-- Multiple auto-comments per published post (text and/or image), each with its own delay.
-- The Worker also creates this table at runtime (ensureTaskCommentsTable), so applying this file is optional.
CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    owner_user_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    image_media_id TEXT,
    delay_minutes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    due_at INTEGER,
    comment_id TEXT,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    posted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id, position);
CREATE INDEX IF NOT EXISTS idx_task_comments_due ON task_comments (status, due_at);
