/**
 * Live analytics straight from the Meta Graph API (no numbers computed from local task data).
 *
 * Per Page, five numbers:
 * - followers    : Page followers_count (fan_count as fallback)
 * - views        : sum of daily page_media_view (page_video_views as fallback) over the complete days in range
 * - views_7d     : the same, last 7 complete days
 * - engagement   : sum of daily page_post_engagements over the range
 * - reels_count  : Reels created on the Page in the range (paginated video_reels)
 *
 * Totals are simply these five numbers added up across Pages.
 * All calls go through Graph Batch requests (max 50 operations per HTTP call).
 * A number Meta does not return stays null. Nothing is estimated or invented.
 */

import type { D1Database, Env, FacebookPageRecord } from "../types.ts";
import { getFacebookPages } from "../db.ts";
import { getMetaConfig } from "./metaGraphService.ts";

const BATCH_MAX = 50;
const REELS_PAGE_SIZE = 100;
const MAX_REEL_PAGINATION_ROUNDS = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 20 * 1000;
const DAY_SEC = 86400;

/** Daily Page metrics, one per batch operation so an unsupported metric does not hide the others. */
const PAGE_DAILY_METRICS = ["page_media_view", "page_video_views", "page_post_engagements"] as const;
type PageMetric = (typeof PAGE_DAILY_METRICS)[number];

export interface LiveDailyPoint {
  date: string;
  views: number | null;
  engagement: number | null;
}

export interface LiveReelItem {
  video_id: string;
  description: string;
  created_time: string;
  permalink_url: string;
}

export interface LivePageStats {
  page_id: string;
  page_name: string;
  avatar_url: string;
  followers: number | null;
  views: number | null;
  views_7d: number | null;
  engagement: number | null;
  reels_count: number | null;
  status: "ok" | "partial" | "reconnect" | "error";
  status_message: string;
  /** Which Meta metric fed "views" (page_media_view or page_video_views) */
  views_metric: string | null;
  daily: LiveDailyPoint[];
  reels: LiveReelItem[];
}

export interface LiveTotals {
  followers: number | null;
  views: number | null;
  views_7d: number | null;
  engagement: number | null;
  reels_count: number | null;
}

export interface LiveAnalyticsDashboard {
  source: "meta_graph_api";
  range_days: number;
  range_start: string;
  range_end: string;
  fetched_at: string;
  cached: boolean;
  total_pages: number;
  totals: LiveTotals;
  pages: LivePageStats[];
  time_series: LiveDailyPoint[];
  warnings: string[];
}

interface BatchOp {
  relative_url: string;
  token: string;
}

interface BatchResult {
  ok: boolean;
  code: number;
  body: any;
  errorCode: number | null;
  errorMessage: string;
}

const cache = new Map<string, { at: number; data: LiveAnalyticsDashboard }>();

function graphRoot(env: Env): string {
  return getMetaConfig(env).graphBase.replace(/\/+$/, "");
}

/** Runs Graph Batch API calls (one HTTP request per 50 operations), all chunks in parallel. */
async function runGraphBatch(env: Env, ops: BatchOp[]): Promise<BatchResult[]> {
  const results: BatchResult[] = new Array(ops.length);
  const chunks: Array<{ start: number; ops: BatchOp[] }> = [];
  for (let i = 0; i < ops.length; i += BATCH_MAX) chunks.push({ start: i, ops: ops.slice(i, i + BATCH_MAX) });

  const failAll = (start: number, count: number, message: string, errorCode: number | null = null) => {
    for (let k = 0; k < count; k++) {
      results[start + k] = { ok: false, code: 0, body: null, errorCode, errorMessage: message };
    }
  };

  await Promise.all(
    chunks.map(async ({ start, ops: chunk }) => {
      const batch = chunk.map((op) => {
        const sep = op.relative_url.includes("?") ? "&" : "?";
        return {
          method: "GET",
          relative_url: `${op.relative_url}${sep}access_token=${encodeURIComponent(op.token)}`
        };
      });
      const form = new URLSearchParams();
      form.set("access_token", chunk[0].token);
      form.set("include_headers", "false");
      form.set("batch", JSON.stringify(batch));

      let raw: unknown;
      try {
        const resp = await fetch(`${graphRoot(env)}/`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString()
        });
        raw = await resp.json().catch(() => null);
        if (!Array.isArray(raw)) {
          const err = (raw as any)?.error || {};
          failAll(start, chunk.length, String(err.message || `HTTP ${resp.status}`), Number(err.code || 0) || null);
          return;
        }
      } catch {
        failAll(start, chunk.length, "Could not reach Facebook.");
        return;
      }

      for (let k = 0; k < chunk.length; k++) {
        const item = (raw as Array<{ code?: number; body?: string } | null>)[k];
        if (!item) {
          results[start + k] = { ok: false, code: 0, body: null, errorCode: null, errorMessage: "Facebook timed out." };
          continue;
        }
        let body: any = null;
        try {
          body = typeof item.body === "string" ? JSON.parse(item.body) : item.body ?? null;
        } catch {
          body = null;
        }
        const code = Number(item.code || 0);
        const err = body?.error;
        results[start + k] = {
          ok: code >= 200 && code < 300 && !err,
          code,
          body,
          errorCode: err ? Number(err.code || 0) || null : null,
          errorMessage: err ? String(err.message || "") : ""
        };
      }
    })
  );
  return results;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Adds numbers, ignoring nulls; null only when every value is null. */
