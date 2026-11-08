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
  insertTaskCommentsBulk,
  normalizeCommentDelayMinutes,
  MAX_COMMENTS_PER_POST,
  MAX_COMMENT_TEXT_LENGTH
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
  comments?: unknown;
}

interface ResolvedComment {
  message: string;
  imageMediaId: string | null;
  delayMinutes: number;
}

interface ResolvedItem {
  pageIds: string[];
  caption: string;
  media: MediaFileRecord;
  scheduleDate: string;
  scheduleTime: string;
  scheduledAt: number;
  comments: ResolvedComment[];
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
  if (!mediaId) return { error: "Please choose a video to publish." };

  const cached = cache.get(mediaId);
  if (cached) return typeof cached === "string" ? { error: cached } : { media: cached };

  const record = await getMediaFileById(db, mediaId, ownerUserId);
  let result: MediaFileRecord | string;
  if (!record || record.id !== mediaId || record.upload_status === "expired") {
    result = "This video is no longer available. Please choose it again.";
  } else if (!String(record.mime_type || "video/").startsWith("video/")) {
    result = "Please choose a video file to publish.";
  } else if (record.upload_status === "ready") {
    result = record;
  } else {
    const verified = await verifyMediaOnR2BeforeTaskOrPublish(db, env, mediaId, ownerUserId);
    result =
      verified.verified && verified.media
        ? verified.media
        : "The video has not finished uploading. Please choose it again.";
  }
  cache.set(mediaId, result);
  return typeof result === "string" ? { error: result } : { media: result };
}

async function resolveComments(
  db: D1Database,
  input: ComposerItemInput,
  ownerUserId: string,
  imageCache: Map<string, boolean>
): Promise<{ comments?: ResolvedComment[]; error?: string }> {
  const raw: unknown[] = Array.isArray(input.comments)
    ? input.comments
    : String(input.comment_text || "").trim()
      ? [{ text: input.comment_text, delay_minutes: input.comment_delay_minutes }]
      : [];

  const comments: ResolvedComment[] = [];
  for (const entry of raw) {
    const item = (entry || {}) as { text?: unknown; message?: unknown; image_media_id?: unknown; delay_minutes?: unknown };
    const message = String(item.text ?? item.message ?? "").trim();
    const imageMediaId = String(item.image_media_id || "").trim() || null;
    if (!message && !imageMediaId) continue; // empty rows are ignored
    if (message.length > MAX_COMMENT_TEXT_LENGTH) {
      return { error: `Comment #${comments.length + 1} is too long (max ${MAX_COMMENT_TEXT_LENGTH} characters).` };
    }
    if (imageMediaId) {
      let ok = imageCache.get(imageMediaId);
      if (ok === undefined) {
        const rec = await getMediaFileById(db, imageMediaId, ownerUserId);
        ok = Boolean(
          rec && rec.id === imageMediaId && rec.upload_status === "ready" && String(rec.mime_type || "").startsWith("image/")
        );
        imageCache.set(imageMediaId, ok);
      }
      if (!ok) return { error: `The image in comment #${comments.length + 1} is not available. Please attach it again.` };
    }
    comments.push({ message, imageMediaId, delayMinutes: normalizeCommentDelayMinutes(item.delay_minutes) });
  }
  if (comments.length > MAX_COMMENTS_PER_POST) {
    return { error: `You can add up to ${MAX_COMMENTS_PER_POST} comments per post.` };
  }
  return { comments };
}

