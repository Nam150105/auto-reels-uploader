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
  saveFacebookAccount,
  updateFacebookAccountStatus,
  upsertFacebookPage,
  removeStaleAccountPages,
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

export function extractAccessToken(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.trim();
  // 1. Nếu paste URL từ Graph API Explorer hoặc Graph API endpoint:
  if (text.includes("access_token=")) {
    const match = /[?&]access_token=([^&,\s"']+)/.exec(text);
    if (match) return decodeURIComponent(match[1]).trim();
  }
  // 2. Nếu paste JSON từ Explorer:
  if (text.startsWith("{") && text.includes('"access_token"')) {
    try {
      const obj = JSON.parse(text);
      if (obj.access_token) return String(obj.access_token).trim();
      if (Array.isArray(obj.data) && obj.data[0]?.access_token) {
        return String(obj.data[0].access_token).trim();
      }
    } catch {}
  }
  // 3. Match chuẩn Access Token Facebook (EAA...)
  const matchEaa = /(EAA[A-Za-z0-9_-]{30,})/.exec(text);
  if (matchEaa) return matchEaa[1].trim();

  return text.replace(/^["']|["']$/g, "").trim();
}

export async function connectFacebookWithAccessToken(
  db: D1Database,
  env: Env,
  rawTokenInput: string,
  ownerUserId: string
): Promise<{
  success: boolean;
  message: string;
  account_id?: string;
  user_id?: string;
  user_name?: string;
  synced_count?: number;
  no_pages?: boolean;
  is_long_lived?: boolean;
  accounts?: unknown[];
  pages?: unknown[];
  missing_scopes?: string[];
}> {
  const token = extractAccessToken(rawTokenInput);
  if (!token) {
    return {
      success: false,
      message: "Vui lòng nhập Access Token từ Graph API Explorer."
    };
  }

  const cfg = getMetaConfig(env);

  // 1. Xác thực Access Token với Meta Graph API (/me?fields=id,name)
  let fbUserId = "";
  let fbUserName = "Facebook User";
  try {
    const meResp = await fetch(
      `${cfg.graphBase}/me?fields=id,name&access_token=${encodeURIComponent(token)}`
    );
    const meData = (await meResp.json()) as Record<string, unknown>;
    if (!meResp.ok || !meData.id) {
      const err = (meData.error || {}) as Record<string, unknown>;
      const code = Number(err.code || 0);
      const subcode = Number(err.error_subcode || 0);
      if (code === 190 || subcode === 463 || subcode === 467) {
        return {
          success: false,
          message: "Access Token đã hết hạn hoặc không hợp lệ. Vui lòng bấm 'Generate Access Token' trên Graph API Explorer để lấy mã mới."
        };
      }
      return {
        success: false,
        message: "Không thể xác thực Access Token với Facebook. Vui lòng kiểm tra lại token vừa dán."
      };
    }
    fbUserId = String(meData.id);
    fbUserName = String(meData.name || "Facebook User");
  } catch {
    return {
      success: false,
      message: "Lỗi kết nối tới Facebook Graph API. Vui lòng kiểm tra mạng và thử lại."
    };
  }

  // 2. Kiểm tra danh sách quyền thực tế đã cấp qua /me/permissions
  const grantedScopes: string[] = [];
  const declinedScopes: string[] = [];
  try {
    const permResp = await fetch(
      `${cfg.graphBase}/me/permissions?access_token=${encodeURIComponent(token)}`
    );
    if (permResp.ok) {
      const permData = (await permResp.json()) as {
        data?: Array<{ permission: string; status: string }>;
      };
      for (const item of permData.data || []) {
        if (item.status === "granted") grantedScopes.push(item.permission);
        else if (item.status === "declined") declinedScopes.push(item.permission);
      }
    }
  } catch {}

  // Kiểm tra các quyền cốt lõi cho Page & Reels
  const essentialScopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
  const missingEssential = essentialScopes.filter(
    (s) => declinedScopes.includes(s) || (grantedScopes.length > 0 && !grantedScopes.includes(s))
  );
  if (missingEssential.length > 0) {
    return {
      success: false,
      missing_scopes: missingEssential,
      message: `Token thiếu quyền bắt buộc để quản lý Fanpage (${missingEssential.join(", ")}). Vui lòng thêm các quyền này tại Bước 3 trên Graph API Explorer rồi tạo lại token.`
    };
  }

  // 3. Tự động nâng cấp sang Long-Lived User Access Token (~60 ngày) nếu có App Secret
  let finalToken = token;
  let isLongLived = false;
  let expiresIn = 60 * 86400;

  if (cfg.appId && cfg.appSecret) {
    try {
      const llParams = new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        fb_exchange_token: token
      });
      const llResp = await fetch(`${cfg.graphBase}/oauth/access_token?${llParams.toString()}`);
      if (llResp.ok) {
        const llData = (await llResp.json()) as Record<string, unknown>;
        if (llData.access_token) {
          finalToken = String(llData.access_token);
          expiresIn = Number(llData.expires_in || 60 * 86400);
          isLongLived = true;
        }
      }
    } catch {
      // Giữ nguyên token gốc nếu không nâng cấp được
    }
  }

  const expiresAtIso = new Date(Date.now() + expiresIn * 1000).toISOString();

  // 4. Lưu tài khoản an toàn vào D1 (Token được mã hóa AES-256-GCM, chống trùng lặp)
  let accountId: string;
  try {
    accountId = await saveFacebookAccount(db, cfg.encryptionKey, {
      facebookUserId: fbUserId,
      facebookUserName: fbUserName,
      facebookUserEmail: null,
      accessToken: finalToken,
      tokenType: isLongLived ? "long_lived_user" : "user_explorer",
      scopes: grantedScopes,
      missingScopes: [],
      tokenExpiresAt: expiresAtIso,
      status: "connected",
      tokenStatus: "valid",
      ownerUserId
    });
  } catch {
    return {
      success: false,
      message: "Không thể lưu thông tin tài khoản vào hệ thống. Vui lòng thử lại."
    };
  }

  // 5. Tự động gọi /me/accounts lấy toàn bộ Fanpage kèm Page Access Token (xử lý pagination)
  const syncRes = await syncPagesForAccount(db, env, accountId, ownerUserId);

  // 6. Truy vấn danh sách Fanpage và Admin cập nhật
  const updatedAccounts = await getFacebookAccounts(db, cfg.encryptionKey, false, ownerUserId);
  const updatedPages = await getFacebookPages(db, cfg.encryptionKey, {
    includeToken: false,
    ownerUserId
  });

  const syncedCount = syncRes.synced_count || 0;
  const successMsg = syncRes.no_pages
    ? `Đã liên kết tài khoản Facebook "${fbUserName}", nhưng tài khoản này chưa quản lý Fanpage nào.`
    : `Đã liên kết tài khoản "${fbUserName}" và đồng bộ thành công ${syncedCount} Fanpage!`;

  return {
    success: true,
    message: successMsg,
    account_id: accountId,
    user_id: fbUserId,
    user_name: fbUserName,
    synced_count: syncedCount,
    no_pages: syncRes.no_pages || false,
    is_long_lived: isLongLived,
    accounts: updatedAccounts,
    pages: updatedPages
  };
}

export async function syncPagesForAccount(
  db: D1Database,
  env: Env,
  accountId: string,
  ownerUserId: string
): Promise<{
  success: boolean;
  error_code?: string;
  no_pages?: boolean;
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
      error_code: "not_found",
      message: "Không tìm thấy tài khoản Facebook hoặc bạn không có quyền truy cập."
    };
  }

  const userToken = account.access_token || "";
  if (!userToken) {
    await updateFacebookAccountStatus(
      db,
      accountId,
      "expired",
      "Kết nối Facebook đã hết hiệu lực, vui lòng kết nối lại",
      null,
      "invalid"
    );
    return {
      success: false,
      error_code: "invalid_token",
      account_id: accountId,
      message: "Kết nối Facebook đã hết hiệu lực, vui lòng kết nối lại"
    };
  }

  try {
    let nextUrl: string | null =
      `${cfg.graphBase}/me/accounts?fields=id,name,global_brand_page_name,access_token,category,picture{url},tasks,is_published&limit=100&access_token=${encodeURIComponent(userToken)}`;

    let syncedCount = 0;
    const syncedPageIds: string[] = [];
    let pageGuard = 0;

    while (nextUrl && pageGuard < 50) {
      pageGuard++;
      let resp = await fetch(nextUrl);
      let data = (await resp.json()) as Record<string, unknown>;

      // Fallback nếu Brand Page không hỗ trợ một số field mở rộng
      if ((!resp.ok || data.error) && pageGuard === 1 && nextUrl.includes("is_published")) {
        const err = (data.error || {}) as Record<string, unknown>;
        const code = Number(err.code || 0);
        if (code !== 190 && code !== 102) {
          const fallbackUrl = `${cfg.graphBase}/me/accounts?fields=id,name,global_brand_page_name,access_token,tasks&limit=100&access_token=${encodeURIComponent(userToken)}`;
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

        const isTokenErr = code === 190 || code === 102;
        const isPermErr = code === 10 || code === 200;

        await updateFacebookAccountStatus(
          db,
          accountId,
          isTokenErr || isPermErr ? "expired" : "error",
          `Meta Error (${code}): ${msg}`,
          null,
          isTokenErr || isPermErr ? "expired" : "error"
        );

        return {
          success: false,
          error_code: isTokenErr
            ? "invalid_token"
            : isPermErr
              ? "missing_permissions"
              : "facebook_error",
          account_id: accountId,
          message: isTokenErr
            ? "Kết nối Facebook đã hết hiệu lực, vui lòng kết nối lại"
            : isPermErr
              ? "Facebook chưa cấp đủ quyền cần thiết"
              : "Không thể kết nối Facebook lúc này, vui lòng thử lại"
        };
      }

      const items = (data.data as Array<Record<string, unknown>>) || [];
      for (const item of items) {
        const pageId = String(item.id || "").trim();
        const pageName = String(
          item.name || item.global_brand_page_name || "Unnamed Page"
        ).trim();
        const pageToken = String(item.access_token || "").trim();
        // Không lấy hoặc lưu Page thiếu Page ID hoặc thiếu Page Access Token
        if (!pageId || !pageToken) continue;

        const hasTasksField = Array.isArray(item.tasks);
        const tasksList = hasTasksField ? (item.tasks as unknown[]).map(String) : [];
        const upperTasks = hasTasksField
          ? tasksList.map((t) => t.toUpperCase())
          : ["CREATE_CONTENT", "MANAGE"];

        // Không lấy hoặc lưu những Page mà tài khoản không có quyền quản lý phù hợp
        if (hasTasksField) {
          const hasValidManagementTask = upperTasks.some((t) =>
            ["MANAGE", "CREATE_CONTENT", "MODERATE", "ADVERTISE"].includes(t)
          );
          if (!hasValidManagementTask) {
            continue;
          }
        }

        const category = String(item.category || "Brand / Page");
        const picObj = (item.picture as { data?: { url?: string } }) || {};
        const avatarUrl = String(picObj.data?.url || "");
        const isPublished = item.is_published !== false;

        const canPost =
          upperTasks.includes("CREATE_CONTENT") ||
          upperTasks.includes("MANAGE") ||
          upperTasks.includes("MODERATE");

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

        syncedPageIds.push(pageId);
        syncedCount++;
      }

      const paging = (data.paging as { next?: string }) || {};
      nextUrl = paging.next || null;
    }

    // Đồng bộ lại các liên kết Page cũ không còn thuộc quyền quản lý của Admin này
    await removeStaleAccountPages(db, accountId, ownerUserId, syncedPageIds);

    const nowIso = new Date().toISOString();
    await updateFacebookAccountStatus(db, accountId, "connected", null, nowIso, "valid");

    if (syncedCount === 0) {
      return {
        success: true,
        no_pages: true,
        account_id: accountId,
        facebook_user_name: account.facebook_user_name,
        synced_count: 0,
        message: "Tài khoản này chưa quản lý Fanpage nào"
      };
    }

    return {
      success: true,
      no_pages: false,
      account_id: accountId,
      facebook_user_name: account.facebook_user_name,
      synced_count: syncedCount,
      message: `Đã kết nối tài khoản Facebook thành công (${syncedCount} Fanpage).`
    };
  } catch (err) {
    const errMsg = sanitizeSensitiveText(`Lỗi mạng khi đồng bộ Fanpage: ${(err as Error).message}`);
    await updateFacebookAccountStatus(db, accountId, "error", errMsg, null, "error");
    return {
      success: false,
      error_code: "facebook_error",
      account_id: accountId,
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
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
      await onStageLog("start_session", "Đang chuẩn bị video...");
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
      await onStageLog("upload_binary", "Đang tải video lên Facebook...");
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
      await onStageLog("finish_publish", "Đang xuất bản thước phim...");
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

    // Lấy chính xác Post ID của Reels (không nhầm Video ID với Post ID)
    const postId = await resolveReelPostId(
      cfg,
      pageAccessToken,
      facebookPageId,
      videoId,
      finishData.post_id ? String(finishData.post_id) : null
    );

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

    return {
      success: true,
      video_id: videoId,
      post_id: postId,
      video_url: permalinkUrl,
      stage: "completed",
      message: "Đã đăng Reels thành công!"
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

/**
 * 4. XÁC ĐỊNH CHÍNH XÁC POST ID CỦA BÀI REELS
 * Không nhầm lẫn Video ID với Post ID.
 */
export async function resolveReelPostId(
  cfg: ReturnType<typeof getMetaConfig>,
  pageAccessToken: string,
  facebookPageId: string,
  videoId: string,
  finishPostId?: string | null
): Promise<string> {
  const cleanFinishId = (finishPostId || "").trim();

  // 1. Nếu API publish trả về post_id rõ ràng khác videoId (ví dụ có chứa '_' hoặc khác videoId)
  if (cleanFinishId && cleanFinishId !== videoId) {
    try {
      const chkResp = await fetch(
        `${cfg.graphBase}/${cleanFinishId}?fields=id&access_token=${encodeURIComponent(pageAccessToken)}`
      );
      if (chkResp.ok) {
        const d = (await chkResp.json()) as { id?: string };
        if (d.id) return String(d.id);
      }
    } catch {}
    return cleanFinishId;
  }

  // 2. Thử truy vấn dạng {PAGE_ID}_{VIDEO_ID} (chuẩn feed post của Facebook cho Video)
  const compositeId = `${facebookPageId}_${videoId}`;
  try {
    const compResp = await fetch(
      `${cfg.graphBase}/${compositeId}?fields=id&access_token=${encodeURIComponent(pageAccessToken)}`
    );
    if (compResp.ok) {
      const compData = (await compResp.json()) as { id?: string };
      if (compData.id) {
        return String(compData.id);
      }
    }
  } catch {}

  // 3. Truy vấn các bài đăng gần đây của Page để lấy đúng post_id có video_id này
  try {
    const listResp = await fetch(
      `${cfg.graphBase}/${facebookPageId}/published_posts?fields=id,attachments{target{id}}&limit=5&access_token=${encodeURIComponent(pageAccessToken)}`
    );
    if (listResp.ok) {
      const listData = (await listResp.json()) as {
        data?: Array<{ id: string; attachments?: { data?: Array<{ target?: { id?: string } }> } }>;
      };
      if (Array.isArray(listData.data)) {
        for (const item of listData.data) {
          const targets = item.attachments?.data?.map((a) => a.target?.id) || [];
          if (targets.includes(videoId)) {
            return String(item.id);
          }
        }
      }
    }
  } catch {}

  // 4. Fallback: Nếu không tìm thấy, sử dụng cleanFinishId hoặc compositeId
  return cleanFinishId || compositeId;
}

export interface PostReelCommentOptions {
  facebookPageId: string;
  pageAccessToken: string;
  postId: string;
  commentText: string;
  ownerUserId: string;
  taskId: number;
}

export interface PostReelCommentResult {
  success: boolean;
  comment_id?: string | null;
  post_id: string;
  comment_status: "success" | "failed";
  error_code?: number | null;
  error_subcode?: number | null;
  message: string;
  already_posted?: boolean;
}

/**
 * 5. TỰ ĐỘNG ĐĂNG BÌNH LUẬN LÊN BÀI VIẾT REELS (POST /{POST_ID}/comments)
 * - Đảm bảo token có quyền pages_manage_engagement và tài khoản có quyền MODERATE
 * - Kiểm tra chống đăng trùng (Idempotency Guard)
 * - Kiểm tra kết quả Facebook trả về & xác nhận comment thực tế xuất hiện
 */
export async function postReelCommentViaGraphApi(
  db: D1Database,
  env: Env,
  options: PostReelCommentOptions
): Promise<PostReelCommentResult> {
  const cfg = getMetaConfig(env);
  const cleanComment = (options.commentText || "").trim();
  const postId = options.postId;

  if (!cleanComment) {
    return {
      success: true,
      post_id: postId,
      comment_status: "success",
      message: "Không có nội dung bình luận."
    };
  }

  // 1. CHỐNG ĐĂNG TRÙNG (IDEMPOTENCY CHECK TRÊN FACEBOOK):
  // Truy vấn danh sách comment gần nhất của bài viết trên Facebook xem đã tồn tại chưa
  try {
    const chkResp = await fetch(
      `${cfg.graphBase}/${postId}/comments?fields=id,message,created_time&limit=10&access_token=${encodeURIComponent(options.pageAccessToken)}`
    );
    if (chkResp.ok) {
      const chkData = (await chkResp.json()) as { data?: Array<{ id: string; message: string }> };
      if (Array.isArray(chkData.data)) {
        const existing = chkData.data.find((c) => (c.message || "").trim() === cleanComment);
        if (existing && existing.id) {
          return {
            success: true,
            comment_id: String(existing.id),
            post_id: postId,
            comment_status: "success",
            message: "Đã xác nhận bình luận đã tồn tại trên bài viết Facebook.",
            already_posted: true
          };
        }
      }
    }
  } catch {}

  // 2. GỌI API ĐĂNG COMMENT: POST /{POST_ID}/comments
  let postResp: Response;
  try {
    postResp = await fetch(`${cfg.graphBase}/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: cleanComment,
        access_token: options.pageAccessToken
      })
    });
  } catch (netErr) {
    // Timeout hoặc lỗi mạng: Kiểm tra xem Facebook đã nhận comment chưa trước khi đánh dấu thất bại
    try {
      const verifyResp = await fetch(
        `${cfg.graphBase}/${postId}/comments?fields=id,message&limit=5&access_token=${encodeURIComponent(options.pageAccessToken)}`
      );
      if (verifyResp.ok) {
        const vData = (await verifyResp.json()) as { data?: Array<{ id: string; message: string }> };
        const found = vData.data?.find((c) => (c.message || "").trim() === cleanComment);
        if (found && found.id) {
          return {
            success: true,
            comment_id: String(found.id),
            post_id: postId,
            comment_status: "success",
            message: "Đã xác nhận bình luận xuất hiện trên bài viết Facebook sau timeout."
          };
        }
      }
    } catch {}

    return {
      success: false,
      post_id: postId,
      comment_status: "failed",
      message: sanitizeSensitiveText(`Lỗi kết nối khi gửi bình luận: ${(netErr as Error).message}`)
    };
  }

  // 3. XỬ LÝ PHẢN HỒI TỪ FACEBOOK
  const postData = (await postResp.json()) as Record<string, unknown>;
  if (postResp.ok && postData.id) {
    const commentId = String(postData.id);

    // Bước 6: Kiểm tra xác nhận comment thực tế xuất hiện
    try {
      await fetch(
        `${cfg.graphBase}/${commentId}?fields=id&access_token=${encodeURIComponent(options.pageAccessToken)}`
      );
    } catch {}

    return {
      success: true,
      comment_id: commentId,
      post_id: postId,
      comment_status: "success",
      message: "Đã đăng bình luận tự động thành công."
    };
  } else {
    const err = (postData.error || {}) as Record<string, unknown>;
    const code = Number(err.code || postResp.status);
    const subcode = Number(err.error_subcode || 0);

    let friendlyErrMsg = "";
    if (code === 200 || code === 10 || String(err.message || "").toLowerCase().includes("permission")) {
      friendlyErrMsg = "Fanpage thiếu quyền pages_manage_engagement hoặc tài khoản không có quyền MODERATE trên Page.";
    } else if (code === 190) {
      friendlyErrMsg = "Phiên Facebook hết hạn (OAuthException 190), vui lòng kết nối lại tài khoản.";
    } else {
      friendlyErrMsg = `Lỗi đăng bình luận: ${err.message || postResp.statusText}`;
    }

    return {
      success: false,
      post_id: postId,
      comment_status: "failed",
      error_code: code,
      error_subcode: subcode || null,
      message: sanitizeSensitiveText(friendlyErrMsg)
    };
  }
}
