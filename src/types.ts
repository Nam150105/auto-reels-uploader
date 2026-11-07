/**
 * Cloudflare Worker TypeScript Definitions (D1, R2, Queues, Cron, Env & Domain Models)
 * Production Domain : https://pagefb.namnangno.click
 * Meta App ID       : 1469615908436980
 */

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: {
    changes?: number;
    last_row_id?: number;
    duration?: number;
    rows_read?: number;
    rows_written?: number;
  };
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

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  sha256?: ArrayBuffer | string;
}

export interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob
  ): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  createMultipartUpload?(key: string, options?: R2PutOptions): Promise<R2MultipartUpload>;
  resumeMultipartUpload?(key: string, uploadId: string): R2MultipartUpload;
}

export interface QueueMessage<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface Queue<T = unknown> {
  send(message: T, options?: { contentType?: "json" | "text" | "bytes" | "v8"; delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Iterable<{ body: T; delaySeconds?: number }>): Promise<void>;
}

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ScheduledEvent {
  cron: string;
  type: string;
  scheduledTime: number;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface QueueTaskMessage {
  task_id: number;
  owner_user_id: string;
  idempotency_key: string;
  attempt: number;
  enqueued_at: number;
}

export interface Env {
  DB?: D1Database;
  MEDIA_BUCKET?: R2Bucket;
  auto_reels_media?: R2Bucket;
  VIDEOS_BUCKET?: R2Bucket;
  REELS_QUEUE?: Queue<QueueTaskMessage>;
  ASSETS?: Fetcher;

  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_REDIRECT_URI?: string;
  META_GRAPH_VERSION?: string;
  APP_BASE_URL?: string;

  SESSION_SECRET?: string;
  SECRET_KEY?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  ENCRYPTION_KEY?: string;
  MAX_VIDEO_SIZE_MB?: string;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string | null;
  password_hash?: string;
  full_name: string | null;
  role: string;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: number;
  revoked_at: string | null;
  created_at: string;
}

export interface FacebookAccountPageSummary {
  facebook_page_id: string;
  page_name: string;
  category: string;
  avatar_url: string;
  can_post: boolean;
  can_analyze?: boolean;
}

export interface FacebookAccountRecord {
  id: string;
  owner_user_id: string | null;
  facebook_user_id: string;
  user_id?: string;
  facebook_user_name: string | null;
  user_name?: string | null;
  facebook_user_email: string | null;
  avatar_url?: string | null;
  access_token?: string;
  token_version?: string;
  token_type: string;
  scopes: string[];
  missing_scopes: string[];
  has_read_insights?: boolean;
  status: string;
  token_status: string;
  connected_at: string | null;
  token_expires_at: string | null;
  expires_at?: string | null;
  last_synced_at: string | null;
  last_token_checked_at?: string | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
  page_count?: number;
  managed_pages_count?: number;
  postable_pages_count?: number;
  days_remaining?: number | null;
  is_expired?: boolean;
  pages?: FacebookAccountPageSummary[];
}

export interface AdminAccountLink {
  account_id: string;
  facebook_user_id: string;
  user_id?: string;
  facebook_user_name: string | null;
  user_name?: string | null;
  account_status: string;
  token_status: string;
  tasks: string[];
  can_post: boolean;
  can_analyze?: boolean;
  is_published: boolean;
  last_synced_at: string | null;
}

export interface FacebookPageRecord {
  id: string;
  owner_user_id: string | null;
  facebook_page_id: string;
  page_name: string;
  name: string;
  category: string;
  avatar_url: string;
  tasks: string[];
  can_post: boolean;
  can_analyze?: boolean;
  is_published: boolean;
  is_selected: boolean;
  status: string;
  token_status: string;
  connected_account_id: string | null;
  last_synced_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  pending_count: number;
  admin_accounts: AdminAccountLink[];
  admin_names: string[];
}

export interface MediaFileRecord {
  id: string;
  owner_user_id: string;
  object_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256_checksum: string | null;
  upload_status: string;
  r2_upload_id: string | null;
  storage_backend: string;
  r2_bucket?: string | null;
  verified_at?: string | null;
  storage_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRecord {
  id: number;
  owner_user_id: string | null;
  profile_id: string | null;
  facebook_page_id: string | null;
  media_id?: string | null;
  object_key?: string | null;
  r2_status?: string | null;
  video_path: string;
  caption: string;
  comment_text: string;
  schedule_date: string;
  schedule_time: string;
  scheduled_at?: number | null;
  original_scheduled_at?: number | null;
  original_schedule_date?: string | null;
  original_schedule_time?: string | null;
  manual_publish_requested_at?: string | null;
  manual_publish_by_user_id?: string | null;
  trigger_source?: string | null;
  needs_schedule?: boolean;
  is_future_schedule?: boolean;
  is_due_soon?: boolean;
  timezone?: string;
  status: string;
  raw_status?: string;
  publish_status?: string;
  is_locked?: boolean;
  idempotency_key?: string | null;
  attempt_count?: number;
  max_attempts?: number;
  next_retry_at?: number | null;
  locked_until?: number | null;
  lease_owner?: string | null;
  error_code?: number | null;
  error_subcode?: number | null;
  retryable?: number;
  log: string;
  video_id: string;
  post_id: string;
  video_url: string;
  comment_id?: string | null;
  comment_status?: string | null;
  comment_log?: string | null;
  comment_posted_at?: string | null;
  analytics_status?: string | null;
  analytics_last_synced_at?: string | null;
  analytics_error?: string | null;
  uploaded_at?: string | null;
  published_at?: string | null;
  last_processed_at?: string | null;
  created_at: string | null;
  updated_at: string | null;
  page_name?: string | null;
  page_avatar?: string | null;
  page_category?: string | null;
  profile_name?: string | null;
}

export interface ReelInsightSnapshotRecord {
  id: number;
  owner_user_id: string;
  task_id: number;
  facebook_page_id: string;
  video_id: string;
  post_id: string;
  sync_date: string;
  synced_at: string;
  sync_status: string;
  views: number | null;
  plays: number | null;
  initial_plays: number | null;
  replays: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  total_interactions: number | null;
  total_watch_time_ms: number | null;
  avg_watch_time_ms: number | null;
  video_length_sec: number | null;
  retention_json: string;
  raw_metrics_json: string;
  error_code: number | null;
  error_message: string;
}

export interface ReelInsightMetricItemRecord {
  id: number;
  owner_user_id: string;
  task_id: number;
  facebook_page_id: string;
  video_id: string;
  post_id: string;
  metric_name: string;
  metric_value: number | null;
  metric_json: string;
  period: string;
  fetched_at: string;
  status: "supported" | "unavailable" | "permission_required" | "no_data" | "retryable";
  error_message: string;
}

export interface TaskAuditLogRecord {
  id: number;
  task_id: number;
  owner_user_id: string;
  actor_user_id: string;
  action: string;
  previous_status: string;
  new_status: string;
  previous_scheduled_at: number | null;
  new_scheduled_at: number | null;
  trigger_source: string;
  detail_json: string;
  error_message: string;
  created_at: string;
}

export interface MetaApiTelemetryRecord {
  endpoint_key: string;
  total_requests: number;
  cache_hits: number;
  cache_misses: number;
  error_requests: number;
  rate_limited_requests: number;
  retry_count: number;
  last_status_code: number;
  app_usage_json: string;
  page_usage_json: string;
  buc_usage_json: string;
  throttle_level: "normal" | "elevated" | "high" | "rate_limited";
  updated_at: string;
}
