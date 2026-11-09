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
  recordTaskAuditLog,
  normalizeCommentDelayMinutes,
  scheduleTaskComment,
  scheduleTaskCommentsAfterPublish,
  claimDueTaskCommentRows,
  finishTaskCommentRow,
  rescheduleTaskCommentRow,
  refreshTaskCommentSummary
} from "../db.ts";
import type { TaskCommentRow } from "../db.ts";
import { loadCommentImage } from "../services/r2MediaService.ts";
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
 * Cloudflare Free allows ~50 outgoing requests per invocation and one Reel needs 4-8,
 * so each invocation publishes only a few videos. The rest wait for the next cron minute.
 */
export const MAX_PUBLISH_PER_INVOCATION = 3;

/** Facebook needs a few minutes to finish processing a new Reel before it accepts comments. */
export const MIN_COMMENT_DELAY_MINUTES = 3;

/** Automatic comment retries: wait 2, 5, then 10 minutes. */
const COMMENT_RETRY_DELAYS_MIN = [2, 5, 10];
const MAX_COMMENT_ATTEMPTS = COMMENT_RETRY_DELAYS_MIN.length + 1;

/** Errors a later attempt cannot fix (token / permission problems). */
const PERMANENT_COMMENT_ERRORS = new Set([
  "TOKEN_EXPIRED",
  "INVALID_PAGE_TOKEN",
  "PAGE_TOKEN_MISMATCH",
  "MISSING_APP_PERMISSION",
  "COMMENT_PERMISSION_DENIED"
]);

/**
 * Publishes the first few messages in this invocation; the rest are handed to the cron
 * (status 'queued', next_retry_at = now), which picks them up over the next minutes.
 */
