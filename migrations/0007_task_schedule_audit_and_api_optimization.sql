-- ============================================================================
-- Migration 0007: Task Schedule Enforcement, Publish-Now Audit Trail & Meta API Telemetry
-- - Lưu lịch gốc (original_scheduled_at, original_schedule_date, original_schedule_time) khi nhấn Đăng ngay hoặc Đổi lịch
-- - Ghi nhận người thực hiện, thời điểm và nguồn kích hoạt (manual_publish_now, bulk_publish_now, scheduled, retry)
-- - Bảng task_audit_logs lưu lịch sử & truy vết mọi thao tác quan trọng trên Task
-- - Bảng meta_api_telemetry theo dõi số lượng request Graph API, cache hit/miss và header X-App-Usage / X-Page-Usage
-- ============================================================================

-- 1. Bổ sung các cột truy vết lịch đăng và thao tác Đăng ngay trên bảng tasks
ALTER TABLE tasks ADD COLUMN original_scheduled_at INTEGER;
ALTER TABLE tasks ADD COLUMN original_schedule_date TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN original_schedule_time TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN manual_publish_requested_at TEXT;
ALTER TABLE tasks ADD COLUMN manual_publish_by_user_id TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN trigger_source TEXT DEFAULT 'scheduled';

-- Đảm bảo các task thất bại (status = 'failed') luôn được mở khóa để cho phép sửa, thử lại hoặc đăng ngay
UPDATE tasks
SET is_locked = 0
WHERE status = 'failed'
  AND (video_id IS NULL OR video_id = '' OR post_id IS NULL OR post_id = '');

-- 2. Tạo bảng task_audit_logs lưu lịch sử thao tác và truy vết (Mục 1.4 & Phần 8)
CREATE TABLE IF NOT EXISTS task_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  owner_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  old_scheduled_at INTEGER,
  new_scheduled_at INTEGER,
  old_schedule_text TEXT DEFAULT '',
  new_schedule_text TEXT DEFAULT '',
  old_status TEXT DEFAULT '',
  new_status TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_audit_logs_task
  ON task_audit_logs(task_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_task_audit_logs_owner
  ON task_audit_logs(owner_user_id, created_at DESC);

-- 3. Tạo bảng meta_api_telemetry theo dõi gọi API, Cache và Rate Limit (Phần 4.6 & Phần 10)
CREATE TABLE IF NOT EXISTS meta_api_telemetry (
  endpoint_key TEXT PRIMARY KEY,
  total_requests INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  cache_misses INTEGER NOT NULL DEFAULT 0,
  error_requests INTEGER NOT NULL DEFAULT 0,
  rate_limited_requests INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER DEFAULT 200,
  app_usage_json TEXT DEFAULT '{}',
  page_usage_json TEXT DEFAULT '{}',
  buc_usage_json TEXT DEFAULT '{}',
  throttle_level TEXT DEFAULT 'normal',
  updated_at TEXT NOT NULL
);

-- 4. Các Index tối ưu truy vấn D1 cho bộ lọc Task và Scheduler (Phần 5.3)
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_sched
  ON tasks(owner_user_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_tasks_owner_page_status
  ON tasks(owner_user_id, facebook_page_id, status);

