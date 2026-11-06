/**
 * Meta Graph API Service – Fanpage Sync, Permission Inspection, Reels Publishing & Run Test
 * - Đồng bộ `/me/accounts` đầy đủ phân trang (pagination)
 * - Chống trùng lặp Fanpage giữa nhiều Admin của cùng 1 User, cô lập tuyệt đối giữa các User
 * - Phát hiện Token hết hạn / bị thu hồi (error code 190) và đánh dấu trạng thái chính xác
 * - Xuất bản Reels qua `/{page_id}/video_reels` đọc trực tiếp từ Cloudflare R2 (Streaming)
 * - Chống đăng trùng Reels khi trạng thái finish không rõ ràng (ambiguousPublish)
 */

import type { D1Database, Env } from "../types.ts";
import {
  getFacebookAccounts,
  getFacebookAccountById,
  updateFacebookAccountStatus,
  upsertFacebookPage,
  getFacebookPages,
  getFacebookPageByFbId,
  getTasks,
  getMediaFileById
} from "../db.ts";
import { getMetaConfig, REQUIRED_SCOPES } from "./metaOAuthService.ts";
export { getMetaConfig, REQUIRED_SCOPES };
import { openVideoFromStorage, validateVideoMetadata } from "./r2MediaService.ts";
import { sanitizeSensitiveText } from "../utils/sanitize.ts";
import { parseVnScheduleToUtc } from "../utils/timezone.ts";

// ==========================================
// 1. SYNC FANPAGES (/me/accounts PAGINATION)
// ==========================================

