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
  appendTaskStageLog,
  recordTaskAttemptStart,
  recordTaskAttemptFinish
} from "../db.ts";
import {
  getMetaConfig,
  validateVideoSource,
  publishReelViaGraphApi
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
    // Nếu chỉ chạy các task đến hạn nhưng user nhấn "Đăng Reels" thủ công:
    // Nếu options.onlyDueOrUnscheduled === true thì bỏ qua task có scheduled_at trong tương lai
    if (options?.onlyDueOrUnscheduled && task.scheduled_at && task.scheduled_at > now) {
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
      "Đã đưa vào hàng đợi xuất bản Reels (Queued)...",
      { clearLease: true }
    );
    await appendTaskStageLog(
      db,
      task.id,
      ownerUserId,
      "INFO",
      "queued",
      `Đã xếp hàng đợi xuất bản (idempotency_key=${idempotencyKey}).`
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
          ? `Có ${skippedFutureCount} tác vụ đang chờ đến giờ hẹn lịch.`
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
    message: `Đã đưa ${messagesToEnqueue.length} tác vụ vào hàng đợi xử lý nền (Queue)!`
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

  // 1. Kiểm tra Idempotency: Nếu task đã thành công hoặc đã bị hủy hoặc đã có video_id xuất bản
  if (
    existingTask.raw_status === "success" ||
    existingTask.status === "success" ||
    existingTask.raw_status === "cancelled"
  ) {
    return { status: "ack", reason: "Task đã hoàn tất hoặc đã hủy trước đó." };
  }

  if (existingTask.video_id && existingTask.post_id) {
    await updateTaskExecutionState(
      db,
      existingTask.id,
      "success",
      existingTask.log || `Đã xuất bản Reels (Video ID: ${existingTask.video_id})`,
      { clearLease: true }
    );
    return { status: "ack", reason: "Idempotency guard: Task đã có video_id & post_id." };
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
    await updateTaskExecutionState(db, claimedTask.id, "success", pubRes.message, {
      videoId: pubRes.video_id || "",
      postId: pubRes.post_id || "",
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

  return { status: "dead_letter", reason: finalFailMsg };
}

export async function processTaskQueueMessages(
  db: D1Database,
  env: Env,
  messages: QueueTaskMessage[]
): Promise<void> {
  const concurrency = 3;
  let index = 0;

  async function workerLoop(): Promise<void> {
    while (index < messages.length) {
      const currentIdx = index++;
      const msg = messages[currentIdx];
      if (!msg) continue;
      await consumeSingleTaskMessage(db, env, msg);
    }
  }

  const workers: Promise<void>[] = [];
  const count = Math.min(concurrency, messages.length);
  for (let i = 0; i < count; i++) {
    workers.push(workerLoop());
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
