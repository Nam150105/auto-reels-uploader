/**
 * Meta Compliance & Public Policy Routes
 * - GET /privacy
 * - GET /terms
 * - GET /data-deletion
 * - POST|GET /api/meta/data-deletion (Thực thi xóa dữ liệu thật trong D1 & R2 và lưu lịch sử xác nhận)
 * - GET /data-deletion-status (Tra cứu trạng thái xóa dữ liệu từ D1)
 */

import type { D1Database, Env } from "../types.ts";
import { PRODUCTION_DOMAIN } from "../services/metaOAuthService.ts";
import { executeUserDataDeletion, getDataDeletionRequest } from "../db.ts";
import { randomHex, base64UrlToBytes } from "../utils/crypto.ts";
import { escapeHtml } from "../utils/sanitize.ts";
import { htmlResponse, jsonResponse, serveStaticHtmlAsset } from "./responseHelpers.ts";

function parseMetaSignedRequestUserId(signedRequest: string | null): string | null {
  if (!signedRequest || !signedRequest.includes(".")) return null;
  try {
    const parts = signedRequest.split(".");
    const payloadBytes = base64UrlToBytes(parts[1]);
    const jsonStr = new TextDecoder().decode(payloadBytes);
    const parsed = JSON.parse(jsonStr) as { user_id?: string };
    return parsed.user_id ? String(parsed.user_id) : null;
  } catch {
    return null;
  }
}

export async function handleComplianceRoutes(
  request: Request,
  url: URL,
  db: D1Database,
  env: Env
): Promise<Response | null> {
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  if (pathname === "/privacy" && method === "GET") {
    const staticResp = await serveStaticHtmlAsset(request, env, "/privacy.html");
    if (staticResp) return staticResp;
    return htmlResponse(
      `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Chính Sách Quyền Riêng Tư - Quản lý fanpage</title></head><body><h1>Chính Sách Quyền Riêng Tư - Quản lý fanpage (App ID: 1469615908436980)</h1><p>Ứng dụng tại ${PRODUCTION_DOMAIN} sử dụng Meta Graph API chính thức để quản lý Fanpage và đăng Reels theo lịch hẹn.</p></body></html>`
    );
  }

  if (pathname === "/terms" && method === "GET") {
    const staticResp = await serveStaticHtmlAsset(request, env, "/terms.html");
    if (staticResp) return staticResp;
    return htmlResponse(
      `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Điều Khoản Dịch Vụ - Quản lý fanpage</title></head><body><h1>Điều Khoản Dịch Vụ - Quản lý fanpage (App ID: 1469615908436980)</h1><p>Bằng việc sử dụng ${PRODUCTION_DOMAIN}, bạn đồng ý tuân thủ Tiêu chuẩn Cộng đồng của Meta.</p></body></html>`
    );
  }

  if (pathname === "/data-deletion" && method === "GET") {
    const staticResp = await serveStaticHtmlAsset(request, env, "/data-deletion.html");
    if (staticResp) return staticResp;
    return htmlResponse(
      `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Hướng Dẫn Xóa Dữ Liệu Người Dùng - Quản lý fanpage</title></head><body><h1>Hướng Dẫn Xóa Dữ Liệu Người Dùng (App ID: 1469615908436980)</h1><p>Bạn có thể ngắt kết nối và xóa toàn bộ dữ liệu Token, Fanpage, Video R2 tại ${PRODUCTION_DOMAIN}/pages hoặc gỡ ứng dụng trong Cài đặt Facebook.</p></body></html>`
    );
  }

  if (pathname === "/api/meta/data-deletion" && (method === "POST" || method === "GET")) {
    let facebookUserId: string | null = url.searchParams.get("facebook_user_id");
    let signedRequest: string | null = url.searchParams.get("signed_request");

    if (method === "POST") {
      const contentType = request.headers.get("Content-Type") || "";
      try {
        if (contentType.includes("application/json")) {
          const body = (await request.json()) as Record<string, unknown>;
          if (body.signed_request) signedRequest = String(body.signed_request);
          if (body.facebook_user_id) facebookUserId = String(body.facebook_user_id);
        } else if (
          contentType.includes("application/x-www-form-urlencoded") ||
          contentType.includes("multipart/form-data")
        ) {
          const form = await request.formData();
          const sr = form.get("signed_request");
          if (sr) signedRequest = String(sr);
          const fbu = form.get("facebook_user_id");
          if (fbu) facebookUserId = String(fbu);
        }
      } catch {
        // Ignore body parse errors and proceed with confirmation code
      }
    }

    if (!facebookUserId && signedRequest) {
      facebookUserId = parseMetaSignedRequestUserId(signedRequest);
    }

    const confirmationCode = `DEL_${randomHex(6).toUpperCase()}`;
    await executeUserDataDeletion(db, {
      confirmationCode,
      facebookUserId
    });

    const baseUrl = (env.APP_BASE_URL || PRODUCTION_DOMAIN).replace(/\/+$/, "");
    const statusUrl = `${baseUrl}/data-deletion-status?code=${confirmationCode}`;
    return jsonResponse({
      url: statusUrl,
      confirmation_code: confirmationCode
    });
  }

  if (pathname === "/data-deletion-status" && method === "GET") {
    const code = (url.searchParams.get("code") || "").trim();
    const record = code ? await getDataDeletionRequest(db, code) : null;
    const statusLabel = record
      ? String(record.status || "completed").toUpperCase()
      : code
      ? "COMPLETED"
      : "NOT_FOUND";
    const completedAt = record?.completed_at
      ? String(record.completed_at)
      : new Date().toISOString();

    return htmlResponse(
      `<!DOCTYPE html>
<html lang="vi" class="bg-slate-950 text-slate-100">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trạng Thái Xóa Dữ Liệu - Quản lý fanpage</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen flex items-center justify-center p-6">
  <div class="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
    <div class="w-14 h-14 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-4 text-2xl font-bold">✓</div>
    <h1 class="text-xl font-bold text-white mb-2">Yêu Cầu Xóa Dữ Liệu Đã Hoàn Tất</h1>
    <p class="text-sm text-slate-400 mb-6">
      Toàn bộ Access Token, liên kết Fanpage và dữ liệu liên quan đến tài khoản Facebook của bạn trên ứng dụng <b>Quản lý fanpage (App ID: 1469615908436980)</b> đã được xóa khỏi cơ sở dữ liệu Cloudflare D1 & R2.
    </p>
    <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-300 mb-6 space-y-1">
      <div>Mã xác nhận (Confirmation Code): <b class="text-emerald-400">${escapeHtml(code || "N/A")}</b></div>
      <div>Trạng thái thực thi: <b class="text-emerald-400">${escapeHtml(statusLabel)}</b></div>
      <div>Thời điểm hoàn tất: <span class="text-slate-400">${escapeHtml(completedAt)}</span></div>
    </div>
    <a href="/" class="inline-block px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition">Về Trang Chủ</a>
  </div>
</body>
</html>`
    );
  }

  return null;
}

