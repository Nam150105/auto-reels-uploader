/**
 * Live analytics straight from the Meta Graph API (no numbers computed from local task data).
 *
 * - Page info (followers), Page insights (daily views / engagement / new follows) and the Page's Reels
 *   (including Reels not posted through this tool) are fetched live for every connected Page.
 * - Reel insights (plays / reach / shares) are fetched per Reel.
 * - Everything goes through Graph Batch requests (max 50 operations per HTTP call), so a dashboard
 *   load costs only a handful of subrequests even with many Pages.
 * - A metric Meta does not return stays null. Nothing is estimated or invented.
 */

import type { D1Database, Env, FacebookPageRecord } from "../types.ts";
import { getFacebookPages } from "../db.ts";
import { getMetaConfig } from "./metaGraphService.ts";

const BATCH_MAX = 50;
const MAX_REELS_PER_PAGE = 25;
const MAX_REELS_TOTAL = 60;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 20 * 1000;

/** Daily Page metrics, requested one per operation so an unsupported metric does not hide the others. */
const PAGE_DAILY_METRICS = [
  "page_media_view",
  "page_video_views",
  "page_post_engagements",
  "page_daily_follows_unique"
] as const;
type PageMetric = (typeof PAGE_DAILY_METRICS)[number];

const REEL_METRICS = [
  "fb_reels_total_plays",
  "blue_reels_play_count",
  "post_impressions_unique",
  "post_video_social_actions"
] as const;
type ReelMetric = (typeof REEL_METRICS)[number];

export interface LiveReel {
  video_id: string;
  page_id: string;
  page_name: string;
  description: string;
  created_time: string;
  permalink_url: string;
  plays: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface LivePageStats {
  page_id: string;
  page_name: string;
  avatar_url: string;
  followers: number | null;
  new_follows: number | null;
  views: number | null;
  engagement: number | null;
  reels_count: number;
  reel_plays: number | null;
  reel_reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  status: "ok" | "partial" | "reconnect" | "error";
  status_message: string;
}

export interface LiveAnalyticsDashboard {
  source: "meta_graph_api";
  range_days: number;
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
  time_series: Array<{ date: string; views: number | null; engagement: number | null; new_follows: number | null }>;
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