export async function syncPagesForAccount(
  db: D1Database,
  env: Env,
  accountId: string,
  ownerUserId: string
): Promise<{
  success: boolean;
  account_id?: string;
  facebook_user_name?: string | null;
  synced_count?: number;
  pages?: unknown[];
  message?: string;
}> {
  const cfg = getMetaConfig(env);
  const account = await getFacebookAccountById(
    db,
    cfg.encryptionKey,
    accountId,
    true,
    ownerUserId
  );

  if (!account) {
    return {
      success: false,
      message:
        "Không tìm thấy tài khoản Facebook Admin hoặc bạn không có quyền truy cập tài khoản này."
    };
  }

  const userToken = account.access_token || "";
  if (!userToken) {
    await updateFacebookAccountStatus(
      db,
      accountId,
      "expired",
      "Token không tồn tại hoặc không thể giải mã. Vui lòng kết nối lại.",
      null,
      "invalid"
    );
    return {
      success: false,
      account_id: accountId,
      message: `Tài khoản '${account.facebook_user_name}' thiếu Access Token hợp lệ. Vui lòng nhấn 'Kết nối lại'.`
    };
  }

  try {
    let nextUrl: string | null =
      `${cfg.graphBase}/me/accounts?fields=id,name,global_brand_page_name,access_token,category,picture{url},tasks,is_published&limit=100&access_token=${encodeURIComponent(userToken)}`;

    let syncedCount = 0;
    let pageGuard = 0;

    while (nextUrl && pageGuard < 20) {
      pageGuard++;
      let resp = await fetch(nextUrl);
      let data = (await resp.json()) as Record<string, unknown>;

      // Nếu một số field mở rộng (như tasks, is_published) bị từ chối quyền trên Brand Page, tự động fallback sang fields tối giản giống Graph API Explorer
      if ((!resp.ok || data.error) && pageGuard === 1 && nextUrl.includes("is_published")) {
        const err = (data.error || {}) as Record<string, unknown>;
        const code = Number(err.code || 0);
        const rawErrMsg = String(err.message || "");
        if (code !== 190 && !/node type \(Page\)/i.test(rawErrMsg)) {
          const fallbackUrl = `${cfg.graphBase}/me/accounts?fields=id,name,global_brand_page_name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`;
          const fbResp = await fetch(fallbackUrl);
          const fbData = (await fbResp.json()) as Record<string, unknown>;
          if (fbResp.ok && !fbData.error) {
            resp = fbResp;
            data = fbData;
          }
        }
      }

      if (!resp.ok || data.error) {
        const err = (data.error || {}) as Record<string, unknown>;
        const code = Number(err.code || 0);
        const rawErrMsg = String(err.message || "Lỗi gọi /me/accounts");
        const msg = sanitizeSensitiveText(rawErrMsg);

        // Trường hợp người dùng dán trực tiếp Page Access Token (node type Page không có /accounts)
        if (code === 100 && /node type \(Page\)/i.test(rawErrMsg)) {
          const pageMeResp = await fetch(
            `${cfg.graphBase}/me?fields=id,name,global_brand_page_name,category,picture{url},tasks,is_published&access_token=${encodeURIComponent(userToken)}`
          );
          if (pageMeResp.ok) {
            const pageMe = (await pageMeResp.json()) as Record<string, unknown>;
            if (pageMe.id) {
              const picObj = (pageMe.picture as { data?: { url?: string } }) || {};
              const tasksList = Array.isArray(pageMe.tasks)
                ? pageMe.tasks.map((t) => String(t).toUpperCase())
                : ["CREATE_CONTENT", "MANAGE"];
              await upsertFacebookPage(db, cfg.encryptionKey, {
                facebookPageId: String(pageMe.id),
                pageName: String(
                  pageMe.name || pageMe.global_brand_page_name || account.facebook_user_name || "Fanpage"
                ),
                category: String(pageMe.category || "Page"),
                avatarUrl: String(picObj.data?.url || ""),
                pageAccessToken: userToken,
                tasks: tasksList,
                canPost: true,
                isPublished: pageMe.is_published !== false,
                connectedAccountId: accountId,
                tokenStatus: "valid",
                ownerUserId
              });
              syncedCount++;
              break;
            }
          }
        }

        const isAuthErr = code === 190 || code === 102 || code === 10 || code === 200;

        await updateFacebookAccountStatus(
          db,
          accountId,
          isAuthErr ? "expired" : "error",
          `Meta Error (${code}): ${msg}`,
          null,
          isAuthErr ? "expired" : "error"
        );

        return {
          success: false,
          account_id: accountId,
          message: `Lỗi đồng bộ Fanpage cho '${account.facebook_user_name}': ${msg}`
        };
      }

      const items = (data.data as Array<Record<string, unknown>>) || [];
      for (const item of items) {
        const pageId = String(item.id || "");
        const pageName = String(
          item.name || item.global_brand_page_name || "Unnamed Page"
        );
        const pageToken = String(item.access_token || "");
        if (!pageId || !pageToken) continue;

        const category = String(item.category || "Brand / Page");
        const picObj = (item.picture as { data?: { url?: string } }) || {};
        const avatarUrl = String(picObj.data?.url || "");
        const tasksList = Array.isArray(item.tasks) ? item.tasks.map(String) : [];
        const isPublished = item.is_published !== false;

        const upperTasks =
          tasksList.length > 0
            ? tasksList.map((t) => t.toUpperCase())
            : ["CREATE_CONTENT", "MANAGE"];
        const canPost =
          upperTasks.includes("CREATE_CONTENT") ||
          upperTasks.includes("MANAGE") ||
          upperTasks.includes("MODERATE") ||
          Boolean(pageToken);

        await upsertFacebookPage(db, cfg.encryptionKey, {
          facebookPageId: pageId,
          pageName,
          category,
          avatarUrl,
          pageAccessToken: pageToken,
          tasks: upperTasks,
          canPost,
          isPublished,
          connectedAccountId: accountId,
          tokenStatus: "valid",
          ownerUserId
        });

        syncedCount++;
      }

      const paging = (data.paging as { next?: string }) || {};
      nextUrl = paging.next || null;
    }

    const nowIso = new Date().toISOString();
    await updateFacebookAccountStatus(db, accountId, "connected", null, nowIso, "valid");

    return {
      success: true,
      account_id: accountId,
      facebook_user_name: account.facebook_user_name,
      synced_count: syncedCount,
      message: `Đã đồng bộ ${syncedCount} Fanpage từ tài khoản ${account.facebook_user_name}.`
    };
  } catch (err) {
    const errMsg = sanitizeSensitiveText(`Lỗi mạng khi đồng bộ Fanpage: ${(err as Error).message}`);
    await updateFacebookAccountStatus(db, accountId, "error", errMsg, null, "error");
    return {
      success: false,
      account_id: accountId,
      message: errMsg
    };
  }
}

