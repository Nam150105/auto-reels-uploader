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
import { parseVnScheduleToUtc } from "./utils/timezone.ts";
import {
  ensureDatabaseInitialized,
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
  getMediaFileById,
  getTasks,
  getTask,
  addTask,
  updateTask,
  addTasksBulk,
  deleteTask,
  resetTask,
  resetRunningTasks,
  getTaskLogs,
  getTaskAttempts
} from "./db.ts";
import {
  PRODUCTION_DOMAIN,
  generateOAuthUrl,
  exchangeCodeForToken,
  getConnectionStatus
} from "./services/metaOAuthService.ts";
import {
  syncPagesForAccount,
  syncPagesFromMeta,
  checkPagePermissionOnMeta,
  validateVideoSource,
  runDiagnosticTest
} from "./services/metaGraphService.ts";
import { deleteUserVideo, getR2Bucket } from "./services/r2MediaService.ts";
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
  handleNativeQueueBatch
} from "./queue/publishQueue.ts";
import { dispatchDueScheduledTasks } from "./scheduler/cronDispatcher.ts";
import {
  jsonResponse,
  serveStaticHtmlAsset,
  renderOAuthCallbackHtml
} from "./routes/responseHelpers.ts";
import { handleComplianceRoutes } from "./routes/complianceRoutes.ts";
import { handleMediaRoutes } from "./routes/mediaRoutes.ts";
import { getD1Database } from "./fallback_d1.ts";

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

  const encryptionKey = getEncryptionKeyMaterial(env);
  const db = getD1Database(env);
  await ensureDatabaseInitialized(db, encryptionKey);

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
  // 3. ĐIỀU HƯỚNG GIAO DIỆN HTML FRONTEND (/, /login, /pages, /schedules)
  // ==========================================
  if (pathname === "/login" && method === "GET") {
    if (currentUser) {
      return Response.redirect(`${url.origin}/pages`, 302);
    }
    const staticResp = await serveStaticHtmlAsset(request, env, "/login.html");
    if (staticResp) return staticResp;
  }

  if (
    (pathname === "/" || pathname === "/pages" || pathname === "/schedules") &&
    method === "GET"
  ) {
    if (!currentUser) {
      return Response.redirect(`${url.origin}/login`, 302);
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
    const errorDesc = url.searchParams.get("error_description");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error) {
      return renderOAuthCallbackHtml({
        success: false,
        title: "Kết Nối Facebook Bị Từ Chối",
        message: errorDesc || error
      });
    }

    if (!code || !state) {
      return renderOAuthCallbackHtml({
        success: false,
        title: "Thiếu Tham Số Xác Thực OAuth",
        message: "Yêu cầu callback không hợp lệ (thiếu code hoặc state)."
      });
    }

    const res = await exchangeCodeForToken(
      db,
      env,
      code,
      state,
      currentUser?.id || null
    );
    if (!res.success) {
      return renderOAuthCallbackHtml({
        success: false,
        title: "Lỗi Xác Thực Meta OAuth",
        message: res.message || "Không thể trao đổi Access Token với Facebook."
      });
    }

    const effectiveUserId = res.owner_user_id || currentUser?.id || "usr_admin";
    let syncRes: { synced_count?: number } = { synced_count: 0 };
    if (res.account_id) {
      syncRes = await syncPagesForAccount(db, env, res.account_id, effectiveUserId);
    } else {
      syncRes = await syncPagesFromMeta(db, env, effectiveUserId);
    }

    return renderOAuthCallbackHtml({
      success: true,
      title: "Kết Nối Tài Khoản Facebook Thành Công!",
      subtitle: `${res.user_name || ""} (ID: ${res.user_id || ""})`,
      message: `Đã tự động đồng bộ ${syncRes.synced_count || 0} Fanpage từ Meta Graph API. Đang chuyển về trang Quản Lý Fanpage...`
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
      const reconnectId = url.searchParams.get("reconnect_account_id");
      const res = await generateOAuthUrl(
        db,
        env,
        ownerUserId,
        reconnectId || null
      );
      if (!res.success) {
        return jsonResponse({ detail: res.message }, 400);
      }
      return jsonResponse(res);
    }

    if (pathname === "/api/meta/login" && method === "GET") {
      const reconnectId = url.searchParams.get("reconnect_account_id");
      const res = await generateOAuthUrl(
        db,
        env,
        ownerUserId,
        reconnectId || null
      );
      if (!res.success || !res.oauth_url) {
        return jsonResponse({ detail: res.message || "Lỗi khởi tạo OAuth" }, 400);
      }
      return Response.redirect(res.oauth_url, 302);
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
        message: "Đã ngắt kết nối toàn bộ tài khoản Facebook Admin của bạn."
      });
    }

    const syncAccMatch = /^\/api\/meta\/accounts\/([^/]+)\/sync$/.exec(pathname);
    if (syncAccMatch && method === "POST") {
      const accountId = decodeURIComponent(syncAccMatch[1]);
      const res = await syncPagesForAccount(db, env, accountId, ownerUserId);
      if (!res.success) {
        return jsonResponse({ detail: res.message }, 400);
      }
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        ownerUserId
      });
      return jsonResponse({ ...res, pages });
    }

    const reconnectAccMatch = /^\/api\/meta\/accounts\/([^/]+)\/reconnect$/.exec(pathname);
    if (reconnectAccMatch && method === "POST") {
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
          { detail: "Không tìm thấy tài khoản Facebook Admin thuộc quyền sở hữu của bạn." },
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
        message: "Đã ngắt kết nối tài khoản Facebook Admin."
      });
    }

    const deleteAccMatch = /^\/api\/meta\/accounts\/([^/]+)$/.exec(pathname);
    if (deleteAccMatch && method === "DELETE") {
      const accountId = decodeURIComponent(deleteAccMatch[1]);
      const ok = await deleteFacebookAccountLocal(db, accountId, ownerUserId);
      if (!ok) {
        return jsonResponse(
          { detail: "Không tìm thấy tài khoản hoặc không có quyền xóa." },
          404
        );
      }
      return jsonResponse({
        success: true,
        message: "Đã xóa tài khoản Facebook Admin khỏi danh sách."
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
      const accountIdsRaw = url.searchParams.get("account_ids") || "";
      const accountIds = accountIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const tasks = await getTasks(db, {
        facebookPageId,
        status,
        search,
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

      // Kiểm tra hợp lệ lịch hẹn (nếu có nhập)
      if (body.schedule_date || body.schedule_time) {
        const schedCheck = parseVnScheduleToUtc(body.schedule_date, body.schedule_time);
        if (!schedCheck.isValid) {
          return jsonResponse({ detail: schedCheck.error }, 400);
        }
      }

      // Tự động phân giải media_id & object_key nếu video_path là r2://<media_id>
      let mediaId = body.media_id || null;
      let objectKey = body.object_key || null;
      if (vPath.startsWith("r2://") || vPath.startsWith("d1://video/") || vPath.startsWith("med_")) {
        const cleanMediaId = vPath.replace(/^r2:\/\//, "").replace(/^d1:\/\/video\//, "");
        const mediaRecord = await getMediaFileById(db, cleanMediaId, ownerUserId);
        if (!mediaRecord) {
          return jsonResponse(
            { detail: "Video R2 không tồn tại hoặc không thuộc quyền sở hữu của bạn." },
            403
          );
        }
        mediaId = mediaRecord.id;
        objectKey = mediaRecord.object_key;
      }

      const taskId = await addTask(db, {
        videoPath: vPath,
        caption: body.caption || "",
        commentText: body.comment_text || "",
        scheduleDate: body.schedule_date || "",
        scheduleTime: body.schedule_time || "",
        facebookPageId: targetPageId,
        profileId: body.profile_id || targetPageId,
        mediaId,
        objectKey,
        ownerUserId
      });

      const created = await getTask(db, taskId, ownerUserId);
      return jsonResponse({ success: true, id: taskId, task: created });
    }

    if (pathname === "/api/tasks/bulk" && method === "POST") {
      const body = (await request.json()) as {
        tasks?: Array<{
          video_path: string;
          caption?: string;
          comment_text?: string;
          schedule_date?: string;
          schedule_time?: string;
          facebook_page_id?: string;
          media_id?: string;
          object_key?: string;
        }>;
        assign_page_ids?: string[];
        assign_profile_ids?: string[];
      };

      const tasksList = body.tasks || [];
      if (tasksList.length === 0) {
        return jsonResponse({ detail: "Danh sách tác vụ trống." }, 400);
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

      const inserted = await addTasksBulk(db, tasksList, assignIds, ownerUserId);
      return jsonResponse({
        success: true,
        inserted_count: inserted.length,
        task_ids: inserted
      });
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
      const ok = await resetTask(db, taskId, ownerUserId);
      if (!ok) {
        return jsonResponse({ detail: "Không tìm thấy tác vụ thuộc quyền sở hữu của bạn." }, 404);
      }
      return jsonResponse({ success: true, id: taskId });
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
      };
      const pageId =
        body.facebook_page_id !== undefined ? body.facebook_page_id : body.profile_id;
      const ok = await updateTask(db, taskId, {
        facebookPageId: pageId,
        videoPath: body.video_path,
        caption: body.caption,
        commentText: body.comment_text,
        scheduleDate: body.schedule_date,
        scheduleTime: body.schedule_time,
        ownerUserId
      });
      if (!ok) {
        return jsonResponse({ detail: "Không tìm thấy tác vụ thuộc quyền sở hữu của bạn." }, 404);
      }
      const updated = await getTask(db, taskId, ownerUserId);
      return jsonResponse({ success: true, task: updated });
    }

    if (taskItemMatch && method === "DELETE") {
      const taskId = parseInt(taskItemMatch[1], 10);
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
      const enqueueRes = await enqueueUserPendingTasks(db, env, ctx, ownerUserId);
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

    if (pathname === "/api/status" && method === "GET") {
      const pages = await getFacebookPages(db, encryptionKey, {
        includeToken: false,
        ownerUserId
      });
      const tasks = await getTasks(db, { ownerUserId });
      const metaStatus = await getConnectionStatus(db, env, ownerUserId);

      const runningCount = tasks.filter(
        (t) =>
          t.status === "running" ||
          t.raw_status === "queued" ||
          t.raw_status === "processing"
      ).length;

      return jsonResponse({
        is_running: runningCount > 0,
        active_tasks_count: runningCount,
        meta_connected: Boolean(metaStatus.is_connected),
        meta_user_name: metaStatus.user_name,
        connected_accounts_count: metaStatus.connected_accounts || 0,
        total_accounts_count: metaStatus.total_accounts || 0,
        total_pages: pages.length,
        selected_pages: pages.filter((p) => p.is_selected).length,
        total_profiles: pages.length,
        selected_profiles: pages.filter((p) => p.is_selected).length,
        total_tasks: tasks.length,
        pending_tasks: tasks.filter((t) => t.status === "pending").length,
        success_tasks: tasks.filter((t) => t.status === "success").length,
        failed_tasks: tasks.filter((t) => t.status === "failed").length,
        running_tasks: runningCount
      });
    }

    return jsonResponse({ detail: `API endpoint not found: ${pathname}` }, 404);
  }

  // ==========================================
  // 7. PHỤC VỤ FILE TĨNH (/static/*, /js/*, ...)
  // ==========================================
  if (env.ASSETS) {
    if (pathname.startsWith("/static/")) {
      const strippedUrl = new URL(request.url);
      strippedUrl.pathname = pathname.replace(/^\/static/, "");
      const strippedReq = new Request(strippedUrl.toString(), request);
      const assetResp = await env.ASSETS.fetch(strippedReq);
      if (assetResp.ok) return assetResp;
    }
    const directResp = await env.ASSETS.fetch(request);
    if (directResp.ok) return directResp;
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
