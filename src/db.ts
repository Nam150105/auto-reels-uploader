/**
 * Cloudflare D1 Data Access Layer (auto-reels-db)
 * - Đảm bảo cô lập dữ liệu Multi-User tuyệt đối (WHERE owner_user_id = ?)
 * - Tối ưu hóa cho Cloudflare Free Plan (Batch queries, Zero N+1 queries, Indexed lookups)
 * - Quản lý Users, Revocable Sessions, OAuth States, Facebook Accounts, Pages, R2 Media, Tasks, Queue Leases & Data Deletion
 */

import type {
  D1Database,
  UserRecord,
  SessionRecord,
  FacebookAccountRecord,
  FacebookPageRecord,
  AdminAccountLink,
  MediaFileRecord,
  TaskRecord,
  TaskAuditLogRecord,
  MetaApiTelemetryRecord
} from "./types.ts";
import {
  hashPassword,
  verifyPassword,
  encryptToken,
  decryptToken,
  detectTokenVersion,
  randomHex
} from "./utils/crypto.ts";
import { parseVnScheduleToUtc, formatUtcToVn, nowUtcSeconds } from "./utils/timezone.ts";
import { sanitizeSensitiveText } from "./utils/sanitize.ts";

let schemaInitialized = false;
let schemaInitPromise: Promise<void> | null = null;

export class TaskLockError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 403) {
    super(message);
    this.name = "TaskLockError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ScheduleValidationError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly fieldErrors: { schedule_date?: string; schedule_time?: string };
  public readonly isPast: boolean;
  public readonly missingDate: boolean;
  public readonly missingTime: boolean;

  constructor(params: {
    code: string;
    message: string;
    httpStatus?: number;
    fieldErrors?: { schedule_date?: string; schedule_time?: string };
    isPast?: boolean;
    missingDate?: boolean;
    missingTime?: boolean;
  }) {
    super(params.message);
    this.name = "ScheduleValidationError";
    this.code = params.code;
    this.httpStatus = params.httpStatus ?? 400;
    this.fieldErrors = params.fieldErrors || {};
    this.isPast = Boolean(params.isPast);
    this.missingDate = Boolean(params.missingDate);
    this.missingTime = Boolean(params.missingTime);
  }
}

export function isTaskPublishedAndLocked(task: {
  status?: string | null;
  raw_status?: string | null;
  publish_status?: string | null;
  is_locked?: boolean | number | null;
  video_id?: string | null;
  post_id?: string | null;
}): boolean {
  const st = String(task.raw_status || task.status || "").toLowerCase();
  const pubSt = String(task.publish_status || "").toLowerCase();
  const hasPublishedIds =
    Boolean(task.video_id && String(task.video_id).trim()) &&
    Boolean(task.post_id && String(task.post_id).trim());
  if (st === "success" || st === "done" || pubSt === "success" || hasPublishedIds) {
    return true;
  }
  if (st === "failed" || pubSt === "failed") {
    return false;
  }
  return Boolean(task.is_locked);
}

export function isTaskCurrentlyRunning(task: {
  status?: string | null;
  raw_status?: string | null;
  publish_status?: string | null;
}): boolean {
  const st = String(task.raw_status || task.status || "").toLowerCase();
  const pubSt = String(task.publish_status || "").toLowerCase();
  return (
    st === "processing" ||
    st === "running" ||
    st === "queued" ||
    pubSt === "processing" ||
    pubSt === "publishing" ||
    pubSt === "uploading"
  );
}

export function assertTaskMutable(
  task: {
    id?: number;
    status?: string | null;
    raw_status?: string | null;
    publish_status?: string | null;
    is_locked?: boolean | number | null;
    video_id?: string | null;
    post_id?: string | null;
  },
  actionLabel = "chỉnh sửa"
): void {
  if (isTaskPublishedAndLocked(task)) {
    throw new TaskLockError(
      "TASK_ALREADY_PUBLISHED",
      `TASK_ALREADY_PUBLISHED: Task đã đăng Reels thành công và không thể ${actionLabel}. Task này đã đăng Reels thành công. Dữ liệu đăng đã được khóa để bảo toàn lịch sử. Bạn vẫn có thể xem thông tin và thống kê bài đăng.`,
      403
    );
  }
  if (isTaskCurrentlyRunning(task)) {
    throw new TaskLockError(
      "TASK_IN_PROGRESS",
      `TASK_IN_PROGRESS: Task đang trong quá trình xử lý đăng Reels, không thể ${actionLabel} lúc này.`,
      409
    );
  }
}

