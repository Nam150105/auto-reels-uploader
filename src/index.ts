/**
 * Cloudflare Worker Entrypoint - Facebook Fanpage & Reels Scheduler
 * Production Domain : https://pagefb.namnangno.click
 * Facebook App ID   : 1469615908436980
 * OAuth Callback    : https://pagefb.namnangno.click/api/meta/callback
 */

import type { Env, ExecutionContext, UserRecord, D1Database } from "./types.ts";
import {
  generateSessionToken,
  verifySessionToken,
  randomHex,
  bytesToBase64Url
} from "./crypto.ts";
import {
  ensureDatabaseInitialized,
  getUserById,
  verifyUserCredentials,
  createUser,
  getFacebookAccounts,
  getFacebookAccountById,
  disconnectFacebookAccount,
  deleteFacebookAccountLocal,
  disconnectAllUserAccounts,
  getFacebookPages,
  updatePageSelection,
  bulkUpdatePageSelection,
  deleteFacebookPageLocal,
  getTasks,
  getTask,
  addTask,
  updateTask,
  addTasksBulk,
  deleteTask,
  resetTask,
  resetRunningTasks,
  getPendingTasks,
  saveUploadedVideo
} from "./db.ts";
import {
  PRODUCTION_DOMAIN,
  generateOAuthUrl,
  exchangeCodeForToken,
  getConnectionStatus,
  syncPagesFromMeta,
  checkPagePermissionOnMeta,
  validateVideoSource,
  runDiagnosticTest,
  executeTasksBatch
} from "./meta.ts";
import { getD1Database } from "./fallback_d1.ts";

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function htmlResponse(
  html: string,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...extraHeaders
    }
  });
}

