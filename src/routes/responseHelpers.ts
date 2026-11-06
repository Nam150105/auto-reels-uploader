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
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center shadow-2xl">
    <div class="w-12 h-12 rounded-full ${badgeClass} flex items-center justify-center mx-auto mb-4 text-2xl font-bold">${icon}</div>
    <h1 class="text-lg font-bold text-white mb-1">${escapeHtml(options.title)}</h1>
    ${options.subtitle ? `<p class="text-xs text-emerald-400 font-semibold mb-2">${escapeHtml(options.subtitle)}</p>` : ""}
    <p class="text-xs text-slate-400 mb-5">${escapeHtml(options.message)}</p>
    <a href="/pages" class="inline-block px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition">Quay về Bảng Điều Khiển</a>
  </div>
</body>
</html>`,
    options.success ? 200 : 400
  );
}

