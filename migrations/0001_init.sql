-- ============================================================================
-- CLOUDFLARE D1 DATABASE MIGRATION: 0001_init.sql
-- Project: Quản lý fanpage & Facebook Reels Scheduler (Meta Graph API v19.0)
-- Domain : https://pagefb.namnangno.click
-- App ID : 1469615908436980
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. Bảng users: Quản lý tài khoản người dùng hệ thống (Multi-tenant isolation)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    full_name TEXT,
    email TEXT,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Khởi tạo tài khoản Quản trị viên mặc định: admin / admin123
INSERT OR IGNORE INTO users (id, username, password_hash, salt, full_name, email, role, status, created_at)
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
);

-- 2. Bảng oauth_states: Lưu trạng thái CSRF OAuth 2.0 phía server (Stateless Worker safe)
CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT,
    action TEXT DEFAULT 'connect',
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_user ON oauth_states(user_id);

-- 3. Bảng facebook_accounts: Lưu các tài khoản Facebook cá nhân (Admin Accounts) kết nối qua OAuth
CREATE TABLE IF NOT EXISTS facebook_accounts (
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
);

CREATE INDEX IF NOT EXISTS idx_fa_userid ON facebook_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_fa_owner ON facebook_accounts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fa_status ON facebook_accounts(status);

-- 4. Bảng facebook_pages: Lưu thông tin Fanpage đồng bộ từ /me/accounts
CREATE TABLE IF NOT EXISTS facebook_pages (
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
);

CREATE INDEX IF NOT EXISTS idx_pages_fbpid ON facebook_pages(facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_pages_owner ON facebook_pages(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_pages_selected ON facebook_pages(is_selected);

-- 5. Bảng facebook_account_pages: Quan hệ Nhiều-Nhiều (Admin Account <-> Fanpage) và phân quyền Page theo User
CREATE TABLE IF NOT EXISTS facebook_account_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    facebook_page_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    encrypted_page_access_token TEXT NOT NULL,
    tasks TEXT,
    can_post INTEGER DEFAULT 1,
    token_status TEXT DEFAULT 'valid',
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, facebook_page_id)
);

CREATE INDEX IF NOT EXISTS idx_fap_account ON facebook_account_pages(account_id);
CREATE INDEX IF NOT EXISTS idx_fap_page ON facebook_account_pages(facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_fap_owner ON facebook_account_pages(owner_user_id);

-- View user_page_permissions: Ánh xạ chuẩn quyền truy cập Fanpage của từng User hệ thống
CREATE VIEW IF NOT EXISTS user_page_permissions AS
SELECT
    fap.id AS permission_id,
    fa.owner_user_id AS user_id,
    fap.account_id AS facebook_account_id,
    fa.user_id AS facebook_user_id,
    fa.user_name AS facebook_user_name,
    fap.facebook_page_id,
    fap.tasks AS permissions_json,
    fap.can_post,
    fap.token_status,
    fap.synced_at
FROM facebook_account_pages fap
JOIN facebook_accounts fa ON fap.account_id = fa.id;

-- 6. Bảng tasks: Lịch đăng và hàng đợi xuất bản Facebook Reels
CREATE TABLE IF NOT EXISTS tasks (
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
);

CREATE INDEX IF NOT EXISTS idx_tasks_page ON tasks(facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- 7. Bảng uploaded_videos: Lưu trữ metadata / binary chunk tạm thời khi upload file từ trình duyệt
CREATE TABLE IF NOT EXISTS uploaded_videos (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT DEFAULT 'video/mp4',
    file_size INTEGER NOT NULL,
    r2_key TEXT,
    data_base64 TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_uploaded_videos_owner ON uploaded_videos(owner_user_id);

-- 8. Bảng profiles: Giữ tương thích ngược cấu trúc cũ
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user_agent TEXT,
    screen_resolution TEXT,
    status TEXT DEFAULT 'idle',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

