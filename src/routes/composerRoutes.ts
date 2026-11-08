/**
 * Composer Routes (giao diện Vue mới)
 * - POST /api/tasks       với body { facebook_page_ids[], media_id, publish_mode, ... }
 * - POST /api/tasks/bulk  với body { tasks: [{ facebook_page_ids[], media_id, schedule_date, schedule_time, ... }] }
 *
 * Nguyên tắc:
 * - 1 video x N Fanpage = N task, tạo bằng D1 batch để không vượt giới hạn truy vấn của Workers Free.
 * - Hẹn giờ phải sau thời điểm hiện tại tối thiểu 5 phút (giờ Việt Nam).
 * - Thông báo lỗi không để lộ chi tiết hạ tầng lưu trữ.
 */

import type { D1Database, Env, ExecutionContext, MediaFileRecord } from "../types.ts";
import {
  getFacebookPages,
  getMediaFileById,
  insertComposerTasksBatch,
  normalizeCommentDelayMinutes
} from "../db.ts";
import { verifyMediaOnR2BeforeTaskOrPublish } from "../services/r2MediaService.ts";
import { publishSelectedTasksNow } from "../queue/publishQueue.ts";
import { parseVnScheduleToUtc, formatUtcToVn, nowUtcSeconds } from "../utils/timezone.ts";
import { jsonResponse } from "./responseHelpers.ts";

/** Hẹn giờ tối thiểu sau hiện tại 5 phút */
export const MIN_SCHEDULE_LEAD_SECONDS = 5 * 60;
/** Dung sai cho độ trễ giữa lúc người dùng chọn giờ và lúc bấm gửi */
const SUBMIT_GRACE_SECONDS = 60;
/** Giới hạn số bài tạo trong 1 lần gửi */
const MAX_TASKS_PER_REQUEST = 200;

interface ComposerItemInput {
  facebook_page_ids?: unknown;
  caption?: unknown;
  media_id?: unknown;
  schedule_date?: unknown;
  schedule_time?: unknown;
  comment_text?: unknown;
  comment_delay_minutes?: unknown;
}

interface ResolvedItem {
  pageIds: string[];
  caption: string;
  media: MediaFileRecord;
  scheduleDate: string;
  scheduleTime: string;
  scheduledAt: number;
  commentText: string;
  commentDelayMinutes: number;
}

export function isComposerTaskPayload(body: unknown): boolean {
  return Boolean(
    body && typeof body === "object" && Array.isArray((body as ComposerItemInput).facebook_page_ids)
  );
}

export function isComposerBulkPayload(body: unknown): boolean {
  const tasks = (body as { tasks?: unknown })?.tasks;
  return Array.isArray(tasks) && tasks.length > 0 && tasks.every((t) => isComposerTaskPayload(t));
}

function cleanPageIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map((x) => String(x || "").trim()).filter(Boolean)));
}

async function resolveReadyMedia(
  db: D1Database,
  env: Env,
  mediaIdRaw: unknown,
  ownerUserId: string,
  cache: Map<string, MediaFileRecord | string>
): Promise<{ media?: MediaFileRecord; error?: string }> {
  const mediaId = String(mediaIdRaw || "").trim();
  if (!mediaId) return { error: "Vui lòng chọn video để đăng." };

  const cached = cache.get(mediaId);
  if (cached) return typeof cached === "string" ? { error: cached } : { media: cached };

  const record = await getMediaFileById(db, mediaId, ownerUserId);
  let result: MediaFileRecord | string;
  if (!record || record.id !== mediaId || record.upload_status === "expired") {
    result = "Video không còn tồn tại. Vui lòng chọn lại video.";
  } else if (record.upload_status === "ready") {
    result = record;
  } else {
    const verified = await verifyMediaOnR2BeforeTaskOrPublish(db, env, mediaId, ownerUserId);
    result =
      verified.verified && verified.media
        ? verified.media
        : "Video chưa tải lên xong hoặc bị lỗi. Vui lòng chọn lại video.";
  }
  cache.set(mediaId, result);
  return typeof result === "string" ? { error: result } : { media: result };
}

