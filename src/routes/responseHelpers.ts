/**
 * Shared HTTP Response & Static Asset Helpers for Cloudflare Workers
 */

import type { Env } from "../types.ts";
import { escapeHtml } from "../utils/sanitize.ts";

export function jsonResponse(
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

export function htmlResponse(
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

export async function serveStaticHtmlAsset(
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

export function renderOAuthCallbackHtml(options: {
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

  const quickTokenConnectHtml = options.success
    ? ""
    : `
    <div class="mt-5 pt-5 border-t border-slate-800 text-left space-y-3">
      <div class="text-xs font-bold text-emerald-400">
        ⚡ Kết nối trực tiếp không cần OAuth Callback (Dán Access Token / URL / JSON Graph API Explorer):
      </div>
      <textarea id="quick-token-input" rows="4"
        placeholder="Dán chuỗi Access Token (EAA...), URL Graph API Explorer hoặc JSON /me/accounts vào đây..."
        class="w-full bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-xl p-3 text-xs text-white font-mono focus:outline-none"></textarea>
      <div id="quick-token-msg" class="text-xs hidden"></div>
      <button id="quick-token-btn" onclick="submitQuickToken()"
        class="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow-lg">
        ⚡ Kết Nối &amp; Đồng Bộ Fanpage Ngay
      </button>
    </div>
    <script>
      // Tự động bắt access_token nếu Facebook trả về trong URL hash (#access_token=...)
      (function() {
        if (window.location.hash && window.location.hash.includes('access_token=')) {
          var input = document.getElementById('quick-token-input');
          if (input) {
            input.value = window.location.hash.substring(1);
            submitQuickToken();
          }
        }
      })();
      async function submitQuickToken() {
        var input = document.getElementById('quick-token-input');
        var btn = document.getElementById('quick-token-btn');
        var msg = document.getElementById('quick-token-msg');
        var val = (input ? input.value : '').trim();
        if (!val) {
          msg.className = 'text-xs text-rose-400 font-semibold';
          msg.textContent = 'Vui lòng dán Access Token, URL hoặc JSON từ Graph API Explorer.';
          return;
        }
        btn.disabled = true;
        btn.textContent = '⏳ Đang xác thực và đồng bộ Fanpage...';
        msg.className = 'text-xs text-slate-300';
        msg.textContent = 'Đang xử lý...';
        try {
          var res = await fetch('/api/meta/connect-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: val })
          });
          var data = await res.json();
          if (res.ok && data.success) {
            msg.className = 'text-xs text-emerald-400 font-bold';
            msg.textContent = data.message || 'Kết nối thành công! Đang chuyển hướng...';
            setTimeout(function() { window.location.href = '/pages'; }, 1000);
          } else {
            msg.className = 'text-xs text-rose-400 font-semibold';
            msg.textContent = data.detail || data.message || 'Kết nối thất bại.';
            btn.disabled = false;
            btn.textContent = '⚡ Kết Nối & Đồng Bộ Fanpage Ngay';
          }
        } catch (e) {
          msg.className = 'text-xs text-rose-400 font-semibold';
          msg.textContent = 'Lỗi kết nối: ' + e.message;
          btn.disabled = false;
          btn.textContent = '⚡ Kết Nối & Đồng Bộ Fanpage Ngay';
        }
      }
    </script>`;

  return htmlResponse(
    `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)} - Quản lý fanpage</title>
  ${metaRefresh}
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center shadow-2xl">
    <div class="w-12 h-12 rounded-full ${badgeClass} flex items-center justify-center mx-auto mb-4 text-2xl font-bold">${icon}</div>
    <h1 class="text-lg font-bold text-white mb-1">${escapeHtml(options.title)}</h1>
    ${options.subtitle ? `<p class="text-xs text-emerald-400 font-semibold mb-2">${escapeHtml(options.subtitle)}</p>` : ""}
    <p class="text-xs text-slate-400 mb-5">${escapeHtml(options.message)}</p>
    <a href="/pages" class="inline-block px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition">Quay về Bảng Điều Khiển</a>
    ${quickTokenConnectHtml}
  </div>
</body>
</html>`,
    options.success ? 200 : 400
  );
}

