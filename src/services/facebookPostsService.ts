/**
 * Facebook Posts Service - Cloudflare Workers + D1 + Meta Graph API (v27.0)
 * Quản lý toàn diện bài viết Facebook: Reels, Video, Photo, Album, Status, Link
 * Tách biệt Posts (Kho lưu trữ tập trung) và Tasks (Hàng đợi đăng bài)
 */

import type { Env, D1Database } from "../types.ts";
import { getEncryptionKeyMaterial, decryptToken } from "../utils/crypto.ts";
import { deleteFacebookReelOrPost } from "./metaGraphService.ts";
import { getFacebookPageByFbId } from "../db.ts";

export interface FacebookPostRecord {
  id: number;
  owner_user_id: string;
  page_id: string;
  page_name?: string;
  page_avatar?: string;
  post_id: string;
  video_id?: string | null;
  message: string;
  post_type: "reel" | "video" | "photo" | "album" | "link" | "status";
  status_type?: string;
  permalink_url: string;
  thumbnail_url: string;
  media_url: string;
  attachments_json: string;
  source: "app_published" | "facebook_external" | "unknown";
  task_id?: number | null;
  created_time: string;
  updated_time?: string | null;
  synced_at: string;
  deleted_at?: string | null;
  is_deleted: number;
  likes_count: number;
  comments_count: number;
  shares_count: number;
  views_count: number;
  raw_data_json: string;
  created_at: string;
  updated_at: string;
}

export interface FacebookCommentRecord {
  id: string;
  post_id: string;
  page_id: string;
  owner_user_id: string;
  from_id: string;
  from_name: string;
  message: string;
  parent_id?: string | null;
  created_time: string;
  can_comment: number;
  can_remove: number;
  can_hide: number;
  is_hidden: number;
  like_count: number;
  comment_count: number;
  synced_at: string;
  created_at: string;
  replies?: FacebookCommentRecord[];
}

