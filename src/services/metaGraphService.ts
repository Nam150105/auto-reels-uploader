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
import { encryptToken } from "../utils/crypto.ts";

// ==========================================
// 1. SYNC FANPAGES (/me/accounts PAGINATION)
// ==========================================

export type MetaErrorCategory =
  | "TOKEN_EXPIRED"
  | "TOKEN_REVOKED"
  | "INVALID_TOKEN"
  | "MISSING_PERMISSION"
  | "MISSING_PAGE_ROLE"
  | "PAGE_TOKEN_MISMATCH"
  | "RATE_LIMIT_OR_TEMPORARY"
  | "OTHER_API_ERROR";

export interface ClassifiedMetaError {
  category: MetaErrorCategory;
  code: number;
  subcode: number;
  isTokenDead: boolean;
  isPermissionError: boolean;
  retryable: boolean;
  tokenStatus: "expired" | "revoked" | "invalid" | "missing_permission" | "valid";
  userMessage: string;
}

/**
 * Phân loại chính xác 8 nhóm lỗi Meta Graph API theo Mục 5.1:
 * 1. TOKEN_EXPIRED (190 / subcode 463)
 * 2. TOKEN_REVOKED (190 / subcode 458, 460, 467, 490)
 * 3. INVALID_TOKEN (190, 102)
 * 4. MISSING_PERMISSION (10, 200 thiếu scope OAuth)
 * 5. MISSING_PAGE_ROLE (10, 200 thiếu quyền task trên Page: MODERATE, CREATE_CONTENT, ANALYZE)
 * 6. PAGE_TOKEN_MISMATCH (Page Access Token không khớp Page ID)
 * 7. RATE_LIMIT_OR_TEMPORARY (1, 2, 4, 17, 32, 341, 613, HTTP 429/5xx)
 * 8. OTHER_API_ERROR (Lỗi API khác: #100 metric không hỗ trợ, #803 post không tồn tại...)
 */
