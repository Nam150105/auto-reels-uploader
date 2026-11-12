/**
 * Admin area (/api/admin/*): who uses the CMS, user management, sessions and the API catalog.
 * Only users with role = 'admin' can call these endpoints.
 *
 * Passwords are stored as one-way hashes (PBKDF2), so nobody, admin included, can read them back.
 * The admin sets a new password instead. Facebook tokens are never returned either.
 */

import type { D1Database, SessionRecord, UserRecord } from "../types.ts";
import { createUser, getUserByUsername } from "../db.ts";
import { hashPassword, verifyPassword } from "../utils/crypto.ts";
import { jsonResponse } from "./responseHelpers.ts";
import { API_CATALOG } from "../shared/apiCatalog.ts";

/** A session that made a request within this window counts as "online" */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
/** last_seen_at is written at most once per minute per session */
const TOUCH_INTERVAL_MS = 60 * 1000;
const ROLES = new Set(["admin", "member"]);

let activityColumnsReady = false;

export async function ensureSessionActivityColumns(db: D1Database): Promise<void> {
  if (activityColumnsReady) return;
  try {
    const info = await db.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
    const cols = new Set((info.results || []).map((c) => c.name));
    if (!cols.has("last_seen_at")) {
      try { await db.exec("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER"); } catch {}
    }
    if (!cols.has("last_ip")) {
      try { await db.exec("ALTER TABLE sessions ADD COLUMN last_ip TEXT"); } catch {}
    }
    activityColumnsReady = true;
  } catch {
    // Not fatal: activity tracking simply stays off until the next try
  }
}

/** Records that this session is active (cheap: no write when touched in the last minute). */
export async function touchSession(db: D1Database, sessionId: string, ip: string | null): Promise<void> {
  await ensureSessionActivityColumns(db);
  const now = Date.now();
  await db
    .prepare(
      `UPDATE sessions SET last_seen_at = ?, last_ip = ?
       WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`
    )
    .bind(now, ip, sessionId, now - TOUCH_INTERVAL_MS)
    .run();
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function countActiveAdmins(db: D1Database, excludeUserId?: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
    .bind(excludeUserId || "")
    .first<{ n: number }>();
  return Number(row?.n || 0);
}

async function revokeUserSessions(db: D1Database, userId: string, keepSessionId?: string | null): Promise<number> {
  const res = await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?")
    .bind(new Date().toISOString(), userId, keepSessionId || "")
    .run();
  return Number(res.meta?.changes || 0);
}

/** Deletes a user and every row they own (any table with owner_user_id or user_id). */
async function deleteUserCascade(db: D1Database, userId: string): Promise<void> {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'users'")
    .all<{ name: string }>();
  const statements = [];
  for (const { name } of tables.results || []) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    const info = await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
    const cols = new Set((info.results || []).map((c) => c.name));
    if (cols.has("owner_user_id")) {
      statements.push(db.prepare(`DELETE FROM ${name} WHERE owner_user_id = ?`).bind(userId));
    } else if (cols.has("user_id")) {
      statements.push(db.prepare(`DELETE FROM ${name} WHERE user_id = ?`).bind(userId));
    }
  }
  statements.push(db.prepare("DELETE FROM users WHERE id = ?").bind(userId));
  await db.batch(statements);
}

function generatePassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json().catch(() => ({}))) as T;
}

/** POST /api/auth/change-password: any logged-in user changes their own password. */
export async function handleChangeOwnPassword(
  request: Request,
  db: D1Database,
  currentUser: UserRecord,
  currentSession: SessionRecord | null
): Promise<Response> {
  const body = await readJson<{ current_password?: string; new_password?: string }>(request);
  const newPassword = String(body.new_password || "");
  if (newPassword.length < 6) {
    return jsonResponse({ detail: "New password must be at least 6 characters." }, 400);
  }
  const row = await getUserByUsername(db, currentUser.username);
  if (!row?.password_hash || !(await verifyPassword(String(body.current_password || ""), row.password_hash))) {
    return jsonResponse({ detail: "Current password is incorrect." }, 400);
  }
  await db
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .bind(await hashPassword(newPassword), new Date().toISOString(), currentUser.id)
    .run();
  // Sign out other devices, keep this one
  const revoked = await revokeUserSessions(db, currentUser.id, currentSession?.id);
  return jsonResponse({ success: true, revoked_sessions: revoked, message: "Password changed." });
}

