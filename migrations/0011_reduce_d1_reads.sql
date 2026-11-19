-- Giảm số dòng D1 phải đọc: cron mỗi phút tìm comment đến hạn trước đây quét toàn bộ bảng tasks
CREATE INDEX IF NOT EXISTS idx_tasks_comment_due ON tasks(comment_status, comment_due_at);
