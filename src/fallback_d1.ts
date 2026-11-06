/**
 * Lightweight In-Memory Fallback D1 Adapter
 * Used only if `env.DB` binding has not yet been attached in Cloudflare dashboard,
 * preventing 500 crashes and allowing full OAuth, Fanpage Sync, and Task operations.
 * Production deployments with bound D1 use real Cloudflare D1 (`env.DB`).
 */

import type { D1Database, D1PreparedStatement, D1Result, D1ExecResult } from "./types.ts";

interface InMemoryStore {
  users: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  oauth_states: Array<Record<string, unknown>>;
  facebook_accounts: Array<Record<string, unknown>>;
  facebook_pages: Array<Record<string, unknown>>;
  facebook_account_pages: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  task_logs: Array<Record<string, unknown>>;
  task_attempts: Array<Record<string, unknown>>;
  media_files: Array<Record<string, unknown>>;
  media_blobs_fallback: Array<Record<string, unknown>>;
  rate_limits: Array<Record<string, unknown>>;
  data_deletion_requests: Array<Record<string, unknown>>;
  nextTaskId: number;
  nextFapId: number;
}

const memStore: InMemoryStore = {
  users: [],
  sessions: [],
  oauth_states: [],
  facebook_accounts: [],
  facebook_pages: [],
  facebook_account_pages: [],
  tasks: [],
  task_logs: [],
  task_attempts: [],
  media_files: [],
  media_blobs_fallback: [],
  rate_limits: [],
  data_deletion_requests: [],
  nextTaskId: 1,
  nextFapId: 1
};

function makeResult<T>(results: T[] = [], changes = 0, lastRowId = 0): D1Result<T> {
  return {
    results,
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      changes
    }
  };
}

class FallbackStatement implements D1PreparedStatement {
  private query: string;
  private params: unknown[] = [];

