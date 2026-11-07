/**
 * Meta Graph API v27.0 – Facebook Reels Insights & Analytics Service
 * - Thu thập số liệu thống kê thực tế từ Meta Graph API cho các Reels đã xuất bản (status = 'success')
 * - Sử dụng đúng Video ID cho `/{VIDEO_ID}/video_insights` và Post ID cho `/{POST_ID}`
 * - Xử lý độc lập từng metric (supported, unavailable, permission_required, no_data, retryable)
 * - Tuyệt đối không tự bịa số 0 hoặc dữ liệu giả khi Meta không trả về metric
 * - Lưu lịch sử Snapshot theo ngày (Asia/Ho_Chi_Minh) trong Cloudflare D1
 * - Tách biệt hoàn toàn khỏi luồng đăng Reels và luồng tự động bình luận
 */

import type {
  D1Database,
  Env,
  ReelInsightMetricItemRecord,
  ReelInsightSnapshotRecord
} from "../types.ts";
import {
  ensureTaskCommentColumns,
  getFacebookAccounts,
  getFacebookPages,
  getTask,
  getTasks,
  updateFacebookAccountStatus,
  updateTaskAnalyticsState
} from "../db.ts";
import {
  classifyMetaApiError,
  getMetaConfig,
  verifyPageTokenAndPermissions
} from "./metaGraphService.ts";
import { sanitizeSensitiveText } from "../utils/sanitize.ts";
import { formatUtcToVn } from "../utils/timezone.ts";

export const REEL_VIDEO_INSIGHT_METRICS = [
  "fb_reels_total_plays",
  "blue_reels_play_count",
  "fb_reels_replay_count",
  "post_video_avg_time_watched",
  "post_video_view_time",
  "post_video_social_actions",
  "post_impressions_unique",
  "post_video_retention_graph"
] as const;

export type ReelMetricStatus =
  | "supported"
  | "unavailable"
  | "permission_required"
  | "no_data"
  | "retryable";

export interface ParsedMetricOutcome {
  metric_name: string;
  label: string;
  value: number | null;
  json_value: string;
  status: ReelMetricStatus;
  error_message: string;
}

export const METRIC_LABELS: Record<string, string> = {
  fb_reels_total_plays: "Tổng lượt phát Reels (Initial + Replay)",
  blue_reels_play_count: "Lượt phát khởi đầu (Initial Plays)",
  fb_reels_replay_count: "Lượt phát lại (Replays)",
  views: "Lượt xem Video (Views)",
  post_impressions_unique: "Lượt tiếp cận duy nhất (Reach)",
  post_video_view_time: "Tổng thời gian xem (ms)",
  post_video_avg_time_watched: "Thời gian xem trung bình (ms)",
  post_video_social_actions: "Tương tác xã hội (Reactions / Comments / Shares)",
  likes: "Lượt thích / Cảm xúc",
  comments: "Bình luận",
  shares: "Lượt chia sẻ",
  post_video_retention_graph: "Biểu đồ giữ chân người xem (Retention)"
};

function getCurrentVnDateString(): string {
  const vn = formatUtcToVn(Math.floor(Date.now() / 1000));
  return vn.schedule_date;
}

function toVnDateString(isoOrUtc: string | number | null | undefined): string {
  if (!isoOrUtc) return getCurrentVnDateString();
  if (typeof isoOrUtc === "number") {
    return formatUtcToVn(isoOrUtc).schedule_date;
  }
  const parsed = Date.parse(String(isoOrUtc));
  if (!isNaN(parsed)) {
    return formatUtcToVn(Math.floor(parsed / 1000)).schedule_date;
  }
  return getCurrentVnDateString();
}

function toFiniteNumberOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function extractInsightEntryValue(entry: Record<string, unknown>): {
  numericValue: number | null;
  jsonValue: string;
} {
  const values = Array.isArray(entry.values)
    ? (entry.values as Array<{ value?: unknown }>)
    : [];
  const rawVal = values.length > 0 ? values[values.length - 1]?.value : entry.value;

  if (rawVal === null || rawVal === undefined) {
    return { numericValue: null, jsonValue: "" };
  }

  if (typeof rawVal === "number") {
    return { numericValue: Number.isFinite(rawVal) ? rawVal : null, jsonValue: String(rawVal) };
  }

  if (typeof rawVal === "string" && rawVal.trim() !== "") {
    const parsedNum = Number(rawVal);
    if (Number.isFinite(parsedNum)) {
      return { numericValue: parsedNum, jsonValue: rawVal };
    }
  }

  if (typeof rawVal === "object") {
    const jsonStr = JSON.stringify(rawVal);
    const obj = rawVal as Record<string, unknown>;
    let sum = 0;
    let hasNumericKey = false;
    for (const v of Object.values(obj)) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        sum += n;
        hasNumericKey = true;
      }
    }
    return {
      numericValue: Array.isArray(rawVal) ? null : hasNumericKey ? sum : null,
      jsonValue: jsonStr
    };
  }

  return { numericValue: null, jsonValue: "" };
}

/**
 * Đồng bộ dữ liệu Insights cho 1 Task Reels đã đăng thành công
 */
