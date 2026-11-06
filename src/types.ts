/**
 * Cloudflare Worker Bindings & Domain Types
 * Domain: https://pagefb.namnangno.click
 * Meta App ID: 1469615908436980
 */

export interface D1Meta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
  error?: string;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface R2ObjectBody {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
  body: ReadableStream;
}

export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface Env {
  /** Cloudflare D1 Serverless SQLite Database */
  DB?: D1Database;
  /** Optional Cloudflare R2 Bucket for Video Reels staging */
  VIDEOS_BUCKET?: R2Bucket;
  /** Cloudflare Workers Static Assets Fetcher */
  ASSETS?: Fetcher;

  /** Public Environment Variables */
  META_APP_ID?: string;
  APP_BASE_URL?: string;
  META_REDIRECT_URI?: string;
  META_GRAPH_VERSION?: string;

  /** Cloudflare Secrets (Sensitive - configured via `wrangler secret put`) */
  META_APP_SECRET?: string;
  SECRET_KEY?: string;
  ENCRYPTION_KEY?: string;
}

export interface UserRecord {
  id: string;
  username: string;
  full_name: string;
  email: string;
  role: string;
  status: string;
  created_at?: string;
}

export interface FacebookAccountRecord {
  id: string;
  user_id: string;
  user_name: string;
  encrypted_user_access_token?: string;
  token_expires_at: string | null;
  scopes: string[];
  status: string;
  owner_user_id: string;
  avatar_url: string | null;
  connected_at: string;
  last_synced_at: string;
  managed_pages_count: number;
  postable_pages_count: number;
  days_remaining: number | null;
}

export interface AdminAccountLink {
  account_id: string;
  user_id: string;
  user_name: string;
  owner_user_id: string;
  avatar_url: string | null;
  account_status: string;
  can_post: number;
  token_status: string;
  synced_at: string;
}

export interface FacebookPageRecord {
  id: string;
  facebook_page_id: string;
  name: string;
  category: string | null;
  avatar_url: string | null;
  tasks: string;
  can_post: number;
  is_selected: number;
  status: string;
  token_status: string;
  owner_user_id: string;
  last_synced_at: string;
  created_at: string;
  pending_count: number;
  total_tasks: number;
  admin_accounts: AdminAccountLink[];
  admin_names: string;
}

export interface TaskRecord {
  id: number;
  profile_id: string | null;
  facebook_page_id: string | null;
  page_name: string | null;
  video_path: string;
  caption: string;
  link_ac: string;
  comment_text: string;
  schedule_date: string;
  schedule_time: string;
  status: string;
  video_url: string | null;
  meta_video_id: string | null;
  meta_post_id: string | null;
  publish_mode: string;
  error_message: string | null;
  log: string | null;
  done_time: string | null;
  owner_user_id: string;
  created_at: string;
}