  const failAll = (start: number, count: number, message: string) => {
    for (let k = 0; k < count; k++) {
      results[start + k] = { ok: false, code: 0, body: null, errorCode: null, errorMessage: message };
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
        if (!resp.ok && !Array.isArray(raw)) {
          const err = (raw as any)?.error || {};
          failAll(start, chunk.length, String(err.message || `HTTP ${resp.status}`));
          for (let k = 0; k < chunk.length; k++) results[start + k].errorCode = Number(err.code || 0) || null;
          return;
        }
      } catch {
        failAll(start, chunk.length, "Could not reach Facebook.");
        return;
      }

      const arr = Array.isArray(raw) ? raw : [];
      for (let k = 0; k < chunk.length; k++) {
        const item = arr[k] as { code?: number; body?: string } | null | undefined;
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

/** Last numeric value of a lifetime insight (video_insights). Objects are summed or picked by key. */
function lifetimeValue(body: any, pickKey?: string): number | null {
  const entry = Array.isArray(body?.data) ? body.data[0] : null;
  if (!entry) return null;
  const values = Array.isArray(entry.values) ? entry.values : [];
  const raw = values.length > 0 ? values[values.length - 1]?.value : entry.value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") {
    if (pickKey) {
      const keys = Object.keys(raw);
      const k = keys.find((x) => x.toLowerCase().startsWith(pickKey));
      return k ? num((raw as Record<string, unknown>)[k]) : 0;
    }
    return null;
  }
  return num(raw);
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

export async function getLiveAnalyticsDashboard(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  options: { days?: number; refresh?: boolean; encryptionKey: string }
): Promise<LiveAnalyticsDashboard> {
  const days = Math.min(90, Math.max(7, Math.floor(options.days || 30)));
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
  const sinceSec = nowSec - days * 86400;
  const since7 = nowSec - 7 * 86400;

  // ---- Round 1: Page info, daily Page insights, Reels list (per Page) ----
  type PageOpKind = { page: FacebookPageRecord; kind: "info" | "reels" | PageMetric };
  const ops1: BatchOp[] = [];
  const meta1: PageOpKind[] = [];
  for (const page of pages) {
    const id = encodeURIComponent(page.facebook_page_id);
    const token = page.page_access_token!;
    ops1.push({ relative_url: `${id}?fields=id,name,followers_count,fan_count,picture{url}`, token });
    meta1.push({ page, kind: "info" });
    ops1.push({
      relative_url: `${id}/video_reels?fields=id,description,created_time,permalink_url,likes.summary(true).limit(0),comments.summary(true).limit(0)&limit=${MAX_REELS_PER_PAGE}`,
      token
    });
    meta1.push({ page, kind: "reels" });
    for (const metric of PAGE_DAILY_METRICS) {
      ops1.push({
        relative_url: `${id}/insights?metric=${metric}&period=day&since=${sinceSec}&until=${nowSec}`,
        token
      });
      meta1.push({ page, kind: metric });
    }
  }
  const res1 = ops1.length > 0 ? await runGraphBatch(env, ops1) : [];

  const statsByPage = new Map<string, LivePageStats>();
  const daily = new Map<string, { views: number | null; engagement: number | null; new_follows: number | null }>();
  const reels: LiveReel[] = [];
  const pageViewMetricUsed = new Map<string, "page_media_view" | "page_video_views">();
  const pageMetricSeries = new Map<string, Partial<Record<PageMetric, Array<{ date: string; value: number }>>>>();
  let permissionProblem = false;

  for (const page of pages) {
    statsByPage.set(page.facebook_page_id, {
      page_id: page.facebook_page_id,
      page_name: page.page_name || page.name || page.facebook_page_id,
      avatar_url: page.avatar_url || "",
      followers: null,
      new_follows: null,
      views: null,
      engagement: null,
      reels_count: 0,
      reel_plays: null,
      reel_reach: null,
      likes: null,
      comments: null,
      shares: null,
      status: "ok",
      status_message: ""
    });
    pageMetricSeries.set(page.facebook_page_id, {});
  }

  res1.forEach((r, idx) => {
    const { page, kind } = meta1[idx];
    const stats = statsByPage.get(page.facebook_page_id)!;
    if (!r.ok) {
      const d = describeError(r);
      if (kind === "info" || kind === "reels") {
        stats.status = d.reconnect ? "reconnect" : "error";
        stats.status_message = d.message;
      } else if (stats.status === "ok") {
        stats.status = "partial";
        stats.status_message = "Some insights are not available for this Page.";
      }
      if (d.reconnect && (r.errorCode === 10 || r.errorCode === 200)) permissionProblem = true;
      return;
    }
    if (kind === "info") {
      stats.followers = num(r.body?.followers_count) ?? num(r.body?.fan_count);
      if (r.body?.name) stats.page_name = String(r.body.name);
      const pic = r.body?.picture?.data?.url;
      if (pic) stats.avatar_url = String(pic);
      return;
    }
    if (kind === "reels") {
      const list: any[] = Array.isArray(r.body?.data) ? r.body.data : [];
      for (const v of list) {
        const created = String(v.created_time || "");
        const t = Date.parse(created);
        if (!Number.isFinite(t) || t / 1000 < sinceSec) continue;
        reels.push({
          video_id: String(v.id || ""),
          page_id: page.facebook_page_id,
          page_name: stats.page_name,
          description: String(v.description || "").slice(0, 140),
          created_time: created,
          permalink_url: v.permalink_url
            ? String(v.permalink_url).startsWith("http")
              ? String(v.permalink_url)
              : `https://www.facebook.com${v.permalink_url}`
            : `https://www.facebook.com/reel/${v.id}`,
          plays: null,
          reach: null,
          likes: num(v.likes?.summary?.total_count),
          comments: num(v.comments?.summary?.total_count),
          shares: null
        });
      }
      return;
    }
    // Daily Page metric
    const entry = Array.isArray(r.body?.data) ? r.body.data[0] : null;
    const values: any[] = Array.isArray(entry?.values) ? entry.values : [];
    const series = values
      .map((v) => ({ date: insightDate(String(v.end_time || "")), value: num(v.value) }))
      .filter((v): v is { date: string; value: number } => Boolean(v.date) && v.value !== null);
    if (series.length > 0) pageMetricSeries.get(page.facebook_page_id)![kind] = series;
  });

  // Combine daily Page metrics (views prefer the newer page_media_view metric)
  for (const page of pages) {
    const stats = statsByPage.get(page.facebook_page_id)!;
    const m = pageMetricSeries.get(page.facebook_page_id)!;
    const viewKey = m.page_media_view ? "page_media_view" : m.page_video_views ? "page_video_views" : null;
    if (viewKey) pageViewMetricUsed.set(page.facebook_page_id, viewKey);
    const apply = (key: PageMetric | null, field: "views" | "engagement" | "new_follows") => {
      if (!key || !m[key]) return;
      let total = 0;
      for (const pt of m[key]!) {
        total += pt.value;
        const day = daily.get(pt.date) || { views: null, engagement: null, new_follows: null };
        day[field] = (day[field] ?? 0) + pt.value;
        daily.set(pt.date, day);
      }
      stats[field] = total;
    };
    apply(viewKey, "views");
    apply("page_post_engagements", "engagement");
    apply("page_daily_follows_unique", "new_follows");
  }

  // ---- Round 2: Reel insights ----
  reels.sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time));
  const reelsForInsights = reels.slice(0, MAX_REELS_TOTAL);
  if (reels.length > MAX_REELS_TOTAL) {
    warnings.push(`Showing insights for the ${MAX_REELS_TOTAL} most recent Reels.`);
  }
  const tokenByPage = new Map(pages.map((p) => [p.facebook_page_id, p.page_access_token!]));
  const ops2: BatchOp[] = [];
  const meta2: Array<{ reel: LiveReel; metric: ReelMetric }> = [];
  for (const reel of reelsForInsights) {
    for (const metric of REEL_METRICS) {
      ops2.push({
        relative_url: `${encodeURIComponent(reel.video_id)}/video_insights?metric=${metric}`,
        token: tokenByPage.get(reel.page_id)!
      });
      meta2.push({ reel, metric });
    }
  }
  const res2 = ops2.length > 0 ? await runGraphBatch(env, ops2) : [];
  const totalPlays = new Map<LiveReel, number | null>();
  const initialPlays = new Map<LiveReel, number | null>();
  res2.forEach((r, idx) => {
    if (!r.ok) return;
    const { reel, metric } = meta2[idx];
    if (metric === "fb_reels_total_plays") totalPlays.set(reel, lifetimeValue(r.body));
    else if (metric === "blue_reels_play_count") initialPlays.set(reel, lifetimeValue(r.body));
    else if (metric === "post_impressions_unique") reel.reach = lifetimeValue(r.body);
    else if (metric === "post_video_social_actions") reel.shares = lifetimeValue(r.body, "share");
  });
  for (const reel of reelsForInsights) {
    reel.plays = totalPlays.get(reel) ?? initialPlays.get(reel) ?? null;
  }

  // Per-page Reel totals
  for (const reel of reels) {
    const stats = statsByPage.get(reel.page_id);
    if (!stats) continue;
    stats.reels_count++;
    stats.reel_plays = addNullable(stats.reel_plays, reel.plays);
    stats.reel_reach = addNullable(stats.reel_reach, reel.reach);
    stats.likes = addNullable(stats.likes, reel.likes);
    stats.comments = addNullable(stats.comments, reel.comments);
    stats.shares = addNullable(stats.shares, reel.shares);
  }

  const pageStats = Array.from(statsByPage.values());
  const sumField = (field: "followers" | "new_follows" | "views" | "engagement" | "reel_plays") =>
    pageStats.reduce<number | null>((acc, p) => addNullable(acc, p[field]), null);

  const cutoff7 = new Date((since7 - 86400) * 1000).toISOString().slice(0, 10);
  let views7: number | null = null;
  const timeSeries = Array.from(daily.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => {
      if (date > cutoff7 && v.views !== null) views7 = (views7 ?? 0) + v.views;
      return { date, ...v };
    });

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
    fetched_at: new Date().toISOString(),
    cached: false,
    total_pages: allPages.length,
    total_followers: sumField("followers"),
    new_follows: sumField("new_follows"),
    views: sumField("views"),
    views_7d: views7,
    engagement: sumField("engagement"),
    reels_count: reels.length,
    reels_count_7d: reels.filter((r) => Date.parse(r.created_time) / 1000 >= since7).length,
    reel_plays: sumField("reel_plays"),
    pages: pageStats,
    time_series: timeSeries,
    top_reels: [...reelsForInsights]
      .sort((a, b) => (b.plays ?? -1) - (a.plays ?? -1))
      .slice(0, 10),
    warnings
  };
  cache.set(cacheKey, { at: nowMs, data });
  return data;
}
