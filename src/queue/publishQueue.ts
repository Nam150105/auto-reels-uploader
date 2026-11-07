/**
 * Cloudflare Queue Producer & Consumer for Reels Publishing
 * - Hỗ trợ cả Cloudflare Queues native (`env.REELS_QUEUE`) VÀ D1 Queue Consumer trên gói Cloudflare Free (`ctx.waitUntil` + Cron)
 * - Queue message chỉ chứa `task_id` và metadata tối thiểu (TUYỆT ĐỐI KHÔNG chứa Access Token hoặc video binary)
 * - Cơ chế Lease/Lock (`claimTaskLease`), Idempotency (`idempotency_key`), Exponential Backoff & Dead-Letter handling
 * - Không retry tự động khi trạng thái publish không rõ ràng (`ambiguous_publish`) để chống đăng trùng Reels
 */

import type {
  D1Database,
  Env,
  ExecutionContext,
  MessageBatch,
  QueueTaskMessage
} from "../types.ts";
import {
  getPendingTasks,
  getTask,
  getFacebookPageByFbId,
  claimTaskLease,
  updateTaskExecutionState,
  updateTaskCommentState,
  appendTaskStageLog,
  recordTaskAttemptStart,
  recordTaskAttemptFinish,
  prepareTasksForPublishNow,
  recordTaskAuditLog
} from "../db.ts";
import {
  getMetaConfig,
  validateVideoSource,
  publishReelViaGraphApi,
  postReelCommentViaGraphApi,
  getCurrentMetaThrottleState
} from "../services/metaGraphService.ts";
import { randomHex } from "../utils/crypto.ts";
import { nowUtcSeconds } from "../utils/timezone.ts";

export function calculateBackoffSeconds(attemptCount: number): number {
  const base = 15;
  const exp = Math.max(0, attemptCount - 1);
  return Math.min(300, base * Math.pow(2, exp));
}

/**
 * Producer: Đưa danh sách Task đủ điều kiện của User vào Queue và trả về kết quả Accepted ngay lập tức
 */