export interface PageSyncStateRecord {
  page_id: string;
  owner_user_id: string;
  sync_status: "idle" | "syncing" | "completed" | "partial" | "failed";
  next_cursor?: string | null;
  previous_cursor?: string | null;
  total_synced: number;
  last_synced_at?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * Lấy Access Token của Fanpage đã giải mã an toàn từ candidate tokens
 */
async function getDecryptedPageToken(
  db: D1Database,
  env: Env,
  pageId: string,
  ownerUserId: string
): Promise<{ pageToken: string; pageName: string; pageFbId: string } | null> {
  const encKey = getEncryptionKeyMaterial(env);
  const page = await getFacebookPageByFbId(db, encKey, pageId, true, ownerUserId);
  if (!page || !page.page_access_token) return null;
  return {
    pageToken: page.page_access_token,
    pageName: page.page_name || page.name || pageId,
    pageFbId: page.facebook_page_id || pageId
  };
}

/**
 * Log có cấu trúc an toàn (Tuyệt đối không log Access Token hay App Secret)
 */
function logPostSync(event: {
  sync_id: string;
  page_id: string;
  owner_user_id: string;
  endpoint: string;
  graph_version: string;
  status: "success" | "partial" | "failed";
  http_status?: number;
  meta_error_code?: number;
  meta_error_subcode?: number;
  fbtrace_id?: string;
  posts_fetched: number;
  posts_new: number;
  posts_updated: number;
  duration_ms: number;
  error?: string;
}) {
  console.log(`[FB_PAGE_SYNC] ${JSON.stringify(event)}`);
}

/**
 * Phân loại post_type chuẩn dựa trên dữ liệu Graph API
 */
function determinePostType(
  item: any,
  permalink: string
): "reel" | "video" | "photo" | "album" | "link" | "status" {
  const lowerPermalink = (permalink || "").toLowerCase();
  const attachments = item.attachments?.data || [];
  const primaryAtt = attachments[0] || {};
  const mediaType = (primaryAtt.media_type || primaryAtt.type || "").toLowerCase();
  const subAttachments = primaryAtt.subattachments?.data || [];

  if (lowerPermalink.includes("/reel/") || lowerPermalink.includes("/reels/")) {
    return "reel";
  }

  if (mediaType === "video" || mediaType === "video_inline" || lowerPermalink.includes("/videos/")) {
    if (lowerPermalink.includes("/reel/")) return "reel";
    return "video";
  }

  if (mediaType === "album" || subAttachments.length > 1) {
    return "album";
  }

  if (mediaType === "photo" || mediaType === "profile_media" || item.full_picture || item.picture) {
    return "photo";
  }

  if (mediaType === "link" || mediaType === "share" || item.status_type === "shared_story") {
    return "link";
  }

  return "status";
}

/**
 * Trích xuất Thumbnail URL từ item Meta
 */
function extractThumbnailUrl(item: any): string {
  if (item.full_picture) return item.full_picture;
  if (item.picture) return item.picture;
  const attachments = item.attachments?.data || [];
  if (attachments.length > 0) {
    const media = attachments[0].media;
    if (media && media.image && media.image.src) return media.image.src;
  }
  return "";
}

/**
 * Fetch một trang bài viết từ Meta Graph API với cơ chế fallback field nhiều tầng (Tiered Fallback)
 * 1. Tier 1: Toàn diện attachments và media metadata (bỏ unshimmed_url)
 * 2. Tier 2: An toàn không lồng attachments (khi Meta từ chối nested fields)
 * 3. Tier 3: Tối thiểu theo đặc tả Meta
 */
interface MetaFetchPageResult {
  res: Response;
  rawJson: any;
  usedEndpoint: string;
  usedFields: string;
}

async function fetchMetaPostsPage(
  graphVersion: string,
  pageId: string,
  pageToken: string,
  cursor?: string | null,
  limit: number = 25
): Promise<MetaFetchPageResult> {
  const endpoints = ["published_posts", "posts"];
  const fieldTiers = [
    // Tier 1: Đầy đủ (bỏ unshimmed_url)
    "id,message,created_time,updated_time,permalink_url,status_type,full_picture,attachments{media_type,url,title,description,type,subattachments,target,media}",
    // Tier 2: Không lồng attachments
    "id,message,created_time,updated_time,permalink_url,status_type,full_picture",
    // Tier 3: Cốt lõi tối thiểu
    "id,message,created_time,permalink_url"
  ];

  let lastRes: Response | null = null;
  let lastJson: any = null;
  let lastEndpoint = endpoints[0];
  let lastFields = fieldTiers[0];

  for (const ep of endpoints) {
    for (const fds of fieldTiers) {
      lastEndpoint = ep;
      lastFields = fds;
      let url = `https://graph.facebook.com/${graphVersion}/${pageId}/${ep}?fields=${encodeURIComponent(
        fds
      )}&limit=${limit}&access_token=${encodeURIComponent(pageToken)}`;
      if (cursor) {
        url += `&after=${encodeURIComponent(cursor)}`;
      }

      try {
        const res = await fetch(url);
        const json = (await res.json()) as any;
        lastRes = res;
        lastJson = json;

        if (res.ok && !json.error) {
          return { res, rawJson: json, usedEndpoint: ep, usedFields: fds };
        }

        const errCode = json.error?.code;
        const errMsg = String(json.error?.message || "");

        // Nếu token hết hạn (190) hoặc thiếu quyền (200/10): dừng ngay, không thử thêm
        if (errCode === 190 || errCode === 200 || errCode === 10) {
          return { res, rawJson: json, usedEndpoint: ep, usedFields: fds };
        }

        // Nếu lỗi do field không hỗ trợ (code 100): thử tier field tiếp theo
        const isFieldIssue =
          errCode === 100 &&
          (errMsg.includes("field") || errMsg.includes("exist") || errMsg.includes("Unknown"));
        if (isFieldIssue) {
          console.warn(`[FB_PAGE_SYNC] Meta API từ chối fields "${fds}": ${errMsg}. Đang thử fallback tier thấp hơn...`);
          continue;
        }

        // Nếu published_posts trả về mã 12, 3 hoặc endpoint không hỗ trợ: thử sang 'posts'
        if (ep === "published_posts" && (errCode === 12 || errCode === 3 || errMsg.includes("endpoint") || errMsg.includes("Unknown path"))) {
          console.warn(`[FB_PAGE_SYNC] Endpoint published_posts không khả dụng (${errMsg}), chuyển sang endpoint posts...`);
          break; // chuyển sang ep tiếp theo
        }

        return { res, rawJson: json, usedEndpoint: ep, usedFields: fds };
      } catch (netErr: any) {
        throw netErr;
      }
    }
  }

  return {
    res: lastRes || new Response(JSON.stringify({ error: { message: "Could not reach Facebook" } }), { status: 500 }),
    rawJson: lastJson || { error: { message: "Unexpected response from Facebook" } },
    usedEndpoint: lastEndpoint,
    usedFields: lastFields
  };
}

/**
 * 1. ĐỒNG BỘ BÀI VIẾT TỪ FACEBOOK PAGE VÀO D1 (HỖ TRỢ CURSOR PAGINATION & BATCHING)
 */
export async function syncFacebookPagePosts(
  db: D1Database,
  env: Env,
  options: {
    pageId: string;
    ownerUserId: string;
    cursor?: string;
    limit?: number;
    forceResetCursor?: boolean;
    maxPages?: number;
  }
): Promise<{
  success: boolean;
  count: number;
  new_count: number;
  updated_count: number;
  next_cursor: string | null;
  has_more: boolean;
  total_synced: number;
  message?: string;
  error?: string;
}> {
  const syncStartTime = Date.now();
  const syncId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { pageId, ownerUserId, limit = 25, forceResetCursor = false } = options;
  const maxPages = options.maxPages || 1;

  const pageInfo = await getDecryptedPageToken(db, env, pageId, ownerUserId);
  if (!pageInfo) {
    return {
      success: false,
      count: 0,
      new_count: 0,
      updated_count: 0,
      next_cursor: null,
      has_more: false,
      total_synced: 0,
      error: "Page not found or its access token is missing. Please reconnect your Facebook account."
    };
  }

  const nowIso = new Date().toISOString();

  // Đọc sync state hiện tại từ D1
  const existingSync = await db
    .prepare(
      `SELECT next_cursor, total_synced FROM facebook_page_sync_states WHERE page_id = ? AND owner_user_id = ? LIMIT 1`
    )
    .bind(pageId, ownerUserId)
    .first<{ next_cursor: string | null; total_synced: number }>();

  let activeCursor = options.cursor;
  if (!activeCursor && !forceResetCursor && existingSync?.next_cursor) {
    activeCursor = existingSync.next_cursor;
  }

  // Đánh dấu trạng thái đang đồng bộ
  await db
    .prepare(
      `INSERT INTO facebook_page_sync_states (page_id, owner_user_id, sync_status, last_synced_at, created_at, updated_at)
       VALUES (?, ?, 'syncing', ?, ?, ?)
       ON CONFLICT(page_id, owner_user_id) DO UPDATE SET sync_status = 'syncing', updated_at = ?`
    )
    .bind(pageId, ownerUserId, nowIso, nowIso, nowIso, nowIso)
    .run();

  const graphVersion = env.META_GRAPH_VERSION || "v27.0";

  let totalBatchSaved = 0;
  let totalNewSaved = 0;
  let totalUpdatedSaved = 0;
  let nextCursorOut: string | null = null;
  let hasMoreOut = false;
  let lastUsedEndpoint = "published_posts";

  for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
    let fetchRes: MetaFetchPageResult;
    try {
      fetchRes = await fetchMetaPostsPage(graphVersion, pageId, pageInfo.pageToken, activeCursor, limit);
    } catch (netErr: any) {
      const durationMs = Date.now() - syncStartTime;
      logPostSync({
        sync_id: syncId,
        page_id: pageId,
        owner_user_id: ownerUserId,
        endpoint: lastUsedEndpoint,
        graph_version: graphVersion,
        status: "failed",
        posts_fetched: 0,
        posts_new: 0,
        posts_updated: 0,
        duration_ms: durationMs,
        error: netErr?.message
      });

      await db
        .prepare(
          `UPDATE facebook_page_sync_states SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE page_id = ? AND owner_user_id = ?`
        )
        .bind(netErr?.message || "Network error while contacting Facebook", nowIso, pageId, ownerUserId)
        .run();

      return {
        success: false,
        count: totalBatchSaved,
        new_count: totalNewSaved,
        updated_count: totalUpdatedSaved,
        next_cursor: activeCursor || null,
        has_more: false,
        total_synced: (existingSync?.total_synced || 0) + totalBatchSaved,
        error: `Could not reach Facebook: ${netErr?.message}`
      };
    }

    const { res, rawJson, usedEndpoint } = fetchRes;
    lastUsedEndpoint = usedEndpoint;

    if (!res.ok || rawJson.error) {
      const errMsg = rawJson.error?.message || `Meta Graph API HTTP ${res.status}`;
      const errCode = rawJson.error?.code;
      const errSubcode = rawJson.error?.error_subcode;
      const fbtraceId = rawJson.error?.fbtrace_id;
      const durationMs = Date.now() - syncStartTime;

      logPostSync({
        sync_id: syncId,
        page_id: pageId,
        owner_user_id: ownerUserId,
        endpoint: usedEndpoint,
        graph_version: graphVersion,
        status: "failed",
        http_status: res.status,
        meta_error_code: errCode,
        meta_error_subcode: errSubcode,
        fbtrace_id: fbtraceId,
        posts_fetched: 0,
        posts_new: 0,
        posts_updated: 0,
        duration_ms: durationMs,
        error: errMsg
      });

      await db
        .prepare(
          `UPDATE facebook_page_sync_states SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE page_id = ? AND owner_user_id = ?`
        )
        .bind(errMsg, nowIso, pageId, ownerUserId)
        .run();

      let friendlyError = errMsg;
      if (errCode === 190) {
        friendlyError = "The Page access token has expired or was revoked (Code 190). Please update the access token.";
      } else if (errCode === 200 || errCode === 10) {
        friendlyError = "This account cannot read this Page's posts (requires pages_read_user_content or pages_read_engagement).";
      } else if (errCode === 4 || errCode === 17 || errCode === 32) {
        friendlyError = "Facebook rate limit reached. Please try again in a few minutes.";
      }

      return {
        success: false,
        count: totalBatchSaved,
        new_count: totalNewSaved,
        updated_count: totalUpdatedSaved,
        next_cursor: activeCursor || null,
        has_more: false,
        total_synced: (existingSync?.total_synced || 0) + totalBatchSaved,
        error: friendlyError
      };
    }

    const postsData: any[] = Array.isArray(rawJson.data) ? rawJson.data : [];
    if (postsData.length === 0) {
      nextCursorOut = null;
      hasMoreOut = false;
      break;
    }

    let pageSavedCount = 0;
    for (const item of postsData) {
      const postId = String(item.id || "");
      if (!postId) continue;

      const message = item.message || "";
      const createdTime = item.created_time || nowIso;
      const updatedTime = item.updated_time || createdTime;
      const permalinkUrl = item.permalink_url || `https://www.facebook.com/${postId}`;
      const postType = determinePostType(item, permalinkUrl);
      const thumbnailUrl = extractThumbnailUrl(item);
      const statusType = item.status_type || "";
      const attachmentsJson = JSON.stringify(item.attachments?.data || []);
      const rawDataJson = JSON.stringify(item);

      // Kiểm tra bản ghi đã tồn tại chưa để bảo toàn source và task_id
      const existingPost = await db
        .prepare(
          `SELECT id, source, task_id, thumbnail_url, media_url FROM facebook_posts WHERE page_id = ? AND post_id = ? LIMIT 1`
        )
        .bind(pageId, postId)
        .first<{ id: number; source: string; task_id: number | null; thumbnail_url: string; media_url: string }>();

      const isNew = !existingPost;
      const source = existingPost?.source === "app_published" ? "app_published" : "facebook_external";
      const taskId = existingPost?.task_id || null;

      let mediaUrl = "";
      if (item.attachments?.data?.[0]?.url) {
        mediaUrl = item.attachments.data[0].url;
      }

      await db
        .prepare(
          `INSERT INTO facebook_posts (
            owner_user_id, page_id, post_id, message, post_type, status_type,
            permalink_url, thumbnail_url, media_url, attachments_json, source, task_id,
            created_time, updated_time, synced_at, raw_data_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(page_id, post_id) DO UPDATE SET
            message = excluded.message,
            post_type = excluded.post_type,
            status_type = excluded.status_type,
            permalink_url = excluded.permalink_url,
            thumbnail_url = CASE WHEN excluded.thumbnail_url != '' THEN excluded.thumbnail_url ELSE facebook_posts.thumbnail_url END,
            media_url = CASE WHEN excluded.media_url != '' THEN excluded.media_url ELSE facebook_posts.media_url END,
            attachments_json = excluded.attachments_json,
            updated_time = excluded.updated_time,
            synced_at = excluded.synced_at,
            raw_data_json = excluded.raw_data_json,
            updated_at = excluded.updated_at`
        )
        .bind(
          ownerUserId,
          pageId,
          postId,
          message,
          postType,
          statusType,
          permalinkUrl,
          thumbnailUrl,
          mediaUrl,
          attachmentsJson,
          source,
          taskId,
          createdTime,
          updatedTime,
          nowIso,
          rawDataJson,
          nowIso,
          nowIso
        )
        .run();

      pageSavedCount++;
      if (isNew) {
        totalNewSaved++;
      } else {
        totalUpdatedSaved++;
      }
    }

    totalBatchSaved += pageSavedCount;

    const currentAfter = rawJson.paging?.cursors?.after || null;
    if (currentAfter && currentAfter !== activeCursor) {
      activeCursor = currentAfter;
      nextCursorOut = currentAfter;
      hasMoreOut = true;
    } else {
      nextCursorOut = null;
      hasMoreOut = false;
      break;
    }
  }

