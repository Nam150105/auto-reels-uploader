/**
 * Stored analytics (D1).
 *
 * Hai khoảng thời gian:
 *  - 30 ngày gần nhất (range_days = 30): đọc từ Facebook khi đồng bộ, lưu nguyên bản vào analytics_snapshots.
 *  - Tất cả (range_days = 0): cộng dồn số liệu theo ngày đã lưu trong page_daily_insights.
 *
 * Mỗi lần đồng bộ (cron 6 tiếng/lần hoặc nút Làm mới):
 *  1. Lấy 30 ngày từ Facebook -> lưu snapshot 30 ngày.
 *  2. Ghi số liệu từng ngày của từng Fanpage vào page_daily_insights (ngày trùng thì ghi đè, chỉ ghi khi đổi).
 *     Lần đầu tiên (chưa có lịch sử) lấy lùi 90 ngày để có dữ liệu ban đầu.
 *  3. Tính sẵn bản "Tất cả" và lưu thành snapshot range_days = 0
 *     -> mở trang chỉ đọc 1 dòng, không cộng lại toàn bộ lịch sử mỗi lần xem.
 *
 * The CMS only reads stored snapshots (no Facebook call on page load).
 */

import type { D1Database, Env } from "../types.ts";
import {
  getLiveAnalyticsDashboard,
  type LiveAnalyticsDashboard,
  type LiveDailyPoint,
  type LivePageStats
} from "./liveInsightsService.ts";

export const ANALYTICS_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Khoảng đọc từ Facebook mỗi lần đồng bộ */
export const DEFAULT_RANGE_DAYS = 30;
/** Khoảng "Tất cả" (cộng dồn từ dữ liệu đã lưu) */
export const ALL_TIME_RANGE = 0;
/** Lần đồng bộ đầu tiên lấy lùi bao nhiêu ngày (giới hạn của Facebook ~90 ngày) */
const BACKFILL_DAYS = 90;
/** Snapshots refreshed per cron run (keeps each run within Worker subrequest limits) */
const MAX_SYNCS_PER_RUN = 5;

export interface StoredAnalyticsDashboard extends LiveAnalyticsDashboard {
  synced_at: string;
  next_sync_at: string;
}

let tableReady = false;

export async function ensureAnalyticsSnapshotsTable(db: D1Database): Promise<void> {
  if (tableReady) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS analytics_snapshots (
         owner_user_id TEXT NOT NULL,
         range_days INTEGER NOT NULL,
         payload TEXT NOT NULL,
         synced_at INTEGER NOT NULL,
         last_error TEXT,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (owner_user_id, range_days)
       )`
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_synced ON analytics_snapshots (synced_at)"),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS page_daily_insights (
         owner_user_id TEXT NOT NULL,
         page_id TEXT NOT NULL,
         date TEXT NOT NULL,
         views INTEGER,
         engagement INTEGER,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (owner_user_id, page_id, date)
       )`
    ),
    // Chỉ còn 2 khoảng: 30 ngày và Tất cả -> bỏ snapshot các khoảng cũ (7/28/90 ngày) để cron không đồng bộ thừa
    db.prepare(`DELETE FROM analytics_snapshots WHERE range_days NOT IN (${DEFAULT_RANGE_DAYS}, ${ALL_TIME_RANGE})`)
  ]);
  tableReady = true;
}

/** "all" (hoặc 0) -> Tất cả; mọi giá trị khác -> 30 ngày */
export function normalizeRangeDays(days: unknown): number {
  const raw = String(days ?? "").trim().toLowerCase();
  if (raw === "all" || raw === "0") return ALL_TIME_RANGE;
  return DEFAULT_RANGE_DAYS;
}

function toStored(payload: LiveAnalyticsDashboard, syncedAtMs: number): StoredAnalyticsDashboard {
  return {
    ...payload,
    cached: true,
    synced_at: new Date(syncedAtMs).toISOString(),
    next_sync_at: new Date(syncedAtMs + ANALYTICS_SYNC_INTERVAL_MS).toISOString()
  };
}

async function saveSnapshot(db: D1Database, ownerUserId: string, days: number, payload: LiveAnalyticsDashboard, syncedAtMs: number) {
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

/** Ghi số liệu từng ngày của từng Fanpage; chỉ ghi khi giá trị thay đổi (không tốn lượt ghi cho ngày cũ). */
async function storeDailyInsights(db: D1Database, ownerUserId: string, pages: LivePageStats[]): Promise<void> {
  const nowIso = new Date().toISOString();
  const statements = [];
  for (const page of pages) {
    for (const d of page.daily || []) {
      if (!d.date || (d.views === null && d.engagement === null)) continue;
      statements.push(
        db
          .prepare(
            `INSERT INTO page_daily_insights (owner_user_id, page_id, date, views, engagement, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner_user_id, page_id, date) DO UPDATE SET
               views = COALESCE(excluded.views, page_daily_insights.views),
               engagement = COALESCE(excluded.engagement, page_daily_insights.engagement),
               updated_at = excluded.updated_at
             WHERE excluded.views IS NOT page_daily_insights.views
                OR excluded.engagement IS NOT page_daily_insights.engagement`
          )
          .bind(ownerUserId, page.page_id, d.date, d.views, d.engagement, nowIso)
      );
    }
  }
  // D1 giới hạn số lệnh mỗi batch -> chia nhỏ
  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }
}

