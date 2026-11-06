/**
 * Cloudflare D1 Database Layer (Serverless SQLite)
 * Enforces strict multi-user isolation (owner_user_id) and encrypted token storage.
 */

import type {
  D1Database,
  UserRecord,
  FacebookAccountRecord,
  FacebookPageRecord,
  AdminAccountLink,
  TaskRecord
} from "./types.ts";
import { hashPassword, verifyPassword, randomHex } from "./crypto.ts";

let schemaInitialized = false;

export function nowIsoSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Ensures all required tables and default admin user exist in Cloudflare D1.
 * Safe and idempotent to call on Worker startup.
 */
export async function ensureDatabaseInitialized(db: D1Database): Promise<void> {
  if (schemaInitialized) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      full_name TEXT,
      email TEXT,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT,
      action TEXT DEFAULT 'connect',
      redirect_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS facebook_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT,
      encrypted_user_access_token TEXT NOT NULL,
      token_expires_at TEXT,
      scopes TEXT,
      status TEXT DEFAULT 'connected',
      owner_user_id TEXT NOT NULL,
      avatar_url TEXT,
      connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, owner_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS facebook_pages (
      id TEXT PRIMARY KEY,
      facebook_page_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      avatar_url TEXT,
      encrypted_page_access_token TEXT NOT NULL,
      tasks TEXT,
      can_post INTEGER DEFAULT 1,
      connection_id TEXT,
      is_selected INTEGER DEFAULT 1,
      status TEXT DEFAULT 'connected',
      token_status TEXT DEFAULT 'valid',
      owner_user_id TEXT NOT NULL,
      last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(facebook_page_id, owner_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS facebook_account_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      facebook_page_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      encrypted_page_access_token TEXT NOT NULL,
      tasks TEXT,
      can_post INTEGER DEFAULT 1,
      token_status TEXT DEFAULT 'valid',
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, facebook_page_id)
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT,
      facebook_page_id TEXT,
      video_path TEXT NOT NULL,
      caption TEXT,
      link_ac TEXT,
      comment_text TEXT,
      schedule_date TEXT,
      schedule_time TEXT,
      status TEXT DEFAULT 'pending',
      video_url TEXT,
      meta_video_id TEXT,
      meta_post_id TEXT,
      publish_mode TEXT DEFAULT 'now',
      error_message TEXT,
      log TEXT,
      done_time TEXT,
      owner_user_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS uploaded_videos (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT DEFAULT 'video/mp4',
      file_size INTEGER NOT NULL,
      r2_key TEXT,
      data_base64 TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_agent TEXT,
      screen_resolution TEXT,
      status TEXT DEFAULT 'idle',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT OR IGNORE INTO users (id, username, password_hash, salt, full_name, email, role, status, created_at)
     VALUES (
       'usr_admin',
       'admin',
       '4a3de7d8f973dcf4eacb1efb73a5492c1fa4593b187d455291ebd75204bef509',
       '7675b4edbf9cb8b1b2a3f4afcdd2dde1',
       'Quản Trị Viên',
       'admin@pagefb.namnangno.click',
       'admin',
       'active',
       CURRENT_TIMESTAMP
     )`
  ];

  try {
    await db.batch(statements.map((sql) => db.prepare(sql)));
    schemaInitialized = true;
  } catch (err) {
    console.error("[D1 Init Error]:", err);
  }
}

// ==========================================
// 1. USERS & AUTHENTICATION
// ==========================================

export async function getUserById(db: D1Database, userId: string): Promise<UserRecord | null> {
  if (!userId) return null;
  const row = await db
    .prepare(
      "SELECT id, username, full_name, email, role, status, created_at FROM users WHERE id = ? LIMIT 1"
    )
    .bind(userId.trim())
    .first<UserRecord>();
  return row || null;
}

export async function verifyUserCredentials(
  db: D1Database,
  username: string,
  password: string
): Promise<UserRecord | null> {
  const cleanUser = (username || "").trim().toLowerCase();
  if (!cleanUser || !password) return null;

  const row = await db
    .prepare(
      "SELECT id, username, password_hash, salt, full_name, email, role, status, created_at FROM users WHERE username = ? LIMIT 1"
    )
    .bind(cleanUser)
    .first<{
      id: string;
      username: string;
      password_hash: string;
      salt: string;
      full_name: string;
      email: string;
      role: string;
      status: string;
      created_at: string;
    }>();

  if (!row || row.status !== "active") return null;

  const valid = await verifyPassword(password, row.salt, row.password_hash);
  if (!valid) return null;

  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    email: row.email,
    role: row.role,
    status: row.status,
    created_at: row.created_at
  };
}

export async function createUser(
  db: D1Database,
  params: {
    username: string;
    password: string;
    fullName?: string;
    email?: string;
    role?: string;
  }
): Promise<UserRecord> {
  const cleanUser = (params.username || "").trim().toLowerCase();
  if (!cleanUser || cleanUser.length < 3) {
    throw new Error("Tên đăng nhập phải có ít nhất 3 ký tự.");
  }
  if (!params.password || params.password.length < 4) {
    throw new Error("Mật khẩu phải có ít nhất 4 ký tự.");
  }

  const existing = await db
    .prepare("SELECT id FROM users WHERE username = ? LIMIT 1")
    .bind(cleanUser)
    .first();
  if (existing) {
    throw new Error(`Tên đăng nhập '${cleanUser}' đã tồn tại.`);
  }

  const { hash, salt } = await hashPassword(params.password);
  const userId = `usr_${randomHex(4)}`;
  const fullName = (params.fullName || cleanUser).trim();
  const email = (params.email || "").trim();
  const role = params.role || "user";
  const now = nowIsoSql();

  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, salt, full_name, email, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .bind(userId, cleanUser, hash, salt, fullName, email, role, now)
    .run();

  const created = await getUserById(db, userId);
  if (!created) {
    throw new Error("Không thể khởi tạo tài khoản người dùng.");
  }
  return created;
}

// ==========================================
// 2. OAUTH CSRF STATE MANAGEMENT (D1)
// ==========================================

export async function saveOAuthState(
  db: D1Database,
  params: {
    state: string;
    userId: string;
    accountId?: string | null;
    action?: string;
    redirectUri: string;
    expiresInSeconds?: number;
  }
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + (params.expiresInSeconds || 900);

  // Clean up expired states opportunistically
  await db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(nowSec).run();

  await db
    .prepare(
      `INSERT INTO oauth_states (state, user_id, account_id, action, redirect_uri, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.state,
      params.userId,
      params.accountId || null,
      params.action || "connect",
      params.redirectUri,
      expiresAt,
      nowIsoSql()
    )
    .run();
}

export interface OAuthStateRecord {
  state: string;
  user_id: string;
  account_id: string | null;
  action: string;
  redirect_uri: string;
  expires_at: number;
}

export async function consumeOAuthState(
  db: D1Database,
  state: string
): Promise<OAuthStateRecord | null> {
  if (!state) return null;
  const row = await db
    .prepare(
      "SELECT state, user_id, account_id, action, redirect_uri, expires_at FROM oauth_states WHERE state = ? LIMIT 1"
    )
    .bind(state.trim())
    .first<OAuthStateRecord>();

  if (!row) return null;

  // One-time consumption: delete immediately to prevent replay attacks
  await db.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state.trim()).run();

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > Number(row.expires_at)) {
    return null;
  }
  return row;
}

