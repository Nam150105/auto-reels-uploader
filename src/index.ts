/**
 * Cloudflare Worker Entrypoint - Facebook Fanpage & Reels Scheduler (Worker: reels-uploader)
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
import { getLiveAnalyticsDashboard } from "./services/liveInsightsService.ts";
import { parseVnScheduleToUtc, formatUtcToVn, nowUtcSeconds } from "./utils/timezone.ts";
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
  cleanupCompletedTasks,
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
  getTaskAuditLogs,
  getTaskCommentsForTasks,
  countTaskComments,
  requeueFailedTaskComments,
  refreshTaskCommentSummary
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
  getMetaApiTelemetrySummary,
  deleteFacebookReelOrPost,
  refreshPageFollowerCounts
} from "./services/metaGraphService.ts";
import {
  syncFacebookPagePosts,
  getFacebookPostsList,
  getFacebookPostDetail,
  editFacebookPostMessage,
  deleteFacebookPostComplete,
  syncPostComments,
  createFacebookCommentOrReply,
  deleteOrHideFacebookComment
} from "./services/facebookPostsService.ts";
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
  handleNativeQueueBatch,
  processTaskComments
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
import {
  isComposerTaskPayload,
  isComposerBulkPayload,
  handleComposerCreateTask,
  handleComposerBulkCreate
} from "./routes/composerRoutes.ts";
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
  // 0.4. FAVICON FAST-PATH (/favicon.ico, /favicon.svg)
  // ==========================================
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/favicon.ico" || pathname === "/favicon.svg")
  ) {
    const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="nnnGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="50%" stop-color="#6366f1"/><stop offset="100%" stop-color="#ec4899"/></linearGradient><filter id="softGlow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.25"/></filter></defs><rect width="100" height="100" rx="26" fill="url(#nnnGrad)"/><rect x="1" y="1" width="98" height="98" rx="25" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/><path d="M25 18h50c2.2 0 4 1.8 4 4v4H21v-4c0-2.2 1.8-4 4-4z" fill="rgba(255,255,255,0.22)"/><path d="M30 18l5 8h4l-5-8h-4zm14 0l5 8h4l-5-8h-4zm14 0l5 8h4l-5-8h-4z" fill="rgba(255,255,255,0.65)"/><text x="50" y="60" font-family="'Plus Jakarta Sans', 'Be Vietnam Pro', system-ui, -apple-system, sans-serif" font-weight="900" font-size="33" letter-spacing="-0.5" text-anchor="middle" fill="#ffffff" filter="url(#softGlow)">NNN</text><rect x="20" y="69" width="60" height="16" rx="8" fill="rgba(255,255,255,0.22)"/><text x="50" y="80.5" font-family="'Plus Jakarta Sans', 'Be Vietnam Pro', system-ui, -apple-system, sans-serif" font-weight="800" font-size="8" letter-spacing="1.2" text-anchor="middle" fill="#ffffff">REELS FB</text></svg>`;
    return new Response(method === "HEAD" ? null : faviconSvg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"
      }
    });
  }

  // ==========================================
  // 0.5. STATIC ASSETS FAST-PATH (/js/*, /static/*, /css/*)
  // Phục vụ trực tiếp từ Cloudflare Assets không tốn truy vấn D1 và hỗ trợ cả 200 OK lẫn 304 Not Modified
  // ==========================================
  if (
    env.ASSETS &&
    (method === "GET" || method === "HEAD") &&
    (pathname.startsWith("/static/") ||
      pathname.startsWith("/assets/") ||
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
  if (pathname === "/login" && (method === "GET" || method === "HEAD")) {
    if (currentUser) {
      const target = sanitizeInternalRedirect(url.searchParams.get("redirect"));
      return redirectResponse(`${url.origin}${target}`, 302);
    }
    const staticResp = await serveStaticHtmlAsset(request, env, "/login.html");
    if (staticResp) return staticResp;
  }

  if (pathname === "/" && (method === "GET" || method === "HEAD")) {
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
      pathname === "/schedule" ||
      pathname === "/schedules" ||
      pathname === "/analytics" ||
      pathname === "/insights" ||
      pathname === "/posts" ||
      pathname === "/comments" ||
      pathname === "/reels") &&
    (method === "GET" || method === "HEAD")
  ) {
    const ua = request.headers.get("User-Agent") || "";
    const isFbCrawler = /facebookexternalhit|Facebot|meta-externalagent/i.test(ua);
    if (!currentUser) {
      if (isFbCrawler) {
        const staticResp = await serveStaticHtmlAsset(request, env, "/login.html");
        if (staticResp) return staticResp;
      }
      const loginRedirect =
        pathname === "/schedules" ||
        pathname === "/schedule" ||
        pathname === "/reels" ||
        pathname === "/insights" ||
        pathname === "/analytics"
          ? `/login?redirect=${encodeURIComponent(pathname + url.search)}`
          : "/login";
      return redirectResponse(`${url.origin}${loginRedirect}`, 302);
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
          detail: `Too many login attempts. Please try again in ${rl.retryAfterSeconds} seconds.`
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
          { detail: "Incorrect username or password." },
          401
        );
      }

      const issued = await issueUserSession(request, db, env, user.id);
      return jsonResponse(
        {
          success: true,
          user,
          csrf_token: issued.csrfToken,
          message: `Welcome, ${user.full_name || user.username}!`
        },
        200,
        { "Set-Cookie": makeSessionCookie(issued.token, isHttps) }
      );
    } catch {
      return jsonResponse({ detail: "Invalid login details." }, 400);
    }
  }

  if (pathname === "/api/auth/register" && method === "POST") {
    const rl = await enforceAuthRateLimit(request, db, "register");
    if (!rl.allowed) {
      return jsonResponse(
        {
          detail: `Too many sign-up attempts. Please try again in ${rl.retryAfterSeconds} seconds.`
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
        return jsonResponse({ detail: res.message || "Sign-up failed." }, 400);
      }

      const issued = await issueUserSession(request, db, env, res.user.id);
      return jsonResponse(
        {
          success: true,
          user: res.user,
          csrf_token: issued.csrfToken,
          message: "Account created successfully!"
        },
        200,
        { "Set-Cookie": makeSessionCookie(issued.token, isHttps) }
      );
    } catch {
      return jsonResponse({ detail: "Invalid sign-up details." }, 400);
    }
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    await revokeRequestSession(request, db);
    return jsonResponse(
      { success: true, message: "You have been logged out." },
      200,
      { "Set-Cookie": clearSessionCookie(isHttps) }
    );
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    if (!currentUser) {
      return jsonResponse(
        { authenticated: false, detail: "Not logged in." },
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
        title: "Permission Not Granted",
        message: "You did not grant permission to connect Facebook"
      });
    }

    if (!code) {
      return renderOAuthCallbackHtml({
        success: false,
        statusCode: 200,
        oauthStatus: "ready",
        isEndpointReadyProbe: true,
        title: "Facebook Connection Ready",
        message:
          "The sign-in endpoint is working. Go back to the app to connect your Facebook account."
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
        title: "Could Not Connect Facebook",
        message: res.message || "Could not connect to Facebook right now. Please try again."
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
        title: "Could Not Sync Pages",
        message: syncRes.message || "Could not connect to Facebook right now. Please try again.",
        accountId: res.account_id
      });
    }

    const syncedCount = syncRes.synced_count || 0;
    if (syncedCount === 0) {
      return renderOAuthCallbackHtml({
        success: false,
        statusCode: 200,
        oauthStatus: "no_pages",
        title: "No Pages Found",
        subtitle: res.user_name || "",
        message: "This account does not manage any Pages",
        syncedCount: 0,
        accountId: res.account_id
      });
    }

    return renderOAuthCallbackHtml({
      success: true,
      statusCode: 200,
      oauthStatus: "success",
      title: "Facebook account connected",
      subtitle: `${res.user_name || ""} (${syncedCount} Page(s))`,
      message: "Facebook account connected",
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
          detail: "Your session has expired. Please log in again."
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

    if (
      (pathname === "/api/meta/accounts" || pathname === "/api/accounts") &&
      method === "GET"
    ) {
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
          { detail: res.message || "Could not connect to Facebook right now. Please try again." },
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
          { detail: res.message || "Could not connect to Facebook right now. Please try again." },
          400
        );
      }
      return Response.redirect(res.oauth_url, 302);
    }

    if (
      (pathname === "/api/meta/connect-token" || pathname === "/api/meta/connect-direct-token") &&
      method === "POST"
    ) {
      const body = (await request.json().catch(() => ({}))) as {
        access_token?: string;
        token?: string;
        account_id?: string;
      };
      const rawToken = (body.access_token || body.token || "").trim();
      if (!rawToken) {
        return jsonResponse(
          { detail: "Please enter an access token from Graph API Explorer." },
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
          { detail: "Please enter a new access token from Graph API Explorer." },
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
        message: "All your Facebook accounts and Pages have been disconnected."
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
          { detail: "Facebook account not found." },
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
          { detail: "Account not found, or you can't disconnect it." },
          404
        );
      }
      return jsonResponse({
        success: true,
        message: "Facebook account disconnected."
      });
    }

    const deleteAccMatch = /^\/api\/meta\/accounts\/([^/]+)$/.exec(pathname);
    if (deleteAccMatch && method === "DELETE") {
      const accountId = decodeURIComponent(deleteAccMatch[1]);
      const delRes = await deleteFacebookAccountWithPages(db, accountId, ownerUserId);
      if (!delRes.deleted) {
        return jsonResponse(
          { detail: "Account not found, or you can't remove it." },
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
            ? `Removed the Facebook account and ${delRes.deleted_pages_count} related Page(s).`
            : "Removed the Facebook account and updated your Pages."
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
        return jsonResponse({ detail: "Page not found." }, 404);
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
        return jsonResponse({ detail: "Page not found." }, 404);
      }
      return jsonResponse({ success: true, deleted_id: pageId });
    }

    // ------------------------------------------
    // 6.4. QUẢN LÝ TÁC VỤ REELS (/api/tasks*)
    // ------------------------------------------
    if (pathname === "/api/tasks" && method === "GET") {
      const pageIdsParam =
        url.searchParams.get("facebook_page_ids") ||
        url.searchParams.get("facebook_page_id") ||
        url.searchParams.get("profile_id");
      let facebookPageIds: string[] | undefined = undefined;
      let facebookPageId: string | null = null;
      if (pageIdsParam && pageIdsParam.includes(",")) {
        facebookPageIds = pageIdsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        facebookPageId = pageIdsParam ? pageIdsParam.trim() : null;
      }
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search");
      const startDate = url.searchParams.get("start_date");
      const endDate = url.searchParams.get("end_date");
      const excludePublished =
        url.searchParams.get("exclude_published") === "true" ||
        url.searchParams.get("active_only") === "true";
      const accountIdsRaw = url.searchParams.get("account_ids") || "";
      const accountIds = accountIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const tasks = await getTasks(db, {
        facebookPageId,
        facebookPageIds,
        status,
        search,
        startDate,
        endDate,
        accountIds,
        ownerUserId,
        excludePublished
      });
      const commentMap = await getTaskCommentsForTasks(
        db,
        ownerUserId,
        (tasks as Array<{ id: number }>).map((t) => Number(t.id))
      );
      const withComments = (tasks as unknown as Array<Record<string, unknown>>).map((t) => {
        const list = commentMap.get(Number(t.id)) || [];
        return {
          ...t,
          comments: list.map((c) => ({
            position: c.position,
            text: c.message,
            has_image: Boolean(c.image_media_id),
            delay_minutes: c.delay_minutes,
            status: c.status,
            error: c.error_message || ""
          }))
        };
      });
      return jsonResponse(withComments);
    }

    if (pathname === "/api/tasks" && method === "POST") {
      const composerBody = await request.clone().json().catch(() => null);
      if (isComposerTaskPayload(composerBody)) {
        return handleComposerCreateTask(
          composerBody as Record<string, unknown>,
          db,
          env,
          ctx,
          ownerUserId,
          encryptionKey
        );
      }
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
        return jsonResponse({ detail: "Please upload or choose a video." }, 400);
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
            { detail: "You don't have access to this Page." },
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
            { detail: "Video not found." },
            403
          );
        }
        if (mediaRecord.upload_status === "failed") {
          return jsonResponse(
            {
              detail:
                mediaRecord.storage_error ||
                `The upload of '${mediaRecord.original_filename}' failed. Please upload the video again.`
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
                "The video has not been uploaded yet. Please choose a video and wait for the upload to finish before creating the post."
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
          { detail: err?.message || "The scheduled time is invalid or in the past." },
          400
        );
      }

      const created = await getTask(db, taskId, ownerUserId);
      return jsonResponse({ success: true, id: taskId, task: created });
    }

    if (pathname === "/api/tasks/bulk" && method === "POST") {
      const composerBulk = await request.clone().json().catch(() => null);
      if (isComposerBulkPayload(composerBulk)) {
        return handleComposerBulkCreate(
          composerBulk as { tasks: Record<string, unknown>[] },
          db,
          env,
          ownerUserId,
          encryptionKey
        );
      }
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
        return jsonResponse({ detail: "The post list is empty." }, 400);
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
              detail: parsedBase.error || "The start time is invalid or in the past.",
              message: parsedBase.error || "The start time is invalid or in the past.",
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

      const allowUnuploadedVideo = Boolean((body as any).allow_unuploaded_video);

      // 2. Kiểm tra tính hợp lệ và phân giải R2 cho từng task
      for (let i = 0; i < tasksList.length; i++) {
        const item = tasksList[i];
        const vPath = (item.video_path || "").trim();

        if (!vPath) {
          return jsonResponse({ detail: `Row ${i + 1}: The video path is empty.` }, 400);
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
            if (allowUnuploadedVideo) {
              item.video_path = vPath;
            } else {
              return jsonResponse(
                {
                  detail: `Row ${i + 1}: Video '${baseName}' has not been uploaded yet. Please upload it before creating the post.`
                },
                400
              );
            }
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
          { detail: err?.message || "The scheduled time is invalid or in the past." },
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
        return jsonResponse({ detail: "Select at least one post to publish now." }, 400);
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
        return jsonResponse({ detail: "Select at least one post to reschedule." }, 400);
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
                ? `Rescheduled ${res.updatedCount} post(s)${res.skippedTasks.length > 0 ? ` (${res.skippedTasks.length} skipped as not eligible)` : ""}.`
                : res.skippedTasks[0]?.reason || "No posts can be rescheduled."
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
        return jsonResponse({ detail: err?.message || "Could not reschedule." }, 400);
      }
    }

    if (pathname === "/api/tasks/bulk-cancel" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { task_ids?: number[] };
      const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
      if (taskIds.length === 0) {
        return jsonResponse({ detail: "Select at least one post to cancel." }, 400);
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
              ? `Cancelled ${res.cancelledCount} post(s)${res.skippedTasks.length > 0 ? ` (${res.skippedTasks.length} skipped)` : ""}.`
              : res.skippedTasks[0]?.reason || "No posts can be cancelled."
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
          return jsonResponse({ detail: "Post not found." }, 404);
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
        return jsonResponse({ detail: err?.message || "Could not reset the post." }, 400);
      }
    }

    const taskRetryCommentMatch = /^\/api\/tasks\/(\d+)\/retry-comment$/.exec(pathname);
    if (taskRetryCommentMatch && method === "POST") {
      const taskId = parseInt(taskRetryCommentMatch[1], 10);
      const task = await getTask(db, taskId, ownerUserId);
      if (!task) {
        return jsonResponse({ detail: "Post not found." }, 404);
      }

      if (task.status !== "success" || !task.post_id) {
        return jsonResponse(
          { detail: "Comments can only be retried on a published Reel." },
          400
        );
      }

      // Posts created with the multi-comment composer: retry every failed comment
      if ((await countTaskComments(db, task.id)) > 0) {
        const requeued = await requeueFailedTaskComments(db, task.id, ownerUserId, nowUtcSeconds());
        if (requeued === 0) {
          await refreshTaskCommentSummary(db, task.id);
          return jsonResponse({ success: true, message: "There are no failed comments to retry." });
        }
        const out = await processTaskComments(db, env, task.id, { maxToPost: 10 });
        const failedNow = out.failed > 0;
        return jsonResponse(
          {
            success: !failedNow,
            comment_status: failedNow ? "failed" : "success",
            detail: failedNow ? `${out.failed} comment(s) failed again. Check the Page connection and try later.` : undefined,
            message: failedNow
              ? `${out.posted} posted, ${out.failed} failed.`
              : `Posted ${out.posted} comment(s).`
          },
          failedNow ? 400 : 200
        );
      }

      const cleanComment = (task.comment_text || "").trim();
      if (!cleanComment) {
        return jsonResponse({ detail: "This post has no comment to publish." }, 400);
      }

      if (task.comment_status === "success") {
        return jsonResponse({
          success: true,
          locked: true,
          already_commented: true,
          message: "This comment has already been posted on Facebook.",
          comment_id: task.comment_id || ""
        });
      }

      if (!task.facebook_page_id) {
        return jsonResponse({ detail: "No Page is assigned to this post." }, 400);
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
            detail: `Page ${task.facebook_page_id} was not found in your Pages.`,
            error_type: "INVALID_PAGE_TOKEN"
          },
          400
        );
      }

      await updateTaskCommentState(db, task.id, "processing", "Retrying comment...");
      await appendTaskStageLog(
        db,
        task.id,
        ownerUserId,
        "INFO",
        "retry_comment",
        "User requested a comment retry."
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
          return jsonResponse({ detail: "Post not found." }, 404);
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
          { detail: err?.message || "The scheduled time is invalid or in the past." },
          400
        );
      }
    }

    if (taskItemMatch && method === "DELETE") {
      const taskId = parseInt(taskItemMatch[1], 10);
      const deleteFb = url.searchParams.get("delete_facebook") === "true";
      const forceDelete = deleteFb || url.searchParams.get("force") === "true";
      try {
        const existing = await getTask(db, taskId, ownerUserId);
        if (!existing) {
          return jsonResponse({ detail: "Post not found." }, 404);
        }

        // Nếu người dùng chọn xóa cả bài viết trên Facebook
        let fbDeleted = false;
        if (deleteFb && (existing.video_id || existing.post_id)) {
          const fbRes = await deleteFacebookReelOrPost(db, env, {
            pageId: existing.facebook_page_id || "",
            videoId: existing.video_id,
            postId: existing.post_id,
            ownerUserId
          });
          fbDeleted = fbRes.success;
        }

        const delRes = await deleteTask(db, taskId, ownerUserId, { allowPublished: forceDelete });
        if (!delRes.deleted) {
          return jsonResponse({ detail: "Post not found." }, 404);
        }

        // Tự động xóa video trên R2 nếu không còn bài viết nào khác tham chiếu
        if (delRes.orphanMediaId) {
          await deleteUserVideo(db, env, delRes.orphanMediaId, ownerUserId);
        }

        return jsonResponse({
          success: true,
          deleted_id: taskId,
          deleted_facebook: fbDeleted,
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
        return jsonResponse({ detail: err?.message || "Could not delete the post." }, 400);
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
        return jsonResponse({ detail: "Select at least one post to delete." }, 400);
      }
      try {
        const forceBulk = url.searchParams.get("force") === "true";
        const bulkRes = await deleteTasksBulk(db, taskIds, ownerUserId, { allowPublished: forceBulk });
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
        return jsonResponse({ detail: err?.message || "Could not delete the posts." }, 400);
      }
    }


    if (pathname === "/api/tasks/cleanup-completed" && method === "POST") {
      try {
        const cleanupRes = await cleanupCompletedTasks(db, ownerUserId);
        return jsonResponse({
          success: true,
          deleted_count: cleanupRes.deletedCount,
          message: `Cleared ${cleanupRes.deletedCount} completed post(s).`
        });
      } catch (err: any) {
        return jsonResponse({ detail: err?.message || "Could not clear completed posts." }, 400);
      }
    }

    // ------------------------------------------
    // 6.4E. THÊM BÌNH LUẬN TRỰC TIẾP VÀO BÀI VIẾT ĐÃ ĐĂNG (/api/tasks/:id/comment)
    // ------------------------------------------
    const taskNewCommentMatch = /^\/api\/tasks\/(\d+)\/comment$/.exec(pathname);
    if (taskNewCommentMatch && method === "POST") {
      const taskId = parseInt(taskNewCommentMatch[1], 10);
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const msg = (body.message || "").trim();
      if (!msg) {
        return jsonResponse({ detail: "Comment cannot be empty." }, 400);
      }

      const task = await getTask(db, taskId, ownerUserId);
      if (!task) {
        return jsonResponse({ detail: "Post not found." }, 404);
      }
      if (task.status !== "success" || (!task.post_id && !task.video_id)) {
        return jsonResponse({ detail: "This post is not published on Facebook yet, so you can't comment on it." }, 400);
      }

      const page = await getFacebookPageByFbId(db, encryptionKey, task.facebook_page_id || "", true, ownerUserId);
      if (!page || !page.page_access_token) {
        return jsonResponse({ detail: "No access to this Page was found." }, 400);
      }

      const cmtRes = await postReelCommentViaGraphApi(db, env, {
        facebookPageId: page.facebook_page_id || task.facebook_page_id || "",
        pageAccessToken: page.page_access_token,
        postId: task.post_id || task.video_id,
        videoId: task.video_id,
        commentText: msg,
        ownerUserId,
        taskId: task.id,
        skipInitialDuplicateCheck: true
      });

      if (cmtRes.success) {
        await updateTaskCommentState(db, taskId, "success", cmtRes.message, {
          commentId: cmtRes.comment_id,
          commentPostedAt: new Date().toISOString()
        });
        return jsonResponse({
          success: true,
          comment_id: cmtRes.comment_id,
          message: "Comment posted."
        });
      } else {
        await updateTaskCommentState(db, taskId, "failed", cmtRes.message);
        return jsonResponse({
          success: false,
          detail: cmtRes.message || "Could not post the comment to Facebook."
        }, 400);
      }
    }

    // ------------------------------------------
    // 6.4F. QUẢN LÝ BÀI VIẾT FACEBOOK (POSTS MANAGER)
    // ------------------------------------------
    if (pathname === "/api/posts" && method === "GET") {
      const pageId = url.searchParams.get("page_id") || undefined;
      const postType = url.searchParams.get("post_type") || undefined;
      const source = url.searchParams.get("source") || undefined;
      const search = url.searchParams.get("search") || undefined;
      const startDate = url.searchParams.get("start_date") || undefined;
      const endDate = url.searchParams.get("end_date") || undefined;
      const page = Number(url.searchParams.get("page")) || 1;
      const limit = Number(url.searchParams.get("limit")) || 20;

      const result = await getFacebookPostsList(db, ownerUserId, {
        page_id: pageId,
        post_type: postType,
        source: source,
        search,
        start_date: startDate,
        end_date: endDate,
        page,
        limit
      });
      return jsonResponse({ success: true, ...result });
    }

    const postCommentsMatch = /^\/api\/posts\/([^\/]+)\/comments$/.exec(pathname);
    if (postCommentsMatch && method === "GET") {
      const pId = decodeURIComponent(postCommentsMatch[1]);
      const res = await syncPostComments(db, env, { postId: pId, ownerUserId });
      if (res.success) {
        return jsonResponse({ success: true, comments: res.comments, count: res.count });
      }
      return jsonResponse({ success: false, detail: res.error || "Could not load comments" }, 400);
    }

    if (postCommentsMatch && method === "POST") {
      const pId = decodeURIComponent(postCommentsMatch[1]);
      const body = (await request.json().catch(() => ({}))) as {
        message?: string;
        parent_comment_id?: string;
      };
      const res = await createFacebookCommentOrReply(db, env, {
        postId: pId,
        parentCommentId: body.parent_comment_id,
        message: body.message || "",
        ownerUserId
      });
      if (res.success) {
        return jsonResponse({ success: true, comment_id: res.comment_id });
      }
      return jsonResponse({ success: false, detail: res.error || "Could not post the comment" }, 400);
    }

    const postDetailMatch = /^\/api\/posts\/([^\/]+)$/.exec(pathname);
    if (postDetailMatch && method === "GET") {
      const pId = decodeURIComponent(postDetailMatch[1]);
      const detail = await getFacebookPostDetail(db, ownerUserId, pId);
      if (!detail.post) {
        return jsonResponse({ detail: "Post not found." }, 404);
      }
      return jsonResponse({ success: true, ...detail });
    }

    if (postDetailMatch && method === "PUT") {
      const pId = decodeURIComponent(postDetailMatch[1]);
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const newMsg = body.message || "";
      const editRes = await editFacebookPostMessage(db, env, {
        postId: pId,
        newCaption: newMsg,
        ownerUserId
      });
      if (editRes.success) {
        return jsonResponse({
          success: true,
          updated_post: editRes.updated_post,
          message: "Post updated on Facebook."
        });
      } else {
        return jsonResponse({
          success: false,
          detail: editRes.error || "Could not update the post."
        }, 400);
      }
    }

    if (postDetailMatch && method === "DELETE") {
      const pId = decodeURIComponent(postDetailMatch[1]);
      const delFb = url.searchParams.get("delete_facebook") === "true";
      const delRes = await deleteFacebookPostComplete(db, env, {
        postId: pId,
        deleteFacebook: delFb,
        ownerUserId
      });
      if (delRes.success) {
        return jsonResponse({
          success: true,
          deleted_id: pId,
          deleted_facebook: delFb,
          message: delFb ? "Post deleted from Facebook and the app." : "Post removed from the app."
        });
      } else {
        return jsonResponse({
          success: false,
          detail: delRes.error || "Could not delete the post."
        }, 400);
      }
    }

    const commentReplyMatch = /^\/api\/comments\/([^\/]+)\/reply$/.exec(pathname);
    if (commentReplyMatch && method === "POST") {
      const commentId = decodeURIComponent(commentReplyMatch[1]);
      const body = (await request.json().catch(() => ({}))) as {
        message?: string;
        post_id?: string;
      };
      const res = await createFacebookCommentOrReply(db, env, {
        postId: body.post_id || "",
        parentCommentId: commentId,
        message: body.message || "",
        ownerUserId
      });
      if (res.success) {
        return jsonResponse({ success: true, comment_id: res.comment_id });
      }
      return jsonResponse({ success: false, detail: res.error || "Could not reply to the comment" }, 400);
    }

    const commentHideMatch = /^\/api\/comments\/([^\/]+)\/hide$/.exec(pathname);
    if (commentHideMatch && method === "POST") {
      const commentId = decodeURIComponent(commentHideMatch[1]);
      const body = (await request.json().catch(() => ({}))) as { hide?: boolean };
      const res = await deleteOrHideFacebookComment(db, env, {
        commentId,
        action: body.hide !== false ? "hide" : "unhide",
        ownerUserId
      });
      if (res.success) {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ success: false, detail: res.error || "Could not update the comment" }, 400);
    }

    const commentItemMatch = /^\/api\/comments\/([^\/]+)$/.exec(pathname);
    if (commentItemMatch && method === "DELETE") {
      const commentId = decodeURIComponent(commentItemMatch[1]);
      const res = await deleteOrHideFacebookComment(db, env, {
        commentId,
        action: "delete",
        ownerUserId
      });
      if (res.success) {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ success: false, detail: res.error || "Could not delete the comment" }, 400);
    }

    // ------------------------------------------
    // 6.4G. ĐỒNG BỘ BÀI VIẾT TỪ FANPAGE VỀ HỆ THỐNG (/api/pages/:id/sync-posts)
    // ------------------------------------------
    const pageSyncPostsMatch = /^\/api\/pages\/([^\/]+)\/sync-posts$/.exec(pathname);
    if (pageSyncPostsMatch && method === "POST") {
      const pageId = decodeURIComponent(pageSyncPostsMatch[1]);
      const body = (await request.json().catch(() => ({}))) as {
        cursor?: string;
        limit?: number;
        force_reset?: boolean;
      };
      const syncRes = await syncFacebookPagePosts(db, env, {
        pageId,
        ownerUserId,
        cursor: body.cursor || url.searchParams.get("cursor") || undefined,
        limit: body.limit || Number(url.searchParams.get("limit")) || 30,
        forceResetCursor: Boolean(body.force_reset)
      });
      if (syncRes.success) {
        return jsonResponse({
          success: true,
          synced_count: syncRes.count,
          new_count: syncRes.new_count,
          updated_count: syncRes.updated_count,
          next_cursor: syncRes.next_cursor,
          has_more: syncRes.has_more,
          total_synced: syncRes.total_synced,
          message: syncRes.message || `Synced ${syncRes.count} posts from the Page.`
        });
      } else {
        return jsonResponse({
          success: false,
          detail: syncRes.error || "Could not sync posts from the Page."
        }, 400);
      }
    }

    // ------------------------------------------
    // 6.4D. THỐNG KÊ REELS INSIGHTS (/api/insights*)
    // ------------------------------------------
    // Live analytics straight from the Meta Graph API (Pages, Page insights, Reels and Reel insights)
    if (pathname === "/api/insights/live" && method === "GET") {
      const days = parseInt(url.searchParams.get("days") || "28", 10) || 28;
      const refresh = url.searchParams.get("refresh") === "1";
      const data = await getLiveAnalyticsDashboard(db, env, ownerUserId, { days, refresh, encryptionKey });
      return jsonResponse(data);
    }

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
          { detail: "Reel not found." },
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
      if (!body.task_id) {
        try {
          await refreshPageFollowerCounts(db, env, ownerUserId);
        } catch {
          // Số người theo dõi là phụ, không chặn kết quả đồng bộ
        }
      }
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
          "Please upload the video from your browser."
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
        message: `Stopped queued and running posts. ${resetCount} post(s) reset to pending.`
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
            ? "Warning: Video storage is over 80% of the free 10 GB limit. Please delete old published videos."
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
  return dispatchDueScheduledTasks(db, env, ctx);
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