export async function enqueueUserPendingTasks(
  db: D1Database,
  env: Env,
  ctx: ExecutionContext,
  ownerUserId: string,
  options?: { onlyDueOrUnscheduled?: boolean }
): Promise<{
  success: boolean;
  enqueued_count: number;
  skipped_future_count: number;
  messages: QueueTaskMessage[];
  message: string;
}> {
  const cfg = getMetaConfig(env);
  const pendingTasks = await getPendingTasks(db, true, ownerUserId);

  if (pendingTasks.length === 0) {
    return {
      success: false,
      enqueued_count: 0,
      skipped_future_count: 0,
      messages: [],
      message: "Không có tác vụ nào ở trạng thái Chờ xử lý (pending) thuộc các Fanpage đang chọn."
    };
  }

  const now = nowUtcSeconds();
  const messagesToEnqueue: QueueTaskMessage[] = [];
  let skippedFutureCount = 0;

  for (const task of pendingTasks) {
    // Task cũ thiếu ngày/giờ đăng (needs_schedule): không tự động đăng cho đến khi bổ sung lịch hoặc bấm Đăng ngay
    if (!task.scheduled_at || !task.schedule_date || !task.schedule_time) {
      skippedFutureCount++;
      continue;
    }

    // BẮT BUỘC: Tuyệt đối KHÔNG BAO GIỜ đưa các task có lịch hẹn tương lai (scheduled_at > now) vào Queue xuất bản ngay!
    // Các task này phải ở trạng thái pending cho đến khi Cron Trigger kích hoạt đúng giờ hẹn.
    if (task.scheduled_at && task.scheduled_at > now) {
      skippedFutureCount++;
      continue;
    }

    if (!task.facebook_page_id) {
      await updateTaskExecutionState(
        db,
        task.id,
        "failed",
        "Tác vụ chưa được gán vào Fanpage nào.",
        { retryable: false, clearLease: true }
      );
      continue;
    }

    const page = await getFacebookPageByFbId(
      db,
      cfg.encryptionKey,
      task.facebook_page_id,
      true,
      ownerUserId
    );
    if (!page || !page.page_access_token) {
      await updateTaskExecutionState(
        db,
        task.id,
        "failed",
        `Fanpage ${task.facebook_page_id} không thuộc quyền sở hữu hoặc thiếu Page Access Token.`,
        { retryable: false, clearLease: true }
      );
      continue;
    }

    const videoRef = task.object_key || task.media_id || task.video_path;
    const vCheck = await validateVideoSource(db, env, videoRef, ownerUserId);
    if (!vCheck.exists || !vCheck.valid_format) {
      await updateTaskExecutionState(db, task.id, "failed", vCheck.message, {
        retryable: false,
        clearLease: true
      });
      continue;
    }

    const idempotencyKey =
      task.idempotency_key || `idem_${ownerUserId}_${task.id}_${randomHex(6)}`;

    await updateTaskExecutionState(
      db,
      task.id,
      "queued",
      "Đang trong hàng đợi đăng...",
      { clearLease: true }
    );
    await appendTaskStageLog(
      db,
      task.id,
      ownerUserId,
      "INFO",
      "queued",
      "Đã đưa vào hàng đợi đăng Reels."
    );

    messagesToEnqueue.push({
      task_id: task.id,
      owner_user_id: ownerUserId,
      idempotency_key: idempotencyKey,
      attempt: (task.attempt_count || 0) + 1,
      enqueued_at: now
    });
  }

  if (messagesToEnqueue.length === 0) {
    return {
      success: false,
      enqueued_count: 0,
      skipped_future_count: skippedFutureCount,
      messages: [],
      message:
        skippedFutureCount > 0
          ? `Có ${skippedFutureCount} tác vụ đang chờ đến giờ hẹn lịch (hệ thống sẽ tự động đăng khi đến hạn).`
          : "Không có tác vụ hợp lệ nào để đưa vào hàng đợi."
    };
  }

  // Nếu tài khoản Cloudflare có gắn REELS_QUEUE native thì gửi vào Cloudflare Queues
  if (env.REELS_QUEUE) {
    await env.REELS_QUEUE.sendBatch(
      messagesToEnqueue.map((m) => ({ body: m }))
    );
  } else {
    // Trên Cloudflare Free Plan: thực thi bất đồng bộ qua ctx.waitUntil kết hợp D1 Lease Lock
    ctx.waitUntil(processTaskQueueMessages(db, env, messagesToEnqueue));
  }

  return {
    success: true,
    enqueued_count: messagesToEnqueue.length,
    skipped_future_count: skippedFutureCount,
    messages: messagesToEnqueue,
    message:
      skippedFutureCount > 0
        ? `Đã đưa ${messagesToEnqueue.length} tác vụ vào hàng đợi xuất bản! (Giữ lại ${skippedFutureCount} tác vụ đang chờ đến giờ hẹn lịch).`
        : `Đã đưa ${messagesToEnqueue.length} tác vụ vào hàng đợi xử lý nền (Queue)!`
  };
}

/**
 * Consumer xử lý từng message trong Queue với Lease Lock, Idempotency & Exponential Backoff
 */