export async function handleAdminRoutes(
  request: Request,
  url: URL,
  db: D1Database,
  currentUser: UserRecord,
  currentSession: SessionRecord | null
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/admin/") && pathname !== "/api/admin") return null;
  if (currentUser.role !== "admin") {
    return jsonResponse({ detail: "Admin access only." }, 403);
  }
  await ensureSessionActivityColumns(db);
  const method = request.method.toUpperCase();
  const onlineSince = Date.now() - ONLINE_WINDOW_MS;

  // ---- Overview ----
  if (pathname === "/api/admin/overview" && method === "GET") {
    const [counts, tasksByStatus, online] = await db.batch([
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM users) AS users,
             (SELECT COUNT(*) FROM users WHERE is_active = 1) AS active_users,
             (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,
             (SELECT COUNT(DISTINCT user_id) FROM sessions
                WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at >= ?) AS online_users,
             (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?) AS active_sessions,
             (SELECT COUNT(*) FROM facebook_accounts) AS facebook_accounts,
             (SELECT COUNT(*) FROM facebook_pages) AS pages,
             (SELECT COUNT(*) FROM tasks) AS tasks`
        )
        .bind(nowSec(), onlineSince, nowSec()),
      db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status"),
      db
        .prepare(
          `SELECT s.id AS session_id, s.user_id, u.username, u.full_name, u.role,
                  s.last_seen_at, COALESCE(s.last_ip, s.ip_address) AS ip_address, s.user_agent
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at >= ?
           ORDER BY s.last_seen_at DESC LIMIT 100`
        )
        .bind(nowSec(), onlineSince)
    ]);
    return jsonResponse({
      counts: counts.results?.[0] || {},
      tasks_by_status: Object.fromEntries((tasksByStatus.results || []).map((r: any) => [r.status, Number(r.n)])),
      online_sessions: online.results || [],
      online_window_minutes: ONLINE_WINDOW_MS / 60000
    });
  }

  // ---- API catalog ----
  if (pathname === "/api/admin/api-catalog" && method === "GET") {
    return jsonResponse({ endpoints: API_CATALOG });
  }

  // ---- Users ----
  if (pathname === "/api/admin/users" && method === "GET") {
    const rows = await db
      .prepare(
        `SELECT u.id, u.username, u.email, u.full_name, u.role, u.is_active, u.created_at, u.updated_at,
           (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
           (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login_at,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at >= ?) AS online_sessions,
           (SELECT COUNT(*) FROM facebook_accounts fa WHERE fa.owner_user_id = u.id) AS facebook_accounts,
           (SELECT COUNT(*) FROM facebook_pages fp WHERE fp.owner_user_id = u.id) AS pages,
           (SELECT COUNT(*) FROM tasks t WHERE t.owner_user_id = u.id) AS tasks
         FROM users u
         ORDER BY COALESCE(last_seen_at, 0) DESC, u.created_at DESC`
      )
      .bind(nowSec(), nowSec(), onlineSince)
      .all();
    const users = (rows.results || []).map((r: any) => ({ ...r, is_active: !!r.is_active, online: Number(r.online_sessions) > 0 }));
    return jsonResponse({ users });
  }

  if (pathname === "/api/admin/users" && method === "POST") {
    const body = await readJson<{ username?: string; password?: string; full_name?: string; email?: string; role?: string }>(request);
    const role = ROLES.has(String(body.role)) ? String(body.role) : "member";
    const password = String(body.password || "") || generatePassword();
    const res = await createUser(db, body.username || "", password, body.full_name || null, body.email || null, role);
    if (!res.success || !res.user) {
      return jsonResponse({ detail: res.message || "Could not create the user." }, 400);
    }
    // The password is returned once so the admin can hand it over; only its hash is stored
    return jsonResponse({ success: true, user: res.user, password: body.password ? undefined : password }, 201);
  }

  const userMatch = /^\/api\/admin\/users\/([^/]+)(?:\/(password|revoke-sessions))?$/.exec(pathname);
  if (userMatch) {
    const userId = decodeURIComponent(userMatch[1]);
    const action = userMatch[2] || "";
    const target = await db
      .prepare("SELECT id, username, email, full_name, role, is_active, created_at, updated_at FROM users WHERE id = ?")
      .bind(userId)
      .first<UserRecord>();
    if (!target) return jsonResponse({ detail: "User not found." }, 404);
    const isSelf = target.id === currentUser.id;

    if (!action && method === "GET") {
      const [accounts, pages, sessions, tasks] = await db.batch([
        db
          .prepare(
            `SELECT fa.id, fa.facebook_user_id, fa.facebook_user_name, fa.facebook_user_email, fa.status, fa.token_status,
                    fa.token_expires_at, fa.connected_at, fa.last_synced_at, fa.last_error, fa.scopes, fa.missing_scopes,
                    (SELECT COUNT(*) FROM facebook_account_pages fap WHERE fap.facebook_account_id = fa.id) AS pages
             FROM facebook_accounts fa WHERE fa.owner_user_id = ? ORDER BY fa.created_at DESC`
          )
          .bind(userId),
        db
          .prepare(
            `SELECT fp.facebook_page_id, fp.page_name, fp.category, fp.avatar_url, fp.status, fp.token_status,
                    fp.can_post, fp.is_selected, fp.last_synced_at,
                    (SELECT COUNT(*) FROM tasks t WHERE t.owner_user_id = fp.owner_user_id AND t.facebook_page_id = fp.facebook_page_id) AS tasks
             FROM facebook_pages fp WHERE fp.owner_user_id = ? ORDER BY fp.page_name COLLATE NOCASE`
          )
          .bind(userId),
        db
          .prepare(
            `SELECT id, ip_address, last_ip, user_agent, created_at, last_seen_at, expires_at, revoked_at
             FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
          )
          .bind(userId),
        db.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE owner_user_id = ? GROUP BY status").bind(userId)
      ]);
      const parseList = (v: unknown) => {
        try { return JSON.parse(String(v || "[]")); } catch { return []; }
      };
      const now = nowSec();
      return jsonResponse({
        user: { ...target, is_active: !!target.is_active },
        facebook_accounts: (accounts.results || []).map((a: any) => ({
          ...a,
          scopes: parseList(a.scopes),
          missing_scopes: parseList(a.missing_scopes)
        })),
        pages: (pages.results || []).map((p: any) => ({ ...p, can_post: !!p.can_post, is_selected: !!p.is_selected })),
        sessions: (sessions.results || []).map((s: any) => ({
          ...s,
          active: !s.revoked_at && Number(s.expires_at) > now,
          online: !s.revoked_at && Number(s.expires_at) > now && Number(s.last_seen_at || 0) >= onlineSince,
          is_current: s.id === currentSession?.id
        })),
        tasks_by_status: Object.fromEntries((tasks.results || []).map((r: any) => [r.status, Number(r.n)]))
      });
    }

    if (!action && method === "PUT") {
      const body = await readJson<{ full_name?: string; email?: string; role?: string; is_active?: boolean; username?: string }>(request);
      const role = body.role !== undefined ? String(body.role) : target.role;
      if (!ROLES.has(role)) return jsonResponse({ detail: "Role must be admin or member." }, 400);
      const isActive = body.is_active !== undefined ? !!body.is_active : !!target.is_active;
      const losesAdmin = target.role === "admin" && target.is_active && (role !== "admin" || !isActive);
      if (losesAdmin && isSelf) {
        return jsonResponse({ detail: "You cannot remove your own admin access or lock your own account." }, 400);
      }
      if (losesAdmin && (await countActiveAdmins(db, target.id)) === 0) {
        return jsonResponse({ detail: "At least one active admin account is required." }, 400);
      }
      let username = target.username;
      if (body.username !== undefined) {
        username = String(body.username).trim().toLowerCase();
        if (username.length < 3 || !/^[a-z0-9_.\-@]+$/.test(username)) {
          return jsonResponse({ detail: "Username must be at least 3 characters (letters, numbers, _ . - @)." }, 400);
        }
        const other = await getUserByUsername(db, username);
        if (other && other.id !== target.id) return jsonResponse({ detail: "This username is already taken." }, 400);
      }
      await db
        .prepare("UPDATE users SET username = ?, full_name = ?, email = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?")
        .bind(
          username,
          body.full_name !== undefined ? String(body.full_name).trim() || username : target.full_name,
          body.email !== undefined ? String(body.email).trim() || null : target.email ?? null,
          role,
          isActive ? 1 : 0,
          new Date().toISOString(),
          target.id
        )
        .run();
      if (!isActive) await revokeUserSessions(db, target.id);
      return jsonResponse({ success: true });
    }

    if (!action && method === "DELETE") {
      if (isSelf) return jsonResponse({ detail: "You cannot delete your own account." }, 400);
      if (target.role === "admin" && target.is_active && (await countActiveAdmins(db, target.id)) === 0) {
        return jsonResponse({ detail: "At least one active admin account is required." }, 400);
      }
      await deleteUserCascade(db, target.id);
      return jsonResponse({ success: true });
    }

    if (action === "password" && method === "POST") {
      const body = await readJson<{ password?: string }>(request);
      const password = String(body.password || "") || generatePassword();
      if (password.length < 6) return jsonResponse({ detail: "Password must be at least 6 characters." }, 400);
      await db
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .bind(await hashPassword(password), new Date().toISOString(), target.id)
        .run();
      // Old password no longer works anywhere: sign the user out (keep the admin's own current session)
      const revoked = await revokeUserSessions(db, target.id, isSelf ? currentSession?.id : null);
      return jsonResponse({ success: true, password: body.password ? undefined : password, revoked_sessions: revoked });
    }

    if (action === "revoke-sessions" && method === "POST") {
      const revoked = await revokeUserSessions(db, target.id, isSelf ? currentSession?.id : null);
      return jsonResponse({ success: true, revoked_sessions: revoked });
    }
  }

  // ---- Sessions ----
  if (pathname === "/api/admin/sessions" && method === "GET") {
    const scope = url.searchParams.get("scope") || "active";
    const where =
      scope === "online"
        ? "WHERE s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at >= ?"
        : scope === "all"
          ? "WHERE ? > 0 AND ? > 0"
          : "WHERE s.revoked_at IS NULL AND s.expires_at > ? AND ? > 0";
    const rows = await db
      .prepare(
        `SELECT s.id, s.user_id, u.username, u.full_name, u.role, s.ip_address, s.last_ip, s.user_agent,
                s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         ${where}
         ORDER BY COALESCE(s.last_seen_at, 0) DESC, s.created_at DESC
         LIMIT 300`
      )
      .bind(nowSec(), onlineSince)
      .all();
    const now = nowSec();
    return jsonResponse({
      sessions: (rows.results || []).map((s: any) => ({
        ...s,
        active: !s.revoked_at && Number(s.expires_at) > now,
        online: !s.revoked_at && Number(s.expires_at) > now && Number(s.last_seen_at || 0) >= onlineSince,
        is_current: s.id === currentSession?.id
      }))
    });
  }

  const sessionRevokeMatch = /^\/api\/admin\/sessions\/([^/]+)\/revoke$/.exec(pathname);
  if (sessionRevokeMatch && method === "POST") {
    const sessionId = decodeURIComponent(sessionRevokeMatch[1]);
    if (sessionId === currentSession?.id) {
      return jsonResponse({ detail: "Use Log out to end your own current session." }, 400);
    }
    const res = await db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(new Date().toISOString(), sessionId)
      .run();
    return jsonResponse({ success: true, revoked: Number(res.meta?.changes || 0) > 0 });
  }

  return jsonResponse({ detail: `API endpoint not found: ${pathname}` }, 404);
}
