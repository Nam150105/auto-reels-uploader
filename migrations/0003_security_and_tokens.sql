-- ============================================================================
-- MIGRATION 0003: SECURITY VIEWS, TOKEN METADATA & DEFAULT ADMIN ACCOUNT
-- ============================================================================

-- View tổng hợp quyền sở hữu & kết nối giữa User - Facebook Account - Fanpage
CREATE VIEW IF NOT EXISTS user_page_permissions AS
SELECT
    fap.id AS link_id,
    COALESCE(fap.owner_user_id, fa.owner_user_id, fp.owner_user_id) AS owner_user_id,
    fa.id AS account_id,
    fa.facebook_user_id,
    fa.facebook_user_name,
    fa.status AS account_status,
    fa.token_status AS account_token_status,
    fa.token_expires_at,
    fp.id AS internal_page_id,
    fap.facebook_page_id,
    fp.page_name,
    fp.category,
    fp.avatar_url,
    fap.tasks_json,
    fap.can_post,
    fap.is_published,
    fap.token_status AS page_token_status,
    fap.last_synced_at
FROM facebook_account_pages fap
JOIN facebook_accounts fa ON fa.id = fap.facebook_account_id
LEFT JOIN facebook_pages fp
  ON fp.facebook_page_id = fap.facebook_page_id
  AND COALESCE(fp.owner_user_id, '') = COALESCE(fa.owner_user_id, '');

-- Bảng metadata theo dõi phiên bản khóa mã hóa Token (hỗ trợ Key Rotation an toàn)
CREATE TABLE IF NOT EXISTS security_key_metadata (
    key_version TEXT PRIMARY KEY,
    algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    rotated_at TEXT
);

INSERT OR IGNORE INTO security_key_metadata (key_version, algorithm, is_current, created_at)
VALUES ('v2', 'AES-256-GCM', 1, '2026-11-06T00:00:00Z');