function validateScheduleSlot(
  dateRaw: unknown,
  timeRaw: unknown,
  nowUtc: number
): { scheduledAt?: number; date?: string; time?: string; error?: string } {
  const date = String(dateRaw || "").trim();
  const time = String(timeRaw || "").trim();
  if (!date || !time) return { error: "Vui lòng chọn ngày giờ đăng." };

  // allowPast: true để đọc đúng giờ 24h người dùng chọn; khoảng cách tối thiểu được kiểm tra bên dưới
  const parsed = parseVnScheduleToUtc(date, time, {
    allowPast: true,
    requireSchedule: true,
    minLeadSeconds: 0
  });
  if (!parsed.isValid || !parsed.scheduledAtUtc) {
    return { error: "Ngày giờ đăng không hợp lệ." };
  }
  if (parsed.scheduledAtUtc < nowUtc + MIN_SCHEDULE_LEAD_SECONDS - SUBMIT_GRACE_SECONDS) {
    return { error: "Thời gian hẹn đăng phải sau thời điểm hiện tại ít nhất 5 phút." };
  }
  return {
    scheduledAt: parsed.scheduledAtUtc,
    date: parsed.normalizedDate || date,
    time: parsed.normalizedTime || time
  };
}

async function resolveItems(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  encryptionKey: string,
  inputs: ComposerItemInput[],
  mode: "now" | "schedule"
): Promise<{ items?: ResolvedItem[]; error?: string }> {
  const nowUtc = nowUtcSeconds();
  const nowVn = formatUtcToVn(nowUtc);
  const ownedPages = await getFacebookPages(db, encryptionKey, { includeToken: false, ownerUserId });
  const ownedIds = new Set(ownedPages.map((p) => p.facebook_page_id));
  const mediaCache = new Map<string, MediaFileRecord | string>();
  const multi = inputs.length > 1;
  const prefix = (i: number) => (multi ? `Bài #${i + 1}: ` : "");

  const items: ResolvedItem[] = [];
  let total = 0;
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const pageIds = cleanPageIds(input.facebook_page_ids);
    if (pageIds.length === 0) return { error: `${prefix(i)}Vui lòng chọn ít nhất một Fanpage.` };
    if (pageIds.some((id) => !ownedIds.has(id))) {
      return { error: `${prefix(i)}Có Fanpage không hợp lệ hoặc bạn không còn quyền đăng.` };
    }

    const mediaRes = await resolveReadyMedia(db, env, input.media_id, ownerUserId, mediaCache);
    if (!mediaRes.media) return { error: `${prefix(i)}${mediaRes.error}` };

    let scheduleDate = nowVn.schedule_date;
    let scheduleTime = nowVn.schedule_time;
    let scheduledAt = nowUtc;
    if (mode === "schedule") {
      const slot = validateScheduleSlot(input.schedule_date, input.schedule_time, nowUtc);
      if (slot.error) return { error: `${prefix(i)}${slot.error}` };
      scheduleDate = slot.date!;
      scheduleTime = slot.time!;
      scheduledAt = slot.scheduledAt!;
    }

    total += pageIds.length;
    if (total > MAX_TASKS_PER_REQUEST) {
      return {
        error: `Mỗi lần chỉ tạo tối đa ${MAX_TASKS_PER_REQUEST} bài đăng. Vui lòng chia nhỏ danh sách.`
      };
    }

    const commentText = String(input.comment_text || "").trim();
    items.push({
      pageIds,
      caption: String(input.caption || "").trim(),
      media: mediaRes.media,
      scheduleDate,
      scheduleTime,
      scheduledAt,
      commentText,
      commentDelayMinutes: commentText ? normalizeCommentDelayMinutes(input.comment_delay_minutes) : 0
    });
  }
  return { items };
}

