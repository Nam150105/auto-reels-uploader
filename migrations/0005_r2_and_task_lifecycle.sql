-- ============================================================================
-- MIGRATION 0005: XÁC MINH R2 STORAGE & VÒNG ĐỜI TÁC VỤ (R2 + PUBLISH + COMMENT)
-- ============================================================================

-- Bổ sung metadata xác minh R2 cho bảng media_files
ALTER TABLE media_files ADD COLUMN r2_bucket TEXT DEFAULT 'auto-reels-media';
ALTER TABLE media_files ADD COLUMN verified_at TEXT;
ALTER TABLE media_files ADD COLUMN storage_error TEXT DEFAULT '';

-- Bổ sung trạng thái lưu trữ R2 và mốc thời gian vòng đời tác vụ trong bảng tasks
ALTER TABLE tasks ADD COLUMN r2_status TEXT DEFAULT 'ready';
ALTER TABLE tasks ADD COLUMN uploaded_at TEXT;
ALTER TABLE tasks ADD COLUMN published_at TEXT;
ALTER TABLE tasks ADD COLUMN last_processed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_media_files_owner_filename
  ON media_files(owner_user_id, original_filename);

CREATE INDEX IF NOT EXISTS idx_tasks_media_id_status
  ON tasks(media_id, status);