export async function syncPagesFromMeta(
  db: D1Database,
  env: Env,
  ownerUserId: string
): Promise<{
  success: boolean;
  synced_count: number;
  pages: unknown[];
  account_results: unknown[];
  errors: string[];
  message: string;
}> {
  const cfg = getMetaConfig(env);
  const accounts = await getFacebookAccounts(db, cfg.encryptionKey, true, ownerUserId);

  if (accounts.length === 0) {
    return {
      success: false,
      synced_count: 0,
      pages: [],
      account_results: [],
      errors: [],
      message:
        "Chưa có tài khoản Facebook Admin nào được kết nối. Vui lòng nhấn '+ Thêm tài khoản Facebook'."
    };
  }

  let totalSynced = 0;
  const accountResults: unknown[] = [];
  const errors: string[] = [];

  for (const acc of accounts) {
    if (acc.status === "disconnected") continue;
    const res = await syncPagesForAccount(db, env, acc.id, ownerUserId);
    accountResults.push(res);
    if (res.success) {
      totalSynced += res.synced_count || 0;
    } else if (res.message) {
      errors.push(res.message);
    }
  }

  const allPages = await getFacebookPages(db, cfg.encryptionKey, {
    includeToken: false,
    ownerUserId
  });

  if (totalSynced === 0 && errors.length > 0 && allPages.length === 0) {
    return {
      success: false,
      synced_count: 0,
      pages: [],
      account_results: accountResults,
      errors,
      message: errors.join(" | ")
    };
  }

  return {
    success: true,
    synced_count: allPages.length,
    pages: allPages,
    account_results: accountResults,
    errors,
    message: `Đồng bộ hoàn tất! Hiện có ${allPages.length} Fanpage từ ${accounts.length} tài khoản Admin.`
  };
}

export async function checkPagePermissionOnMeta(
  db: D1Database,
  env: Env,
  facebookPageId: string,
  ownerUserId: string
): Promise<Record<string, unknown>> {
  const cfg = getMetaConfig(env);
  const page = await getFacebookPageByFbId(
    db,
    cfg.encryptionKey,
    facebookPageId,
    true,
    ownerUserId
  );

  if (!page) {
    return {
      success: false,
      can_post: false,
      message: `Không tìm thấy Fanpage ID ${facebookPageId} thuộc quyền quản lý của bạn.`
    };
  }

  const pageToken = page.page_access_token || "";
  if (!pageToken) {
    return {
      success: false,
      can_post: false,
      message: `Fanpage '${page.page_name}' thiếu Page Access Token hợp lệ. Vui lòng đồng bộ lại.`
    };
  }

  try {
    const resp = await fetch(
      `${cfg.graphBase}/${page.facebook_page_id}?fields=id,name,is_published,tasks&access_token=${encodeURIComponent(pageToken)}`
    );
    const data = (await resp.json()) as Record<string, unknown>;

    if (!resp.ok || data.error) {
      const err = (data.error || {}) as Record<string, unknown>;
      const code = Number(err.code || 0);
      if (code === 190) {
        await db
          .prepare(
            "UPDATE facebook_pages SET token_status = 'expired', status = 'expired' WHERE id = ?"
          )
          .bind(page.id)
          .run();
      }
      return {
        success: false,
        can_post: false,
        message: sanitizeSensitiveText(
          `Page Token không hợp lệ hoặc đã hết hạn: ${err.message || resp.statusText}`
        )
      };
    }

    const tasks = Array.isArray(data.tasks) ? data.tasks.map(String) : page.tasks || [];
    const upper = tasks.map((t) => t.toUpperCase());
    const canPost =
      upper.includes("CREATE_CONTENT") ||
      upper.includes("MANAGE") ||
      upper.includes("MODERATE");
    const isPublished = data.is_published !== false;

    return {
      success: true,
      facebook_page_id: page.facebook_page_id,
      page_name: data.name || page.page_name,
      tasks: upper,
      can_post: canPost,
      is_published: isPublished,
      admin_accounts: page.admin_accounts || [],
      message: canPost
        ? `Fanpage '${page.page_name}' hợp lệ và có đầy đủ quyền đăng Reels (CREATE_CONTENT).`
        : `Fanpage '${page.page_name}' thiếu quyền CREATE_CONTENT trên Meta.`
    };
  } catch (err) {
    return {
      success: false,
      can_post: false,
      message: sanitizeSensitiveText(
        `Lỗi kết nối Graph API khi kiểm tra Page: ${(err as Error).message}`
      )
    };
  }
}