export async function syncSingleReelInsights(
  db: D1Database,
  env: Env,
  taskId: number,
  ownerUserId: string
): Promise<{
  success: boolean;
  analytics_status: string;
  task_id: number;
  video_id: string;
  post_id: string;
  synced_at: string;
  warnings: string[];
  error_type?: string;
  message: string;
  snapshot?: Record<string, unknown>;
  metrics?: ParsedMetricOutcome[];
}> {
  await ensureTaskCommentColumns(db);
  const cfg = getMetaConfig(env);
  const nowIso = new Date().toISOString();
  const syncDateVn = getCurrentVnDateString();
  const warnings: string[] = [];

  const task = await getTask(db, taskId, ownerUserId);
  if (!task) {
    return {
      success: false,
      analytics_status: "failed",
      task_id: taskId,
      video_id: "",
      post_id: "",
      synced_at: nowIso,
      warnings: [],
      message: "Không tìm thấy task hoặc bạn không có quyền truy cập."
    };
  }

  const isPublished =
    task.raw_status === "success" ||
    task.status === "success" ||
    task.publish_status === "success" ||
    Boolean(task.video_id && task.post_id);

  if (!isPublished || !task.video_id) {
    return {
      success: false,
      analytics_status: "not_synced",
      task_id: task.id,
      video_id: task.video_id || "",
      post_id: task.post_id || "",
      synced_at: nowIso,
      warnings: [],
      message: "Task này chưa đăng Reels thành công hoặc chưa có Video ID trên Facebook."
    };
  }

  const pageId = String(task.facebook_page_id || task.profile_id || "").trim();
  const videoId = String(task.video_id || "").trim();
  const postId = String(task.post_id || "").trim();

  await updateTaskAnalyticsState(db, task.id, "syncing", "", null);

  // Kiểm tra Token & Quyền trên Fanpage
  const permCheck = await verifyPageTokenAndPermissions(db, env, {
    facebookPageId: pageId,
    pageAccessToken: "",
    ownerUserId,
    mode: "insights"
  });

  if (permCheck.hasReadInsights === false) {
    warnings.push(
      "Access Token hiện tại chưa có quyền read_insights. Chức năng đăng Reels vẫn hoạt động, nhưng không thể lấy đầy đủ dữ liệu thống kê Reels."
    );
  }
  if (permCheck.canAnalyze === false) {
    warnings.push(
      "Tài khoản hiện không có quyền ANALYZE trên Page này để đọc Insights."
    );
  }

  if (!permCheck.valid || !permCheck.effectivePageToken) {
    const isExpired =
      permCheck.errorCategory === "TOKEN_EXPIRED" ||
      permCheck.errorCategory === "TOKEN_REVOKED" ||
      permCheck.errorCategory === "INVALID_TOKEN" ||
      permCheck.errorType === "TOKEN_EXPIRED" ||
      permCheck.errorType === "INVALID_PAGE_TOKEN";

    const finalStatus = isExpired ? "token_expired" : "permission_required";
    const errMsg =
      permCheck.message ||
      "Page Access Token không hợp lệ hoặc đã hết hạn. Vui lòng cập nhật Access Token.";

    await updateTaskAnalyticsState(db, task.id, finalStatus, errMsg, nowIso);
    return {
      success: false,
      analytics_status: finalStatus,
      task_id: task.id,
      video_id: videoId,
      post_id: postId,
      synced_at: nowIso,
      warnings,
      error_type: permCheck.errorCategory || permCheck.errorType || "INVALID_TOKEN",
      message: errMsg
    };
  }

  const pageToken = permCheck.effectivePageToken;
  const metricMap = new Map<string, ParsedMetricOutcome>();

  for (const mName of REEL_VIDEO_INSIGHT_METRICS) {
    metricMap.set(mName, {
      metric_name: mName,
      label: METRIC_LABELS[mName] || mName,
      value: null,
      json_value: "",
      status: "no_data",
      error_message: ""
    });
  }

  let tokenDeadDetected = false;
  let permissionDeniedDetected = false;
  let anyInsightSuccess = false;
  let topErrorCode: number | null = null;
  let topErrorMessage = "";

  // BƯỚC 1: Truy vấn /{VIDEO_ID}/video_insights (Dùng đúng Video ID của Reels)
  const batchMetricsParam = REEL_VIDEO_INSIGHT_METRICS.join(",");
  const videoInsightsUrl = `${cfg.graphBase}/${encodeURIComponent(videoId)}/video_insights?metric=${encodeURIComponent(batchMetricsParam)}&access_token=${encodeURIComponent(pageToken)}`;

  try {
    const viResp = await fetch(videoInsightsUrl);
    const viData = (await viResp.json().catch(() => ({}))) as Record<string, unknown>;

    if (viResp.ok && Array.isArray(viData.data)) {
      const returnedNames = new Set<string>();
      for (const item of viData.data as Array<Record<string, unknown>>) {
        const mName = String(item.name || "");
        if (!mName) continue;
        returnedNames.add(mName);
        const extracted = extractInsightEntryValue(item);
        const hasVal = extracted.numericValue !== null || Boolean(extracted.jsonValue);
        if (hasVal) anyInsightSuccess = true;
        metricMap.set(mName, {
          metric_name: mName,
          label: METRIC_LABELS[mName] || mName,
          value: extracted.numericValue,
          json_value: extracted.jsonValue,
          status: hasVal ? "supported" : "no_data",
          error_message: ""
        });
      }
      for (const mName of REEL_VIDEO_INSIGHT_METRICS) {
        if (!returnedNames.has(mName)) {
          const cur = metricMap.get(mName)!;
          cur.status = "no_data";
        }
      }
    } else {
      const errObj = (viData.error || {}) as Record<string, unknown>;
      const classified = classifyMetaApiError(errObj, viResp.status);
      topErrorCode = classified.code;
      topErrorMessage = classified.userMessage;

      if (classified.isTokenDead) {
        tokenDeadDetected = true;
      } else if (classified.isPermissionError) {
        permissionDeniedDetected = true;
        for (const mName of REEL_VIDEO_INSIGHT_METRICS) {
          metricMap.set(mName, {
            metric_name: mName,
            label: METRIC_LABELS[mName] || mName,
            value: null,
            json_value: "",
            status: "permission_required",
            error_message: classified.userMessage
          });
        }
      } else if (classified.code === 100) {
        // Một hoặc nhiều metric trong batch không được hỗ trợ cho loại Video/Reels này -> Thử từng metric độc lập!
        for (const singleMetric of REEL_VIDEO_INSIGHT_METRICS) {
          try {
            const singleResp = await fetch(
              `${cfg.graphBase}/${encodeURIComponent(videoId)}/video_insights?metric=${encodeURIComponent(singleMetric)}&access_token=${encodeURIComponent(pageToken)}`
            );
            const singleData = (await singleResp.json().catch(() => ({}))) as Record<
              string,
              unknown
            >;
            if (singleResp.ok && Array.isArray(singleData.data) && singleData.data.length > 0) {
              const entry = singleData.data[0] as Record<string, unknown>;
              const extracted = extractInsightEntryValue(entry);
              const hasVal = extracted.numericValue !== null || Boolean(extracted.jsonValue);
              if (hasVal) anyInsightSuccess = true;
              metricMap.set(singleMetric, {
                metric_name: singleMetric,
                label: METRIC_LABELS[singleMetric] || singleMetric,
                value: extracted.numericValue,
                json_value: extracted.jsonValue,
                status: hasVal ? "supported" : "no_data",
                error_message: ""
              });
            } else {
              const sErr = (singleData.error || {}) as Record<string, unknown>;
              const sClass = classifyMetaApiError(sErr, singleResp.status);
              metricMap.set(singleMetric, {
                metric_name: singleMetric,
                label: METRIC_LABELS[singleMetric] || singleMetric,
                value: null,
                json_value: "",
                status:
                  sClass.code === 100
                    ? "unavailable"
                    : sClass.isPermissionError
                      ? "permission_required"
                      : sClass.retryable
                        ? "retryable"
                        : "unavailable",
                error_message: sanitizeSensitiveText(String(sErr.message || ""))
              });
            }
          } catch (singleFetchErr) {
            metricMap.set(singleMetric, {
              metric_name: singleMetric,
              label: METRIC_LABELS[singleMetric] || singleMetric,
              value: null,
              json_value: "",
              status: "retryable",
              error_message: sanitizeSensitiveText((singleFetchErr as Error).message)
            });
          }
        }
      } else {
        for (const mName of REEL_VIDEO_INSIGHT_METRICS) {
          metricMap.set(mName, {
            metric_name: mName,
            label: METRIC_LABELS[mName] || mName,
            value: null,
            json_value: "",
            status: classified.retryable ? "retryable" : "unavailable",
            error_message: classified.userMessage
          });
        }
      }
    }
  } catch (netErr) {
    topErrorMessage = sanitizeSensitiveText(
      `Lỗi kết nối khi lấy video_insights: ${(netErr as Error).message}`
    );
    for (const mName of REEL_VIDEO_INSIGHT_METRICS) {
      metricMap.set(mName, {
        metric_name: mName,
        label: METRIC_LABELS[mName] || mName,
        value: null,
        json_value: "",
        status: "retryable",
        error_message: topErrorMessage
      });
    }
  }

  // BƯỚC 2: Truy vấn Node Video `/{VIDEO_ID}?fields=id,views,length,permalink_url,likes.summary(true),comments.summary(true)`
  let videoViews: number | null = null;
  let videoLengthSec: number | null = null;
  let videoLikes: number | null = null;
  let videoComments: number | null = null;

  if (!tokenDeadDetected) {
    try {
      const vNodeResp = await fetch(
        `${cfg.graphBase}/${encodeURIComponent(videoId)}?fields=id,views,length,permalink_url,likes.summary(true),comments.summary(true)&access_token=${encodeURIComponent(pageToken)}`
      );
      const vNodeData = (await vNodeResp.json().catch(() => ({}))) as Record<string, unknown>;
      if (vNodeResp.ok && vNodeData.id) {
        anyInsightSuccess = true;
        videoViews = toFiniteNumberOrNull(vNodeData.views);
        videoLengthSec = toFiniteNumberOrNull(vNodeData.length);
        const likesObj = (vNodeData.likes as { summary?: { total_count?: unknown } }) || {};
        const commentsObj = (vNodeData.comments as { summary?: { total_count?: unknown } }) || {};
        videoLikes = toFiniteNumberOrNull(likesObj.summary?.total_count);
        videoComments = toFiniteNumberOrNull(commentsObj.summary?.total_count);
      } else if (vNodeData.error) {
        const vErr = classifyMetaApiError(
          vNodeData.error as Record<string, unknown>,
          vNodeResp.status
        );
        if (vErr.isTokenDead) tokenDeadDetected = true;
      }
    } catch {}
  }

  // BƯỚC 3: Truy vấn Node Post `/{POST_ID}?fields=id,shares,reactions.summary(true),comments.summary(true)` (Dùng đúng Post ID)
  let postShares: number | null = null;
  let postReactions: number | null = null;
  let postComments: number | null = null;
  let postReachFallback: number | null = null;

  const candidatePostIds: string[] = [];
  if (postId && postId.includes("_")) candidatePostIds.push(postId);
  if (postId && !postId.includes("_") && pageId && postId !== pageId && postId !== videoId) {
    candidatePostIds.push(`${pageId}_${postId}`);
  }
  if (pageId && videoId) {
    const comp = `${pageId}_${videoId}`;
    if (!candidatePostIds.includes(comp)) candidatePostIds.push(comp);
  }
  if (postId && !candidatePostIds.includes(postId)) {
    candidatePostIds.push(postId);
  }

  if (!tokenDeadDetected && candidatePostIds.length > 0) {
    for (const targetPostId of candidatePostIds) {
      try {
        const pResp = await fetch(
          `${cfg.graphBase}/${encodeURIComponent(targetPostId)}?fields=id,shares,reactions.summary(true),comments.summary(true)&access_token=${encodeURIComponent(pageToken)}`
        );
        const pData = (await pResp.json().catch(() => ({}))) as Record<string, unknown>;
        if (pResp.ok && pData.id) {
          anyInsightSuccess = true;
          const sharesObj = (pData.shares as { count?: unknown }) || {};
          const reactionsObj =
            (pData.reactions as { summary?: { total_count?: unknown } }) || {};
          const commentsObj =
            (pData.comments as { summary?: { total_count?: unknown } }) || {};

          const sCount = toFiniteNumberOrNull(sharesObj.count);
          const rCount = toFiniteNumberOrNull(reactionsObj.summary?.total_count);
          const cCount = toFiniteNumberOrNull(commentsObj.summary?.total_count);

          if (sCount !== null) postShares = sCount;
          if (rCount !== null) postReactions = rCount;
          if (cCount !== null) postComments = cCount;

          // Nếu reach trên video_insights chưa có, thử lấy post_impressions_unique trên Post ID
          const currentReach = metricMap.get("post_impressions_unique")?.value ?? null;
          if (currentReach === null && !permissionDeniedDetected) {
            try {
              const pInsResp = await fetch(
                `${cfg.graphBase}/${encodeURIComponent(targetPostId)}/insights?metric=post_impressions_unique&access_token=${encodeURIComponent(pageToken)}`
              );
              const pInsData = (await pInsResp.json().catch(() => ({}))) as Record<
                string,
                unknown
              >;
              if (pInsResp.ok && Array.isArray(pInsData.data) && pInsData.data.length > 0) {
                const entry = pInsData.data[0] as Record<string, unknown>;
                const ext = extractInsightEntryValue(entry);
                if (ext.numericValue !== null) {
                  postReachFallback = ext.numericValue;
                  metricMap.set("post_impressions_unique", {
                    metric_name: "post_impressions_unique",
                    label: METRIC_LABELS.post_impressions_unique,
                    value: ext.numericValue,
                    json_value: ext.jsonValue,
                    status: "supported",
                    error_message: ""
                  });
                }
              }
            } catch {}
          }
          break;
        }
      } catch {}
    }
  }

  if (tokenDeadDetected) {
    await db
      .prepare(
        "UPDATE facebook_pages SET token_status = 'expired', status = 'expired', updated_at = ? WHERE facebook_page_id = ? AND owner_user_id = ?"
      )
      .bind(nowIso, pageId, ownerUserId)
      .run();

    const pageRow = await db
      .prepare(
        "SELECT connected_account_id FROM facebook_pages WHERE facebook_page_id = ? AND owner_user_id = ? LIMIT 1"
      )
      .bind(pageId, ownerUserId)
      .first<{ connected_account_id: string | null }>();
    if (pageRow?.connected_account_id) {
      await updateFacebookAccountStatus(
        db,
        pageRow.connected_account_id,
        "expired",
        topErrorMessage || "Access Token đã hết hạn khi đồng bộ Insights.",
        null,
        "expired"
      );
    }

    await updateTaskAnalyticsState(
      db,
      task.id,
      "token_expired",
      topErrorMessage || "Access Token đã hết hạn.",
      nowIso
    );

    return {
      success: false,
      analytics_status: "token_expired",
      task_id: task.id,
      video_id: videoId,
      post_id: postId,
      synced_at: nowIso,
      warnings,
      error_type: "TOKEN_EXPIRED",
      message: topErrorMessage || "Access Token đã hết hạn. Vui lòng cập nhật Access Token mới."
    };
  }

  // Tổng hợp các chỉ số chuẩn xác (TUYỆT ĐỐI KHÔNG tự gán 0 nếu tất cả nguồn đều trả null)
  const totalPlaysVal = metricMap.get("fb_reels_total_plays")?.value ?? null;
  const initialPlaysVal = metricMap.get("blue_reels_play_count")?.value ?? null;
  const replaysVal = metricMap.get("fb_reels_replay_count")?.value ?? null;
  const reachVal =
    metricMap.get("post_impressions_unique")?.value ?? postReachFallback ?? null;
  const totalWatchTimeMs = metricMap.get("post_video_view_time")?.value ?? null;
  const avgWatchTimeMs = metricMap.get("post_video_avg_time_watched")?.value ?? null;

  // Social actions từ video_insights (nếu có dạng JSON {reaction, comment, share} hoặc tổng)
  let socialReactions: number | null = null;
  let socialComments: number | null = null;
  let socialShares: number | null = null;
  const socialJsonStr = metricMap.get("post_video_social_actions")?.json_value || "";
  if (socialJsonStr.startsWith("{")) {
    try {
      const sObj = JSON.parse(socialJsonStr) as Record<string, unknown>;
      socialReactions = toFiniteNumberOrNull(
        sObj.reaction ?? sObj.reactions ?? sObj.like ?? sObj.likes
      );
      socialComments = toFiniteNumberOrNull(sObj.comment ?? sObj.comments);
      socialShares = toFiniteNumberOrNull(sObj.share ?? sObj.shares);
    } catch {}
  }

  const finalViews =
    totalPlaysVal !== null
      ? totalPlaysVal
      : videoViews !== null
        ? videoViews
        : initialPlaysVal !== null
          ? initialPlaysVal + (replaysVal ?? 0)
          : null;

  const finalPlays =
    totalPlaysVal !== null
      ? totalPlaysVal
      : initialPlaysVal !== null
        ? initialPlaysVal + (replaysVal ?? 0)
        : videoViews;

  const finalLikes =
    postReactions !== null
      ? postReactions
      : videoLikes !== null
        ? videoLikes
        : socialReactions;

  const finalComments =
    postComments !== null
      ? postComments
      : videoComments !== null
        ? videoComments
        : socialComments;

  const finalShares = postShares !== null ? postShares : socialShares;

  const socialTotalMetricVal = metricMap.get("post_video_social_actions")?.value ?? null;
  const hasAnyInteractionPart =
    finalLikes !== null || finalComments !== null || finalShares !== null;
  const finalTotalInteractions = hasAnyInteractionPart
    ? (finalLikes ?? 0) + (finalComments ?? 0) + (finalShares ?? 0)
    : socialTotalMetricVal;

  // Ghi nhận bổ sung các metric tổng hợp vào bảng metric_items để hiển thị chi tiết trên UI
  const extraMetrics: ParsedMetricOutcome[] = [
    {
      metric_name: "views",
      label: METRIC_LABELS.views,
      value: finalViews,
      json_value: finalViews !== null ? String(finalViews) : "",
      status: finalViews !== null ? "supported" : permissionDeniedDetected ? "permission_required" : "no_data",
      error_message: ""
    },
    {
      metric_name: "likes",
      label: METRIC_LABELS.likes,
      value: finalLikes,
      json_value: finalLikes !== null ? String(finalLikes) : "",
      status: finalLikes !== null ? "supported" : "no_data",
      error_message: ""
    },
    {
      metric_name: "comments",
      label: METRIC_LABELS.comments,
      value: finalComments,
      json_value: finalComments !== null ? String(finalComments) : "",
      status: finalComments !== null ? "supported" : "no_data",
      error_message: ""
    },
    {
      metric_name: "shares",
      label: METRIC_LABELS.shares,
      value: finalShares,
      json_value: finalShares !== null ? String(finalShares) : "",
      status: finalShares !== null ? "supported" : "no_data",
      error_message: ""
    }
  ];

  for (const em of extraMetrics) {
    metricMap.set(em.metric_name, em);
  }

  const allMetricOutcomes = Array.from(metricMap.values());
  const supportedCount = allMetricOutcomes.filter((m) => m.status === "supported").length;
  const permErrorCount = allMetricOutcomes.filter(
    (m) => m.status === "permission_required"
  ).length;

  let finalAnalyticsStatus = "success";
  if (supportedCount === 0 && permErrorCount > 0) {
    finalAnalyticsStatus = "permission_required";
  } else if (supportedCount === 0 && !anyInsightSuccess) {
    finalAnalyticsStatus = topErrorMessage ? "failed" : "no_data";
  } else if (permErrorCount > 0 || warnings.length > 0) {
    finalAnalyticsStatus = "partial";
  }

  const retentionJson =
    metricMap.get("post_video_retention_graph")?.json_value || "[]";
  const rawMetricsObj: Record<string, unknown> = {};
  for (const m of allMetricOutcomes) {
    rawMetricsObj[m.metric_name] = {
      value: m.value,
      status: m.status,
      error: m.error_message || undefined
    };
  }

  // Lưu Snapshot vào D1 (Chống ghi trùng dữ liệu bằng ON CONFLICT(task_id, sync_date) DO UPDATE)
  await db
    .prepare(
      `INSERT INTO reel_insight_snapshots (
         owner_user_id, task_id, facebook_page_id, video_id, post_id,
         sync_date, synced_at, sync_status,
         views, plays, initial_plays, replays, reach,
         likes, comments, shares, total_interactions,
         total_watch_time_ms, avg_watch_time_ms, video_length_sec,
         retention_json, raw_metrics_json, error_code, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, sync_date) DO UPDATE SET
         synced_at = excluded.synced_at,
         sync_status = excluded.sync_status,
         views = COALESCE(excluded.views, reel_insight_snapshots.views),
         plays = COALESCE(excluded.plays, reel_insight_snapshots.plays),
         initial_plays = COALESCE(excluded.initial_plays, reel_insight_snapshots.initial_plays),
         replays = COALESCE(excluded.replays, reel_insight_snapshots.replays),
         reach = COALESCE(excluded.reach, reel_insight_snapshots.reach),
         likes = COALESCE(excluded.likes, reel_insight_snapshots.likes),
         comments = COALESCE(excluded.comments, reel_insight_snapshots.comments),
         shares = COALESCE(excluded.shares, reel_insight_snapshots.shares),
         total_interactions = COALESCE(excluded.total_interactions, reel_insight_snapshots.total_interactions),
         total_watch_time_ms = COALESCE(excluded.total_watch_time_ms, reel_insight_snapshots.total_watch_time_ms),
         avg_watch_time_ms = COALESCE(excluded.avg_watch_time_ms, reel_insight_snapshots.avg_watch_time_ms),
         video_length_sec = COALESCE(excluded.video_length_sec, reel_insight_snapshots.video_length_sec),
         retention_json = CASE WHEN excluded.retention_json != '[]' AND excluded.retention_json != '' THEN excluded.retention_json ELSE reel_insight_snapshots.retention_json END,
         raw_metrics_json = excluded.raw_metrics_json,
         error_code = excluded.error_code,
         error_message = excluded.error_message`
    )
    .bind(
      ownerUserId,
      task.id,
      pageId,
      videoId,
      postId,
      syncDateVn,
      nowIso,
      finalAnalyticsStatus,
      finalViews,
      finalPlays,
      initialPlaysVal,
      replaysVal,
      reachVal,
      finalLikes,
      finalComments,
      finalShares,
      finalTotalInteractions,
      totalWatchTimeMs,
      avgWatchTimeMs,
      videoLengthSec,
      retentionJson || "[]",
      JSON.stringify(rawMetricsObj),
      topErrorCode,
      sanitizeSensitiveText(topErrorMessage || warnings.join(" | "))
    )
    .run();

  // Lưu từng metric_item vào D1
  const metricStmts = allMetricOutcomes.map((m) =>
    db
      .prepare(
        `INSERT INTO reel_insight_metric_items (
           owner_user_id, task_id, facebook_page_id, video_id, post_id,
           metric_name, metric_value, metric_json, period, fetched_at, status, error_message
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lifetime', ?, ?, ?)
         ON CONFLICT(task_id, metric_name) DO UPDATE SET
           metric_value = excluded.metric_value,
           metric_json = excluded.metric_json,
           fetched_at = excluded.fetched_at,
           status = excluded.status,
           error_message = excluded.error_message`
      )
      .bind(
        ownerUserId,
        task.id,
        pageId,
        videoId,
        postId,
        m.metric_name,
        m.value,
        m.json_value || "",
        nowIso,
        m.status,
        sanitizeSensitiveText(m.error_message || "")
      )
  );
  if (metricStmts.length > 0) {
    await db.batch(metricStmts);
  }

  await updateTaskAnalyticsState(
    db,
    task.id,
    finalAnalyticsStatus,
    topErrorMessage || warnings.join(" | "),
    nowIso
  );

  return {
    success: finalAnalyticsStatus === "success" || finalAnalyticsStatus === "partial",
    analytics_status: finalAnalyticsStatus,
    task_id: task.id,
    video_id: videoId,
    post_id: postId,
    synced_at: nowIso,
    warnings,
    message:
      finalAnalyticsStatus === "permission_required"
        ? warnings[0] || topErrorMessage || "Thiếu quyền read_insights hoặc ANALYZE để đọc đầy đủ thống kê."
        : "Đã đồng bộ dữ liệu thống kê Reels từ Meta Graph API.",
    snapshot: {
      task_id: task.id,
      sync_date: syncDateVn,
      synced_at: nowIso,
      sync_status: finalAnalyticsStatus,
      views: finalViews,
      plays: finalPlays,
      initial_plays: initialPlaysVal,
      replays: replaysVal,
      reach: reachVal,
      likes: finalLikes,
      comments: finalComments,
      shares: finalShares,
      total_interactions: finalTotalInteractions,
      total_watch_time_ms: totalWatchTimeMs,
      avg_watch_time_ms: avgWatchTimeMs,
      video_length_sec: videoLengthSec
    },
    metrics: allMetricOutcomes
  };
}

