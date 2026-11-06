/**
 * Lightweight In-Memory Fallback D1 Adapter
 * Used only if `env.DB` binding has not yet been attached in Cloudflare dashboard,
 * preventing 500 crashes and allowing immediate UI inspection.
 * Production deployments use real Cloudflare D1 (`env.DB`).
 */

import type { D1Database, D1PreparedStatement, D1Result, D1ExecResult } from "./types.ts";

interface InMemoryStore {
  users: Array<Record<string, unknown>>;
  oauth_states: Array<Record<string, unknown>>;
  facebook_accounts: Array<Record<string, unknown>>;
  facebook_pages: Array<Record<string, unknown>>;
  facebook_account_pages: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  uploaded_videos: Array<Record<string, unknown>>;
  nextTaskId: number;
  nextFapId: number;
}

const memStore: InMemoryStore = {
  users: [
    {
      id: "usr_admin",
      username: "admin",
      password_hash: "4a3de7d8f973dcf4eacb1efb73a5492c1fa4593b187d455291ebd75204bef509",
      salt: "7675b4edbf9cb8b1b2a3f4afcdd2dde1",
      full_name: "Quản Trị Viên",
      email: "admin@pagefb.namnangno.click",
      role: "admin",
      status: "active",
      created_at: "2026-11-06 00:00:00"
    }
  ],
  oauth_states: [],
  facebook_accounts: [],
  facebook_pages: [],
  facebook_account_pages: [],
  tasks: [],
  uploaded_videos: [],
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

    if (upper.startsWith("CREATE ") || upper.startsWith("INSERT OR IGNORE INTO USERS")) {
      return makeResult<T>([], 0);
    }

    // USERS
    if (upper.includes("FROM USERS WHERE ID =")) {
      const found = memStore.users.find((u) => u.id === this.params[0]);
      return makeResult<T>(found ? ([found] as unknown as T[]) : []);
    }
    if (upper.includes("FROM USERS WHERE USERNAME =")) {
      const found = memStore.users.find((u) => u.username === this.params[0]);
      return makeResult<T>(found ? ([found] as unknown as T[]) : []);
    }
    if (upper.startsWith("INSERT INTO USERS")) {
      const [id, username, password_hash, salt, full_name, email, role, created_at] = this.params;
      memStore.users.push({
        id,
        username,
        password_hash,
        salt,
        full_name,
        email,
        role,
        status: "active",
        created_at
      });
      return makeResult<T>([], 1, memStore.users.length);
    }

    // OAUTH STATES
    if (upper.startsWith("DELETE FROM OAUTH_STATES WHERE EXPIRES_AT <")) {
      const cutoff = Number(this.params[0]);
      const before = memStore.oauth_states.length;
      memStore.oauth_states = memStore.oauth_states.filter((s) => Number(s.expires_at) >= cutoff);
      return makeResult<T>([], before - memStore.oauth_states.length);
    }
    if (upper.startsWith("INSERT INTO OAUTH_STATES")) {
      const [state, user_id, account_id, action, redirect_uri, expires_at, created_at] = this.params;
      memStore.oauth_states.push({
        state,
        user_id,
        account_id,
        action,
        redirect_uri,
        expires_at,
        created_at
      });
      return makeResult<T>([], 1);
    }
    if (upper.includes("FROM OAUTH_STATES WHERE STATE =")) {
      const found = memStore.oauth_states.find((s) => s.state === this.params[0]);
      return makeResult<T>(found ? ([found] as unknown as T[]) : []);
    }
    if (upper.startsWith("DELETE FROM OAUTH_STATES WHERE STATE =")) {
      const before = memStore.oauth_states.length;
      memStore.oauth_states = memStore.oauth_states.filter((s) => s.state !== this.params[0]);
      return makeResult<T>([], before - memStore.oauth_states.length);
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