/**
 * Bản "Tất cả": cộng mọi ngày đã lưu cho từng Fanpage. Thông tin Page (tên, ảnh, người theo dõi,
 * lượt xem 7 ngày, trạng thái) lấy từ snapshot 30 ngày mới nhất.
 */
async function buildAllTimeDashboard(
  db: D1Database,
  ownerUserId: string,
  latest: LiveAnalyticsDashboard
): Promise<LiveAnalyticsDashboard> {
  const { results: rows } = await db
    .prepare("SELECT page_id, date, views, engagement FROM page_daily_insights WHERE owner_user_id = ? ORDER BY date ASC")
    .bind(ownerUserId)
    .all<{ page_id: string; date: string; views: number | null; engagement: number | null }>();

  // Số Reels đăng thành công qua công cụ, theo từng Page (đọc qua index owner/page/status)
  const { results: reelRows } = await db
    .prepare(
      `SELECT facebook_page_id AS page_id, COUNT(*) AS n FROM tasks
       WHERE owner_user_id = ? AND status IN ('success', 'published')
       GROUP BY facebook_page_id`
    )
    .bind(ownerUserId)
    .all<{ page_id: string; n: number }>();
  const reelsByPage = new Map((reelRows || []).map((r) => [String(r.page_id), Number(r.n)]));

  const byPage = new Map<string, LiveDailyPoint[]>();
  const byDate = new Map<string, { views: number; engagement: number; hasViews: boolean; hasEng: boolean }>();
  for (const r of rows || []) {
    const list = byPage.get(r.page_id) || [];
    list.push({ date: r.date, views: r.views, engagement: r.engagement });
    byPage.set(r.page_id, list);
    const agg = byDate.get(r.date) || { views: 0, engagement: 0, hasViews: false, hasEng: false };
    if (r.views !== null) { agg.views += Number(r.views); agg.hasViews = true; }
    if (r.engagement !== null) { agg.engagement += Number(r.engagement); agg.hasEng = true; }
    byDate.set(r.date, agg);
  }

  const sum = (list: LiveDailyPoint[], key: "views" | "engagement") => {
    const vals = list.map((p) => p[key]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + Number(b), 0) : null;
  };

  const pages: LivePageStats[] = latest.pages.map((p) => {
    const daily = byPage.get(p.page_id) || [];
    return {
      ...p,
      views: daily.length ? sum(daily, "views") : p.views,
      engagement: daily.length ? sum(daily, "engagement") : p.engagement,
      reels_count: reelsByPage.get(p.page_id) ?? 0,
      daily: daily.length ? daily : p.daily
    };
  });

  const total = (key: "followers" | "views" | "views_7d" | "engagement" | "reels_count") => {
    const vals = pages.map((p) => p[key]).filter((v): v is number => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + Number(b), 0) : null;
  };

  const dates = Array.from(byDate.keys()).sort();
  const timeSeries: LiveDailyPoint[] = dates.map((date) => {
    const a = byDate.get(date)!;
    return { date, views: a.hasViews ? a.views : null, engagement: a.hasEng ? a.engagement : null };
  });

  return {
    ...latest,
    range_days: ALL_TIME_RANGE,
    range_start: dates[0] || latest.range_start,
    range_end: dates[dates.length - 1] || latest.range_end,
    totals: {
      followers: total("followers"),
      views: total("views"),
      views_7d: total("views_7d"),
      engagement: total("engagement"),
      reels_count: total("reels_count")
    },
    pages,
    time_series: timeSeries.length ? timeSeries : latest.time_series
  };
}