/**
 * Đồng bộ hàng loạt Insights cho các Reels đã xuất bản của người dùng (Theo yêu cầu thủ công từ nút Làm mới)
 */
export async function syncUserReelsInsights(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  options?: {
    facebookPageId?: string | null;
    taskId?: number | null;
    limit?: number;
  }
): Promise<{
  success: boolean;
  synced_count: number;
  partial_count: number;
  failed_count: number;
  token_expired_count: number;
  permission_missing_count: number;
  warnings: string[];
  results: unknown[];
  message: string;
}> {
  await ensureTaskCommentColumns(db);

  if (options?.taskId) {
    const single = await syncSingleReelInsights(db, env, Number(options.taskId), ownerUserId);
    return {
      success: single.success,
      synced_count: single.success ? 1 : 0,
      partial_count: single.analytics_status === "partial" ? 1 : 0,
      failed_count: single.success ? 0 : 1,
      token_expired_count: single.analytics_status === "token_expired" ? 1 : 0,
      permission_missing_count: single.analytics_status === "permission_required" ? 1 : 0,
      warnings: single.warnings,
      results: [single],
      message: single.message
    };
  }

  const allTasks = await getTasks(db, {
    facebookPageId: options?.facebookPageId || null,
    ownerUserId
  });

  const publishedTasks = allTasks.filter(
    (t) =>
      (t.raw_status === "success" || t.status === "success" || t.publish_status === "success") &&
      Boolean(t.video_id && t.video_id.trim())
  );

  const maxItems = Math.min(Math.max(options?.limit || 20, 1), 50);
  const targets = publishedTasks.slice(0, maxItems);

  let syncedCount = 0;
  let partialCount = 0;
  let failedCount = 0;
  let tokenExpiredCount = 0;
  let permMissingCount = 0;
  const warningsSet = new Set<string>();
  const results: unknown[] = [];

  for (const t of targets) {
    const res = await syncSingleReelInsights(db, env, t.id, ownerUserId);
    results.push(res);
    for (const w of res.warnings) warningsSet.add(w);
    if (res.success) {
      syncedCount++;
      if (res.analytics_status === "partial") partialCount++;
    } else {
      failedCount++;
      if (res.analytics_status === "token_expired") tokenExpiredCount++;
      if (res.analytics_status === "permission_required") permMissingCount++;
    }
  }

  const warnings = Array.from(warningsSet);
  return {
    success: targets.length === 0 || syncedCount > 0,
    synced_count: syncedCount,
    partial_count: partialCount,
    failed_count: failedCount,
    token_expired_count: tokenExpiredCount,
    permission_missing_count: permMissingCount,
    warnings,
    results,
    message:
      targets.length === 0
        ? "Chưa có bài Reels nào đã đăng thành công để đồng bộ thống kê."
        : `Đã đồng bộ thống kê ${syncedCount}/${targets.length} bài Reels.`
  };
}

