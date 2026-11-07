/**
 * Cloudflare Worker Entrypoint - Facebook Fanpage & Reels Scheduler (auto-reels-uploader)
 * Production Domain : https://pagefb.namnangno.click
 * Facebook App ID   : 1469615908436980
 * OAuth Callback    : https://pagefb.namnangno.click/api/meta/callback
 * Architecture      : Cloudflare Workers + D1 + R2 + Queues + Cron Triggers (Free-Plan Optimized)
 */

import type {
  Env,
  ExecutionContext,
  ScheduledEvent,
  MessageBatch,
  QueueTaskMessage
} from "./types.ts";
import { getEncryptionKeyMaterial } from "./utils/crypto.ts";
import { parseVnScheduleToUtc, formatUtcToVn } from "./utils/timezone.ts";
import {
  ensureDatabaseInitialized,
  verifyUserCredentials,
  createUser,
  getFacebookAccounts,
  getFacebookAccountById,
  disconnectFacebookAccount,
  deleteFacebookAccountWithPages,
  disconnectAllUserAccounts,
  getFacebookPages,
  getFacebookPageByFbId,
  updatePageSelection,
  bulkUpdatePageSelection,
  deleteFacebookPageLocal,
  getMediaFileById,
  getTasks,
  getTask,
  addTask,
  updateTask,
  addTasksBulk,
  deleteTask,
  deleteTasksBulk,
  resetTask,
  resetRunningTasks,
  getTaskLogs,
  getTaskAttempts,
  updateTaskCommentState,
  appendTaskStageLog,
  TaskLockError,
  ScheduleValidationError,
  rescheduleTasksBulk,
  cancelTasksBulk,
  getTaskAuditLogs
} from "./db.ts";
import {
  getReelsAnalyticsDashboard,
  getSingleReelInsightDetail,
  syncSingleReelInsights,
  syncUserReelsInsights
} from "./services/reelsInsightsService.ts";
import {
  PRODUCTION_DOMAIN,
  generateOAuthUrl,
  exchangeCodeForToken,
  getConnectionStatus,
  ensureMetaAppDomainsConfigured
} from "./services/metaOAuthService.ts";
import {
  syncPagesForAccount,
  syncPagesFromMeta,
  checkPagePermissionOnMeta,
  validateVideoSource,
  runDiagnosticTest,
  connectFacebookWithAccessToken,
  postReelCommentViaGraphApi,
  getMetaApiTelemetrySummary
} from "./services/metaGraphService.ts";
import { deleteUserVideo, getR2Bucket, cleanupExpiredR2Media } from "./services/r2MediaService.ts";
import {
  makeSessionCookie,
  clearSessionCookie,
  issueUserSession,
  authenticateRequest,
  revokeRequestSession,
  verifyCsrfProtection,
  enforceAuthRateLimit
} from "./middleware/auth.ts";
import {
  enqueueUserPendingTasks,
  publishSelectedTasksNow,
  handleNativeQueueBatch
} from "./queue/publishQueue.ts";
import { dispatchDueScheduledTasks } from "./scheduler/cronDispatcher.ts";
import {
  jsonResponse,
  redirectResponse,
  serveStaticHtmlAsset,
  renderOAuthCallbackHtml
} from "./routes/responseHelpers.ts";
import { handleComplianceRoutes } from "./routes/complianceRoutes.ts";
import { handleMediaRoutes } from "./routes/mediaRoutes.ts";
import { getD1Database } from "./fallback_d1.ts";

function sanitizeInternalRedirect(raw: string | null): string {
  if (!raw || typeof raw !== "string") return "/page";
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/login") ||
    trimmed.startsWith("/api/")
  ) {
    return "/page";
  }
  if (trimmed === "/" || trimmed === "/pages") {
    return "/page";
  }
  if (trimmed.startsWith("/pages?")) {
    return `/page${trimmed.slice(6)}`;
  }
  return trimmed;
}