  const durationMs = Date.now() - syncStartTime;
  const newTotalSynced = (existingSync?.total_synced || 0) + totalBatchSaved;
  const finalSyncStatus = hasMoreOut ? "partial" : "completed";

  logPostSync({
    sync_id: syncId,
    page_id: pageId,
    owner_user_id: ownerUserId,
    endpoint: lastUsedEndpoint,
    graph_version: graphVersion,
    status: finalSyncStatus === "completed" ? "success" : "partial",
    posts_fetched: totalBatchSaved,
    posts_new: totalNewSaved,
    posts_updated: totalUpdatedSaved,
    duration_ms: durationMs
  });

  const metadataJson = JSON.stringify({
    last_batch_new: totalNewSaved,
    last_batch_updated: totalUpdatedSaved,
    last_endpoint: lastUsedEndpoint,
    duration_ms: durationMs
  });

  await db
    .prepare(
      `INSERT INTO facebook_page_sync_states (
        page_id, owner_user_id, sync_status, next_cursor, previous_cursor, total_synced,
        last_synced_at, last_success_at, last_error, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(page_id, owner_user_id) DO UPDATE SET
        sync_status = excluded.sync_status,
        next_cursor = excluded.next_cursor,
        total_synced = excluded.total_synced,
        last_synced_at = excluded.last_synced_at,
        last_success_at = excluded.last_success_at,
        last_error = NULL,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`
    )
    .bind(
      pageId,
      ownerUserId,
      finalSyncStatus,
      nextCursorOut,
      newTotalSynced,
      nowIso,
      nowIso,
      metadataJson,
      nowIso,
      nowIso
    )
    .run();