export function classifyMetaApiError(
  errObjOrCode: Record<string, unknown> | number | null | undefined,
  httpStatusOrSubcode?: number,
  maybeMessage?: string
): ClassifiedMetaError {
  const isLegacyTuple = typeof errObjOrCode === "number" || typeof maybeMessage === "string";
  const err: Record<string, unknown> = isLegacyTuple
    ? {
        code: Number(errObjOrCode || 0),
        error_subcode: Number(httpStatusOrSubcode || 0),
        message: maybeMessage || ""
      }
    : (errObjOrCode as Record<string, unknown>) || {};
  const httpStatus = isLegacyTuple ? 400 : Number(httpStatusOrSubcode || 400);
  const code = Number(err.code || 0);
  const subcode = Number(err.error_subcode || 0);
  const rawMessage = sanitizeSensitiveText(String(err.message || ""));
  const lower = rawMessage.toLowerCase();

  if (code === 190 || code === 102) {
    if (
      subcode === 458 ||
      subcode === 460 ||
      subcode === 467 ||
      subcode === 490 ||
      lower.includes("revoked") ||
      lower.includes("not authorized") ||
      lower.includes("deauthorized") ||
      lower.includes("changed the password") ||
      lower.includes("logged out")
    ) {
      return {
        category: "TOKEN_REVOKED",
        code: code || 190,
        subcode,
        isTokenDead: true,
        isPermissionError: false,
        retryable: false,
        tokenStatus: "revoked",
        userMessage: `Access Token Facebook đã bị thu hồi hoặc đăng xuất khỏi phiên (${code}${subcode ? "." + subcode : ""}). Vui lòng cập nhật Access Token mới.`
      };
    }

    if (
      subcode === 463 ||
      lower.includes("expired") ||
      lower.includes("session has expired") ||
      lower.includes("validating access token")
    ) {
      return {
        category: "TOKEN_EXPIRED",
        code: code || 190,
        subcode,
        isTokenDead: true,
        isPermissionError: false,
        retryable: false,
        tokenStatus: "expired",
        userMessage: `Access Token Facebook đã hết hạn (${code}${subcode ? "." + subcode : ""}). Vui lòng cập nhật Access Token mới để tiếp tục.`
      };
    }

    return {
      category: "INVALID_TOKEN",
      code: code || 190,
      subcode,
      isTokenDead: true,
      isPermissionError: false,
      retryable: false,
      tokenStatus: "invalid",
      userMessage: `Access Token Facebook không hợp lệ (${code}${subcode ? "." + subcode : ""}: ${rawMessage || "Invalid OAuth access token"}). Vui lòng kiểm tra và cập nhật lại token.`
    };
  }

  if (code === 10 || code === 200 || httpStatus === 403) {
    const mentionsPageRole =
      lower.includes("moderate") ||
      lower.includes("create_content") ||
      lower.includes("analyze") ||
      lower.includes("page role") ||
      lower.includes("admin") ||
      lower.includes("task");
    const mentionsOAuthScope =
      lower.includes("pages_manage_posts") ||
      lower.includes("pages_read_engagement") ||
      lower.includes("pages_show_list") ||
      lower.includes("pages_manage_engagement") ||
      lower.includes("read_insights");

    if (mentionsPageRole && !mentionsOAuthScope) {
      return {
        category: "MISSING_PAGE_ROLE",
        code: code || 200,
        subcode,
        isTokenDead: false,
        isPermissionError: true,
        retryable: false,
        tokenStatus: "missing_permission",
        userMessage: `Tài khoản hiện không có đủ quyền quản trị (MODERATE / CREATE_CONTENT / ANALYZE) trên Fanpage này (#${code}: ${rawMessage}).`
      };
    }

    return {
      category: "MISSING_PERMISSION",
      code: code || 200,
      subcode,
      isTokenDead: false,
      isPermissionError: true,
      retryable: false,
      tokenStatus: "missing_permission",
      userMessage: `Access Token thiếu quyền OAuth cần thiết (#${code}: ${rawMessage}). Vui lòng cấp đủ quyền trên Graph API Explorer và cập nhật lại token.`
    };
  }

  if (
    code === 1 ||
    code === 2 ||
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 341 ||
    code === 613 ||
    httpStatus === 429 ||
    httpStatus >= 500
  ) {
    return {
      category: "RATE_LIMIT_OR_TEMPORARY",
      code: code || httpStatus,
      subcode,
      isTokenDead: false,
      isPermissionError: false,
      retryable: true,
      tokenStatus: "valid",
      userMessage: `Facebook Graph API đang giới hạn tần suất hoặc gặp lỗi tạm thời (#${code || httpStatus}: ${rawMessage || "Temporary error"}). Vui lòng thử lại sau ít phút.`
    };
  }

  if (
    lower.includes("mismatch") ||
    (lower.includes("page token") && lower.includes("page_id")) ||
    lower.includes("does not match target page")
  ) {
    return {
      category: "PAGE_TOKEN_MISMATCH",
      code: code || 100,
      subcode,
      isTokenDead: false,
      isPermissionError: true,
      retryable: false,
      tokenStatus: "missing_permission",
      userMessage: `Page Access Token không khớp với Fanpage đích (#${code || 100}: ${rawMessage}). Hệ thống cần làm mới Page Token từ Admin.`
    };
  }

  return {
    category: "OTHER_API_ERROR",
    code: code || httpStatus,
    subcode,
    isTokenDead: false,
    isPermissionError: false,
    retryable: false,
    tokenStatus: "valid",
    userMessage: rawMessage
      ? `Lỗi từ Facebook Graph API (#${code || httpStatus}): ${rawMessage}`
      : `Lỗi phản hồi từ Facebook Graph API (HTTP ${httpStatus}).`
  };
}

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
  ownerUserId: string,
  targetAccountId: string | null = null
): Promise<{
  success: boolean;
  message: string;
  error_type?: MetaErrorCategory;
  account_id?: string;
  user_id?: string;
  user_name?: string;
  synced_count?: number;
  no_pages?: boolean;
  is_long_lived?: boolean;
  has_read_insights?: boolean;
  insights_warning?: string | null;
  analyze_warning?: string | null;
  missing_permission_page_ids?: string[];
  missing_pages_warning?: string | null;
  accounts?: unknown[];
  pages?: unknown[];
  scopes?: string[];
  missing_scopes?: string[];
}> {
  const token = extractAccessToken(rawTokenInput);
  if (!token) {
    return {
      success: false,
      error_type: "INVALID_TOKEN",
      message: "Vui lòng nhập Access Token từ Graph API Explorer."
    };
  }

  const cfg = getMetaConfig(env);

  // 1. Xác thực Access Token với Meta Graph API (/me?fields=id,name) TRƯỚC KHI ghi đè token cũ (Mục 5.4)
  let fbUserId = "";
  let fbUserName = "Facebook User";
  try {
    const meResp = await fetch(
      `${cfg.graphBase}/me?fields=id,name&access_token=${encodeURIComponent(token)}`
    );
    const meData = (await meResp.json()) as Record<string, unknown>;
    if (!meResp.ok || !meData.id) {
      const err = (meData.error || {}) as Record<string, unknown>;
      const classified = classifyMetaApiError(err, meResp.status);
      if (classified.isTokenDead) {
        return {
          success: false,
          error_type: classified.category,
          message:
            "Access Token đã hết hạn hoặc không hợp lệ. Vui lòng bấm 'Generate Access Token' trên Graph API Explorer để lấy mã mới."
        };
      }
      return {
        success: false,
        error_type: classified.category,
        message: "Không thể xác thực Access Token với Facebook. Vui lòng kiểm tra lại token vừa dán."
      };
    }
    fbUserId = String(meData.id);
    fbUserName = String(meData.name || "Facebook User");
  } catch {
    return {
      success: false,
      error_type: "RATE_LIMIT_OR_TEMPORARY",
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
      error_type: "MISSING_PERMISSION",
      missing_scopes: missingEssential,
      message: `Token thiếu quyền bắt buộc để quản lý Fanpage (${missingEssential.join(", ")}). Vui lòng thêm các quyền này tại Bước 3 trên Graph API Explorer rồi tạo lại token.`
    };
  }

  // Kiểm tra quyền read_insights (Mục 2.3): Nếu thiếu read_insights, vẫn cho phép liên kết & đăng Reels nhưng trả về cảnh báo rõ ràng
  const hasReadInsights = grantedScopes.includes("read_insights");
  const allMissingScopes = REQUIRED_SCOPES.filter(
    (s) => declinedScopes.includes(s) || (grantedScopes.length > 0 && !grantedScopes.includes(s))
  );
  const insightsWarning = !hasReadInsights
    ? "Access Token hiện tại chưa có quyền read_insights. Chức năng đăng Reels vẫn hoạt động, nhưng không thể lấy đầy đủ dữ liệu thống kê Reels."
    : null;

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

  // 4. Lưu tài khoản an toàn vào D1 (Token được mã hóa AES-256-GCM, chống trùng lặp, không lộ token)
  let accountId: string;
  try {
    accountId = await saveFacebookAccount(db, cfg.encryptionKey, {
      facebookUserId: fbUserId,
      facebookUserName: fbUserName,
      facebookUserEmail: null,
      accessToken: finalToken,
      tokenType: isLongLived ? "long_lived_user" : "user_explorer",
      scopes: grantedScopes,
      missingScopes: allMissingScopes,
      hasReadInsights,
      tokenExpiresAt: expiresAtIso,
      status: "connected",
      tokenStatus: "valid",
      accountId: targetAccountId,
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
  let successMsg = syncRes.no_pages
    ? `Đã liên kết tài khoản Facebook "${fbUserName}", nhưng tài khoản này chưa quản lý Fanpage nào.`
    : `Đã liên kết tài khoản "${fbUserName}" và đồng bộ thành công ${syncedCount} Fanpage!`;

  if (insightsWarning) {
    successMsg += ` (${insightsWarning})`;
  }

  return {
    success: true,
    message: successMsg,
    account_id: accountId,
    user_id: fbUserId,
    user_name: fbUserName,
    synced_count: syncedCount,
    no_pages: syncRes.no_pages || false,
    is_long_lived: isLongLived,
    has_read_insights: hasReadInsights,
    insights_warning: insightsWarning,
    analyze_warning: syncRes.analyze_warning || null,
    missing_permission_page_ids: syncRes.missing_permission_page_ids || [],
    missing_pages_warning: syncRes.missing_pages_warning || null,
    scopes: grantedScopes,
    missing_scopes: allMissingScopes,
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
  error_type?: MetaErrorCategory;
  no_pages?: boolean;
  account_id?: string;
  facebook_user_name?: string | null;
  synced_count?: number;
  missing_permission_page_ids?: string[];
  missing_pages_warning?: string | null;
  analyze_warning?: string | null;
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
      error_type: "INVALID_TOKEN",
      account_id: accountId,
      message: "Kết nối Facebook đã hết hiệu lực, vui lòng kết nối lại"
    };
  }

  try {
    let nextUrl: string | null =
      `${cfg.graphBase}/me/accounts?fields=id,name,global_brand_page_name,access_token,category,picture{url},tasks,is_published&limit=100&access_token=${encodeURIComponent(userToken)}`;

    let syncedCount = 0;
    const syncedPageIds: string[] = [];
    const pagesMissingAnalyze: string[] = [];
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
        const classified = classifyMetaApiError(err, resp.status);
        const code = classified.code;
        const msg = sanitizeSensitiveText(String(err.message || "Lỗi gọi /me/accounts"));

        const isTokenErr = classified.isTokenDead;
        const isPermErr = classified.isPermissionError;

        await updateFacebookAccountStatus(
          db,
          accountId,
          isTokenErr || isPermErr ? "expired" : "error",
          `Meta Error (${code}): ${msg}`,
          null,
          classified.tokenStatus === "valid" ? "error" : classified.tokenStatus
        );

        return {
          success: false,
          error_code: isTokenErr
            ? "invalid_token"
            : isPermErr
              ? "missing_permissions"
              : "facebook_error",
          error_type: classified.category,
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
          : ["CREATE_CONTENT", "MANAGE", "ANALYZE"];

        // Không lấy hoặc lưu những Page mà tài khoản không có quyền quản lý phù hợp
        if (hasTasksField) {
          const hasValidManagementTask = upperTasks.some((t) =>
            ["MANAGE", "CREATE_CONTENT", "MODERATE", "ADVERTISE", "ANALYZE"].includes(t)
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
        const canAnalyze =
          upperTasks.includes("ANALYZE") || upperTasks.includes("MANAGE");

        if (!canAnalyze) {
          pagesMissingAnalyze.push(pageName);
        }

        await upsertFacebookPage(db, cfg.encryptionKey, {
          facebookPageId: pageId,
          pageName,
          category,
          avatarUrl,
          pageAccessToken: pageToken,
          tasks: upperTasks,
          canPost,
          canAnalyze,
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

    // Đồng bộ lại các liên kết Page cũ không còn thuộc quyền quản lý của Admin này (Giữ Page cũ nhưng đánh dấu thiếu quyền theo Mục 5.4)
    const stalePageIds = await removeStaleAccountPages(db, accountId, ownerUserId, syncedPageIds);
    invalidatePageTokenVerificationCache();

    const nowIso = new Date().toISOString();
    await updateFacebookAccountStatus(db, accountId, "connected", null, nowIso, "valid");

    const analyzeWarning =
      pagesMissingAnalyze.length > 0
        ? "Tài khoản hiện không có quyền ANALYZE trên Page này để đọc Insights."
        : null;
    const missingPagesWarning =
      stalePageIds.length > 0
        ? "Page này chưa có trong token mới hoặc thiếu quyền quản lý."
        : null;

    if (syncedCount === 0) {
      return {
        success: true,
        no_pages: true,
        account_id: accountId,
        facebook_user_name: account.facebook_user_name,
        synced_count: 0,
        missing_permission_page_ids: stalePageIds,
        missing_pages_warning: missingPagesWarning,
        analyze_warning: analyzeWarning,
        message: "Tài khoản này chưa quản lý Fanpage nào"
      };
    }

    return {
      success: true,
      no_pages: false,
      account_id: accountId,
      facebook_user_name: account.facebook_user_name,
      synced_count: syncedCount,
      missing_permission_page_ids: stalePageIds,
      missing_pages_warning: missingPagesWarning,
      analyze_warning: analyzeWarning,
      message: `Đã kết nối tài khoản Facebook thành công (${syncedCount} Fanpage).`
    };
  } catch (err) {
    const errMsg = sanitizeSensitiveText(`Lỗi mạng khi đồng bộ Fanpage: ${(err as Error).message}`);
    await updateFacebookAccountStatus(db, accountId, "error", errMsg, null, "error");
    return {
      success: false,
      error_code: "facebook_error",
      error_type: "RATE_LIMIT_OR_TEMPORARY",
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

  // Case 1: Đường dẫn ổ đĩa Windows cũ (C:\, D:\, E:\) -> Cảnh báo rõ ràng trên Cloudflare
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

  // Case 3: Video trên Cloudflare R2 (r2://<media_id>, object_key users/..., d1://video/<media_id>, media_id hoặc tên file gốc đã tải lên)
  const cleanId = clean.replace(/^r2:\/\//, "").replace(/^d1:\/\/video\//, "");
  const media = await getMediaFileById(db, cleanId, ownerUserId);
  if (media) {
    const check = validateVideoMetadata(
      media.original_filename,
      media.size_bytes || 1,
      media.mime_type,
      env
    );
    const sizeMb = Math.round((media.size_bytes / (1024 * 1024)) * 100) / 100;
    const isReady = media.upload_status === "ready";

    return {
      video_path: `r2://${media.id}`,
      exists: isReady,
      valid_format: check.valid,
      size_mb: sizeMb,
      storage_type: media.storage_backend,
      media_id: media.id,
      object_key: media.object_key,
      message: isReady
        ? `Video R2 hợp lệ: ${media.original_filename} (${sizeMb} MB)`
        : `Video '${media.original_filename}' chưa hoàn tất tải lên R2 (status=${media.upload_status}).`
    };
  }

  if (
    clean.startsWith("r2://") ||
    clean.startsWith("users/") ||
    clean.startsWith("d1://video/") ||
    clean.startsWith("med_") ||
    clean.startsWith("vid_")
  ) {
    return {
      video_path: clean,
      exists: false,
      valid_format: false,
      size_mb: 0,
      storage_type: "r2",
      message: "Không tìm thấy video trên Cloudflare R2 hoặc bạn không có quyền sở hữu video này."
    };
  }

  return {
    video_path: clean,
    exists: false,
    valid_format: false,
    size_mb: 0,
    storage_type: "unknown",
    message:
      "Video chưa được tải lên Cloudflare R2. Vui lòng chọn video và chờ tải lên R2 hoàn tất trước khi tạo hoặc chạy Task."
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

export type MetaPermissionErrorCode =
  | "MISSING_APP_PERMISSION"
  | "MISSING_PAGE_TASK"
  | "INVALID_PAGE_TOKEN"
  | "TOKEN_EXPIRED"
  | "PAGE_TOKEN_MISMATCH"
  | "POST_NOT_FOUND"
  | "POST_ID_INVALID"
  | "COMMENT_PERMISSION_DENIED"
  | "META_API_ERROR";

export interface PagePermissionVerificationResult {
  valid: boolean;
  effectivePageToken: string;
  resolvedPageId: string;
  resolvedPageName: string;
  grantedScopes: string[];
  pageTasks: string[];
  hasReadInsights?: boolean;
  canAnalyze?: boolean;
  fromCache?: boolean;
  errorType?: MetaPermissionErrorCode;
  errorCategory?: MetaErrorCategory;
  errorCode?: number;
  message?: string;
}

// ==========================================
// META GRAPH API TELEMETRY, CACHE & RATE-LIMIT HEADER MONITOR (PHẦN 4 & 5)
// ==========================================

export interface MetaEndpointTelemetry {
  endpoint_group: string;
  total_requests: number;
  cache_hits: number;
  cache_misses: number;
  error_requests: number;
  rate_limited_requests: number;
  retry_count: number;
  max_app_call_pct: number;
  max_page_call_pct: number;
  last_status_code: number;
  last_error_code: number | null;
  updated_at: string;
}

const TOKEN_VERIFY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 phút
const pageTokenVerifyCache = new Map<
  string,
  { expiresAt: number; result: PagePermissionVerificationResult }
>();

const inMemoryTelemetry = new Map<string, MetaEndpointTelemetry>();
let latestAppUsagePct = 0;
let latestPageUsagePct = 0;
let latestBucUsagePct = 0;
let lastRateLimitHitAtMs = 0;

function getOrCreateEndpointTelemetry(group: string): MetaEndpointTelemetry {
  let rec = inMemoryTelemetry.get(group);
  if (!rec) {
    rec = {
      endpoint_group: group,
      total_requests: 0,
      cache_hits: 0,
      cache_misses: 0,
      error_requests: 0,
      rate_limited_requests: 0,
      retry_count: 0,
      max_app_call_pct: 0,
      max_page_call_pct: 0,
      last_status_code: 200,
      last_error_code: null,
      updated_at: new Date().toISOString()
    };
    inMemoryTelemetry.set(group, rec);
  }
  return rec;
}

export function parseMetaUsageHeaders(headers?: Headers | null): {
  appCallPct: number;
  pageCallPct: number;
  bucCallPct: number;
} {
  let appCallPct = 0;
  let pageCallPct = 0;
  let bucCallPct = 0;
  if (!headers) return { appCallPct, pageCallPct, bucCallPct };

  const parseUsageJson = (raw: string | null): number => {
    if (!raw) return 0;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const extractMax = (val: unknown): number => {
        if (!val || typeof val !== "object") return 0;
        const r = val as Record<string, unknown>;
        const c1 = Number(r.call_count || 0);
        const c2 = Number(r.total_cputime || 0);
        const c3 = Number(r.total_time || 0);
        return Math.max(
          Number.isFinite(c1) ? c1 : 0,
          Number.isFinite(c2) ? c2 : 0,
          Number.isFinite(c3) ? c3 : 0
        );
      };
      let maxVal = extractMax(obj);
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) {
          for (const item of v) {
            maxVal = Math.max(maxVal, extractMax(item));
          }
        } else if (v && typeof v === "object") {
          maxVal = Math.max(maxVal, extractMax(v));
        }
      }
      return maxVal;
    } catch {
      return 0;
    }
  };

  appCallPct = parseUsageJson(headers.get("x-app-usage") || headers.get("X-App-Usage"));
  pageCallPct = parseUsageJson(headers.get("x-page-usage") || headers.get("X-Page-Usage"));
  bucCallPct = parseUsageJson(
    headers.get("x-business-use-case-usage") || headers.get("X-Business-Use-Case-Usage")
  );

  if (appCallPct > 0) latestAppUsagePct = appCallPct;
  if (pageCallPct > 0) latestPageUsagePct = pageCallPct;
  if (bucCallPct > 0) latestBucUsagePct = bucCallPct;

  return { appCallPct, pageCallPct, bucCallPct };
}

export async function trackMetaGraphResponse(
  db: D1Database | null | undefined,
  endpointGroup: string,
  resp: Response | null,
  errorCode?: number | null,
  isRetry = false
): Promise<void> {
  const rec = getOrCreateEndpointTelemetry(endpointGroup);
  const nowIso = new Date().toISOString();
  rec.total_requests += 1;
  rec.cache_misses += 1;
  if (isRetry) rec.retry_count += 1;
  rec.updated_at = nowIso;

  const status = resp ? resp.status : 0;
  rec.last_status_code = status;
  if (errorCode) rec.last_error_code = errorCode;

  const { appCallPct, pageCallPct, bucCallPct } = parseMetaUsageHeaders(resp?.headers);
  const effectivePagePct = Math.max(pageCallPct, bucCallPct);
  if (appCallPct > rec.max_app_call_pct) rec.max_app_call_pct = appCallPct;
  if (effectivePagePct > rec.max_page_call_pct) rec.max_page_call_pct = effectivePagePct;

  const isRateLimit =
    status === 429 ||
    errorCode === 4 ||
    errorCode === 17 ||
    errorCode === 32 ||
    errorCode === 613;

  if (isRateLimit) {
    rec.rate_limited_requests += 1;
    rec.error_requests += 1;
    lastRateLimitHitAtMs = Date.now();
  } else if (!resp || !resp.ok || (errorCode && errorCode > 0)) {
    rec.error_requests += 1;
  }

  if (db) {
    const bucketHour = nowIso.slice(0, 13) + ":00:00Z";
    try {
      await db
        .prepare(
          `INSERT INTO meta_api_telemetry (
             bucket_hour, endpoint_group, total_requests, cache_hits, cache_misses,
             error_requests, rate_limited_requests, retry_count,
             max_app_call_pct, max_page_call_pct, last_status_code, last_error_code, updated_at
           ) VALUES (?, ?, 1, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bucket_hour, endpoint_group) DO UPDATE SET
             total_requests = meta_api_telemetry.total_requests + 1,
             cache_misses = meta_api_telemetry.cache_misses + 1,
             error_requests = meta_api_telemetry.error_requests + excluded.error_requests,
             rate_limited_requests = meta_api_telemetry.rate_limited_requests + excluded.rate_limited_requests,
             retry_count = meta_api_telemetry.retry_count + excluded.retry_count,
             max_app_call_pct = MAX(meta_api_telemetry.max_app_call_pct, excluded.max_app_call_pct),
             max_page_call_pct = MAX(meta_api_telemetry.max_page_call_pct, excluded.max_page_call_pct),
             last_status_code = excluded.last_status_code,
             last_error_code = COALESCE(excluded.last_error_code, meta_api_telemetry.last_error_code),
             updated_at = excluded.updated_at`
        )
        .bind(
          bucketHour,
          endpointGroup,
          !resp || !resp.ok || (errorCode && errorCode > 0) ? 1 : 0,
          isRateLimit ? 1 : 0,
          isRetry ? 1 : 0,
          appCallPct,
          effectivePagePct,
          status,
          errorCode ?? null,
          nowIso
        )
        .run();
    } catch {}
  }
}

export function recordMetaCacheHit(endpointGroup: string): void {
  const rec = getOrCreateEndpointTelemetry(endpointGroup);
  rec.cache_hits += 1;
  rec.updated_at = new Date().toISOString();
}

export function getCurrentMetaThrottleState(): {
  level: "normal" | "elevated" | "high" | "critical";
  max_usage_pct: number;
  app_usage_pct: number;
  page_usage_pct: number;
  buc_usage_pct: number;
  defer_background_sync: boolean;
  recommended_delay_ms: number;
} {
  const maxPct = Math.max(latestAppUsagePct, latestPageUsagePct, latestBucUsagePct);
  const recentRateLimit = Date.now() - lastRateLimitHitAtMs < 5 * 60 * 1000;
  if (recentRateLimit || maxPct >= 95) {
    return {
      level: "critical",
      max_usage_pct: maxPct,
      app_usage_pct: latestAppUsagePct,
      page_usage_pct: latestPageUsagePct,
      buc_usage_pct: latestBucUsagePct,
      defer_background_sync: true,
      recommended_delay_ms: 5000
    };
  }
  if (maxPct >= 85) {
    return {
      level: "high",
      max_usage_pct: maxPct,
      app_usage_pct: latestAppUsagePct,
      page_usage_pct: latestPageUsagePct,
      buc_usage_pct: latestBucUsagePct,
      defer_background_sync: true,
      recommended_delay_ms: 2000
    };
  }
  if (maxPct >= 70) {
    return {
      level: "elevated",
      max_usage_pct: maxPct,
      app_usage_pct: latestAppUsagePct,
      page_usage_pct: latestPageUsagePct,
      buc_usage_pct: latestBucUsagePct,
      defer_background_sync: false,
      recommended_delay_ms: 600
    };
  }
  return {
    level: "normal",
    max_usage_pct: maxPct,
    app_usage_pct: latestAppUsagePct,
    page_usage_pct: latestPageUsagePct,
    buc_usage_pct: latestBucUsagePct,
    defer_background_sync: false,
    recommended_delay_ms: 0
  };
}

export async function getMetaApiTelemetrySummary(
  db?: D1Database | null
): Promise<Record<string, unknown>> {
  const endpoints = Array.from(inMemoryTelemetry.values());
  let totalReq = 0;
  let totalHits = 0;
  let totalErrors = 0;
  let totalRateLimited = 0;
  for (const e of endpoints) {
    totalReq += e.total_requests;
    totalHits += e.cache_hits;
    totalErrors += e.error_requests;
    totalRateLimited += e.rate_limited_requests;
  }

  let d1Buckets: unknown[] = [];
  if (db) {
    try {
      const { results } = await db
        .prepare("SELECT * FROM meta_api_telemetry ORDER BY bucket_hour DESC LIMIT 24")
        .all();
      d1Buckets = results || [];
    } catch {}
  }

  return {
    throttle: getCurrentMetaThrottleState(),
    totals: {
      total_network_requests: totalReq,
      total_cache_hits: totalHits,
      cache_hit_ratio_pct:
        totalReq + totalHits > 0 ? Math.round((totalHits / (totalReq + totalHits)) * 100) : 0,
      total_errors: totalErrors,
      total_rate_limited: totalRateLimited
    },
    endpoints,
    hourly_buckets: d1Buckets
  };
}

export function invalidatePageTokenVerificationCache(facebookPageId?: string): void {
  if (!facebookPageId) {
    pageTokenVerifyCache.clear();
    return;
  }
  for (const k of pageTokenVerifyCache.keys()) {
    if (k.includes(`:${facebookPageId}:`)) {
      pageTokenVerifyCache.delete(k);
    }
  }
}

/**
 * Hàm kiểm tra thống nhất Token và Quyền của Fanpage (dùng chung cho cả Publish, Retry-Comment & Insights):
 * - Tách bạch hoàn toàn App Permissions (scopes của User Access Token) và Page Tasks (tasks trên /me/accounts)
 * - Không bao giờ kiểm tra MODERATE, CREATE_CONTENT hay ANALYZE trong danh sách scopes của User Token
 * - Cache TTL 15 phút để không gọi lặp lại `/me` cho cùng một Page Token đã xác thực hợp lệ
 * - Tự động xác minh Page Access Token khớp với facebookPageId hoặc làm mới từ Admin User Access Token
 */
export async function verifyPageTokenAndPermissions(
  db: D1Database,
  env: Env,
  params: {
    facebookPageId: string;
    pageAccessToken: string;
    ownerUserId: string;
    mode: "publish" | "comment" | "insights";
    forceLiveVerify?: boolean;
  }
): Promise<PagePermissionVerificationResult> {
  const cfg = getMetaConfig(env);
  const pageId = (params.facebookPageId || "").trim();
  const ownerUserId = (params.ownerUserId || "").trim();
  let effectiveToken = (params.pageAccessToken || "").trim();

  const pageRec = pageId
    ? await getFacebookPageByFbId(db, cfg.encryptionKey, pageId, true, ownerUserId)
    : null;
  if (!effectiveToken && pageRec?.page_access_token) {
    effectiveToken = pageRec.page_access_token.trim();
  }

  const resolvedPageId = pageRec?.facebook_page_id || pageId;
  let resolvedPageName = pageRec?.page_name || pageId;
  let pageTasks: string[] = Array.isArray(pageRec?.tasks) ? [...pageRec.tasks] : [];
  let grantedScopes: string[] = [];
  let hasReadInsights = false;

  if (ownerUserId) {
    try {
      const accs = await getFacebookAccounts(db, cfg.encryptionKey, false, ownerUserId);
      for (const acc of accs) {
        if (Array.isArray(acc.scopes)) {
          for (const s of acc.scopes) {
            if (!grantedScopes.includes(s)) grantedScopes.push(s);
          }
        }
        if (acc.has_read_insights) hasReadInsights = true;
      }
      if (!hasReadInsights && grantedScopes.includes("read_insights")) {
        hasReadInsights = true;
      }
    } catch {}
  }

  const upperTasksInit = pageTasks.map((t) => String(t).toUpperCase());
  let canAnalyze =
    Boolean(pageRec?.can_analyze) ||
    upperTasksInit.includes("ANALYZE") ||
    upperTasksInit.includes("MANAGE");

  if (!effectiveToken) {
    return {
      valid: false,
      effectivePageToken: "",
      resolvedPageId,
      resolvedPageName,
      grantedScopes,
      pageTasks,
      hasReadInsights,
      canAnalyze,
      errorType: "INVALID_PAGE_TOKEN",
      errorCategory: "INVALID_TOKEN",
      errorCode: 190,
      message: "Thiếu Page Access Token hợp lệ. Vui lòng đồng bộ hoặc liên kết lại Facebook."
    };
  }

  // Kiểm tra In-Memory Cache (TTL 15 phút) để tránh gọi `/me` dư thừa ở mỗi lần publish/comment/insights
  const cacheKey = `${ownerUserId}:${resolvedPageId}:${effectiveToken.slice(-20)}`;
  if (!params.forceLiveVerify) {
    const cached = pageTokenVerifyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && cached.result.valid) {
      recordMetaCacheHit("token_verify");
      return {
        ...cached.result,
        grantedScopes,
        pageTasks: pageTasks.length > 0 ? pageTasks : cached.result.pageTasks,
        hasReadInsights,
        canAnalyze,
        fromCache: true
      };
    }
  }

  let tokenPageId = "";
  let tokenExpired = false;
  let tokenRevoked = false;
  let tokenInvalid = false;

  try {
    const meResp = await fetch(
      `${cfg.graphBase}/me?fields=id,name&access_token=${encodeURIComponent(effectiveToken)}`
    );
    if (meResp.ok) {
      await trackMetaGraphResponse(db, "token_verify", meResp, null);
      const meData = (await meResp.json()) as { id?: string; name?: string };
      tokenPageId = String(meData.id || "").trim();
      if (meData.name) resolvedPageName = String(meData.name).trim();
    } else if (meResp.status === 400 || meResp.status === 401) {
      const errBody = (await meResp.json().catch(() => ({}))) as {
        error?: Record<string, unknown>;
      };
      const classified = classifyMetaApiError(errBody.error, meResp.status);
      await trackMetaGraphResponse(db, "token_verify", meResp, classified.code);
      if (classified.category === "TOKEN_EXPIRED") tokenExpired = true;
      else if (classified.category === "TOKEN_REVOKED") tokenRevoked = true;
      else if (classified.category === "INVALID_TOKEN") tokenInvalid = true;
    }
  } catch {
    // Ignore transient network check errors
  }

  const isTokenMismatched = Boolean(tokenPageId && resolvedPageId && tokenPageId !== resolvedPageId);

  // Tự động khôi phục Page Access Token chuẩn từ User Access Token của Admin nếu lệch hoặc hết hạn
  if ((tokenExpired || tokenRevoked || tokenInvalid || isTokenMismatched) && ownerUserId && resolvedPageId) {
    try {
      const userAccounts = await getFacebookAccounts(db, cfg.encryptionKey, true, ownerUserId);
      for (const acc of userAccounts) {
        if (Array.isArray(acc.scopes)) {
          for (const s of acc.scopes) {
            if (!grantedScopes.includes(s)) grantedScopes.push(s);
          }
        }
        if (acc.has_read_insights) hasReadInsights = true;
        if (!acc.access_token) continue;
        const pageResp = await fetch(
          `${cfg.graphBase}/${resolvedPageId}?fields=access_token,name,tasks&access_token=${encodeURIComponent(acc.access_token)}`
        );
        if (pageResp.ok) {
          const pageData = (await pageResp.json()) as {
            access_token?: string;
            name?: string;
            tasks?: string[];
          };
          if (pageData.access_token) {
            effectiveToken = String(pageData.access_token).trim();
            tokenPageId = resolvedPageId;
            if (pageData.name) resolvedPageName = String(pageData.name);
            if (Array.isArray(pageData.tasks)) {
              pageTasks = pageData.tasks.map((t) => String(t).toUpperCase());
              canAnalyze = pageTasks.includes("ANALYZE") || pageTasks.includes("MANAGE");
            }
            tokenExpired = false;
            tokenRevoked = false;
            tokenInvalid = false;

            const encToken = await encryptToken(effectiveToken, cfg.encryptionKey, "v2");
            const now = new Date().toISOString();
            await db.batch([
              db
                .prepare(
                  "UPDATE facebook_pages SET page_access_token = ?, token_status = 'valid', status = 'active', updated_at = ? WHERE (facebook_page_id = ? OR id = ?) AND owner_user_id = ?"
                )
                .bind(encToken, now, resolvedPageId, resolvedPageId, ownerUserId),
              db
                .prepare(
                  "UPDATE facebook_account_pages SET page_access_token = ?, token_status = 'valid', last_synced_at = ? WHERE facebook_page_id = ? AND owner_user_id = ?"
                )
                .bind(encToken, now, resolvedPageId, ownerUserId)
            ]);
            break;
          }
        }
      }
    } catch {}
  }

  if (tokenPageId && resolvedPageId && tokenPageId !== resolvedPageId) {
    return {
      valid: false,
      effectivePageToken: effectiveToken,
      resolvedPageId,
      resolvedPageName,
      grantedScopes,
      pageTasks,
      hasReadInsights,
      canAnalyze,
      errorType: "PAGE_TOKEN_MISMATCH",
      errorCategory: "PAGE_TOKEN_MISMATCH",
      errorCode: 400,
      message: `Page ID không khớp: Token đang thuộc về "${resolvedPageName}" (${tokenPageId}), không khớp với Fanpage của tác vụ (${resolvedPageId}).`
    };
  }

  if (tokenExpired) {
    return {
      valid: false,
      effectivePageToken: effectiveToken,
      resolvedPageId,
      resolvedPageName,
      grantedScopes,
      pageTasks,
      hasReadInsights,
      canAnalyze,
      errorType: "TOKEN_EXPIRED",
      errorCategory: "TOKEN_EXPIRED",
      errorCode: 190,
      message: "Page Access Token đã hết hạn. Vui lòng liên kết lại tài khoản Facebook."
    };
  }

  if (tokenRevoked) {
    return {
      valid: false,
      effectivePageToken: effectiveToken,
      resolvedPageId,
      resolvedPageName,
      grantedScopes,
      pageTasks,
      hasReadInsights,
      canAnalyze,
      errorType: "TOKEN_EXPIRED",
      errorCategory: "TOKEN_REVOKED",
      errorCode: 190,
      message: "Access Token Facebook đã bị thu hồi. Vui lòng cập nhật Access Token mới."
    };
  }

  if (tokenInvalid) {
    return {
      valid: false,
      effectivePageToken: effectiveToken,
      resolvedPageId,
      resolvedPageName,
      grantedScopes,
      pageTasks,
      hasReadInsights,
      canAnalyze,
      errorType: "INVALID_PAGE_TOKEN",
      errorCategory: "INVALID_TOKEN",
      errorCode: 190,
      message: "Page Access Token không hợp lệ. Vui lòng liên kết lại tài khoản Facebook."
    };
  }

  const validResult: PagePermissionVerificationResult = {
    valid: true,
    effectivePageToken: effectiveToken,
    resolvedPageId,
    resolvedPageName,
    grantedScopes,
    pageTasks,
    hasReadInsights,
    canAnalyze
  };
  const finalCacheKey = `${ownerUserId}:${resolvedPageId}:${effectiveToken.slice(-20)}`;
  pageTokenVerifyCache.set(finalCacheKey, {
    expiresAt: Date.now() + TOKEN_VERIFY_CACHE_TTL_MS,
    result: validResult
  });

  return validResult;
}

export interface PublishReelResult {
  success: boolean;
  video_id?: string;
  post_id?: string;
  video_url?: string;
  comment_id?: string | null;
  error_code?: number | null;
  error_subcode?: number | null;
  error_type?: MetaPermissionErrorCode;
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
  const { facebookPageId, pageAccessToken, videoRef, caption, ownerUserId, onStageLog } =
    params;

  const permCheck = await verifyPageTokenAndPermissions(db, env, {
    facebookPageId,
    pageAccessToken,
    ownerUserId,
    mode: "publish"
  });
  if (!permCheck.valid || !permCheck.effectivePageToken) {
    return {
      success: false,
      retryable: false,
      error_code: permCheck.errorCode || 190,
      error_type: permCheck.errorType || "INVALID_PAGE_TOKEN",
      stage: "auth_check",
      message: permCheck.message || "Thiếu Page Access Token hợp lệ."
    };
  }
  const effectivePageToken = permCheck.effectivePageToken;

  let videoStream: ReadableStream<Uint8Array> | null = null;
  let videoBytes: Uint8Array | null = null;
  let videoSizeBytes = 0;
  let remoteVideoUrl: string | null = null;

  const cleanRef = (videoRef || "").trim();
  if (/^[a-zA-Z]:\\/.test(cleanRef) || cleanRef.startsWith("\\\\")) {
    return {
      success: false,
      retryable: false,
      stage: "validate_video",
      message:
        "Đường dẫn ổ đĩa cục bộ không hợp lệ trên Cloudflare Workers. Vui lòng tải video lên R2 trước khi đăng."
    };
  } else if (cleanRef.startsWith("https://") || cleanRef.startsWith("http://")) {
    remoteVideoUrl = cleanRef;
  } else {
    const r2Res = await openVideoFromStorage(db, env, cleanRef, ownerUserId);
    if (!r2Res.found) {
      return {
        success: false,
        retryable: false,
        stage: "r2_read",
        message:
          r2Res.error ||
          "Nguồn video chưa tồn tại trên Cloudflare R2. Vui lòng tải video lên R2 trước khi đăng."
      };
    }
    videoStream = r2Res.stream || null;
    videoSizeBytes = r2Res.sizeBytes || 0;
    if (r2Res.getBytes && videoSizeBytes <= 30 * 1024 * 1024) {
      videoBytes = await r2Res.getBytes();
      videoSizeBytes = videoBytes.byteLength;
    }
    if (onStageLog) {
      await onStageLog(
        "r2_verified",
        `Đã xác minh video trên R2 (${r2Res.media?.original_filename || cleanRef}, ${(videoSizeBytes / 1048576).toFixed(2)} MB).`
      );
    }
  }

  try {
    // GIAI ĐOẠN 1: Khởi tạo phiên upload Reels (upload_phase=start)
    if (onStageLog) {
      await onStageLog("start_session", "Đang chuẩn bị phiên tải video lên Facebook...");
    }

    const startResp = await fetch(`${cfg.graphBase}/${facebookPageId}/video_reels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "start",
        access_token: effectivePageToken
      })
    });
    const startData = (await startResp.json()) as Record<string, unknown>;
    await trackMetaGraphResponse(
      db,
      "reels_upload",
      startResp,
      startData.error ? Number((startData.error as any).code || startResp.status) : null
    );

    if (!startResp.ok || startData.error || !startData.video_id) {
      const err = (startData.error || {}) as Record<string, unknown>;
      const code = Number(err.code || 0);
      const subcode = Number(err.error_subcode || 0);
      const isTokenErr = code === 190 || code === 10 || code === 200;
      if (isTokenErr) {
        invalidatePageTokenVerificationCache(facebookPageId);
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
          Authorization: `OAuth ${effectivePageToken}`,
          file_url: remoteVideoUrl
        }
      });
    } else if (videoBytes) {
      uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${effectivePageToken}`,
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
          Authorization: `OAuth ${effectivePageToken}`,
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
    await trackMetaGraphResponse(
      db,
      "reels_upload",
      uploadResp,
      uploadData.error ? Number((uploadData.error as any).code || uploadResp.status) : null
    );
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
      access_token: effectivePageToken,
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
    await trackMetaGraphResponse(
      db,
      "reels_publish",
      finishResp,
      finishData.error ? Number((finishData.error as any).code || finishResp.status) : null
    );
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
      effectivePageToken,
      facebookPageId,
      videoId,
      finishData.post_id ? String(finishData.post_id) : null
    );

    const permalinkUrl = `https://www.facebook.com/reel/${videoId}`;

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
 * Tối ưu: Nếu finishData.post_id đã được Meta trả về, chuẩn hóa trực tiếp không cần gọi thêm GET /{post_id}.
 */
export async function resolveReelPostId(
  cfg: ReturnType<typeof getMetaConfig>,
  pageAccessToken: string,
  facebookPageId: string,
  videoId: string,
  finishPostId?: string | null
): Promise<string> {
  const cleanFinishId = (finishPostId || "").trim();

  // 1. Nếu API publish trả về post_id hợp lệ, chuẩn hóa ngay trong bộ nhớ (tiết kiệm 1 request Graph API)
  if (cleanFinishId && cleanFinishId !== videoId) {
    recordMetaCacheHit("post_resolve");
    if (cleanFinishId.includes("_")) {
      return cleanFinishId;
    }
    if (cleanFinishId !== facebookPageId) {
      return `${facebookPageId}_${cleanFinishId}`;
    }
  }

  // 2. Thử truy vấn dạng {PAGE_ID}_{VIDEO_ID} (chuẩn feed post của Facebook cho Video)
  const compositeVideoId = `${facebookPageId}_${videoId}`;
  try {
    const compResp = await fetch(
      `${cfg.graphBase}/${compositeVideoId}?fields=id&access_token=${encodeURIComponent(pageAccessToken)}`
    );
    await trackMetaGraphResponse(null, "post_resolve", compResp, null);
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
    await trackMetaGraphResponse(null, "post_resolve", listResp, null);
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

  // 4. Fallback: Sử dụng compositeVideoId để luôn đảm bảo video_id và post_id riêng biệt
  return compositeVideoId;
}

export interface PostReelCommentOptions {
  facebookPageId: string;
  pageAccessToken: string;
  postId?: string | null;
  videoId?: string | null;
  commentText: string;
  ownerUserId: string;
  taskId: number;
  skipInitialDuplicateCheck?: boolean;
}

export interface PostReelCommentResult {
  success: boolean;
  comment_id?: string | null;
  post_id: string;
  comment_status: "success" | "failed";
  error_code?: number | null;
  error_subcode?: number | null;
  error_type?: MetaPermissionErrorCode;
  message: string;
  already_posted?: boolean;
}

/**
 * 5. TỰ ĐỘNG ĐĂNG BÌNH LUẬN LÊN BÀI VIẾT REELS (POST /{POST_ID}/comments HOẶC /{VIDEO_ID}/comments)
 * - Đảm bảo token có quyền pages_manage_engagement và tài khoản có quyền MODERATE
 * - Kiểm tra chống đăng trùng (Idempotency Guard)
 * - Tự động chọn đúng endpoint: Facebook Reels là đối tượng Video nên /{video_id}/comments hoặc /{page_id}_{post_id}/comments là chuẩn nhất
 * - Triệt tiêu hoàn toàn lỗi: "(#12) singular statuses API is deprecated for versions v2.4 and higher"
 */
export async function postReelCommentViaGraphApi(
  db: D1Database,
  env: Env,
  options: PostReelCommentOptions
): Promise<PostReelCommentResult> {
  const cfg = getMetaConfig(env);
  const cleanComment = (options.commentText || "").trim();
  const rawPostId = (options.postId || "").trim();
  const rawVideoId = (options.videoId || "").trim();
  const pageId = (options.facebookPageId || "").trim();

  if (!cleanComment) {
    return {
      success: true,
      post_id: rawPostId || rawVideoId,
      comment_status: "success",
      message: "Không có nội dung bình luận."
    };
  }

  const candidateIds: string[] = [];

  if (rawPostId && rawPostId.includes("_") && !candidateIds.includes(rawPostId)) {
    candidateIds.push(rawPostId);
  }

  if (rawPostId && !rawPostId.includes("_") && rawPostId !== pageId && rawPostId !== rawVideoId && pageId) {
    const prefixed = `${pageId}_${rawPostId}`;
    if (!candidateIds.includes(prefixed)) {
      candidateIds.push(prefixed);
    }
  }

  if (rawVideoId && !candidateIds.includes(rawVideoId)) {
    candidateIds.push(rawVideoId);
  }

  if (pageId && rawVideoId) {
    const compVideo = `${pageId}_${rawVideoId}`;
    if (!candidateIds.includes(compVideo)) {
      candidateIds.push(compVideo);
    }
  }

  if (candidateIds.length === 0 && rawPostId) {
    candidateIds.push(rawPostId);
  }

  if (candidateIds.length === 0) {
    return {
      success: false,
      post_id: "",
      comment_status: "failed",
      error_type: "POST_ID_INVALID",
      message: "Không tìm thấy Video ID hoặc Post ID hợp lệ để đăng bình luận."
    };
  }

  // Sử dụng hàm kiểm tra thống nhất Token & Quyền Fanpage (có cache TTL 15 phút)
  const permCheck = await verifyPageTokenAndPermissions(db, env, {
    facebookPageId: pageId,
    pageAccessToken: options.pageAccessToken,
    ownerUserId: options.ownerUserId,
    mode: "comment"
  });

  if (!permCheck.valid || !permCheck.effectivePageToken) {
    return {
      success: false,
      post_id: candidateIds[0],
      comment_status: "failed",
      error_code: permCheck.errorCode || 400,
      error_type: permCheck.errorType || "INVALID_PAGE_TOKEN",
      message: permCheck.message || "Page Access Token không hợp lệ."
    };
  }

  let effectiveToken = permCheck.effectivePageToken;

  const attemptPosting = async (token: string, isRetryPass = false): Promise<PostReelCommentResult> => {
    let lastError: PostReelCommentResult | null = null;

    for (const targetId of candidateIds) {
      // 1. CHỐNG ĐĂNG TRÙNG (IDEMPOTENCY CHECK TRÊN FACEBOOK):
      // Chỉ gọi GET /{targetId}/comments khi retry hoặc khôi phục, bỏ qua khi vừa mới publish xong để tiết kiệm request
      if (!options.skipInitialDuplicateCheck || isRetryPass) {
        try {
          const chkResp = await fetch(
            `${cfg.graphBase}/${targetId}/comments?fields=id,message,created_time&limit=10&access_token=${encodeURIComponent(token)}`
          );
          await trackMetaGraphResponse(db, "comment_post", chkResp, null, isRetryPass);
          if (chkResp.ok) {
            const chkData = (await chkResp.json()) as { data?: Array<{ id: string; message: string }> };
            if (Array.isArray(chkData.data)) {
              const existing = chkData.data.find((c) => (c.message || "").trim() === cleanComment);
              if (existing && existing.id) {
                return {
                  success: true,
                  comment_id: String(existing.id),
                  post_id: targetId,
                  comment_status: "success",
                  message: "Đã xác nhận bình luận đã tồn tại trên bài viết Facebook.",
                  already_posted: true
                };
              }
            }
          }
        } catch {}
      }

      // 2. GỌI API ĐĂNG COMMENT: POST /{targetId}/comments
      let postResp: Response;
      const formBody = new URLSearchParams();
      formBody.set("message", cleanComment);
      formBody.set("access_token", token);

      try {
        postResp = await fetch(
          `${cfg.graphBase}/${targetId}/comments?access_token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              Authorization: `Bearer ${token}`
            },
            body: formBody.toString()
          }
        );
      } catch (netErr) {
        // Timeout hoặc lỗi mạng: Kiểm tra xem Facebook đã nhận comment chưa
        try {
          const verifyResp = await fetch(
            `${cfg.graphBase}/${targetId}/comments?fields=id,message&limit=5&access_token=${encodeURIComponent(token)}`
          );
          await trackMetaGraphResponse(db, "comment_post", verifyResp, null, true);
          if (verifyResp.ok) {
            const vData = (await verifyResp.json()) as { data?: Array<{ id: string; message: string }> };
            const found = vData.data?.find((c) => (c.message || "").trim() === cleanComment);
            if (found && found.id) {
              return {
                success: true,
                comment_id: String(found.id),
                post_id: targetId,
                comment_status: "success",
                message: "Đã xác nhận bình luận xuất hiện trên bài viết Facebook sau timeout."
              };
            }
          }
        } catch {}

        lastError = {
          success: false,
          post_id: targetId,
          comment_status: "failed",
          error_type: "META_API_ERROR",
          message: sanitizeSensitiveText(`Lỗi kết nối khi gửi bình luận: ${(netErr as Error).message}`)
        };
        continue;
      }

      // 3. XỬ LÝ PHẢN HỒI TỪ FACEBOOK (Không gọi lại GET /{comment_id} dư thừa khi POST đã trả về id)
      const postData = (await postResp.json().catch(() => ({}))) as Record<string, unknown>;
      await trackMetaGraphResponse(
        db,
        "comment_post",
        postResp,
        postData.error ? Number((postData.error as any).code || postResp.status) : null,
        isRetryPass
      );
      if (postResp.ok && postData.id) {
        const commentId = String(postData.id);
        return {
          success: true,
          comment_id: commentId,
          post_id: targetId,
          comment_status: "success",
          message: "Đã đăng bình luận tự động thành công."
        };
      } else {
        const err = (postData.error || {}) as Record<string, unknown>;
        const code = Number(err.code || postResp.status);
        const subcode = Number(err.error_subcode || 0);
        const rawErrMsg = String(err.message || postResp.statusText || "");
        const lowerMsg = rawErrMsg.toLowerCase();

        let friendlyErrMsg = "";
        let errType: MetaPermissionErrorCode = "META_API_ERROR";

        if (code === 190 || code === 102 || lowerMsg.includes("session") || lowerMsg.includes("expired")) {
          errType = lowerMsg.includes("expired") || subcode === 463 ? "TOKEN_EXPIRED" : "INVALID_PAGE_TOKEN";
          friendlyErrMsg = `Token Facebook đã hết hạn hoặc không hợp lệ (OAuthException ${code}: ${rawErrMsg}). Vui lòng kết nối lại tài khoản Facebook.`;
        } else if (
          code === 12 ||
          code === 100 ||
          code === 803 ||
          lowerMsg.includes("statuses api is deprecated") ||
          lowerMsg.includes("does not exist") ||
          lowerMsg.includes("unsupported post request")
        ) {
          errType = lowerMsg.includes("does not exist") || code === 803 ? "POST_NOT_FOUND" : "POST_ID_INVALID";
          friendlyErrMsg = `ID bài viết không tồn tại hoặc không hỗ trợ bình luận (Mã lỗi ${code}: ${rawErrMsg}).`;
        } else if (code === 200 || code === 10 || lowerMsg.includes("permission")) {
          if (lowerMsg.includes("pages_manage_engagement") && !lowerMsg.includes("moderate")) {
            errType = "MISSING_APP_PERMISSION";
          } else {
            errType = "COMMENT_PERMISSION_DENIED";
          }
          friendlyErrMsg = `Facebook từ chối cấp quyền bình luận (#${code}): ${rawErrMsg}. Vui lòng kiểm tra quyền pages_manage_engagement của token và quyền MODERATE trên Fanpage.`;
        } else {
          errType = "META_API_ERROR";
          friendlyErrMsg = `Lỗi đăng bình luận từ Facebook: ${rawErrMsg} (Mã lỗi: ${code}${subcode ? "." + subcode : ""})`;
        }

        lastError = {
          success: false,
          post_id: targetId,
          comment_status: "failed",
          error_code: code,
          error_subcode: subcode || null,
          error_type: errType,
          message: sanitizeSensitiveText(friendlyErrMsg)
        };

        if (code === 190) {
          return lastError;
        }

        continue;
      }
    }

    return lastError || {
      success: false,
      post_id: candidateIds[0] || "",
      comment_status: "failed",
      error_type: "META_API_ERROR",
      message: "Không thể đăng bình luận lên bài viết Reels."
    };
  };

  // Lần thử 1: Chạy với Page Access Token hiện tại
  let result = await attemptPosting(effectiveToken, false);

  // Nếu thất bại do quyền hoặc token (code 200, 10, hoặc 190), thử tự động làm mới Page Access Token
  const isAuthOrPermErr =
    !result.success &&
    (result.error_code === 200 ||
      result.error_code === 10 ||
      result.error_code === 190 ||
      (result.message || "").includes("pages_manage_engagement"));

  if (isAuthOrPermErr && options.ownerUserId && pageId) {
    invalidatePageTokenVerificationCache(pageId);
    try {
      const userAccounts = await getFacebookAccounts(db, cfg.encryptionKey, true, options.ownerUserId);
      const activeAccount = userAccounts.find((a) => a.access_token);
      if (activeAccount && activeAccount.access_token) {
        const pageTokenResp = await fetch(
          `${cfg.graphBase}/${pageId}?fields=access_token,name&access_token=${encodeURIComponent(activeAccount.access_token)}`
        );
        if (pageTokenResp.ok) {
          const pageTokenData = (await pageTokenResp.json()) as { access_token?: string };
          const freshPageToken = String(pageTokenData.access_token || "").trim();
          if (freshPageToken && freshPageToken !== effectiveToken) {
            effectiveToken = freshPageToken;
            const now = new Date().toISOString();
            const encToken = await encryptToken(freshPageToken, cfg.encryptionKey, "v2");
            await db.batch([
              db
                .prepare(
                  "UPDATE facebook_pages SET page_access_token = ?, token_status = 'valid', status = 'active', updated_at = ? WHERE facebook_page_id = ? AND owner_user_id = ?"
                )
                .bind(encToken, now, pageId, options.ownerUserId),
              db
                .prepare(
                  "UPDATE facebook_account_pages SET page_access_token = ?, token_status = 'valid', last_synced_at = ? WHERE facebook_page_id = ? AND owner_user_id = ?"
                )
                .bind(encToken, now, pageId, options.ownerUserId)
            ]);

            result = await attemptPosting(effectiveToken, true);
          }
        }
      }
    } catch {}
  }

  return result;
}
