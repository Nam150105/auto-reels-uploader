-- ============================================================================
-- MIGRATION 0002: PERFORMANCE & CLOUDFLARE FREE-PLAN INDEXES
-- Tối ưu truy vấn theo user_id, facebook_page_id, status và scheduled_at
-- ============================================================================

-- Indexes cho bảng sessions & oauth_states
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_owner ON oauth_states(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

-- Indexes cho bảng facebook_accounts
CREATE INDEX IF NOT EXISTS idx_fb_accounts_owner ON facebook_accounts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fb_accounts_fb_uid ON facebook_accounts(facebook_user_id);
CREATE INDEX IF NOT EXISTS idx_fb_accounts_status ON facebook_accounts(owner_user_id, status);

-- Indexes cho bảng facebook_pages & facebook_account_pages
CREATE INDEX IF NOT EXISTS idx_fb_pages_owner ON facebook_pages(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fb_pages_page_id ON facebook_pages(facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_fb_pages_owner_selected ON facebook_pages(owner_user_id, is_selected);
CREATE INDEX IF NOT EXISTS idx_fb_acc_pages_owner ON facebook_account_pages(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fb_acc_pages_page_id ON facebook_account_pages(facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_fb_acc_pages_acc_id ON facebook_account_pages(facebook_account_id);

-- Indexes cho bảng media_files (Cloudflare R2 metadata)
CREATE INDEX IF NOT EXISTS idx_media_files_owner ON media_files(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_media_files_status ON media_files(owner_user_id, upload_status);
CREATE INDEX IF NOT EXISTS idx_media_files_object_key ON media_files(object_key);

-- Indexes cho bảng tasks (Tối ưu Cron Scheduler & Queue Consumer trên gói Free)
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_page_id ON tasks(facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_retry ON tasks(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tasks_media_id ON tasks(media_id);

-- Indexes cho bảng task_attempts & task_logs
CREATE INDEX IF NOT EXISTS idx_task_attempts_task_id ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