// ==========================================
// 3. FACEBOOK ADMIN ACCOUNTS (MULTI-ACCOUNT)
// ==========================================

export async function saveFacebookAccount(
  db: D1Database,
  params: {
    userId: string;
    userName: string;
    encryptedToken: string;
    tokenExpiresAt: string;
    scopes: string;
    accountId?: string | null;
    ownerUserId: string;
    avatarUrl?: string | null;
  }
): Promise<FacebookAccountRecord> {
  const cleanFbUid = String(params.userId).trim();
  const cleanOwnerUid = String(params.ownerUserId).trim();
  const now = nowIsoSql();

  const existing = await db
    .prepare(
      "SELECT id FROM facebook_accounts WHERE user_id = ? AND owner_user_id = ? LIMIT 1"
    )
    .bind(cleanFbUid, cleanOwnerUid)
    .first<{ id: string }>();

  let accId: string;
  if (existing) {
    accId = existing.id;
    await db
      .prepare(
        `UPDATE facebook_accounts SET
          user_name = COALESCE(?, user_name),
          encrypted_user_access_token = ?,
          token_expires_at = ?,
          scopes = COALESCE(?, scopes),
          avatar_url = COALESCE(?, avatar_url),
          status = 'connected',
          connected_at = ?,
          last_synced_at = ?
        WHERE id = ? AND owner_user_id = ?`
      )
      .bind(
        params.userName,
        params.encryptedToken,
        params.tokenExpiresAt,
        params.scopes,
        params.avatarUrl || null,
        now,
        now,
        accId,
        cleanOwnerUid
      )
      .run();
  } else {
    accId = params.accountId || `acc_${randomHex(4)}`;
    await db
      .prepare(
        `INSERT INTO facebook_accounts (
          id, user_id, user_name, encrypted_user_access_token, token_expires_at,
          scopes, status, owner_user_id, avatar_url, connected_at, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?)`
      )
      .bind(
        accId,
        cleanFbUid,
        params.userName,
        params.encryptedToken,
        params.tokenExpiresAt,
        params.scopes,
        cleanOwnerUid,
        params.avatarUrl || null,
        now,
        now
      )
      .run();
  }

  const saved = await getFacebookAccountById(db, accId, cleanOwnerUid, false);
  if (!saved) {
    throw new Error("Không thể lưu tài khoản Facebook Admin vào D1.");
  }
  return saved;
}

