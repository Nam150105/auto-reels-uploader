-- ============================================================================
-- MIGRATION 0004: TỰ ĐỘNG BÌNH LUẬN SAU KHI ĐĂNG REELS
-- ============================================================================

-- Thêm các cột lưu trữ dữ liệu bình luận tự động trên bài viết Reels Facebook
ALTER TABLE tasks ADD COLUMN comment_id TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN comment_status TEXT DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN comment_log TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN comment_posted_at TEXT;

