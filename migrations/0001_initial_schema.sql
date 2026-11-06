-- ============================================================================
-- MIGRATION 0001: INITIAL SCHEMA FOR CLOUDFLARE D1 (auto-reels-db)
-- Hệ thống: Quản lý Facebook Fanpage & Hẹn Lịch Đăng Reels (Multi-User)
-- Domain  : https://pagefb.namnangno.click
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. Bảng người dùng hệ thống (Multi-Tenant Isolation)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

-- 2. Bảng phiên đăng nhập phía Server (Hỗ trợ thu hồi session, Logout thực sự & CSRF)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    expires_at INTEGER NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 3. Bảng lưu CSRF State cho Meta OAuth 2.0 (One-time state, an toàn đa người dùng đồng thời)
CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    action_type TEXT NOT NULL DEFAULT 'connect',
    reconnect_account_id TEXT,
    redirect_after TEXT DEFAULT '/pages',
    used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 4. Bảng tài khoản Facebook Admin cá nhân (Hỗ trợ kết nối nhiều tài khoản Facebook / 1 User)
CREATE TABLE IF NOT EXISTS facebook_accounts (
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
    UNIQUE(owner_user_id, facebook_user_id),
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 5. Bảng danh sách Fanpage (Chống trùng lặp theo từng User: UNIQUE(owner_user_id, facebook_page_id))
CREATE TABLE IF NOT EXISTS facebook_pages (
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
    UNIQUE(owner_user_id, facebook_page_id),
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (connected_account_id) REFERENCES facebook_accounts (id) ON DELETE SET NULL
);

-- 6. Bảng trung gian N-N liên kết Tài khoản Facebook Admin và Fanpage
CREATE TABLE IF NOT EXISTS facebook_account_pages (
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
    UNIQUE(facebook_account_id, facebook_page_id),
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts (id) ON DELETE CASCADE
);

-- 7. Bảng quản lý file Video lưu trữ trên Cloudflare R2 (Không lưu video binary trong D1)
CREATE TABLE IF NOT EXISTS media_files (
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
    UNIQUE(owner_user_id, object_key),
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 8. Bảng kế thừa Profiles (Bảo toàn dữ liệu lịch sử từ hệ thống cũ)
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    name TEXT NOT NULL,
    facebook_page_name TEXT,
    facebook_page_id TEXT,
    status TEXT DEFAULT 'idle',
    notes TEXT,
    created_at TEXT
);

-- 9. Bảng tác vụ đăng và hẹn lịch Reels (Hỗ trợ Queue, Lease Lock, Idempotency & Cron UTC)
CREATE TABLE IF NOT EXISTS tasks (
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
    created_at TEXT,
    updated_at TEXT,
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files (id) ON DELETE SET NULL
);

-- 10. Bảng lịch sử các lần thử thực thi Task (Task Attempts Audit)
CREATE TABLE IF NOT EXISTS task_attempts (
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
    finished_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 11. Bảng chi tiết từng giai đoạn xử lý Task (Task Stage Logs)
CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    owner_user_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'INFO',
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 12. Bảng theo dõi yêu cầu xóa dữ liệu người dùng theo chuẩn Meta Compliance
CREATE TABLE IF NOT EXISTS data_deletion_requests (
    confirmation_code TEXT PRIMARY KEY,
    facebook_user_id TEXT,
    owner_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    deleted_summary TEXT NOT NULL DEFAULT '{}',
    requested_at TEXT NOT NULL,
    completed_at TEXT
);

-- 13. Bảng giới hạn tần suất (Rate Limiting cho Login/Register & API nhạy cảm)
CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);