/** Reads Facebook now, stores the 30-day snapshot + daily history + all-time snapshot, returns the requested range. */
export async function syncAndStoreAnalytics(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  days: number,
  encryptionKey: string
): Promise<StoredAnalyticsDashboard> {
  await ensureAnalyticsSnapshotsTable(db);
  const data = await getLiveAnalyticsDashboard(db, env, ownerUserId, { days: DEFAULT_RANGE_DAYS, refresh: true, encryptionKey });
  const syncedAtMs = Date.now();
  const payload: LiveAnalyticsDashboard = { ...data, cached: false, fetched_at: new Date(syncedAtMs).toISOString() };
  await saveSnapshot(db, ownerUserId, DEFAULT_RANGE_DAYS, payload, syncedAtMs);

  // Lịch sử theo ngày: lần đầu lấy lùi 90 ngày, các lần sau ghi 30 ngày vừa đọc
  const hasHistory = await db
    .prepare("SELECT 1 AS x FROM page_daily_insights WHERE owner_user_id = ? LIMIT 1")
    .bind(ownerUserId)
    .first();
  if (!hasHistory) {
    try {
      const backfill = await getLiveAnalyticsDashboard(db, env, ownerUserId, { days: BACKFILL_DAYS, refresh: true, encryptionKey });
      await storeDailyInsights(db, ownerUserId, backfill.pages);
    } catch {
      // Không lấy được 90 ngày thì vẫn lưu 30 ngày bên dưới
    }
  }
  await storeDailyInsights(db, ownerUserId, payload.pages);

  const allTime = await buildAllTimeDashboard(db, ownerUserId, payload);
  await saveSnapshot(db, ownerUserId, ALL_TIME_RANGE, allTime, syncedAtMs);

  const result = days === ALL_TIME_RANGE ? allTime : payload;
  return { ...toStored(result, syncedAtMs), cached: false };
}

/** Pushes a failed snapshot back in the queue so one bad account cannot block the others every run. */
async function recordSyncFailure(db: D1Database, ownerUserId: string, message: string): Promise<void> {
  const nowMs = Date.now();
  // Retry in ~30 minutes instead of waiting the full 6-hour interval
  const retryBase = nowMs - ANALYTICS_SYNC_INTERVAL_MS + 30 * 60 * 1000;
  await db
    .prepare(
      `UPDATE analytics_snapshots SET synced_at = MIN(synced_at, ?), last_error = ?, updated_at = ?
       WHERE owner_user_id = ? AND range_days = ?`
    )
    .bind(retryBase, message.slice(0, 500), new Date(nowMs).toISOString(), ownerUserId, DEFAULT_RANGE_DAYS)
    .run();
}

/**
 * Cron job: refreshes snapshots that are 6 hours old or older, and creates the first
 * snapshot for users who have Pages but were never synced. (Bản "Tất cả" được tính lại trong cùng lần đồng bộ.)
 */
export async function syncDueAnalytics(
  db: D1Database,
  env: Env,
  encryptionKey: string
): Promise<{ synced: number; failed: number }> {
  await ensureAnalyticsSnapshotsTable(db);
  const nowMs = Date.now();

  const owners: string[] = [];

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
  for (const r of neverSynced.results || []) owners.push(r.owner_user_id);

  if (owners.length < MAX_SYNCS_PER_RUN) {
    const due = await db
      .prepare(
        `SELECT owner_user_id FROM analytics_snapshots
         WHERE range_days = ? AND synced_at <= ?
         ORDER BY synced_at ASC
         LIMIT ?`
      )
      .bind(DEFAULT_RANGE_DAYS, nowMs - ANALYTICS_SYNC_INTERVAL_MS, MAX_SYNCS_PER_RUN - owners.length)
      .all<{ owner_user_id: string }>();
    for (const r of due.results || []) owners.push(r.owner_user_id);
  }

  let synced = 0;
  let failed = 0;
  for (const owner of owners) {
    try {
      await syncAndStoreAnalytics(db, env, owner, DEFAULT_RANGE_DAYS, encryptionKey);
      synced++;
    } catch (err: any) {
      failed++;
      await recordSyncFailure(db, owner, String(err?.message || err)).catch(() => {});
    }
  }
  return { synced, failed };
}

/**
 * Dữ liệu cho màn hình Thống kê: luôn đọc bản đã lưu (1 dòng).
 * Chưa có bản "Tất cả" nhưng đã có 30 ngày -> tính từ lịch sử trong DB (không gọi Facebook).
 * Chưa có gì -> đồng bộ từ Facebook lần đầu.
 */
export async function getAnalytics(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  days: number,
  encryptionKey: string
): Promise<StoredAnalyticsDashboard> {
  const stored = await getStoredAnalytics(db, ownerUserId, days);
  if (stored) return stored;
  if (days === ALL_TIME_RANGE) {
    const latestRow = await db
      .prepare("SELECT payload, synced_at FROM analytics_snapshots WHERE owner_user_id = ? AND range_days = ? LIMIT 1")
      .bind(ownerUserId, DEFAULT_RANGE_DAYS)
      .first<{ payload: string; synced_at: number }>();
    if (latestRow) {
      const latest = JSON.parse(latestRow.payload) as LiveAnalyticsDashboard;
      await storeDailyInsights(db, ownerUserId, latest.pages);
      const allTime = await buildAllTimeDashboard(db, ownerUserId, latest);
      await saveSnapshot(db, ownerUserId, ALL_TIME_RANGE, allTime, Number(latestRow.synced_at));
      return toStored(allTime, Number(latestRow.synced_at));
    }
  }
  return syncAndStoreAnalytics(db, env, ownerUserId, days, encryptionKey);
}
