/**
 * Cloudflare Cron Trigger Scheduler (`scheduled(event, env, ctx)`)
 * - Chạy định kỳ mỗi phút qua Cloudflare Cron Trigger
 * - Chỉ truy vấn theo batch có index (`idx_tasks_scheduled_at` và `idx_tasks_retry`) để tối ưu Cloudflare Free Plan
 * - Atomically claim các task đến hạn (`scheduled_at <= now_utc`) hoặc đến thời điểm retry (`next_retry_at <= now_utc`)
 * - Đưa vào Queue xử lý xuất bản Reels
 */

import type { D1Database, Env, ExecutionContext, QueueTaskMessage } from "../types.ts";
import { nowUtcSeconds } from "../utils/timezone.ts";
import { randomHex } from "../utils/crypto.ts";
import { appendTaskStageLog } from "../db.ts";
import { processTaskQueueMessages } from "../queue/publishQueue.ts";
import { cleanupExpiredR2Media } from "../services/r2MediaService.ts";
import { syncDueReelsInsightsBatch } from "../services/reelsInsightsService.ts";

export async function dispatchDueScheduledTasks(
  db: D1Database,
  env: Env,
  ctx: ExecutionContext,
  batchLimit = 15
): Promise<{
  checked_at_utc: number;
  claimed_count: number;
  task_ids: number[];
}> {
  const now = nowUtcSeconds();
  const isoNow = new Date().toISOString();

  // 1. Tìm các task đến hạn lịch đăng (status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= now)
  //    HOẶC các task đang chờ retry đến hạn (status = 'queued' AND next_retry_at IS NOT NULL AND next_retry_at <= now)
  //    HOẶC các task bị treo quá thời gian lease (status = 'processing' AND locked_until < now AND attempt_count < max_attempts)
  const { results: candidateRows } = await db
    .prepare(
      `SELECT id, owner_user_id, idempotency_key, attempt_count, status, scheduled_at, next_retry_at
       FROM tasks
       WHERE (
         (status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= ?)
         OR (status = 'queued' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
         OR (status = 'processing' AND locked_until IS NOT NULL AND locked_until < ? AND attempt_count < max_attempts)
       )
       ORDER BY COALESCE(scheduled_at, next_retry_at, 0) ASC
       LIMIT ?`
    )
    .bind(now, now, now, batchLimit)
    .all<{
      id: number;
      owner_user_id: string;
      idempotency_key: string | null;
      attempt_count: number;
      status: string;
      scheduled_at: number | null;
      next_retry_at: number | null;
    }>();

  if (!candidateRows || candidateRows.length === 0) {
    // Khi không có task đến hạn cần đăng ngay, chạy đồng bộ Insights định kỳ cho tối đa 2 Reels
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(syncDueReelsInsightsBatch(db, env, 2, 30).catch(() => {}));
    }
    return {
      checked_at_utc: now,
      claimed_count: 0,
      task_ids: []
    };
  }

  const messagesToEnqueue: QueueTaskMessage[] = [];
  const claimedIds: number[] = [];

  for (const row of candidateRows) {
    const idemKey =
      row.idempotency_key || `cron_${row.owner_user_id}_${row.id}_${randomHex(6)}`;

    // Atomic claim: chuyển sang 'queued' và xóa next_retry_at để không bị cron lần sau lấy trùng
    const claimRes = await db
      .prepare(
        `UPDATE tasks
         SET status = 'queued',
             idempotency_key = ?,
             next_retry_at = NULL,
             locked_until = NULL,
             log = 'Đến giờ hẹn lịch -> Đang đăng video...',
             updated_at = ?
         WHERE id = ?
           AND status = ?`
      )
      .bind(idemKey, isoNow, row.id, row.status)
      .run();

    if ((claimRes.meta?.changes || 0) > 0) {
      claimedIds.push(row.id);
      await appendTaskStageLog(
        db,
        row.id,
        row.owner_user_id,
        "INFO",
        "cron_dispatched",
        `Cron Scheduler kích hoạt tác vụ đến hạn (UTC=${now}).`
      );
      messagesToEnqueue.push({
        task_id: row.id,
        owner_user_id: row.owner_user_id,
        idempotency_key: idemKey,
        attempt: (row.attempt_count || 0) + 1,
        enqueued_at: now
      });
    }
  }

  if (messagesToEnqueue.length > 0) {
    if (env.REELS_QUEUE) {
      await env.REELS_QUEUE.sendBatch(
        messagesToEnqueue.map((m) => ({ body: m }))
      );
    } else {
      ctx.waitUntil(processTaskQueueMessages(db, env, messagesToEnqueue));
    }
  }

  // Tự động dọn dẹp các video lưu trên R2 đã quá 30 ngày (1 tháng)
  try {
    await cleanupExpiredR2Media(db, env, 30, 20);
  } catch (err) {
    console.warn("[Cron] Lỗi dọn dẹp video R2 hết hạn:", err);
  }

  return {
    checked_at_utc: now,
    claimed_count: claimedIds.length,
    task_ids: claimedIds
  };
}

