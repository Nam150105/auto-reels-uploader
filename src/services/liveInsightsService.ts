/**
 * Live analytics straight from the Meta Graph API (no numbers computed from local task data).
 *
 * Per Page:
 * - Page info (followers)
 * - Daily Page insights over complete days only (views, engagement, new follows), like Meta Business Suite
 * - Every Reel created in the range (paginated, including Reels not posted through this tool)
 * - Per-Reel lifetime insights: plays, reach, reactions (all types), comments (incl. replies), shares
 *
 * All calls go through Graph Batch requests (max 50 operations per HTTP call), so loading the dashboard
 * stays within the Workers subrequest limit even with many Pages and Reels.
 * A number Meta does not return stays null. Nothing is estimated or invented.
 */

import type { D1Database, Env, FacebookPageRecord } from "../types.ts";
import { getFacebookPages } from "../db.ts";
import { getMetaConfig } from "./metaGraphService.ts";

const BATCH_MAX = 50;
const REELS_PAGE_SIZE = 100;
const MAX_REEL_PAGINATION_ROUNDS = 5;
const MAX_REELS_WITH_INSIGHTS = 300;
const MAX_FALLBACK_REELS = 60;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 20 * 1000;
const DAY_SEC = 86400;

/** Daily Page metrics, one per batch operation so an unsupported metric does not hide the others. */
const PAGE_DAILY_METRICS = [
  "page_media_view",
  "page_video_views",
  "page_post_engagements",
  "page_daily_follows_unique"
] as const;
type PageMetric = (typeof PAGE_DAILY_METRICS)[number];

/** Lifetime Reel metrics, requested together; per-metric fallback when Meta rejects the combination. */
const REEL_METRICS = [
  "fb_reels_total_plays",
  "blue_reels_play_count",
  "post_impressions_unique",
  "post_video_social_actions",
  "post_video_likes_by_reaction_type"
] as const;

export interface LiveReel {
  video_id: string;
  page_id: string;
  page_name: string;
  description: string;
  created_time: string;
  permalink_url: string;
  length_seconds: number | null;
  plays: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
}

export interface LiveDailyPoint {
  date: string;
  views: number | null;
  engagement: number | null;
  new_follows: number | null;
}

export interface LivePageStats {
  page_id: string;
  page_name: string;
  avatar_url: string;
  followers: number | null;
  new_follows: number | null;
  views: number | null;
  views_7d: number | null;
  engagement: number | null;
  reels_count: number;
  reel_plays: number | null;
  reel_reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  status: "ok" | "partial" | "reconnect" | "error";
  status_message: string;
  /** Which Meta metric fed "views" (page_media_view or page_video_views) */
  views_metric: string | null;
  daily: LiveDailyPoint[];
  reels: LiveReel[];
}