function sumNullable(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
}

/** Date (YYYY-MM-DD) a daily insight value belongs to: end_time marks the end of that day. */
function insightDate(endMs: number): string {
  return new Date(endMs - 12 * 3600 * 1000).toISOString().slice(0, 10);
}

function describeError(r: BatchResult): { reconnect: boolean; message: string } {
  const code = r.errorCode;
  const msg = (r.errorMessage || "").toLowerCase();
  if (code === 190 || code === 102 || msg.includes("session has expired") || msg.includes("access token")) {
    return { reconnect: true, message: "Facebook connection expired. Reconnect this Page." };
  }
  if (code === 10 || code === 200 || code === 3 || msg.includes("permission")) {
    return { reconnect: true, message: "Missing permission to read insights. Reconnect and allow all requested permissions." };
  }
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return { reconnect: false, message: "Facebook rate limit reached. Try again in a few minutes." };
  }
  return { reconnect: false, message: "Facebook did not return data for this Page." };
}

function toPermalink(v: any): string {
  const raw = String(v?.permalink_url || "");
  if (raw.startsWith("http")) return raw;
  if (raw) return `https://www.facebook.com${raw.startsWith("/") ? "" : "/"}${raw}`;
  return `https://www.facebook.com/reel/${v?.id}`;
}