  let message = "";
  if (totalBatchSaved === 0) {
    if (newTotalSynced === 0) {
      message = "This Page has no published posts on Facebook yet.";
    } else {
      message = "All posts from this Page are synced.";
    }
  } else {
    message = `Synced ${totalBatchSaved} posts (${totalNewSaved} new, ${totalUpdatedSaved} updated).`;
    if (hasMoreOut) {
      message += " Older posts are still available.";
    }
  }

  return {
    success: true,
    count: totalBatchSaved,
    new_count: totalNewSaved,
    updated_count: totalUpdatedSaved,
    next_cursor: nextCursorOut,
    has_more: hasMoreOut,
    total_synced: newTotalSynced,
    message
  };
}

/**
 * 2. LẤY DANH SÁCH BÀI VIẾT TỪ D1 VỚI BỘ LỌC TOÀN DIỆN VÀ PHÂN TRANG
 */
export async function getFacebookPostsList(
  db: D1Database,
  ownerUserId: string,
  filters: {
    page_id?: string;
    post_type?: string;
    source?: string;
    search?: string;
    start_date?: string;
    end_date?: string;
    page?: number;
    limit?: number;
  }
): Promise<{
  posts: FacebookPostRecord[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
  sync_states: Record<string, PageSyncStateRecord>;
}> {
  const pageNum = Math.max(1, Number(filters.page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(filters.limit) || 20));
  const offset = (pageNum - 1) * limitNum;

  const conditions: string[] = ["p.owner_user_id = ?", "p.is_deleted = 0"];
  const params: any[] = [ownerUserId];

  if (filters.page_id && filters.page_id.trim()) {
    conditions.push("p.page_id = ?");
    params.push(filters.page_id.trim());
  }

  if (filters.post_type && filters.post_type !== "all" && filters.post_type.trim()) {
    conditions.push("p.post_type = ?");
    params.push(filters.post_type.trim());
  }

  if (filters.source && filters.source !== "all" && filters.source.trim()) {
    conditions.push("p.source = ?");
    params.push(filters.source.trim());
  }

  if (filters.search && filters.search.trim()) {
    conditions.push("(p.message LIKE ? OR p.post_id LIKE ?)");
    params.push(`%${filters.search.trim()}%`, `%${filters.search.trim()}%`);
  }

  if (filters.start_date && filters.start_date.trim()) {
    conditions.push("p.created_time >= ?");
    params.push(filters.start_date.trim());
  }

  if (filters.end_date && filters.end_date.trim()) {
    conditions.push("p.created_time <= ?");
    params.push(filters.end_date.trim() + "T23:59:59Z");
  }

  const whereClause = conditions.join(" AND ");

  // 1. Đếm tổng số bản ghi
  const countRow = await db
    .prepare(`SELECT COUNT(*) as total FROM facebook_posts p WHERE ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>();
  const total = countRow?.total || 0;
  const total_pages = Math.ceil(total / limitNum) || 1;

  // 2. Lấy dữ liệu bài viết kèm thông tin Page
  const query = `
    SELECT 
      p.*,
      fp.page_name as page_name
    FROM facebook_posts p
    LEFT JOIN facebook_pages fp ON p.page_id = fp.facebook_page_id AND p.owner_user_id = fp.owner_user_id
    WHERE ${whereClause}
    ORDER BY p.created_time DESC
    LIMIT ? OFFSET ?
  `;

  const queryParams = [...params, limitNum, offset];
  const rows = await db.prepare(query).bind(...queryParams).all<FacebookPostRecord>();
  const posts = rows.results || [];

  // 3. Đọc sync states của các page
  const syncStateRows = await db
    .prepare(
      `SELECT * FROM facebook_page_sync_states WHERE owner_user_id = ?`
    )
    .bind(ownerUserId)
    .all<PageSyncStateRecord>();

  const sync_states: Record<string, PageSyncStateRecord> = {};
  for (const st of syncStateRows.results || []) {
    sync_states[st.page_id] = st;
  }

  return {
    posts,
    total,
    page: pageNum,
    limit: limitNum,
    total_pages,
    sync_states
  };
}

/**
 * 3. LẤY CHI TIẾT BÀI VIẾT KÈM BÌNH LUẬN & AUDIT TRAIL
 */
export async function getFacebookPostDetail(
  db: D1Database,
  ownerUserId: string,
  postIdOrInternalId: string | number
): Promise<{
  post: FacebookPostRecord | null;
  comments: FacebookCommentRecord[];
  audit_logs: any[];
}> {
  const isNumeric = typeof postIdOrInternalId === "number" || /^\d+$/.test(String(postIdOrInternalId));

  let post: FacebookPostRecord | null = null;
  if (isNumeric) {
    post = await db
      .prepare(
        `SELECT p.*, fp.page_name as page_name 
         FROM facebook_posts p 
         LEFT JOIN facebook_pages fp ON p.page_id = fp.facebook_page_id AND p.owner_user_id = fp.owner_user_id
         WHERE (p.id = ? OR p.post_id = ?) AND p.owner_user_id = ? LIMIT 1`
      )
      .bind(Number(postIdOrInternalId), String(postIdOrInternalId), ownerUserId)
      .first<FacebookPostRecord>();
  } else {
    post = await db
      .prepare(
        `SELECT p.*, fp.page_name as page_name 
         FROM facebook_posts p 
         LEFT JOIN facebook_pages fp ON p.page_id = fp.facebook_page_id AND p.owner_user_id = fp.owner_user_id
         WHERE p.post_id = ? AND p.owner_user_id = ? LIMIT 1`
      )
      .bind(String(postIdOrInternalId), ownerUserId)
      .first<FacebookPostRecord>();
  }

  if (!post) {
    return { post: null, comments: [], audit_logs: [] };
  }

  // Lấy bình luận từ cache D1
  const commentRows = await db
    .prepare(
      `SELECT * FROM facebook_post_comments WHERE post_id = ? AND owner_user_id = ? ORDER BY created_time ASC`
    )
    .bind(post.post_id, ownerUserId)
    .all<FacebookCommentRecord>();

  // Xây dựng cây bình luận cha / con (nested replies)
  const allComments = commentRows.results || [];
  const topComments: FacebookCommentRecord[] = [];
  const commentMap = new Map<string, FacebookCommentRecord>();

  for (const c of allComments) {
    c.replies = [];
    commentMap.set(c.id, c);
  }

  for (const c of allComments) {
    if (c.parent_id && commentMap.has(c.parent_id)) {
      commentMap.get(c.parent_id)!.replies!.push(c);
    } else {
      topComments.push(c);
    }
  }

  // Lấy audit logs
  const auditRows = await db
    .prepare(
      `SELECT * FROM facebook_post_audit_logs WHERE post_id = ? AND owner_user_id = ? ORDER BY id DESC LIMIT 20`
    )
    .bind(post.post_id, ownerUserId)
    .all<any>();

  return {
    post,
    comments: topComments,
    audit_logs: auditRows.results || []
  };
}

/**
 * 4. CHỈNH SỬA NỘI DUNG (CAPTION/MESSAGE) BÀI VIẾT TRÊN FACEBOOK & D1
 */
export async function editFacebookPostMessage(
  db: D1Database,
  env: Env,
  options: {
    postId: string;
    newCaption: string;
    ownerUserId: string;
  }
): Promise<{ success: boolean; error?: string; updated_post?: FacebookPostRecord | null }> {
  const { postId, newCaption, ownerUserId } = options;

  const post = await db
    .prepare(
      `SELECT * FROM facebook_posts WHERE (id = ? OR post_id = ?) AND owner_user_id = ? LIMIT 1`
    )
    .bind(isNaN(Number(postId)) ? 0 : Number(postId), postId, ownerUserId)
    .first<FacebookPostRecord>();

  if (!post) {
    return { success: false, error: "Post not found." };
  }

  const pageInfo = await getDecryptedPageToken(db, env, post.page_id, ownerUserId);
  if (!pageInfo) {
    return { success: false, error: "The Page access token is invalid or expired." };
  }

  const nowIso = new Date().toISOString();
  const graphVersion = env.META_GRAPH_VERSION || "v27.0";

  // Gọi Meta Graph API để sửa message: POST /{post-id} với message
  const editUrl = `https://graph.facebook.com/${graphVersion}/${post.post_id}`;
  const formData = new URLSearchParams();
  formData.append("message", newCaption);
  formData.append("access_token", pageInfo.pageToken);

  let res: Response;
  try {
    res = await fetch(editUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    });
  } catch (netErr: any) {
    return { success: false, error: `Could not reach Facebook: ${netErr?.message}` };
  }

  const resJson = (await res.json()) as any;
  if (!res.ok || resJson.error || resJson.success === false) {
    const errMsg = resJson.error?.message || "Facebook rejected the post update.";
    const errCode = resJson.error?.code;

    // Ghi audit log thất bại
    await db
      .prepare(
        `INSERT INTO facebook_post_audit_logs (post_id, page_id, owner_user_id, action, old_data, new_data, result_status, error_message, created_at)
         VALUES (?, ?, ?, 'edit_message', ?, ?, 'failed', ?, ?)`
      )
      .bind(post.post_id, post.page_id, ownerUserId, post.message, newCaption, errMsg, nowIso)
      .run();

    let friendly = errMsg;
    if (errCode === 100 || errCode === 200) {
      friendly = "Facebook does not allow editing this post (for example, Reels and some media types can't be edited after publishing).";
    }
    return { success: false, error: friendly };
  }

  // Meta xác nhận thành công -> Cập nhật D1
  await db
    .prepare(
      `UPDATE facebook_posts SET message = ?, updated_time = ?, updated_at = ? WHERE id = ?`
    )
    .bind(newCaption, nowIso, nowIso, post.id)
    .run();

  // Ghi audit log thành công
  await db
    .prepare(
      `INSERT INTO facebook_post_audit_logs (post_id, page_id, owner_user_id, action, old_data, new_data, result_status, created_at)
       VALUES (?, ?, ?, 'edit_message', ?, ?, 'success', ?)`
    )
    .bind(post.post_id, post.page_id, ownerUserId, post.message, newCaption, nowIso)
    .run();

  const updated = await db
    .prepare(`SELECT * FROM facebook_posts WHERE id = ? LIMIT 1`)
    .bind(post.id)
    .first<FacebookPostRecord>();

  return { success: true, updated_post: updated };
}

/**
 * 5. XÓA BÀI VIẾT TRÊN FACEBOOK & D1 (HỖ TRỢ XÁC NHẬN BẢO VỆ)
 */
export async function deleteFacebookPostComplete(
  db: D1Database,
  env: Env,
  options: {
    postId: string;
    deleteFacebook: boolean;
    ownerUserId: string;
  }
): Promise<{ success: boolean; error?: string }> {
  const { postId, deleteFacebook, ownerUserId } = options;

  const post = await db
    .prepare(
      `SELECT * FROM facebook_posts WHERE (id = ? OR post_id = ?) AND owner_user_id = ? LIMIT 1`
    )
    .bind(isNaN(Number(postId)) ? 0 : Number(postId), postId, ownerUserId)
    .first<FacebookPostRecord>();

  if (!post) {
    return { success: false, error: "Post not found." };
  }

  const nowIso = new Date().toISOString();

  if (deleteFacebook) {
    const pageInfo = await getDecryptedPageToken(db, env, post.page_id, ownerUserId);
    if (!pageInfo) {
      return { success: false, error: "The Page access token is invalid or expired." };
    }

    const delResult = await deleteFacebookReelOrPost(db, env, {
      pageId: post.page_id,
      postId: post.post_id,
      videoId: post.video_id || undefined,
      ownerUserId
    });

    if (!delResult.success) {
      await db
        .prepare(
          `INSERT INTO facebook_post_audit_logs (post_id, page_id, owner_user_id, action, result_status, error_message, created_at)
           VALUES (?, ?, ?, 'delete_post_facebook', 'failed', ?, ?)`
        )
        .bind(post.post_id, post.page_id, ownerUserId, delResult.error || "Delete failed", nowIso)
        .run();

      return {
        success: false,
        error: `Could not delete the post on Facebook: ${delResult.error}. You can delete it manually on Facebook.`
      };
    }
  }

  // Đánh dấu đã xóa trong D1
  await db
    .prepare(
      `UPDATE facebook_posts SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(nowIso, nowIso, post.id)
    .run();

  // Ghi audit log
  await db
    .prepare(
      `INSERT INTO facebook_post_audit_logs (post_id, page_id, owner_user_id, action, result_status, created_at)
       VALUES (?, ?, ?, 'delete_post_complete', 'success', ?)`
    )
    .bind(post.post_id, post.page_id, ownerUserId, nowIso)
    .run();

  return { success: true };
}

/**
 * 6. ĐỒNG BỘ BÌNH LUẬN BÀI VIẾT TỪ FACEBOOK VÀO D1
 */
export async function syncPostComments(
  db: D1Database,
  env: Env,
  options: {
    postId: string;
    ownerUserId: string;
  }
): Promise<{
  success: boolean;
  comments: FacebookCommentRecord[];
  count: number;
  error?: string;
}> {
  const { postId, ownerUserId } = options;

  const post = await db
    .prepare(
      `SELECT * FROM facebook_posts WHERE (id = ? OR post_id = ?) AND owner_user_id = ? LIMIT 1`
    )
    .bind(isNaN(Number(postId)) ? 0 : Number(postId), postId, ownerUserId)
    .first<FacebookPostRecord>();

  if (!post) {
    return { success: false, comments: [], count: 0, error: "Post not found." };
  }

  const pageInfo = await getDecryptedPageToken(db, env, post.page_id, ownerUserId);
  if (!pageInfo) {
    return { success: false, comments: [], count: 0, error: "The Page token has expired." };
  }

  const nowIso = new Date().toISOString();
  const graphVersion = env.META_GRAPH_VERSION || "v27.0";
  const fields = "id,from,message,created_time,parent,like_count,comment_count,can_comment,can_remove,can_hide,is_hidden";
  const commentsUrl = `https://graph.facebook.com/${graphVersion}/${post.post_id}/comments?fields=${encodeURIComponent(
    fields
  )}&limit=50&access_token=${encodeURIComponent(pageInfo.pageToken)}`;

  let res: Response;
  try {
    res = await fetch(commentsUrl);
  } catch (e: any) {
    return { success: false, comments: [], count: 0, error: `Could not reach Facebook: ${e?.message}` };
  }

  const rawJson = (await res.json()) as any;
  if (!res.ok || rawJson.error) {
    return {
      success: false,
      comments: [],
      count: 0,
      error: rawJson.error?.message || "Could not load comments from Facebook."
    };
  }

  const commentsList: any[] = Array.isArray(rawJson.data) ? rawJson.data : [];
  let savedCount = 0;

  for (const c of commentsList) {
    const commentId = String(c.id || "");
    if (!commentId) continue;

    const fromId = c.from?.id || "";
    const fromName = c.from?.name || "Facebook user";
    const msg = c.message || "";
    const parentId = c.parent?.id || null;
    const createdTime = c.created_time || nowIso;
    const canComment = c.can_comment ? 1 : 0;
    const canRemove = c.can_remove ? 1 : 0;
    const canHide = c.can_hide ? 1 : 0;
    const isHidden = c.is_hidden ? 1 : 0;
    const likeCount = Number(c.like_count) || 0;
    const commentCount = Number(c.comment_count) || 0;

    await db
      .prepare(
        `INSERT INTO facebook_post_comments (
          id, post_id, page_id, owner_user_id, from_id, from_name, message, parent_id,
          created_time, can_comment, can_remove, can_hide, is_hidden, like_count, comment_count,
          synced_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          message = excluded.message,
          is_hidden = excluded.is_hidden,
          like_count = excluded.like_count,
          comment_count = excluded.comment_count,
          synced_at = excluded.synced_at`
      )
      .bind(
        commentId,
        post.post_id,
        post.page_id,
        ownerUserId,
        fromId,
        fromName,
        msg,
        parentId,
        createdTime,
        canComment,
        canRemove,
        canHide,
        isHidden,
        likeCount,
        commentCount,
        nowIso,
        nowIso
      )
      .run();

    savedCount++;
  }

  // Cập nhật tổng số comment vào bài viết
  await db
    .prepare(`UPDATE facebook_posts SET comments_count = ? WHERE id = ?`)
    .bind(savedCount, post.id)
    .run();

  const detail = await getFacebookPostDetail(db, ownerUserId, post.id);
  return {
    success: true,
    comments: detail.comments,
    count: savedCount
  };
}

/**
 * 7. GỬI BÌNH LUẬN HOẶC TRẢ LỜI BÌNH LUẬN TRÊN FACEBOOK
 */
export async function createFacebookCommentOrReply(
  db: D1Database,
  env: Env,
  options: {
    postId: string;
    parentCommentId?: string;
    message: string;
    ownerUserId: string;
  }
): Promise<{ success: boolean; comment_id?: string; error?: string }> {
  const { postId, parentCommentId, message, ownerUserId } = options;

  if (!message || !message.trim()) {
    return { success: false, error: "Comment cannot be empty." };
  }

  const post = await db
    .prepare(
      `SELECT * FROM facebook_posts WHERE (id = ? OR post_id = ?) AND owner_user_id = ? LIMIT 1`
    )
    .bind(isNaN(Number(postId)) ? 0 : Number(postId), postId, ownerUserId)
    .first<FacebookPostRecord>();

  if (!post) {
    return { success: false, error: "Post not found." };
  }

  const pageInfo = await getDecryptedPageToken(db, env, post.page_id, ownerUserId);
  if (!pageInfo) {
    return { success: false, error: "The Page access token is invalid." };
  }

  const nowIso = new Date().toISOString();
  const graphVersion = env.META_GRAPH_VERSION || "v27.0";
  const targetId = parentCommentId ? parentCommentId : post.post_id;
  const targetUrl = `https://graph.facebook.com/${graphVersion}/${targetId}/comments`;

  const formData = new URLSearchParams();
  formData.append("message", message.trim());
  formData.append("access_token", pageInfo.pageToken);

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    });
  } catch (netErr: any) {
    return { success: false, error: `Could not reach Facebook: ${netErr?.message}` };
  }

  const resJson = (await res.json()) as any;
  if (!res.ok || !resJson.id) {
    return {
      success: false,
      error: resJson.error?.message || "Facebook rejected the comment."
    };
  }

  const createdCommentId = String(resJson.id);

  // Lưu ngay vào D1
  await db
    .prepare(
      `INSERT INTO facebook_post_comments (
        id, post_id, page_id, owner_user_id, from_id, from_name, message, parent_id,
        created_time, can_comment, can_remove, can_hide, is_hidden, like_count, comment_count,
        synced_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 0, 0, 0, ?, ?)`
    )
    .bind(
      createdCommentId,
      post.post_id,
      post.page_id,
      ownerUserId,
      post.page_id,
      pageInfo.pageName,
      message.trim(),
      parentCommentId || null,
      nowIso,
      nowIso,
      nowIso
    )
    .run();

  await db
    .prepare(`UPDATE facebook_posts SET comments_count = comments_count + 1 WHERE id = ?`)
    .bind(post.id)
    .run();

  return {
    success: true,
    comment_id: createdCommentId
  };
}