export async function handleWorkerRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();
  const isHttps =
    url.protocol === "https:" ||
    request.headers.get("X-Forwarded-Proto") === "https";

  // ==========================================
  // 0. CORS PREFLIGHT (Strict Same-Origin / Production Domain)
  // ==========================================
  if (method === "OPTIONS") {
    const origin = request.headers.get("Origin") || PRODUCTION_DOMAIN;
    const allowedOrigin =
      origin === PRODUCTION_DOMAIN || origin === url.origin
        ? origin
        : PRODUCTION_DOMAIN;
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-File-Name, X-CSRF-Token"
      }
    });
  }

  // ==========================================
  // 0.5. STATIC ASSETS FAST-PATH (/js/*, /static/*, /css/*, /favicon.ico)
  // Phục vụ trực tiếp từ Cloudflare Assets không tốn truy vấn D1 và hỗ trợ cả 200 OK lẫn 304 Not Modified
  // ==========================================
  if (
    env.ASSETS &&
    (method === "GET" || method === "HEAD") &&
    (pathname.startsWith("/static/") ||
      pathname.startsWith("/js/") ||
      pathname.startsWith("/css/") ||
      pathname === "/favicon.ico")
  ) {
    if (pathname.startsWith("/static/")) {
      const strippedUrl = new URL(request.url);
      strippedUrl.pathname = pathname.replace(/^\/static/, "");
      const strippedReq = new Request(strippedUrl.toString(), request);
      const assetResp = await env.ASSETS.fetch(strippedReq);
      if (assetResp.ok || assetResp.status === 304) return assetResp;
    }
    const directResp = await env.ASSETS.fetch(request);
    if (directResp.ok || directResp.status === 304) return directResp;
  }

  const encryptionKey = getEncryptionKeyMaterial(env);
  const db = getD1Database(env);
  await ensureDatabaseInitialized(db, encryptionKey);

  // ==========================================
  // 1. TRANG CÔNG KHAI BẮT BUỘC CỦA META (/privacy, /terms, /data-deletion, /api/meta/data-deletion)
  // ==========================================
  const complianceResp = await handleComplianceRoutes(request, url, db, env);
  if (complianceResp) return complianceResp;

  // ==========================================
  // 2. XÁC THỰC PHIÊN NGƯỜI DÙNG & CHỐNG CSRF
  // ==========================================
  const { user: currentUser, session: currentSession } = await authenticateRequest(
    request,
    db,
    env
  );

  if (pathname.startsWith("/api/")) {
    const csrfCheck = verifyCsrfProtection(request, env);
    if (!csrfCheck.valid) {
      return jsonResponse({ detail: csrfCheck.reason || "CSRF validation failed." }, 403);
    }
  }

  // ==========================================
  // 3. ĐIỀU HƯỚNG GIAO DIỆN HTML FRONTEND (/, /login, /page, /pages, /schedules, /reels)
  // ==========================================
  if (pathname === "/login" && method === "GET") {
    if (currentUser) {
      const target = sanitizeInternalRedirect(url.searchParams.get("redirect"));
      return redirectResponse(`${url.origin}${target}`, 302);
    }
    const staticResp = await serveStaticHtmlAsset(request, env, "/login.html");
    if (staticResp) return staticResp;
  }

  if (pathname === "/" && method === "GET") {
    const ua = request.headers.get("User-Agent") || "";
    const isFbCrawler = /facebookexternalhit|Facebot|meta-externalagent/i.test(ua);
    if (currentUser) {
      return redirectResponse(`${url.origin}/page`, 302);
    }
    if (isFbCrawler) {
      const staticResp = await serveStaticHtmlAsset(request, env, "/login.html");
      if (staticResp) return staticResp;
    }
    return redirectResponse(`${url.origin}/login`, 302);
  }

  if (
    (pathname === "/page" ||
      pathname === "/pages" ||
      pathname === "/schedules" ||
      pathname === "/reels" ||
      pathname === "/insights") &&
    method === "GET"
  ) {
    const ua = request.headers.get("User-Agent") || "";
    const isFbCrawler = /facebookexternalhit|Facebot|meta-externalagent/i.test(ua);
    if (!currentUser) {
      if (isFbCrawler) {
        const staticResp = await serveStaticHtmlAsset(request, env, "/login.html");
        if (staticResp) return staticResp;
      }
      const loginRedirect =
        pathname === "/schedules" || pathname === "/reels" || pathname === "/insights"
          ? `/login?redirect=${encodeURIComponent(pathname + url.search)}`
          : "/login";
      return redirectResponse(`${url.origin}${loginRedirect}`, 302);
    }
    if (pathname === "/pages") {
      return redirectResponse(`${url.origin}/page${url.search}`, 302);
    }
    const staticResp = await serveStaticHtmlAsset(request, env, "/index.html");
    if (staticResp) return staticResp;
  }

  // ==========================================
  // 4. API XÁC THỰC (/api/auth/*)
  // ==========================================
  if (pathname === "/api/auth/login" && method === "POST") {
    const rl = await enforceAuthRateLimit(request, db, "login");
    if (!rl.allowed) {
      return jsonResponse(
        {
          detail: `Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau ${rl.retryAfterSeconds} giây.`
        },
        429,
        { "Retry-After": String(rl.retryAfterSeconds) }
      );
    }

    try {
      const body = (await request.json()) as { username?: string; password?: string };
      const user = await verifyUserCredentials(
        db,
        body.username || "",
        body.password || ""
      );
      if (!user) {
        return jsonResponse(
          { detail: "Tên đăng nhập hoặc mật khẩu không chính xác." },
          401
        );
      }

      const issued = await issueUserSession(request, db, env, user.id);
      return jsonResponse(
        {
          success: true,
          user,
          csrf_token: issued.csrfToken,
          message: `Chào mừng ${user.full_name || user.username}!`
        },
        200,
        { "Set-Cookie": makeSessionCookie(issued.token, isHttps) }
      );
    } catch {
      return jsonResponse({ detail: "Dữ liệu đăng nhập không hợp lệ." }, 400);
    }
  }

  if (pathname === "/api/auth/register" && method === "POST") {
    const rl = await enforceAuthRateLimit(request, db, "register");
    if (!rl.allowed) {
      return jsonResponse(
        {
          detail: `Quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau ${rl.retryAfterSeconds} giây.`
        },
        429,
        { "Retry-After": String(rl.retryAfterSeconds) }
      );
    }

    try {
      const body = (await request.json()) as {
        username?: string;
        password?: string;
        full_name?: string;
        email?: string;
      };
      const res = await createUser(
        db,
        body.username || "",
        body.password || "",
        body.full_name || null,
        body.email || null,
        "member"
      );
      if (!res.success || !res.user) {
        return jsonResponse({ detail: res.message || "Đăng ký thất bại." }, 400);
      }

      const issued = await issueUserSession(request, db, env, res.user.id);
      return jsonResponse(
        {
          success: true,
          user: res.user,
          csrf_token: issued.csrfToken,
          message: "Đăng ký tài khoản thành công!"
        },
        200,
        { "Set-Cookie": makeSessionCookie(issued.token, isHttps) }
      );
    } catch {
      return jsonResponse({ detail: "Dữ liệu đăng ký không hợp lệ." }, 400);
    }
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    await revokeRequestSession(request, db);
    return jsonResponse(
      { success: true, message: "Đã đăng xuất và thu hồi phiên làm việc thành công." },
      200,
      { "Set-Cookie": clearSessionCookie(isHttps) }
    );
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    if (!currentUser) {
      return jsonResponse(
        { authenticated: false, detail: "Chưa đăng nhập." },
        401
      );
    }
    return jsonResponse({
      authenticated: true,
      user: currentUser,
      csrf_token: currentSession?.csrf_token || null
    });
  }

  // ==========================================
  // 5. FACEBOOK OAUTH CALLBACK (/api/meta/callback)
  // ==========================================
  if (pathname === "/api/meta/callback" && method === "GET") {
    const error = url.searchParams.get("error");
    const errorReason = url.searchParams.get("error_reason");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error || errorReason === "user_denied") {
      return renderOAuthCallbackHtml({
        success: false,
        statusCode: 200,
        oauthStatus: "denied",
        title: "Chưa Cấp Quyền Kết Nối",
        message: "Bạn chưa cấp quyền kết nối Facebook"
      });
    }

    if (!code) {
      return renderOAuthCallbackHtml({
        success: false,
        statusCode: 200,
        oauthStatus: "ready",
        isEndpointReadyProbe: true,
        title: "Cổng Kết Nối Facebook Sẵn Sàng",
        message:
          "Điểm cuối xác thực đang hoạt động. Vui lòng quay về trang Quản lý để kết nối tài khoản Facebook."
      });
    }

    const res = await exchangeCodeForToken(
      db,
      env,
      code,
      state || "",
      currentUser?.id || null
    );
    if (!res.success) {
      const oauthStatus =
        res.error_code === "missing_permissions"
          ? "missing_permissions"
          : res.error_code === "invalid_token"
            ? "invalid_token"
            : "error";
      return renderOAuthCallbackHtml({
        success: false,
        statusCode: 400,
        oauthStatus,
        title: "Không Thể Kết Nối Facebook",
        message: res.message || "Không thể kết nối Facebook lúc này, vui lòng thử lại"
      });
    }

    const effectiveUserId = res.owner_user_id || currentUser?.id || "usr_admin";
    const syncRes = res.account_id
      ? await syncPagesForAccount(db, env, res.account_id, effectiveUserId)
      : await syncPagesFromMeta(db, env, effectiveUserId);

    if (!syncRes.success) {
      const syncStatus =
        "error_code" in syncRes && syncRes.error_code === "missing_permissions"
          ? "missing_permissions"
          : "error_code" in syncRes && syncRes.error_code === "invalid_token"
            ? "invalid_token"
            : "error";
      return renderOAuthCallbackHtml({
        success: false,
        statusCode: 400,
        oauthStatus: syncStatus,
        title: "Không Thể Đồng Bộ Fanpage",
        message: syncRes.message || "Không thể kết nối Facebook lúc này, vui lòng thử lại",
        accountId: res.account_id
      });
    }

    const syncedCount = syncRes.synced_count || 0;
    if (syncedCount === 0) {
      return renderOAuthCallbackHtml({
        success: false,
        statusCode: 200,
        oauthStatus: "no_pages",
        title: "Chưa Có Fanpage",
        subtitle: res.user_name || "",
        message: "Tài khoản này chưa quản lý Fanpage nào",
        syncedCount: 0,
        accountId: res.account_id
      });
    }

    return renderOAuthCallbackHtml({
      success: true,
      statusCode: 200,
      oauthStatus: "success",
      title: "Đã kết nối tài khoản Facebook thành công",
      subtitle: `${res.user_name || ""} (${syncedCount} Fanpage)`,
      message: "Đã kết nối tài khoản Facebook thành công",
      syncedCount,
      accountId: res.account_id
    });
  }

  // ==========================================
  // 6. BẢO VỆ CÁC API NGHIỆP VỤ (/api/*) - YÊU CẦU ĐĂNG NHẬP
  // ==========================================
  if (pathname.startsWith("/api/")) {
    if (!currentUser) {
      return jsonResponse(
        {
          detail: "Phiên đăng nhập hết hạn hoặc chưa xác thực. Vui lòng đăng nhập lại."
        },
        401
      );
    }

    const ownerUserId = currentUser.id;

    // ------------------------------------------
    // 6.1. MEDIA R2 UPLOAD & STORAGE ENDPOINTS
    // ------------------------------------------
    const mediaResp = await handleMediaRoutes(request, url, db, env, currentUser);
    if (mediaResp) return mediaResp;

    // ------------------------------------------
    // 6.2. META CONNECTION & ADMIN ACCOUNTS
    // ------------------------------------------
    if (pathname === "/api/meta/status" && method === "GET") {
      const status = await getConnectionStatus(db, env, ownerUserId);
      return jsonResponse(status);
    }

    if (pathname === "/api/meta/accounts" && method === "GET") {
      const accounts = await getFacebookAccounts(
        db,
        encryptionKey,
        false,
        ownerUserId
      );
      return jsonResponse(accounts);
    }

    if (pathname === "/api/meta/oauth-url" && method === "GET") {
      const reconnectId = url.searchParams.get("reconnect_account_id") || url.searchParams.get("account_id");
      const customRedirectUri = url.searchParams.get("redirect_uri");
      const res = await generateOAuthUrl(
        db,
        env,
        ownerUserId,
        reconnectId || null,
        reconnectId ? "reconnect" : "connect",
        customRedirectUri || null
      );
      if (!res.success) {
        return jsonResponse(
          { detail: res.message || "Không thể kết nối Facebook lúc này, vui lòng thử lại" },
          400
        );
      }
      return jsonResponse(res);
    }

    if (pathname === "/api/meta/login" && method === "GET") {
      const reconnectId = url.searchParams.get("reconnect_account_id") || url.searchParams.get("account_id");
      const customRedirectUri = url.searchParams.get("redirect_uri");
      const res = await generateOAuthUrl(
        db,
        env,
        ownerUserId,
        reconnectId || null,
        reconnectId ? "reconnect" : "connect",
        customRedirectUri || null
      );
      if (!res.success || !res.oauth_url) {
        return jsonResponse(
          { detail: res.message || "Không thể kết nối Facebook lúc này, vui lòng thử lại" },
          400
        );
      }
      return Response.redirect(res.oauth_url, 302);
    }

    if (pathname === "/api/meta/connect-token" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        access_token?: string;
        token?: string;
        account_id?: string;
      };
      const rawToken = (body.access_token || body.token || "").trim();
      if (!rawToken) {
        return jsonResponse(
          { detail: "Vui lòng nhập Access Token từ Graph API Explorer." },
          400
        );
      }
      const res = await connectFacebookWithAccessToken(
        db,
        env,
        rawToken,
        ownerUserId,
        body.account_id ? String(body.account_id).trim() : null
      );
      if (!res.success) {
        return jsonResponse(
          {
            detail: res.message,
            message: res.message,
            error_type: res.error_type || "INVALID_TOKEN",
            error_code: res.error_code || 400,
            missing_scopes: res.missing_scopes
          },
          400
        );
      }
      const accounts = await getFacebookAccounts(db, encryptionKey, false, ownerUserId);
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        ownerUserId
      });
      return jsonResponse({ ...res, accounts, pages });
    }

    const updateTokenAccMatch = /^\/api\/meta\/accounts\/([^/]+)\/update-token$/.exec(pathname);
    if (updateTokenAccMatch && method === "POST") {
      const accountId = decodeURIComponent(updateTokenAccMatch[1]);
      const body = (await request.json().catch(() => ({}))) as {
        access_token?: string;
        token?: string;
      };
      const rawToken = (body.access_token || body.token || "").trim();
      if (!rawToken) {
        return jsonResponse(
          { detail: "Vui lòng nhập Access Token mới từ Graph API Explorer." },
          400
        );
      }
      const res = await connectFacebookWithAccessToken(
        db,
        env,
        rawToken,
        ownerUserId,
        accountId
      );
      if (!res.success) {
        return jsonResponse(
          {
            detail: res.message,
            message: res.message,
            error_type: res.error_type || "INVALID_TOKEN",
            error_code: res.error_code || 400,
            missing_scopes: res.missing_scopes
          },
          400
        );
      }
      const accounts = await getFacebookAccounts(db, encryptionKey, false, ownerUserId);
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        ownerUserId
      });
      return jsonResponse({ ...res, accounts, pages });
    }

    if (pathname === "/api/meta/sync-pages" && method === "POST") {
      const res = await syncPagesFromMeta(db, env, ownerUserId);
      if (!res.success && res.synced_count === 0) {
        return jsonResponse({ detail: res.message, errors: res.errors }, 400);
      }
      return jsonResponse(res);
    }

    if (pathname === "/api/meta/disconnect" && method === "POST") {
      await disconnectAllUserAccounts(db, ownerUserId);
      return jsonResponse({
        success: true,
        message: "Đã xóa kết nối toàn bộ tài khoản Facebook và Fanpage của bạn."
      });
    }

    const syncAccMatch = /^\/api\/meta\/accounts\/([^/]+)\/sync$/.exec(pathname);
    if (syncAccMatch && method === "POST") {
      const accountId = decodeURIComponent(syncAccMatch[1]);
      const res = await syncPagesForAccount(db, env, accountId, ownerUserId);
      if (!res.success) {
        return jsonResponse({ detail: res.message }, 400);
      }
      const accounts = await getFacebookAccounts(db, encryptionKey, false, ownerUserId);
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        ownerUserId
      });
      return jsonResponse({ ...res, accounts, pages });
    }

    const reconnectAccMatch = /^\/api\/meta\/accounts\/([^/]+)\/reconnect(?:-url)?$/.exec(pathname);
    if (reconnectAccMatch && (method === "POST" || method === "GET")) {
      const accountId = decodeURIComponent(reconnectAccMatch[1]);
      const acc = await getFacebookAccountById(
        db,
        encryptionKey,
        accountId,
        false,
        ownerUserId
      );
      if (!acc) {
        return jsonResponse(
          { detail: "Không tìm thấy tài khoản Facebook thuộc quyền sở hữu của bạn." },
          404
        );
      }
      const res = await generateOAuthUrl(db, env, ownerUserId, accountId, "reconnect");
      if (!res.success) {
        return jsonResponse({ detail: res.message }, 400);
      }
      return jsonResponse(res);
    }

    const disconnectAccMatch = /^\/api\/meta\/accounts\/([^/]+)\/disconnect$/.exec(pathname);
    if (disconnectAccMatch && method === "POST") {
      const accountId = decodeURIComponent(disconnectAccMatch[1]);
      const ok = await disconnectFacebookAccount(db, accountId, ownerUserId);
      if (!ok) {
        return jsonResponse(
          { detail: "Không tìm thấy tài khoản hoặc không có quyền ngắt kết nối." },
          404
        );
      }
      return jsonResponse({
        success: true,
        message: "Đã ngắt kết nối tài khoản Facebook."
      });
    }

    const deleteAccMatch = /^\/api\/meta\/accounts\/([^/]+)$/.exec(pathname);
    if (deleteAccMatch && method === "DELETE") {
      const accountId = decodeURIComponent(deleteAccMatch[1]);
      const delRes = await deleteFacebookAccountWithPages(db, accountId, ownerUserId);
      if (!delRes.deleted) {
        return jsonResponse(
          { detail: "Không tìm thấy tài khoản hoặc không có quyền xóa." },
          404
        );
      }
      const accounts = await getFacebookAccounts(db, encryptionKey, false, ownerUserId);
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        ownerUserId
      });
      return jsonResponse({
        success: true,
        deleted_id: accountId,
        deleted_pages_count: delRes.deleted_pages_count,
        deleted_page_ids: delRes.deleted_page_ids,
        shared_pages_kept_count: delRes.shared_pages_kept_count,
        accounts,
        pages,
        message:
          delRes.deleted_pages_count > 0
            ? `Đã xóa tài khoản Facebook và ${delRes.deleted_pages_count} Fanpage liên quan khỏi danh sách quản lý.`
            : "Đã xóa tài khoản Facebook và cập nhật danh sách Fanpage."
      });
    }

    // ------------------------------------------
    // 6.3. QUẢN LÝ FANPAGE (/api/pages*)
    // ------------------------------------------
    if (pathname === "/api/pages" && method === "GET") {
      const accountIdsRaw = url.searchParams.get("account_ids") || "";
      const accountIds = accountIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        accountIds,
        ownerUserId
      });
      return jsonResponse(pages);
    }

    if (pathname === "/api/pages/bulk-select" && method === "POST") {
      const body = (await request.json()) as {
        is_selected?: boolean;
        facebook_page_ids?: string[];
        account_ids?: string[];
      };
      const updated = await bulkUpdatePageSelection(
        db,
        Boolean(body.is_selected),
        body.facebook_page_ids || null,
        body.account_ids || null,
        ownerUserId
      );
      return jsonResponse({ success: true, updated_count: updated });
    }

    const pageSelectMatch = /^\/api\/pages\/([^/]+)\/select$/.exec(pathname);
    if (pageSelectMatch && method === "POST") {
      const pageId = decodeURIComponent(pageSelectMatch[1]);
      const body = (await request.json()) as { is_selected?: boolean };
      const ok = await updatePageSelection(
        db,
        pageId,
        Boolean(body.is_selected),
        ownerUserId
      );
      if (!ok) {
        return jsonResponse({ detail: "Không tìm thấy Fanpage thuộc quyền sở hữu của bạn." }, 404);
      }
      return jsonResponse({
        success: true,
        facebook_page_id: pageId,
        is_selected: Boolean(body.is_selected)
      });
    }

    const pageCheckMatch = /^\/api\/pages\/([^/]+)\/check-permission$/.exec(pathname);
    if (pageCheckMatch && method === "POST") {
      const pageId = decodeURIComponent(pageCheckMatch[1]);
      const res = await checkPagePermissionOnMeta(db, env, pageId, ownerUserId);
      if (!res.success) {
        return jsonResponse({ detail: res.message }, 400);
      }
      return jsonResponse(res);
    }

    const pageDeleteMatch = /^\/api\/pages\/([^/]+)$/.exec(pathname);
    if (pageDeleteMatch && method === "DELETE") {
      const pageId = decodeURIComponent(pageDeleteMatch[1]);
      const ok = await deleteFacebookPageLocal(db, pageId, ownerUserId);
      if (!ok) {
        return jsonResponse({ detail: "Không tìm thấy Fanpage thuộc quyền sở hữu của bạn." }, 404);
      }
      return jsonResponse({ success: true, deleted_id: pageId });
    }

    // ------------------------------------------
    // 6.4. QUẢN LÝ TÁC VỤ REELS (/api/tasks*)
    // ------------------------------------------
    if (pathname === "/api/tasks" && method === "GET") {
      const facebookPageId =
        url.searchParams.get("facebook_page_id") ||
        url.searchParams.get("profile_id");
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search");
      const startDate = url.searchParams.get("start_date");
      const endDate = url.searchParams.get("end_date");
      const accountIdsRaw = url.searchParams.get("account_ids") || "";
      const accountIds = accountIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const tasks = await getTasks(db, {
        facebookPageId,
        status,
        search,
        startDate,
        endDate,
        accountIds,
        ownerUserId
      });
      return jsonResponse(tasks);
    }

    if (pathname === "/api/tasks" && method === "POST") {
      const body = (await request.json()) as {
        facebook_page_id?: string;
        profile_id?: string;
        media_id?: string;
        object_key?: string;
        video_path?: string;
        caption?: string;
        comment_text?: string;
        schedule_date?: string;
        schedule_time?: string;
        allow_past?: boolean;
      };
      const vPath = (body.video_path || "").trim();
      if (!vPath) {
        return jsonResponse({ detail: "Vui lòng tải lên hoặc chọn video trên R2." }, 400);
      }

      const targetPageId = body.facebook_page_id || body.profile_id || null;
      if (targetPageId) {
        const ownedPages = await getFacebookPages(db, encryptionKey, {
          includeToken: false,
          ownerUserId
        });
        const owns = ownedPages.some(
          (p) => p.facebook_page_id === targetPageId || p.id === targetPageId
        );
        if (!owns) {
          return jsonResponse(
            { detail: "Bạn không có quyền gán tác vụ cho Fanpage này." },
            403
          );
        }
      }

      // BẮT BUỘC NHẬP NGÀY VÀ GIỜ ĐĂNG (Phần 1.2): Không cho phép bỏ trống, không tự động coi rỗng là đăng ngay
      const schedCheck = parseVnScheduleToUtc(body.schedule_date, body.schedule_time, {
        minLeadSeconds: 60,
        requireSchedule: true,
        allowPast: Boolean(body.allow_past)
      });
      if (!schedCheck.isValid) {
        return jsonResponse(
          {
            error_code: schedCheck.isPast ? "PAST_SCHEDULE_TIME" : "SCHEDULE_REQUIRED",
            detail: schedCheck.error,
            message: schedCheck.error,
            field_errors: schedCheck.fieldErrors,
            is_past: Boolean(schedCheck.isPast),
            missing_date: Boolean(schedCheck.missingDate),
            missing_time: Boolean(schedCheck.missingTime)
          },
          400
        );
      }

      // Tự động phân giải & xác minh media_id, object_key trên R2 trước khi cho phép tạo Task
      let mediaId = body.media_id || null;
      let objectKey = body.object_key || null;
      let effectiveVideoPath = vPath;

      const isExplicitR2Ref =
        vPath.startsWith("r2://") ||
        vPath.startsWith("d1://video/") ||
        vPath.startsWith("med_") ||
        Boolean(body.media_id) ||
        Boolean(body.object_key);

      if (isExplicitR2Ref) {
        const lookupKey = body.media_id || body.object_key || vPath;
        const mediaRecord = await getMediaFileById(db, lookupKey, ownerUserId);
        if (!mediaRecord) {
          return jsonResponse(
            { detail: "Video R2 không tồn tại hoặc không thuộc quyền sở hữu của bạn." },
            403
          );
        }
        if (mediaRecord.upload_status === "failed") {
          return jsonResponse(
            {
              detail:
                mediaRecord.storage_error ||
                `Video '${mediaRecord.original_filename}' tải lên R2 bị lỗi. Vui lòng tải lại video.`
            },
            400
          );
        }
        mediaId = mediaRecord.id;
        objectKey = mediaRecord.object_key;
        effectiveVideoPath = `r2://${mediaRecord.id}`;
      } else if (vPath.startsWith("https://") || vPath.startsWith("http://")) {
        effectiveVideoPath = vPath;
      } else {
        // Thử tìm kiếm theo tên file gốc trong kho R2 của người dùng
        const matchedMedia = await getMediaFileById(db, vPath, ownerUserId);
        if (matchedMedia && matchedMedia.upload_status !== "failed") {
          mediaId = matchedMedia.id;
          objectKey = matchedMedia.object_key;
          effectiveVideoPath = `r2://${matchedMedia.id}`;
        } else {
          return jsonResponse(
            {
              detail:
                "Video chưa được tải lên Cloudflare R2 thành công. Vui lòng chọn file video và chờ tải lên R2 hoàn tất trước khi tạo Task."
            },
            400
          );
        }
      }

      let taskId: number;
      try {
        taskId = await addTask(
          db,
          {
            videoPath: effectiveVideoPath,
            caption: body.caption || "",
            commentText: body.comment_text || "",
            scheduleDate: body.schedule_date || "",
            scheduleTime: body.schedule_time || "",
            facebookPageId: targetPageId,
            profileId: body.profile_id || targetPageId,
            mediaId,
            objectKey,
            ownerUserId
          },
          {
            allowPast: Boolean(body.allow_past)
          }
        );
      } catch (err: any) {
        if (err instanceof ScheduleValidationError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              field_errors: err.fieldErrors,
              is_past: err.isPast,
              missing_date: err.missingDate,
              missing_time: err.missingTime
            },
            err.httpStatus
          );
        }
        return jsonResponse(
          { detail: err?.message || "Thời gian đặt lịch không hợp lệ hoặc đã qua." },
          400
        );
      }

      const created = await getTask(db, taskId, ownerUserId);
      return jsonResponse({ success: true, id: taskId, task: created });
    }

    if (pathname === "/api/tasks/bulk" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        tasks?: Array<{
          video_path: string;
          caption?: string;
          comment_text?: string;
          schedule_date?: string;
          schedule_time?: string;
          facebook_page_id?: string;
          media_id?: string;
          object_key?: string;
          trigger_source?: string;
        }>;
        assign_page_ids?: string[];
        assign_profile_ids?: string[];
        allow_past?: boolean;
        schedule_date?: string;
        schedule_time?: string;
        interval_minutes?: number;
      };

      const tasksList = body.tasks || [];
      if (tasksList.length === 0) {
        return jsonResponse({ detail: "Danh sách tác vụ trống." }, 400);
      }

      // 1. Phân bổ lịch hẹn tự động nếu có ngày giờ bắt đầu và khoảng cách
      const baseDate = (body.schedule_date || "").trim();
      const baseTime = (body.schedule_time || "").trim();
      const intervalMinutes = Math.max(0, Number(body.interval_minutes) || 0);

      if (baseDate && baseTime) {
        const parsedBase = parseVnScheduleToUtc(baseDate, baseTime, {
          allowPast: Boolean(body.allow_past),
          requireSchedule: true
        });
        if (!parsedBase.isValid) {
          return jsonResponse(
            {
              error_code: parsedBase.isPast ? "SCHEDULE_IN_PAST" : "SCHEDULE_INVALID",
              detail: parsedBase.error || "Thời gian bắt đầu đặt lịch không hợp lệ hoặc đã qua.",
              message: parsedBase.error || "Thời gian bắt đầu đặt lịch không hợp lệ hoặc đã qua.",
              field_errors: parsedBase.fieldErrors,
              is_past: parsedBase.isPast,
              missing_date: parsedBase.missingDate,
              missing_time: parsedBase.missingTime
            },
            400
          );
        }
        const baseUtc = parsedBase.scheduledAtUtc!;
        for (let i = 0; i < tasksList.length; i++) {
          if (!tasksList[i].schedule_date || !tasksList[i].schedule_time) {
            const taskUtc = baseUtc + i * intervalMinutes * 60;
            const vnSlot = formatUtcToVn(taskUtc);
            tasksList[i].schedule_date = vnSlot.schedule_date;
            tasksList[i].schedule_time = vnSlot.schedule_time;
          }
        }
      }

      // 2. Kiểm tra tính hợp lệ và phân giải R2 cho từng task
      for (let i = 0; i < tasksList.length; i++) {
        const item = tasksList[i];
        const vPath = (item.video_path || "").trim();
        const cap = (item.caption || "").trim();

        if (!vPath) {
          return jsonResponse({ detail: `Dòng ${i + 1}: Đường dẫn video không được để trống.` }, 400);
        }
        if (!cap) {
          return jsonResponse({ detail: `Dòng ${i + 1}: Caption không được để trống.` }, 400);
        }

        // Tự động giải quyết media R2
        const isUrl = vPath.startsWith("https://") || vPath.startsWith("http://");
        const isExplicitR2 =
          vPath.startsWith("r2://") ||
          vPath.startsWith("d1://video/") ||
          vPath.startsWith("med_") ||
          Boolean(item.media_id);

        if (!isUrl) {
          const cleanKey = vPath.replace(/^r2:\/\//, "").replace(/^d1:\/\/video\//, "");
          const baseName = vPath.split(/[\\/]/).pop() || vPath;
          const lookupKey = item.media_id || cleanKey;

          let mediaRecord = await getMediaFileById(db, lookupKey, ownerUserId);
          if (!mediaRecord && baseName) {
            mediaRecord = await getMediaFileById(db, baseName, ownerUserId);
          }

          if (mediaRecord && mediaRecord.upload_status === "ready") {
            item.media_id = mediaRecord.id;
            item.object_key = mediaRecord.object_key;
            item.video_path = `r2://${mediaRecord.id}`;
          } else if (isExplicitR2 || /^[a-zA-Z]:\\/.test(vPath) || vPath.endsWith(".mp4")) {
            return jsonResponse(
              {
                detail: `Dòng ${i + 1}: Video '${baseName}' chưa được tải lên Cloudflare R2 hoặc upload chưa hoàn tất. Vui lòng chọn file và tải lên R2 trước khi tạo task.`
              },
              400
            );
          }
        }
      }

      let assignIds = body.assign_page_ids || body.assign_profile_ids || null;
      if (!assignIds || assignIds.length === 0) {
        const selectedPages = await getFacebookPages(db, encryptionKey, {
          selectedOnly: true,
          includeToken: false,
          ownerUserId
        });
        assignIds = selectedPages.map((p) => p.facebook_page_id);
      }

      try {
        const inserted = await addTasksBulk(db, tasksList, assignIds, ownerUserId, {
          allowPast: Boolean(body.allow_past),
          triggerSource: "excel_bulk"
        });
        return jsonResponse({
          success: true,
          inserted_count: inserted.length,
          task_ids: inserted
        });
      } catch (err: any) {
        if (err instanceof ScheduleValidationError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              field_errors: err.fieldErrors,
              is_past: err.isPast,
              missing_date: err.missingDate,
              missing_time: err.missingTime
            },
            err.httpStatus
          );
        }
        return jsonResponse(
          { detail: err?.message || "Thời gian đặt lịch không hợp lệ hoặc đã qua." },
          400
        );
      }
    }

    const taskAuditLogsMatch = /^\/api\/tasks\/(\d+)\/audit-logs$/.exec(pathname);
    if (taskAuditLogsMatch && method === "GET") {
      const taskId = parseInt(taskAuditLogsMatch[1], 10);
      const auditLogs = await getTaskAuditLogs(db, taskId, ownerUserId);
      return jsonResponse({ task_id: taskId, audit_logs: auditLogs });
    }

    const taskPublishNowMatch = /^\/api\/tasks\/(\d+)\/(publish-now|publish)$/.exec(pathname);
    if (taskPublishNowMatch && method === "POST") {
      const taskId = parseInt(taskPublishNowMatch[1], 10);
      const res = await publishSelectedTasksNow(db, env, ctx, {
        taskIds: [taskId],
        ownerUserId,
        actorUserId: ownerUserId,
        triggerSource: "manual_publish_now"
      });

      if (!res.success) {
        const skipItem = res.skipped[0];
        if (skipItem?.code === "NOT_FOUND") {
          return jsonResponse({ detail: skipItem.reason, error_code: skipItem.code }, 404);
        }
        if (skipItem?.code === "TASK_ALREADY_PUBLISHED") {
          return jsonResponse(
            {
              error_code: "TASK_LOCKED_AFTER_PUBLISH",
              detail: skipItem.reason,
              message: skipItem.reason,
              locked: true
            },
            409
          );
        }
        if (skipItem?.code === "TASK_IN_PROGRESS") {
          return jsonResponse(
            {
              error_code: "TASK_IN_PROGRESS",
              detail: skipItem.reason,
              message: skipItem.reason
            },
            409
          );
        }
        return jsonResponse(
          {
            error_code: skipItem?.code || "PUBLISH_NOW_FAILED",
            detail: res.message,
            message: res.message,
            skipped: res.skipped
          },
          400
        );
      }

      const updatedTask = await getTask(db, taskId, ownerUserId);
      return jsonResponse({
        ...res,
        task: updatedTask
      });
    }

    if (pathname === "/api/tasks/bulk-publish-now" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { task_ids?: number[] };
      const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
      if (taskIds.length === 0) {
        return jsonResponse({ detail: "Vui lòng chọn ít nhất một task để đăng ngay." }, 400);
      }
      const res = await publishSelectedTasksNow(db, env, ctx, {
        taskIds,
        ownerUserId,
        actorUserId: ownerUserId,
        triggerSource: "bulk_publish_now"
      });
      return jsonResponse(res, res.success ? 200 : 400);
    }

    if (pathname === "/api/tasks/bulk-reschedule" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        task_ids?: number[];
        schedule_date?: string;
        schedule_time?: string;
        new_schedule_date?: string;
        new_schedule_time?: string;
        interval_minutes?: number;
        allow_past?: boolean;
      };
      const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
      if (taskIds.length === 0) {
        return jsonResponse({ detail: "Vui lòng chọn ít nhất một task để đổi lịch đăng." }, 400);
      }
      try {
        const res = await rescheduleTasksBulk(db, {
          taskIds,
          scheduleDate: body.new_schedule_date || body.schedule_date || "",
          scheduleTime: body.new_schedule_time || body.schedule_time || "",
          intervalMinutes: Number(body.interval_minutes) || 0,
          allowPast: Boolean(body.allow_past),
          ownerUserId,
          actorUserId: ownerUserId
        });
        return jsonResponse(
          {
            success: res.updatedCount > 0,
            updated_count: res.updatedCount,
            rescheduled_count: res.updatedCount,
            updated_tasks: res.updatedTasks,
            skipped_tasks: res.skippedTasks,
            skipped: res.skippedTasks,
            message:
              res.updatedCount > 0
                ? `Đã cập nhật lịch đăng cho ${res.updatedCount} task${res.skippedTasks.length > 0 ? ` (Bỏ qua ${res.skippedTasks.length} task không hợp lệ)` : ""}.`
                : res.skippedTasks[0]?.reason || "Không có task nào đủ điều kiện đổi lịch."
          },
          res.updatedCount > 0 ? 200 : 400
        );
      } catch (err: any) {
        if (err instanceof ScheduleValidationError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              field_errors: err.fieldErrors,
              is_past: err.isPast,
              missing_date: err.missingDate,
              missing_time: err.missingTime
            },
            err.httpStatus
          );
        }
        return jsonResponse({ detail: err?.message || "Không thể đổi lịch đăng." }, 400);
      }
    }

    if (pathname === "/api/tasks/bulk-cancel" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { task_ids?: number[] };
      const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
      if (taskIds.length === 0) {
        return jsonResponse({ detail: "Vui lòng chọn ít nhất một task để hủy lịch." }, 400);
      }
      const res = await cancelTasksBulk(db, {
        taskIds,
        ownerUserId,
        actorUserId: ownerUserId
      });
      return jsonResponse(
        {
          success: res.cancelledCount > 0,
          cancelled_count: res.cancelledCount,
          cancelled_task_ids: res.cancelledTaskIds,
          skipped_tasks: res.skippedTasks,
          skipped: res.skippedTasks,
          message:
            res.cancelledCount > 0
              ? `Đã hủy lịch ${res.cancelledCount} task${res.skippedTasks.length > 0 ? ` (Bỏ qua ${res.skippedTasks.length} task)` : ""}.`
              : res.skippedTasks[0]?.reason || "Không có task nào có thể hủy lịch."
        },
        res.cancelledCount > 0 ? 200 : 400
      );
    }

    const taskLogsMatch = /^\/api\/tasks\/(\d+)\/logs$/.exec(pathname);
    if (taskLogsMatch && method === "GET") {
      const taskId = parseInt(taskLogsMatch[1], 10);
      const logs = await getTaskLogs(db, taskId, ownerUserId);
      return jsonResponse({ task_id: taskId, logs });
    }

    const taskAttemptsMatch = /^\/api\/tasks\/(\d+)\/attempts$/.exec(pathname);
    if (taskAttemptsMatch && method === "GET") {
      const taskId = parseInt(taskAttemptsMatch[1], 10);
      const attempts = await getTaskAttempts(db, taskId, ownerUserId);
      return jsonResponse({ task_id: taskId, attempts });
    }

    const taskResetMatch = /^\/api\/tasks\/(\d+)\/reset$/.exec(pathname);
    if (taskResetMatch && method === "POST") {
      const taskId = parseInt(taskResetMatch[1], 10);
      try {
        const ok = await resetTask(db, taskId, ownerUserId);
        if (!ok) {
          return jsonResponse({ detail: "Không tìm thấy tác vụ thuộc quyền sở hữu của bạn." }, 404);
        }
        return jsonResponse({ success: true, id: taskId });
      } catch (err: any) {
        if (err instanceof TaskLockError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              locked: true
            },
            err.httpStatus
          );
        }
        return jsonResponse({ detail: err?.message || "Không thể đặt lại tác vụ." }, 400);
      }
    }

    const taskRetryCommentMatch = /^\/api\/tasks\/(\d+)\/retry-comment$/.exec(pathname);
    if (taskRetryCommentMatch && method === "POST") {
      const taskId = parseInt(taskRetryCommentMatch[1], 10);
      const task = await getTask(db, taskId, ownerUserId);
      if (!task) {
        return jsonResponse({ detail: "Không tìm thấy tác vụ thuộc quyền sở hữu của bạn." }, 404);
      }

      if (task.status !== "success" || !task.post_id) {
        return jsonResponse(
          { detail: "Chỉ có thể đăng lại bình luận cho bài Reels đã xuất bản thành công." },
          400
        );
      }

      const cleanComment = (task.comment_text || "").trim();
      if (!cleanComment) {
        return jsonResponse({ detail: "Tác vụ này không có nội dung bình luận." }, 400);
      }

      if (task.comment_status === "success") {
        return jsonResponse({
          success: true,
          locked: true,
          already_commented: true,
          message: "Bình luận này đã được đăng thành công trên Facebook.",
          comment_id: task.comment_id || ""
        });
      }

      if (!task.facebook_page_id) {
        return jsonResponse({ detail: "Tác vụ chưa được gán Fanpage." }, 400);
      }

      const page = await getFacebookPageByFbId(
        db,
        encryptionKey,
        task.facebook_page_id,
        true,
        ownerUserId
      );

      if (!page) {
        return jsonResponse(
          {
            detail: `Không tìm thấy Fanpage ${task.facebook_page_id} trong danh sách quản lý của bạn.`,
            error_type: "INVALID_PAGE_TOKEN"
          },
          400
        );
      }

      await updateTaskCommentState(db, task.id, "processing", "Đang thử đăng lại bình luận...");
      await appendTaskStageLog(
        db,
        task.id,
        ownerUserId,
        "INFO",
        "retry_comment",
        "Người dùng yêu cầu thử đăng lại bình luận."
      );

      const cmtRes = await postReelCommentViaGraphApi(db, env, {
        facebookPageId: page.facebook_page_id || task.facebook_page_id,
        pageAccessToken: page.page_access_token || "",
        postId: task.post_id,
        videoId: task.video_id,
        commentText: cleanComment,
        ownerUserId,
        taskId: task.id
      });

      if (cmtRes.success) {
        await updateTaskCommentState(db, task.id, "success", cmtRes.message, {
          commentId: cmtRes.comment_id,
          commentPostedAt: new Date().toISOString()
        });
        if (
          cmtRes.post_id &&
          cmtRes.post_id !== task.video_id &&
          cmtRes.post_id !== task.post_id
        ) {
          try {
            await db
              .prepare("UPDATE tasks SET post_id = ? WHERE id = ?")
              .bind(cmtRes.post_id, task.id)
              .run();
          } catch {}
        }
        await appendTaskStageLog(db, task.id, ownerUserId, "INFO", "comment_success", cmtRes.message);
        return jsonResponse({
          success: true,
          comment_id: cmtRes.comment_id,
          comment_status: "success",
          message: cmtRes.message
        });
      } else {
        await updateTaskCommentState(db, task.id, "failed", cmtRes.message);
        await appendTaskStageLog(db, task.id, ownerUserId, "WARN", "comment_failed", cmtRes.message);
        return jsonResponse(
          {
            success: false,
            comment_status: "failed",
            error_type: cmtRes.error_type || "META_API_ERROR",
            error_code: cmtRes.error_code || 400,
            detail: cmtRes.message,
            message: cmtRes.message
          },
          400
        );
      }
    }

    const taskSyncInsightsMatch = /^\/api\/tasks\/(\d+)\/sync-insights$/.exec(pathname);
    if (taskSyncInsightsMatch && method === "POST") {
      const taskId = parseInt(taskSyncInsightsMatch[1], 10);
      const res = await syncSingleReelInsights(db, env, taskId, ownerUserId);
      if (!res.success && res.error_type === "NOT_FOUND") {
        return jsonResponse({ detail: res.message, error_type: res.error_type }, 404);
      }
      if (!res.success && res.error_type === "INVALID_STATE") {
        return jsonResponse({ detail: res.message, error_type: res.error_type }, 400);
      }
      return jsonResponse(res);
    }

    const taskItemMatch = /^\/api\/tasks\/(\d+)$/.exec(pathname);
    if (taskItemMatch && method === "PUT") {
      const taskId = parseInt(taskItemMatch[1], 10);
      const body = (await request.json()) as {
        facebook_page_id?: string;
        profile_id?: string;
        video_path?: string;
        caption?: string;
        comment_text?: string;
        schedule_date?: string;
        schedule_time?: string;
        allow_past?: boolean;
      };
      const pageId =
        body.facebook_page_id !== undefined ? body.facebook_page_id : body.profile_id;
      try {
        const ok = await updateTask(
          db,
          taskId,
          {
            facebookPageId: pageId,
            videoPath: body.video_path,
            caption: body.caption,
            commentText: body.comment_text,
            scheduleDate: body.schedule_date,
            scheduleTime: body.schedule_time,
            ownerUserId
          },
          {
            allowPast: Boolean(body.allow_past)
          }
        );
        if (!ok) {
          return jsonResponse({ detail: "Không tìm thấy tác vụ thuộc quyền sở hữu của bạn." }, 404);
        }
        const updated = await getTask(db, taskId, ownerUserId);
        return jsonResponse({ success: true, task: updated });
      } catch (err: any) {
        if (err instanceof TaskLockError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              locked: true
            },
            err.httpStatus
          );
        }
        if (err instanceof ScheduleValidationError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              field_errors: err.fieldErrors,
              is_past: err.isPast,
              missing_date: err.missingDate,
              missing_time: err.missingTime
            },
            err.httpStatus
          );
        }
        return jsonResponse(
          { detail: err?.message || "Thời gian đặt lịch không hợp lệ hoặc đã qua." },
          400
        );
      }
    }

    if (taskItemMatch && method === "DELETE") {
      const taskId = parseInt(taskItemMatch[1], 10);
      try {
        const delRes = await deleteTask(db, taskId, ownerUserId);
        if (!delRes.deleted) {
          return jsonResponse({ detail: "Không tìm thấy tác vụ thuộc quyền sở hữu của bạn." }, 404);
        }
        // Tự động xóa video tạm trên R2 nếu không còn task nào khác tham chiếu
        if (delRes.orphanMediaId) {
          await deleteUserVideo(db, env, delRes.orphanMediaId, ownerUserId);
        }
        return jsonResponse({
          success: true,
          deleted_id: taskId,
          cleaned_orphan_media_id: delRes.orphanMediaId || null
        });
      } catch (err: any) {
        if (err instanceof TaskLockError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              locked: true
            },
            err.httpStatus
          );
        }
        return jsonResponse({ detail: err?.message || "Không thể xóa tác vụ." }, 400);
      }
    }

    // ------------------------------------------
    // 6.4B. XÓA NHIỀU TASK ĐÃ CHỌN (/api/tasks/bulk-delete HOẶC DELETE /api/tasks/bulk)
    // ------------------------------------------
    if (
      (pathname === "/api/tasks/bulk-delete" && method === "POST") ||
      (pathname === "/api/tasks/bulk" && method === "DELETE")
    ) {
      const body = (await request.json().catch(() => ({}))) as { task_ids?: number[] };
      const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
      if (taskIds.length === 0) {
        return jsonResponse({ detail: "Vui lòng chọn ít nhất một tác vụ để xóa." }, 400);
      }
      try {
        const bulkRes = await deleteTasksBulk(db, taskIds, ownerUserId);
        for (const mId of bulkRes.orphanMediaIds) {
          await deleteUserVideo(db, env, mId, ownerUserId);
        }
        return jsonResponse({
          success: true,
          deleted_count: bulkRes.deletedCount,
          cleaned_orphan_count: bulkRes.orphanMediaIds.length,
          skipped_locked_count: bulkRes.skippedLockedCount,
          skipped_locked_ids: bulkRes.lockedTaskIds
        });
      } catch (err: any) {
        if (err instanceof TaskLockError) {
          return jsonResponse(
            {
              error_code: err.code,
              detail: err.message,
              message: err.message,
              locked: true
            },
            err.httpStatus
          );
        }
        return jsonResponse({ detail: err?.message || "Không thể xóa tác vụ." }, 400);
      }
    }

    // ------------------------------------------
    // 6.4D. THỐNG KÊ REELS INSIGHTS (/api/insights*)
    // ------------------------------------------
    if (pathname === "/api/insights/reels" && method === "GET") {
      const facebookPageId = url.searchParams.get("facebook_page_id") || url.searchParams.get("page_id") || null;
      const range = url.searchParams.get("range") || "30d";
      const startDate = url.searchParams.get("start_date") || null;
      const endDate = url.searchParams.get("end_date") || null;
      const search = url.searchParams.get("search") || null;
      const sortBy = url.searchParams.get("sort_by") || "published_at";
      const sortDir = (url.searchParams.get("sort_dir") === "asc" ? "asc" : "desc") as "asc" | "desc";

      const dashboard = await getReelsAnalyticsDashboard(db, env, ownerUserId, {
        facebookPageId,
        range,
        startDate,
        endDate,
        search,
        sortBy,
        sortDir
      });
      return jsonResponse(dashboard);
    }

    const insightItemMatch = /^\/api\/insights\/reels\/(\d+)$/.exec(pathname);
    if (insightItemMatch && method === "GET") {
      const taskId = parseInt(insightItemMatch[1], 10);
      const detail = await getSingleReelInsightDetail(db, env, taskId, ownerUserId);
      if (!detail) {
        return jsonResponse(
          { detail: "Không tìm thấy bài đăng Reels thuộc quyền sở hữu của bạn." },
          404
        );
      }
      return jsonResponse(detail);
    }

    if (pathname === "/api/insights/sync" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        facebook_page_id?: string | null;
        task_id?: number | null;
        limit?: number;
      };
      const syncRes = await syncUserReelsInsights(db, env, ownerUserId, {
        facebookPageId: body.facebook_page_id || null,
        taskId: body.task_id ? Number(body.task_id) : null,
        limit: body.limit ? Number(body.limit) : 20
      });
      return jsonResponse(syncRes);
    }

    // ------------------------------------------
    // 6.4C. TỰ ĐỘNG DỌN DẸP VIDEO R2 HẾT HẠN (/api/system/cleanup-expired-media)
    // ------------------------------------------
    if (
      (pathname === "/api/system/cleanup-expired-media" || pathname === "/api/media/cleanup-expired") &&
      method === "POST"
    ) {
      const body = (await request.json().catch(() => ({}))) as { max_age_days?: number };
      const maxAge = Number(body.max_age_days) || 30;
      const result = await cleanupExpiredR2Media(db, env, maxAge, 50);
      return jsonResponse({ success: true, ...result });
    }

    // ------------------------------------------
    // 6.5. KIỂM TRA VIDEO BULK (/api/system/check-files)
    // ------------------------------------------
    if (pathname === "/api/system/check-files" && method === "POST") {
      const body = (await request.json()) as { paths?: string[] };
      const paths = body.paths || [];
      const results: Record<string, unknown> = {};
      for (const p of paths) {
        if (!p) continue;
        results[p] = await validateVideoSource(db, env, p, ownerUserId);
      }
      return jsonResponse({ results });
    }

    if (pathname === "/api/system/browse-file" && method === "GET") {
      return jsonResponse({
        path: "",
        cloud_mode: true,
        message:
          "Vui lòng nhấn nút 'Tải Video Lên R2' để chọn video trực tiếp từ trình duyệt của bạn."
      });
    }

    // ------------------------------------------
    // 6.6. RUNNER, QUEUE & FREE QUOTA STATUS
    // ------------------------------------------
    if (pathname === "/api/runner/test" && method === "POST") {
      const report = await runDiagnosticTest(db, env, ownerUserId);
      return jsonResponse(report);
    }

    if (
      (pathname === "/api/runner/start" || pathname === "/api/run") &&
      method === "POST"
    ) {
      const enqueueRes = await enqueueUserPendingTasks(db, env, ctx, ownerUserId, {
        onlyDueOrUnscheduled: true
      });
      if (!enqueueRes.success) {
        return jsonResponse({ detail: enqueueRes.message }, 400);
      }
      return jsonResponse(
        {
          success: true,
          status: "accepted",
          started_tasks: enqueueRes.enqueued_count,
          enqueued_count: enqueueRes.enqueued_count,
          message: enqueueRes.message
        },
        202
      );
    }

    if (
      (pathname === "/api/runner/stop" || pathname === "/api/stop") &&
      method === "POST"
    ) {
      const resetCount = await resetRunningTasks(db, ownerUserId);
      return jsonResponse({
        success: true,
        reset_tasks: resetCount,
        message: `Đã dừng các tác vụ đang chờ/xử lý và đặt lại ${resetCount} tác vụ về trạng thái chờ.`
      });
    }

    if (pathname === "/api/system/api-telemetry" && method === "GET") {
      const summary = await getMetaApiTelemetrySummary(db);
      return jsonResponse({
        success: true,
        ...summary
      });
    }

    if (pathname === "/api/system/quota" && method === "GET") {
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        ownerUserId
      });
      const tasks = await getTasks(db, { ownerUserId });
      const mediaRow = await db
        .prepare(
          "SELECT COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS total_bytes FROM media_files WHERE owner_user_id = ?"
        )
        .bind(ownerUserId)
        .first<{ cnt: number; total_bytes: number }>();

      const r2UsedBytes = Number(mediaRow?.total_bytes || 0);
      const r2FreeLimitBytes = 10 * 1024 * 1024 * 1024; // 10 GB R2 Free tier
      const r2Percent = Math.round((r2UsedBytes / r2FreeLimitBytes) * 10000) / 100;

      return jsonResponse({
        plan: "Cloudflare Workers Free",
        limits: {
          worker_requests_per_day: 100000,
          cpu_ms_per_invocation: 10,
          d1_rows_read_per_day: 5000000,
          d1_rows_written_per_day: 100000,
          r2_storage_gb: 10
        },
        usage: {
          pages_count: pages.length,
          tasks_count: tasks.length,
          media_files_count: Number(mediaRow?.cnt || 0),
          r2_used_mb: Math.round((r2UsedBytes / 1048576) * 100) / 100,
          r2_used_percent: r2Percent,
          r2_binding_active: Boolean(getR2Bucket(env)),
          queue_binding_active: Boolean(env.REELS_QUEUE)
        },
        warning:
          r2Percent >= 80
            ? "Cảnh báo: Dung lượng video trên R2 đã vượt 80% hạn mức Free (10 GB). Hãy xóa các video cũ đã đăng."
            : null
      });
    }

    if (pathname === "/api/meta/app-check" && method === "GET") {
      const checkRes = await ensureMetaAppDomainsConfigured(env);
      return jsonResponse({
        success: true,
        app_id: env.META_APP_ID || "1469615908436980",
        app_base_url: env.APP_BASE_URL || PRODUCTION_DOMAIN,
        redirect_uri: env.META_REDIRECT_URI || `${PRODUCTION_DOMAIN}/api/meta/callback`,
        ...checkRes
      });
    }

    if (pathname === "/api/status" && method === "GET") {
      const [pageCountsRes, taskCountsRes, accCountsRes] = await db.batch([
        db
          .prepare(
            `SELECT COUNT(*) AS total_pages,
                    COALESCE(SUM(CASE WHEN is_selected = 1 THEN 1 ELSE 0 END), 0) AS selected_pages
             FROM facebook_pages
             WHERE owner_user_id = ?`
          )
          .bind(ownerUserId),
        db
          .prepare(
            `SELECT COUNT(*) AS total_tasks,
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_tasks,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_tasks,
                    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_tasks,
                    COALESCE(SUM(CASE WHEN status IN ('running', 'queued', 'processing') THEN 1 ELSE 0 END), 0) AS running_tasks
             FROM tasks
             WHERE owner_user_id = ?`
          )
          .bind(ownerUserId),
        db
          .prepare(
            `SELECT COUNT(*) AS total_accounts,
                    COALESCE(SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END), 0) AS connected_accounts,
                    COALESCE(SUM(CASE WHEN status IN ('expired', 'invalid_token', 'revoked') THEN 1 ELSE 0 END), 0) AS expired_accounts,
                    COALESCE(SUM(CASE WHEN status = 'connected' AND COALESCE(has_read_insights, 0) = 0 THEN 1 ELSE 0 END), 0) AS missing_insights_accounts,
                    MAX(CASE WHEN status = 'connected' THEN facebook_user_name ELSE NULL END) AS primary_user_name
             FROM facebook_accounts
             WHERE owner_user_id = ?`
          )
          .bind(ownerUserId)
      ]);

      const pageCounts = ((pageCountsRes.results || [])[0] || {}) as Record<string, unknown>;
      const taskCounts = ((taskCountsRes.results || [])[0] || {}) as Record<string, unknown>;
      const accCounts = ((accCountsRes.results || [])[0] || {}) as Record<string, unknown>;

      const totalPages = Number(pageCounts.total_pages || 0);
      const selectedPages = Number(pageCounts.selected_pages || 0);
      const totalTasks = Number(taskCounts.total_tasks || 0);
      const pendingTasks = Number(taskCounts.pending_tasks || 0);
      const successTasks = Number(taskCounts.success_tasks || 0);
      const failedTasks = Number(taskCounts.failed_tasks || 0);
      const runningCount = Number(taskCounts.running_tasks || 0);
      const connectedAccounts = Number(accCounts.connected_accounts || 0);
      const totalAccounts = Number(accCounts.total_accounts || 0);
      const expiredAccounts = Number(accCounts.expired_accounts || 0);
      const missingInsightsAccounts = Number(accCounts.missing_insights_accounts || 0);

      return jsonResponse({
        is_running: runningCount > 0,
        active_tasks_count: runningCount,
        meta_connected: connectedAccounts > 0,
        meta_user_name: (accCounts.primary_user_name as string) || null,
        connected_accounts_count: connectedAccounts,
        total_accounts_count: totalAccounts,
        expired_accounts_count: expiredAccounts,
        missing_read_insights_count: missingInsightsAccounts,
        total_pages: totalPages,
        selected_pages: selectedPages,
        total_profiles: totalPages,
        selected_profiles: selectedPages,
        total_tasks: totalTasks,
        pending_tasks: pendingTasks,
        success_tasks: successTasks,
        failed_tasks: failedTasks,
        running_tasks: runningCount
      });
    }

    return jsonResponse({ detail: `API endpoint not found: ${pathname}` }, 404);
  }

  // ==========================================
  // 7. PHỤC VỤ FILE TĨNH & ĐIỀU HƯỚNG FALLBACK CHO TRANG NỘI BỘ
  // ==========================================
  if (env.ASSETS) {
    if (pathname.startsWith("/static/")) {
      const strippedUrl = new URL(request.url);
      strippedUrl.pathname = pathname.replace(/^\/static/, "");
      const strippedReq = new Request(strippedUrl.toString(), request);
      const assetResp = await env.ASSETS.fetch(strippedReq);
      if (assetResp.ok || assetResp.status === 304) return assetResp;
    }
    const directResp = await env.ASSETS.fetch(request);
    if (directResp.ok || directResp.status === 304) return directResp;
  }

  const acceptHeader = request.headers.get("Accept") || "";
  if (method === "GET" && !pathname.startsWith("/api/") && acceptHeader.includes("text/html")) {
    if (!currentUser) {
      return redirectResponse(`${url.origin}/login`, 302);
    }
    return redirectResponse(`${url.origin}/page`, 302);
  }

  return jsonResponse({ detail: "Not Found" }, 404);
}

export async function handleScheduledCron(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<{ checked_at_utc: number; claimed_count: number; task_ids: number[] }> {
  const encryptionKey = getEncryptionKeyMaterial(env);
  const db = getD1Database(env);
  await ensureDatabaseInitialized(db, encryptionKey);
  return dispatchDueScheduledTasks(db, env, ctx, 15);
}

export async function handleQueueConsumer(
  batch: MessageBatch<QueueTaskMessage>,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const encryptionKey = getEncryptionKeyMaterial(env);
  const db = getD1Database(env);
  await ensureDatabaseInitialized(db, encryptionKey);
  await handleNativeQueueBatch(batch, db, env);
}

export default {
  fetch: handleWorkerRequest,
  scheduled: handleScheduledCron,
  queue: handleQueueConsumer
};