export async function consumeSingleTaskMessage(
  db: D1Database,
  env: Env,
  msg: QueueTaskMessage
): Promise<{ status: "ack" | "retry" | "dead_letter"; delaySeconds?: number; reason?: string }> {
  const cfg = getMetaConfig(env);
  const existingTask = await getTask(db, msg.task_id, msg.owner_user_id);

  if (!existingTask) {
    return { status: "ack", reason: "Task không tồn tại." };
  }

  // 1. Kiểm tra Idempotency & Trạng thái hoàn thành từng phần
  if (existingTask.raw_status === "cancelled") {
    return { status: "ack", reason: "Task đã hủy trước đó." };
  }

  const isReelPublished =
    Boolean(existingTask.video_id && existingTask.post_id) ||
    existingTask.status === "success" ||
    existingTask.raw_status === "success";

  if (isReelPublished) {
    // Reels đã xuất bản thành công!
    const cleanComment = (existingTask.comment_text || "").trim();
    const needsComment =
      cleanComment &&
      !existingTask.comment_id &&
      existingTask.comment_status !== "success" &&
      Boolean(existingTask.facebook_page_id);

    if (needsComment) {
      // Worker bị restart hoặc retry giữa hai bước: CHỈ đăng comment, tuyệt đối KHÔNG đăng lại video!
      const page = await getFacebookPageByFbId(
        db,
        cfg.encryptionKey,
        existingTask.facebook_page_id!,
        true,
        msg.owner_user_id
      );
      if (page && page.page_access_token) {
        await updateTaskCommentState(db, existingTask.id, "processing", "Đang xử lý đăng bình luận...");
        const cmtRes = await postReelCommentViaGraphApi(db, env, {
          facebookPageId: page.facebook_page_id || existingTask.facebook_page_id!,
          pageAccessToken: page.page_access_token,
          postId: existingTask.post_id || existingTask.video_id,
          videoId: existingTask.video_id,
          commentText: cleanComment,
          ownerUserId: msg.owner_user_id,
          taskId: existingTask.id
        });
        if (cmtRes.success) {
          await updateTaskCommentState(db, existingTask.id, "success", cmtRes.message, {
            commentId: cmtRes.comment_id,
            commentPostedAt: new Date().toISOString()
          });
          if (
            cmtRes.post_id &&
            cmtRes.post_id !== existingTask.video_id &&
            cmtRes.post_id !== existingTask.post_id
          ) {
            try {
              await db
                .prepare("UPDATE tasks SET post_id = ? WHERE id = ?")
                .bind(cmtRes.post_id, existingTask.id)
                .run();
            } catch {}
          }
          await updateTaskExecutionState(
            db,
            existingTask.id,
            "success",
            "Đã đăng Reels thành công! (Đã đăng bình luận tự động)",
            { clearLease: true }
          );
        } else {
          await updateTaskCommentState(db, existingTask.id, "failed", cmtRes.message);
        }
      }
    } else {
      await updateTaskExecutionState(
        db,
        existingTask.id,
        "success",
        existingTask.log || "Đã đăng Reels thành công!",
        { clearLease: true }
      );
    }
    return { status: "ack", reason: "Idempotency guard: Video đã đăng thành công." };
  }

  // 2. Atomic Lease Claim: Tránh 2 consumer xử lý cùng 1 task
  const leaseOwner = `worker_${randomHex(6)}`;
  const claimedTask = await claimTaskLease(db, msg.task_id, leaseOwner, 120);
  if (!claimedTask) {
    return {
      status: "ack",
      reason: "Task đang được xử lý bởi một consumer khác (Lease locked)."
    };
  }

  const attemptNum = claimedTask.attempt_count || 1;
  const maxAttempts = claimedTask.max_attempts || 3;

  const attemptId = await recordTaskAttemptStart(
    db,
    claimedTask.id,
    msg.owner_user_id,
    attemptNum,
    "claiming_lease"
  );

  // Kiểm tra lại xem task có bị người dùng bấm "Dừng" trong lúc chờ không
  const refreshed = await getTask(db, claimedTask.id, msg.owner_user_id);
  if (!refreshed || refreshed.raw_status === "pending" || refreshed.raw_status === "cancelled") {
    await recordTaskAttemptFinish(db, attemptId, "failed", "cancelled", null, null, "Người dùng đã dừng tác vụ.");
    return { status: "ack", reason: "Task đã được dừng bởi người dùng." };
  }

  // 3. KIỂM TRA LẠI THỜI GIAN THỰC TẾ TRƯỚC KHI ĐĂNG
  // Nếu scheduled_at > now: tác vụ chưa đến giờ hẹn! Tuyệt đối không upload video hay gọi API publish!
  const currentNowUtc = nowUtcSeconds();
  if (claimedTask.scheduled_at && claimedTask.scheduled_at > currentNowUtc) {
    const diffSec = claimedTask.scheduled_at - currentNowUtc;
    const diffMin = Math.ceil(diffSec / 60);
    const holdMsg = `Đang chờ đến giờ hẹn: ${claimedTask.schedule_date || ''} ${claimedTask.schedule_time || ''} (còn ${diffMin} phút)`;
    await updateTaskExecutionState(
      db,
      claimedTask.id,
      "pending",
      holdMsg,
      { clearLease: true }
    );
    await appendTaskStageLog(
      db,
      claimedTask.id,
      msg.owner_user_id,
      "INFO",
      "awaiting_schedule",
      holdMsg
    );
    await recordTaskAttemptFinish(db, attemptId, "failed", "awaiting_schedule", null, null, holdMsg);
    return { status: "ack", reason: holdMsg };
  }

  if (!claimedTask.facebook_page_id) {
    const errMsg = "Tác vụ chưa được gán Fanpage.";
    await updateTaskExecutionState(db, claimedTask.id, "failed", errMsg, {
      retryable: false,
      clearLease: true
    });
    await recordTaskAttemptFinish(db, attemptId, "failed", "validate_page", null, null, errMsg);
    return { status: "dead_letter", reason: errMsg };
  }

  const page = await getFacebookPageByFbId(
    db,
    cfg.encryptionKey,
    claimedTask.facebook_page_id,
    true,
    msg.owner_user_id
  );

  if (!page || !page.page_access_token) {
    const errMsg = `Không tìm thấy Page Access Token hợp lệ cho Fanpage ${claimedTask.facebook_page_id}.`;
    await updateTaskExecutionState(db, claimedTask.id, "failed", errMsg, {
      retryable: false,
      clearLease: true
    });
    await recordTaskAttemptFinish(db, attemptId, "failed", "validate_token", 190, null, errMsg);
    return { status: "dead_letter", reason: errMsg };
  }

  if (!page.can_post) {
    const errMsg = `Fanpage '${page.page_name}' không có quyền CREATE_CONTENT.`;
    await updateTaskExecutionState(db, claimedTask.id, "failed", errMsg, {
      retryable: false,
      clearLease: true
    });
    await recordTaskAttemptFinish(db, attemptId, "failed", "validate_permission", 200, null, errMsg);
    return { status: "dead_letter", reason: errMsg };
  }

  const videoRef = claimedTask.object_key || claimedTask.media_id || claimedTask.video_path;
  const pubRes = await publishReelViaGraphApi(db, env, {
    facebookPageId: claimedTask.facebook_page_id,
    pageAccessToken: page.page_access_token,
    videoRef,
    caption: claimedTask.caption || "",
    commentText: claimedTask.comment_text || "",
    ownerUserId: msg.owner_user_id,
    onStageLog: async (stage, stageMsg) => {
      await appendTaskStageLog(db, claimedTask.id, msg.owner_user_id, "INFO", stage, stageMsg);
      await updateTaskExecutionState(db, claimedTask.id, "processing", stageMsg);
    }
  });

  if (pubRes.success) {
    const rawPostId = pubRes.post_id || "";
    await updateTaskExecutionState(db, claimedTask.id, "success", pubRes.message, {
      videoId: pubRes.video_id || "",
      postId: rawPostId,
      videoUrl: pubRes.video_url || "",
      errorCode: null,
      errorSubcode: null,
      retryable: false,
      nextRetryAt: null,
      clearLease: true
    });
    await appendTaskStageLog(
      db,
      claimedTask.id,
      msg.owner_user_id,
      "INFO",
      "completed",
      pubRes.message
    );
    await recordTaskAttemptFinish(db, attemptId, "success", "completed");
    await recordTaskAuditLog(db, {
      taskId: claimedTask.id,
      ownerUserId: msg.owner_user_id,
      actorUserId: msg.owner_user_id,
      action: "publish_success",
      triggerSource: claimedTask.trigger_source || "scheduler",
      beforeStatus: "processing",
      afterStatus: "success",
      details: {
        video_id: pubRes.video_id || "",
        post_id: rawPostId,
        video_url: pubRes.video_url || ""
      }
    });

    // Tự động tạo bản ghi bài viết trong danh mục Facebook Posts tập trung
    try {
      const nowIso = new Date().toISOString();
      const fbPostId = rawPostId || pubRes.video_id || `reel_${claimedTask.id}`;
      const permalink = pubRes.video_url || `https://www.facebook.com/${fbPostId}`;
      await db
        .prepare(
          `INSERT INTO facebook_posts (
            owner_user_id, page_id, post_id, video_id, message, post_type,
            permalink_url, thumbnail_url, media_url, attachments_json, source, task_id,
            created_time, synced_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'reel', ?, '', ?, '[]', 'app_published', ?, ?, ?, ?, ?)
          ON CONFLICT(page_id, post_id) DO UPDATE SET
            task_id = excluded.task_id,
            source = 'app_published',
            video_id = excluded.video_id,
            permalink_url = excluded.permalink_url,
            media_url = excluded.media_url,
            updated_at = excluded.updated_at`
        )
        .bind(
          msg.owner_user_id,
          page.facebook_page_id || claimedTask.facebook_page_id,
          fbPostId,
          pubRes.video_id || "",
          claimedTask.caption || "",
          permalink,
          claimedTask.video_url || "",
          claimedTask.id,
          nowIso,
          nowIso,
          nowIso,
          nowIso
        )
        .run();
    } catch {}

    // BƯỚC 5, 6, 7: XỬ LÝ ĐĂNG BÌNH LUẬN RIÊNG BIỆT (TÁCH BIỆT VỚI REELS)
    const cleanComment = (claimedTask.comment_text || "").trim();
    if (!cleanComment) {
      await updateTaskCommentState(db, claimedTask.id, "none", "");
    } else {
      await updateTaskCommentState(db, claimedTask.id, "processing", "Đang đăng bình luận tự động...");
      await appendTaskStageLog(
        db,
        claimedTask.id,
        msg.owner_user_id,
        "INFO",
        "commenting",
        "Đang đăng bình luận lên bài viết Reels..."
      );

      const cmtRes = await postReelCommentViaGraphApi(db, env, {
        facebookPageId: page.facebook_page_id || claimedTask.facebook_page_id,
        pageAccessToken: page.page_access_token,
        postId: rawPostId,
        videoId: pubRes.video_id || claimedTask.video_id,
        commentText: cleanComment,
        ownerUserId: msg.owner_user_id,
        taskId: claimedTask.id,
        skipInitialDuplicateCheck: attemptNum <= 1
      });

      if (cmtRes.success) {
        await updateTaskCommentState(db, claimedTask.id, "success", cmtRes.message, {
          commentId: cmtRes.comment_id,
          commentPostedAt: new Date().toISOString()
        });
        if (
          cmtRes.post_id &&
          cmtRes.post_id !== (pubRes.video_id || claimedTask.video_id) &&
          cmtRes.post_id !== rawPostId
        ) {
          try {
            await db
              .prepare("UPDATE tasks SET post_id = ? WHERE id = ?")
              .bind(cmtRes.post_id, claimedTask.id)
              .run();
          } catch {}
        }
        await updateTaskExecutionState(
          db,
          claimedTask.id,
          "success",
          "Đã đăng Reels thành công! (Đã đăng bình luận tự động)",
          { clearLease: true }
        );
        await appendTaskStageLog(
          db,
          claimedTask.id,
          msg.owner_user_id,
          "INFO",
          "comment_success",
          cmtRes.message
        );
      } else {
        await updateTaskCommentState(db, claimedTask.id, "failed", cmtRes.message);
        await updateTaskExecutionState(
          db,
          claimedTask.id,
          "success",
          `Đã đăng Reels thành công! (Lỗi bình luận: ${cmtRes.message})`,
          { clearLease: true }
        );
        await appendTaskStageLog(
          db,
          claimedTask.id,
          msg.owner_user_id,
          "WARN",
          "comment_failed",
          cmtRes.message
        );
      }
    }

    return { status: "ack" };
  }

  // Xử lý lỗi & quyết định Retry hay Dead-Letter
  const canRetry =
    Boolean(pubRes.retryable) &&
    !pubRes.ambiguous_publish &&
    attemptNum < maxAttempts;

  if (canRetry) {
    const backoffSec = calculateBackoffSeconds(attemptNum);
    const nextRetryAt = nowUtcSeconds() + backoffSec;
    const retryLog = `[Thử lại ${attemptNum}/${maxAttempts} sau ${backoffSec}s] ${pubRes.message}`;

    await updateTaskExecutionState(db, claimedTask.id, "queued", retryLog, {
      videoId: pubRes.video_id,
      errorCode: pubRes.error_code ?? null,
      errorSubcode: pubRes.error_subcode ?? null,
      retryable: true,
      nextRetryAt,
      clearLease: true
    });
    await appendTaskStageLog(
      db,
      claimedTask.id,
      msg.owner_user_id,
      "WARN",
      pubRes.stage || "retry_scheduled",
      retryLog
    );
    await recordTaskAttemptFinish(
      db,
      attemptId,
      "failed",
      pubRes.stage || "failed",
      pubRes.error_code,
      pubRes.error_subcode,
      pubRes.message
    );
    return { status: "retry", delaySeconds: backoffSec, reason: pubRes.message };
  }

  // Dead-letter hoặc Ambiguous Publish (không tự động retry để tránh đăng trùng)
  const finalFailMsg = pubRes.ambiguous_publish
    ? `[DỪNG AUTO-RETRY CHỐNG ĐĂNG TRÙNG] ${pubRes.message}`
    : attemptNum >= maxAttempts
    ? `[DEAD-LETTER: Quá số lần thử ${attemptNum}/${maxAttempts}] ${pubRes.message}`
    : pubRes.message;

  await updateTaskExecutionState(db, claimedTask.id, "failed", finalFailMsg, {
    videoId: pubRes.video_id,
    errorCode: pubRes.error_code ?? null,
    errorSubcode: pubRes.error_subcode ?? null,
    retryable: false,
    nextRetryAt: null,
    clearLease: true
  });
  await appendTaskStageLog(
    db,
    claimedTask.id,
    msg.owner_user_id,
    "ERROR",
    pubRes.ambiguous_publish ? "ambiguous_publish_halt" : "dead_letter",
    finalFailMsg
  );
  await recordTaskAttemptFinish(
    db,
    attemptId,
    "failed",
    pubRes.stage || "dead_letter",
    pubRes.error_code,
    pubRes.error_subcode,
    finalFailMsg
  );
  await recordTaskAuditLog(db, {
    taskId: claimedTask.id,
    ownerUserId: msg.owner_user_id,
    actorUserId: msg.owner_user_id,
    action: "publish_failed",
    triggerSource: claimedTask.trigger_source || "scheduler",
    beforeStatus: "processing",
    afterStatus: "failed",
    details: {
      stage: pubRes.stage || "dead_letter",
      error_code: pubRes.error_code ?? null,
      error_subcode: pubRes.error_subcode ?? null,
      ambiguous_publish: Boolean(pubRes.ambiguous_publish),
      message: finalFailMsg
    }
  });

  return { status: "dead_letter", reason: finalFailMsg };
}

