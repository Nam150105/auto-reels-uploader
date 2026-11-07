-- ============================================================================
-- Migration 0008: Facebook Page Manager - Posts, Sync States, Comments & Audit Logs
-- - Quản lý tập trung toàn bộ bài viết: Reels, Video, Ảnh, Album, Status, Link
-- - Phân biệt nguồn gốc: 'app_published' vs 'facebook_external'
-- - Quản lý tiến trình Cursor Pagination đồng bộ lịch sử bài viết từng Fanpage
-- - Quản lý bình luận, phân cấp reply, ẩn/xóa bình luận và audit trail
-- ============================================================================

-- 1. Bảng facebook_posts: Kho lưu trữ tập trung toàn bộ bài viết từ Fanpage
CREATE TABLE IF NOT EXISTS facebook_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  video_id TEXT,
  message TEXT DEFAULT '',
  post_type TEXT NOT NULL DEFAULT 'status', -- 'reel' | 'video' | 'photo' | 'album' | 'link' | 'status'
  status_type TEXT DEFAULT '',
  permalink_url TEXT DEFAULT '',
  thumbnail_url TEXT DEFAULT '',
  media_url TEXT DEFAULT '',
  attachments_json TEXT DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'facebook_external', -- 'app_published' | 'facebook_external' | 'unknown'
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
);

CREATE INDEX IF NOT EXISTS idx_fb_posts_owner_page
  ON facebook_posts(owner_user_id, page_id, created_time DESC);

CREATE INDEX IF NOT EXISTS idx_fb_posts_type
  ON facebook_posts(owner_user_id, post_type, created_time DESC);

CREATE INDEX IF NOT EXISTS idx_fb_posts_source
  ON facebook_posts(owner_user_id, source, created_time DESC);

CREATE INDEX IF NOT EXISTS idx_fb_posts_task
  ON facebook_posts(task_id);

CREATE INDEX IF NOT EXISTS idx_fb_posts_post_id
  ON facebook_posts(post_id);

-- 2. Bảng facebook_page_sync_states: Theo dõi trạng thái & con trỏ (Cursor Pagination) đồng bộ từng Page
CREATE TABLE IF NOT EXISTS facebook_page_sync_states (
  page_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'syncing' | 'completed' | 'partial' | 'failed'
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
);

-- 3. Bảng facebook_post_comments: Quản lý và cache bình luận bài viết
CREATE TABLE IF NOT EXISTS facebook_post_comments (
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
);

CREATE INDEX IF NOT EXISTS idx_fb_comments_post
  ON facebook_post_comments(post_id, created_time DESC);

CREATE INDEX IF NOT EXISTS idx_fb_comments_parent
  ON facebook_post_comments(parent_id);

-- 4. Bảng facebook_post_audit_logs: Truy vết lịch sử chỉnh sửa, xóa và tương tác bài viết
CREATE TABLE IF NOT EXISTS facebook_post_audit_logs (
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
);

CREATE INDEX IF NOT EXISTS idx_fb_post_audit_post
  ON facebook_post_audit_logs(post_id, id DESC);