export async function getFacebookAccounts(
  db: D1Database,
  options: {
    status?: string | null;
    ownerUserId: string;
    includeEncryptedToken?: boolean;
  }
): Promise<FacebookAccountRecord[]> {
  let query = `
    SELECT
      fa.id,
      fa.user_id,
      fa.user_name,
      ${options.includeEncryptedToken ? "fa.encrypted_user_access_token," : ""}
      fa.token_expires_at,
      fa.scopes,
      fa.status,
      fa.owner_user_id,
      fa.avatar_url,
      fa.connected_at,
      fa.last_synced_at,
      COUNT(fap.id) AS managed_pages_count,
      COUNT(CASE WHEN fap.can_post = 1 AND fap.token_status = 'valid' THEN 1 END) AS postable_pages_count
    FROM facebook_accounts fa
    LEFT JOIN facebook_account_pages fap ON fa.id = fap.account_id
    WHERE fa.owner_user_id = ?
  `;
  const binds: unknown[] = [options.ownerUserId];

  if (options.status) {
    query += " AND fa.status = ?";
    binds.push(options.status);
  }

  query += " GROUP BY fa.id ORDER BY fa.connected_at DESC";

  const res = await db
    .prepare(query)
    .bind(...binds)
    .all<Record<string, unknown>>();

  const nowMs = Date.now();
  return (res.results || []).map((r) => {
    const rawScopes = typeof r.scopes === "string" ? r.scopes : "";
    const scopes = rawScopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let daysRemaining: number | null = null;
    let status = String(r.status || "connected");
    const expStr = r.token_expires_at ? String(r.token_expires_at) : null;
    if (expStr) {
      const parsedMs = Date.parse(expStr.replace(" ", "T") + "Z");
      if (!isNaN(parsedMs)) {
        daysRemaining = Math.floor((parsedMs - nowMs) / 86400000);
        if (daysRemaining < 0 && status === "connected") {
          status = "expired";
        }
      }
    }

    const record: FacebookAccountRecord = {
      id: String(r.id),
      user_id: String(r.user_id),
      user_name: String(r.user_name || "Facebook Admin"),
      token_expires_at: expStr,
      scopes,
      status,
      owner_user_id: String(r.owner_user_id),
      avatar_url: r.avatar_url ? String(r.avatar_url) : null,
      connected_at: String(r.connected_at || ""),
      last_synced_at: String(r.last_synced_at || ""),
      managed_pages_count: Number(r.managed_pages_count || 0),
      postable_pages_count: Number(r.postable_pages_count || 0),
      days_remaining: daysRemaining
    };

    if (options.includeEncryptedToken && r.encrypted_user_access_token) {
      record.encrypted_user_access_token = String(r.encrypted_user_access_token);
    }
    return record;
  });
}

export async function getFacebookAccountById(
  db: D1Database,
  accountId: string,
  ownerUserId: string,
  includeEncryptedToken = false
): Promise<FacebookAccountRecord | null> {
  const cleanId = (accountId || "").trim();
  if (!cleanId) return null;

  const all = await getFacebookAccounts(db, {
    ownerUserId,
    includeEncryptedToken
  });
  return all.find((a) => a.id === cleanId || a.user_id === cleanId) || null;
}

