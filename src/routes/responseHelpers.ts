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
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...extraHeaders
    }
  });
}

export function redirectResponse(
  targetUrl: string,
  status = 302,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(null, {
    status,
    headers: {
      Location: targetUrl,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
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
  url.search = "";
  const cleanHeaders = new Headers({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  });
  const assetReq = new Request(url.toString(), {
    method: "GET",
    headers: cleanHeaders
  });
  let resp = await env.ASSETS.fetch(assetReq);
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("Location");
    if (loc) {
      const followUrl = new URL(loc, url.origin);
      resp = await env.ASSETS.fetch(
        new Request(followUrl.toString(), { method: "GET", headers: cleanHeaders })
      );
    }
  }
  if (resp.ok) {
    return new Response(resp.body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache"
      }
    });
  }
  return null;
}

export function renderOAuthCallbackHtml(options: {
  success: boolean;
  statusCode?: number;
  oauthStatus?:
    | "success"
    | "denied"
    | "no_pages"
    | "missing_permissions"
    | "invalid_token"
    | "error"
    | "ready";
  isEndpointReadyProbe?: boolean;
  title: string;
  subtitle?: string;
  message: string;
  syncedCount?: number;
  accountId?: string;
}): Response {
  const statusCode =
    typeof options.statusCode === "number"
      ? options.statusCode
      : options.success
        ? 200
        : 400;
  const oauthStatus =
    options.oauthStatus || (options.success ? "success" : "error");
  const isWarning = oauthStatus === "no_pages" || oauthStatus === "denied";
  const badgeClass =
    options.success || options.isEndpointReadyProbe
      ? "bg-emerald-500/20 text-emerald-400"
      : isWarning
        ? "bg-amber-500/20 text-amber-400"
        : "bg-rose-500/20 text-rose-400";
  const icon =
    options.success || options.isEndpointReadyProbe
      ? "✓"
      : isWarning
        ? "!"
        : "✕";

  const ogTitle = options.isEndpointReadyProbe
    ? "Quản lý fanpage - Kết nối Facebook"
    : `${options.title} - Quản lý fanpage`;
  const ogDesc = options.isEndpointReadyProbe
    ? "Hệ thống quản lý Fanpage và lên lịch đăng Reels tự động."
    : options.message;

  const redirectTarget = options.isEndpointReadyProbe
    ? "/page"
    : `/page?oauth_status=${encodeURIComponent(oauthStatus)}&oauth_msg=${encodeURIComponent(options.message)}`;

  const payloadJson = JSON.stringify({
    type: "META_OAUTH_RESULT",
    success: options.success,
    status: oauthStatus,
    title: options.title,
    message: options.message,
    synced_count: options.syncedCount ?? 0,
    account_id: options.accountId || null
  }).replace(/</g, "\\u003c");

  const popupAndRedirectScript = options.isEndpointReadyProbe
    ? ""
    : `<script>
(function() {
  var payload = ${payloadJson};
  var redirectUrl = ${JSON.stringify(redirectTarget)};
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage(payload, window.location.origin);
      setTimeout(function() { window.close(); }, 350);
      return;
    } catch (e) {}
  }
  setTimeout(function() {
    window.location.replace(redirectUrl);
  }, 1500);
})();
</script>`;

  return htmlResponse(
    `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(ogTitle)}</title>
  <meta property="fb:app_id" content="1469615908436980" />
  <meta property="og:url" content="https://pagefb.namnangno.click/api/meta/callback" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Quản lý fanpage" />
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(ogDesc)}" />
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center shadow-2xl">
    <div class="w-12 h-12 rounded-full ${badgeClass} flex items-center justify-center mx-auto mb-4 text-2xl font-bold">${icon}</div>
    <h1 class="text-lg font-bold text-white mb-1">${escapeHtml(options.title)}</h1>
    ${options.subtitle ? `<p class="text-xs text-emerald-400 font-semibold mb-2">${escapeHtml(options.subtitle)}</p>` : ""}
    <p class="text-xs text-slate-300 mb-5">${escapeHtml(options.message)}</p>
    <a href="${escapeHtml(redirectTarget)}" class="inline-block px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition">Quay về trang Quản lý</a>
  </div>
  ${popupAndRedirectScript}
</body>
</html>`,
    statusCode
  );
}