export async function ensureTaskCommentColumns(db: D1Database): Promise<void> {
  try {
    const info = await db.prepare("PRAGMA table_info(tasks)").all<{ name: string }>();
    const existing = new Set((info.results || []).map((c) => c.name));
    if (!existing.has("comment_id")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_id TEXT DEFAULT ''"); } catch {}
    }
    if (!existing.has("comment_status")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_status TEXT DEFAULT 'none'"); } catch {}
    }
    if (!existing.has("comment_log")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_log TEXT DEFAULT ''"); } catch {}
    }
    if (!existing.has("comment_posted_at")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_posted_at TEXT"); } catch {}
    }
    if (!existing.has("r2_status")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN r2_status TEXT DEFAULT 'ready'"); } catch {}
    }
    if (!existing.has("uploaded_at")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN uploaded_at TEXT"); } catch {}
    }
    if (!existing.has("published_at")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN published_at TEXT"); } catch {}
    }
    if (!existing.has("last_processed_at")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN last_processed_at TEXT"); } catch {}
    }
    if (!existing.has("publish_status")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN publish_status TEXT DEFAULT 'pending'"); } catch {}
    }
    if (!existing.has("is_locked")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN is_locked INTEGER DEFAULT 0"); } catch {}
    }
    if (!existing.has("analytics_status")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN analytics_status TEXT DEFAULT 'not_synced'"); } catch {}
    }
    if (!existing.has("analytics_last_synced_at")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN analytics_last_synced_at TEXT"); } catch {}
    }
    if (!existing.has("analytics_error")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN analytics_error TEXT DEFAULT ''"); } catch {}
    }
    if (!existing.has("original_scheduled_at")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN original_scheduled_at INTEGER"); } catch {}
    }
    if (!existing.has("original_schedule_date")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN original_schedule_date TEXT DEFAULT ''"); } catch {}
    }
    if (!existing.has("original_schedule_time")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN original_schedule_time TEXT DEFAULT ''"); } catch {}
    }
    if (!existing.has("manual_publish_requested_at")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN manual_publish_requested_at TEXT"); } catch {}
    }
    if (!existing.has("manual_publish_by_user_id")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN manual_publish_by_user_id TEXT"); } catch {}
    }
    if (!existing.has("trigger_source")) {
      try { await db.exec("ALTER TABLE tasks ADD COLUMN trigger_source TEXT DEFAULT 'scheduled'"); } catch {}
    }
  } catch {
    try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_id TEXT DEFAULT ''"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_status TEXT DEFAULT 'none'"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_log TEXT DEFAULT ''"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN comment_posted_at TEXT"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN r2_status TEXT DEFAULT 'ready'"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN uploaded_at TEXT"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN published_at TEXT"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN last_processed_at TEXT"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN publish_status TEXT DEFAULT 'pending'"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN is_locked INTEGER DEFAULT 0"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN analytics_status TEXT DEFAULT 'not_synced'"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN analytics_last_synced_at TEXT"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN analytics_error TEXT DEFAULT ''"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN original_scheduled_at INTEGER"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN original_schedule_date TEXT DEFAULT ''"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN original_schedule_time TEXT DEFAULT ''"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN manual_publish_requested_at TEXT"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN manual_publish_by_user_id TEXT"); } catch {}
    try { await db.exec("ALTER TABLE tasks ADD COLUMN trigger_source TEXT DEFAULT 'scheduled'"); } catch {}
  }

  try {
    await db
      .prepare(
        "UPDATE tasks SET is_locked = 0 WHERE status = 'failed' AND (post_id IS NULL OR post_id = '')"
      )
      .run();
  } catch {}

  try {
    const accInfo = await db.prepare("PRAGMA table_info(facebook_accounts)").all<{ name: string }>();
    const existingAcc = new Set((accInfo.results || []).map((c) => c.name));
    if (!existingAcc.has("has_read_insights")) {
      try { await db.exec("ALTER TABLE facebook_accounts ADD COLUMN has_read_insights INTEGER DEFAULT 0"); } catch {}
    }
    if (!existingAcc.has("last_token_checked_at")) {
      try { await db.exec("ALTER TABLE facebook_accounts ADD COLUMN last_token_checked_at TEXT"); } catch {}
    }
  } catch {
    try { await db.exec("ALTER TABLE facebook_accounts ADD COLUMN has_read_insights INTEGER DEFAULT 0"); } catch {}
    try { await db.exec("ALTER TABLE facebook_accounts ADD COLUMN last_token_checked_at TEXT"); } catch {}
  }

  try {
    const pageInfo = await db.prepare("PRAGMA table_info(facebook_pages)").all<{ name: string }>();
    const existingPage = new Set((pageInfo.results || []).map((c) => c.name));
    if (!existingPage.has("can_analyze")) {
      try { await db.exec("ALTER TABLE facebook_pages ADD COLUMN can_analyze INTEGER DEFAULT 0"); } catch {}
    }
    const accPageInfo = await db.prepare("PRAGMA table_info(facebook_account_pages)").all<{ name: string }>();
    const existingAccPage = new Set((accPageInfo.results || []).map((c) => c.name));
    if (!existingAccPage.has("can_analyze")) {
      try { await db.exec("ALTER TABLE facebook_account_pages ADD COLUMN can_analyze INTEGER DEFAULT 0"); } catch {}
    }
  } catch {
    try { await db.exec("ALTER TABLE facebook_pages ADD COLUMN can_analyze INTEGER DEFAULT 0"); } catch {}
    try { await db.exec("ALTER TABLE facebook_account_pages ADD COLUMN can_analyze INTEGER DEFAULT 0"); } catch {}
  }

  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS reel_insight_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        facebook_page_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        post_id TEXT DEFAULT '',
        sync_date TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'success',
        views INTEGER,
        plays INTEGER,
        initial_plays INTEGER,
        replays INTEGER,
        reach INTEGER,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        total_interactions INTEGER,
        total_watch_time_ms INTEGER,
        avg_watch_time_ms INTEGER,
        video_length_sec REAL,
        retention_json TEXT DEFAULT '[]',
        raw_metrics_json TEXT DEFAULT '{}',
        error_code INTEGER,
        error_message TEXT DEFAULT '',
        UNIQUE(task_id, sync_date)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS reel_insight_metric_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        facebook_page_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        post_id TEXT DEFAULT '',
        metric_name TEXT NOT NULL,
        metric_value REAL,
        metric_json TEXT DEFAULT '',
        period TEXT DEFAULT 'lifetime',
        fetched_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'supported',
        error_message TEXT DEFAULT '',
        UNIQUE(task_id, metric_name)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_reel_snapshots_owner_page ON reel_insight_snapshots(owner_user_id, facebook_page_id, sync_date)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_reel_snapshots_task ON reel_insight_snapshots(task_id, sync_date)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_reel_metrics_owner_task ON reel_insight_metric_items(owner_user_id, task_id)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS task_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        owner_user_id TEXT NOT NULL,
        actor_user_id TEXT,
        action TEXT NOT NULL,
        old_scheduled_at INTEGER,
        new_scheduled_at INTEGER,
        old_schedule_text TEXT DEFAULT '',
        new_schedule_text TEXT DEFAULT '',
        old_status TEXT DEFAULT '',
        new_status TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_task_audit_logs_task ON task_audit_logs(task_id, created_at)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_task_audit_logs_owner ON task_audit_logs(owner_user_id, created_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS meta_api_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_hour TEXT NOT NULL,
        endpoint_group TEXT NOT NULL,
        total_requests INTEGER NOT NULL DEFAULT 0,
        cache_hits INTEGER NOT NULL DEFAULT 0,
        cache_misses INTEGER NOT NULL DEFAULT 0,
        error_requests INTEGER NOT NULL DEFAULT 0,
        rate_limited_requests INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_app_call_pct REAL DEFAULT 0,
        max_page_call_pct REAL DEFAULT 0,
        last_status_code INTEGER DEFAULT 200,
        last_error_code INTEGER,
        updated_at TEXT NOT NULL,
        UNIQUE(bucket_hour, endpoint_group)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_sched ON tasks(owner_user_id, status, scheduled_at)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_owner_page_status ON tasks(owner_user_id, facebook_page_id, status)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS facebook_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        video_id TEXT,
        message TEXT DEFAULT '',
        post_type TEXT NOT NULL DEFAULT 'status',
        status_type TEXT DEFAULT '',
        permalink_url TEXT DEFAULT '',
        thumbnail_url TEXT DEFAULT '',
        media_url TEXT DEFAULT '',
        attachments_json TEXT DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'facebook_external',
        task_id INTEGER,
        created_time TEXT NOT NULL,
        updated_time TEXT,
        synced_at TEXT NOT NULL,
        deleted_at TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        likes_count INTEGER DEFAULT 0,
        comments_count INTEGER DEFAULT 0,
        shares_count INTEGER DEFAULT 0,
        views_count INTEGER DEFAULT 0,
        raw_data_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(page_id, post_id)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS facebook_page_sync_states (
        page_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'idle',
        next_cursor TEXT,
        previous_cursor TEXT,
        total_synced INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (page_id, owner_user_id)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS facebook_post_comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        from_id TEXT DEFAULT '',
        from_name TEXT DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        created_time TEXT NOT NULL,
        can_comment INTEGER DEFAULT 1,
        can_remove INTEGER DEFAULT 0,
        can_hide INTEGER DEFAULT 0,
        is_hidden INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        comment_count INTEGER DEFAULT 0,
        synced_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS facebook_post_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        old_data TEXT DEFAULT '',
        new_data TEXT DEFAULT '',
        result_status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_posts_owner_page ON facebook_posts(owner_user_id, page_id, created_time DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_posts_type ON facebook_posts(owner_user_id, post_type, created_time DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_posts_source ON facebook_posts(owner_user_id, source, created_time DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_posts_task ON facebook_posts(task_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_posts_post_id ON facebook_posts(post_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_comments_post ON facebook_post_comments(post_id, created_time DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_comments_parent ON facebook_post_comments(parent_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fb_post_audit_post ON facebook_post_audit_logs(post_id, id DESC)`)
    ]);
  } catch {}

  try {
    const mediaInfo = await db.prepare("PRAGMA table_info(media_files)").all<{ name: string }>();
    const existingMedia = new Set((mediaInfo.results || []).map((c) => c.name));
    if (!existingMedia.has("r2_bucket")) {
      try { await db.exec("ALTER TABLE media_files ADD COLUMN r2_bucket TEXT DEFAULT 'auto-reels-media'"); } catch {}
    }
    if (!existingMedia.has("verified_at")) {
      try { await db.exec("ALTER TABLE media_files ADD COLUMN verified_at TEXT"); } catch {}
    }
    if (!existingMedia.has("storage_error")) {
      try { await db.exec("ALTER TABLE media_files ADD COLUMN storage_error TEXT DEFAULT ''"); } catch {}
    }
  } catch {
    try { await db.exec("ALTER TABLE media_files ADD COLUMN r2_bucket TEXT DEFAULT 'auto-reels-media'"); } catch {}
    try { await db.exec("ALTER TABLE media_files ADD COLUMN verified_at TEXT"); } catch {}
    try { await db.exec("ALTER TABLE media_files ADD COLUMN storage_error TEXT DEFAULT ''"); } catch {}
  }
}

export async function ensureDatabaseInitialized(
  db: D1Database,
  encryptionKey: string
): Promise<void> {
  if (schemaInitialized) return;
  if (schemaInitPromise) return schemaInitPromise;

  schemaInitPromise = (async () => {
    try {
      const fastCheck = await db
        .prepare("SELECT id FROM users WHERE username = ? LIMIT 1")
        .bind("admin")
        .first<{ id: string }>();
      if (fastCheck?.id) {
        await db.prepare("SELECT 1 FROM user_page_permissions LIMIT 1").first();
        await ensureTaskCommentColumns(db);
        schemaInitialized = true;
        return;
      }
    } catch {
      // Schema chưa khởi tạo đầy đủ, tiếp tục chạy DDL batch bên dưới
    }

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      expires_at INTEGER NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      action_type TEXT NOT NULL DEFAULT 'connect',
      reconnect_account_id TEXT,
      redirect_after TEXT DEFAULT '/pages',
      used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS facebook_accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      facebook_user_id TEXT NOT NULL,
      facebook_user_name TEXT,
      facebook_user_email TEXT,
      access_token TEXT NOT NULL,
      token_version TEXT NOT NULL DEFAULT 'v2',
      token_type TEXT DEFAULT 'long_lived_user',
      scopes TEXT DEFAULT '[]',
      missing_scopes TEXT DEFAULT '[]',
      status TEXT DEFAULT 'connected',
      token_status TEXT DEFAULT 'valid',
      connected_at TEXT,
      token_expires_at TEXT,
      last_synced_at TEXT,
      last_error TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(owner_user_id, facebook_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS facebook_pages (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      facebook_page_id TEXT NOT NULL,
      page_name TEXT NOT NULL,
      category TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      page_access_token TEXT NOT NULL,
      token_version TEXT NOT NULL DEFAULT 'v2',
      tasks_json TEXT DEFAULT '[]',
      can_post INTEGER DEFAULT 1,
      is_published INTEGER DEFAULT 1,
      is_selected INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      token_status TEXT DEFAULT 'valid',
      connected_account_id TEXT,
      last_synced_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(owner_user_id, facebook_page_id)
    )`,
    `CREATE TABLE IF NOT EXISTS facebook_account_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL,
      facebook_account_id TEXT NOT NULL,
      facebook_page_id TEXT NOT NULL,
      page_access_token TEXT,
      token_version TEXT NOT NULL DEFAULT 'v2',
      tasks_json TEXT DEFAULT '[]',
      can_post INTEGER DEFAULT 1,
      is_published INTEGER DEFAULT 1,
      token_status TEXT DEFAULT 'valid',
      last_synced_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(facebook_account_id, facebook_page_id)
    )`,
    `CREATE TABLE IF NOT EXISTS media_files (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'video/mp4',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256_checksum TEXT,
      upload_status TEXT NOT NULL DEFAULT 'pending',
      r2_upload_id TEXT,
      storage_backend TEXT NOT NULL DEFAULT 'r2',
      r2_bucket TEXT DEFAULT 'auto-reels-media',
      verified_at TEXT,
      storage_error TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, object_key)
    )`,
    `CREATE TABLE IF NOT EXISTS media_blobs_fallback (
      media_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      data_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      facebook_page_name TEXT,
      facebook_page_id TEXT,
      status TEXT DEFAULT 'idle',
      notes TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL,
      profile_id TEXT,
      facebook_page_id TEXT,
      media_id TEXT,
      object_key TEXT,
      video_path TEXT NOT NULL,
      caption TEXT DEFAULT '',
      comment_text TEXT DEFAULT '',
      schedule_date TEXT DEFAULT '',
      schedule_time TEXT DEFAULT '',
      scheduled_at INTEGER,
      timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      status TEXT NOT NULL DEFAULT 'pending',
      idempotency_key TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_retry_at INTEGER,
      locked_until INTEGER,
      lease_owner TEXT,
      error_code INTEGER,
      error_subcode INTEGER,
      retryable INTEGER NOT NULL DEFAULT 1,
      log TEXT DEFAULT '',
      video_id TEXT DEFAULT '',
      post_id TEXT DEFAULT '',
      video_url TEXT DEFAULT '',
      comment_id TEXT DEFAULT '',
      comment_status TEXT DEFAULT 'none',
      comment_log TEXT DEFAULT '',
      comment_posted_at TEXT,
      r2_status TEXT DEFAULT 'ready',
      uploaded_at TEXT,
      published_at TEXT,
      last_processed_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS task_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      owner_user_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      error_code INTEGER,
      error_subcode INTEGER,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      owner_user_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'INFO',
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS data_deletion_requests (
      confirmation_code TEXT PRIMARY KEY,
      facebook_user_id TEXT,
      owner_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      deleted_summary TEXT NOT NULL DEFAULT '{}',
      requested_at TEXT NOT NULL,
      completed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fb_accounts_owner ON facebook_accounts(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fb_pages_owner ON facebook_pages(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fb_pages_page_id ON facebook_pages(facebook_page_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fb_acc_pages_owner ON facebook_account_pages(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_media_files_owner ON media_files(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_page_id ON tasks(facebook_page_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(status, scheduled_at)`,
    `CREATE VIEW IF NOT EXISTS user_page_permissions AS
      SELECT
        fap.id AS link_id,
        COALESCE(fap.owner_user_id, fa.owner_user_id, fp.owner_user_id) AS owner_user_id,
        fa.id AS account_id,
        fa.facebook_user_id,
        fa.facebook_user_name,
        fa.status AS account_status,
        fa.token_status AS account_token_status,
        fa.token_expires_at,
        fp.id AS internal_page_id,
        fap.facebook_page_id,
        fp.page_name,
        fp.category,
        fp.avatar_url,
        fap.tasks_json,
        fap.can_post,
        fap.is_published,
        fap.token_status AS page_token_status,
        fap.last_synced_at
      FROM facebook_account_pages fap
      JOIN facebook_accounts fa ON fa.id = fap.facebook_account_id
      LEFT JOIN facebook_pages fp
        ON fp.facebook_page_id = fap.facebook_page_id
        AND COALESCE(fp.owner_user_id, '') = COALESCE(fa.owner_user_id, '')`,
    `CREATE VIEW IF NOT EXISTS admin_token_registry AS
      SELECT
        fa.id AS token_record_id,
        fa.owner_user_id AS admin_user_id,
        fa.facebook_user_id,
        fa.facebook_user_name,
        fap.facebook_page_id AS page_id,
        fp.page_name,
        fa.token_type,
        fa.token_version,
        fa.status AS account_status,
        COALESCE(fap.token_status, fa.token_status) AS token_status,
        fa.token_expires_at AS expires_at,
        COALESCE(fap.last_synced_at, fa.last_synced_at) AS last_synced_at,
        fa.updated_at
      FROM facebook_accounts fa
      LEFT JOIN facebook_account_pages fap ON fap.facebook_account_id = fa.id
      LEFT JOIN facebook_pages fp
        ON fp.facebook_page_id = fap.facebook_page_id
        AND COALESCE(fp.owner_user_id, '') = COALESCE(fa.owner_user_id, '')`
  ];

  await db.batch(statements.map((sql) => db.prepare(sql)));

  // Tương thích với CSDL hiện có (Thêm các cột trạng thái comment nếu chưa có)
  await ensureTaskCommentColumns(db);

  // Khởi tạo tài khoản quản trị viên mặc định nếu hệ thống mới tinh
  const existingAdmin = await db
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind("admin")
    .first<{ id: string }>();

  if (!existingAdmin) {
    const now = new Date().toISOString();
    const defaultHash = await hashPassword("admin123", "d1defaultadminsalt2026");
    await db
      .prepare(
        `INSERT OR IGNORE INTO users (id, username, email, password_hash, full_name, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .bind(
        "usr_admin",
        "admin",
        "admin@pagefb.namnangno.click",
        defaultHash,
        "System Administrator",
        "admin",
        now,
        now
      )
      .run();
  }

  schemaInitialized = true;
  })();

  try {
    await schemaInitPromise;
  } finally {
    schemaInitPromise = null;
  }
}

// ==========================================
// 1. USERS, SESSIONS & RATE LIMITING
// ==========================================

export async function checkRateLimit(
  db: D1Database,
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const now = nowUtcSeconds();
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ window_start: number; count: number }>();

  if (!row || now - Number(row.window_start) >= windowSeconds) {
    await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1, updated_at = excluded.updated_at`
      )
      .bind(key, now, now)
      .run();
    return { allowed: true, remaining: Math.max(0, maxRequests - 1), retryAfterSeconds: 0 };
  }

  const currentCount = Number(row.count) || 0;
  if (currentCount >= maxRequests) {
    const retryAfter = Math.max(1, windowSeconds - (now - Number(row.window_start)));
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
  }

  await db
    .prepare("UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE key = ?")
    .bind(now, key)
    .run();

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - (currentCount + 1)),
    retryAfterSeconds: 0
  };
}

export async function createSessionRecord(
  db: D1Database,
  params: {
    sessionId: string;
    userId: string;
    tokenHash: string;
    csrfToken: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    expiresAt: number;
  }
): Promise<SessionRecord> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip_address, user_agent, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .bind(
      params.sessionId,
      params.userId,
      params.tokenHash,
      params.csrfToken,
      params.ipAddress || null,
      params.userAgent || null,
      params.expiresAt,
      now
    )
    .run();

  return {
    id: params.sessionId,
    user_id: params.userId,
    token_hash: params.tokenHash,
    csrf_token: params.csrfToken,
    ip_address: params.ipAddress || null,
    user_agent: params.userAgent || null,
    expires_at: params.expiresAt,
    revoked_at: null,
    created_at: now
  };
}

export async function getValidSessionByTokenHash(
  db: D1Database,
  tokenHash: string
): Promise<SessionRecord | null> {
  const now = nowUtcSeconds();
  const row = await db
    .prepare(
      `SELECT id, user_id, token_hash, csrf_token, ip_address, user_agent, expires_at, revoked_at, created_at
       FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`
    )
    .bind(tokenHash, now)
    .first<SessionRecord>();
  return row || null;
}

export async function revokeSessionByTokenHash(
  db: D1Database,
  tokenHash: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(now, tokenHash)
    .run();
  return (res.meta?.changes || 0) > 0;
}

export async function revokeAllUserSessions(
  db: D1Database,
  userId: string
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .bind(now, userId)
    .run();
  return res.meta?.changes || 0;
}

export async function getUserByUsername(
  db: D1Database,
  username: string
): Promise<UserRecord | null> {
  const clean = (username || "").trim().toLowerCase();
  if (!clean) return null;
  return db
    .prepare("SELECT * FROM users WHERE LOWER(username) = ?")
    .bind(clean)
    .first<UserRecord>();
}

export async function getUserById(
  db: D1Database,
  userId: string
): Promise<UserRecord | null> {
  if (!userId) return null;
  const user = await db
    .prepare(
      "SELECT id, username, email, full_name, role, is_active, created_at, updated_at FROM users WHERE id = ?"
    )
    .bind(userId)
    .first<UserRecord>();
  if (!user || !user.is_active) return null;
  return user;
}

export async function createUser(
  db: D1Database,
  username: string,
  password: string,
  fullName?: string | null,
  email?: string | null,
  role = "member"
): Promise<{ success: boolean; message?: string; user?: UserRecord }> {
  const cleanUser = (username || "").trim().toLowerCase();
  if (!cleanUser || cleanUser.length < 3) {
    return { success: false, message: "Tên đăng nhập phải có ít nhất 3 ký tự." };
  }
  if (!/^[a-z0-9_.\-@]+$/.test(cleanUser)) {
    return {
      success: false,
      message: "Tên đăng nhập chỉ được chứa chữ cái, chữ số và các ký tự _, ., -, @."
    };
  }
  if (!password || password.length < 6) {
    return { success: false, message: "Mật khẩu phải có ít nhất 6 ký tự." };
  }

  const existing = await getUserByUsername(db, cleanUser);
  if (existing) {
    return { success: false, message: "Tên đăng nhập này đã được sử dụng." };
  }

  const userId = `usr_${randomHex(6)}`;
  const now = new Date().toISOString();
  const pwdHash = await hashPassword(password);
  const displayName = (fullName || "").trim() || cleanUser;
  const cleanEmail = (email || "").trim() || null;

  await db
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(userId, cleanUser, cleanEmail, pwdHash, displayName, role, now, now)
    .run();

  const user = await getUserById(db, userId);
  return { success: true, user: user || undefined };
}

export async function verifyUserCredentials(
  db: D1Database,
  username: string,
  password: string
): Promise<UserRecord | null> {
  const row = await getUserByUsername(db, username);
  if (!row || !row.is_active || !row.password_hash) {
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  delete row.password_hash;
  return row;
}

// ==========================================
// 2. OAUTH CSRF STATE (D1 PERSISTENCE)
// ==========================================

export async function createOAuthState(
  db: D1Database,
  state: string,
  ownerUserId: string,
  reconnectAccountId: string | null = null,
  actionType = "connect",
  redirectAfter = "/page",
  ttlSeconds = 600
): Promise<void> {
  const now = nowUtcSeconds();
  const expiresAt = now + ttlSeconds;

  await db
    .prepare("DELETE FROM oauth_states WHERE expires_at < ? OR used = 1")
    .bind(now)
    .run();

  await db
    .prepare(
      `INSERT INTO oauth_states (state, owner_user_id, action_type, reconnect_account_id, redirect_after, used, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      state,
      ownerUserId,
      actionType,
      reconnectAccountId,
      redirectAfter,
      now,
      expiresAt
    )
    .run();
}

export async function consumeOAuthState(
  db: D1Database,
  state: string
): Promise<{
  valid: boolean;
  owner_user_id?: string;
  action_type?: string;
  reconnect_account_id?: string | null;
  redirect_after?: string;
  message?: string;
}> {
  if (!state) {
    return {
      valid: false,
      message: "Thiếu tham số CSRF state trong phản hồi từ Facebook."
    };
  }

  const row = await db
    .prepare(
      "SELECT state, owner_user_id, action_type, reconnect_account_id, redirect_after, used, expires_at FROM oauth_states WHERE state = ?"
    )
    .bind(state)
    .first<{
      state: string;
      owner_user_id: string;
      action_type: string;
      reconnect_account_id: string | null;
      redirect_after: string;
      used: number;
      expires_at: number;
    }>();

  if (!row) {
    return {
      valid: false,
      message: "Mã xác thực bảo mật (CSRF State) không tồn tại hoặc đã bị thu hồi."
    };
  }

  const now = nowUtcSeconds();
  if (row.used === 1) {
    return {
      valid: false,
      message: "Phiên xác thực OAuth này đã được sử dụng trước đó. Vui lòng thử lại."
    };
  }

  // Atomic one-time state consumption
  const updateRes = await db
    .prepare("UPDATE oauth_states SET used = 1 WHERE state = ? AND used = 0")
    .bind(state)
    .run();

  if ((updateRes.meta?.changes || 0) === 0) {
    return {
      valid: false,
      message: "Phiên xác thực OAuth đã được xử lý ở một yêu cầu khác."
    };
  }

  if (now > row.expires_at) {
    return {
      valid: false,
      message: "Phiên kết nối OAuth đã hết hạn (quá 10 phút). Vui lòng thực hiện lại."
    };
  }

  return {
    valid: true,
    owner_user_id: row.owner_user_id,
    action_type: row.action_type || "connect",
    reconnect_account_id: row.reconnect_account_id,
    redirect_after: row.redirect_after || "/page"
  };
}

// ==========================================
// 3. FACEBOOK ADMIN ACCOUNTS (MULTI-ADMIN)
// ==========================================

function safeJsonParseArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function saveFacebookAccount(
  db: D1Database,
  encryptionKey: string,
  params: {
    facebookUserId: string;
    facebookUserName: string;
    accessToken: string;
    tokenType?: string;
    scopes?: string[];
    missingScopes?: string[];
    hasReadInsights?: boolean;
    tokenExpiresAt?: string | null;
    status?: string;
    tokenStatus?: string;
    lastError?: string | null;
    accountId?: string | null;
    ownerUserId: string;
    facebookUserEmail?: string | null;
  }
): Promise<string> {
  const now = new Date().toISOString();
  const encryptedToken = await encryptToken(params.accessToken, encryptionKey, "v2");
  const tokenVersion = detectTokenVersion(encryptedToken);
  const scopesArr = params.scopes || [];
  const scopesJson = JSON.stringify(scopesArr);
  const missingJson = JSON.stringify(params.missingScopes || []);
  const hasReadInsightsInt =
    params.hasReadInsights !== undefined
      ? params.hasReadInsights
        ? 1
        : 0
      : scopesArr.some((s) => s.toLowerCase() === "read_insights")
        ? 1
        : 0;
  const status = params.status || "connected";
  const tokenStatus = params.tokenStatus || (status === "connected" ? "valid" : status);

  let existing = await db
    .prepare(
      "SELECT id FROM facebook_accounts WHERE facebook_user_id = ? AND owner_user_id = ?"
    )
    .bind(params.facebookUserId, params.ownerUserId)
    .first<{ id: string }>();

  if (!existing && params.accountId) {
    existing = await db
      .prepare(
        "SELECT id FROM facebook_accounts WHERE id = ? AND owner_user_id = ?"
      )
      .bind(params.accountId, params.ownerUserId)
      .first<{ id: string }>();
  }

  let targetId = params.accountId || existing?.id || `fb_acc_${params.facebookUserId}_${randomHex(3)}`;
  if (existing?.id) {
    targetId = existing.id;
  }

  await ensureTaskCommentColumns(db);

  if (existing) {
    await db
      .prepare(
        `UPDATE facebook_accounts
         SET facebook_user_id = ?,
             facebook_user_name = ?,
             facebook_user_email = COALESCE(?, facebook_user_email),
             access_token = ?,
             token_version = ?,
             token_type = ?,
             scopes = ?,
             missing_scopes = ?,
             has_read_insights = ?,
             status = ?,
             token_status = ?,
             connected_at = ?,
             token_expires_at = ?,
             last_token_checked_at = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
      .bind(
        params.facebookUserId,
        params.facebookUserName,
        params.facebookUserEmail || null,
        encryptedToken,
        tokenVersion,
        params.tokenType || "long_lived_user",
        scopesJson,
        missingJson,
        hasReadInsightsInt,
        status,
        tokenStatus,
        now,
        params.tokenExpiresAt || null,
        now,
        params.lastError ? sanitizeSensitiveText(params.lastError) : null,
        now,
        targetId,
        params.ownerUserId
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO facebook_accounts (
           id, owner_user_id, facebook_user_id, facebook_user_name, facebook_user_email,
           access_token, token_version, token_type, scopes, missing_scopes, has_read_insights, status, token_status,
           connected_at, token_expires_at, last_token_checked_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        targetId,
        params.ownerUserId,
        params.facebookUserId,
        params.facebookUserName,
        params.facebookUserEmail || null,
        encryptedToken,
        tokenVersion,
        params.tokenType || "long_lived_user",
        scopesJson,
        missingJson,
        hasReadInsightsInt,
        status,
        tokenStatus,
        now,
        params.tokenExpiresAt || null,
        now,
        params.lastError ? sanitizeSensitiveText(params.lastError) : null,
        now,
        now
      )
      .run();
  }

  return targetId;
}

export async function getFacebookAccounts(
  db: D1Database,
  encryptionKey: string,
  includeToken = false,
  ownerUserId: string
): Promise<FacebookAccountRecord[]> {
  const [accountsResult, linksResult] = await db.batch([
    db
      .prepare(
        `SELECT fa.*,
                (SELECT COUNT(*) FROM facebook_account_pages fap WHERE fap.facebook_account_id = fa.id) AS page_count,
                (SELECT COUNT(*) FROM facebook_account_pages fap WHERE fap.facebook_account_id = fa.id AND fap.can_post = 1) AS postable_count
         FROM facebook_accounts fa
         WHERE fa.owner_user_id = ?
         ORDER BY fa.connected_at DESC, fa.created_at DESC`
      )
      .bind(ownerUserId),
    db
      .prepare(
        `SELECT fap.facebook_account_id,
                fap.facebook_page_id,
                fap.can_post,
                fap.can_analyze,
                COALESCE(fp.page_name, fap.facebook_page_id) AS page_name,
                COALESCE(fp.category, '') AS category,
                COALESCE(fp.avatar_url, '') AS avatar_url
         FROM facebook_account_pages fap
         LEFT JOIN facebook_pages fp
           ON fp.facebook_page_id = fap.facebook_page_id
           AND fp.owner_user_id = fap.owner_user_id
         WHERE fap.owner_user_id = ?
         ORDER BY fp.page_name COLLATE NOCASE ASC`
      )
      .bind(ownerUserId)
  ]);

  const rows = (accountsResult.results || []) as Record<string, unknown>[];
  const linkRows = (linksResult.results || []) as Record<string, unknown>[];

  const pagesByAccountId = new Map<
    string,
    Array<{
      facebook_page_id: string;
      page_name: string;
      category: string;
      avatar_url: string;
      can_post: boolean;
      can_analyze: boolean;
    }>
  >();

  for (const lr of linkRows) {
    const accId = String(lr.facebook_account_id || "");
    if (!accId) continue;
    const list = pagesByAccountId.get(accId) || [];
    list.push({
      facebook_page_id: String(lr.facebook_page_id || ""),
      page_name: String(lr.page_name || lr.facebook_page_id || ""),
      category: String(lr.category || ""),
      avatar_url: String(lr.avatar_url || ""),
      can_post: Boolean(lr.can_post),
      can_analyze: Boolean(lr.can_analyze)
    });
    pagesByAccountId.set(accId, list);
  }

  const out: FacebookAccountRecord[] = [];

  for (const r of rows) {
    const scopes = safeJsonParseArray(r.scopes as string);
    const missingScopes = safeJsonParseArray(r.missing_scopes as string);
    const hasReadInsights =
      r.has_read_insights !== undefined && r.has_read_insights !== null
        ? Boolean(r.has_read_insights)
        : scopes.some((s) => s.toLowerCase() === "read_insights");

    let daysRemaining: number | null = null;
    let isExpired = false;
    const expStr = r.token_expires_at as string | null;
    if (expStr) {
      const expDate = new Date(expStr);
      if (!isNaN(expDate.getTime())) {
        const diffMs = expDate.getTime() - Date.now();
        daysRemaining = Math.max(0, Math.floor(diffMs / 86400000));
        if (diffMs < 0) isExpired = true;
      }
    }

    let status = (r.status as string) || "connected";
    let tokenStatus = (r.token_status as string) || "valid";
    if (isExpired && status === "connected") {
      status = "expired";
      tokenStatus = "expired";
    }

    const accId = String(r.id);
    const linkedPages = pagesByAccountId.get(accId) || [];
    const pageCount = Number(r.page_count ?? linkedPages.length);
    const postableCount = Number(r.postable_count ?? pageCount);
    const fbUserId = String(r.facebook_user_id);
    const fbUserName = (r.facebook_user_name as string) || null;

    const item: FacebookAccountRecord = {
      id: accId,
      owner_user_id: (r.owner_user_id as string) || null,
      facebook_user_id: fbUserId,
      user_id: fbUserId,
      facebook_user_name: fbUserName,
      user_name: fbUserName,
      facebook_user_email: (r.facebook_user_email as string) || null,
      token_version: (r.token_version as string) || "v2",
      token_type: (r.token_type as string) || "long_lived_user",
      scopes,
      missing_scopes: missingScopes,
      has_read_insights: hasReadInsights,
      status,
      token_status: tokenStatus,
      connected_at: (r.connected_at as string) || null,
      token_expires_at: expStr,
      expires_at: expStr,
      last_synced_at: (r.last_synced_at as string) || null,
      last_token_checked_at: (r.last_token_checked_at as string) || null,
      last_error: (r.last_error as string) || null,
      created_at: (r.created_at as string) || null,
      updated_at: (r.updated_at as string) || null,
      page_count: pageCount,
      managed_pages_count: pageCount,
      postable_pages_count: postableCount,
      days_remaining: daysRemaining,
      is_expired: isExpired,
      pages: linkedPages
    };

    if (includeToken) {
      item.access_token = await decryptToken(String(r.access_token || ""), encryptionKey);
    }

    out.push(item);
  }

  return out;
}

export async function getFacebookAccountById(
  db: D1Database,
  encryptionKey: string,
  accountId: string,
  includeToken = false,
  ownerUserId: string
): Promise<FacebookAccountRecord | null> {
  const accounts = await getFacebookAccounts(db, encryptionKey, includeToken, ownerUserId);
  return accounts.find((a) => a.id === accountId) || null;
}

export async function updateFacebookAccountStatus(
  db: D1Database,
  accountId: string,
  status: string,
  lastError: string | null = null,
  lastSyncedAt: string | null = null,
  tokenStatus: string | null = null
): Promise<void> {
  const now = new Date().toISOString();
  const resolvedTokenStatus =
    tokenStatus ||
    (status === "connected"
      ? "valid"
      : status === "expired" || status === "invalid"
      ? "expired"
      : status);

  await db
    .prepare(
      `UPDATE facebook_accounts
       SET status = ?,
           token_status = ?,
           last_error = ?,
           last_synced_at = COALESCE(?, last_synced_at),
           last_token_checked_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      status,
      resolvedTokenStatus,
      lastError ? sanitizeSensitiveText(lastError) : null,
      lastSyncedAt,
      now,
      now,
      accountId
    )
    .run();
}

export async function disconnectFacebookAccount(
  db: D1Database,
  accountId: string,
  ownerUserId: string
): Promise<boolean> {
  const acc = await db
    .prepare("SELECT id, owner_user_id FROM facebook_accounts WHERE id = ? AND owner_user_id = ?")
    .bind(accountId, ownerUserId)
    .first<{ id: string; owner_user_id: string }>();

  if (!acc) return false;

  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE facebook_accounts
         SET status = 'disconnected', token_status = 'revoked', access_token = '', updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
      .bind(now, accountId, ownerUserId),
    db
      .prepare("DELETE FROM facebook_account_pages WHERE facebook_account_id = ? AND owner_user_id = ?")
      .bind(accountId, ownerUserId)
  ]);

  await reconcileOrphanPages(db, encryptionKeyFallback, ownerUserId, { preservePages: true });
  return true;
}

const encryptionKeyFallback = "";

export interface DeleteAccountResult {
  deleted: boolean;
  account_id?: string;
  facebook_user_name?: string | null;
  deleted_pages_count: number;
  deleted_page_ids: string[];
  shared_pages_kept_count: number;
}

export async function deleteFacebookAccountWithPages(
  db: D1Database,
  accountId: string,
  ownerUserId: string
): Promise<DeleteAccountResult> {
  const acc = await db
    .prepare(
      "SELECT id, facebook_user_id, facebook_user_name FROM facebook_accounts WHERE id = ? AND owner_user_id = ?"
    )
    .bind(accountId, ownerUserId)
    .first<{ id: string; facebook_user_id: string; facebook_user_name: string | null }>();

  if (!acc) {
    return {
      deleted: false,
      deleted_pages_count: 0,
      deleted_page_ids: [],
      shared_pages_kept_count: 0
    };
  }

  const [pagesRes, accountLinksRes, otherLinksRes] = await db.batch([
    db
      .prepare(
        "SELECT id, facebook_page_id, connected_account_id FROM facebook_pages WHERE owner_user_id = ?"
      )
      .bind(ownerUserId),
    db
      .prepare(
        "SELECT facebook_page_id FROM facebook_account_pages WHERE facebook_account_id = ? AND owner_user_id = ?"
      )
      .bind(accountId, ownerUserId),
    db
      .prepare(
        `SELECT fap.*
         FROM facebook_account_pages fap
         JOIN facebook_accounts fa ON fa.id = fap.facebook_account_id
         WHERE fa.owner_user_id = ?
           AND fa.id != ?
           AND fa.status = 'connected'
           AND fap.page_access_token != ''
         ORDER BY fap.can_post DESC, fap.last_synced_at DESC`
      )
      .bind(ownerUserId, accountId)
  ]);

  const allUserPages = (pagesRes.results || []) as Array<{
    id: string;
    facebook_page_id: string;
    connected_account_id: string | null;
  }>;
  const targetLinkedSet = new Set<string>(
    ((accountLinksRes.results || []) as Array<{ facebook_page_id: string }>).map((r) =>
      String(r.facebook_page_id)
    )
  );
  const otherLinks = (otherLinksRes.results || []) as Array<Record<string, unknown>>;
  const bestOtherLinkByPageId = new Map<string, Record<string, unknown>>();
  for (const lnk of otherLinks) {
    const pid = String(lnk.facebook_page_id || "");
    if (pid && !bestOtherLinkByPageId.has(pid)) {
      bestOtherLinkByPageId.set(pid, lnk);
    }
  }

  const now = new Date().toISOString();
  const batchStmts = [
    db
      .prepare("DELETE FROM oauth_states WHERE reconnect_account_id = ? AND owner_user_id = ?")
      .bind(accountId, ownerUserId),
    db
      .prepare(
        "DELETE FROM facebook_account_pages WHERE facebook_account_id = ? AND owner_user_id = ?"
      )
      .bind(accountId, ownerUserId)
  ];

  const deletedPageIds: string[] = [];
  let sharedPagesKeptCount = 0;

  for (const p of allUserPages) {
    const wasLinkedToDeletedAdmin =
      targetLinkedSet.has(p.facebook_page_id) || p.connected_account_id === accountId;
    const otherLink = bestOtherLinkByPageId.get(p.facebook_page_id);

    if (otherLink) {
      if (wasLinkedToDeletedAdmin) {
        sharedPagesKeptCount++;
      }
      batchStmts.push(
        db
          .prepare(
            `UPDATE facebook_pages
             SET page_access_token = ?,
                 tasks_json = ?,
                 can_post = ?,
                 can_analyze = ?,
                 is_published = ?,
                 status = 'active',
                 token_status = 'valid',
                 connected_account_id = ?,
                 updated_at = ?
             WHERE id = ? AND owner_user_id = ?`
          )
          .bind(
            String(otherLink.page_access_token || ""),
            String(otherLink.tasks_json || "[]"),
            Number(otherLink.can_post ?? 1),
            Number(otherLink.can_analyze ?? 0),
            Number(otherLink.is_published ?? 1),
            String(otherLink.facebook_account_id),
            now,
            p.id,
            ownerUserId
          )
      );
    } else {
      deletedPageIds.push(p.facebook_page_id);
      // Xóa các task chưa đăng (pending/failed) nhưng giữ lại các task đã đăng thành công (status='success') để bảo toàn lịch sử
      batchStmts.push(
        db
          .prepare(
            "DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ? AND status != 'success')"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare(
            "DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ? AND status != 'success')"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ? AND status != 'success'")
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM profiles WHERE facebook_page_id = ? AND owner_user_id = ?")
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare(
            "DELETE FROM facebook_account_pages WHERE facebook_page_id = ? AND owner_user_id = ?"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM facebook_pages WHERE id = ? AND owner_user_id = ?")
          .bind(p.id, ownerUserId)
      );
    }
  }

  batchStmts.push(
    db
      .prepare("DELETE FROM facebook_accounts WHERE id = ? AND owner_user_id = ?")
      .bind(accountId, ownerUserId)
  );

  await db.batch(batchStmts);

  return {
    deleted: true,
    account_id: accountId,
    facebook_user_name: acc.facebook_user_name,
    deleted_pages_count: deletedPageIds.length,
    deleted_page_ids: deletedPageIds,
    shared_pages_kept_count: sharedPagesKeptCount
  };
}

export async function deleteFacebookAccountLocal(
  db: D1Database,
  accountId: string,
  ownerUserId: string
): Promise<boolean> {
  const res = await deleteFacebookAccountWithPages(db, accountId, ownerUserId);
  return res.deleted;
}

export async function removeStaleAccountPages(
  db: D1Database,
  accountId: string,
  ownerUserId: string,
  activeFacebookPageIds: string[]
): Promise<string[]> {
  const { results: currentLinks } = await db
    .prepare(
      "SELECT facebook_page_id FROM facebook_account_pages WHERE facebook_account_id = ? AND owner_user_id = ?"
    )
    .bind(accountId, ownerUserId)
    .all<{ facebook_page_id: string }>();

  const activeSet = new Set(activeFacebookPageIds);
  const staleIds = (currentLinks || [])
    .map((r) => String(r.facebook_page_id))
    .filter((pid) => !activeSet.has(pid));

  if (staleIds.length === 0) return [];

  const stmts = staleIds.map((pid) =>
    db
      .prepare(
        "DELETE FROM facebook_account_pages WHERE facebook_account_id = ? AND facebook_page_id = ? AND owner_user_id = ?"
      )
      .bind(accountId, pid, ownerUserId)
  );
  await db.batch(stmts);
  // Khi đồng bộ lại hoặc cập nhật token mới, tuyệt đối KHÔNG tự xóa Page cũ hay Task cũ (Mục 5.4)
  await reconcileOrphanPages(db, encryptionKeyFallback, ownerUserId, { preservePages: true });
  return staleIds;
}

export async function disconnectAllUserAccounts(
  db: D1Database,
  ownerUserId: string
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM oauth_states WHERE owner_user_id = ?").bind(ownerUserId),
    db.prepare("DELETE FROM facebook_account_pages WHERE owner_user_id = ?").bind(ownerUserId),
    db.prepare("DELETE FROM facebook_pages WHERE owner_user_id = ?").bind(ownerUserId),
    db.prepare("DELETE FROM facebook_accounts WHERE owner_user_id = ?").bind(ownerUserId)
  ]);
}

export async function reconcileOrphanPages(
  db: D1Database,
  _encryptionKey: string,
  ownerUserId: string,
  options?: { preservePages?: boolean }
): Promise<void> {
  const preservePages = options?.preservePages ?? true;
  const now = new Date().toISOString();
  const { results: pages } = await db
    .prepare(
      "SELECT id, facebook_page_id, owner_user_id FROM facebook_pages WHERE owner_user_id = ?"
    )
    .bind(ownerUserId)
    .all<{ id: string; facebook_page_id: string; owner_user_id: string }>();

  for (const p of pages) {
    const activeLink = await db
      .prepare(
        `SELECT fap.*
         FROM facebook_account_pages fap
         JOIN facebook_accounts fa ON fa.id = fap.facebook_account_id
         WHERE fap.facebook_page_id = ?
           AND fa.owner_user_id = ?
           AND fa.status = 'connected'
           AND fap.page_access_token != ''
         ORDER BY fap.can_post DESC, fap.last_synced_at DESC
         LIMIT 1`
      )
      .bind(p.facebook_page_id, ownerUserId)
      .first<Record<string, unknown>>();

    if (activeLink) {
      await db
        .prepare(
          `UPDATE facebook_pages
           SET page_access_token = ?,
               tasks_json = ?,
               can_post = ?,
               can_analyze = ?,
               is_published = ?,
               status = 'active',
               token_status = 'valid',
               connected_account_id = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          String(activeLink.page_access_token || ""),
          String(activeLink.tasks_json || "[]"),
          Number(activeLink.can_post ?? 1),
          Number(activeLink.can_analyze ?? 0),
          Number(activeLink.is_published ?? 1),
          String(activeLink.facebook_account_id),
          now,
          p.id
        )
        .run();
    } else if (preservePages) {
      // Giữ lại Page cũ và toàn bộ lịch sử Task/Thống kê, chỉ đánh dấu thiếu quyền trên token mới (Mục 5.4)
      await db
        .prepare(
          `UPDATE facebook_pages
           SET page_access_token = '',
               can_post = 0,
               can_analyze = 0,
               status = 'missing_permission',
               token_status = 'missing_permission',
               updated_at = ?
           WHERE id = ? AND owner_user_id = ?`
        )
        .bind(now, p.id, ownerUserId)
        .run();
    } else {
      await db.batch([
        db
          .prepare(
            "DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ? AND status != 'success')"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare(
            "DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ? AND status != 'success')"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ? AND status != 'success'")
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM profiles WHERE facebook_page_id = ? AND owner_user_id = ?")
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare(
            "DELETE FROM facebook_account_pages WHERE facebook_page_id = ? AND owner_user_id = ?"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM facebook_pages WHERE id = ? AND owner_user_id = ?")
          .bind(p.id, ownerUserId)
      ]);
    }
  }
}

// ==========================================
// 4. FACEBOOK PAGES & DEDUPLICATION (ZERO N+1)
// ==========================================

export async function upsertFacebookPage(
  db: D1Database,
  encryptionKey: string,
  params: {
    facebookPageId: string;
    pageName: string;
    category?: string;
    avatarUrl?: string;
    pageAccessToken: string;
    tasks?: string[];
    canPost?: boolean;
    canAnalyze?: boolean;
    isPublished?: boolean;
    connectedAccountId: string;
    tokenStatus?: string;
    ownerUserId: string;
  }
): Promise<string> {
  const now = new Date().toISOString();
  const tasksArr = params.tasks || [];
  const tasksJson = JSON.stringify(tasksArr);
  const encryptedToken = await encryptToken(params.pageAccessToken, encryptionKey, "v2");
  const tokenVersion = detectTokenVersion(encryptedToken);
  const canPostInt = params.canPost !== false ? 1 : 0;
  const upperTasks = tasksArr.map((t) => String(t).toUpperCase());
  const canAnalyzeInt =
    params.canAnalyze !== undefined
      ? params.canAnalyze
        ? 1
        : 0
      : upperTasks.includes("ANALYZE") || upperTasks.includes("MANAGE")
        ? 1
        : 0;
  const isPublishedInt = params.isPublished !== false ? 1 : 0;
  const tokenStatus = params.tokenStatus || (encryptedToken ? "valid" : "missing");

  await ensureTaskCommentColumns(db);

  await db
    .prepare(
      `INSERT INTO facebook_account_pages (
         owner_user_id, facebook_account_id, facebook_page_id, page_access_token, token_version,
         tasks_json, can_post, can_analyze, is_published, token_status, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(facebook_account_id, facebook_page_id) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         page_access_token = excluded.page_access_token,
         token_version = excluded.token_version,
         tasks_json = excluded.tasks_json,
         can_post = excluded.can_post,
         can_analyze = excluded.can_analyze,
         is_published = excluded.is_published,
         token_status = excluded.token_status,
         last_synced_at = excluded.last_synced_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      params.ownerUserId,
      params.connectedAccountId,
      params.facebookPageId,
      encryptedToken,
      tokenVersion,
      tasksJson,
      canPostInt,
      canAnalyzeInt,
      isPublishedInt,
      tokenStatus,
      now,
      now,
      now
    )
    .run();

  const existing = await db
    .prepare(
      "SELECT id, can_post FROM facebook_pages WHERE facebook_page_id = ? AND owner_user_id = ?"
    )
    .bind(params.facebookPageId, params.ownerUserId)
    .first<{ id: string; can_post: number }>();

  const internalId = existing?.id || `page_${params.facebookPageId}_${randomHex(3)}`;

  if (existing) {
    await db
      .prepare(
        `UPDATE facebook_pages
         SET page_name = ?,
             category = ?,
             avatar_url = COALESCE(NULLIF(?, ''), avatar_url),
             page_access_token = CASE WHEN ? = 1 OR can_post = 0 THEN ? ELSE page_access_token END,
             token_version = ?,
             tasks_json = CASE WHEN ? = 1 OR can_post = 0 THEN ? ELSE tasks_json END,
             can_post = CASE WHEN ? = 1 THEN 1 ELSE can_post END,
             can_analyze = CASE WHEN ? = 1 THEN 1 ELSE can_analyze END,
             is_published = ?,
             status = 'active',
             token_status = ?,
             connected_account_id = CASE WHEN ? = 1 OR connected_account_id IS NULL THEN ? ELSE connected_account_id END,
             last_synced_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        params.pageName,
        params.category || "",
        params.avatarUrl || "",
        canPostInt,
        encryptedToken,
        tokenVersion,
        canPostInt,
        tasksJson,
        canPostInt,
        canAnalyzeInt,
        isPublishedInt,
        tokenStatus,
        canPostInt,
        params.connectedAccountId,
        now,
        now,
        internalId
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO facebook_pages (
           id, owner_user_id, facebook_page_id, page_name, category, avatar_url,
           page_access_token, token_version, tasks_json, can_post, can_analyze, is_published, is_selected,
           status, token_status, connected_account_id, last_synced_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?)`
      )
      .bind(
        internalId,
        params.ownerUserId,
        params.facebookPageId,
        params.pageName,
        params.category || "",
        params.avatarUrl || "",
        encryptedToken,
        tokenVersion,
        tasksJson,
        canPostInt,
        canAnalyzeInt,
        isPublishedInt,
        tokenStatus,
        params.connectedAccountId,
        now,
        now,
        now
      )
      .run();
  }

  return internalId;
}

/**
 * Truy vấn danh sách Fanpage của User bằng 1 lần db.batch() duy nhất (Tránh hoàn toàn N+1 query!)
 */
export async function getFacebookPages(
  db: D1Database,
  encryptionKey: string,
  options: {
    selectedOnly?: boolean;
    includeToken?: boolean;
    accountIds?: string[];
    ownerUserId: string;
  }
): Promise<FacebookPageRecord[]> {
  const { selectedOnly = false, includeToken = false, accountIds = [], ownerUserId } = options;

  let pageSql = `
    SELECT fp.*,
           (SELECT COUNT(*) FROM tasks t
            WHERE t.facebook_page_id = fp.facebook_page_id
              AND t.owner_user_id = fp.owner_user_id
              AND t.status IN ('pending', 'queued', 'processing', 'scheduled', 'needs_schedule')) AS pending_count,
           (SELECT COUNT(*) FROM tasks t
            WHERE t.facebook_page_id = fp.facebook_page_id
              AND t.owner_user_id = fp.owner_user_id
              AND t.status = 'running') AS running_count,
           (SELECT COUNT(*) FROM tasks t
            WHERE t.facebook_page_id = fp.facebook_page_id
              AND t.owner_user_id = fp.owner_user_id
              AND t.status = 'failed') AS failed_count
    FROM facebook_pages fp
    WHERE fp.owner_user_id = ?
  `;
  const pageParams: unknown[] = [ownerUserId];

  if (selectedOnly) {
    pageSql += " AND fp.is_selected = 1";
  }

  if (accountIds && accountIds.length > 0) {
    const placeholders = accountIds.map(() => "?").join(",");
    pageSql += ` AND fp.facebook_page_id IN (
      SELECT facebook_page_id FROM facebook_account_pages WHERE facebook_account_id IN (${placeholders}) AND owner_user_id = ?
    )`;
    pageParams.push(...accountIds, ownerUserId);
  }

  pageSql += " ORDER BY fp.page_name COLLATE NOCASE ASC";

  const linksSql = `
    SELECT fap.*, fa.facebook_user_id, fa.facebook_user_name, fa.status AS account_status
    FROM facebook_account_pages fap
    JOIN facebook_accounts fa ON fa.id = fap.facebook_account_id
    WHERE fa.owner_user_id = ?
    ORDER BY fap.can_post DESC, fap.last_synced_at DESC
  `;

  const [pagesResult, linksResult] = await db.batch([
    db.prepare(pageSql).bind(...pageParams),
    db.prepare(linksSql).bind(ownerUserId)
  ]);

  const rows = (pagesResult.results || []) as Record<string, unknown>[];
  const allLinks = (linksResult.results || []) as Record<string, unknown>[];

  const linksByPageId = new Map<string, Record<string, unknown>[]>();
  for (const lnk of allLinks) {
    const pid = String(lnk.facebook_page_id);
    const list = linksByPageId.get(pid) || [];
    list.push(lnk);
    linksByPageId.set(pid, list);
  }

  const out: FacebookPageRecord[] = [];

  for (const r of rows) {
    const fbPageId = String(r.facebook_page_id);
    const linkRows = linksByPageId.get(fbPageId) || [];

    const adminAccounts: AdminAccountLink[] = [];
    const mergedTasksSet = new Set<string>(safeJsonParseArray(r.tasks_json as string));
    let anyCanPost = Boolean(r.can_post);
    let anyCanAnalyze = Boolean(r.can_analyze);
    const candidateEncryptedTokens: string[] = [];

    for (const lnk of linkRows) {
      const lTasks = safeJsonParseArray(lnk.tasks_json as string);
      for (const t of lTasks) mergedTasksSet.add(t);
      const lCanPost = Boolean(lnk.can_post);
      const upperLTasks = lTasks.map((t) => t.toUpperCase());
      const lCanAnalyze =
        lnk.can_analyze !== undefined && lnk.can_analyze !== null
          ? Boolean(lnk.can_analyze)
          : upperLTasks.includes("ANALYZE") || upperLTasks.includes("MANAGE");
      if (lCanPost && lnk.account_status === "connected") {
        anyCanPost = true;
        if (lnk.page_access_token) {
          candidateEncryptedTokens.push(String(lnk.page_access_token));
        }
      }
      if (lCanAnalyze && lnk.account_status === "connected") {
        anyCanAnalyze = true;
      }
      adminAccounts.push({
        account_id: String(lnk.facebook_account_id),
        facebook_user_id: String(lnk.facebook_user_id),
        user_id: String(lnk.facebook_user_id),
        facebook_user_name: (lnk.facebook_user_name as string) || null,
        user_name: (lnk.facebook_user_name as string) || null,
        account_status: String(lnk.account_status || "connected"),
        token_status: String(lnk.token_status || "valid"),
        tasks: lTasks,
        can_post: lCanPost,
        can_analyze: lCanAnalyze,
        is_published: Boolean(lnk.is_published),
        last_synced_at: (lnk.last_synced_at as string) || null
      });
    }

    const mergedTasksArr = Array.from(mergedTasksSet);
    const mergedUpper = mergedTasksArr.map((t) => t.toUpperCase());
    if (!anyCanAnalyze && (mergedUpper.includes("ANALYZE") || mergedUpper.includes("MANAGE"))) {
      anyCanAnalyze = true;
    }

    for (const lnk of linkRows) {
      if (lnk.page_access_token) {
        const tok = String(lnk.page_access_token);
        if (!candidateEncryptedTokens.includes(tok)) {
          candidateEncryptedTokens.push(tok);
        }
      }
    }
    if (r.page_access_token) {
      const pageTok = String(r.page_access_token);
      if (!candidateEncryptedTokens.includes(pageTok)) {
        candidateEncryptedTokens.push(pageTok);
      }
    }

    const pageRecord: FacebookPageRecord & { page_access_token?: string } = {
      id: String(r.id),
      owner_user_id: (r.owner_user_id as string) || null,
      facebook_page_id: fbPageId,
      page_name: String(r.page_name),
      name: String(r.page_name),
      category: String(r.category || ""),
      avatar_url: String(r.avatar_url || ""),
      tasks: mergedTasksArr,
      can_post: anyCanPost,
      can_analyze: anyCanAnalyze,
      is_published: Boolean(r.is_published),
      is_selected: Boolean(r.is_selected),
      status: String(r.status || "active"),
      token_status: String(r.token_status || "valid"),
      connected_account_id: (r.connected_account_id as string) || null,
      last_synced_at: (r.last_synced_at as string) || null,
      created_at: (r.created_at as string) || null,
      updated_at: (r.updated_at as string) || null,
      pending_count: Number(r.pending_count || 0),
      running_count: Number(r.running_count || 0),
      failed_count: Number(r.failed_count || 0),
      admin_accounts: adminAccounts,
      admin_names: adminAccounts
        .map((a) => a.facebook_user_name)
        .filter((n): n is string => Boolean(n))
    };

    if (includeToken) {
      let resolvedPlainToken = "";
      for (const encTok of candidateEncryptedTokens) {
        const plain = await decryptToken(encTok, encryptionKey);
        if (plain && plain.trim().length > 10) {
          resolvedPlainToken = plain.trim();
          break;
        }
      }
      pageRecord.page_access_token = resolvedPlainToken;
    }

    out.push(pageRecord);
  }

  return out;
}

export async function getFacebookPageByFbId(
  db: D1Database,
  encryptionKey: string,
  facebookPageId: string,
  includeToken = false,
  ownerUserId: string
): Promise<(FacebookPageRecord & { page_access_token?: string }) | null> {
  const pages = await getFacebookPages(db, encryptionKey, {
    includeToken,
    ownerUserId
  });
  return pages.find((p) => p.facebook_page_id === facebookPageId || p.id === facebookPageId) || null;
}

export async function updatePageSelection(
  db: D1Database,
  facebookPageId: string,
  isSelected: boolean,
  ownerUserId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE facebook_pages
       SET is_selected = ?, updated_at = ?
       WHERE (facebook_page_id = ? OR id = ?) AND owner_user_id = ?`
    )
    .bind(isSelected ? 1 : 0, now, facebookPageId, facebookPageId, ownerUserId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

export async function bulkUpdatePageSelection(
  db: D1Database,
  isSelected: boolean,
  facebookPageIds: string[] | null,
  accountIds: string[] | null,
  ownerUserId: string
): Promise<number> {
  const now = new Date().toISOString();
  const val = isSelected ? 1 : 0;

  if (facebookPageIds && facebookPageIds.length > 0) {
    const placeholders = facebookPageIds.map(() => "?").join(",");
    const res = await db
      .prepare(
        `UPDATE facebook_pages
         SET is_selected = ?, updated_at = ?
         WHERE facebook_page_id IN (${placeholders}) AND owner_user_id = ?`
      )
      .bind(val, now, ...facebookPageIds, ownerUserId)
      .run();
    return res.meta?.changes || 0;
  }

  if (accountIds && accountIds.length > 0) {
    const placeholders = accountIds.map(() => "?").join(",");
    const res = await db
      .prepare(
        `UPDATE facebook_pages
         SET is_selected = ?, updated_at = ?
         WHERE facebook_page_id IN (
           SELECT facebook_page_id FROM facebook_account_pages WHERE facebook_account_id IN (${placeholders}) AND owner_user_id = ?
         ) AND owner_user_id = ?`
      )
      .bind(val, now, ...accountIds, ownerUserId, ownerUserId)
      .run();
    return res.meta?.changes || 0;
  }

  const res = await db
    .prepare("UPDATE facebook_pages SET is_selected = ?, updated_at = ? WHERE owner_user_id = ?")
    .bind(val, now, ownerUserId)
    .run();
  return res.meta?.changes || 0;
}

export async function deleteFacebookPageLocal(
  db: D1Database,
  facebookPageId: string,
  ownerUserId: string
): Promise<boolean> {
  const page = await db
    .prepare(
      "SELECT id, facebook_page_id FROM facebook_pages WHERE (facebook_page_id = ? OR id = ?) AND owner_user_id = ?"
    )
    .bind(facebookPageId, facebookPageId, ownerUserId)
    .first<{ id: string; facebook_page_id: string }>();

  if (!page) return false;

  await db.batch([
    db
      .prepare("DELETE FROM facebook_account_pages WHERE facebook_page_id = ? AND owner_user_id = ?")
      .bind(page.facebook_page_id, ownerUserId),
    db
      .prepare("DELETE FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?")
      .bind(page.facebook_page_id, ownerUserId),
    db
      .prepare("DELETE FROM facebook_pages WHERE id = ? AND owner_user_id = ?")
      .bind(page.id, ownerUserId)
  ]);

  return true;
}

// ==========================================
// 5. MEDIA FILES (CLOUDFLARE R2 METADATA)
// ==========================================

export async function createMediaFileInit(
  db: D1Database,
  params: {
    id: string;
    ownerUserId: string;
    objectKey: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    sha256Checksum?: string | null;
    r2UploadId?: string | null;
    storageBackend?: string;
    uploadStatus?: string;
    r2Bucket?: string;
    verifiedAt?: string | null;
    storageError?: string;
  }
): Promise<MediaFileRecord> {
  const now = new Date().toISOString();
  const status = params.uploadStatus || "pending";
  const backend = params.storageBackend || "r2";
  const bucketName = params.r2Bucket || "auto-reels-media";
  const verifiedAt = params.verifiedAt || (status === "ready" ? now : null);
  const storageError = params.storageError || "";

  try {
    await db
      .prepare(
        `INSERT INTO media_files (
           id, owner_user_id, object_key, original_filename, mime_type,
           size_bytes, sha256_checksum, upload_status, r2_upload_id, storage_backend,
           r2_bucket, verified_at, storage_error,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        params.ownerUserId,
        params.objectKey,
        params.originalFilename,
        params.mimeType,
        params.sizeBytes,
        params.sha256Checksum || null,
        status,
        params.r2UploadId || null,
        backend,
        bucketName,
        verifiedAt,
        storageError,
        now,
        now
      )
      .run();
  } catch (err: any) {
    await ensureTaskCommentColumns(db);
    await db
      .prepare(
        `INSERT INTO media_files (
           id, owner_user_id, object_key, original_filename, mime_type,
           size_bytes, sha256_checksum, upload_status, r2_upload_id, storage_backend,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        params.ownerUserId,
        params.objectKey,
        params.originalFilename,
        params.mimeType,
        params.sizeBytes,
        params.sha256Checksum || null,
        status,
        params.r2UploadId || null,
        backend,
        now,
        now
      )
      .run();
  }

  return {
    id: params.id,
    owner_user_id: params.ownerUserId,
    object_key: params.objectKey,
    original_filename: params.originalFilename,
    mime_type: params.mimeType,
    size_bytes: params.sizeBytes,
    sha256_checksum: params.sha256Checksum || null,
    upload_status: status,
    r2_upload_id: params.r2UploadId || null,
    storage_backend: backend,
    r2_bucket: bucketName,
    verified_at: verifiedAt,
    storage_error: storageError,
    created_at: now,
    updated_at: now
  };
}

export async function getMediaFileById(
  db: D1Database,
  mediaIdOrKey: string,
  ownerUserId: string
): Promise<MediaFileRecord | null> {
  if (!mediaIdOrKey) return null;
  const cleanKey = mediaIdOrKey.trim().replace(/^r2:\/\//, "").replace(/^d1:\/\/video\//, "");
  if (!cleanKey) return null;
  return db
    .prepare(
      `SELECT * FROM media_files
       WHERE (id = ? OR object_key = ? OR original_filename = ?) AND owner_user_id = ?
       ORDER BY CASE WHEN id = ? THEN 0 WHEN object_key = ? THEN 1 ELSE 2 END,
                CASE WHEN upload_status = 'ready' THEN 0 ELSE 1 END,
                created_at DESC
       LIMIT 1`
    )
    .bind(cleanKey, cleanKey, cleanKey, ownerUserId, cleanKey, cleanKey)
    .first<MediaFileRecord>();
}

export async function completeMediaFileUpload(
  db: D1Database,
  mediaId: string,
  ownerUserId: string,
  sizeBytes?: number,
  sha256Checksum?: string | null,
  storageBackend?: string,
  r2Bucket?: string
): Promise<MediaFileRecord | null> {
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `UPDATE media_files
         SET upload_status = 'ready',
             size_bytes = COALESCE(?, size_bytes),
             sha256_checksum = COALESCE(?, sha256_checksum),
             storage_backend = COALESCE(?, storage_backend),
             r2_bucket = COALESCE(?, r2_bucket),
             verified_at = ?,
             storage_error = '',
             updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
      .bind(
        sizeBytes !== undefined ? sizeBytes : null,
        sha256Checksum || null,
        storageBackend || null,
        r2Bucket || "auto-reels-media",
        now,
        now,
        mediaId,
        ownerUserId
      )
      .run();
  } catch {
    await db
      .prepare(
        `UPDATE media_files
         SET upload_status = 'ready',
             size_bytes = COALESCE(?, size_bytes),
             sha256_checksum = COALESCE(?, sha256_checksum),
             storage_backend = COALESCE(?, storage_backend),
             updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
      .bind(
        sizeBytes !== undefined ? sizeBytes : null,
        sha256Checksum || null,
        storageBackend || null,
        now,
        mediaId,
        ownerUserId
      )
      .run();
  }

  return getMediaFileById(db, mediaId, ownerUserId);
}

export async function markMediaFileFailed(
  db: D1Database,
  mediaId: string,
  ownerUserId: string,
  errorMessage: string
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `UPDATE media_files
         SET upload_status = 'failed',
             storage_error = ?,
             updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
      .bind(sanitizeSensitiveText(errorMessage), now, mediaId, ownerUserId)
      .run();
  } catch {
    await db
      .prepare(
        `UPDATE media_files
         SET upload_status = 'failed',
             updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
      .bind(now, mediaId, ownerUserId)
      .run();
  }
}

export async function getUserMediaFiles(
  db: D1Database,
  ownerUserId: string
): Promise<MediaFileRecord[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM media_files WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 200"
    )
    .bind(ownerUserId)
    .all<MediaFileRecord>();
  return results || [];
}

export async function deleteMediaFileRecord(
  db: D1Database,
  mediaId: string,
  ownerUserId: string
): Promise<MediaFileRecord | null> {
  const existing = await getMediaFileById(db, mediaId, ownerUserId);
  if (!existing) return null;

  await db.batch([
    db
      .prepare("DELETE FROM media_files WHERE id = ? AND owner_user_id = ?")
      .bind(existing.id, ownerUserId),
    db
      .prepare("DELETE FROM media_blobs_fallback WHERE media_id = ? AND owner_user_id = ?")
      .bind(existing.id, ownerUserId)
  ]);

  return existing;
}

// ==========================================
// 6. TASKS, QUEUE LEASES & AUDIT LOGS
// ==========================================

export async function recordTaskAuditLog(
  db: D1Database,
  params: {
    taskId: number;
    ownerUserId: string;
    actorUserId?: string | null;
    action: string;
    oldScheduledAt?: number | null;
    newScheduledAt?: number | null;
    oldScheduleText?: string | null;
    newScheduleText?: string | null;
    oldStatus?: string | null;
    newStatus?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const cleanReason = sanitizeSensitiveText(params.reason || "");
  const cleanMeta = sanitizeSensitiveText(JSON.stringify(params.metadata || {}));
  const insertSql = `INSERT INTO task_audit_logs (
    task_id, owner_user_id, actor_user_id, action,
    old_scheduled_at, new_scheduled_at, old_schedule_text, new_schedule_text,
    old_status, new_status, reason, metadata_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const bindArgs = [
    params.taskId,
    params.ownerUserId,
    params.actorUserId || params.ownerUserId,
    params.action,
    params.oldScheduledAt ?? null,
    params.newScheduledAt ?? null,
    params.oldScheduleText || "",
    params.newScheduleText || "",
    params.oldStatus || "",
    params.newStatus || "",
    cleanReason,
    cleanMeta,
    now
  ];
  try {
    await db.prepare(insertSql).bind(...bindArgs).run();
  } catch {
    try {
      await ensureTaskCommentColumns(db);
      await db.prepare(insertSql).bind(...bindArgs).run();
    } catch {}
  }
}

export async function getTaskAuditLogs(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<TaskAuditLogRecord[]> {
  try {
    const { results } = await db
      .prepare(
        "SELECT * FROM task_audit_logs WHERE task_id = ? AND owner_user_id = ? ORDER BY id DESC LIMIT 100"
      )
      .bind(taskId, ownerUserId)
      .all<TaskAuditLogRecord>();
    return results || [];
  } catch {
    await ensureTaskCommentColumns(db);
    try {
      const { results } = await db
        .prepare(
          "SELECT * FROM task_audit_logs WHERE task_id = ? AND owner_user_id = ? ORDER BY id DESC LIMIT 100"
        )
        .bind(taskId, ownerUserId)
        .all<TaskAuditLogRecord>();
      return results || [];
    } catch {
      return [];
    }
  }
}

function mapStatusForFrontend(
  status: string,
  scheduledAt?: number | null,
  scheduleDate?: string | null,
  scheduleTime?: string | null
): string {
  const now = nowUtcSeconds();
  if (status === "pending") {
    const hasSchedule =
      scheduledAt !== null &&
      scheduledAt !== undefined &&
      Boolean(scheduleDate && String(scheduleDate).trim()) &&
      Boolean(scheduleTime && String(scheduleTime).trim());
    if (!hasSchedule) {
      return "needs_schedule"; // Cần bổ sung lịch
    }
    if (scheduledAt > now) {
      return "scheduled"; // Đang chờ lịch
    }
    return "pending"; // Chờ đăng (đến giờ)
  }
  if (status === "queued") {
    return "queued"; // Trong hàng đợi
  }
  if (status === "processing" || status === "running") {
    return "running";
  }
  return status;
}

export async function addTask(
  db: D1Database,
  params: {
    videoPath: string;
    caption?: string;
    commentText?: string;
    scheduleDate?: string;
    scheduleTime?: string;
    facebookPageId?: string | null;
    profileId?: string | null;
    mediaId?: string | null;
    objectKey?: string | null;
    status?: string;
    ownerUserId: string;
    triggerSource?: string;
  },
  options?: {
    allowPast?: boolean;
    minLeadSeconds?: number;
    referenceNowUtc?: number;
    allowEmptySchedule?: boolean;
    triggerSource?: string;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const pageId = params.facebookPageId || params.profileId || null;
  const requireSchedule = options?.allowEmptySchedule ? false : true;
  const parsedSchedule = parseVnScheduleToUtc(params.scheduleDate, params.scheduleTime, {
    minLeadSeconds: options?.minLeadSeconds ?? 60,
    allowPast: options?.allowPast ?? false,
    referenceNowUtc: options?.referenceNowUtc,
    requireSchedule
  });
  if (!parsedSchedule.isValid) {
    const code =
      parsedSchedule.missingDate || parsedSchedule.missingTime
        ? "SCHEDULE_REQUIRED"
        : parsedSchedule.isPast
          ? "SCHEDULE_IN_PAST"
          : "SCHEDULE_INVALID";
    throw new ScheduleValidationError({
      code,
      message: parsedSchedule.error || "Thời gian đặt lịch không hợp lệ hoặc đã qua.",
      httpStatus: 400,
      fieldErrors: parsedSchedule.fieldErrors,
      isPast: parsedSchedule.isPast,
      missingDate: parsedSchedule.missingDate,
      missingTime: parsedSchedule.missingTime
    });
  }
  const scheduledAt = parsedSchedule.scheduledAtUtc;
  const finalScheduleDate = parsedSchedule.normalizedDate ?? (params.scheduleDate || "");
  const finalScheduleTime = parsedSchedule.normalizedTime ?? (params.scheduleTime || "");
  const status = params.status || "pending";
  const idempotencyKey = `task_${params.ownerUserId}_${pageId || "unassigned"}_${randomHex(8)}`;
  const cleanComment = (params.commentText || "").trim();
  const initialCommentStatus = cleanComment ? "pending" : "none";

  const effectiveTriggerSource =
    params.triggerSource || options?.triggerSource || "scheduled";

  const insertSqlWithAuditCols = `INSERT INTO tasks (
         owner_user_id, profile_id, facebook_page_id, media_id, object_key,
         video_path, caption, comment_text, schedule_date, schedule_time,
         scheduled_at, original_scheduled_at, original_schedule_date, original_schedule_time,
         trigger_source, timezone, status, publish_status, is_locked, idempotency_key, attempt_count, max_attempts,
         log, video_id, post_id, video_url, comment_id, comment_status, comment_log,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Asia/Ho_Chi_Minh', ?, ?, 0, ?, 0, 3, 'Chờ xử lý', '', '', '', '', ?, '', ?, ?)`;

  const insertParamsWithAudit = [
    params.ownerUserId,
    params.profileId || pageId,
    pageId,
    params.mediaId || null,
    params.objectKey || null,
    params.videoPath.trim(),
    params.caption || "",
    params.commentText || "",
    finalScheduleDate,
    finalScheduleTime,
    scheduledAt,
    scheduledAt,
    finalScheduleDate,
    finalScheduleTime,
    effectiveTriggerSource,
    status,
    status,
    idempotencyKey,
    initialCommentStatus,
    now,
    now
  ];

  let res: any;
  try {
    res = await db.prepare(insertSqlWithAuditCols).bind(...insertParamsWithAudit).run();
  } catch (err: any) {
    await ensureTaskCommentColumns(db);
    try {
      res = await db.prepare(insertSqlWithAuditCols).bind(...insertParamsWithAudit).run();
    } catch {
      const fallbackSql = `INSERT INTO tasks (
             owner_user_id, profile_id, facebook_page_id, media_id, object_key,
             video_path, caption, comment_text, schedule_date, schedule_time,
             scheduled_at, timezone, status, idempotency_key, attempt_count, max_attempts,
             log, video_id, post_id, video_url, comment_id, comment_status, comment_log,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Asia/Ho_Chi_Minh', ?, ?, 0, 3, 'Chờ xử lý', '', '', '', '', ?, '', ?, ?)`;
      res = await db
        .prepare(fallbackSql)
        .bind(
          params.ownerUserId,
          params.profileId || pageId,
          pageId,
          params.mediaId || null,
          params.objectKey || null,
          params.videoPath.trim(),
          params.caption || "",
          params.commentText || "",
          finalScheduleDate,
          finalScheduleTime,
          scheduledAt,
          status,
          idempotencyKey,
          initialCommentStatus,
          now,
          now
        )
        .run();
    }
  }

  const taskId = Number(res.meta?.last_row_id || 0);
  if (taskId > 0) {
    await appendTaskStageLog(
      db,
      taskId,
      params.ownerUserId,
      "INFO",
      "created",
      scheduledAt
        ? `Tạo tác vụ hẹn lịch đăng lúc ${finalScheduleDate} ${finalScheduleTime} (24h Asia/Ho_Chi_Minh -> UTC ${scheduledAt}).`
        : "Tạo tác vụ đăng Reels mới."
    );
    await recordTaskAuditLog(db, {
      taskId,
      ownerUserId: params.ownerUserId,
      actorUserId: params.ownerUserId,
      action: effectiveTriggerSource === "excel_bulk" ? "create_excel_bulk_task" : "create_task",
      triggerSource: effectiveTriggerSource,
      oldScheduledAt: null,
      newScheduledAt: scheduledAt,
      oldScheduleText: "",
      newScheduleText: `${finalScheduleDate} ${finalScheduleTime}`.trim(),
      oldStatus: "",
      newStatus: status,
      reason: effectiveTriggerSource === "excel_bulk"
        ? "Khởi tạo tác vụ hàng loạt từ bảng tính Excel"
        : "Khởi tạo task mới với lịch đăng bắt buộc",
      metadata: { facebook_page_id: pageId, trigger_source: effectiveTriggerSource }
    });
  }
  return taskId;
}

export async function addTasksBulk(
  db: D1Database,
  tasksList: Array<{
    video_path: string;
    caption?: string;
    comment_text?: string;
    schedule_date?: string;
    schedule_time?: string;
    facebook_page_id?: string;
    media_id?: string;
    object_key?: string;
    trigger_source?: string;
  }>,
  assignPageIds: string[] | null,
  ownerUserId: string,
  options?: {
    allowPast?: boolean;
    minLeadSeconds?: number;
    triggerSource?: string;
  }
): Promise<number[]> {
  if (!tasksList || tasksList.length === 0) return [];

  let validAssignIds: string[] = [];
  if (assignPageIds && assignPageIds.length > 0) {
    const placeholders = assignPageIds.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT facebook_page_id FROM facebook_pages
         WHERE facebook_page_id IN (${placeholders}) AND owner_user_id = ?`
      )
      .bind(...assignPageIds, ownerUserId)
      .all<{ facebook_page_id: string }>();
    validAssignIds = results.map((r) => r.facebook_page_id);
  }

  const insertedIds: number[] = [];
  let idx = 0;

  for (const item of tasksList) {
    const vPath = (item.video_path || "").trim();
    if (!vPath) continue;

    let targetPageId: string | null = item.facebook_page_id || null;
    if (!targetPageId && validAssignIds.length > 0) {
      targetPageId = validAssignIds[idx % validAssignIds.length];
      idx++;
    }

    let mediaId = item.media_id || null;
    let objectKey = item.object_key || null;
    let effectiveVideoPath = vPath;

    // Tự động phân giải media từ R2 nếu vPath là tên file hoặc đường dẫn máy tính
    if (!mediaId && !vPath.startsWith("http://") && !vPath.startsWith("https://")) {
      const cleanKey = vPath.replace(/^r2:\/\//, "").replace(/^d1:\/\/video\//, "");
      const baseName = vPath.split(/[\\/]/).pop() || vPath;
      const mediaRec =
        (await getMediaFileById(db, cleanKey, ownerUserId)) ||
        (await getMediaFileById(db, baseName, ownerUserId));
      if (mediaRec && mediaRec.upload_status === "ready") {
        mediaId = mediaRec.id;
        objectKey = mediaRec.object_key;
        effectiveVideoPath = `r2://${mediaRec.id}`;
      }
    }

    const tid = await addTask(
      db,
      {
        videoPath: effectiveVideoPath,
        caption: item.caption || "",
        commentText: item.comment_text || "",
        scheduleDate: item.schedule_date || "",
        scheduleTime: item.schedule_time || "",
        facebookPageId: targetPageId,
        mediaId,
        objectKey,
        ownerUserId,
        triggerSource: item.trigger_source || options?.triggerSource || "excel_bulk"
      },
      options
    );
    insertedIds.push(tid);
  }

  return insertedIds;
}

export async function getTasks(
  db: D1Database,
  options: {
    facebookPageId?: string | null;
    status?: string | null;
    search?: string | null;
    accountIds?: string[];
    startDate?: string | null;
    endDate?: string | null;
    ownerUserId: string;
    excludePublished?: boolean;
  }
): Promise<TaskRecord[]> {
  const { facebookPageId, status, search, accountIds = [], startDate, endDate, ownerUserId, excludePublished } = options;
  const nowSec = nowUtcSeconds();

  let sql = `
    SELECT t.*,
           fp.page_name AS page_name,
           fp.avatar_url AS page_avatar,
           fp.category AS page_category
    FROM tasks t
    LEFT JOIN facebook_pages fp
      ON fp.facebook_page_id = t.facebook_page_id
      AND fp.owner_user_id = t.owner_user_id
    WHERE t.owner_user_id = ?
  `;
  const params: unknown[] = [ownerUserId];

  if (facebookPageId) {
    sql += " AND (t.facebook_page_id = ? OR t.profile_id = ?)";
    params.push(facebookPageId, facebookPageId);
  }

  if (accountIds && accountIds.length > 0) {
    const placeholders = accountIds.map(() => "?").join(",");
    sql += ` AND t.facebook_page_id IN (
      SELECT facebook_page_id FROM facebook_account_pages
      WHERE facebook_account_id IN (${placeholders}) AND owner_user_id = ?
    )`;
    params.push(...accountIds, ownerUserId);
  }

  if (status && status !== "all") {
    if (status === "running" || status === "processing") {
      sql += " AND t.status IN ('running', 'queued', 'processing')";
    } else if (status === "needs_schedule") {
      sql += " AND t.status = 'pending' AND (t.scheduled_at IS NULL OR COALESCE(t.schedule_date, '') = '' OR COALESCE(t.schedule_time, '') = '')";
    } else if (status === "due_soon") {
      sql += " AND t.status = 'pending' AND t.scheduled_at IS NOT NULL AND t.scheduled_at <= ?";
      params.push(nowSec + 1800);
    } else if (status === "scheduled" || status === "pending") {
      sql += " AND t.status = 'pending'";
    } else {
      sql += " AND t.status = ?";
      params.push(status);
    }
  } else if (excludePublished) {
    sql += " AND t.status NOT IN ('published', 'success')";
  }

  if (startDate && startDate.trim()) {
    sql += " AND t.schedule_date >= ?";
    params.push(startDate.trim());
  }

  if (endDate && endDate.trim()) {
    sql += " AND t.schedule_date <= ?";
    params.push(endDate.trim());
  }

  if (search && search.trim()) {
    const kw = `%${search.trim()}%`;
    sql +=
      " AND (t.caption LIKE ? OR t.video_path LIKE ? OR fp.page_name LIKE ? OR t.facebook_page_id LIKE ?)";
    params.push(kw, kw, kw, kw);
  }

  sql += " ORDER BY t.id DESC";

  const { results } = await db.prepare(sql).bind(...params).all<Record<string, unknown>>();

  return results.map((r) => {
    const rawStatus = String(r.status || "pending");
    const schedAt = r.scheduled_at !== null && r.scheduled_at !== undefined ? Number(r.scheduled_at) : null;
    const schedDateStr = String(r.schedule_date || "");
    const schedTimeStr = String(r.schedule_time || "");
    const videoIdStr = String(r.video_id || "");
    const postIdStr = String(r.post_id || "");
    const publishStatus = String(r.publish_status || rawStatus);
    const hasPublishedIds = Boolean(videoIdStr.trim()) && Boolean(postIdStr.trim());
    const isLocked =
      rawStatus === "failed" && !hasPublishedIds
        ? false
        : Boolean(r.is_locked) ||
          rawStatus === "success" ||
          publishStatus === "success" ||
          hasPublishedIds;
    const mappedStatus = mapStatusForFrontend(rawStatus, schedAt, schedDateStr, schedTimeStr);
    const needsSchedule = mappedStatus === "needs_schedule";
    const isDueSoon =
      rawStatus === "pending" &&
      !needsSchedule &&
      schedAt !== null &&
      schedAt <= nowSec + 1800;

    return {
      id: Number(r.id),
      owner_user_id: (r.owner_user_id as string) || null,
      profile_id: (r.profile_id as string) || (r.facebook_page_id as string) || null,
      facebook_page_id: (r.facebook_page_id as string) || (r.profile_id as string) || null,
      media_id: (r.media_id as string) || null,
      object_key: (r.object_key as string) || null,
      r2_status: (r.r2_status as string) || (r.media_id ? "verified" : "ready"),
      video_path: String(r.video_path || ""),
      caption: String(r.caption || ""),
      comment_text: String(r.comment_text || ""),
      schedule_date: schedDateStr,
      schedule_time: schedTimeStr,
      scheduled_at: schedAt,
      original_scheduled_at:
        r.original_scheduled_at !== null && r.original_scheduled_at !== undefined
          ? Number(r.original_scheduled_at)
          : schedAt,
      original_schedule_date: String(r.original_schedule_date || schedDateStr),
      original_schedule_time: String(r.original_schedule_time || schedTimeStr),
      manual_publish_requested_at: (r.manual_publish_requested_at as string) || null,
      manual_publish_by_user_id: (r.manual_publish_by_user_id as string) || null,
      trigger_source: String(r.trigger_source || "scheduled"),
      timezone: String(r.timezone || "Asia/Ho_Chi_Minh"),
      status: mappedStatus,
      raw_status: rawStatus,
      publish_status: publishStatus,
      is_locked: isLocked,
      needs_schedule: needsSchedule,
      is_due_soon: isDueSoon,
      is_future_schedule: schedAt !== null && schedAt > nowSec,
      idempotency_key: (r.idempotency_key as string) || null,
      attempt_count: Number(r.attempt_count || 0),
      max_attempts: Number(r.max_attempts || 3),
      next_retry_at: r.next_retry_at ? Number(r.next_retry_at) : null,
      locked_until: r.locked_until ? Number(r.locked_until) : null,
      lease_owner: (r.lease_owner as string) || null,
      error_code: r.error_code ? Number(r.error_code) : null,
      error_subcode: r.error_subcode ? Number(r.error_subcode) : null,
      retryable: Number(r.retryable ?? 1),
      log: String(r.log || ""),
      video_id: videoIdStr,
      post_id: postIdStr,
      video_url: String(r.video_url || ""),
      comment_id: String(r.comment_id || ""),
      comment_status: String(
        r.comment_status || (r.comment_text ? "pending" : "none")
      ),
      comment_log: String(r.comment_log || ""),
      comment_posted_at: (r.comment_posted_at as string) || null,
      analytics_status: String(
        r.analytics_status || (rawStatus === "success" ? "pending" : "not_synced")
      ),
      analytics_last_synced_at: (r.analytics_last_synced_at as string) || null,
      analytics_error: String(r.analytics_error || ""),
      uploaded_at: (r.uploaded_at as string) || null,
      published_at: (r.published_at as string) || null,
      last_processed_at: (r.last_processed_at as string) || null,
      created_at: (r.created_at as string) || null,
      updated_at: (r.updated_at as string) || null,
      page_name: (r.page_name as string) || null,
      page_avatar: (r.page_avatar as string) || null,
      page_category: (r.page_category as string) || null,
      profile_name: (r.page_name as string) || (r.facebook_page_id as string) || null
    };
  });
}

export async function getTask(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<TaskRecord | null> {
  const tasks = await getTasks(db, { ownerUserId });
  return tasks.find((t) => t.id === taskId) || null;
}

export async function updateTask(
  db: D1Database,
  taskId: number,
  params: {
    facebookPageId?: string | null;
    videoPath?: string;
    caption?: string;
    commentText?: string;
    scheduleDate?: string;
    scheduleTime?: string;
    mediaId?: string | null;
    objectKey?: string | null;
    ownerUserId: string;
  },
  options?: {
    allowPast?: boolean;
    minLeadSeconds?: number;
    referenceNowUtc?: number;
    allowEmptySchedule?: boolean;
  }
): Promise<boolean> {
  const existing = await getTask(db, taskId, params.ownerUserId);
  if (!existing) return false;

  // Khóa toàn bộ thao tác chỉnh sửa khi Task đã đăng Reels thành công hoặc đang chạy (Mục 1.2 & 1.5)
  assertTaskMutable(existing, "chỉnh sửa");

  const newPageId =
    params.facebookPageId !== undefined ? params.facebookPageId : existing.facebook_page_id;
  const newVideo = params.videoPath !== undefined ? params.videoPath.trim() : existing.video_path;
  const newCaption = params.caption !== undefined ? params.caption : existing.caption;
  const newComment = params.commentText !== undefined ? params.commentText : existing.comment_text;
  const newDate = params.scheduleDate !== undefined ? params.scheduleDate : existing.schedule_date;
  const newTime = params.scheduleTime !== undefined ? params.scheduleTime : existing.schedule_time;
  const newMediaId = params.mediaId !== undefined ? params.mediaId : existing.media_id;
  const newObjectKey = params.objectKey !== undefined ? params.objectKey : existing.object_key;
  const requireSchedule = options?.allowEmptySchedule ? false : true;
  const parsedSchedule = parseVnScheduleToUtc(newDate, newTime, {
    minLeadSeconds: options?.minLeadSeconds ?? 60,
    allowPast: options?.allowPast ?? false,
    referenceNowUtc: options?.referenceNowUtc,
    requireSchedule
  });
  if (!parsedSchedule.isValid) {
    const code =
      parsedSchedule.missingDate || parsedSchedule.missingTime
        ? "SCHEDULE_REQUIRED"
        : parsedSchedule.isPast
          ? "SCHEDULE_IN_PAST"
          : "SCHEDULE_INVALID";
    throw new ScheduleValidationError({
      code,
      message: parsedSchedule.error || "Thời gian đặt lịch không hợp lệ hoặc đã qua.",
      httpStatus: 400,
      fieldErrors: parsedSchedule.fieldErrors,
      isPast: parsedSchedule.isPast,
      missingDate: parsedSchedule.missingDate,
      missingTime: parsedSchedule.missingTime
    });
  }
  const finalScheduleDate = parsedSchedule.normalizedDate ?? newDate;
  const finalScheduleTime = parsedSchedule.normalizedTime ?? newTime;
  const now = new Date().toISOString();

  let newCommentStatus = existing.comment_status || "none";
  if (params.commentText !== undefined) {
    if (!newComment.trim()) {
      newCommentStatus = "none";
    } else if (existing.comment_text !== newComment) {
      newCommentStatus = "pending";
    }
  }

  let res: any;
  try {
    res = await db
      .prepare(
        `UPDATE tasks
         SET facebook_page_id = ?,
             profile_id = ?,
             media_id = ?,
             object_key = ?,
             video_path = ?,
             caption = ?,
             comment_text = ?,
             comment_status = ?,
             original_scheduled_at = COALESCE(original_scheduled_at, scheduled_at, ?),
             original_schedule_date = CASE WHEN original_schedule_date IS NULL OR original_schedule_date = '' THEN COALESCE(NULLIF(schedule_date, ''), ?) ELSE original_schedule_date END,
             original_schedule_time = CASE WHEN original_schedule_time IS NULL OR original_schedule_time = '' THEN COALESCE(NULLIF(schedule_time, ''), ?) ELSE original_schedule_time END,
             schedule_date = ?,
             schedule_time = ?,
             scheduled_at = ?,
             status = CASE WHEN status = 'cancelled' THEN 'pending' ELSE status END,
             publish_status = CASE WHEN publish_status = 'cancelled' THEN 'pending' ELSE publish_status END,
             is_locked = 0,
             updated_at = ?
         WHERE id = ?
           AND owner_user_id = ?
           AND status != 'success'
           AND COALESCE(is_locked, 0) = 0`
      )
      .bind(
        newPageId,
        newPageId,
        newMediaId || null,
        newObjectKey || null,
        newVideo,
        newCaption,
        newComment,
        newCommentStatus,
        parsedSchedule.scheduledAtUtc,
        finalScheduleDate,
        finalScheduleTime,
        finalScheduleDate,
        finalScheduleTime,
        parsedSchedule.scheduledAtUtc,
        now,
        taskId,
        params.ownerUserId
      )
      .run();
  } catch {
    await ensureTaskCommentColumns(db);
    res = await db
      .prepare(
        `UPDATE tasks
         SET facebook_page_id = ?,
             profile_id = ?,
             media_id = ?,
             object_key = ?,
             video_path = ?,
             caption = ?,
             comment_text = ?,
             comment_status = ?,
             schedule_date = ?,
             schedule_time = ?,
             scheduled_at = ?,
             updated_at = ?
         WHERE id = ?
           AND owner_user_id = ?
           AND status != 'success'
           AND COALESCE(is_locked, 0) = 0`
      )
      .bind(
        newPageId,
        newPageId,
        newMediaId || null,
        newObjectKey || null,
        newVideo,
        newCaption,
        newComment,
        newCommentStatus,
        finalScheduleDate,
        finalScheduleTime,
        parsedSchedule.scheduledAtUtc,
        now,
        taskId,
        params.ownerUserId
      )
      .run();
  }

  if ((res.meta?.changes || 0) === 0) {
    const recheck = await getTask(db, taskId, params.ownerUserId);
    if (recheck) {
      assertTaskMutable(recheck, "chỉnh sửa");
    }
  }

  const scheduleChanged =
    existing.scheduled_at !== parsedSchedule.scheduledAtUtc ||
    existing.schedule_date !== finalScheduleDate ||
    existing.schedule_time !== finalScheduleTime;

  await recordTaskAuditLog(db, {
    taskId,
    ownerUserId: params.ownerUserId,
    actorUserId: params.ownerUserId,
    action: scheduleChanged ? "reschedule" : "edit_task",
    oldScheduledAt: existing.scheduled_at ?? null,
    newScheduledAt: parsedSchedule.scheduledAtUtc,
    oldScheduleText: `${existing.schedule_date || ""} ${existing.schedule_time || ""}`.trim(),
    newScheduleText: `${finalScheduleDate} ${finalScheduleTime}`.trim(),
    oldStatus: existing.raw_status || existing.status,
    newStatus: existing.raw_status === "cancelled" ? "pending" : existing.raw_status || existing.status,
    reason: scheduleChanged ? "Cập nhật lịch đăng & thông tin task" : "Cập nhật nội dung task"
  });

  return true;
}

export async function updateTaskExecutionState(
  db: D1Database,
  taskId: number,
  status: string,
  logMsg: string,
  extra?: {
    videoId?: string;
    postId?: string;
    videoUrl?: string;
    errorCode?: number | null;
    errorSubcode?: number | null;
    retryable?: boolean;
    nextRetryAt?: number | null;
    attemptCount?: number;
    clearLease?: boolean;
    publishedAt?: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const cleanLog = sanitizeSensitiveText(logMsg);
  const isSuccess = status === "success" || status === "done";
  const isFailed = status === "failed";
  const publishedAtVal =
    extra?.publishedAt !== undefined
      ? extra.publishedAt
      : isSuccess
        ? now
        : null;

  try {
    await db
      .prepare(
        `UPDATE tasks
         SET status = ?,
             publish_status = ?,
             is_locked = CASE WHEN ? = 1 THEN 1 WHEN ? = 1 THEN 0 ELSE COALESCE(is_locked, 0) END,
             analytics_status = CASE
               WHEN ? = 1 AND (analytics_status IS NULL OR analytics_status = 'not_synced') THEN 'pending'
               ELSE COALESCE(analytics_status, 'not_synced')
             END,
             log = ?,
             video_id = COALESCE(?, video_id),
             post_id = COALESCE(?, post_id),
             video_url = COALESCE(?, video_url),
             error_code = COALESCE(?, error_code),
             error_subcode = COALESCE(?, error_subcode),
             retryable = COALESCE(?, retryable),
             next_retry_at = ?,
             attempt_count = COALESCE(?, attempt_count),
             locked_until = CASE WHEN ? = 1 THEN NULL ELSE locked_until END,
             lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
             published_at = COALESCE(?, published_at),
             last_processed_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        status,
        status,
        isSuccess ? 1 : 0,
        isFailed ? 1 : 0,
        isSuccess ? 1 : 0,
        cleanLog,
        extra?.videoId ?? null,
        extra?.postId ?? null,
        extra?.videoUrl ?? null,
        extra?.errorCode ?? null,
        extra?.errorSubcode ?? null,
        extra?.retryable !== undefined ? (extra.retryable ? 1 : 0) : null,
        extra?.nextRetryAt !== undefined ? extra.nextRetryAt : null,
        extra?.attemptCount !== undefined ? extra.attemptCount : null,
        extra?.clearLease ? 1 : 0,
        extra?.clearLease ? 1 : 0,
        publishedAtVal,
        now,
        now,
        taskId
      )
      .run();
  } catch {
    await ensureTaskCommentColumns(db);
    await db
      .prepare(
        `UPDATE tasks
         SET status = ?,
             log = ?,
             video_id = COALESCE(?, video_id),
             post_id = COALESCE(?, post_id),
             video_url = COALESCE(?, video_url),
             error_code = COALESCE(?, error_code),
             error_subcode = COALESCE(?, error_subcode),
             retryable = COALESCE(?, retryable),
             next_retry_at = ?,
             attempt_count = COALESCE(?, attempt_count),
             locked_until = CASE WHEN ? = 1 THEN NULL ELSE locked_until END,
             lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        status,
        cleanLog,
        extra?.videoId ?? null,
        extra?.postId ?? null,
        extra?.videoUrl ?? null,
        extra?.errorCode ?? null,
        extra?.errorSubcode ?? null,
        extra?.retryable !== undefined ? (extra.retryable ? 1 : 0) : null,
        extra?.nextRetryAt !== undefined ? extra.nextRetryAt : null,
        extra?.attemptCount !== undefined ? extra.attemptCount : null,
        extra?.clearLease ? 1 : 0,
        extra?.clearLease ? 1 : 0,
        now,
        taskId
      )
      .run();
  }
}

export async function updateTaskAnalyticsState(
  db: D1Database,
  taskId: number,
  analyticsStatus: string,
  analyticsError = "",
  syncedAt?: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const cleanErr = sanitizeSensitiveText(analyticsError || "");
  try {
    await db
      .prepare(
        `UPDATE tasks
         SET analytics_status = ?,
             analytics_error = ?,
             analytics_last_synced_at = COALESCE(?, analytics_last_synced_at),
             updated_at = ?
         WHERE id = ?`
      )
      .bind(analyticsStatus, cleanErr, syncedAt !== undefined ? syncedAt : now, now, taskId)
      .run();
  } catch {
    await ensureTaskCommentColumns(db);
    await db
      .prepare(
        `UPDATE tasks
         SET analytics_status = ?,
             analytics_error = ?,
             analytics_last_synced_at = COALESCE(?, analytics_last_synced_at),
             updated_at = ?
         WHERE id = ?`
      )
      .bind(analyticsStatus, cleanErr, syncedAt !== undefined ? syncedAt : now, now, taskId)
      .run();
  }
}

export async function updateTaskCommentState(
  db: D1Database,
  taskId: number,
  commentStatus: string,
  commentLogMsg: string,
  extra?: {
    commentId?: string | null;
    commentPostedAt?: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const cleanLog = sanitizeSensitiveText(commentLogMsg);

  await db
    .prepare(
      `UPDATE tasks
       SET comment_status = ?,
           comment_log = ?,
           comment_id = COALESCE(?, comment_id),
           comment_posted_at = COALESCE(?, comment_posted_at),
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      commentStatus,
      cleanLog,
      extra?.commentId !== undefined ? extra.commentId : null,
      extra?.commentPostedAt !== undefined ? extra.commentPostedAt : null,
      now,
      taskId
    )
    .run();
}

export async function appendTaskStageLog(
  db: D1Database,
  taskId: number,
  ownerUserId: string,
  level: "INFO" | "WARN" | "ERROR",
  stage: string,
  message: string
): Promise<void> {
  const now = new Date().toISOString();
  const clean = sanitizeSensitiveText(message);
  await db
    .prepare(
      `INSERT INTO task_logs (task_id, owner_user_id, level, stage, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(taskId, ownerUserId, level, stage, clean, now)
    .run();
}

export async function recordTaskAttemptStart(
  db: D1Database,
  taskId: number,
  ownerUserId: string,
  attemptNumber: number,
  stage = "initializing"
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `INSERT INTO task_attempts (task_id, owner_user_id, attempt_number, status, stage, started_at)
       VALUES (?, ?, ?, 'processing', ?, ?)`
    )
    .bind(taskId, ownerUserId, attemptNumber, stage, now)
    .run();
  return Number(res.meta?.last_row_id || 0);
}

export async function recordTaskAttemptFinish(
  db: D1Database,
  attemptId: number,
  status: "success" | "failed",
  stage: string,
  errorCode?: number | null,
  errorSubcode?: number | null,
  errorMessage?: string | null
): Promise<void> {
  if (!attemptId) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE task_attempts
       SET status = ?,
           stage = ?,
           error_code = ?,
           error_subcode = ?,
           error_message = ?,
           finished_at = ?
       WHERE id = ?`
    )
    .bind(
      status,
      stage,
      errorCode ?? null,
      errorSubcode ?? null,
      errorMessage ? sanitizeSensitiveText(errorMessage) : null,
      now,
      attemptId
    )
    .run();
}

export async function getTaskLogs(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<Array<Record<string, unknown>>> {
  const { results } = await db
    .prepare(
      "SELECT * FROM task_logs WHERE task_id = ? AND owner_user_id = ? ORDER BY id ASC"
    )
    .bind(taskId, ownerUserId)
    .all<Record<string, unknown>>();
  return results || [];
}

export async function getTaskAttempts(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<Array<Record<string, unknown>>> {
  const { results } = await db
    .prepare(
      "SELECT * FROM task_attempts WHERE task_id = ? AND owner_user_id = ? ORDER BY attempt_number ASC"
    )
    .bind(taskId, ownerUserId)
    .all<Record<string, unknown>>();
  return results || [];
}

export async function resetTask(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<boolean> {
  const existing = await getTask(db, taskId, ownerUserId);
  if (!existing) return false;

  // Khóa không cho chuyển task đã đăng thành công hoặc đang chạy về trạng thái chờ đăng (Mục 1.2 & 1.5)
  assertTaskMutable(existing, "đặt lại trạng thái chờ đăng");

  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE tasks
       SET status = 'pending',
           publish_status = 'pending',
           is_locked = 0,
           attempt_count = 0,
           next_retry_at = NULL,
           locked_until = NULL,
           lease_owner = NULL,
           error_code = NULL,
           error_subcode = NULL,
           retryable = 1,
           log = 'Đã đặt lại - Chờ xử lý',
           video_id = '',
           post_id = '',
           video_url = '',
           comment_id = '',
           comment_status = CASE WHEN comment_text != '' THEN 'pending' ELSE 'none' END,
           comment_log = '',
           comment_posted_at = NULL,
           updated_at = ?
       WHERE id = ?
         AND owner_user_id = ?
         AND status != 'success'
         AND COALESCE(is_locked, 0) = 0`
    )
    .bind(now, taskId, ownerUserId)
    .run();

  if ((res.meta?.changes || 0) === 0) {
    const recheck = await getTask(db, taskId, ownerUserId);
    if (recheck) {
      assertTaskMutable(recheck, "đặt lại trạng thái chờ đăng");
    }
  }

  await recordTaskAuditLog(db, {
    taskId,
    ownerUserId,
    actorUserId: ownerUserId,
    action: "retry_task",
    oldScheduledAt: existing.scheduled_at ?? null,
    newScheduledAt: existing.scheduled_at ?? null,
    oldScheduleText: `${existing.schedule_date || ""} ${existing.schedule_time || ""}`.trim(),
    newScheduleText: `${existing.schedule_date || ""} ${existing.schedule_time || ""}`.trim(),
    oldStatus: existing.raw_status || existing.status,
    newStatus: "pending",
    reason: "Người dùng đặt lại trạng thái chờ đăng / thử lại"
  });

  return true;
}

export async function prepareTasksForPublishNow(
  db: D1Database,
  params: {
    taskIds: number[];
    ownerUserId: string;
    actorUserId?: string;
    triggerSource?: "manual_publish_now" | "bulk_publish_now";
  }
): Promise<{
  eligibleTaskIds: number[];
  eligibleTasks: TaskRecord[];
  ineligibleTasks: Array<{ id: number; reason: string; code: string }>;
  publishedTimestampUtc: number;
  publishedScheduleDate: string;
  publishedScheduleTime: string;
}> {
  const validIds = Array.from(
    new Set(
      (params.taskIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  const nowSec = nowUtcSeconds();
  const vnNow = formatUtcToVn(nowSec);
  const isoNow = new Date().toISOString();
  const triggerSource = params.triggerSource || "manual_publish_now";
  const actorUserId = params.actorUserId || params.ownerUserId;

  if (validIds.length === 0) {
    return {
      eligibleTaskIds: [],
      eligibleTasks: [],
      ineligibleTasks: [],
      publishedTimestampUtc: nowSec,
      publishedScheduleDate: vnNow.schedule_date,
      publishedScheduleTime: vnNow.schedule_time
    };
  }

  await ensureTaskCommentColumns(db);

  const allUserTasks = await getTasks(db, { ownerUserId: params.ownerUserId });
  const taskMap = new Map<number, TaskRecord>();
  for (const t of allUserTasks) {
    taskMap.set(t.id, t);
  }

  const eligibleTaskIds: number[] = [];
  const eligibleTasks: TaskRecord[] = [];
  const ineligibleTasks: Array<{ id: number; reason: string; code: string }> = [];

  for (const id of validIds) {
    const task = taskMap.get(id);
    if (!task) {
      ineligibleTasks.push({
        id,
        code: "TASK_NOT_FOUND",
        reason: "Task không tồn tại hoặc không thuộc quyền sở hữu của bạn."
      });
      continue;
    }

    if (isTaskPublishedAndLocked(task)) {
      ineligibleTasks.push({
        id,
        code: "TASK_ALREADY_PUBLISHED",
        reason: "Task đã đăng Reels thành công và đã khóa lịch sử."
      });
      continue;
    }

    if (isTaskCurrentlyRunning(task)) {
      ineligibleTasks.push({
        id,
        code: "TASK_IN_PROGRESS",
        reason: "Task đang trong quá trình xử lý đăng hoặc đã nằm trong hàng đợi."
      });
      continue;
    }

    if (!task.facebook_page_id || !String(task.facebook_page_id).trim()) {
      ineligibleTasks.push({
        id,
        code: "MISSING_PAGE",
        reason: "Task chưa được gắn Fanpage đích."
      });
      continue;
    }

    if (!task.video_path || !String(task.video_path).trim()) {
      ineligibleTasks.push({
        id,
        code: "MISSING_VIDEO",
        reason: "Task thiếu nguồn video R2 hợp lệ."
      });
      continue;
    }

    const oldScheduledAt = task.scheduled_at ?? null;
    const oldScheduleText = `${task.schedule_date || ""} ${task.schedule_time || ""}`.trim();
    const oldStatus = task.raw_status || task.status;

    const updateRes = await db
      .prepare(
        `UPDATE tasks
         SET original_scheduled_at = COALESCE(original_scheduled_at, scheduled_at, ?),
             original_schedule_date = CASE WHEN original_schedule_date IS NULL OR original_schedule_date = '' THEN COALESCE(NULLIF(schedule_date, ''), ?) ELSE original_schedule_date END,
             original_schedule_time = CASE WHEN original_schedule_time IS NULL OR original_schedule_time = '' THEN COALESCE(NULLIF(schedule_time, ''), ?) ELSE original_schedule_time END,
             schedule_date = ?,
             schedule_time = ?,
             scheduled_at = ?,
             manual_publish_requested_at = ?,
             manual_publish_by_user_id = ?,
             trigger_source = ?,
             status = 'queued',
             publish_status = 'queued',
             is_locked = 0,
             attempt_count = 0,
             locked_until = NULL,
             lease_owner = NULL,
             next_retry_at = NULL,
             error_code = NULL,
             error_subcode = NULL,
             log = ?,
             updated_at = ?
         WHERE id = ?
           AND owner_user_id = ?
           AND status NOT IN ('success', 'done', 'processing', 'running', 'queued')
           AND COALESCE(is_locked, 0) = 0`
      )
      .bind(
        nowSec,
        vnNow.schedule_date,
        vnNow.schedule_time,
        vnNow.schedule_date,
        vnNow.schedule_time,
        nowSec,
        isoNow,
        actorUserId,
        triggerSource,
        `Đăng ngay lúc ${vnNow.schedule_date} ${vnNow.schedule_time} (lịch gốc: ${oldScheduleText || "chưa đặt"})`,
        isoNow,
        id,
        params.ownerUserId
      )
      .run();

    if ((updateRes.meta?.changes || 0) === 0) {
      ineligibleTasks.push({
        id,
        code: "TASK_STATE_CHANGED",
        reason: "Trạng thái task vừa thay đổi ở tiến trình khác (đang chạy hoặc đã khóa)."
      });
      continue;
    }

    await appendTaskStageLog(
      db,
      id,
      params.ownerUserId,
      "INFO",
      "manual_publish_now",
      `Kích hoạt Đăng ngay (${triggerSource}). Cập nhật lịch đăng từ [${oldScheduleText || "trống"}] -> [${vnNow.schedule_date} ${vnNow.schedule_time} / UTC=${nowSec}].`
    );

    await recordTaskAuditLog(db, {
      taskId: id,
      ownerUserId: params.ownerUserId,
      actorUserId,
      action: triggerSource === "bulk_publish_now" ? "bulk_publish_now" : "publish_now",
      oldScheduledAt,
      newScheduledAt: nowSec,
      oldScheduleText,
      newScheduleText: `${vnNow.schedule_date} ${vnNow.schedule_time}`,
      oldStatus,
      newStatus: "queued",
      reason:
        triggerSource === "bulk_publish_now"
          ? "Người dùng chọn nhiều task và bấm Đăng ngay"
          : "Người dùng bấm Đăng ngay trên task",
      metadata: {
        trigger_source: triggerSource,
        facebook_page_id: task.facebook_page_id
      }
    });

    eligibleTaskIds.push(id);
    eligibleTasks.push({
      ...task,
      schedule_date: vnNow.schedule_date,
      schedule_time: vnNow.schedule_time,
      scheduled_at: nowSec,
      original_scheduled_at: task.original_scheduled_at ?? oldScheduledAt ?? nowSec,
      original_schedule_date: task.original_schedule_date || task.schedule_date || vnNow.schedule_date,
      original_schedule_time: task.original_schedule_time || task.schedule_time || vnNow.schedule_time,
      manual_publish_requested_at: isoNow,
      manual_publish_by_user_id: actorUserId,
      trigger_source: triggerSource,
      status: "queued",
      raw_status: "queued",
      publish_status: "queued",
      is_locked: false
    });
  }

  return {
    eligibleTaskIds,
    eligibleTasks,
    ineligibleTasks,
    publishedTimestampUtc: nowSec,
    publishedScheduleDate: vnNow.schedule_date,
    publishedScheduleTime: vnNow.schedule_time
  };
}

export async function rescheduleTasksBulk(
  db: D1Database,
  params: {
    taskIds: number[];
    scheduleDate: string;
    scheduleTime: string;
    intervalMinutes?: number;
    allowPast?: boolean;
    minLeadSeconds?: number;
    ownerUserId: string;
    actorUserId?: string;
  }
): Promise<{
  updatedCount: number;
  updatedTasks: Array<{
    id: number;
    schedule_date: string;
    schedule_time: string;
    scheduled_at: number;
  }>;
  skippedTasks: Array<{ id: number; reason: string; code: string }>;
}> {
  const parsedBase = parseVnScheduleToUtc(params.scheduleDate, params.scheduleTime, {
    minLeadSeconds: params.minLeadSeconds ?? 60,
    allowPast: params.allowPast ?? false,
    requireSchedule: true
  });

  if (!parsedBase.isValid || parsedBase.scheduledAtUtc === null) {
    const code =
      parsedBase.missingDate || parsedBase.missingTime
        ? "SCHEDULE_REQUIRED"
        : parsedBase.isPast
          ? "SCHEDULE_IN_PAST"
          : "SCHEDULE_INVALID";
    throw new ScheduleValidationError({
      code,
      message: parsedBase.error || "Thời gian đặt lịch mới không hợp lệ hoặc đã qua.",
      httpStatus: 400,
      fieldErrors: parsedBase.fieldErrors,
      isPast: parsedBase.isPast,
      missingDate: parsedBase.missingDate,
      missingTime: parsedBase.missingTime
    });
  }

  const validIds = Array.from(
    new Set(
      (params.taskIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  if (validIds.length === 0) {
    return { updatedCount: 0, updatedTasks: [], skippedTasks: [] };
  }

  await ensureTaskCommentColumns(db);

  const allUserTasks = await getTasks(db, { ownerUserId: params.ownerUserId });
  const taskMap = new Map<number, TaskRecord>();
  for (const t of allUserTasks) {
    taskMap.set(t.id, t);
  }

  const intervalSec = Math.max(0, Math.floor(Number(params.intervalMinutes || 0))) * 60;
  const baseUtc = parsedBase.scheduledAtUtc;
  const isoNow = new Date().toISOString();
  const actorUserId = params.actorUserId || params.ownerUserId;

  const updatedTasks: Array<{
    id: number;
    schedule_date: string;
    schedule_time: string;
    scheduled_at: number;
  }> = [];
  const skippedTasks: Array<{ id: number; reason: string; code: string }> = [];

  let eligibleIdx = 0;
  for (const id of validIds) {
    const task = taskMap.get(id);
    if (!task) {
      skippedTasks.push({
        id,
        code: "TASK_NOT_FOUND",
        reason: "Task không tồn tại."
      });
      continue;
    }

    if (isTaskPublishedAndLocked(task)) {
      skippedTasks.push({
        id,
        code: "TASK_ALREADY_PUBLISHED",
        reason: "Task đã đăng Reels thành công (đã khóa)."
      });
      continue;
    }

    if (isTaskCurrentlyRunning(task)) {
      skippedTasks.push({
        id,
        code: "TASK_IN_PROGRESS",
        reason: "Task đang xử lý đăng, không thể đổi lịch."
      });
      continue;
    }

    const targetUtc = baseUtc + eligibleIdx * intervalSec;
    const targetVn = formatUtcToVn(targetUtc);
    eligibleIdx++;

    const oldScheduledAt = task.scheduled_at ?? null;
    const oldScheduleText = `${task.schedule_date || ""} ${task.schedule_time || ""}`.trim();
    const oldStatus = task.raw_status || task.status;

    const res = await db
      .prepare(
        `UPDATE tasks
         SET original_scheduled_at = COALESCE(original_scheduled_at, scheduled_at, ?),
             original_schedule_date = CASE WHEN original_schedule_date IS NULL OR original_schedule_date = '' THEN COALESCE(NULLIF(schedule_date, ''), ?) ELSE original_schedule_date END,
             original_schedule_time = CASE WHEN original_schedule_time IS NULL OR original_schedule_time = '' THEN COALESCE(NULLIF(schedule_time, ''), ?) ELSE original_schedule_time END,
             schedule_date = ?,
             schedule_time = ?,
             scheduled_at = ?,
             status = 'pending',
             publish_status = 'pending',
             is_locked = 0,
             next_retry_at = NULL,
             locked_until = NULL,
             lease_owner = NULL,
             log = ?,
             updated_at = ?
         WHERE id = ?
           AND owner_user_id = ?
           AND status NOT IN ('success', 'done', 'processing', 'running', 'queued')
           AND COALESCE(is_locked, 0) = 0`
      )
      .bind(
        targetUtc,
        targetVn.schedule_date,
        targetVn.schedule_time,
        targetVn.schedule_date,
        targetVn.schedule_time,
        targetUtc,
        `Đã đổi lịch đăng sang ${targetVn.schedule_date} ${targetVn.schedule_time}`,
        isoNow,
        id,
        params.ownerUserId
      )
      .run();

    if ((res.meta?.changes || 0) === 0) {
      skippedTasks.push({
        id,
        code: "TASK_STATE_CHANGED",
        reason: "Không thể cập nhật do trạng thái task vừa thay đổi."
      });
      continue;
    }

    await recordTaskAuditLog(db, {
      taskId: id,
      ownerUserId: params.ownerUserId,
      actorUserId,
      action: "bulk_reschedule",
      oldScheduledAt,
      newScheduledAt: targetUtc,
      oldScheduleText,
      newScheduleText: `${targetVn.schedule_date} ${targetVn.schedule_time}`,
      oldStatus,
      newStatus: "pending",
      reason:
        intervalSec > 0
          ? `Đổi lịch hàng loạt (giãn cách ${params.intervalMinutes} phút/task)`
          : "Đổi lịch hàng loạt cùng giờ",
      metadata: { interval_minutes: params.intervalMinutes || 0 }
    });

    updatedTasks.push({
      id,
      schedule_date: targetVn.schedule_date,
      schedule_time: targetVn.schedule_time,
      scheduled_at: targetUtc
    });
  }

  return {
    updatedCount: updatedTasks.length,
    updatedTasks,
    skippedTasks
  };
}

export async function cancelTasksBulk(
  db: D1Database,
  params: {
    taskIds: number[];
    ownerUserId: string;
    actorUserId?: string;
  }
): Promise<{
  cancelledCount: number;
  cancelledTaskIds: number[];
  skippedTasks: Array<{ id: number; reason: string; code: string }>;
}> {
  const validIds = Array.from(
    new Set(
      (params.taskIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  if (validIds.length === 0) {
    return { cancelledCount: 0, cancelledTaskIds: [], skippedTasks: [] };
  }

  await ensureTaskCommentColumns(db);

  const allUserTasks = await getTasks(db, { ownerUserId: params.ownerUserId });
  const taskMap = new Map<number, TaskRecord>();
  for (const t of allUserTasks) {
    taskMap.set(t.id, t);
  }

  const isoNow = new Date().toISOString();
  const actorUserId = params.actorUserId || params.ownerUserId;
  const cancelledTaskIds: number[] = [];
  const skippedTasks: Array<{ id: number; reason: string; code: string }> = [];

  for (const id of validIds) {
    const task = taskMap.get(id);
    if (!task) {
      skippedTasks.push({ id, code: "TASK_NOT_FOUND", reason: "Task không tồn tại." });
      continue;
    }
    if (isTaskPublishedAndLocked(task)) {
      skippedTasks.push({
        id,
        code: "TASK_ALREADY_PUBLISHED",
        reason: "Task đã đăng Reels thành công (đã khóa)."
      });
      continue;
    }
    if (isTaskCurrentlyRunning(task)) {
      skippedTasks.push({
        id,
        code: "TASK_IN_PROGRESS",
        reason: "Task đang xử lý đăng, không thể hủy lịch."
      });
      continue;
    }

    const res = await db
      .prepare(
        `UPDATE tasks
         SET status = 'cancelled',
             publish_status = 'cancelled',
             locked_until = NULL,
             lease_owner = NULL,
             next_retry_at = NULL,
             log = 'Đã hủy lịch đăng theo yêu cầu người dùng',
             updated_at = ?
         WHERE id = ?
           AND owner_user_id = ?
           AND status NOT IN ('success', 'done', 'processing', 'running', 'queued')
           AND COALESCE(is_locked, 0) = 0`
      )
      .bind(isoNow, id, params.ownerUserId)
      .run();

    if ((res.meta?.changes || 0) > 0) {
      cancelledTaskIds.push(id);
      await recordTaskAuditLog(db, {
        taskId: id,
        ownerUserId: params.ownerUserId,
        actorUserId,
        action: "cancel_schedule",
        oldScheduledAt: task.scheduled_at ?? null,
        newScheduledAt: task.scheduled_at ?? null,
        oldScheduleText: `${task.schedule_date || ""} ${task.schedule_time || ""}`.trim(),
        newScheduleText: `${task.schedule_date || ""} ${task.schedule_time || ""}`.trim(),
        oldStatus: task.raw_status || task.status,
        newStatus: "cancelled",
        reason: "Người dùng hủy lịch đăng"
      });
    } else {
      skippedTasks.push({
        id,
        code: "TASK_STATE_CHANGED",
        reason: "Không thể hủy lịch do trạng thái task vừa thay đổi."
      });
    }
  }

  return {
    cancelledCount: cancelledTaskIds.length,
    cancelledTaskIds,
    skippedTasks
  };
}

export async function deleteTask(
  db: D1Database,
  taskId: number,
  ownerUserId: string,
  options?: { allowPublished?: boolean }
): Promise<{ deleted: boolean; orphanMediaId?: string | null }> {
  const existing = await getTask(db, taskId, ownerUserId);
  if (!existing) return { deleted: false };

  if (options?.allowPublished) {
    if (isTaskCurrentlyRunning(existing)) {
      throw new TaskLockError(
        "TASK_CURRENTLY_RUNNING",
        "TASK_CURRENTLY_RUNNING: Bài viết đang trong quá trình xuất bản, không thể xóa lúc này.",
        409
      );
    }
  } else {
    assertTaskMutable(existing, "xóa");
  }

  const deleteSql = options?.allowPublished
    ? `DELETE FROM tasks WHERE id = ? AND owner_user_id = ? AND (status != 'running' OR status IS NULL)`
    : `DELETE FROM tasks WHERE id = ? AND owner_user_id = ? AND status != 'success' AND COALESCE(is_locked, 0) = 0`;

  const res = await db.prepare(deleteSql).bind(taskId, ownerUserId).run();

  if ((res.meta?.changes || 0) === 0) {
    const recheck = await getTask(db, taskId, ownerUserId);
    if (recheck) {
      assertTaskMutable(recheck, "xóa");
    }
  }

  await recordTaskAuditLog(db, {
    taskId,
    ownerUserId,
    actorUserId: ownerUserId,
    action: "delete_task",
    oldScheduledAt: existing.scheduled_at ?? null,
    newScheduledAt: null,
    oldScheduleText: `${existing.schedule_date || ""} ${existing.schedule_time || ""}`.trim(),
    newScheduleText: "",
    oldStatus: existing.raw_status || existing.status,
    newStatus: "deleted",
    reason: "Người dùng xóa task"
  });

  let orphanMediaId: string | null = null;
  if (existing.media_id) {
    const otherRef = await db
      .prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE media_id = ? AND owner_user_id = ?")
      .bind(existing.media_id, ownerUserId)
      .first<{ cnt: number }>();
    if (!otherRef || Number(otherRef.cnt) === 0) {
      orphanMediaId = existing.media_id;
    }
  }

  return { deleted: true, orphanMediaId };
}

export async function cleanupCompletedTasks(
  db: D1Database,
  ownerUserId: string
): Promise<{ deletedCount: number }> {
  const res = await db
    .prepare(
      "DELETE FROM tasks WHERE owner_user_id = ? AND status IN ('published', 'success')"
    )
    .bind(ownerUserId)
    .run();
  return { deletedCount: res.meta?.changes || 0 };
}

export async function deleteTasksBulk(
  db: D1Database,
  taskIds: number[],
  ownerUserId: string
): Promise<{
  deletedCount: number;
  orphanMediaIds: string[];
  skippedLockedCount: number;
  lockedTaskIds: number[];
}> {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return { deletedCount: 0, orphanMediaIds: [], skippedLockedCount: 0, lockedTaskIds: [] };
  }

  const validIds = taskIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (validIds.length === 0) {
    return { deletedCount: 0, orphanMediaIds: [], skippedLockedCount: 0, lockedTaskIds: [] };
  }

  const placeholders = validIds.map(() => "?").join(",");
  const { results: targetTasks } = await db
    .prepare(
      `SELECT id, media_id, status, publish_status, is_locked, video_id, post_id
       FROM tasks
       WHERE id IN (${placeholders}) AND owner_user_id = ?`
    )
    .bind(...validIds, ownerUserId)
    .all<{
      id: number;
      media_id: string | null;
      status: string;
      publish_status?: string;
      is_locked?: number;
      video_id?: string;
      post_id?: string;
    }>();

  if (!targetTasks || targetTasks.length === 0) {
    return { deletedCount: 0, orphanMediaIds: [], skippedLockedCount: 0, lockedTaskIds: [] };
  }

  const lockedTaskIds: number[] = [];
  const deletableTasks: typeof targetTasks = [];

  for (const t of targetTasks) {
    if (isTaskPublishedAndLocked(t) || isTaskCurrentlyRunning(t)) {
      lockedTaskIds.push(t.id);
    } else {
      deletableTasks.push(t);
    }
  }

  if (deletableTasks.length === 0 && lockedTaskIds.length > 0) {
    throw new TaskLockError(
      "TASK_ALREADY_PUBLISHED",
      "TASK_ALREADY_PUBLISHED: Task đã đăng Reels thành công và không thể xóa. Các task đã xuất bản hoặc đang xử lý đã được khóa để bảo toàn lịch sử.",
      403
    );
  }

  const idsToDelete = deletableTasks.map((t) => t.id);
  const mediaIds = deletableTasks
    .map((t) => t.media_id)
    .filter((m): m is string => Boolean(m && m.trim().length > 0));

  const delPlaceholders = idsToDelete.map(() => "?").join(",");
  await db
    .prepare(
      `DELETE FROM tasks
       WHERE id IN (${delPlaceholders})
         AND owner_user_id = ?
         AND status != 'success'
         AND COALESCE(is_locked, 0) = 0`
    )
    .bind(...idsToDelete, ownerUserId)
    .run();

  const orphanMediaIds: string[] = [];
  if (mediaIds.length > 0) {
    const uniqueMediaIds = Array.from(new Set(mediaIds));
    for (const mId of uniqueMediaIds) {
      const refCount = await db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM tasks WHERE media_id = ? AND owner_user_id = ?"
        )
        .bind(mId, ownerUserId)
        .first<{ cnt: number }>();
      if (!refCount || Number(refCount.cnt) === 0) {
        orphanMediaIds.push(mId);
      }
    }
  }

  return {
    deletedCount: idsToDelete.length,
    orphanMediaIds,
    skippedLockedCount: lockedTaskIds.length,
    lockedTaskIds
  };
}

export async function resetRunningTasks(
  db: D1Database,
  ownerUserId: string
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE tasks
       SET status = 'pending',
           locked_until = NULL,
           lease_owner = NULL,
           next_retry_at = NULL,
           log = 'Đã dừng theo yêu cầu người dùng -> Chờ chạy lại',
           updated_at = ?
       WHERE status IN ('running', 'queued', 'processing') AND owner_user_id = ?`
    )
    .bind(now, ownerUserId)
    .run();
  return res.meta?.changes || 0;
}

export async function getPendingTasks(
  db: D1Database,
  selectedPagesOnly = true,
  ownerUserId: string
): Promise<TaskRecord[]> {
  const allPending = await getTasks(db, {
    status: "pending",
    ownerUserId
  });

  if (!selectedPagesOnly) return allPending;

  const selectedPages = await getFacebookPages(db, "", {
    selectedOnly: true,
    includeToken: false,
    ownerUserId
  });
  const selectedIds = new Set(selectedPages.map((p) => p.facebook_page_id));
  return allPending.filter((t) => t.facebook_page_id && selectedIds.has(t.facebook_page_id));
}

/**
 * Atomic Lease Acquisition cho Queue Consumer (Tránh 2 consumer xử lý trùng 1 task)
 */
export async function claimTaskLease(
  db: D1Database,
  taskId: number,
  leaseOwner: string,
  leaseSeconds = 120
): Promise<TaskRecord | null> {
  const now = nowUtcSeconds();
  const lockedUntil = now + leaseSeconds;
  const isoNow = new Date().toISOString();

  const res = await db
    .prepare(
      `UPDATE tasks
       SET status = 'processing',
           locked_until = ?,
           lease_owner = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'queued', 'processing', 'scheduled')
         AND status != 'success'
         AND status != 'cancelled'
         AND (locked_until IS NULL OR locked_until < ?)`
    )
    .bind(lockedUntil, leaseOwner, isoNow, taskId, now)
    .run();

  if ((res.meta?.changes || 0) === 0) {
    return null;
  }

  const row = await db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<Record<string, unknown>>();
  if (!row) return null;

  return getTask(db, taskId, String(row.owner_user_id));
}

// ==========================================
// 7. DATA DELETION COMPLIANCE (META CALLBACK)
// ==========================================

export async function executeUserDataDeletion(
  db: D1Database,
  params: {
    confirmationCode: string;
    facebookUserId?: string | null;
    ownerUserId?: string | null;
  }
): Promise<{
  confirmation_code: string;
  status: string;
  deleted_summary: Record<string, number>;
  requested_at: string;
  completed_at: string;
}> {
  const now = new Date().toISOString();
  let targetUserId = params.ownerUserId || null;

  if (!targetUserId && params.facebookUserId) {
    const acc = await db
      .prepare("SELECT owner_user_id FROM facebook_accounts WHERE facebook_user_id = ? LIMIT 1")
      .bind(params.facebookUserId)
      .first<{ owner_user_id: string }>();
    if (acc?.owner_user_id) {
      targetUserId = acc.owner_user_id;
    }
  }

  const summary: Record<string, number> = {
    facebook_accounts: 0,
    facebook_pages: 0,
    facebook_account_pages: 0,
    tasks: 0,
    media_files: 0
  };

  if (params.facebookUserId) {
    const accs = await db
      .prepare("SELECT id, owner_user_id FROM facebook_accounts WHERE facebook_user_id = ?")
      .bind(params.facebookUserId)
      .all<{ id: string; owner_user_id: string }>();

    for (const a of accs.results || []) {
      const delRes = await deleteFacebookAccountWithPages(db, a.id, a.owner_user_id);
      if (delRes.deleted) {
        summary.facebook_accounts += 1;
        summary.facebook_pages += delRes.deleted_pages_count;
        summary.facebook_account_pages += delRes.deleted_pages_count + delRes.shared_pages_kept_count;
      }
    }
  } else if (targetUserId) {
    const [r1, r2, r3, r4, r5] = await db.batch([
      db.prepare("DELETE FROM facebook_account_pages WHERE owner_user_id = ?").bind(targetUserId),
      db.prepare("DELETE FROM facebook_pages WHERE owner_user_id = ?").bind(targetUserId),
      db.prepare("DELETE FROM facebook_accounts WHERE owner_user_id = ?").bind(targetUserId),
      db.prepare("DELETE FROM tasks WHERE owner_user_id = ?").bind(targetUserId),
      db.prepare("DELETE FROM media_files WHERE owner_user_id = ?").bind(targetUserId)
    ]);
    summary.facebook_account_pages = r1.meta?.changes || 0;
    summary.facebook_pages = r2.meta?.changes || 0;
    summary.facebook_accounts = r3.meta?.changes || 0;
    summary.tasks = r4.meta?.changes || 0;
    summary.media_files = r5.meta?.changes || 0;
  }

  await db
    .prepare(
      `INSERT INTO data_deletion_requests (
         confirmation_code, facebook_user_id, owner_user_id, status, deleted_summary, requested_at, completed_at
       ) VALUES (?, ?, ?, 'completed', ?, ?, ?)`
    )
    .bind(
      params.confirmationCode,
      params.facebookUserId || null,
      targetUserId,
      JSON.stringify(summary),
      now,
      now
    )
    .run();

  return {
    confirmation_code: params.confirmationCode,
    status: "completed",
    deleted_summary: summary,
    requested_at: now,
    completed_at: now
  };
}

export async function getDataDeletionRequest(
  db: D1Database,
  confirmationCode: string
): Promise<Record<string, unknown> | null> {
  if (!confirmationCode) return null;
  return db
    .prepare("SELECT * FROM data_deletion_requests WHERE confirmation_code = ?")
    .bind(confirmationCode)
    .first<Record<string, unknown>>();
}