export async function getLiveAnalyticsDashboard(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  options: { days?: number; refresh?: boolean; encryptionKey: string }
): Promise<LiveAnalyticsDashboard> {
  const days = Math.min(90, Math.max(7, Math.floor(options.days || 28)));
  const cacheKey = `${ownerUserId}:${days}`;
  const hit = cache.get(cacheKey);
  const nowMs = Date.now();
  if (hit && (nowMs - hit.at < MIN_REFRESH_INTERVAL_MS || (!options.refresh && nowMs - hit.at < CACHE_TTL_MS))) {
    return { ...hit.data, cached: true };
  }

  const allPages = await getFacebookPages(db, options.encryptionKey, { includeToken: true, ownerUserId });
  // One entry per Facebook Page, so nothing is ever counted twice
  const seen = new Set<string>();
  const pages = allPages.filter((p) => {
    if (!p.page_access_token || seen.has(p.facebook_page_id)) return false;
    seen.add(p.facebook_page_id);
    return true;
  });
  const warnings: string[] = [];
  const missingNames = Array.from(
    new Map(
      allPages
        .filter((p) => !seen.has(p.facebook_page_id))
        .map((p) => [p.facebook_page_id, p.page_name || p.name || p.facebook_page_id] as const)
    ).values()
  );
  if (missingNames.length > 0) {
    warnings.push(
      `${missingNames.length} Page(s) have no valid token and were skipped: ${missingNames.join(", ")}. ` +
        "The admin token no longer includes them (not selected when the token was created, or admin access was lost). " +
        "Update the token with these Pages selected, or remove them in the Fanpage tab."
    );
  }

  const nowSec = Math.floor(nowMs / 1000);
  const rangeStartSec = nowSec - days * DAY_SEC;
  // Ask for a few extra days, then keep only the last `days` complete days (Business Suite style)
  const insightsSince = nowSec - (days + 3) * DAY_SEC;
  const tokenOf = (p: FacebookPageRecord) => p.page_access_token!;
  const reelFields = "id,description,created_time,permalink_url";

  const stats = new Map<string, LivePageStats>();
  for (const page of pages) {
    stats.set(page.facebook_page_id, {
      page_id: page.facebook_page_id,
      page_name: page.page_name || page.name || page.facebook_page_id,
      avatar_url: page.avatar_url || "",
      followers: null,
      views: null,
      views_7d: null,
      engagement: null,
      reels_count: null,
      status: "ok",
      status_message: "",
      views_metric: null,
      daily: [],
      reels: []
    });
  }
  let permissionProblem = false;
  const markProblem = (pageId: string, r: BatchResult, critical: boolean) => {
    const s = stats.get(pageId)!;
    const d = describeError(r);
    if (critical) {
      s.status = d.reconnect ? "reconnect" : "error";
      s.status_message = d.message;
    } else if (s.status === "ok") {
      s.status = "partial";
      s.status_message = "Some numbers are not available for this Page.";
    }
    if (r.errorCode === 10 || r.errorCode === 200) permissionProblem = true;
  };

  // ---- Round 1: Page info, daily Page insights, first page of Reels ----
  type Op1 = { page: FacebookPageRecord; kind: "info" | "reels" | PageMetric };
  const ops1: BatchOp[] = [];
  const meta1: Op1[] = [];
  for (const page of pages) {
    const id = encodeURIComponent(page.facebook_page_id);
    ops1.push({ relative_url: `${id}?fields=id,name,followers_count,fan_count,picture{url}`, token: tokenOf(page) });
    meta1.push({ page, kind: "info" });
    ops1.push({ relative_url: `${id}/video_reels?fields=${reelFields}&limit=${REELS_PAGE_SIZE}`, token: tokenOf(page) });
    meta1.push({ page, kind: "reels" });
    for (const metric of PAGE_DAILY_METRICS) {
      ops1.push({
        relative_url: `${id}/insights?metric=${metric}&period=day&since=${insightsSince}&until=${nowSec}`,
        token: tokenOf(page)
      });
      meta1.push({ page, kind: metric });
    }
  }
  const res1 = ops1.length > 0 ? await runGraphBatch(env, ops1) : [];

  const series = new Map<string, Partial<Record<PageMetric, Map<string, number>>>>();
  const reelCursor = new Map<string, string>(); // pageId -> "after" cursor while more Reels are in range
  const reelsLoaded = new Set<string>();

  const takeReels = (page: FacebookPageRecord, body: any) => {
    const s = stats.get(page.facebook_page_id)!;
    reelsLoaded.add(page.facebook_page_id);
    const list: any[] = Array.isArray(body?.data) ? body.data : [];
    let reachedOlder = false;
    for (const v of list) {
      const t = Date.parse(String(v.created_time || ""));
      if (!Number.isFinite(t)) continue;
      if (t / 1000 < rangeStartSec) {
        reachedOlder = true;
        continue;
      }
      const id = String(v.id || "");
      if (s.reels.some((r) => r.video_id === id)) continue;
      s.reels.push({
        video_id: id,
        description: String(v.description || "").slice(0, 160),
        created_time: String(v.created_time),
        permalink_url: toPermalink(v)
      });
    }
    const after = body?.paging?.cursors?.after;
    if (!reachedOlder && body?.paging?.next && after) reelCursor.set(page.facebook_page_id, String(after));
    else reelCursor.delete(page.facebook_page_id);
  };

  const metricErrors = new Map<string, Partial<Record<PageMetric, BatchResult>>>();
  res1.forEach((r, idx) => {
    const { page, kind } = meta1[idx];
    const s = stats.get(page.facebook_page_id)!;
    if (!r.ok) {
      if (kind === "info" || kind === "reels") {
        markProblem(page.facebook_page_id, r, kind === "info");
      } else {
        // Judged later: a failed fallback metric is fine when the main one worked
        const errs = metricErrors.get(page.facebook_page_id) || {};
        errs[kind] = r;
        metricErrors.set(page.facebook_page_id, errs);
      }
      return;
    }
    if (kind === "info") {
      s.followers = num(r.body?.followers_count) ?? num(r.body?.fan_count);
      if (r.body?.name) s.page_name = String(r.body.name);
      const pic = r.body?.picture?.data?.url;
      if (pic) s.avatar_url = String(pic);
      return;
    }
    if (kind === "reels") {
      takeReels(page, r.body);
      return;
    }
    // Daily Page metric: keep complete days only (end_time <= now), the last `days` of them
    const entry = Array.isArray(r.body?.data) ? r.body.data[0] : null;
    const values: any[] = Array.isArray(entry?.values) ? entry.values : [];
    const points = values
      .map((v) => ({ end: Date.parse(String(v.end_time || "")), value: num(v.value) }))
      .filter((v) => Number.isFinite(v.end) && v.end <= nowMs && v.value !== null)
      .sort((a, b) => a.end - b.end)
      .slice(-days);
    if (points.length === 0) return;
    const m = new Map<string, number>();
    for (const p of points) m.set(insightDate(p.end), p.value as number);
    const pageSeries = series.get(page.facebook_page_id) || {};
    pageSeries[kind] = m;
    series.set(page.facebook_page_id, pageSeries);
  });

  // ---- Reels pagination: keep reading until Reels are older than the range ----
  for (let round = 0; round < MAX_REEL_PAGINATION_ROUNDS && reelCursor.size > 0; round++) {
    const pending = pages.filter((p) => reelCursor.has(p.facebook_page_id));
    const ops: BatchOp[] = pending.map((p) => ({
      relative_url: `${encodeURIComponent(p.facebook_page_id)}/video_reels?fields=${reelFields}&limit=${REELS_PAGE_SIZE}&after=${encodeURIComponent(reelCursor.get(p.facebook_page_id)!)}`,
      token: tokenOf(p)
    }));
    const res = await runGraphBatch(env, ops);
    res.forEach((r, i) => {
      if (r.ok) takeReels(pending[i], r.body);
      else reelCursor.delete(pending[i].facebook_page_id);
    });
  }
  if (reelCursor.size > 0) {
    warnings.push("Some Pages have more Reels in this period than could be loaded. Choose a shorter period for an exact count.");
  }

  // ---- The five numbers per Page ----
  for (const page of pages) {
    const s = stats.get(page.facebook_page_id)!;
    const m = series.get(page.facebook_page_id) || {};
    const viewKey: PageMetric | null = m.page_media_view ? "page_media_view" : m.page_video_views ? "page_video_views" : null;
    s.views_metric = viewKey;
    const errs = metricErrors.get(page.facebook_page_id) || {};
    if (!viewKey) {
      const err = errs.page_media_view || errs.page_video_views;
      if (err) markProblem(page.facebook_page_id, err, false);
    }
    if (!m.page_post_engagements && errs.page_post_engagements) {
      markProblem(page.facebook_page_id, errs.page_post_engagements, false);
    }
    const dates = new Set<string>();
    for (const key of [viewKey, "page_post_engagements"] as const) {
      if (key && m[key]) for (const d of m[key]!.keys()) dates.add(d);
    }
    s.daily = Array.from(dates)
      .sort()
      .map((date) => ({
        date,
        views: viewKey ? m[viewKey]!.get(date) ?? null : null,
        engagement: m.page_post_engagements?.get(date) ?? null
      }));
    s.views = viewKey ? sumNullable(s.daily.map((d) => d.views)) : null;
    s.views_7d = viewKey ? sumNullable(s.daily.slice(-7).map((d) => d.views)) : null;
    s.engagement = m.page_post_engagements ? sumNullable(s.daily.map((d) => d.engagement)) : null;
    s.reels.sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time));
    s.reels_count = reelsLoaded.has(page.facebook_page_id) ? s.reels.length : null;
  }

  const pageStats = Array.from(stats.values());

  // Totals: the five per-Page numbers added up
  const totals: LiveTotals = {
    followers: sumNullable(pageStats.map((p) => p.followers)),
    views: sumNullable(pageStats.map((p) => p.views)),
    views_7d: sumNullable(pageStats.map((p) => p.views_7d)),
    engagement: sumNullable(pageStats.map((p) => p.engagement)),
    reels_count: sumNullable(pageStats.map((p) => p.reels_count))
  };

  // Daily series across Pages (chart)
  const overall = new Map<string, LiveDailyPoint>();
  for (const s of pageStats) {
    for (const d of s.daily) {
      const cur = overall.get(d.date) || { date: d.date, views: null, engagement: null };
      cur.views = sumNullable([cur.views, d.views]);
      cur.engagement = sumNullable([cur.engagement, d.engagement]);
      overall.set(d.date, cur);
    }
  }
  const timeSeries = Array.from(overall.values()).sort((a, b) => a.date.localeCompare(b.date));

  if (permissionProblem) {
    warnings.push(
      "Facebook did not allow reading some insights. Reconnect your Facebook account and keep every requested permission enabled (especially read_insights)."
    );
  }
  const unreadable = pageStats.filter((p) => p.status === "reconnect" || p.status === "error");
  if (unreadable.length > 0) {
    warnings.push(`Could not read ${unreadable.length} Page(s): ${unreadable.map((p) => p.page_name).join(", ")}.`);
  }

  const data: LiveAnalyticsDashboard = {
    source: "meta_graph_api",
    range_days: days,
    range_start: timeSeries[0]?.date || new Date(rangeStartSec * 1000).toISOString().slice(0, 10),
    range_end: timeSeries[timeSeries.length - 1]?.date || new Date(nowMs).toISOString().slice(0, 10),
    fetched_at: new Date(nowMs).toISOString(),
    cached: false,
    total_pages: seen.size + missingNames.length,
    totals,
    pages: pageStats,
    time_series: timeSeries,
    warnings
  };
  cache.set(cacheKey, { at: nowMs, data });
  return data;
}
