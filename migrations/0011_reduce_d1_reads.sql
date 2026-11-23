-- Giảm số dòng D1 phải đọc.
-- Index idx_tasks_comment_due ON tasks(comment_status, comment_due_at) được Worker tự tạo khi khởi động
-- (src/db.ts, ensureDatabaseInitialized) vì cột comment_due_at cũng do Worker tự thêm lúc chạy:
-- tạo ở đây sẽ làm migration lỗi trên CSDL mới chưa có cột này.
SELECT 1;