/**
 * Đăng ngay (Publish Now) cho 1 hoặc nhiều Task được chọn:
 * - Tự động cập nhật `scheduled_at` = thời điểm hiện tại (UTC), lưu `original_scheduled_at` vào lịch sử
 * - Kiểm tra chặt chẽ điều kiện đăng (video R2 tồn tại, Fanpage & Page Access Token hợp lệ, không đăng lại task đã thành công hoặc đang chạy)
 * - Đẩy vào Queue xử lý có kiểm soát Concurrency (tối đa 3 task song song)
 */
export async function publishSelectedTasksNow(
  db: D1Database,
  env: Env,
  ctx: ExecutionContext,
  params: {
    taskIds: number[];
    ownerUserId: string;
    actorUserId?: string;
    triggerSource?: "manual_publish_now" | "bulk_publish_now";
  }
): Promise<{
  success: boolean;
  requested_count: number;
  eligible_count: number;
  skipped_count: number;
  enqueued_task_ids: number[];
  skipped: Array<{ id: number; reason: string; code: string }>;
  messages: QueueTaskMessage[];
  updated_schedule_vn?: { schedule_date: string; schedule_time: string; scheduled_at: number };
  message: string;
}> {
  const cfg = getMetaConfig(env);
  const triggerSource = params.triggerSource || (params.taskIds.length > 1 ? "bulk_publish_now" : "manual_publish_now");
  const actorId = params.actorUserId || params.ownerUserId;

  // Bước 1: Kiểm tra trạng thái & cập nhật lịch đăng của các task hợp lệ về thời điểm hiện tại
  const prep = await prepareTasksForPublishNow(db, {
    taskIds: params.taskIds,
    ownerUserId: params.ownerUserId,
    actorUserId: actorId,
    triggerSource
  });

  const skippedList: Array<{ id: number; reason: string; code: string }> = [...(prep.ineligibleTasks || [])];
  const messagesToEnqueue: QueueTaskMessage[] = [];
  const enqueuedIds: number[] = [];
  const now = nowUtcSeconds();
  let updatedScheduleVn: { schedule_date: string; schedule_time: string; scheduled_at: number } | undefined;

  for (const task of (prep.eligibleTasks || [])) {
    if (!updatedScheduleVn && task.scheduled_at) {
      updatedScheduleVn = {
        schedule_date: task.schedule_date || "",
        schedule_time: task.schedule_time || "",
        scheduled_at: task.scheduled_at
      };
    }

    if (!task.facebook_page_id) {
      const msg = "Task chưa được gán vào Fanpage đích.";
      await updateTaskExecutionState(db, task.id, "failed", msg, {
        retryable: false,
        clearLease: true
      });
      skippedList.push({ id: task.id, reason: msg, code: "MISSING_PAGE" });
      continue;
    }

    const page = await getFacebookPageByFbId(
      db,
      cfg.encryptionKey,
      task.facebook_page_id,
      true,
      params.ownerUserId
    );
    if (!page || !page.page_access_token) {
      const msg = `Fanpage ${task.facebook_page_id} chưa có Page Access Token hợp lệ.`;
      await updateTaskExecutionState(db, task.id, "failed", msg, {
        retryable: false,
        clearLease: true
      });
      skippedList.push({ id: task.id, reason: msg, code: "INVALID_PAGE_TOKEN" });
      continue;
    }

    if (
      page.token_status === "expired" ||
      page.token_status === "revoked" ||
      page.token_status === "invalid"
    ) {
      const msg = `Access Token của Fanpage '${page.page_name || task.facebook_page_id}' đã hết hạn hoặc bị thu hồi. Vui lòng cập nhật lại Token.`;
      await updateTaskExecutionState(db, task.id, "failed", msg, {
        retryable: false,
        clearLease: true
      });
      skippedList.push({ id: task.id, reason: msg, code: "TOKEN_EXPIRED" });
      continue;
    }

    if (!page.can_post) {
      const msg = `Fanpage '${page.page_name || task.facebook_page_id}' thiếu quyền CREATE_CONTENT.`;
      await updateTaskExecutionState(db, task.id, "failed", msg, {
        retryable: false,
        clearLease: true
      });
      skippedList.push({ id: task.id, reason: msg, code: "MISSING_CREATE_CONTENT" });
      continue;
    }

    const videoRef = task.object_key || task.media_id || task.video_path;
    const vCheck = await validateVideoSource(db, env, videoRef, params.ownerUserId);
    if (!vCheck.exists || !vCheck.valid_format) {
      await updateTaskExecutionState(db, task.id, "failed", vCheck.message, {
        retryable: false,
        clearLease: true
      });
      skippedList.push({ id: task.id, reason: vCheck.message, code: "INVALID_VIDEO_SOURCE" });
      continue;
    }

    const idempotencyKey =
      task.idempotency_key || `idem_${params.ownerUserId}_${task.id}_${randomHex(6)}`;

    await updateTaskExecutionState(
      db,
      task.id,
      "queued",
      "Đã nhận lệnh Đăng ngay -> Đang trong hàng đợi xuất bản...",
      { clearLease: true }
    );
    await appendTaskStageLog(
      db,
      task.id,
      params.ownerUserId,
      "INFO",
      "queued_publish_now",
      `Đã cập nhật lịch đăng về hiện tại (${task.schedule_date} ${task.schedule_time}) và đưa vào hàng đợi Đăng ngay.`
    );

    enqueuedIds.push(task.id);
    messagesToEnqueue.push({
      task_id: task.id,
      owner_user_id: params.ownerUserId,
      idempotency_key: idempotencyKey,
      attempt: (task.attempt_count || 0) + 1,
      enqueued_at: now
    });
  }

  if (messagesToEnqueue.length > 0) {
    if (env.REELS_QUEUE) {
      await env.REELS_QUEUE.sendBatch(messagesToEnqueue.map((m) => ({ body: m })));
    } else {
      ctx.waitUntil(processTaskQueueMessages(db, env, messagesToEnqueue));
    }
  }

  const msgText =
    messagesToEnqueue.length > 0
      ? skippedList.length > 0
        ? `Đã đưa ${messagesToEnqueue.length} task vào hàng đợi Đăng ngay (Bỏ qua ${skippedList.length} task không đủ điều kiện).`
        : `Đã cập nhật lịch đăng về hiện tại và đưa ${messagesToEnqueue.length} task vào hàng đợi Đăng ngay!`
      : skippedList.length > 0
        ? `Không thể đăng ngay: ${skippedList[0].reason}`
        : "Không có task hợp lệ nào để đăng ngay.";

  return {
    success: messagesToEnqueue.length > 0,
    requested_count: prep.requested_count,
    eligible_count: messagesToEnqueue.length,
    skipped_count: skippedList.length,
    enqueued_task_ids: enqueuedIds,
    skipped: skippedList,
    messages: messagesToEnqueue,
    updated_schedule_vn: updatedScheduleVn,
    message: msgText
  };
}

