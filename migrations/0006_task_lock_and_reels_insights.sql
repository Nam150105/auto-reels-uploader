-- Migration 0006: Task Post-Publish Lock, Read Insights Permission & Reels Insights History
-- Compatible with existing production data (non-destructive)

-- 1. Bổ sung các cột khóa Task & trạng thái Analytics độc lập vào bảng tasks
ALTER TABLE tasks ADD COLUMN publish_status TEXT DEFAULT 'pending';
ALTER TABLE tasks ADD COLUMN is_locked INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN analytics_status TEXT DEFAULT 'not_synced';
ALTER TABLE tasks ADD COLUMN analytics_last_synced_at TEXT;
ALTER TABLE tasks ADD COLUMN analytics_error TEXT DEFAULT '';

-- Đồng bộ trạng thái khóa cho các task đã đăng thành công trước đó
UPDATE tasks
SET publish_status = status,
    is_locked = CASE WHEN status = 'success' OR (video_id != '' AND post_id != '') THEN 1 ELSE 0 END
WHERE publish_status IS NULL OR publish_status = 'pending';

-- 2. Bổ sung cột kiểm tra quyền read_insights và ANALYZE cho tài khoản & Fanpage
ALTER TABLE facebook_accounts ADD COLUMN has_read_insights INTEGER DEFAULT 0;
ALTER TABLE facebook_accounts ADD COLUMN last_token_checked_at TEXT;
ALTER TABLE facebook_pages ADD COLUMN can_analyze INTEGER DEFAULT 0;
ALTER TABLE facebook_account_pages ADD COLUMN can_analyze INTEGER DEFAULT 0;

-- 3. Bảng lưu lịch sử Snapshot thống kê Reels theo từng chu kỳ đồng bộ (D1 History)
CREATE TABLE IF NOT EXISTS reel_insight_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  facebook_page_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  post_id TEXT DEFAULT '',
  sync_date TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'success',
  views INTEGER,
  plays INTEGER,
  initial_plays INTEGER,
  replays INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  total_interactions INTEGER,
  total_watch_time_ms INTEGER,
  avg_watch_time_ms INTEGER,
  video_length_sec REAL,
  retention_json TEXT DEFAULT '[]',
  raw_metrics_json TEXT DEFAULT '{}',
  error_code INTEGER,
  error_message TEXT DEFAULT '',
  UNIQUE(task_id, sync_date)
);

-- 4. Bảng lưu chi tiết từng Metric của từng Reels từ Meta Graph API v27.0
CREATE TABLE IF NOT EXISTS reel_insight_metric_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  facebook_page_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  post_id TEXT DEFAULT '',
  metric_name TEXT NOT NULL,
  metric_value REAL,
  metric_json TEXT DEFAULT '',
  period TEXT DEFAULT 'lifetime',
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'supported',
  error_message TEXT DEFAULT '',
  UNIQUE(task_id, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_reel_snapshots_owner_page
  ON reel_insight_snapshots(owner_user_id, facebook_page_id, sync_date);

CREATE INDEX IF NOT EXISTS idx_reel_snapshots_task
  ON reel_insight_snapshots(task_id, sync_date);

CREATE INDEX IF NOT EXISTS idx_reel_metrics_owner_task
  ON reel_insight_metric_items(owner_user_id, task_id);