export async function updateAccountStatus(
  db: D1Database,
  accountId: string,
  ownerUserId: string,
  status: string
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE facebook_accounts SET status = ? WHERE id = ? AND owner_user_id = ?")
    .bind(status, accountId.trim(), ownerUserId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

export async function disconnectFacebookAccount(
  db: D1Database,
  accountId: string,
  ownerUserId: string
): Promise<boolean> {
  const cleanAid = accountId.trim();
  const acc = await getFacebookAccountById(db, cleanAid, ownerUserId, false);
  if (!acc) return false;

  const pageRows = await db
    .prepare(
      "SELECT facebook_page_id FROM facebook_account_pages WHERE account_id = ? AND owner_user_id = ?"
    )
    .bind(acc.id, ownerUserId)
    .all<{ facebook_page_id: string }>();

  const affectedPageIds = (pageRows.results || []).map((r) => r.facebook_page_id);

  await db
    .prepare("UPDATE facebook_accounts SET status = 'disconnected' WHERE id = ? AND owner_user_id = ?")
    .bind(acc.id, ownerUserId)
    .run();

  await db
    .prepare(
      "UPDATE facebook_account_pages SET token_status = 'invalid' WHERE account_id = ? AND owner_user_id = ?"
    )
    .bind(acc.id, ownerUserId)
    .run();

  for (const pid of affectedPageIds) {
    const otherActive = await db
      .prepare(
        `SELECT fap.encrypted_page_access_token, fap.tasks, fap.can_post
         FROM facebook_account_pages fap
         JOIN facebook_accounts fa ON fap.account_id = fa.id
         WHERE fap.facebook_page_id = ?
           AND fap.owner_user_id = ?
           AND fa.status = 'connected'
           AND fap.token_status = 'valid'
         ORDER BY fap.can_post DESC, fap.synced_at DESC
         LIMIT 1`
      )
      .bind(pid, ownerUserId)
      .first<{ encrypted_page_access_token: string; tasks: string; can_post: number }>();

    if (otherActive) {
      await db
        .prepare(
          `UPDATE facebook_pages SET
            encrypted_page_access_token = ?,
            tasks = ?,
            can_post = ?,
            status = 'connected'
          WHERE facebook_page_id = ? AND owner_user_id = ?`
        )
        .bind(
          otherActive.encrypted_page_access_token,
          otherActive.tasks,
          otherActive.can_post,
          pid,
          ownerUserId
        )
        .run();
    } else {
      await db
        .prepare(
          "UPDATE facebook_pages SET can_post = 0, status = 'disconnected' WHERE facebook_page_id = ? AND owner_user_id = ?"
        )
        .bind(pid, ownerUserId)
        .run();
    }
  }

  return true;
}

export async function deleteFacebookAccountLocal(
  db: D1Database,
  accountId: string,
  ownerUserId: string
): Promise<boolean> {
  const acc = await getFacebookAccountById(db, accountId, ownerUserId, false);
  if (!acc) return false;

  await disconnectFacebookAccount(db, acc.id, ownerUserId);
  await db
    .prepare("DELETE FROM facebook_account_pages WHERE account_id = ? AND owner_user_id = ?")
    .bind(acc.id, ownerUserId)
    .run();
  await db
    .prepare("DELETE FROM facebook_accounts WHERE id = ? AND owner_user_id = ?")
    .bind(acc.id, ownerUserId)
    .run();
  return true;
}

export async function disconnectAllUserAccounts(
  db: D1Database,
  ownerUserId: string
): Promise<number> {
  const accounts = await getFacebookAccounts(db, { ownerUserId });
  let count = 0;
  for (const acc of accounts) {
    if (await disconnectFacebookAccount(db, acc.id, ownerUserId)) {
      count++;
    }
  }
  return count;
}

// ==========================================
// 4. FACEBOOK PAGES & USER PERMISSIONS
// ==========================================

export async function upsertFacebookPageAndRelation(
  db: D1Database,
  params: {
    accountId: string;
    ownerUserId: string;
    facebookPageId: string;
    name: string;
    encryptedPageAccessToken: string;
    tasksJson: string;
    canPost: number;
    category?: string | null;
    avatarUrl?: string | null;
  }
): Promise<void> {
  const cleanFbId = params.facebookPageId.trim();
  const cleanAid = params.accountId.trim();
  const cleanOwner = params.ownerUserId.trim();
  const now = nowIsoSql();

  const existingPage = await db
    .prepare(
      "SELECT id, is_selected, can_post FROM facebook_pages WHERE facebook_page_id = ? AND owner_user_id = ? LIMIT 1"
    )
    .bind(cleanFbId, cleanOwner)
    .first<{ id: string; is_selected: number; can_post: number }>();

  if (existingPage) {
    const shouldUpdateToken = params.canPost === 1 || Number(existingPage.can_post) === 0;
    if (shouldUpdateToken) {
      await db
        .prepare(
          `UPDATE facebook_pages SET
            name = ?,
            category = COALESCE(?, category),
            avatar_url = COALESCE(?, avatar_url),
            encrypted_page_access_token = ?,
            tasks = ?,
            can_post = ?,
            status = 'connected',
            token_status = 'valid',
            last_synced_at = ?
          WHERE facebook_page_id = ? AND owner_user_id = ?`
        )
        .bind(
          params.name.trim(),
          params.category || null,
          params.avatarUrl || null,
          params.encryptedPageAccessToken,
          params.tasksJson,
          params.canPost,
          now,
          cleanFbId,
          cleanOwner
        )
        .run();
    } else {
      await db
        .prepare(
          `UPDATE facebook_pages SET
            name = ?,
            category = COALESCE(?, category),
            avatar_url = COALESCE(?, avatar_url),
            status = 'connected',
            last_synced_at = ?
          WHERE facebook_page_id = ? AND owner_user_id = ?`
        )
        .bind(
          params.name.trim(),
          params.category || null,
          params.avatarUrl || null,
          now,
          cleanFbId,
          cleanOwner
        )
        .run();
    }
  } else {
    const pageInternalId = `page_${randomHex(4)}`;
    await db
      .prepare(
        `INSERT INTO facebook_pages (
          id, facebook_page_id, name, category, avatar_url,
          encrypted_page_access_token, tasks, can_post, connection_id,
          is_selected, status, token_status, owner_user_id, last_synced_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'connected', 'valid', ?, ?, ?)`
      )
      .bind(
        pageInternalId,
        cleanFbId,
        params.name.trim(),
        params.category || null,
        params.avatarUrl || null,
        params.encryptedPageAccessToken,
        params.tasksJson,
        params.canPost,
        cleanAid,
        cleanOwner,
        now,
        now
      )
      .run();
  }

  // Upsert Many-to-Many relationship in facebook_account_pages
  const existingRel = await db
    .prepare(
      "SELECT id FROM facebook_account_pages WHERE account_id = ? AND facebook_page_id = ? LIMIT 1"
    )
    .bind(cleanAid, cleanFbId)
    .first<{ id: number }>();

  if (existingRel) {
    await db
      .prepare(
        `UPDATE facebook_account_pages SET
          encrypted_page_access_token = ?,
          tasks = ?,
          can_post = ?,
          token_status = 'valid',
          synced_at = ?
        WHERE id = ?`
      )
      .bind(params.encryptedPageAccessToken, params.tasksJson, params.canPost, now, existingRel.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO facebook_account_pages (
          account_id, facebook_page_id, owner_user_id,
          encrypted_page_access_token, tasks, can_post, token_status, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'valid', ?)`
      )
      .bind(
        cleanAid,
        cleanFbId,
        cleanOwner,
        params.encryptedPageAccessToken,
        params.tasksJson,
        params.canPost,
        now
      )
      .run();
  }

  await db
    .prepare("UPDATE facebook_accounts SET last_synced_at = ? WHERE id = ? AND owner_user_id = ?")
    .bind(now, cleanAid, cleanOwner)
    .run();
}

export async function getFacebookPages(
  db: D1Database,
  options: {
    accountIds?: string[] | null;
    search?: string | null;
    status?: string | null;
    onlySelected?: boolean;
    ownerUserId: string;
  }
): Promise<FacebookPageRecord[]> {
  let query = `
    SELECT
      p.id,
      p.facebook_page_id,
      p.name,
      p.category,
      p.avatar_url,
      p.tasks,
      p.can_post,
      p.is_selected,
      p.status,
      p.token_status,
      p.owner_user_id,
      p.last_synced_at,
      p.created_at,
      COUNT(CASE WHEN t.status = 'pending' THEN 1 END) AS pending_count,
      COUNT(t.id) AS total_tasks
    FROM facebook_pages p
    LEFT JOIN tasks t ON p.facebook_page_id = t.facebook_page_id AND t.owner_user_id = p.owner_user_id
    WHERE p.owner_user_id = ?
  `;
  const binds: unknown[] = [options.ownerUserId];

  if (options.accountIds && options.accountIds.length > 0) {
    const cleanAids = options.accountIds.map((a) => a.trim()).filter(Boolean);
    if (cleanAids.length > 0) {
      const placeholders = cleanAids.map(() => "?").join(",");
      query += ` AND p.facebook_page_id IN (
        SELECT facebook_page_id FROM facebook_account_pages
        WHERE owner_user_id = ? AND account_id IN (${placeholders})
      )`;
      binds.push(options.ownerUserId, ...cleanAids);
    }
  }

  if (options.search && options.search.trim()) {
    const s = `%${options.search.trim()}%`;
    query += " AND (p.name LIKE ? OR p.facebook_page_id LIKE ?)";
    binds.push(s, s);
  }

  if (options.status && options.status.trim()) {
    if (options.status.trim() === "can_post") {
      query += " AND p.can_post = 1";
    } else {
      query += " AND p.status = ?";
      binds.push(options.status.trim());
    }
  }

  if (options.onlySelected) {
    query += " AND p.is_selected = 1";
  }

  query += " GROUP BY p.facebook_page_id ORDER BY p.name COLLATE NOCASE ASC";

  const res = await db
    .prepare(query)
    .bind(...binds)
    .all<Record<string, unknown>>();

  const pages: FacebookPageRecord[] = [];
  for (const r of res.results || []) {
    const fbid = String(r.facebook_page_id);
    const adminRes = await db
      .prepare(
        `SELECT
          fa.id AS account_id,
          fa.user_id,
          fa.user_name,
          fa.owner_user_id,
          fa.avatar_url,
          fa.status AS account_status,
          fap.can_post,
          fap.token_status,
          fap.synced_at
        FROM facebook_account_pages fap
        JOIN facebook_accounts fa ON fap.account_id = fa.id
        WHERE fap.facebook_page_id = ? AND fap.owner_user_id = ?
        ORDER BY fa.user_name ASC`
      )
      .bind(fbid, options.ownerUserId)
      .all<AdminAccountLink>();

    const admins = adminRes.results || [];
    const adminNames =
      admins
        .map((a) => a.user_name)
        .filter(Boolean)
        .join(", ") || "Chưa rõ";

    let canPost = Number(r.can_post || 0);
    if (admins.length > 0) {
      const anyActiveCanPost = admins.some(
        (a) =>
          a.account_status === "connected" &&
          Number(a.can_post) === 1 &&
          a.token_status === "valid"
      );
      canPost = anyActiveCanPost ? 1 : 0;
    }

    pages.push({
      id: String(r.id),
      facebook_page_id: fbid,
      name: String(r.name),
      category: r.category ? String(r.category) : null,
      avatar_url: r.avatar_url ? String(r.avatar_url) : null,
      tasks: String(r.tasks || "[]"),
      can_post: canPost,
      is_selected: Number(r.is_selected ?? 1),
      status: String(r.status || "connected"),
      token_status: String(r.token_status || "valid"),
      owner_user_id: String(r.owner_user_id),
      last_synced_at: String(r.last_synced_at || ""),
      created_at: String(r.created_at || ""),
      pending_count: Number(r.pending_count || 0),
      total_tasks: Number(r.total_tasks || 0),
      admin_accounts: admins,
      admin_names: adminNames
    });
  }

  return pages;
}

export async function getFacebookPageByFbId(
  db: D1Database,
  facebookPageId: string,
  ownerUserId: string
): Promise<FacebookPageRecord | null> {
  const cleanFbId = (facebookPageId || "").trim();
  if (!cleanFbId) return null;

  const pages = await getFacebookPages(db, {
    search: cleanFbId,
    ownerUserId
  });
  return pages.find((p) => p.facebook_page_id === cleanFbId || p.id === cleanFbId) || null;
}

export async function getPageActiveEncryptedToken(
  db: D1Database,
  facebookPageId: string,
  ownerUserId: string
): Promise<string | null> {
  const cleanFbId = (facebookPageId || "").trim();
  if (!cleanFbId) return null;

  const activeRel = await db
    .prepare(
      `SELECT fap.encrypted_page_access_token
       FROM facebook_account_pages fap
       JOIN facebook_accounts fa ON fap.account_id = fa.id
       WHERE fap.facebook_page_id = ?
         AND fap.owner_user_id = ?
         AND fa.status = 'connected'
         AND fap.can_post = 1
         AND fap.token_status = 'valid'
       ORDER BY fap.synced_at DESC
       LIMIT 1`
    )
    .bind(cleanFbId, ownerUserId)
    .first<{ encrypted_page_access_token: string }>();

  if (activeRel && activeRel.encrypted_page_access_token) {
    return activeRel.encrypted_page_access_token;
  }

  const pageRow = await db
    .prepare(
      "SELECT encrypted_page_access_token FROM facebook_pages WHERE facebook_page_id = ? AND owner_user_id = ? LIMIT 1"
    )
    .bind(cleanFbId, ownerUserId)
    .first<{ encrypted_page_access_token: string }>();

  return pageRow?.encrypted_page_access_token || null;
}

export async function updatePageSelection(
  db: D1Database,
  facebookPageId: string,
  isSelected: boolean,
  ownerUserId: string
): Promise<boolean> {
  const cleanId = facebookPageId.trim();
  const res = await db
    .prepare(
      "UPDATE facebook_pages SET is_selected = ? WHERE (facebook_page_id = ? OR id = ?) AND owner_user_id = ?"
    )
    .bind(isSelected ? 1 : 0, cleanId, cleanId, ownerUserId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

export async function bulkUpdatePageSelection(
  db: D1Database,
  params: {
    isSelected: boolean;
    facebookPageIds?: string[] | null;
    accountIds?: string[] | null;
    ownerUserId: string;
  }
): Promise<number> {
  const val = params.isSelected ? 1 : 0;

  if (params.facebookPageIds && params.facebookPageIds.length > 0) {
    const cleanIds = params.facebookPageIds.map((id) => id.trim()).filter(Boolean);
    if (cleanIds.length === 0) return 0;
    const placeholders = cleanIds.map(() => "?").join(",");
    const res = await db
      .prepare(
        `UPDATE facebook_pages SET is_selected = ?
         WHERE owner_user_id = ? AND (facebook_page_id IN (${placeholders}) OR id IN (${placeholders}))`
      )
      .bind(val, params.ownerUserId, ...cleanIds, ...cleanIds)
      .run();
    return res.meta?.changes || 0;
  }

  if (params.accountIds && params.accountIds.length > 0) {
    const cleanAids = params.accountIds.map((id) => id.trim()).filter(Boolean);
    if (cleanAids.length > 0) {
      const placeholders = cleanAids.map(() => "?").join(",");
      const res = await db
        .prepare(
          `UPDATE facebook_pages SET is_selected = ?
           WHERE owner_user_id = ? AND facebook_page_id IN (
             SELECT facebook_page_id FROM facebook_account_pages
             WHERE owner_user_id = ? AND account_id IN (${placeholders})
           )`
        )
        .bind(val, params.ownerUserId, params.ownerUserId, ...cleanAids)
        .run();
      return res.meta?.changes || 0;
    }
  }

  const res = await db
    .prepare("UPDATE facebook_pages SET is_selected = ? WHERE owner_user_id = ?")
    .bind(val, params.ownerUserId)
    .run();
  return res.meta?.changes || 0;
}

export async function deleteFacebookPageLocal(
  db: D1Database,
  facebookPageId: string,
  ownerUserId: string
): Promise<boolean> {
  const cleanFbId = facebookPageId.trim();
  const page = await getFacebookPageByFbId(db, cleanFbId, ownerUserId);
  if (!page) return false;

  await db
    .prepare(
      "DELETE FROM facebook_account_pages WHERE facebook_page_id = ? AND owner_user_id = ?"
    )
    .bind(page.facebook_page_id, ownerUserId)
    .run();

  await db
    .prepare(
      "DELETE FROM tasks WHERE facebook_page_id = ? AND owner_user_id = ?"
    )
    .bind(page.facebook_page_id, ownerUserId)
    .run();

  const res = await db
    .prepare(
      "DELETE FROM facebook_pages WHERE facebook_page_id = ? AND owner_user_id = ?"
    )
    .bind(page.facebook_page_id, ownerUserId)
    .run();

  return (res.meta?.changes || 0) > 0;
}

// ==========================================
// 5. TASKS (REELS PUBLISHING & SCHEDULING)
// ==========================================

export async function getTasks(
  db: D1Database,
  options: {
    facebookPageId?: string | null;
    profileId?: string | null;
    status?: string | null;
    search?: string | null;
    ownerUserId: string;
  }
): Promise<TaskRecord[]> {
  let query = `
    SELECT
      t.id,
      t.profile_id,
      t.facebook_page_id,
      p.name AS page_name,
      t.video_path,
      t.caption,
      t.link_ac,
      t.comment_text,
      t.schedule_date,
      t.schedule_time,
      t.status,
      t.video_url,
      t.meta_video_id,
      t.meta_post_id,
      t.publish_mode,
      t.error_message,
      t.log,
      t.done_time,
      t.owner_user_id,
      t.created_at
    FROM tasks t
    LEFT JOIN facebook_pages p
      ON t.facebook_page_id = p.facebook_page_id AND p.owner_user_id = t.owner_user_id
    WHERE t.owner_user_id = ?
  `;
  const binds: unknown[] = [options.ownerUserId];

  if (options.facebookPageId && options.facebookPageId.trim()) {
    query += " AND t.facebook_page_id = ?";
    binds.push(options.facebookPageId.trim());
  }
  if (options.profileId && options.profileId.trim()) {
    query += " AND t.profile_id = ?";
    binds.push(options.profileId.trim());
  }
  if (options.status && options.status.trim()) {
    query += " AND t.status = ?";
    binds.push(options.status.trim());
  }
  if (options.search && options.search.trim()) {
    const s = `%${options.search.trim()}%`;
    query +=
      " AND (t.caption LIKE ? OR t.video_path LIKE ? OR t.comment_text LIKE ? OR CAST(t.id AS TEXT) LIKE ?)";
    binds.push(s, s, s, s);
  }

  query += " ORDER BY t.id DESC";
  const res = await db
    .prepare(query)
    .bind(...binds)
    .all<TaskRecord>();
  return res.results || [];
}

export async function getTask(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<TaskRecord | null> {
  const row = await db
    .prepare(
      `SELECT
        t.id,
        t.profile_id,
        t.facebook_page_id,
        p.name AS page_name,
        t.video_path,
        t.caption,
        t.link_ac,
        t.comment_text,
        t.schedule_date,
        t.schedule_time,
        t.status,
        t.video_url,
        t.meta_video_id,
        t.meta_post_id,
        t.publish_mode,
        t.error_message,
        t.log,
        t.done_time,
        t.owner_user_id,
        t.created_at
      FROM tasks t
      LEFT JOIN facebook_pages p
        ON t.facebook_page_id = p.facebook_page_id AND p.owner_user_id = t.owner_user_id
      WHERE t.id = ? AND t.owner_user_id = ?
      LIMIT 1`
    )
    .bind(taskId, ownerUserId)
    .first<TaskRecord>();
  return row || null;
}

export async function addTask(
  db: D1Database,
  params: {
    facebookPageId?: string | null;
    profileId?: string | null;
    videoPath: string;
    caption?: string;
    commentText?: string;
    scheduleDate?: string;
    scheduleTime?: string;
    publishMode?: string;
    ownerUserId: string;
  }
): Promise<TaskRecord | null> {
  // Verify page ownership if facebookPageId is provided
  if (params.facebookPageId && params.facebookPageId.trim()) {
    const page = await getFacebookPageByFbId(db, params.facebookPageId.trim(), params.ownerUserId);
    if (!page) {
      throw new Error("Bạn không có quyền truy cập Fanpage được chọn.");
    }
  }

  const res = await db
    .prepare(
      `INSERT INTO tasks (
        profile_id, facebook_page_id, video_path, caption, link_ac, comment_text,
        schedule_date, schedule_time, status, publish_mode, owner_user_id, created_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .bind(
      params.profileId ? params.profileId.trim() : null,
      params.facebookPageId ? params.facebookPageId.trim() : null,
      params.videoPath.trim(),
      (params.caption || "").trim(),
      (params.commentText || "").trim(),
      (params.scheduleDate || "").trim(),
      (params.scheduleTime || "").trim(),
      params.publishMode || "now",
      params.ownerUserId,
      nowIsoSql()
    )
    .run();

  const lastId = Number(res.meta?.last_row_id || 0);
  if (lastId > 0) {
    return getTask(db, lastId, params.ownerUserId);
  }
  const latest = await getTasks(db, { ownerUserId: params.ownerUserId });
  return latest[0] || null;
}

export async function updateTask(
  db: D1Database,
  taskId: number,
  updates: {
    facebookPageId?: string | null;
    profileId?: string | null;
    videoPath?: string | null;
    caption?: string | null;
    commentText?: string | null;
    scheduleDate?: string | null;
    scheduleTime?: string | null;
    publishMode?: string | null;
  },
  ownerUserId: string
): Promise<TaskRecord | null> {
  const current = await getTask(db, taskId, ownerUserId);
  if (!current) return null;

  const targetPageId =
    updates.facebookPageId !== undefined
      ? updates.facebookPageId
        ? updates.facebookPageId.trim()
        : null
      : current.facebook_page_id;

  if (targetPageId) {
    const page = await getFacebookPageByFbId(db, targetPageId, ownerUserId);
    if (!page) {
      throw new Error("Bạn không có quyền gán Fanpage này.");
    }
  }

  await db
    .prepare(
      `UPDATE tasks SET
        facebook_page_id = ?,
        profile_id = ?,
        video_path = ?,
        caption = ?,
        comment_text = ?,
        schedule_date = ?,
        schedule_time = ?,
        publish_mode = ?
      WHERE id = ? AND owner_user_id = ?`
    )
    .bind(
      targetPageId,
      updates.profileId !== undefined ? updates.profileId : current.profile_id,
      updates.videoPath ? updates.videoPath.trim() : current.video_path,
      updates.caption !== undefined && updates.caption !== null ? updates.caption : current.caption,
      updates.commentText !== undefined && updates.commentText !== null
        ? updates.commentText
        : current.comment_text,
      updates.scheduleDate !== undefined && updates.scheduleDate !== null
        ? updates.scheduleDate
        : current.schedule_date,
      updates.scheduleTime !== undefined && updates.scheduleTime !== null
        ? updates.scheduleTime
        : current.schedule_time,
      updates.publishMode || current.publish_mode,
      taskId,
      ownerUserId
    )
    .run();

  return getTask(db, taskId, ownerUserId);
}

export async function addTasksBulk(
  db: D1Database,
  params: {
    tasksList: Array<{
      video_path: string;
      caption?: string;
      comment_text?: string;
      schedule_date?: string;
      schedule_time?: string;
      facebook_page_id?: string | null;
      profile_id?: string | null;
      publish_mode?: string;
    }>;
    assignPageIds?: string[] | null;
    ownerUserId: string;
  }
): Promise<number> {
  if (!params.tasksList || params.tasksList.length === 0) return 0;

  // Filter assignPageIds to only pages owned by ownerUserId
  const userPages = await getFacebookPages(db, { ownerUserId: params.ownerUserId });
  const ownedPageIdSet = new Set(userPages.map((p) => p.facebook_page_id));

  const targetPages = (params.assignPageIds || [])
    .map((p) => String(p).trim())
    .filter((p) => ownedPageIdSet.has(p));

  const now = nowIsoSql();
  const stmts = [];

  for (let i = 0; i < params.tasksList.length; i++) {
    const item = params.tasksList[i];
    const videoPath = String(item.video_path || "").trim();
    if (!videoPath) continue;

    let pageId: string | null = null;
    if (targetPages.length > 0) {
      pageId = targetPages[i % targetPages.length];
    } else if (item.facebook_page_id && ownedPageIdSet.has(String(item.facebook_page_id).trim())) {
      pageId = String(item.facebook_page_id).trim();
    }

    const scheduleDate = String(item.schedule_date || "").trim();
    const scheduleTime = String(item.schedule_time || "").trim();
    const publishMode =
      item.publish_mode || (scheduleDate || scheduleTime ? "scheduled" : "now");

    stmts.push(
      db
        .prepare(
          `INSERT INTO tasks (
            profile_id, facebook_page_id, video_path, caption, link_ac, comment_text,
            schedule_date, schedule_time, status, publish_mode, owner_user_id, created_at
          ) VALUES (?, ?, ?, ?, '', ?, ?, ?, 'pending', ?, ?, ?)`
        )
        .bind(
          item.profile_id ? String(item.profile_id).trim() : null,
          pageId,
          videoPath,
          String(item.caption || "").trim(),
          String(item.comment_text || "").trim(),
          scheduleDate,
          scheduleTime,
          publishMode,
          params.ownerUserId,
          now
        )
    );
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
  return stmts.length;
}

export async function deleteTask(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM tasks WHERE id = ? AND owner_user_id = ?")
    .bind(taskId, ownerUserId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

export async function resetTask(
  db: D1Database,
  taskId: number,
  ownerUserId: string
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE tasks SET
        status = 'pending',
        log = NULL,
        video_url = NULL,
        meta_video_id = NULL,
        meta_post_id = NULL,
        error_message = NULL,
        done_time = NULL
      WHERE id = ? AND owner_user_id = ?`
    )
    .bind(taskId, ownerUserId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

export async function resetRunningTasks(
  db: D1Database,
  ownerUserId: string
): Promise<number> {
  const res = await db
    .prepare(
      "UPDATE tasks SET status = 'pending', log = 'Đã dừng khẩn cấp' WHERE status = 'running' AND owner_user_id = ?"
    )
    .bind(ownerUserId)
    .run();
  return res.meta?.changes || 0;
}

export async function updateTaskStatus(
  db: D1Database,
  taskId: number,
  ownerUserId: string,
  update: {
    status: string;
    log?: string | null;
    videoUrl?: string | null;
    metaVideoId?: string | null;
    metaPostId?: string | null;
    errorMessage?: string | null;
    doneTime?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE tasks SET
        status = ?,
        log = COALESCE(?, log),
        video_url = COALESCE(?, video_url),
        meta_video_id = COALESCE(?, meta_video_id),
        meta_post_id = COALESCE(?, meta_post_id),
        error_message = COALESCE(?, error_message),
        done_time = COALESCE(?, done_time)
      WHERE id = ? AND owner_user_id = ?`
    )
    .bind(
      update.status,
      update.log ?? null,
      update.videoUrl ?? null,
      update.metaVideoId ?? null,
      update.metaPostId ?? null,
      update.errorMessage ?? null,
      update.doneTime ?? null,
      taskId,
      ownerUserId
    )
    .run();
}

export async function getPendingTasks(
  db: D1Database,
  options: {
    facebookPageIds?: string[] | null;
    taskIds?: number[] | null;
    ownerUserId: string;
  }
): Promise<TaskRecord[]> {
  let query = `
    SELECT
      t.id,
      t.profile_id,
      t.facebook_page_id,
      p.name AS page_name,
      t.video_path,
      t.caption,
      t.link_ac,
      t.comment_text,
      t.schedule_date,
      t.schedule_time,
      t.status,
      t.video_url,
      t.meta_video_id,
      t.meta_post_id,
      t.publish_mode,
      t.error_message,
      t.log,
      t.done_time,
      t.owner_user_id,
      t.created_at
    FROM tasks t
    LEFT JOIN facebook_pages p
      ON t.facebook_page_id = p.facebook_page_id AND p.owner_user_id = t.owner_user_id
    WHERE t.status = 'pending' AND t.owner_user_id = ?
  `;
  const binds: unknown[] = [options.ownerUserId];

  if (options.taskIds && options.taskIds.length > 0) {
    const placeholders = options.taskIds.map(() => "?").join(",");
    query += ` AND t.id IN (${placeholders})`;
    binds.push(...options.taskIds);
  } else if (options.facebookPageIds && options.facebookPageIds.length > 0) {
    const cleanPids = options.facebookPageIds.map((id) => id.trim()).filter(Boolean);
    if (cleanPids.length > 0) {
      const placeholders = cleanPids.map(() => "?").join(",");
      query += ` AND t.facebook_page_id IN (${placeholders})`;
      binds.push(...cleanPids);
    }
  }

  query += " ORDER BY t.id ASC";
  const res = await db
    .prepare(query)
    .bind(...binds)
    .all<TaskRecord>();
  return res.results || [];
}

// ==========================================
// 6. UPLOADED VIDEOS STORAGE (R2 / D1)
// ==========================================

export interface UploadedVideoRecord {
  id: string;
  owner_user_id: string;
  filename: string;
  mime_type: string;
  file_size: number;
  r2_key: string | null;
  data_base64: string | null;
  created_at: string;
}

export async function saveUploadedVideo(
  db: D1Database,
  params: {
    id: string;
    ownerUserId: string;
    filename: string;
    mimeType: string;
    fileSize: number;
    r2Key?: string | null;
    dataBase64?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO uploaded_videos (id, owner_user_id, filename, mime_type, file_size, r2_key, data_base64, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.ownerUserId,
      params.filename,
      params.mimeType || "video/mp4",
      params.fileSize,
      params.r2Key || null,
      params.dataBase64 || null,
      nowIsoSql()
    )
    .run();
}

export async function getUploadedVideo(
  db: D1Database,
  videoId: string,
  ownerUserId?: string
): Promise<UploadedVideoRecord | null> {
  if (ownerUserId) {
    return db
      .prepare(
        "SELECT * FROM uploaded_videos WHERE id = ? AND owner_user_id = ? LIMIT 1"
      )
      .bind(videoId.trim(), ownerUserId)
      .first<UploadedVideoRecord>();
  }
  return db
    .prepare("SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1")
    .bind(videoId.trim())
    .first<UploadedVideoRecord>();
}