export async function processTaskQueueMessages(
  db: D1Database,
  env: Env,
  messages: QueueTaskMessage[]
): Promise<void> {
  // Kiểm soát Concurrency chặt chẽ: Tối đa 3 luồng song song (giảm xuống 1 nếu Meta Rate Limit đang cao)
  const throttle = getCurrentMetaThrottleState();
  const maxAllowed = throttle.level === "critical" || throttle.level === "high" ? 1 : 3;
  const concurrency = Math.min(maxAllowed, Math.max(1, messages.length));
  let index = 0;

  async function workerLoop(workerIdx: number): Promise<void> {
    if (workerIdx > 0 && messages.length > 1) {
      // Stagger nhẹ giữa các worker để tránh burst khởi tạo upload session cùng mili-giây
      await new Promise((r) => setTimeout(r, workerIdx * 250));
    }
    while (index < messages.length) {
      const currentIdx = index++;
      const msg = messages[currentIdx];
      if (!msg) continue;
      const curThrottle = getCurrentMetaThrottleState();
      if (curThrottle.recommended_delay_ms > 0 && currentIdx > 0) {
        await new Promise((r) => setTimeout(r, Math.min(curThrottle.recommended_delay_ms, 2000)));
      }
      await consumeSingleTaskMessage(db, env, msg);
    }
  }

  const workers: Promise<void>[] = [];
  const count = Math.min(concurrency, messages.length);
  for (let i = 0; i < count; i++) {
    workers.push(workerLoop(i));
  }
  await Promise.all(workers);
}

/**
 * Native Cloudflare Queues Batch Handler (`queue(batch, env, ctx)`)
 */
export async function handleNativeQueueBatch(
  batch: MessageBatch<QueueTaskMessage>,
  db: D1Database,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const res = await consumeSingleTaskMessage(db, env, message.body);
    if (res.status === "retry") {
      message.retry({ delaySeconds: res.delaySeconds || 30 });
    } else {
      message.ack();
    }
  }
}