// ==========================================
// 2. VIDEO VALIDATION & RUN TEST (DIAGNOSTIC)
// ==========================================

export async function validateVideoSource(
  db: D1Database,
  env: Env,
  videoPath: string,
  ownerUserId: string
): Promise<{
  video_path: string;
  exists: boolean;
  valid_format: boolean;
  size_mb: number;
  storage_type: string;
  media_id?: string;
  message: string;
}> {
  const clean = (videoPath || "").trim();
  if (!clean) {
    return {
      video_path: "",
      exists: false,
      valid_format: false,
      size_mb: 0,
      storage_type: "none",
      message: "Đường dẫn hoặc tham chiếu video trống."
    };
  }

  // Case 1: Video trên Cloudflare R2 (r2://<media_id>, object_key users/..., d1://video/<media_id>, hoặc media_id trực tiếp)
  if (
    clean.startsWith("r2://") ||
    clean.startsWith("users/") ||
    clean.startsWith("d1://video/") ||
    clean.startsWith("med_") ||
    clean.startsWith("vid_")
  ) {
    const cleanId = clean.replace(/^r2:\/\//, "").replace(/^d1:\/\/video\//, "");
    const media = await getMediaFileById(db, cleanId, ownerUserId);
    if (!media) {
      return {
        video_path: clean,
        exists: false,
        valid_format: false,
        size_mb: 0,
        storage_type: "r2",
        message: "Không tìm thấy video trên Cloudflare R2 hoặc bạn không có quyền sở hữu video này."
      };
    }

    const check = validateVideoMetadata(
      media.original_filename,
      media.size_bytes || 1,
      media.mime_type,
      env
    );
    const sizeMb = Math.round((media.size_bytes / (1024 * 1024)) * 100) / 100;
    const isReady = media.upload_status === "ready";

    return {
      video_path: clean,
      exists: isReady,
      valid_format: check.valid,
      size_mb: sizeMb,
      storage_type: media.storage_backend,
      media_id: media.id,
      message: isReady
        ? `Video R2 hợp lệ: ${media.original_filename} (${sizeMb} MB)`
        : `Video '${media.original_filename}' chưa hoàn tất tải lên R2.`
    };
  }

  // Case 2: Public HTTPS URL
  if (clean.startsWith("https://") || clean.startsWith("http://")) {
    return {
      video_path: clean,
      exists: true,
      valid_format: true,
      size_mb: 1.0,
      storage_type: "remote_url",
      message: "URL Video trực tuyến hợp lệ (Sẵn sàng tải lên Meta Graph API)."
    };
  }

  // Case 3: Đường dẫn ổ đĩa Windows cũ (C:\, D:\, E:\) -> Cảnh báo rõ ràng trên Cloudflare
  if (/^[a-zA-Z]:\\/.test(clean) || clean.startsWith("\\\\")) {
    return {
      video_path: clean,
      exists: false,
      valid_format: false,
      size_mb: 0,
      storage_type: "legacy_windows_path",
      message:
        "Đường dẫn ổ đĩa Windows cục bộ không được hỗ trợ trên Cloudflare Workers. Vui lòng nhấn 'Tải Video Lên R2' từ trình duyệt."
    };
  }

  return {
    video_path: clean,
    exists: false,
    valid_format: false,
    size_mb: 0,
    storage_type: "unknown",
    message:
      "Tham chiếu video không hợp lệ. Vui lòng tải file video lên Cloudflare R2 hoặc nhập URL HTTPS hợp lệ."
  };
}

/**
 * Chế độ Chạy Thử (Run Test) - TUYỆT ĐỐI KHÔNG upload hay publish bất kỳ bài đăng nào
 */
export async function runDiagnosticTest(
  db: D1Database,
  env: Env,
  ownerUserId: string
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const cfg = getMetaConfig(env);
  const statusInfo = await getFacebookAccounts(db, cfg.encryptionKey, false, ownerUserId);
  const connectedAccounts = statusInfo.filter((a) => a.status === "connected");
  const expiredAccounts = statusInfo.filter((a) => a.status === "expired" || a.is_expired);

  const selectedPages = await getFacebookPages(db, cfg.encryptionKey, {
    selectedOnly: true,
    includeToken: true,
    ownerUserId
  });
  const allPages = await getFacebookPages(db, cfg.encryptionKey, {
    selectedOnly: false,
    includeToken: false,
    ownerUserId
  });

  const pageChecks: Array<Record<string, unknown>> = [];
  let validPagesCount = 0;

  for (const p of selectedPages) {
    const hasToken = Boolean((p as { page_access_token?: string }).page_access_token);
    const canPost = Boolean(p.can_post) && hasToken && p.token_status === "valid";
    if (canPost) validPagesCount++;

    pageChecks.push({
      facebook_page_id: p.facebook_page_id,
      page_name: p.page_name,
      has_token: hasToken,
      token_status: p.token_status,
      can_post: canPost,
      tasks: p.tasks || [],
      admin_names: p.admin_names || [],
      status_text: canPost
        ? "Hợp lệ - Đủ quyền CREATE_CONTENT & Page Token sẵn sàng"
        : !hasToken || p.token_status !== "valid"
        ? "Thiếu hoặc hết hạn Page Access Token (cần đồng bộ lại)"
        : "Thiếu quyền đăng bài (CREATE_CONTENT)"
    });
  }

  const allPendingTasks = await getTasks(db, {
    status: "pending",
    ownerUserId
  });
  const selectedIds = new Set(selectedPages.map((p) => p.facebook_page_id));
  const pendingTasks = allPendingTasks.filter(
    (t) => t.facebook_page_id && selectedIds.has(t.facebook_page_id)
  );

  const videoChecks: Array<Record<string, unknown>> = [];
  let validVideosCount = 0;
  let invalidSchedulesCount = 0;
  let validTasksCount = 0;
  const scheduleWarnings: string[] = [];

  for (const t of pendingTasks) {
    const vCheck = await validateVideoSource(db, env, t.object_key || t.media_id || t.video_path, ownerUserId);
    const videoOk = vCheck.exists && vCheck.valid_format;
    if (videoOk) validVideosCount++;

    let scheduleOk = true;
    const sDate = (t.schedule_date || "").trim();
    const sTime = (t.schedule_time || "").trim();
    if (sDate || sTime) {
      const parsed = parseVnScheduleToUtc(sDate, sTime);
      if (!parsed.isValid) {
        scheduleOk = false;
        invalidSchedulesCount++;
        scheduleWarnings.push(`Task #${t.id}: ${parsed.error}`);
      }
    }

    if (videoOk && scheduleOk) {
      validTasksCount++;
    }

    videoChecks.push({
      task_id: t.id,
      facebook_page_id: t.facebook_page_id,
      page_name: t.page_name || t.facebook_page_id,
      caption_preview: (t.caption || "").slice(0, 60),
      has_comment: Boolean((t.comment_text || "").trim()),
      ...vCheck
    });
  }

  const missingPermissions = Array.from(
    new Set(connectedAccounts.flatMap((a) => a.missing_scopes || []))
  );

  let overallStatus = "ready";
  let summaryMsg =
    "Hệ thống sẵn sàng! Tất cả cấu hình OAuth, quyền Fanpage và Video R2 đều hợp lệ (Chế độ Run Test an toàn: Không tải lên hay đăng bất kỳ Reels nào).";

  if (connectedAccounts.length === 0) {
    overallStatus = "error";
    summaryMsg =
      "Chưa kết nối tài khoản Facebook Admin nào hoặc toàn bộ Token đã hết hạn. Vui lòng kết nối qua Meta OAuth trước.";
  } else if (selectedPages.length === 0) {
    overallStatus = "warning";
    summaryMsg = "Bạn chưa tích chọn Fanpage nào ở bảng bên trái.";
  } else if (validPagesCount < selectedPages.length) {
    overallStatus = "warning";
    summaryMsg = `Có ${selectedPages.length - validPagesCount}/${selectedPages.length} Fanpage đang chọn bị thiếu quyền đăng bài hoặc hết hạn Token.`;
  } else if (pendingTasks.length > 0 && validVideosCount < pendingTasks.length) {
    overallStatus = "warning";
    summaryMsg = `Có ${pendingTasks.length - validVideosCount}/${pendingTasks.length} tác vụ chờ xử lý có tham chiếu video chưa hợp lệ trên R2.`;
  } else if (invalidSchedulesCount > 0) {
    overallStatus = "warning";
    summaryMsg = `Có ${invalidSchedulesCount} tác vụ có định dạng ngày/giờ hẹn lịch chưa hợp lệ.`;
  }

  const durationMs = Date.now() - startedAt;

  return {
    status: overallStatus,
    message: summaryMsg,
    duration_ms: durationMs,
    executed_at: new Date().toISOString(),
    oauth_check: {
      is_connected: connectedAccounts.length > 0,
      connected_accounts: connectedAccounts.length,
      expired_accounts: expiredAccounts.length,
      user_name: connectedAccounts[0]?.facebook_user_name || null,
      user_id: connectedAccounts[0]?.facebook_user_id || null,
      days_remaining: connectedAccounts[0]?.days_remaining ?? null,
      missing_scopes: missingPermissions,
      required_scopes: REQUIRED_SCOPES
    },
    total_pages_count: allPages.length,
    selected_pages_count: selectedPages.length,
    valid_pages_count: validPagesCount,
    page_checks: pageChecks,
    pending_tasks_count: pendingTasks.length,
    valid_tasks_count: validTasksCount,
    total_videos_count: pendingTasks.length,
    valid_videos_count: validVideosCount,
    video_checks: videoChecks,
    invalid_schedules_count: invalidSchedulesCount,
    schedule_warnings: scheduleWarnings
  };
}

// ==========================================
// 3. OFFICIAL META REELS PUBLISHING API
// ==========================================

export interface PublishReelResult {
  success: boolean;
  video_id?: string;
  post_id?: string;
  video_url?: string;
  comment_id?: string | null;
  error_code?: number | null;
  error_subcode?: number | null;
  retryable?: boolean;
  ambiguous_publish?: boolean;
  stage?: string;
  message: string;
}

/**
 * Thực thi xuất bản Reels chính thức qua Meta Graph API `/{page_id}/video_reels`
 * - Lấy video từ Cloudflare R2 (Streaming) và kiểm tra quyền sở hữu
 * - Không đánh dấu thành công nếu bước `finish` chưa xác nhận
 * - Cờ `ambiguous_publish` để Queue Consumer không retry mù quáng tránh đăng trùng Reels
 */
export async function publishReelViaGraphApi(
  db: D1Database,
  env: Env,
  params: {
    facebookPageId: string;
    pageAccessToken: string;
    videoRef: string;
    caption: string;
    commentText?: string;
    ownerUserId: string;
    onStageLog?: (stage: string, message: string) => Promise<void>;
  }
): Promise<PublishReelResult> {
  const cfg = getMetaConfig(env);
  const { facebookPageId, pageAccessToken, videoRef, caption, commentText, ownerUserId, onStageLog } =
    params;

  if (!pageAccessToken) {
    return {
      success: false,
      retryable: false,
      stage: "auth_check",
      message: "Thiếu Page Access Token hợp lệ."
    };
  }

  let videoStream: ReadableStream<Uint8Array> | null = null;
  let videoBytes: Uint8Array | null = null;
  let videoSizeBytes = 0;
  let remoteVideoUrl: string | null = null;

  const cleanRef = (videoRef || "").trim();
  if (
    cleanRef.startsWith("r2://") ||
    cleanRef.startsWith("users/") ||
    cleanRef.startsWith("d1://video/") ||
    cleanRef.startsWith("med_") ||
    cleanRef.startsWith("vid_")
  ) {
    const r2Res = await openVideoFromStorage(db, env, cleanRef, ownerUserId);
    if (!r2Res.found) {
      return {
        success: false,
        retryable: false,
        stage: "r2_read",
        message: r2Res.error || "Không tìm thấy video trên Cloudflare R2."
      };
    }
    videoStream = r2Res.stream || null;
    videoSizeBytes = r2Res.sizeBytes || 0;
    if (r2Res.getBytes && videoSizeBytes <= 30 * 1024 * 1024) {
      videoBytes = await r2Res.getBytes();
      videoSizeBytes = videoBytes.byteLength;
    }
  } else if (cleanRef.startsWith("https://") || cleanRef.startsWith("http://")) {
    remoteVideoUrl = cleanRef;
  } else {
    return {
      success: false,
      retryable: false,
      stage: "validate_video",
      message:
        "Nguồn video không hợp lệ trên Cloudflare Workers. Vui lòng tải video lên R2 trước khi đăng."
    };
  }

  try {
    // GIAI ĐOẠN 1: Khởi tạo phiên upload Reels (upload_phase=start)
    if (onStageLog) {
      await onStageLog("start_session", `Khởi tạo phiên upload Reels trên Page ${facebookPageId}...`);
    }

    const startResp = await fetch(`${cfg.graphBase}/${facebookPageId}/video_reels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "start",
        access_token: pageAccessToken
      })
    });
    const startData = (await startResp.json()) as Record<string, unknown>;

    if (!startResp.ok || startData.error || !startData.video_id) {
      const err = (startData.error || {}) as Record<string, unknown>;
      const code = Number(err.code || 0);
      const subcode = Number(err.error_subcode || 0);
      const isTokenErr = code === 190 || code === 10 || code === 200;
      if (isTokenErr) {
        await db
          .prepare(
            "UPDATE facebook_pages SET token_status = 'expired', status = 'expired' WHERE facebook_page_id = ? AND owner_user_id = ?"
          )
          .bind(facebookPageId, ownerUserId)
          .run();
      }
      return {
        success: false,
        error_code: code || startResp.status,
        error_subcode: subcode || null,
        retryable: !isTokenErr && startResp.status >= 500,
        stage: "start_session",
        message: sanitizeSensitiveText(
          `Lỗi khởi tạo phiên Reels (start): ${err.message || startResp.statusText}`
        )
      };
    }

    const videoId = String(startData.video_id);
    const uploadUrl = String(
      startData.upload_url || `https://rupload.facebook.com/video-upload/${cfg.graphVersion}/${videoId}`
    );

    // GIAI ĐOẠN 2: Upload dữ liệu binary lên rupload.facebook.com
    if (onStageLog) {
      await onStageLog(
        "upload_binary",
        `Đang truyền dữ liệu video lên Meta (${videoId}, size=${videoSizeBytes} bytes)...`
      );
    }

    let uploadResp: Response;
    if (remoteVideoUrl) {
      uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${pageAccessToken}`,
          file_url: remoteVideoUrl
        }
      });
    } else if (videoBytes) {
      uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${pageAccessToken}`,
          offset: "0",
          file_size: String(videoBytes.byteLength),
          "Content-Type": "application/octet-stream"
        },
        body: videoBytes as unknown as BodyInit
      });
    } else if (videoStream) {
      uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${pageAccessToken}`,
          offset: "0",
          file_size: String(videoSizeBytes),
          "Content-Type": "application/octet-stream"
        },
        body: videoStream as unknown as BodyInit,
        // @ts-ignore Cloudflare Workers duplex stream support
        duplex: "half"
      });
    } else {
      return {
        success: false,
        retryable: false,
        stage: "upload_binary",
        message: "Không có luồng dữ liệu video để tải lên."
      };
    }

    const uploadData = (await uploadResp.json()) as Record<string, unknown>;
    if (!uploadResp.ok || uploadData.error) {
      const err = (uploadData.error || {}) as Record<string, unknown>;
      const code = Number(err.code || uploadResp.status);
      const subcode = Number(err.error_subcode || 0);
      return {
        success: false,
        video_id: videoId,
        error_code: code,
        error_subcode: subcode || null,
        retryable: uploadResp.status >= 500 || code === 1 || code === 2,
        stage: "upload_binary",
        message: sanitizeSensitiveText(
          `Lỗi tải dữ liệu video lên Meta (rupload): ${err.message || uploadResp.statusText}`
        )
      };
    }

    // GIAI ĐOẠN 3: Hoàn tất và xuất bản Reels (upload_phase=finish)
    if (onStageLog) {
      await onStageLog("finish_publish", `Đang xác nhận xuất bản Reels (video_id=${videoId})...`);
    }

    const finishParams = new URLSearchParams({
      access_token: pageAccessToken,
      video_id: videoId,
      upload_phase: "finish",
      video_state: "PUBLISHED",
      description: caption || ""
    });

    let finishResp: Response;
    try {
      finishResp = await fetch(
        `${cfg.graphBase}/${facebookPageId}/video_reels?${finishParams.toString()}`,
        { method: "POST" }
      );
    } catch (networkErr) {
      // Lỗi mạng xảy ra NGAY LÚC gọi finish -> Không rõ Meta đã tạo bài hay chưa!
      return {
        success: false,
        video_id: videoId,
        retryable: false,
        ambiguous_publish: true,
        stage: "finish_publish",
        message: sanitizeSensitiveText(
          `Mất kết nối khi xác nhận xuất bản Reels (video_id=${videoId}). Tạm dừng retry tự động để tránh đăng trùng bài: ${(networkErr as Error).message}`
        )
      };
    }

    const finishData = (await finishResp.json()) as Record<string, unknown>;
    if (!finishResp.ok || finishData.error) {
      const err = (finishData.error || {}) as Record<string, unknown>;
      const code = Number(err.code || finishResp.status);
      const subcode = Number(err.error_subcode || 0);
      // Nếu lỗi 5xx ở bước finish, có khả năng Meta đã nhận lệnh publish -> không tự động retry mù quáng
      const isAmbiguous = finishResp.status >= 500;
      return {
        success: false,
        video_id: videoId,
        error_code: code,
        error_subcode: subcode || null,
        retryable: false,
        ambiguous_publish: isAmbiguous,
        stage: "finish_publish",
        message: sanitizeSensitiveText(
          `Lỗi xuất bản Reels (finish): ${err.message || finishResp.statusText}`
        )
      };
    }

    const postId = String(finishData.post_id || videoId);
    let permalinkUrl = `https://www.facebook.com/reel/${videoId}`;

    // Kiểm tra permalink & trạng thái xử lý video
    try {
      const infoResp = await fetch(
        `${cfg.graphBase}/${videoId}?fields=id,permalink_url,status&access_token=${encodeURIComponent(pageAccessToken)}`
      );
      if (infoResp.ok) {
        const infoData = (await infoResp.json()) as { permalink_url?: string };
        if (infoData.permalink_url) {
          permalinkUrl = infoData.permalink_url.startsWith("http")
            ? infoData.permalink_url
            : `https://www.facebook.com${infoData.permalink_url}`;
        }
      }
    } catch {
      // Keep default permalinkUrl
    }

    // GIAI ĐOẠN 4: Tự động đăng bình luận dưới Reels (nếu có commentText)
    let commentId: string | null = null;
    let commentLog = "";
    const cleanComment = (commentText || "").trim();
    if (cleanComment) {
      try {
        const targetObj = postId || videoId;
        const cmtResp = await fetch(`${cfg.graphBase}/${targetObj}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: cleanComment,
            access_token: pageAccessToken
          })
        });
        const cmtData = (await cmtResp.json()) as Record<string, unknown>;
        if (cmtResp.ok && cmtData.id) {
          commentId = String(cmtData.id);
          commentLog = ` | Đã đăng bình luận tự động (${commentId})`;
        } else {
          const cErr = (cmtData.error || {}) as Record<string, unknown>;
          commentLog = ` | Cảnh báo comment: ${sanitizeSensitiveText(cErr.message || "Không thể tạo bình luận")}`;
        }
      } catch (cEx) {
        commentLog = ` | Cảnh báo comment: ${sanitizeSensitiveText((cEx as Error).message)}`;
      }
    }

    return {
      success: true,
      video_id: videoId,
      post_id: postId,
      video_url: permalinkUrl,
      comment_id: commentId,
      stage: "completed",
      message: `Đăng Reels thành công! Video ID: ${videoId}${commentLog}`
    };
  } catch (err) {
    return {
      success: false,
      retryable: false,
      stage: "exception",
      message: sanitizeSensitiveText(
        `Lỗi ngoại lệ khi xuất bản Reels: ${(err as Error).message}`
      )
    };
  }
}