/**
 * Đồng bộ định kỳ tự động trong nền (Cron Background Sync) có kiểm soát Rate Limit
 * - Chỉ chọn tối đa `maxBatchSize` bài Reels đã đăng thành công có `analytics_last_synced_at` cũ hơn `minIntervalMinutes`
 * - Cô lập hoàn toàn lỗi để không bao giờ ảnh hưởng tới luồng đăng bài hay comment
 */
export async function syncDueReelsInsightsBatch(
  db: D1Database,
  env: Env,
  maxBatchSize = 3,
  minIntervalMinutes = 30
): Promise<{ processed: number; succeeded: number }> {
  try {
    await ensureTaskCommentColumns(db);
    const cutoffIso = new Date(Date.now() - minIntervalMinutes * 60 * 1000).toISOString();

    const { results: dueRows } = await db
      .prepare(
        `SELECT id, owner_user_id
         FROM tasks
         WHERE status = 'success'
           AND video_id != ''
           AND (analytics_status IS NULL OR analytics_status != 'token_expired')
           AND (analytics_last_synced_at IS NULL OR analytics_last_synced_at < ?)
         ORDER BY CASE WHEN analytics_last_synced_at IS NULL THEN 0 ELSE 1 END ASC,
                  published_at DESC,
                  id DESC
         LIMIT ?`
      )
      .bind(cutoffIso, maxBatchSize)
      .all<{ id: number; owner_user_id: string }>();

    if (!dueRows || dueRows.length === 0) {
      return { processed: 0, succeeded: 0 };
    }

    let succeeded = 0;
    for (const row of dueRows) {
      try {
        const res = await syncSingleReelInsights(db, env, Number(row.id), String(row.owner_user_id));
        if (res.success) succeeded++;
      } catch {}
    }

    return { processed: dueRows.length, succeeded };
  } catch {
    return { processed: 0, succeeded: 0 };
  }
}

