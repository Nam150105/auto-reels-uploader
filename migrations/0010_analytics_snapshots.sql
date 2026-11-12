-- Stored analytics (one snapshot per user and date range), refreshed by the cron worker every 3 hours.
-- The Worker also creates this table at runtime (ensureAnalyticsSnapshotsTable), so applying this file is optional.
CREATE TABLE IF NOT EXISTS analytics_snapshots (
    owner_user_id TEXT NOT NULL,
    range_days INTEGER NOT NULL,
    payload TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, range_days)
);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_synced ON analytics_snapshots (synced_at);
