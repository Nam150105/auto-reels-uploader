-- ============================================================================
-- MIGRATION 0012: TASK VERSIONS, ANALYTICS NEXT SYNC INTERVALS & INDEXES
-- 1. Bảng task_versions: theo dõi phiên bản dữ liệu bài đăng, phục vụ polling rẻ (1 dòng)
-- 2. Indexes cho analytics_next_sync_at và task_comments
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_versions (
  owner_user_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Index tối ưu kiểm tra cập nhật bài theo người dùng
CREATE INDEX IF NOT EXISTS idx_tasks_owner_updated ON tasks(owner_user_id, updated_at);

-- Index tối ưu Cron quét bài Reels đến hạn đồng bộ Insights
CREATE INDEX IF NOT EXISTS idx_tasks_analytics_due ON tasks(status, analytics_next_sync_at);

-- Index tối ưu kiểm tra comment bị treo
CREATE INDEX IF NOT EXISTS idx_task_comments_stuck ON task_comments (status, updated_at);

-- Triggers tự động tăng version khi có thay đổi bài đăng
CREATE TRIGGER IF NOT EXISTS trg_tasks_version_ins AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_versions (owner_user_id, version, updated_at)
  VALUES (NEW.owner_user_id, 1, CAST(strftime('%s', 'now') AS INTEGER))
  ON CONFLICT(owner_user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_version_del AFTER DELETE ON tasks
BEGIN
  INSERT INTO task_versions (owner_user_id, version, updated_at)
  VALUES (OLD.owner_user_id, 1, CAST(strftime('%s', 'now') AS INTEGER))
  ON CONFLICT(owner_user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_version_upd AFTER UPDATE ON tasks
WHEN NEW.status IS NOT OLD.status
  OR NEW.comment_status IS NOT OLD.comment_status
  OR NEW.caption IS NOT OLD.caption
  OR NEW.scheduled_at IS NOT OLD.scheduled_at
  OR NEW.is_locked IS NOT OLD.is_locked
BEGIN
  INSERT INTO task_versions (owner_user_id, version, updated_at)
  VALUES (NEW.owner_user_id, 1, CAST(strftime('%s', 'now') AS INTEGER))
  ON CONFLICT(owner_user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_task_comments_version_ins AFTER INSERT ON task_comments
BEGIN
  INSERT INTO task_versions (owner_user_id, version, updated_at)
  VALUES (NEW.owner_user_id, 1, CAST(strftime('%s', 'now') AS INTEGER))
  ON CONFLICT(owner_user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_task_comments_version_upd AFTER UPDATE ON task_comments
BEGIN
  INSERT INTO task_versions (owner_user_id, version, updated_at)
  VALUES (NEW.owner_user_id, 1, CAST(strftime('%s', 'now') AS INTEGER))
  ON CONFLICT(owner_user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_task_comments_version_del AFTER DELETE ON task_comments
BEGIN
  INSERT INTO task_versions (owner_user_id, version, updated_at)
  VALUES (OLD.owner_user_id, 1, CAST(strftime('%s', 'now') AS INTEGER))
  ON CONFLICT(owner_user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at;
END;