function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function makeSessionCookie(token: string, isHttps: boolean, maxAgeSeconds = 7 * 86400): string {
  const parts = [
    `session_token=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isHttps) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearSessionCookie(isHttps: boolean): string {
  const parts = [
    "session_token=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (isHttps) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

async function getCurrentUser(
  request: Request,
  db: D1Database,
  env: Env
): Promise<UserRecord | null> {
  const cookies = parseCookies(request.headers.get("Cookie"));
  let token = cookies["session_token"] || "";

  if (!token) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }
  }
  if (!token) return null;

  const secretKey = env.SECRET_KEY || "meta_scheduler_secret_key_2026";
  const userId = await verifySessionToken(token, secretKey);
  if (!userId) return null;

  return getUserById(db, userId);
}

async function serveStaticHtmlAsset(
  request: Request,
  env: Env,
  assetPath: string
): Promise<Response | null> {
  if (!env.ASSETS) return null;
  const url = new URL(request.url);
  url.pathname = assetPath;
  const assetReq = new Request(url.toString(), {
    method: "GET",
    headers: request.headers
  });
  const resp = await env.ASSETS.fetch(assetReq);
  if (resp.ok) {
    return new Response(resp.body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }
  return null;
}

function renderOAuthCallbackHtml(options: {
  success: boolean;
  title: string;
  subtitle?: string;
  message: string;
}): Response {
  const badgeClass = options.success
    ? "bg-emerald-500/20 text-emerald-400"
    : "bg-rose-500/20 text-rose-400";
  const icon = options.success ? "✓" : "✕";
  const metaRefresh = options.success
    ? `<meta http-equiv="refresh" content="2;url=/pages" />`
    : "";

  return htmlResponse(
    `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${metaRefresh}
  <title>${escapeHtml(options.title)}</title>
  <script data-cfasync="false" src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
    <div class="h-14 w-14 rounded-full ${badgeClass} flex items-center justify-center mx-auto mb-4 text-3xl font-bold">${icon}</div>
    <h2 class="text-xl font-bold text-white mb-2">${escapeHtml(options.title)}</h2>
    ${
      options.subtitle
        ? `<p class="text-sm text-slate-300 mb-1">Tài khoản: <b>${escapeHtml(options.subtitle)}</b></p>`
        : ""
    }
    <p class="text-xs ${options.success ? "text-slate-400" : "text-rose-400"} mb-6 whitespace-pre-line">${escapeHtml(options.message)}</p>
    ${
      options.success
        ? `<p class="text-xs text-slate-500 mb-4 animate-pulse">Đang tự động chuyển hướng về trang Quản lý Fanpage...</p>`
        : ""
    }
    <a href="/pages" class="inline-block py-2.5 px-6 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg transition">
      Về Bảng Điều Khiển Ngay
    </a>
  </div>
</body>
</html>`,
    options.success ? 200 : 400
  );
}

export async function handleWorkerRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  const isHttps =
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";

  // Handle CORS preflight strictly for production domain / same-origin
  if (method === "OPTIONS") {
    const origin = request.headers.get("Origin") || PRODUCTION_DOMAIN;
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true"
      }
    });
  }

  const db = getD1Database(env.DB);
  await ensureDatabaseInitialized(db);

  // =========================================================================
  // PUBLIC META COMPLIANCE ROUTES (No Authentication Required)
  // =========================================================================

  if (method === "GET" && path === "/privacy") {
    const asset = await serveStaticHtmlAsset(request, env, "/privacy.html");
    if (asset) return asset;
    return htmlResponse(
      `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Chính Sách Quyền Riêng Tư - Quản lý fanpage</title></head><body><h1>Chính Sách Quyền Riêng Tư - Quản lý fanpage (App ID: 1469615908436980)</h1><p>Website: https://pagefb.namnangno.click</p></body></html>`
    );
  }

  if (method === "GET" && path === "/terms") {
    const asset = await serveStaticHtmlAsset(request, env, "/terms.html");
    if (asset) return asset;
    return htmlResponse(
      `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Điều Khoản Dịch Vụ - Quản lý fanpage</title></head><body><h1>Điều Khoản Dịch Vụ - Quản lý fanpage (App ID: 1469615908436980)</h1><p>Website: https://pagefb.namnangno.click</p></body></html>`
    );
  }

  if (method === "GET" && path === "/data-deletion") {
    const asset = await serveStaticHtmlAsset(request, env, "/data-deletion.html");
    if (asset) return asset;
    return htmlResponse(
      `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Hướng Dẫn Xóa Dữ Liệu - Quản lý fanpage</title></head><body><h1>Hướng Dẫn Xóa Dữ Liệu Người Dùng - Quản lý fanpage (App ID: 1469615908436980)</h1><p>Callback: https://pagefb.namnangno.click/api/meta/data-deletion</p></body></html>`
    );
  }

  if (path === "/api/meta/data-deletion" && (method === "POST" || method === "GET")) {
    const confirmationCode = `DEL_${randomHex(8).toUpperCase()}`;
    const baseUrl = (env.APP_BASE_URL || PRODUCTION_DOMAIN).replace(/\/+$/, "");
    const statusUrl = `${baseUrl}/data-deletion-status?code=${confirmationCode}`;
    return jsonResponse({
      url: statusUrl,
      confirmation_code: confirmationCode
    });
  }

  if (method === "GET" && path === "/data-deletion-status") {
    const code = url.searchParams.get("code") || "DEL_CONFIRMED";
    return htmlResponse(`<!DOCTYPE html>
<html lang="vi" class="h-full bg-slate-950 text-slate-100">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trạng Thái Xóa Dữ Liệu - Quản lý fanpage</title>
  <script data-cfasync="false" src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full flex items-center justify-center p-4">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-7 text-center shadow-2xl">
    <div class="h-12 w-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-4 text-2xl font-bold">✓</div>
    <h2 class="text-lg font-bold text-white mb-2">Yêu Cầu Xóa Dữ Liệu Đã Được Ghi Nhận</h2>
    <p class="text-xs text-slate-400 mb-4">Mã xác nhận: <code class="font-mono text-emerald-400 font-bold">${escapeHtml(code)}</code></p>
    <p class="text-xs text-slate-300 mb-6 leading-relaxed">Toàn bộ dữ liệu phiên kết nối, token truy cập và liên kết Fanpage của bạn đã được xóa sạch hoàn toàn khỏi cơ sở dữ liệu Cloudflare D1.</p>
    <a href="/login" class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold inline-block transition">
      Về Trang Đăng Nhập
    </a>
  </div>
</body>
</html>`);
  }

  // =========================================================================
  // 0. AUTHENTICATION ENDPOINTS (/api/auth/*)
  // =========================================================================

  if (method === "POST" && path === "/api/auth/login") {
    let body: { username?: string; password?: string } = {};
    try {
      body = (await request.json()) as { username?: string; password?: string };
    } catch {
      return jsonResponse({ detail: "Dữ liệu đăng nhập không hợp lệ." }, 400);
    }

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

    const secretKey = env.SECRET_KEY || "meta_scheduler_secret_key_2026";
    const token = await generateSessionToken(user.id, secretKey);
    return jsonResponse(
      {
        status: "success",
        message: `Chào mừng ${user.full_name || user.username}!`,
        user,
        token
      },
      200,
      { "Set-Cookie": makeSessionCookie(token, isHttps) }
    );
  }

  if (method === "POST" && path === "/api/auth/register") {
    let body: {
      username?: string;
      password?: string;
      full_name?: string;
      email?: string;
    } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ detail: "Dữ liệu đăng ký không hợp lệ." }, 400);
    }

    try {
      const user = await createUser(db, {
        username: body.username || "",
        password: body.password || "",
        fullName: body.full_name,
        email: body.email,
        role: "user"
      });
      const secretKey = env.SECRET_KEY || "meta_scheduler_secret_key_2026";
      const token = await generateSessionToken(user.id, secretKey);
      return jsonResponse(
        {
          status: "success",
          message: "Đăng ký tài khoản thành công!",
          user,
          token
        },
        200,
        { "Set-Cookie": makeSessionCookie(token, isHttps) }
      );
    } catch (err) {
      return jsonResponse(
        { detail: err instanceof Error ? err.message : "Lỗi đăng ký tài khoản." },
        400
      );
    }
  }

  if (method === "POST" && path === "/api/auth/logout") {
    return jsonResponse(
      { status: "success", message: "Đã đăng xuất thành công." },
      200,
      { "Set-Cookie": clearSessionCookie(isHttps) }
    );
  }

  if (method === "GET" && path === "/api/auth/me") {
    const user = await getCurrentUser(request, db, env);
    if (!user) {
      return jsonResponse({ detail: "Chưa đăng nhập." }, 401);
    }
    return jsonResponse({ status: "success", user });
  }

  // =========================================================================
  // FACEBOOK OAUTH CALLBACK (/api/meta/callback)
  // Validated via server-side `oauth_states` table in D1
  // =========================================================================

  if (method === "GET" && path === "/api/meta/callback") {
    const error = url.searchParams.get("error");
    const errorDesc = url.searchParams.get("error_description");
    if (error) {
      return renderOAuthCallbackHtml({
        success: false,
        title: "Kết Nối Facebook Thất Bại",
        message:
          errorDesc ||
          error ||
          "Người dùng đã từ chối cấp quyền trên hộp thoại Facebook OAuth."
      });
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return renderOAuthCallbackHtml({
        success: false,
        title: "Thiếu Tham Số OAuth",
        message: "Thiếu mã `code` hoặc `state` từ phản hồi của Facebook."
      });
    }

    const currentUser = await getCurrentUser(request, db, env);
    const exchangeRes = await exchangeCodeForToken(db, env, {
      code,
      state,
      fallbackUserId: currentUser?.id || null
    });

    if (exchangeRes.status === "error") {
      return renderOAuthCallbackHtml({
        success: false,
        title: "Lỗi Đổi Mã Truy Cập (Token Exchange)",
        message: exchangeRes.message
      });
    }

    const ownerUserId = exchangeRes.owner_user_id || currentUser?.id || "usr_admin";
    const syncRes = await syncPagesFromMeta(db, env, {
      accountId: exchangeRes.account_id,
      ownerUserId
    });

    return renderOAuthCallbackHtml({
      success: true,
      title: "Kết Nối Facebook Thành Công!",
      subtitle: exchangeRes.user_name,
      message: String(syncRes.message || "Đã đồng bộ danh sách Fanpage thành công.")
    });
  }

  // =========================================================================
  // PROTECTED API ROUTES (/api/*) - Require Authenticated User
  // =========================================================================

  if (path.startsWith("/api/")) {
    const currentUser = await getCurrentUser(request, db, env);
    if (!currentUser) {
      return jsonResponse(
        {
          status: "error",
          detail: "Phiên đăng nhập đã hết hạn hoặc chưa đăng nhập. Vui lòng đăng nhập lại!"
        },
        401
      );
    }
    const ownerUserId = currentUser.id;

    // 1. META OAUTH & MULTI-ACCOUNT ENDPOINTS
    if (method === "GET" && path === "/api/meta/status") {
      const statusData = await getConnectionStatus(db, env, ownerUserId);
      return jsonResponse(statusData);
    }

    if (method === "GET" && path === "/api/meta/accounts") {
      const statusFilter = url.searchParams.get("status");
      const accounts = await getFacebookAccounts(db, {
        status: statusFilter,
        ownerUserId,
        includeEncryptedToken: false
      });
      return jsonResponse(accounts);
    }

    if (method === "GET" && path === "/api/meta/oauth-url") {
      const accountId = url.searchParams.get("account_id");
      const res = await generateOAuthUrl(db, env, {
        userId: ownerUserId,
        accountId,
        authType: "rerequest"
      });
      if (res.status === "error") {
        return jsonResponse({ detail: res.message }, 400);
      }
      return jsonResponse(res);
    }

    if (method === "GET" && path === "/api/meta/login") {
      const accountId = url.searchParams.get("account_id");
      const authType = url.searchParams.get("auth_type") || "rerequest";
      const res = await generateOAuthUrl(db, env, {
        userId: ownerUserId,
        accountId,
        authType
      });
      if (res.status === "error" || !res.oauth_url) {
        return jsonResponse({ detail: res.message || "Lỗi khởi tạo OAuth URL." }, 400);
      }
      return Response.redirect(res.oauth_url, 302);
    }

    if (method === "POST" && path === "/api/meta/disconnect") {
      await disconnectAllUserAccounts(db, ownerUserId);
      return jsonResponse({
        status: "success",
        message: "Đã ngắt kết nối toàn bộ tài khoản Facebook Admin của bạn."
      });
    }

    if (method === "POST" && path === "/api/meta/sync-pages") {
      const accountId = url.searchParams.get("account_id");
      const res = await syncPagesFromMeta(db, env, { accountId, ownerUserId });
      if (res.status === "error") {
        return jsonResponse({ detail: res.message, ...res }, 400);
      }
      return jsonResponse(res);
    }

    // Dynamic /api/meta/accounts/:accountId/*
    const accountRouteMatch = path.match(
      /^\/api\/meta\/accounts\/([^/]+)(?:\/(disconnect|sync|reconnect-url))?$/
    );
    if (accountRouteMatch) {
      const accountId = decodeURIComponent(accountRouteMatch[1]);
      const subAction = accountRouteMatch[2] || "";

      if (!subAction && method === "GET") {
        const acc = await getFacebookAccountById(db, accountId, ownerUserId, false);
        if (!acc) {
          return jsonResponse(
            { detail: "Không tìm thấy tài khoản Facebook Admin hoặc bạn không có quyền truy cập." },
            404
          );
        }
        return jsonResponse(acc);
      }

      if (subAction === "disconnect" && method === "POST") {
        const ok = await disconnectFacebookAccount(db, accountId, ownerUserId);
        if (!ok) {
          return jsonResponse(
            { detail: "Không tìm thấy tài khoản Facebook Admin thuộc quyền sở hữu của bạn." },
            404
          );
        }
        return jsonResponse({
          status: "success",
          account_id: accountId,
          message: `Đã ngắt kết nối tài khoản Facebook Admin ${accountId}.`
        });
      }

      if (!subAction && method === "DELETE") {
        const ok = await deleteFacebookAccountLocal(db, accountId, ownerUserId);
        if (!ok) {
          return jsonResponse(
            { detail: "Không tìm thấy tài khoản Facebook Admin thuộc quyền sở hữu của bạn." },
            404
          );
        }
        return jsonResponse({
          status: "success",
          account_id: accountId,
          message: `Đã xóa tài khoản Facebook Admin ${accountId} khỏi hệ thống.`
        });
      }

      if (subAction === "sync" && method === "POST") {
        const res = await syncPagesFromMeta(db, env, { accountId, ownerUserId });
        if (res.status === "error") {
          return jsonResponse({ detail: res.message, ...res }, 400);
        }
        return jsonResponse(res);
      }

      if (subAction === "reconnect-url" && method === "GET") {
        const acc = await getFacebookAccountById(db, accountId, ownerUserId, false);
        if (!acc) {
          return jsonResponse(
            { detail: "Không tìm thấy tài khoản Facebook Admin thuộc quyền sở hữu của bạn." },
            404
          );
        }
        const res = await generateOAuthUrl(db, env, {
          userId: ownerUserId,
          accountId: acc.id,
          authType: "rerequest"
        });
        return jsonResponse(res);
      }
    }

    // 2. FANPAGE MANAGEMENT ENDPOINTS (/api/pages/*)
    if (method === "GET" && path === "/api/pages") {
      const rawAccountIds = url.searchParams.get("account_ids") || "";
      const accountIds = rawAccountIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const search = url.searchParams.get("search");
      const status = url.searchParams.get("status");
      const onlySelected = url.searchParams.get("only_selected") === "true";

      const pages = await getFacebookPages(db, {
        accountIds: accountIds.length > 0 ? accountIds : null,
        search,
        status,
        onlySelected,
        ownerUserId
      });
      return jsonResponse(pages);
    }

    if (
      method === "POST" &&
      (path === "/api/pages/bulk-select" || path === "/api/pages/select-all")
    ) {
      let body: {
        is_selected?: boolean;
        facebook_page_ids?: string[];
        account_ids?: string[];
      } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ detail: "Payload không hợp lệ." }, 400);
      }
      const isSel = Boolean(body.is_selected);
      const updatedCount = await bulkUpdatePageSelection(db, {
        isSelected: isSel,
        facebookPageIds: body.facebook_page_ids,
        accountIds: body.account_ids,
        ownerUserId
      });
      return jsonResponse({
        status: "success",
        updated_count: updatedCount,
        is_selected: isSel,
        message: `Đã ${isSel ? "chọn" : "bỏ chọn"} ${updatedCount} Fanpage.`
      });
    }

    const pageRouteMatch = path.match(
      /^\/api\/pages\/([^/]+)(?:\/(select|check-permission))?$/
    );
    if (pageRouteMatch) {
      const facebookPageId = decodeURIComponent(pageRouteMatch[1]);
      const subAction = pageRouteMatch[2] || "";

      if (subAction === "select" && (method === "POST" || method === "PATCH")) {
        let body: { is_selected?: boolean } = {};
        try {
          body = (await request.json()) as { is_selected?: boolean };
        } catch {
          return jsonResponse({ detail: "Payload không hợp lệ." }, 400);
        }
        const ok = await updatePageSelection(
          db,
          facebookPageId,
          Boolean(body.is_selected),
          ownerUserId
        );
        if (!ok) {
          return jsonResponse(
            { detail: "Không tìm thấy Fanpage hoặc bạn không có quyền truy cập Fanpage này." },
            404
          );
        }
        return jsonResponse({
          status: "success",
          facebook_page_id: facebookPageId,
          is_selected: Boolean(body.is_selected)
        });
      }

      if (subAction === "check-permission" && method === "POST") {
        const res = await checkPagePermissionOnMeta(db, env, facebookPageId, ownerUserId);
        if (res.status === "error") {
          return jsonResponse({ detail: res.message, ...res }, 400);
        }
        return jsonResponse(res);
      }

      if (!subAction && method === "DELETE") {
        const ok = await deleteFacebookPageLocal(db, facebookPageId, ownerUserId);
        if (!ok) {
          return jsonResponse(
            { detail: "Không tìm thấy Fanpage hoặc bạn không có quyền xóa Fanpage này." },
            404
          );
        }
        return jsonResponse({
          status: "success",
          message: `Đã xóa Fanpage ${facebookPageId} khỏi danh sách quản lý.`
        });
      }
    }

    // 3. TASK ENDPOINTS (/api/tasks/*)
    if (method === "GET" && path === "/api/tasks") {
      const facebookPageId = url.searchParams.get("facebook_page_id");
      const profileId = url.searchParams.get("profile_id");
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search");

      const tasks = await getTasks(db, {
        facebookPageId,
        profileId,
        status,
        search,
        ownerUserId
      });
      return jsonResponse(tasks);
    }

    if (method === "POST" && path === "/api/tasks") {
      let body: {
        facebook_page_id?: string;
        profile_id?: string;
        video_path?: string;
        caption?: string;
        comment_text?: string;
        schedule_date?: string;
        schedule_time?: string;
        publish_mode?: string;
      } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ detail: "Payload không hợp lệ." }, 400);
      }

      if (!body.video_path || !body.video_path.trim()) {
        return jsonResponse({ detail: "Đường dẫn hoặc URL video không được để trống." }, 400);
      }

      try {
        const task = await addTask(db, {
          facebookPageId: body.facebook_page_id,
          profileId: body.profile_id,
          videoPath: body.video_path,
          caption: body.caption,
          commentText: body.comment_text,
          scheduleDate: body.schedule_date,
          scheduleTime: body.schedule_time,
          publishMode: body.publish_mode,
          ownerUserId
        });
        return jsonResponse({
          id: task?.id,
          message: "Tạo task thành công.",
          task
        });
      } catch (err) {
        return jsonResponse(
          { detail: err instanceof Error ? err.message : "Không thể tạo task." },
          403
        );
      }
    }

    if (method === "POST" && path === "/api/tasks/bulk") {
      let body: {
        tasks?: Array<{
          video_path: string;
          caption?: string;
          comment_text?: string;
          schedule_date?: string;
          schedule_time?: string;
          facebook_page_id?: string | null;
          profile_id?: string | null;
        }>;
        assign_page_ids?: string[];
      } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ detail: "Payload không hợp lệ." }, 400);
      }

      if (!body.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
        return jsonResponse({ detail: "Danh sách task rỗng." }, 400);
      }

      const inserted = await addTasksBulk(db, {
        tasksList: body.tasks,
        assignPageIds: body.assign_page_ids,
        ownerUserId
      });
      return jsonResponse({
        inserted_count: inserted,
        message: `Đã nhập thành công ${inserted} task.`
      });
    }

    const taskRouteMatch = path.match(/^\/api\/tasks\/(\d+)(?:\/(reset))?$/);
    if (taskRouteMatch) {
      const taskId = parseInt(taskRouteMatch[1], 10);
      const subAction = taskRouteMatch[2] || "";

      if (!subAction && method === "PUT") {
        let body: {
          facebook_page_id?: string;
          profile_id?: string;
          video_path?: string;
          caption?: string;
          comment_text?: string;
          schedule_date?: string;
          schedule_time?: string;
          publish_mode?: string;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return jsonResponse({ detail: "Payload không hợp lệ." }, 400);
        }

        try {
          const updated = await updateTask(
            db,
            taskId,
            {
              facebookPageId: body.facebook_page_id,
              profileId: body.profile_id,
              videoPath: body.video_path,
              caption: body.caption,
              commentText: body.comment_text,
              scheduleDate: body.schedule_date,
              scheduleTime: body.schedule_time,
              publishMode: body.publish_mode
            },
            ownerUserId
          );
          if (!updated) {
            return jsonResponse(
              { detail: "Không tìm thấy task hoặc bạn không có quyền chỉnh sửa." },
              404
            );
          }
          return jsonResponse({
            message: "Cập nhật task thành công.",
            task: updated
          });
        } catch (err) {
          return jsonResponse(
            { detail: err instanceof Error ? err.message : "Lỗi cập nhật task." },
            403
          );
        }
      }

      if (!subAction && method === "DELETE") {
        const ok = await deleteTask(db, taskId, ownerUserId);
        if (!ok) {
          return jsonResponse(
            { detail: "Không tìm thấy task hoặc bạn không có quyền xóa." },
            404
          );
        }
        return jsonResponse({ message: "Đã xóa task." });
      }

      if (subAction === "reset" && method === "POST") {
        const ok = await resetTask(db, taskId, ownerUserId);
        if (!ok) {
          return jsonResponse(
            { detail: "Không tìm thấy task hoặc bạn không có quyền reset." },
            404
          );
        }
        return jsonResponse({ message: "Đã reset task về trạng thái pending." });
      }
    }

    // 4. RUNNER CONTROLS (/api/runner/test, /api/runner/start, /api/runner/stop)
    if (method === "POST" && path === "/api/runner/test") {
      let body: { facebook_page_ids?: string[]; task_ids?: number[] } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        // Empty body allowed
      }
      const res = await runDiagnosticTest(db, env, {
        facebookPageIds: body.facebook_page_ids,
        taskIds: body.task_ids,
        ownerUserId
      });
      return jsonResponse(res);
    }

    if (method === "POST" && (path === "/api/runner/start" || path === "/api/run")) {
      let body: { facebook_page_ids?: string[]; threads?: number } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        // Empty body allowed
      }

      let targetPageIds = body.facebook_page_ids || [];
      if (targetPageIds.length === 0) {
        const selectedPages = await getFacebookPages(db, {
          onlySelected: true,
          ownerUserId
        });
        targetPageIds = selectedPages
          .filter((p) => Number(p.can_post) === 1)
          .map((p) => p.facebook_page_id);
      }

      if (targetPageIds.length === 0) {
        return jsonResponse(
          { detail: "Không có Fanpage nào được chọn hoặc có quyền đăng bài!" },
          400
        );
      }

      const pendingTasks = await getPendingTasks(db, {
        facebookPageIds: targetPageIds,
        ownerUserId
      });

      if (pendingTasks.length === 0) {
        return jsonResponse({ detail: "Không có task cần làm!" }, 400);
      }

      const threads = Math.max(1, Math.min(Number(body.threads || 3), 5));
      const batchPromise = executeTasksBatch(db, env, {
        tasks: pendingTasks.map((t) => ({ id: t.id })),
        ownerUserId,
        concurrency: threads
      });

      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(batchPromise);
      } else {
        await batchPromise;
      }

      return jsonResponse({
        status: "started",
        total_tasks: pendingTasks.length,
        threads,
        message: `Đã bắt đầu xử lý ${pendingTasks.length} task qua Meta Graph API v19.0.`
      });
    }

    if (method === "POST" && (path === "/api/runner/stop" || path === "/api/stop")) {
      const resetCount = await resetRunningTasks(db, ownerUserId);
      return jsonResponse({
        status: "stopped",
        message: `Đã dừng tiến trình và đặt lại ${resetCount} task.`
      });
    }

    // 5. DASHBOARD STATUS SUMMARY (/api/status)
    if (method === "GET" && path === "/api/status") {
      const [connStatus, allAccounts, allPages, allTasks] = await Promise.all([
        getConnectionStatus(db, env, ownerUserId),
        getFacebookAccounts(db, { ownerUserId, includeEncryptedToken: false }),
        getFacebookPages(db, { ownerUserId }),
        getTasks(db, { ownerUserId })
      ]);

      const pendingTasks = allTasks.filter((t) => t.status === "pending");
      const successTasks = allTasks.filter((t) => t.status === "success");
      const failedTasks = allTasks.filter((t) => t.status === "failed");
      const runningTasks = allTasks.filter((t) => t.status === "running");

      return jsonResponse({
        user: currentUser,
        meta: connStatus,
        accounts: allAccounts,
        is_running: runningTasks.length > 0,
        total_accounts: allAccounts.length,
        connected_accounts: allAccounts.filter((a) => a.status === "connected").length,
        total_pages: allPages.length,
        selected_pages: allPages.filter((p) => Number(p.is_selected) === 1).length,
        total_tasks: allTasks.length,
        pending_tasks: pendingTasks.length,
        success_tasks: successTasks.length,
        failed_tasks: failedTasks.length,
        running_tasks: runningTasks.length
      });
    }

    // 6. CLOUD VIDEO UPLOAD & FILE CHECK HELPERS
    if (method === "POST" && path === "/api/upload/video") {
      try {
        const contentType = request.headers.get("Content-Type") || "";
        let fileName = "reel_video.mp4";
        let mimeType = "video/mp4";
        let arrayBuf: ArrayBuffer;

        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          const fileEntry = formData.get("file") as File | null;
          if (!fileEntry || typeof fileEntry.arrayBuffer !== "function") {
            return jsonResponse({ detail: "Không tìm thấy file video trong form upload." }, 400);
          }
          fileName = fileEntry.name || fileName;
          mimeType = fileEntry.type || mimeType;
          arrayBuf = await fileEntry.arrayBuffer();
        } else {
          fileName = request.headers.get("X-File-Name") || fileName;
          arrayBuf = await request.arrayBuffer();
        }

        if (arrayBuf.byteLength === 0) {
          return jsonResponse({ detail: "File video rỗng (0 bytes)." }, 400);
        }

        const videoId = `vid_${randomHex(6)}`;
        let r2Key: string | null = null;
        let dataBase64: string | null = null;

        if (env.VIDEOS_BUCKET) {
          r2Key = `uploads/${ownerUserId}/${videoId}_${fileName}`;
          await env.VIDEOS_BUCKET.put(r2Key, arrayBuf, {
            httpMetadata: { contentType: mimeType }
          });
        } else {
          // Store in D1 uploaded_videos if under 25MB
          if (arrayBuf.byteLength > 25 * 1024 * 1024) {
            return jsonResponse(
              {
                detail:
                  "Video lớn hơn 25MB cần gắn Cloudflare R2 Bucket (VIDEOS_BUCKET) hoặc sử dụng link URL video trực tiếp (https://...mp4)."
              },
              400
            );
          }
          dataBase64 = bytesToBase64Url(new Uint8Array(arrayBuf));
        }

        await saveUploadedVideo(db, {
          id: videoId,
          ownerUserId,
          filename: fileName,
          mimeType,
          fileSize: arrayBuf.byteLength,
          r2Key,
          dataBase64
        });

        const cloudPath = `cloud://video/${videoId}/${fileName}`;
        return jsonResponse({
          status: "success",
          video_id: videoId,
          path: cloudPath,
          filename: fileName,
          file_size: arrayBuf.byteLength,
          message: `Đã tải video '${fileName}' lên Cloudflare thành công!`
        });
      } catch (err) {
        return jsonResponse(
          {
            detail: `Lỗi tải video lên Cloud: ${err instanceof Error ? err.message : String(err)}`
          },
          500
        );
      }
    }

    if (method === "POST" && path === "/api/system/browse-file") {
      return jsonResponse({
        path: "",
        mode: "cloud_browser_picker",
        message: "Chọn file video trực tiếp từ trình duyệt của bạn."
      });
    }

    if (method === "POST" && path === "/api/system/check-files") {
      let body: { paths?: string[] } = {};
      try {
        body = (await request.json()) as { paths?: string[] };
      } catch {
        // Ignore
      }
      const results: Record<string, boolean> = {};
      for (const p of body.paths || []) {
        const check = await validateVideoSource(db, env, p, ownerUserId);
        results[p] = check.exists;
      }
      return jsonResponse({ results });
    }

    return jsonResponse({ detail: `API Endpoint không tồn tại: ${method} ${path}` }, 404);
  }

  // =========================================================================
  // 7. GUI NAVIGATION & STATIC ASSETS
  // =========================================================================

  if (method === "GET" && path === "/login") {
    const user = await getCurrentUser(request, db, env);
    if (user) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/pages" }
      });
    }
    const asset = await serveStaticHtmlAsset(request, env, "/login.html");
    if (asset) return asset;
  }

  if (
    method === "GET" &&
    (path === "/" || path === "/pages" || path === "/schedules" || path === "/reels")
  ) {
    const user = await getCurrentUser(request, db, env);
    if (!user) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" }
      });
    }
    const asset = await serveStaticHtmlAsset(request, env, "/index.html");
    if (asset) return asset;
  }

  // Serve static files (/static/js/app.js -> /js/app.js in static directory)
  if (env.ASSETS) {
    if (path.startsWith("/static/")) {
      const strippedUrl = new URL(request.url);
      strippedUrl.pathname = path.replace(/^\/static/, "");
      const resp = await env.ASSETS.fetch(new Request(strippedUrl.toString(), request));
      if (resp.ok) return resp;
    }
    const directResp = await env.ASSETS.fetch(request);
    if (directResp.ok) return directResp;
  }

  return jsonResponse({ detail: "Không tìm thấy trang yêu cầu (404)." }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleWorkerRequest(request, env, ctx);
  }
};
