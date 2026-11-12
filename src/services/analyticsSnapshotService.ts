/**
 * Stored analytics snapshots (D1).
 *
 * - The CMS only reads the latest snapshot from D1 (no Facebook call on page load).
 * - A cron worker refreshes every snapshot that is 3 hours old or older.
 * - "Làm mới dữ liệu" syncs right away; the stored time resets, so the next
 *   automatic sync for that snapshot happens 3 hours after the manual one.
 *
 * One row per (owner_user_id, range_days).
 */

import type { D1Database, Env } from "../types.ts";
import { getLiveAnalyticsDashboard, type LiveAnalyticsDashboard } from "./liveInsightsService.ts";

export const ANALYTICS_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Range always kept fresh for every user who has Pages (the CMS default) */
export const DEFAULT_RANGE_DAYS = 28;
/** Snapshots refreshed per cron run (keeps each run within Worker subrequest limits) */
const MAX_SYNCS_PER_RUN = 5;

export interface StoredAnalyticsDashboard extends LiveAnalyticsDashboard {
  synced_at: string;
  next_sync_at: string;
}

let tableReady = false;

export async function ensureAnalyticsSnapshotsTable(db: D1Database): Promise<void> {
  if (tableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS analytics_snapshots (
         owner_user_id TEXT NOT NULL,
         range_days INTEGER NOT NULL,
         payload TEXT NOT NULL,
         synced_at INTEGER NOT NULL,
         last_error TEXT,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (owner_user_id, range_days)
       )`
    )
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_synced ON analytics_snapshots (synced_at)")
    .run();
  tableReady = true;
}

export function normalizeRangeDays(days: unknown): number {
  const n = Math.floor(Number(days) || DEFAULT_RANGE_DAYS);
  return Math.min(90, Math.max(7, n));
}

function toStored(payload: LiveAnalyticsDashboard, syncedAtMs: number): StoredAnalyticsDashboard {
  return {
    ...payload,
    cached: true,
    synced_at: new Date(syncedAtMs).toISOString(),
    next_sync_at: new Date(syncedAtMs + ANALYTICS_SYNC_INTERVAL_MS).toISOString()
  };
}

/** Latest stored snapshot, or null when this range was never synced. */
export async function getStoredAnalytics(
  db: D1Database,
  ownerUserId: string,
  days: number
): Promise<StoredAnalyticsDashboard | null> {
  await ensureAnalyticsSnapshotsTable(db);
  const row = await db
    .prepare("SELECT payload, synced_at FROM analytics_snapshots WHERE owner_user_id = ? AND range_days = ? LIMIT 1")
    .bind(ownerUserId, days)
    .first<{ payload: string; synced_at: number }>();
  if (!row) return null;
  try {
    return toStored(JSON.parse(row.payload) as LiveAnalyticsDashboard, Number(row.synced_at));
  } catch {
    return null;
  }
}

/** Reads Facebook now, stores the result and returns it. */
export async function syncAndStoreAnalytics(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  days: number,
  encryptionKey: string
): Promise<StoredAnalyticsDashboard> {
  await ensureAnalyticsSnapshotsTable(db);
  const data = await getLiveAnalyticsDashboard(db, env, ownerUserId, { days, refresh: true, encryptionKey });
  const syncedAtMs = Date.now();
  const payload: LiveAnalyticsDashboard = { ...data, cached: false, fetched_at: new Date(syncedAtMs).toISOString() };
  await db
    .prepare(
      `INSERT INTO analytics_snapshots (owner_user_id, range_days, payload, synced_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT (owner_user_id, range_days) DO UPDATE SET
         payload = excluded.payload,
         synced_at = excluded.synced_at,
         last_error = NULL,
         updated_at = excluded.updated_at`
    )
    .bind(ownerUserId, days, JSON.stringify(payload), syncedAtMs, new Date(syncedAtMs).toISOString())
    .run();
  return { ...toStored(payload, syncedAtMs), cached: false };
}

/** Pushes a failed snapshot back in the queue so one bad account cannot block the others every run. */
async function recordSyncFailure(db: D1Database, ownerUserId: string, days: number, message: string): Promise<void> {
  const nowMs = Date.now();
  // Retry in ~30 minutes instead of 3 hours
  const retryBase = nowMs - ANALYTICS_SYNC_INTERVAL_MS + 30 * 60 * 1000;
  await db
    .prepare(
      `UPDATE analytics_snapshots SET synced_at = MIN(synced_at, ?), last_error = ?, updated_at = ?
       WHERE owner_user_id = ? AND range_days = ?`
    )
    .bind(retryBase, message.slice(0, 500), new Date(nowMs).toISOString(), ownerUserId, days)
    .run();
}

/**
 * Cron job: refreshes snapshots that are 3 hours old or older, and creates the default
 * snapshot for users who have Pages but were never synced.
 */
export async function syncDueAnalytics(
  db: D1Database,
  env: Env,
  encryptionKey: string
): Promise<{ synced: number; failed: number }> {
  await ensureAnalyticsSnapshotsTable(db);
  const nowMs = Date.now();

  const jobs: Array<{ owner_user_id: string; range_days: number }> = [];

  const neverSynced = await db
    .prepare(
      `SELECT DISTINCT fp.owner_user_id AS owner_user_id
       FROM facebook_pages fp
       WHERE NOT EXISTS (
         SELECT 1 FROM analytics_snapshots s
         WHERE s.owner_user_id = fp.owner_user_id AND s.range_days = ?
       )
       LIMIT ?`
    )
    .bind(DEFAULT_RANGE_DAYS, MAX_SYNCS_PER_RUN)
    .all<{ owner_user_id: string }>();
  for (const r of neverSynced.results || []) {
    jobs.push({ owner_user_id: r.owner_user_id, range_days: DEFAULT_RANGE_DAYS });
  }

  if (jobs.length < MAX_SYNCS_PER_RUN) {
    const due = await db
      .prepare(
        `SELECT owner_user_id, range_days FROM analytics_snapshots
         WHERE synced_at <= ?
         ORDER BY synced_at ASC
         LIMIT ?`
      )
      .bind(nowMs - ANALYTICS_SYNC_INTERVAL_MS, MAX_SYNCS_PER_RUN - jobs.length)
      .all<{ owner_user_id: string; range_days: number }>();
    jobs.push(...(due.results || []));
  }

  let synced = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await syncAndStoreAnalytics(db, env, job.owner_user_id, Number(job.range_days), encryptionKey);
      synced++;
    } catch (err: any) {
      failed++;
      await recordSyncFailure(db, job.owner_user_id, Number(job.range_days), String(err?.message || err)).catch(() => {});
    }
  }
  return { synced, failed };
}