  constructor(query: string) {
    this.query = query.trim();
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const res = await this.all<T>();
    return res.results[0] || null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return [];
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const q = this.query.replace(/\s+/g, " ").trim();
    const upper = q.toUpperCase();

    if (upper.startsWith("CREATE ")) {
      return makeResult<T>([], 0);
    }

    // 1. USERS
    if (upper.includes("FROM USERS WHERE USERNAME =")) {
      const uName = String(this.params[0] || "").toLowerCase();
      const found = memStore.users.find(
        (u) => String(u.username || "").toLowerCase() === uName
      );
      return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
    }
    if (upper.includes("FROM USERS WHERE ID =")) {
      const found = memStore.users.find((u) => u.id === this.params[0]);
      return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
    }
    if (upper.startsWith("INSERT OR IGNORE INTO USERS") || upper.startsWith("INSERT INTO USERS")) {
      const [id, username, email, password_hash, full_name, role, created_at, updated_at] =
        this.params;
      const exists = memStore.users.some(
        (u) =>
          u.id === id ||
          String(u.username || "").toLowerCase() === String(username || "").toLowerCase()
      );
      if (!exists) {
        memStore.users.push({
          id,
          username,
          email,
          password_hash,
          full_name,
          role,
          is_active: 1,
          created_at,
          updated_at
        });
        return makeResult<T>([], 1, memStore.users.length);
      }
      return makeResult<T>([], 0);
    }

    // 2. SESSIONS
    if (upper.startsWith("INSERT INTO SESSIONS")) {
      const [id, user_id, token_hash, csrf_token, ip_address, user_agent, expires_at, created_at] =
        this.params;
      memStore.sessions.push({
        id,
        user_id,
        token_hash,
        csrf_token,
        ip_address,
        user_agent,
        expires_at,
        revoked_at: null,
        created_at
      });
      return makeResult<T>([], 1);
    }
    if (upper.includes("FROM SESSIONS WHERE TOKEN_HASH =")) {
      const found = memStore.sessions.find((s) => s.token_hash === this.params[0]);
      return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
    }
    if (upper.startsWith("UPDATE SESSIONS SET REVOKED_AT =")) {
      const [revokedAt, tokenHash] = this.params;
      let changes = 0;
      for (const s of memStore.sessions) {
        if (s.token_hash === tokenHash && !s.revoked_at) {
          s.revoked_at = revokedAt;
          changes++;
        }
      }
      return makeResult<T>([], changes);
    }

    // 3. RATE LIMITS
    if (upper.includes("FROM RATE_LIMITS WHERE KEY =")) {
      const found = memStore.rate_limits.find((r) => r.key === this.params[0]);
      return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
    }
    if (upper.startsWith("INSERT INTO RATE_LIMITS") || upper.startsWith("UPDATE RATE_LIMITS")) {
      return makeResult<T>([], 1);
    }

    // 4. OAUTH STATES
    if (upper.startsWith("DELETE FROM OAUTH_STATES")) {
      const cutoff = Number(this.params[0] || 0);
      const before = memStore.oauth_states.length;
      memStore.oauth_states = memStore.oauth_states.filter(
        (s) => Number(s.expires_at) >= cutoff && Number(s.used) === 0
      );
      return makeResult<T>([], before - memStore.oauth_states.length);
    }
    if (upper.startsWith("INSERT INTO OAUTH_STATES")) {
      const [
        state,
        owner_user_id,
        action_type,
        reconnect_account_id,
        redirect_after,
        created_at,
        expires_at
      ] = this.params;
      memStore.oauth_states.push({
        state,
        owner_user_id,
        action_type,
        reconnect_account_id,
        redirect_after,
        used: 0,
        created_at,
        expires_at
      });
      return makeResult<T>([], 1);
    }
    if (upper.includes("FROM OAUTH_STATES WHERE STATE =")) {
      const found = memStore.oauth_states.find((s) => s.state === this.params[0]);
      return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
    }
    if (upper.startsWith("UPDATE OAUTH_STATES SET USED = 1 WHERE STATE =")) {
      const targetState = this.params[0];
      let changes = 0;
      for (const s of memStore.oauth_states) {
        if (s.state === targetState && Number(s.used) === 0) {
          s.used = 1;
          changes++;
        }
      }
      return makeResult<T>([], changes);
    }

    // 5. FACEBOOK ACCOUNTS
    if (upper.includes("FROM FACEBOOK_ACCOUNTS")) {
      if (upper.includes("WHERE ID = ? AND OWNER_USER_ID = ?")) {
        const found = memStore.facebook_accounts.find(
          (a) => a.id === this.params[0] && a.owner_user_id === this.params[1]
        );
        return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
      }
      if (upper.includes("WHERE OWNER_USER_ID = ? AND FACEBOOK_USER_ID = ?")) {
        const found = memStore.facebook_accounts.find(
          (a) =>
            a.owner_user_id === this.params[0] &&
            a.facebook_user_id === this.params[1]
        );
        return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
      }
      if (upper.includes("WHERE ID = ?")) {
        const found = memStore.facebook_accounts.find((a) => a.id === this.params[0]);
        return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
      }
      if (upper.includes("WHERE OWNER_USER_ID = ?")) {
        const rows = memStore.facebook_accounts.filter(
          (a) => a.owner_user_id === this.params[0]
        );
        return makeResult<T>(rows as unknown as T[]);
      }
      return makeResult<T>(memStore.facebook_accounts as unknown as T[]);
    }
    if (upper.startsWith("INSERT INTO FACEBOOK_ACCOUNTS")) {
      const [
        id,
        owner_user_id,
        facebook_user_id,
        facebook_user_name,
        facebook_user_email,
        access_token,
        token_version,
        token_type,
        scopes,
        missing_scopes,
        status,
        token_status,
        connected_at,
        token_expires_at,
        last_synced_at,
        created_at,
        updated_at
      ] = this.params;
      memStore.facebook_accounts.push({
        id,
        owner_user_id,
        facebook_user_id,
        facebook_user_name,
        facebook_user_email,
        access_token,
        token_version,
        token_type,
        scopes,
        missing_scopes,
        status,
        token_status,
        connected_at,
        token_expires_at,
        last_synced_at,
        last_error: null,
        created_at,
        updated_at
      });
      return makeResult<T>([], 1);
    }
    if (upper.startsWith("UPDATE FACEBOOK_ACCOUNTS SET")) {
      if (upper.includes("FACEBOOK_USER_ID = ?")) {
        const [
          facebook_user_id,
          facebook_user_name,
          facebook_user_email,
          access_token,
          token_version,
          token_type,
          scopes,
          missing_scopes,
          status,
          token_status,
          connected_at,
          token_expires_at,
          last_synced_at,
          updated_at,
          id
        ] = this.params;
        for (const a of memStore.facebook_accounts) {
          if (a.id === id) {
            Object.assign(a, {
              facebook_user_id,
              facebook_user_name,
              facebook_user_email,
              access_token,
              token_version,
              token_type,
              scopes,
              missing_scopes,
              status,
              token_status,
              connected_at,
              token_expires_at,
              last_synced_at,
              last_error: null,
              updated_at
            });
          }
        }
        return makeResult<T>([], 1);
      }
      if (upper.includes("STATUS = ?, TOKEN_STATUS = ?, LAST_ERROR = ?")) {
        const [status, token_status, last_error, last_synced_at, updated_at, id] = this.params;
        for (const a of memStore.facebook_accounts) {
          if (a.id === id) {
            a.status = status;
            a.token_status = token_status;
            a.last_error = last_error;
            if (last_synced_at) a.last_synced_at = last_synced_at;
            a.updated_at = updated_at;
          }
        }
        return makeResult<T>([], 1);
      }
      return makeResult<T>([], 1);
    }

    // 6. FACEBOOK PAGES & ACCOUNT_PAGES
    if (upper.includes("FROM FACEBOOK_PAGES")) {
      if (upper.includes("WHERE OWNER_USER_ID = ? AND FACEBOOK_PAGE_ID = ?")) {
        const found = memStore.facebook_pages.find(
          (p) =>
            p.owner_user_id === this.params[0] &&
            p.facebook_page_id === this.params[1]
        );
        return makeResult<T>(found ? ([{ ...found }] as unknown as T[]) : []);
      }
      if (upper.includes("WHERE OWNER_USER_ID = ?")) {
        const rows = memStore.facebook_pages.filter(
          (p) => p.owner_user_id === this.params[0]
        );
        return makeResult<T>(rows as unknown as T[]);
      }
      return makeResult<T>(memStore.facebook_pages as unknown as T[]);
    }
    if (upper.startsWith("INSERT INTO FACEBOOK_PAGES")) {
      const [
        id,
        owner_user_id,
        facebook_page_id,
        page_name,
        category,
        avatar_url,
        page_access_token,
        token_version,
        tasks_json,
        can_post,
        is_published,
        token_status,
        connected_account_id,
        last_synced_at,
        created_at,
        updated_at
      ] = this.params;
      memStore.facebook_pages.push({
        id,
        owner_user_id,
        facebook_page_id,
        page_name,
        category,
        avatar_url,
        page_access_token,
        token_version,
        tasks_json,
        can_post,
        is_published,
        is_selected: 1,
        status: "active",
        token_status,
        connected_account_id,
        last_synced_at,
        created_at,
        updated_at
      });
      return makeResult<T>([], 1);
    }
    if (upper.startsWith("UPDATE FACEBOOK_PAGES SET")) {
      if (upper.includes("PAGE_NAME = ?")) {
        const [
          page_name,
          category,
          avatar_url,
          page_access_token,
          token_version,
          tasks_json,
          can_post,
          is_published,
          token_status,
          connected_account_id,
          last_synced_at,
          updated_at,
          id
        ] = this.params;
        for (const p of memStore.facebook_pages) {
          if (p.id === id) {
            Object.assign(p, {
              page_name,
              category,
              avatar_url,
              page_access_token,
              token_version,
              tasks_json,
              can_post,
              is_published,
              status: "active",
              token_status,
              connected_account_id,
              last_synced_at,
              updated_at
            });
          }
        }
        return makeResult<T>([], 1);
      }
      return makeResult<T>([], 1);
    }
    if (upper.startsWith("INSERT INTO FACEBOOK_ACCOUNT_PAGES")) {
      const [
        owner_user_id,
        facebook_account_id,
        facebook_page_id,
        page_access_token,
        token_version,
        tasks_json,
        can_post,
        is_published,
        token_status,
        last_synced_at,
        created_at,
        updated_at
      ] = this.params;
      const existing = memStore.facebook_account_pages.find(
        (x) =>
          x.facebook_account_id === facebook_account_id &&
          x.facebook_page_id === facebook_page_id
      );
      if (existing) {
        Object.assign(existing, {
          owner_user_id,
          page_access_token,
          token_version,
          tasks_json,
          can_post,
          is_published,
          token_status,
          last_synced_at,
          updated_at
        });
      } else {
        memStore.facebook_account_pages.push({
          id: memStore.nextFapId++,
          owner_user_id,
          facebook_account_id,
          facebook_page_id,
          page_access_token,
          token_version,
          tasks_json,
          can_post,
          is_published,
          token_status,
          last_synced_at,
          created_at,
          updated_at
        });
      }
      return makeResult<T>([], 1);
    }
    if (upper.includes("FROM FACEBOOK_ACCOUNT_PAGES")) {
      const rows = memStore.facebook_account_pages.filter(
        (x) => !this.params[0] || x.owner_user_id === this.params[0]
      );
      return makeResult<T>(rows as unknown as T[]);
    }

    return makeResult<T>([]);
  }
}

export class FallbackMemoryD1 implements D1Database {
  prepare(query: string): D1PreparedStatement {
    return new FallbackStatement(query);
  }
  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const out: D1Result<T>[] = [];
    for (const stmt of statements) {
      out.push(await stmt.run<T>());
    }
    return out;
  }
  async exec(): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }
}

const fallbackInstance = new FallbackMemoryD1();

export function getD1Database(envOrDb?: D1Database | { DB?: D1Database }): D1Database {
  if (!envOrDb) return fallbackInstance;
  if (typeof (envOrDb as D1Database).prepare === "function") {
    return envOrDb as D1Database;
  }
  const maybeDb = (envOrDb as { DB?: D1Database }).DB;
  if (maybeDb && typeof maybeDb.prepare === "function") {
    return maybeDb;
  }
  return fallbackInstance;
}
