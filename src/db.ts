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
  TaskRecord
} from "./types.ts";
import {
  hashPassword,
  verifyPassword,
  encryptToken,
  decryptToken,
  detectTokenVersion,
  randomHex
} from "./utils/crypto.ts";
import { parseVnScheduleToUtc, nowUtcSeconds } from "./utils/timezone.ts";
import { sanitizeSensitiveText } from "./utils/sanitize.ts";

let schemaInitialized = false;
let schemaInitPromise: Promise<void> | null = null;

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
  const scopesJson = JSON.stringify(params.scopes || []);
  const missingJson = JSON.stringify(params.missingScopes || []);
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
             status = ?,
             token_status = ?,
             connected_at = ?,
             token_expires_at = ?,
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
        status,
        tokenStatus,
        now,
        params.tokenExpiresAt || null,
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
           access_token, token_version, token_type, scopes, missing_scopes, status, token_status,
           connected_at, token_expires_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        status,
        tokenStatus,
        now,
        params.tokenExpiresAt || null,
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
      can_post: Boolean(lr.can_post)
    });
    pagesByAccountId.set(accId, list);
  }

  const out: FacebookAccountRecord[] = [];

  for (const r of rows) {
    const scopes = safeJsonParseArray(r.scopes as string);
    const missingScopes = safeJsonParseArray(r.missing_scopes as string);

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
      status,
      token_status: tokenStatus,
      connected_at: (r.connected_at as string) || null,
      token_expires_at: expStr,
      expires_at: expStr,
      last_synced_at: (r.last_synced_at as string) || null,
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
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      status,
      resolvedTokenStatus,
      lastError ? sanitizeSensitiveText(lastError) : null,
      lastSyncedAt,
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

  await reconcileOrphanPages(db, encryptionKeyFallback, ownerUserId);
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
            Number(otherLink.is_published ?? 1),
            String(otherLink.facebook_account_id),
            now,
            p.id,
            ownerUserId
          )
      );
    } else {
      deletedPageIds.push(p.facebook_page_id);
      batchStmts.push(
        db
          .prepare(
            "DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?)"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare(
            "DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?)"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?")
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
): Promise<void> {
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

  if (staleIds.length === 0) return;

  const stmts = staleIds.map((pid) =>
    db
      .prepare(
        "DELETE FROM facebook_account_pages WHERE facebook_account_id = ? AND facebook_page_id = ? AND owner_user_id = ?"
      )
      .bind(accountId, pid, ownerUserId)
  );
  await db.batch(stmts);
  await reconcileOrphanPages(db, encryptionKeyFallback, ownerUserId);
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
  ownerUserId: string
): Promise<void> {
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
          Number(activeLink.is_published ?? 1),
          String(activeLink.facebook_account_id),
          now,
          p.id
        )
        .run();
    } else {
      await db.batch([
        db
          .prepare(
            "DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?)"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare(
            "DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?)"
          )
          .bind(p.facebook_page_id, ownerUserId),
        db
          .prepare("DELETE FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?")
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
    isPublished?: boolean;
    connectedAccountId: string;
    tokenStatus?: string;
    ownerUserId: string;
  }
): Promise<string> {
  const now = new Date().toISOString();
  const tasksJson = JSON.stringify(params.tasks || []);
  const encryptedToken = await encryptToken(params.pageAccessToken, encryptionKey, "v2");
  const tokenVersion = detectTokenVersion(encryptedToken);
  const canPostInt = params.canPost !== false ? 1 : 0;
  const isPublishedInt = params.isPublished !== false ? 1 : 0;
  const tokenStatus = params.tokenStatus || (encryptedToken ? "valid" : "missing");

  await db
    .prepare(
      `INSERT INTO facebook_account_pages (
         owner_user_id, facebook_account_id, facebook_page_id, page_access_token, token_version,
         tasks_json, can_post, is_published, token_status, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(facebook_account_id, facebook_page_id) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         page_access_token = excluded.page_access_token,
         token_version = excluded.token_version,
         tasks_json = excluded.tasks_json,
         can_post = excluded.can_post,
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
           page_access_token, token_version, tasks_json, can_post, is_published, is_selected,
           status, token_status, connected_account_id, last_synced_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?)`
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
              AND t.status IN ('pending', 'queued', 'processing', 'running')) AS pending_count
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
    let bestEncryptedToken = String(r.page_access_token || "");

    for (const lnk of linkRows) {
      const lTasks = safeJsonParseArray(lnk.tasks_json as string);
      for (const t of lTasks) mergedTasksSet.add(t);
      const lCanPost = Boolean(lnk.can_post);
      if (lCanPost && lnk.account_status === "connected") {
        anyCanPost = true;
        if (lnk.page_access_token) {
          bestEncryptedToken = String(lnk.page_access_token);
        }
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
        is_published: Boolean(lnk.is_published),
        last_synced_at: (lnk.last_synced_at as string) || null
      });
    }

    const pageRecord: FacebookPageRecord & { page_access_token?: string } = {
      id: String(r.id),
      owner_user_id: (r.owner_user_id as string) || null,
      facebook_page_id: fbPageId,
      page_name: String(r.page_name),
      name: String(r.page_name),
      category: String(r.category || ""),
      avatar_url: String(r.avatar_url || ""),
      tasks: Array.from(mergedTasksSet),
      can_post: anyCanPost,
      is_published: Boolean(r.is_published),
      is_selected: Boolean(r.is_selected),
      status: String(r.status || "active"),
      token_status: String(r.token_status || "valid"),
      connected_account_id: (r.connected_account_id as string) || null,
      last_synced_at: (r.last_synced_at as string) || null,
      created_at: (r.created_at as string) || null,
      updated_at: (r.updated_at as string) || null,
      pending_count: Number(r.pending_count || 0),
      admin_accounts: adminAccounts,
      admin_names: adminAccounts
        .map((a) => a.facebook_user_name)
        .filter((n): n is string => Boolean(n))
    };

    if (includeToken) {
      pageRecord.page_access_token = await decryptToken(bestEncryptedToken, encryptionKey);
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
  }
): Promise<MediaFileRecord> {
  const now = new Date().toISOString();
  const status = params.uploadStatus || "pending";
  const backend = params.storageBackend || "r2";

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
  const cleanKey = mediaIdOrKey.replace(/^r2:\/\//, "");
  return db
    .prepare(
      `SELECT * FROM media_files
       WHERE (id = ? OR object_key = ?) AND owner_user_id = ?
       LIMIT 1`
    )
    .bind(cleanKey, cleanKey, ownerUserId)
    .first<MediaFileRecord>();
}

export async function completeMediaFileUpload(
  db: D1Database,
  mediaId: string,
  ownerUserId: string,
  sizeBytes?: number,
  sha256Checksum?: string | null,
  storageBackend?: string
): Promise<MediaFileRecord | null> {
  const now = new Date().toISOString();
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

  return getMediaFileById(db, mediaId, ownerUserId);
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

function mapStatusForFrontend(status: string, scheduledAt?: number | null): string {
  const now = nowUtcSeconds();
  if (status === "pending") {
    if (scheduledAt !== null && scheduledAt !== undefined && scheduledAt > now) {
      return "scheduled"; // Đang chờ lịch
    }
    return "pending"; // Chờ đăng
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
  },
  options?: {
    allowPast?: boolean;
    minLeadSeconds?: number;
    referenceNowUtc?: number;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const pageId = params.facebookPageId || params.profileId || null;
  const parsedSchedule = parseVnScheduleToUtc(params.scheduleDate, params.scheduleTime, {
    minLeadSeconds: options?.minLeadSeconds ?? 60,
    allowPast: options?.allowPast ?? false,
    referenceNowUtc: options?.referenceNowUtc
  });
  if (!parsedSchedule.isValid) {
    throw new Error(parsedSchedule.error || "Thời gian đặt lịch không hợp lệ hoặc đã qua.");
  }
  const scheduledAt = parsedSchedule.scheduledAtUtc;
  const status = params.status || "pending";
  const idempotencyKey = `task_${params.ownerUserId}_${pageId || "unassigned"}_${randomHex(8)}`;

  const res = await db
    .prepare(
      `INSERT INTO tasks (
         owner_user_id, profile_id, facebook_page_id, media_id, object_key,
         video_path, caption, comment_text, schedule_date, schedule_time,
         scheduled_at, timezone, status, idempotency_key, attempt_count, max_attempts,
         log, video_id, post_id, video_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Asia/Ho_Chi_Minh', ?, ?, 0, 3, 'Chờ xử lý', '', '', '', ?, ?)`
    )
    .bind(
      params.ownerUserId,
      params.profileId || pageId,
      pageId,
      params.mediaId || null,
      params.objectKey || null,
      params.videoPath.trim(),
      params.caption || "",
      params.commentText || "",
      params.scheduleDate || "",
      params.scheduleTime || "",
      scheduledAt,
      status,
      idempotencyKey,
      now,
      now
    )
    .run();

  const taskId = Number(res.meta?.last_row_id || 0);
  if (taskId > 0) {
    await appendTaskStageLog(
      db,
      taskId,
      params.ownerUserId,
      "INFO",
      "created",
      scheduledAt
        ? `Tạo tác vụ hẹn lịch đăng lúc ${params.scheduleDate} ${params.scheduleTime} (Asia/Ho_Chi_Minh -> UTC ${scheduledAt}).`
        : "Tạo tác vụ đăng Reels mới."
    );
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
  }>,
  assignPageIds: string[] | null,
  ownerUserId: string
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

    const tid = await addTask(db, {
      videoPath: vPath,
      caption: item.caption || "",
      commentText: item.comment_text || "",
      scheduleDate: item.schedule_date || "",
      scheduleTime: item.schedule_time || "",
      facebookPageId: targetPageId,
      mediaId: item.media_id || null,
      objectKey: item.object_key || null,
      ownerUserId
    });
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
    ownerUserId: string;
  }
): Promise<TaskRecord[]> {
  const { facebookPageId, status, search, accountIds = [], ownerUserId } = options;

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

  if (status) {
    if (status === "running") {
      sql += " AND t.status IN ('running', 'queued', 'processing')";
    } else {
      sql += " AND t.status = ?";
      params.push(status);
    }
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
    return {
      id: Number(r.id),
      owner_user_id: (r.owner_user_id as string) || null,
      profile_id: (r.profile_id as string) || (r.facebook_page_id as string) || null,
      facebook_page_id: (r.facebook_page_id as string) || (r.profile_id as string) || null,
      media_id: (r.media_id as string) || null,
      object_key: (r.object_key as string) || null,
      video_path: String(r.video_path || ""),
      caption: String(r.caption || ""),
      comment_text: String(r.comment_text || ""),
      schedule_date: String(r.schedule_date || ""),
      schedule_time: String(r.schedule_time || ""),
      scheduled_at: schedAt,
      timezone: String(r.timezone || "Asia/Ho_Chi_Minh"),
      status: mapStatusForFrontend(rawStatus, schedAt),
      raw_status: rawStatus,
      is_future_schedule: schedAt !== null && schedAt > nowUtcSeconds(),
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
      video_id: String(r.video_id || ""),
      post_id: String(r.post_id || ""),
      video_url: String(r.video_url || ""),
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
  }
): Promise<boolean> {
  const existing = await getTask(db, taskId, params.ownerUserId);
  if (!existing) return false;

  const newPageId =
    params.facebookPageId !== undefined ? params.facebookPageId : existing.facebook_page_id;
  const newVideo = params.videoPath !== undefined ? params.videoPath.trim() : existing.video_path;
  const newCaption = params.caption !== undefined ? params.caption : existing.caption;
  const newComment = params.commentText !== undefined ? params.commentText : existing.comment_text;
  const newDate = params.scheduleDate !== undefined ? params.scheduleDate : existing.schedule_date;
  const newTime = params.scheduleTime !== undefined ? params.scheduleTime : existing.schedule_time;
  const newMediaId = params.mediaId !== undefined ? params.mediaId : existing.media_id;
  const newObjectKey = params.objectKey !== undefined ? params.objectKey : existing.object_key;
  const parsedSchedule = parseVnScheduleToUtc(newDate, newTime, {
    minLeadSeconds: options?.minLeadSeconds ?? 60,
    allowPast: options?.allowPast ?? false,
    referenceNowUtc: options?.referenceNowUtc
  });
  if (!parsedSchedule.isValid) {
    throw new Error(parsedSchedule.error || "Thời gian đặt lịch không hợp lệ hoặc đã qua.");
  }
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE tasks
       SET facebook_page_id = ?,
           profile_id = ?,
           media_id = ?,
           object_key = ?,
           video_path = ?,
           caption = ?,
           comment_text = ?,
           schedule_date = ?,
           schedule_time = ?,
           scheduled_at = ?,
           updated_at = ?
       WHERE id = ? AND owner_user_id = ?`
    )
    .bind(
      newPageId,
      newPageId,
      newMediaId || null,
      newObjectKey || null,
      newVideo,
      newCaption,
      newComment,
      newDate,
      newTime,
      parsedSchedule.scheduledAtUtc,
      now,
      taskId,
      params.ownerUserId
    )
    .run();

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
  }
): Promise<void> {
  const now = new Date().toISOString();
  const cleanLog = sanitizeSensitiveText(logMsg);

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

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE tasks
       SET status = 'pending',
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
           updated_at = ?
       WHERE id = ? AND owner_user_id = ?`
    )
    .bind(now, taskId, ownerUserId)
    .run();
  return true;
}

export async function deleteTask(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<{ deleted: boolean; orphanMediaId?: string | null }> {
  const existing = await getTask(db, taskId, ownerUserId);
  if (!existing) return { deleted: false };

  await db
    .prepare("DELETE FROM tasks WHERE id = ? AND owner_user_id = ?")
    .bind(taskId, ownerUserId)
    .run();

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
         AND status IN ('pending', 'queued', 'processing')
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