async function createTasks(
  db: D1Database,
  ownerUserId: string,
  items: ResolvedItem[],
  triggerSource: string
): Promise<number[]> {
  const rows = items.flatMap((it) =>
    it.pageIds.map((pageId) => ({
      facebookPageId: pageId,
      mediaId: it.media.id,
      objectKey: it.media.object_key,
      caption: it.caption,
      commentText: it.commentText,
      commentDelayMinutes: it.commentDelayMinutes,
      scheduleDate: it.scheduleDate,
      scheduleTime: it.scheduleTime,
      scheduledAt: it.scheduledAt,
      triggerSource,
      stageMessage: `Tạo bài đăng hẹn lịch lúc ${it.scheduleDate} ${it.scheduleTime} (giờ Việt Nam).`
    }))
  );
  return insertComposerTasksBatch(db, ownerUserId, rows);
}

function formatVnDisplay(date: string, time: string): string {
  const [y, m, d] = date.split("-");
  return y && m && d ? `${time} ngày ${d}/${m}/${y}` : `${date} ${time}`;
}

/** POST /api/tasks (body có facebook_page_ids[]) */
export async function handleComposerCreateTask(
  body: Record<string, unknown>,
  db: D1Database,
  env: Env,
  ctx: ExecutionContext,
  ownerUserId: string,
  encryptionKey: string
): Promise<Response> {
  const mode = body.publish_mode === "schedule" ? "schedule" : "now";
  const resolved = await resolveItems(
    db,
    env,
    ownerUserId,
    encryptionKey,
    [body as ComposerItemInput],
    mode
  );
  if (!resolved.items) return jsonResponse({ detail: resolved.error, message: resolved.error }, 400);

  const taskIds = await createTasks(
    db,
    ownerUserId,
    resolved.items,
    mode === "now" ? "manual_publish_now" : "scheduled"
  );
  if (taskIds.length === 0) {
    return jsonResponse({ detail: "Không thể tạo bài đăng. Vui lòng thử lại." }, 500);
  }

  if (mode === "now") {
    // Đưa vào hàng đợi đăng ngay. Nếu chưa đưa được, Cron sẽ tự đăng trong vòng 1 phút vì lịch = hiện tại.
    try {
      await publishSelectedTasksNow(db, env, ctx, {
        taskIds,
        ownerUserId,
        actorUserId: ownerUserId,
        triggerSource: taskIds.length > 1 ? "bulk_publish_now" : "manual_publish_now"
      });
    } catch {
      // Cron dự phòng
    }
    return jsonResponse({
      success: true,
      task_ids: taskIds,
      created_count: taskIds.length,
      message: `Đang đăng ${taskIds.length} bài lên Facebook. Theo dõi tiến trình trong mục Lịch đăng.`
    });
  }

  const it = resolved.items[0];
  return jsonResponse({
    success: true,
    task_ids: taskIds,
    created_count: taskIds.length,
    message: `Đã hẹn lịch ${taskIds.length} bài đăng lúc ${formatVnDisplay(it.scheduleDate, it.scheduleTime)}.`
  });
}

/** POST /api/tasks/bulk (mỗi phần tử có facebook_page_ids[]) */
export async function handleComposerBulkCreate(
  body: { tasks: ComposerItemInput[] },
  db: D1Database,
  env: Env,
  ownerUserId: string,
  encryptionKey: string
): Promise<Response> {
  const resolved = await resolveItems(db, env, ownerUserId, encryptionKey, body.tasks, "schedule");
  if (!resolved.items) return jsonResponse({ detail: resolved.error, message: resolved.error }, 400);

  const taskIds = await createTasks(db, ownerUserId, resolved.items, "composer_bulk");
  if (taskIds.length === 0) {
    return jsonResponse({ detail: "Không thể tạo bài đăng. Vui lòng thử lại." }, 500);
  }
  return jsonResponse({
    success: true,
    task_ids: taskIds,
    inserted_count: taskIds.length,
    created_count: taskIds.length,
    message: `Đã hẹn lịch ${taskIds.length} bài đăng.`
  });
}