/**
 * 8. ẨN HOẶC XÓA BÌNH LUẬN TRÊN FACEBOOK
 */
export async function deleteOrHideFacebookComment(
  db: D1Database,
  env: Env,
  options: {
    commentId: string;
    action: "delete" | "hide" | "unhide";
    ownerUserId: string;
  }
): Promise<{ success: boolean; error?: string }> {
  const { commentId, action, ownerUserId } = options;

  const comment = await db
    .prepare(`SELECT * FROM facebook_post_comments WHERE id = ? AND owner_user_id = ? LIMIT 1`)
    .bind(commentId, ownerUserId)
    .first<FacebookCommentRecord>();

  if (!comment) {
    return { success: false, error: "Comment not found." };
  }

  const pageInfo = await getDecryptedPageToken(db, env, comment.page_id, ownerUserId);
  if (!pageInfo) {
    return { success: false, error: "The Page token has expired." };
  }

  const graphVersion = env.META_GRAPH_VERSION || "v27.0";

  if (action === "delete") {
    const delUrl = `https://graph.facebook.com/${graphVersion}/${commentId}?access_token=${encodeURIComponent(
      pageInfo.pageToken
    )}`;
    try {
      const res = await fetch(delUrl, { method: "DELETE" });
      const resJson = (await res.json()) as any;
      if (!res.ok || resJson.error || resJson.success === false) {
        return { success: false, error: resJson.error?.message || "Could not delete the comment on Facebook." };
      }
    } catch (e: any) {
      return { success: false, error: `Could not reach Facebook: ${e?.message}` };
    }

    await db.prepare(`DELETE FROM facebook_post_comments WHERE id = ?`).bind(commentId).run();
    await db
      .prepare(`UPDATE facebook_posts SET comments_count = MAX(0, comments_count - 1) WHERE post_id = ?`)
      .bind(comment.post_id)
      .run();

    return { success: true };
  } else {
    const isHidden = action === "hide";
    const editUrl = `https://graph.facebook.com/${graphVersion}/${commentId}`;
    const formData = new URLSearchParams();
    formData.append("is_hidden", String(isHidden));
    formData.append("access_token", pageInfo.pageToken);

    try {
      const res = await fetch(editUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString()
      });
      const resJson = (await res.json()) as any;
      if (!res.ok || resJson.error || resJson.success === false) {
        return { success: false, error: resJson.error?.message || "Could not change the comment's visibility." };
      }
    } catch (e: any) {
      return { success: false, error: `Could not reach Facebook: ${e?.message}` };
    }

    await db
      .prepare(`UPDATE facebook_post_comments SET is_hidden = ? WHERE id = ?`)
      .bind(isHidden ? 1 : 0, commentId)
      .run();

    return { success: true };
  }
}