export async function runOrDeferQueuedTasks(
  db: D1Database,
  env: Env,
  ctx: ExecutionContext,
  messages: QueueTaskMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  if (env.REELS_QUEUE) {
    await env.REELS_QUEUE.sendBatch(messages.map((m) => ({ body: m })));
    return;
  }
  const inline = messages.slice(0, MAX_PUBLISH_PER_INVOCATION);
  const deferred = messages.slice(MAX_PUBLISH_PER_INVOCATION);
  const now = nowUtcSeconds();
  for (const m of deferred) {
    try {
      await db
        .prepare(
          `UPDATE tasks SET next_retry_at = ?, log = 'Queued - publishing within a few minutes...', updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .bind(now, new Date().toISOString(), m.task_id)
        .run();
    } catch {}
  }
  ctx.waitUntil(processTaskQueueMessages(db, env, inline));
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
      message: "No pending posts for the selected Pages."
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
        "This post is not assigned to a Page.",
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
        `Page ${task.facebook_page_id} is not yours or is missing a Page access token.`,
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
      "Queued for publishing...",
      { clearLease: true }
    );
    await appendTaskStageLog(
      db,
      task.id,
      ownerUserId,
      "INFO",
      "queued",
      "Added to the Reels publishing queue."
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
          ? `${skippedFutureCount} post(s) are waiting for their scheduled time and will publish automatically.`
          : "No eligible posts to queue."
    };
  }

  await runOrDeferQueuedTasks(db, env, ctx, messagesToEnqueue);

  return {
    success: true,
    enqueued_count: messagesToEnqueue.length,
    skipped_future_count: skippedFutureCount,
    messages: messagesToEnqueue,
    message:
      skippedFutureCount > 0
        ? `Queued ${messagesToEnqueue.length} post(s) for publishing. ${skippedFutureCount} post(s) are waiting for their scheduled time.`
        : `Queued ${messagesToEnqueue.length} post(s) for publishing.`
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
    return { status: "ack", reason: "Post not found." };
  }

  // 1. Kiểm tra Idempotency & Trạng thái hoàn thành từng phần
  if (existingTask.raw_status === "cancelled") {
    return { status: "ack", reason: "This post was already cancelled." };
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
      existingTask.comment_status !== "scheduled" &&
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
        await updateTaskCommentState(db, existingTask.id, "processing", "Posting comment...");
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
            "Reel published! (Auto comment posted)",
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
        existingTask.log || "Reel published!",
        { clearLease: true }
      );
    }
    try {
      await processTaskComments(db, env, existingTask.id, { publishedAtUtc: nowUtcSeconds() });
    } catch {}
    return { status: "ack", reason: "Already published. Skipped to avoid a duplicate post." };
  }

  // 2. Atomic Lease Claim: Tránh 2 consumer xử lý cùng 1 task
  const leaseOwner = `worker_${randomHex(6)}`;
  const claimedTask = await claimTaskLease(db, msg.task_id, leaseOwner, 120);
  if (!claimedTask) {
    return {
      status: "ack",
      reason: "This post is already being processed."
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
    await recordTaskAttemptFinish(db, attemptId, "failed", "cancelled", null, null, "Stopped by user.");
    return { status: "ack", reason: "This post was stopped by the user." };
  }

  // 3. KIỂM TRA LẠI THỜI GIAN THỰC TẾ TRƯỚC KHI ĐĂNG
  // Nếu scheduled_at > now: tác vụ chưa đến giờ hẹn! Tuyệt đối không upload video hay gọi API publish!
  const currentNowUtc = nowUtcSeconds();
  if (claimedTask.scheduled_at && claimedTask.scheduled_at > currentNowUtc) {
    const diffSec = claimedTask.scheduled_at - currentNowUtc;
    const diffMin = Math.ceil(diffSec / 60);
    const holdMsg = `Waiting for scheduled time: ${claimedTask.schedule_date || ''} ${claimedTask.schedule_time || ''} (${diffMin} min left)`;
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
    const errMsg = "No Page is assigned to this post.";
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
    const errMsg = `No valid Page access token for Page ${claimedTask.facebook_page_id}. Please reconnect the Page.`;
    await updateTaskExecutionState(db, claimedTask.id, "failed", errMsg, {
      retryable: false,
      clearLease: true
    });
    await recordTaskAttemptFinish(db, attemptId, "failed", "validate_token", 190, null, errMsg);
    return { status: "dead_letter", reason: errMsg };
  }

  if (!page.can_post) {
    const errMsg = `Page '${page.page_name}' does not have the CREATE_CONTENT permission.`;
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
    const commentDelayMin = normalizeCommentDelayMinutes(
      (claimedTask as { comment_delay_minutes?: number | null }).comment_delay_minutes
    );
    if (!cleanComment) {
      await updateTaskCommentState(db, claimedTask.id, "none", "");
    } else {
      // Never comment right away: the cron posts it once the Reel is ready on Facebook
      const effectiveDelayMin = Math.max(commentDelayMin, MIN_COMMENT_DELAY_MINUTES);
      const dueAt = nowUtcSeconds() + effectiveDelayMin * 60;
      const delayText = formatCommentDelay(effectiveDelayMin);
      await scheduleTaskComment(db, claimedTask.id, dueAt, `Comment will be posted in ${delayText}.`);
      await updateTaskExecutionState(
        db,
        claimedTask.id,
        "success",
        `Reel published! (Comment will be posted in ${delayText})`,
        { clearLease: true }
      );
      await appendTaskStageLog(
        db,
        claimedTask.id,
        msg.owner_user_id,
        "INFO",
        "comment_scheduled",
        `Auto comment scheduled in ${delayText}.`
      );
    }

    // Multi-comment pipeline: each comment is due at publish time + its own delay
    try {
      await processTaskComments(db, env, claimedTask.id, { publishedAtUtc: nowUtcSeconds() });
    } catch {
      // The cron retries due comments every minute
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
    const retryLog = `[Retry ${attemptNum}/${maxAttempts} in ${backoffSec}s] ${pubRes.message}`;

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
    ? `[AUTO-RETRY STOPPED TO AVOID A DUPLICATE POST] ${pubRes.message}`
    : attemptNum >= maxAttempts
    ? `[Failed after ${attemptNum}/${maxAttempts} attempts] ${pubRes.message}`
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
      const msg = "No target Page is assigned to this post.";
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
      const msg = `Page ${task.facebook_page_id} has no valid Page access token.`;
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
      const msg = `The access token for Page '${page.page_name || task.facebook_page_id}' has expired or was revoked. Please update the token.`;
      await updateTaskExecutionState(db, task.id, "failed", msg, {
        retryable: false,
        clearLease: true
      });
      skippedList.push({ id: task.id, reason: msg, code: "TOKEN_EXPIRED" });
      continue;
    }

    if (!page.can_post) {
      const msg = `Page '${page.page_name || task.facebook_page_id}' is missing the CREATE_CONTENT permission.`;
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
      "Publish now requested - queued for publishing...",
      { clearLease: true }
    );
    await appendTaskStageLog(
      db,
      task.id,
      params.ownerUserId,
      "INFO",
      "queued_publish_now",
      `Schedule moved to now (${task.schedule_date} ${task.schedule_time}) and queued to publish.`
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

  await runOrDeferQueuedTasks(db, env, ctx, messagesToEnqueue);

  const msgText =
    messagesToEnqueue.length > 0
      ? skippedList.length > 0
        ? `Queued ${messagesToEnqueue.length} post(s) to publish now (${skippedList.length} skipped as not eligible).`
        : `Queued ${messagesToEnqueue.length} post(s) to publish now.`
      : skippedList.length > 0
        ? `Cannot publish now: ${skippedList[0].reason}`
        : "No eligible posts to publish now.";

  return {
    success: messagesToEnqueue.length > 0,
    requested_count: params.taskIds.length,
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
    try {
      // A "retry" result already put the task back in D1 (status 'queued' + next_retry_at),
      // and the cron re-sends it when due. Retrying here as well would run it twice.
      await consumeSingleTaskMessage(db, env, message.body);
      message.ack();
    } catch {
      // Unexpected crash before the task state was saved: let the Queue deliver it again.
      // The D1 lease prevents two workers from publishing the same task.
      message.retry({ delaySeconds: 60 });
    }
  }
}

export function formatCommentDelay(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes > 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
  return `${minutes} min`;
}

/**
 * Đăng bình luận hẹn giờ cho 1 task đã xuất bản (được Cron gọi khi comment_due_at đến hạn).
 * Task phải đã được claim sang comment_status = 'processing' trước khi gọi.
 */
export async function postScheduledTaskComment(
  db: D1Database,
  env: Env,
  taskId: number,
  ownerUserId: string
): Promise<{ success: boolean; message: string }> {
  const cfg = getMetaConfig(env);
  const task = await getTask(db, taskId, ownerUserId);
  if (!task) return { success: false, message: "Post not found." };

  const cleanComment = (task.comment_text || "").trim();
  if (!cleanComment || task.comment_id) {
    await updateTaskCommentState(db, taskId, task.comment_id ? "success" : "none", "");
    return { success: true, message: "No comments to post." };
  }
  if (!task.facebook_page_id || !(task.post_id || task.video_id)) {
    const msgText = "This post has no Facebook post ID to comment on.";
    await updateTaskCommentState(db, taskId, "failed", msgText);
    return { success: false, message: msgText };
  }

  const page = await getFacebookPageByFbId(db, cfg.encryptionKey, task.facebook_page_id, true, ownerUserId);
  if (!page || !page.page_access_token) {
    const msgText = "The Page is not connected or has lost permissions. Reconnect it, then retry the comment.";
    await updateTaskCommentState(db, taskId, "failed", msgText);
    return { success: false, message: msgText };
  }

  const cmtRes = await postReelCommentViaGraphApi(db, env, {
    facebookPageId: page.facebook_page_id || task.facebook_page_id,
    pageAccessToken: page.page_access_token,
    postId: task.post_id || task.video_id,
    videoId: task.video_id,
    commentText: cleanComment,
    ownerUserId,
    taskId
  });

  if (cmtRes.success) {
    await updateTaskCommentState(db, taskId, "success", cmtRes.message, {
      commentId: cmtRes.comment_id,
      commentPostedAt: new Date().toISOString()
    });
    await updateTaskExecutionState(db, taskId, "success", "Reel published! (Auto comment posted)", {
      clearLease: true
    });
    await appendTaskStageLog(db, taskId, ownerUserId, "INFO", "comment_success", cmtRes.message);
    return { success: true, message: cmtRes.message };
  }

  await updateTaskCommentState(db, taskId, "failed", cmtRes.message);
  await appendTaskStageLog(db, taskId, ownerUserId, "WARN", "comment_failed", cmtRes.message);
  return { success: false, message: cmtRes.message };
}

// ============================================================================
// MULTI-COMMENT PIPELINE (task_comments)
// ============================================================================

/** Max comments of one post handled per call; the rest are picked up by the cron within a minute. */
const INLINE_COMMENT_LIMIT = 3;

/**
 * Posts already-claimed comment rows (status = 'processing'), grouped by post and in their set order.
 * Each comment is independent: one failure does not stop the others.
 */
export async function postClaimedTaskComments(
  db: D1Database,
  env: Env,
  rows: TaskCommentRow[]
): Promise<{ posted: number; failed: number; taskIds: number[] }> {
  const cfg = getMetaConfig(env);
  const byTask = new Map<number, TaskCommentRow[]>();
  for (const row of rows) {
    const list = byTask.get(Number(row.task_id)) || [];
    list.push(row);
    byTask.set(Number(row.task_id), list);
  }

  let posted = 0;
  let failed = 0;
  for (const [taskId, list] of byTask) {
    list.sort((a, b) => Number(a.due_at || 0) - Number(b.due_at || 0) || a.position - b.position);
    const owner = list[0].owner_user_id;
    const task = await getTask(db, taskId, owner);

    let failReason = "";
    let page: Awaited<ReturnType<typeof getFacebookPageByFbId>> = null;
    if (!task) {
      failReason = "The post no longer exists.";
    } else if (!task.facebook_page_id || !(task.post_id || task.video_id)) {
      failReason = "The post is not on Facebook yet, so it cannot be commented on.";
    } else {
      page = await getFacebookPageByFbId(db, cfg.encryptionKey, task.facebook_page_id, true, owner);
      if (!page || !page.page_access_token) {
        failReason = "The Page is disconnected. Reconnect it, then retry the comments.";
      }
    }

    for (const row of list) {
      const label = `Comment #${row.position + 1}`;
      if (failReason || !task || !page) {
        await finishTaskCommentRow(db, row.id, { success: false, error: failReason });
        failed++;
        continue;
      }

      let image: Awaited<ReturnType<typeof loadCommentImage>> = null;
      if (row.image_media_id) {
        image = await loadCommentImage(db, env, row.image_media_id, owner).catch(() => null);
        if (!image) {
          const msgText = "The attached image is no longer available.";
          await finishTaskCommentRow(db, row.id, { success: false, error: msgText });
          await appendTaskStageLog(db, taskId, owner, "WARN", "comment_failed", `${label}: ${msgText}`);
          failed++;
          continue;
        }
      }

      let ok = false;
      let resultMsg = "";
      let commentId: string | null = null;
      let permanentError = false;
      try {
        const cmtRes = await postReelCommentViaGraphApi(db, env, {
          facebookPageId: page.facebook_page_id || task.facebook_page_id!,
          pageAccessToken: page.page_access_token!,
          postId: task.post_id || task.video_id,
          videoId: task.video_id,
          commentText: row.message || "",
          ownerUserId: owner,
          taskId,
          skipInitialDuplicateCheck: Number(row.attempts || 0) === 0,
          image
        });
        ok = cmtRes.success;
        resultMsg = cmtRes.message;
        commentId = cmtRes.comment_id || null;
        permanentError = !ok && PERMANENT_COMMENT_ERRORS.has(String(cmtRes.error_type || ""));
      } catch (err) {
        ok = false;
        resultMsg = "Could not reach Facebook.";
      }

      // Temporary failures (Reel still processing, network, request limits) are retried automatically
      const attemptsSoFar = Number(row.attempts || 0) + 1;
      if (!ok && !permanentError && attemptsSoFar < MAX_COMMENT_ATTEMPTS) {
        const waitMin = COMMENT_RETRY_DELAYS_MIN[attemptsSoFar - 1] ?? COMMENT_RETRY_DELAYS_MIN[COMMENT_RETRY_DELAYS_MIN.length - 1];
        await rescheduleTaskCommentRow(db, row.id, nowUtcSeconds() + waitMin * 60, resultMsg);
        await appendTaskStageLog(
          db,
          taskId,
          owner,
          "WARN",
          "comment_retry_scheduled",
          `${label}: ${resultMsg} Retrying automatically in ${waitMin} min.`
        );
        continue;
      }

      await finishTaskCommentRow(db, row.id, { success: ok, commentId, error: resultMsg });
      await appendTaskStageLog(
        db,
        taskId,
        owner,
        ok ? "INFO" : "WARN",
        ok ? "comment_success" : "comment_failed",
        ok ? `${label} posted.` : `${label}: ${resultMsg}`
      );
      if (ok) posted++;
      else failed++;
    }
  }
  return { posted, failed, taskIds: Array.from(byTask.keys()) };
}

/**
 * For one post: make pending comments due (publish time + each delay) and post the ones due now.
 */
export async function processTaskComments(
  db: D1Database,
  env: Env,
  taskId: number,
  options: { publishedAtUtc?: number; maxToPost?: number } = {}
): Promise<{ posted: number; failed: number }> {
  if (options.publishedAtUtc) {
    await scheduleTaskCommentsAfterPublish(db, taskId, options.publishedAtUtc, MIN_COMMENT_DELAY_MINUTES * 60);
  }
  const due = await claimDueTaskCommentRows(
    db,
    nowUtcSeconds(),
    options.maxToPost ?? INLINE_COMMENT_LIMIT,
    taskId
  );
  const res = due.length > 0 ? await postClaimedTaskComments(db, env, due) : { posted: 0, failed: 0 };
  await refreshTaskCommentSummary(db, taskId);
  return { posted: res.posted, failed: res.failed };
}

/** Cron: post comments from any post that are due now. */
export async function dispatchDueTaskComments(
  db: D1Database,
  env: Env,
  nowUtc: number,
  limit = 5
): Promise<number> {
  const due = await claimDueTaskCommentRows(db, nowUtc, limit);
  if (due.length === 0) return 0;
  const res = await postClaimedTaskComments(db, env, due);
  for (const taskId of res.taskIds) {
    try {
      await refreshTaskCommentSummary(db, taskId);
    } catch {}
  }
  return due.length;
}