export interface LiveAnalyticsDashboard {
  source: "meta_graph_api";
  range_days: number;
  range_start: string;
  range_end: string;
  fetched_at: string;
  cached: boolean;
  total_pages: number;
  total_followers: number | null;
  new_follows: number | null;
  views: number | null;
  views_7d: number | null;
  engagement: number | null;
  reels_count: number;
  reels_count_7d: number;
  reel_plays: number | null;
  pages: LivePageStats[];
  time_series: LiveDailyPoint[];
  top_reels: LiveReel[];
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

const addNullable = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : a + b;

/** Date (YYYY-MM-DD) a daily insight value belongs to: end_time marks the end of that day. */
function insightDate(endTime: string): string {
  const t = Date.parse(endTime);
  if (!Number.isFinite(t)) return "";
  return new Date(t - 12 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Value of a lifetime insight entry. Objects (e.g. reactions by type) are summed, or one key is picked. */
function entryValue(entry: any, mode: "number" | "sum" | { key: string }): number | null {
  if (!entry) return null;
  const values = Array.isArray(entry.values) ? entry.values : [];
  const raw = values.length > 0 ? values[values.length - 1]?.value : entry.value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return num(raw);
  const obj = raw as Record<string, unknown>;
  if (mode === "sum") {
    let total = 0;
    let any = false;
    for (const v of Object.values(obj)) {
      const n = num(v);
      if (n !== null) {
        total += n;
        any = true;
      }
    }
    return any ? total : 0;
  }
  if (typeof mode === "object") {
    const k = Object.keys(obj).find((x) => x.toLowerCase().startsWith(mode.key));
    return k ? num(obj[k]) : 0; // Meta omits zero keys
  }
  return null;
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
  const pages = allPages.filter((p) => p.page_access_token);
  const warnings: string[] = [];
  const missingToken = allPages.length - pages.length;
  if (missingToken > 0) warnings.push(`${missingToken} Page(s) need to be reconnected before their data can be read.`);

  const nowSec = Math.floor(nowMs / 1000);
  const rangeStartSec = nowSec - days * DAY_SEC;
  const since7 = nowSec - 7 * DAY_SEC;
  // Ask for a few extra days, then keep only the last `days` complete days (Business Suite style)
  const insightsSince = nowSec - (days + 3) * DAY_SEC;

  const tokenOf = (p: FacebookPageRecord) => p.page_access_token!;
  const reelFields =
    "id,description,created_time,permalink_url,length," +
    "comments.filter(stream).limit(0).summary(true)," +
    "reactions.limit(0).summary(total_count)";
  /** Used when Meta rejects the richer field set for a Page */
  const reelFieldsBasic = "id,description,created_time,permalink_url,length,comments.limit(0).summary(true)";
  const reelFieldsByPage = new Map<string, string>();

  const stats = new Map<string, LivePageStats>();
  for (const page of pages) {
    stats.set(page.facebook_page_id, {
      page_id: page.facebook_page_id,
      page_name: page.page_name || page.name || page.facebook_page_id,
      avatar_url: page.avatar_url || "",
      followers: null,
      new_follows: null,
      views: null,
      views_7d: null,
      engagement: null,
      reels_count: 0,
      reel_plays: null,
      reel_reach: null,
      reactions: null,
      comments: null,
      shares: null,
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

  const takeReels = (page: FacebookPageRecord, body: any) => {
    const s = stats.get(page.facebook_page_id)!;
    const list: any[] = Array.isArray(body?.data) ? body.data : [];
    let reachedOlder = false;
    for (const v of list) {
      const t = Date.parse(String(v.created_time || ""));
      if (!Number.isFinite(t)) continue;
      if (t / 1000 < rangeStartSec) {
        reachedOlder = true;
        continue;
      }
      s.reels.push({
        video_id: String(v.id || ""),
        page_id: page.facebook_page_id,
        page_name: s.page_name,
        description: String(v.description || "").slice(0, 160),
        created_time: String(v.created_time),
        permalink_url: toPermalink(v),
        length_seconds: num(v.length),
        plays: null,
        reach: null,
        reactions: num(v.reactions?.summary?.total_count),
        comments: num(v.comments?.summary?.total_count),
        shares: null
      });
    }
    const after = body?.paging?.cursors?.after;
    if (!reachedOlder && body?.paging?.next && after) reelCursor.set(page.facebook_page_id, String(after));
    else reelCursor.delete(page.facebook_page_id);
  };

  const reelsRetryBasic: FacebookPageRecord[] = [];
  res1.forEach((r, idx) => {
    const { page, kind } = meta1[idx];
    const s = stats.get(page.facebook_page_id)!;
    if (!r.ok && kind === "reels" && r.errorCode === 100) {
      reelsRetryBasic.push(page);
      return;
    }
    if (!r.ok) {
      markProblem(page.facebook_page_id, r, kind === "info" || kind === "reels");
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
    for (const p of points) m.set(insightDate(new Date(p.end).toISOString()), p.value as number);
    const pageSeries = series.get(page.facebook_page_id) || {};
    pageSeries[kind] = m;
    series.set(page.facebook_page_id, pageSeries);
  });

  // Pages whose Reels list rejected the richer fields: read again with basic fields
  if (reelsRetryBasic.length > 0) {
    const res = await runGraphBatch(
      env,
      reelsRetryBasic.map((p) => ({
        relative_url: `${encodeURIComponent(p.facebook_page_id)}/video_reels?fields=${reelFieldsBasic}&limit=${REELS_PAGE_SIZE}`,
        token: tokenOf(p)
      }))
    );
    res.forEach((r, i) => {
      const page = reelsRetryBasic[i];
      if (r.ok) {
        reelFieldsByPage.set(page.facebook_page_id, reelFieldsBasic);
        takeReels(page, r.body);
      } else {
        markProblem(page.facebook_page_id, r, true);
      }
    });
  }

  // ---- Reels pagination: keep reading until Reels are older than the range ----
  for (let round = 0; round < MAX_REEL_PAGINATION_ROUNDS && reelCursor.size > 0; round++) {
    const pending = pages.filter((p) => reelCursor.has(p.facebook_page_id));
    const ops: BatchOp[] = pending.map((p) => ({
      relative_url: `${encodeURIComponent(p.facebook_page_id)}/video_reels?fields=${reelFieldsByPage.get(p.facebook_page_id) || reelFields}&limit=${REELS_PAGE_SIZE}&after=${encodeURIComponent(reelCursor.get(p.facebook_page_id)!)}`,
      token: tokenOf(p)
    }));
    const res = await runGraphBatch(env, ops);
    res.forEach((r, i) => {
      if (r.ok) takeReels(pending[i], r.body);
      else reelCursor.delete(pending[i].facebook_page_id);
    });
  }
  if (reelCursor.size > 0) {
    warnings.push("Some Pages have more Reels in this period than could be loaded. Choose a shorter period for exact totals.");
  }

  // ---- Daily series per Page ----
  for (const page of pages) {
    const s = stats.get(page.facebook_page_id)!;
    const m = series.get(page.facebook_page_id) || {};
    const viewKey: PageMetric | null = m.page_media_view ? "page_media_view" : m.page_video_views ? "page_video_views" : null;
    s.views_metric = viewKey;
    const dates = new Set<string>();
    for (const key of [viewKey, "page_post_engagements", "page_daily_follows_unique"] as const) {
      if (key && m[key]) for (const d of m[key]!.keys()) dates.add(d);
    }
    s.daily = Array.from(dates)
      .sort()
      .map((date) => ({
        date,
        views: viewKey ? m[viewKey]!.get(date) ?? null : null,
        engagement: m.page_post_engagements?.get(date) ?? null,
        new_follows: m.page_daily_follows_unique?.get(date) ?? null
      }));
    const sumOf = (field: "views" | "engagement" | "new_follows", fromDate = "") =>
      s.daily.reduce<number | null>((acc, d) => (d.date >= fromDate ? addNullable(acc, d[field]) : acc), null);
    s.views = viewKey ? sumOf("views") : null;
    s.engagement = m.page_post_engagements ? sumOf("engagement") : null;
    s.new_follows = m.page_daily_follows_unique ? sumOf("new_follows") : null;
    const last7 = s.daily.slice(-7)[0]?.date || "";
    s.views_7d = viewKey ? sumOf("views", last7) : null;
  }

  // ---- Reel insights (combined request, per-metric fallback) ----
  const allReels = pages.flatMap((p) => stats.get(p.facebook_page_id)!.reels);
  allReels.sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time));
  const reelsForInsights = allReels.slice(0, MAX_REELS_WITH_INSIGHTS);
  if (allReels.length > MAX_REELS_WITH_INSIGHTS) {
    warnings.push(`Plays and reach are shown for the ${MAX_REELS_WITH_INSIGHTS} most recent Reels only.`);
  }
  const tokenByPage = new Map(pages.map((p) => [p.facebook_page_id, tokenOf(p)]));

  const applyReelInsights = (reel: LiveReel, entries: any[]) => {
    const byName = new Map<string, any>(entries.map((e) => [String(e?.name || ""), e]));
    const total = entryValue(byName.get("fb_reels_total_plays"), "number");
    const initial = entryValue(byName.get("blue_reels_play_count"), "number");
    if (total !== null || initial !== null) reel.plays = total ?? initial;
    const reach = entryValue(byName.get("post_impressions_unique"), "number");
    if (reach !== null) reel.reach = reach;
    if (byName.has("post_video_social_actions")) {
      reel.shares = entryValue(byName.get("post_video_social_actions"), { key: "share" });
    }
    if (reel.reactions === null && byName.has("post_video_likes_by_reaction_type")) {
      reel.reactions = entryValue(byName.get("post_video_likes_by_reaction_type"), "sum");
    }
  };

  const combinedOps: BatchOp[] = reelsForInsights.map((reel) => ({
    relative_url: `${encodeURIComponent(reel.video_id)}/video_insights?metric=${REEL_METRICS.join(",")}`,
    token: tokenByPage.get(reel.page_id)!
  }));
  const combined = combinedOps.length > 0 ? await runGraphBatch(env, combinedOps) : [];
  const fallbackReels: LiveReel[] = [];
  combined.forEach((r, i) => {
    const reel = reelsForInsights[i];
    if (r.ok) applyReelInsights(reel, Array.isArray(r.body?.data) ? r.body.data : []);
    else if (r.errorCode === 100 && fallbackReels.length < MAX_FALLBACK_REELS) fallbackReels.push(reel);
  });
  if (fallbackReels.length > 0) {
    const ops: BatchOp[] = [];
    const owners: LiveReel[] = [];
    for (const reel of fallbackReels) {
      for (const metric of REEL_METRICS) {
        ops.push({
          relative_url: `${encodeURIComponent(reel.video_id)}/video_insights?metric=${metric}`,
          token: tokenByPage.get(reel.page_id)!
        });
        owners.push(reel);
      }
    }
    const res = await runGraphBatch(env, ops);
    res.forEach((r, i) => {
      if (r.ok) applyReelInsights(owners[i], Array.isArray(r.body?.data) ? r.body.data : []);
    });
  }

  // ---- Per-Page Reel totals ----
  for (const s of stats.values()) {
    s.reels.sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time));
    s.reels_count = s.reels.length;
    for (const reel of s.reels) {
      s.reel_plays = addNullable(s.reel_plays, reel.plays);
      s.reel_reach = addNullable(s.reel_reach, reel.reach);
      s.reactions = addNullable(s.reactions, reel.reactions);
      s.comments = addNullable(s.comments, reel.comments);
      s.shares = addNullable(s.shares, reel.shares);
    }
  }

  const pageStats = Array.from(stats.values());
  const sumField = (field: "followers" | "new_follows" | "views" | "views_7d" | "engagement" | "reel_plays") =>
    pageStats.reduce<number | null>((acc, p) => addNullable(acc, p[field]), null);

  // Overall daily series = sum across Pages per day
  const overall = new Map<string, LiveDailyPoint>();
  for (const s of pageStats) {
    for (const d of s.daily) {
      const cur = overall.get(d.date) || { date: d.date, views: null, engagement: null, new_follows: null };
      cur.views = addNullable(cur.views, d.views);
      cur.engagement = addNullable(cur.engagement, d.engagement);
      cur.new_follows = addNullable(cur.new_follows, d.new_follows);
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
    total_pages: allPages.length,
    total_followers: sumField("followers"),
    new_follows: sumField("new_follows"),
    views: sumField("views"),
    views_7d: sumField("views_7d"),
    engagement: sumField("engagement"),
    reels_count: allReels.length,
    reels_count_7d: allReels.filter((r) => Date.parse(r.created_time) / 1000 >= since7).length,
    reel_plays: sumField("reel_plays"),
    pages: pageStats,
    time_series: timeSeries,
    top_reels: [...allReels].sort((a, b) => (b.plays ?? -1) - (a.plays ?? -1)).slice(0, 10),
    warnings
  };
  cache.set(cacheKey, { at: nowMs, data });
  return data;
}