/**
 * Truy vấn dữ liệu tổng hợp cho Trang Thống Kê Reels (Dashboard + 8 Stat Cards + 5 Biểu đồ + Bảng Reels)
 */
export async function getReelsAnalyticsDashboard(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  filters?: {
    facebookPageId?: string | null;
    range?: string | null; // '7d' | '30d' | '90d' | 'custom'
    startDate?: string | null; // YYYY-MM-DD (Asia/Ho_Chi_Minh)
    endDate?: string | null; // YYYY-MM-DD (Asia/Ho_Chi_Minh)
    search?: string | null;
    sortBy?: string | null; // 'views' | 'reach' | 'interactions' | 'watch_time' | 'published_at'
    sortDir?: string | null; // 'asc' | 'desc'
  }
): Promise<Record<string, unknown>> {
  await ensureTaskCommentColumns(db);
  const cfg = getMetaConfig(env);

  const [accounts, pages, allTasks] = await Promise.all([
    getFacebookAccounts(db, cfg.encryptionKey, false, ownerUserId),
    getFacebookPages(db, cfg.encryptionKey, { includeToken: false, ownerUserId }),
    getTasks(db, {
      facebookPageId:
        filters?.facebookPageId && filters.facebookPageId !== "all"
          ? filters.facebookPageId
          : null,
      search: filters?.search || null,
      ownerUserId
    })
  ]);

  // Kiểm tra cảnh báo quyền read_insights và ANALYZE
  const connectedAccounts = accounts.filter((a) => a.status === "connected");
  const expiredAccounts = accounts.filter(
    (a) =>
      a.status === "expired" ||
      a.token_status === "expired" ||
      a.token_status === "revoked" ||
      a.token_status === "invalid" ||
      Boolean(a.is_expired)
  );
  const hasReadInsights =
    connectedAccounts.length > 0 && connectedAccounts.some((a) => Boolean(a.has_read_insights));

  const targetPageFilter =
    filters?.facebookPageId && filters.facebookPageId !== "all"
      ? filters.facebookPageId
      : null;

  const relevantPages = targetPageFilter
    ? pages.filter((p) => p.facebook_page_id === targetPageFilter || p.id === targetPageFilter)
    : pages;
  const pagesMissingAnalyze = relevantPages.filter((p) => !p.can_analyze);
  const pagesMissingPermission = relevantPages.filter(
    (p) => p.status === "missing_permission" || p.token_status === "missing_permission"
  );

  const permissionWarnings: string[] = [];
  if (accounts.length > 0 && !hasReadInsights) {
    permissionWarnings.push(
      "Access Token hiện tại chưa có quyền read_insights. Chức năng đăng Reels vẫn hoạt động, nhưng không thể lấy đầy đủ dữ liệu thống kê Reels."
    );
  }
  if (pagesMissingAnalyze.length > 0) {
    permissionWarnings.push(
      "Tài khoản hiện không có quyền ANALYZE trên Page này để đọc Insights."
    );
  }
  if (pagesMissingPermission.length > 0) {
    permissionWarnings.push(
      "Page này chưa có trong token mới hoặc thiếu quyền quản lý."
    );
  }

  // Lọc theo khoảng thời gian (Asia/Ho_Chi_Minh)
  const rangeKey = (filters?.range || "30d").toLowerCase();
  const todayVn = getCurrentVnDateString();
  let startDateVn = "";
  let endDateVn = todayVn;

  if (rangeKey === "custom" && (filters?.startDate || filters?.endDate)) {
    startDateVn = (filters?.startDate || "2000-01-01").trim();
    endDateVn = (filters?.endDate || todayVn).trim();
  } else {
    const days = rangeKey === "7d" ? 7 : rangeKey === "90d" ? 90 : 30;
    const cutoffSec = Math.floor(Date.now() / 1000) - (days - 1) * 86400;
    startDateVn = formatUtcToVn(cutoffSec).schedule_date;
  }

  const publishedTasks = allTasks.filter((t) => {
    const isPub =
      t.raw_status === "success" ||
      t.status === "success" ||
      t.publish_status === "success" ||
      Boolean(t.video_id && t.post_id);
    if (!isPub) return false;
    const pubDateVn = toVnDateString(t.published_at || t.updated_at || t.created_at);
    if (startDateVn && pubDateVn < startDateVn) return false;
    if (endDateVn && pubDateVn > endDateVn) return false;
    return true;
  });

  // Lấy toàn bộ bản ghi snapshot mới nhất cho từng task và lịch sử theo ngày trong khoảng chọn
  const { results: allSnapshots } = await db
    .prepare(
      `SELECT * FROM reel_insight_snapshots
       WHERE owner_user_id = ?
       ORDER BY sync_date DESC, id DESC`
    )
    .bind(ownerUserId)
    .all<ReelInsightSnapshotRecord>();

  const latestSnapshotByTaskId = new Map<number, ReelInsightSnapshotRecord>();
  for (const snap of allSnapshots || []) {
    const tid = Number(snap.task_id);
    if (!latestSnapshotByTaskId.has(tid)) {
      latestSnapshotByTaskId.set(tid, snap);
    }
  }

  // Kết hợp từng Task đã đăng với Snapshot mới nhất
  const reelsItems = publishedTasks.map((t) => {
    const snap = latestSnapshotByTaskId.get(t.id) || null;
    const pubDateVn = toVnDateString(t.published_at || t.updated_at || t.created_at);
    const views = snap ? toFiniteNumberOrNull(snap.views ?? snap.plays) : null;
    const plays = snap ? toFiniteNumberOrNull(snap.plays ?? snap.views) : null;
    const initialPlays = snap ? toFiniteNumberOrNull(snap.initial_plays) : null;
    const replays = snap ? toFiniteNumberOrNull(snap.replays) : null;
    const reach = snap ? toFiniteNumberOrNull(snap.reach) : null;
    const likes = snap ? toFiniteNumberOrNull(snap.likes) : null;
    const comments = snap ? toFiniteNumberOrNull(snap.comments) : null;
    const shares = snap ? toFiniteNumberOrNull(snap.shares) : null;
    const totalInteractions = snap ? toFiniteNumberOrNull(snap.total_interactions) : null;
    const totalWatchTimeMs = snap ? toFiniteNumberOrNull(snap.total_watch_time_ms) : null;
    const avgWatchTimeMs = snap ? toFiniteNumberOrNull(snap.avg_watch_time_ms) : null;
    const videoLengthSec = snap ? toFiniteNumberOrNull(snap.video_length_sec) : null;

    return {
      task_id: t.id,
      facebook_page_id: t.facebook_page_id,
      page_name: t.page_name || t.facebook_page_id || "Unnamed Page",
      page_avatar: t.page_avatar || "",
      caption: t.caption || "(Không có caption)",
      video_id: t.video_id || "",
      post_id: t.post_id || "",
      permalink_url:
        t.video_url || (t.video_id ? `https://www.facebook.com/reel/${t.video_id}` : ""),
      published_at: t.published_at || t.updated_at || t.created_at,
      published_date_vn: pubDateVn,
      publish_status: "success",
      is_locked: true,
      comment_status: t.comment_status || "none",
      comment_id: t.comment_id || "",
      analytics_status: t.analytics_status || (snap ? snap.sync_status : "not_synced"),
      analytics_last_synced_at: t.analytics_last_synced_at || snap?.synced_at || null,
      analytics_error: t.analytics_error || snap?.error_message || "",
      views,
      plays,
      initial_plays: initialPlays,
      replays,
      reach,
      likes,
      comments,
      shares,
      total_interactions: totalInteractions,
      total_watch_time_ms: totalWatchTimeMs,
      avg_watch_time_ms: avgWatchTimeMs,
      video_length_sec: videoLengthSec
    };
  });

  // Sắp xếp danh sách Reels theo bộ lọc (views, reach, interactions, watch_time, published_at)
  const sortBy = (filters?.sortBy || "published_at").toLowerCase();
  const sortDir = (filters?.sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;

  reelsItems.sort((a, b) => {
    if (sortBy === "views") {
      const va = a.views ?? -1;
      const vb = b.views ?? -1;
      return (va - vb) * sortDir;
    }
    if (sortBy === "reach") {
      const ra = a.reach ?? -1;
      const rb = b.reach ?? -1;
      return (ra - rb) * sortDir;
    }
    if (sortBy === "interactions") {
      const ia = a.total_interactions ?? -1;
      const ib = b.total_interactions ?? -1;
      return (ia - ib) * sortDir;
    }
    if (sortBy === "watch_time") {
      const wa = a.total_watch_time_ms ?? -1;
      const wb = b.total_watch_time_ms ?? -1;
      return (wa - wb) * sortDir;
    }
    const ta = Date.parse(String(a.published_at || "")) || a.task_id;
    const tb = Date.parse(String(b.published_at || "")) || b.task_id;
    return (ta - tb) * sortDir;
  });

  // Tính toán 8 Thẻ chỉ số tổng quan (Overview Cards) - Tuyệt đối không tự bịa 0 nếu tất cả đều null
  const sumNullable = (vals: Array<number | null>): { total: number | null; count: number } => {
    let sum = 0;
    let count = 0;
    for (const v of vals) {
      if (v !== null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return { total: count > 0 ? sum : null, count };
  };

  const viewsAgg = sumNullable(reelsItems.map((r) => r.views));
  const reachAgg = sumNullable(reelsItems.map((r) => r.reach));
  const interactionsAgg = sumNullable(reelsItems.map((r) => r.total_interactions));
  const likesAgg = sumNullable(reelsItems.map((r) => r.likes));
  const commentsAgg = sumNullable(reelsItems.map((r) => r.comments));
  const sharesAgg = sumNullable(reelsItems.map((r) => r.shares));
  const watchTimeAgg = sumNullable(reelsItems.map((r) => r.total_watch_time_ms));
  const avgWatchAgg = sumNullable(reelsItems.map((r) => r.avg_watch_time_ms));

  const avgWatchTimeMsOverall =
    avgWatchAgg.total !== null && avgWatchAgg.count > 0
      ? Math.round(avgWatchAgg.total / avgWatchAgg.count)
      : null;

  // 5 Biểu đồ (Charts Data)
  // 1. Line chart: Lượt xem theo ngày đăng / ngày snapshot
  const viewsByDateMap = new Map<
    string,
    { date: string; views: number | null; reach: number | null; interactions: number | null; reels_count: number }
  >();
  for (const item of reelsItems) {
    const d = item.published_date_vn || todayVn;
    const cur = viewsByDateMap.get(d) || {
      date: d,
      views: null,
      reach: null,
      interactions: null,
      reels_count: 0
    };
    cur.reels_count++;
    if (item.views !== null) cur.views = (cur.views ?? 0) + item.views;
    if (item.reach !== null) cur.reach = (cur.reach ?? 0) + item.reach;
    if (item.total_interactions !== null) {
      cur.interactions = (cur.interactions ?? 0) + item.total_interactions;
    }
    viewsByDateMap.set(d, cur);
  }
  const viewsOverTime = Array.from(viewsByDateMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  // 2. Bar chart: Hiệu suất từng Reels (Top 12 Reels)
  const performanceByReel = reelsItems.slice(0, 12).map((r) => ({
    task_id: r.task_id,
    label: `#${r.task_id} ${(r.caption || "").slice(0, 24)}`,
    page_name: r.page_name,
    views: r.views,
    reach: r.reach,
    total_interactions: r.total_interactions
  }));

  // 3. Tương tác (Likes, Comments, Shares)
  const interactionsChart = reelsItems.slice(0, 12).map((r) => ({
    task_id: r.task_id,
    label: `#${r.task_id} ${(r.caption || "").slice(0, 22)}`,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    total_interactions: r.total_interactions
  }));

  // 4. Thời gian xem (Watch time & Average watch time)
  const watchTimeChart = reelsItems.slice(0, 12).map((r) => ({
    task_id: r.task_id,
    label: `#${r.task_id} ${(r.caption || "").slice(0, 22)}`,
    total_watch_time_ms: r.total_watch_time_ms,
    avg_watch_time_ms: r.avg_watch_time_ms,
    video_length_sec: r.video_length_sec
  }));

  // 5. So sánh hiệu suất giữa các Fanpage
  const pageCompMap = new Map<
    string,
    {
      facebook_page_id: string;
      page_name: string;
      reels_count: number;
      views: number | null;
      reach: number | null;
      total_interactions: number | null;
      total_watch_time_ms: number | null;
    }
  >();

  for (const r of reelsItems) {
    const pid = r.facebook_page_id || "unassigned";
    const cur = pageCompMap.get(pid) || {
      facebook_page_id: pid,
      page_name: r.page_name || pid,
      reels_count: 0,
      views: null,
      reach: null,
      total_interactions: null,
      total_watch_time_ms: null
    };
    cur.reels_count++;
    if (r.views !== null) cur.views = (cur.views ?? 0) + r.views;
    if (r.reach !== null) cur.reach = (cur.reach ?? 0) + r.reach;
    if (r.total_interactions !== null) {
      cur.total_interactions = (cur.total_interactions ?? 0) + r.total_interactions;
    }
    if (r.total_watch_time_ms !== null) {
      cur.total_watch_time_ms = (cur.total_watch_time_ms ?? 0) + r.total_watch_time_ms;
    }
    pageCompMap.set(pid, cur);
  }
  const pageComparison = Array.from(pageCompMap.values()).sort(
    (a, b) => (b.views ?? -1) - (a.views ?? -1)
  );

  const lastSyncedAt =
    reelsItems
      .map((r) => r.analytics_last_synced_at)
      .filter((x): x is string => Boolean(x))
      .sort()
      .reverse()[0] || null;

  return {
    success: true,
    filters: {
      facebook_page_id: targetPageFilter || "all",
      range: rangeKey,
      start_date: startDateVn,
      end_date: endDateVn,
      search: filters?.search || "",
      sort_by: sortBy,
      sort_dir: sortDir === 1 ? "asc" : "desc"
    },
    token_health: {
      has_read_insights: hasReadInsights,
      expired_accounts_count: expiredAccounts.length,
      pages_missing_analyze_count: pagesMissingAnalyze.length,
      pages_missing_permission_count: pagesMissingPermission.length,
      warnings: permissionWarnings
    },
    last_synced_at: lastSyncedAt,
    total_published_reels: reelsItems.length,
    overview: {
      total_views: viewsAgg.total,
      total_reach: reachAgg.total,
      total_interactions: interactionsAgg.total,
      total_likes: likesAgg.total,
      total_comments: commentsAgg.total,
      total_shares: sharesAgg.total,
      total_watch_time_ms: watchTimeAgg.total,
      avg_watch_time_ms: avgWatchTimeMsOverall
    },
    charts: {
      views_over_time: viewsOverTime,
      performance_by_reel: performanceByReel,
      interactions_breakdown: interactionsChart,
      watch_time: watchTimeChart,
      page_comparison: pageComparison
    },
    reels: reelsItems,
    pages: pages.map((p) => ({
      id: p.id,
      facebook_page_id: p.facebook_page_id,
      page_name: p.page_name,
      avatar_url: p.avatar_url,
      can_post: p.can_post,
      can_analyze: Boolean(p.can_analyze),
      status: p.status,
      token_status: p.token_status
    }))
  };
}

/**
 * Truy vấn chi tiết thống kê của 1 bài Reels cụ thể (Bao gồm lịch sử Snapshot theo thời gian & trạng thái từng Metric)
 */
export async function getSingleReelInsightDetail(
  db: D1Database,
  _env: Env,
  taskId: number,
  ownerUserId: string
): Promise<Record<string, unknown> | null> {
  await ensureTaskCommentColumns(db);
  const task = await getTask(db, taskId, ownerUserId);
  if (!task) return null;

  const [snapshotsRes, metricsRes] = await db.batch([
    db
      .prepare(
        `SELECT * FROM reel_insight_snapshots
         WHERE task_id = ? AND owner_user_id = ?
         ORDER BY sync_date DESC, synced_at DESC
         LIMIT 90`
      )
      .bind(task.id, ownerUserId),
    db
      .prepare(
        `SELECT * FROM reel_insight_metric_items
         WHERE task_id = ? AND owner_user_id = ?
         ORDER BY id ASC`
      )
      .bind(task.id, ownerUserId)
  ]);

  const snapshots = (snapshotsRes.results || []) as unknown as ReelInsightSnapshotRecord[];
  const metricItems = (metricsRes.results || []) as unknown as ReelInsightMetricItemRecord[];
  const latest = snapshots[0] || null;

  let retentionGraph: unknown = [];
  if (latest?.retention_json) {
    try {
      retentionGraph = JSON.parse(latest.retention_json);
    } catch {
      retentionGraph = [];
    }
  }

  return {
    success: true,
    task: {
      id: task.id,
      facebook_page_id: task.facebook_page_id,
      page_name: task.page_name || task.facebook_page_id,
      page_avatar: task.page_avatar || "",
      caption: task.caption,
      comment_text: task.comment_text,
      comment_status: task.comment_status,
      comment_id: task.comment_id,
      comment_log: task.comment_log,
      publish_status: task.publish_status || task.raw_status,
      is_locked: Boolean(task.is_locked),
      video_id: task.video_id,
      post_id: task.post_id,
      permalink_url:
        task.video_url ||
        (task.video_id ? `https://www.facebook.com/reel/${task.video_id}` : ""),
      published_at: task.published_at || task.updated_at || task.created_at,
      analytics_status: task.analytics_status || (latest ? latest.sync_status : "not_synced"),
      analytics_last_synced_at: task.analytics_last_synced_at || latest?.synced_at || null,
      analytics_error: task.analytics_error || latest?.error_message || ""
    },
    latest_snapshot: latest
      ? {
          sync_date: latest.sync_date,
          synced_at: latest.synced_at,
          sync_status: latest.sync_status,
          views: toFiniteNumberOrNull(latest.views),
          plays: toFiniteNumberOrNull(latest.plays),
          initial_plays: toFiniteNumberOrNull(latest.initial_plays),
          replays: toFiniteNumberOrNull(latest.replays),
          reach: toFiniteNumberOrNull(latest.reach),
          likes: toFiniteNumberOrNull(latest.likes),
          comments: toFiniteNumberOrNull(latest.comments),
          shares: toFiniteNumberOrNull(latest.shares),
          total_interactions: toFiniteNumberOrNull(latest.total_interactions),
          total_watch_time_ms: toFiniteNumberOrNull(latest.total_watch_time_ms),
          avg_watch_time_ms: toFiniteNumberOrNull(latest.avg_watch_time_ms),
          video_length_sec: toFiniteNumberOrNull(latest.video_length_sec),
          retention_graph: retentionGraph
        }
      : null,
    metrics: metricItems.map((m) => ({
      metric_name: m.metric_name,
      label: METRIC_LABELS[m.metric_name] || m.metric_name,
      value: toFiniteNumberOrNull(m.metric_value),
      metric_json: m.metric_json,
      period: m.period,
      fetched_at: m.fetched_at,
      status: m.status,
      error_message: m.error_message
    })),
    history: snapshots.map((s) => ({
      sync_date: s.sync_date,
      synced_at: s.synced_at,
      sync_status: s.sync_status,
      views: toFiniteNumberOrNull(s.views),
      plays: toFiniteNumberOrNull(s.plays),
      reach: toFiniteNumberOrNull(s.reach),
      likes: toFiniteNumberOrNull(s.likes),
      comments: toFiniteNumberOrNull(s.comments),
      shares: toFiniteNumberOrNull(s.shares),
      total_interactions: toFiniteNumberOrNull(s.total_interactions),
      total_watch_time_ms: toFiniteNumberOrNull(s.total_watch_time_ms),
      avg_watch_time_ms: toFiniteNumberOrNull(s.avg_watch_time_ms)
    }))
  };
}