function validateScheduleSlot(
  dateRaw: unknown,
  timeRaw: unknown,
  nowUtc: number
): { scheduledAt?: number; date?: string; time?: string; error?: string } {
  const date = String(dateRaw || "").trim();
  const time = String(timeRaw || "").trim();
  if (!date || !time) return { error: "Please choose a publish date and time." };

  // allowPast: true để đọc đúng giờ 24h người dùng chọn; khoảng cách tối thiểu được kiểm tra bên dưới
  const parsed = parseVnScheduleToUtc(date, time, {
    allowPast: true,
    requireSchedule: true,
    minLeadSeconds: 0
  });
  if (!parsed.isValid || !parsed.scheduledAtUtc) {
    return { error: "The publish date or time is not valid." };
  }
  if (parsed.scheduledAtUtc < nowUtc + MIN_SCHEDULE_LEAD_SECONDS - SUBMIT_GRACE_SECONDS) {
    return { error: "The scheduled time must be at least 5 minutes from now." };
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
  const imageCache = new Map<string, boolean>();
  const multi = inputs.length > 1;
  const prefix = (i: number) => (multi ? `Post #${i + 1}: ` : "");

  const items: ResolvedItem[] = [];
  let total = 0;
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const pageIds = cleanPageIds(input.facebook_page_ids);
    if (pageIds.length === 0) return { error: `${prefix(i)}Please select at least one Page.` };
    if (pageIds.some((id) => !ownedIds.has(id))) {
      return { error: `${prefix(i)}One of the selected Pages is not valid or you can no longer post to it.` };
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
        error: `You can create up to ${MAX_TASKS_PER_REQUEST} posts at a time. Please split the list.`
      };
    }

    const commentRes = await resolveComments(db, input, ownerUserId, imageCache);
    if (!commentRes.comments) return { error: `${prefix(i)}${commentRes.error}` };
    items.push({
      pageIds,
      caption: String(input.caption || "").trim(),
      media: mediaRes.media,
      scheduleDate,
      scheduleTime,
      scheduledAt,
      comments: commentRes.comments
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
      commentText: "",
      commentDelayMinutes: 0,
      scheduleDate: it.scheduleDate,
      scheduleTime: it.scheduleTime,
      scheduledAt: it.scheduledAt,
      triggerSource,
      stageMessage: `Post created for ${it.scheduleDate} ${it.scheduleTime} (GMT+7).`
    }))
  );
  const taskIds = await insertComposerTasksBatch(db, ownerUserId, rows);

  // Comments: one row per (post, comment). Task ids come back in the same order as rows.
  if (taskIds.length === rows.length) {
    const commentRows: Array<{ taskId: number; position: number; message: string; imageMediaId: string | null; delayMinutes: number }> = [];
    const withComments: number[] = [];
    let k = 0;
    for (const it of items) {
      for (let p = 0; p < it.pageIds.length; p++) {
        const taskId = taskIds[k++];
        if (it.comments.length > 0) withComments.push(taskId);
        it.comments.forEach((c, position) =>
          commentRows.push({ taskId, position, message: c.message, imageMediaId: c.imageMediaId, delayMinutes: c.delayMinutes })
        );
      }
    }
    if (commentRows.length > 0) {
      await insertTaskCommentsBulk(db, ownerUserId, commentRows);
      await db
        .prepare(
          `UPDATE tasks SET comment_status = 'pending', comment_log = ?
           WHERE id IN (SELECT value FROM json_each(?))`
        )
        .bind("Comments will be posted after the video is published.", JSON.stringify(withComments))
        .run();
    }
  }
  return taskIds;
}

function formatVnDisplay(date: string, time: string): string {
  const [y, m, d] = date.split("-");
  return y && m && d ? `${time} on ${d}/${m}/${y}` : `${date} ${time}`;
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
    return jsonResponse({ detail: "Could not create the posts. Please try again." }, 500);
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
      message: `Publishing ${taskIds.length} post(s) to Facebook. Track progress in Schedule.`
    });
  }

  const it = resolved.items[0];
  return jsonResponse({
    success: true,
    task_ids: taskIds,
    created_count: taskIds.length,
    message: `Scheduled ${taskIds.length} post(s) for ${formatVnDisplay(it.scheduleDate, it.scheduleTime)}.`
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
    return jsonResponse({ detail: "Could not create the posts. Please try again." }, 500);
  }
  return jsonResponse({
    success: true,
    task_ids: taskIds,
    inserted_count: taskIds.length,
    created_count: taskIds.length,
    message: `Scheduled ${taskIds.length} post(s).`
  });
}
