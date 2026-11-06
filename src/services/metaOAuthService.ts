/**
 * Meta Facebook OAuth 2.0 Service (Cloudflare Workers + D1)
 * - Authorization Code Flow chuẩn Meta Graph API
 * - Lưu CSRF State trong D1 (`oauth_states`), chỉ sử dụng 1 lần (One-Time Use)
 * - Hỗ trợ nhiều người dùng thực hiện OAuth đồng thời
 * - Nâng cấp Long-Lived User Access Token (~60 ngày) và kiểm tra quyền (/me/permissions)
 */

import type { D1Database, Env, FacebookAccountRecord } from "../types.ts";
import { randomHex, getEncryptionKeyMaterial } from "../utils/crypto.ts";
import { sanitizeSensitiveText } from "../utils/sanitize.ts";
import {
  createOAuthState,
  consumeOAuthState,
  saveFacebookAccount,
  getFacebookAccounts
} from "../db.ts";

export const PRODUCTION_DOMAIN = "https://pagefb.namnangno.click";
export const DEFAULT_META_APP_ID = "1469615908436980";
export const DEFAULT_GRAPH_VERSION = "v19.0";

export const REQUIRED_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_read_user_content"
];

export function getMetaConfig(env: Env) {
  const appId = (env.META_APP_ID || DEFAULT_META_APP_ID).trim();
  const appSecret = (env.META_APP_SECRET || "").trim();
  const baseUrl = (env.APP_BASE_URL || PRODUCTION_DOMAIN).trim().replace(/\/+$/, "");
  const redirectUri = (
    env.META_REDIRECT_URI || `${baseUrl}/api/meta/callback`
  ).trim();
  const graphVersion = (env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).trim();
  const encryptionKey = getEncryptionKeyMaterial(env);

  return {
    appId,
    appSecret,
    baseUrl,
    redirectUri,
    graphVersion,
    graphBase: `https://graph.facebook.com/${graphVersion}`,
    oauthDialogUrl: `https://www.facebook.com/${graphVersion}/dialog/oauth`,
    encryptionKey
  };
}

export async function generateOAuthUrl(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  reconnectAccountId: string | null = null,
  actionType = "connect",
  customRedirectUri: string | null = null
): Promise<{
  success: boolean;
  oauth_url?: string;
  state?: string;
  redirect_uri?: string;
  app_id?: string;
  scopes?: string[];
  message?: string;
}> {
  const cfg = getMetaConfig(env);
  if (!cfg.appId || !cfg.appSecret) {
    return {
      success: false,
      message:
        "Thiếu cấu hình META_APP_ID hoặc META_APP_SECRET trên Cloudflare Worker Secrets. Vui lòng chạy `npx wrangler secret put META_APP_SECRET` hoặc dùng Cách 1: Dán trực tiếp Access Token."
    };
  }

  let effectiveRedirectUri = cfg.redirectUri;
  if (customRedirectUri && /^https?:\/\/[^/\s]+\/api\/meta\/callback$/i.test(customRedirectUri.trim())) {
    effectiveRedirectUri = customRedirectUri.trim();
  }

  const state = randomHex(24);
  await createOAuthState(
    db,
    state,
    ownerUserId,
    reconnectAccountId,
    reconnectAccountId ? "reconnect" : actionType,
    effectiveRedirectUri,
    600
  );

  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: effectiveRedirectUri,
    state,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(","),
    auth_type: "rerequest"
  });

  return {
    success: true,
    oauth_url: `${cfg.oauthDialogUrl}?${params.toString()}`,
    state,
    redirect_uri: effectiveRedirectUri,
    app_id: cfg.appId,
    scopes: REQUIRED_SCOPES
  };
}

export async function exchangeCodeForToken(
  db: D1Database,
  env: Env,
  code: string,
  state: string,
  fallbackOwnerUserId: string | null = null
): Promise<{
  success: boolean;
  account_id?: string;
  owner_user_id?: string;
  user_id?: string;
  user_name?: string;
  token_expires_at?: string | null;
  scopes?: string[];
  missing_scopes?: string[];
  message?: string;
}> {
  const stateCheck = await consumeOAuthState(db, state);
  if (!stateCheck.valid) {
    return { success: false, message: stateCheck.message };
  }

  const ownerUserId = stateCheck.owner_user_id || fallbackOwnerUserId;
  if (!ownerUserId) {
    return {
      success: false,
      message: "Không xác định được phiên người dùng thực hiện kết nối OAuth."
    };
  }

  const cfg = getMetaConfig(env);
  if (!cfg.appId || !cfg.appSecret) {
    return {
      success: false,
      message: "Thiếu META_APP_ID hoặc META_APP_SECRET trên Cloudflare Worker."
    };
  }

  const effectiveRedirectUri =
    stateCheck.redirect_after && /^https?:\/\//i.test(stateCheck.redirect_after)
      ? stateCheck.redirect_after
      : cfg.redirectUri;

  try {
    // Bước 1: Đổi code lấy Short-Lived User Access Token
    const tokenParams = new URLSearchParams({
      client_id: cfg.appId,
      redirect_uri: effectiveRedirectUri,
      client_secret: cfg.appSecret,
      code
    });

    const tokenResp = await fetch(
      `${cfg.graphBase}/oauth/access_token?${tokenParams.toString()}`
    );
    const tokenData = (await tokenResp.json()) as Record<string, unknown>;

    if (!tokenResp.ok || tokenData.error) {
      const errObj = (tokenData.error || {}) as Record<string, unknown>;
      return {
        success: false,
        message: sanitizeSensitiveText(
          `Lỗi đổi mã OAuth code: ${errObj.message || tokenResp.statusText}`
        )
      };
    }

    const shortToken = String(tokenData.access_token || "");
    if (!shortToken) {
      return {
        success: false,
        message: "Meta không trả về access_token hợp lệ."
      };
    }

    // Bước 2: Đổi sang Long-Lived User Access Token (~60 ngày)
    let finalToken = shortToken;
    let expiresIn = Number(tokenData.expires_in || 0);

    const llParams = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: shortToken
    });

    const llResp = await fetch(`${cfg.graphBase}/oauth/access_token?${llParams.toString()}`);
    if (llResp.ok) {
      const llData = (await llResp.json()) as Record<string, unknown>;
      if (llData.access_token) {
        finalToken = String(llData.access_token);
        expiresIn = Number(llData.expires_in || expiresIn || 60 * 86400);
      }
    }

    // Bước 3: Lấy thông tin cá nhân Facebook (/me)
    const meResp = await fetch(
      `${cfg.graphBase}/me?fields=id,name,email&access_token=${encodeURIComponent(finalToken)}`
    );
    const meData = (await meResp.json()) as Record<string, unknown>;
    if (!meResp.ok || !meData.id) {
      const errObj = (meData.error || {}) as Record<string, unknown>;
      return {
        success: false,
        message: sanitizeSensitiveText(
          `Không thể lấy thông tin người dùng Facebook (/me): ${errObj.message || "Lỗi Graph API"}`
        )
      };
    }

    const fbUserId = String(meData.id);
    const fbUserName = String(meData.name || "Facebook Admin");
    const fbUserEmail = meData.email ? String(meData.email) : null;

    // Bước 4: Kiểm tra danh sách quyền đã cấp (/me/permissions)
    const grantedScopes: string[] = [];
    const permResp = await fetch(
      `${cfg.graphBase}/me/permissions?access_token=${encodeURIComponent(finalToken)}`
    );
    if (permResp.ok) {
      const permData = (await permResp.json()) as {
        data?: Array<{ permission: string; status: string }>;
      };
      for (const item of permData.data || []) {
        if (item.status === "granted") {
          grantedScopes.push(item.permission);
        }
      }
    }

    const missingScopes = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s));
    const expiresAtIso =
      expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : new Date(Date.now() + 60 * 86400 * 1000).toISOString();

    const accountId = await saveFacebookAccount(db, cfg.encryptionKey, {
      facebookUserId: fbUserId,
      facebookUserName: fbUserName,
      facebookUserEmail: fbUserEmail,
      accessToken: finalToken,
      tokenType: "long_lived_user",
      scopes: grantedScopes,
      missingScopes,
      tokenExpiresAt: expiresAtIso,
      status: "connected",
      tokenStatus: "valid",
      accountId: stateCheck.reconnect_account_id,
      ownerUserId
    });

    return {
      success: true,
      account_id: accountId,
      owner_user_id: ownerUserId,
      user_id: fbUserId,
      user_name: fbUserName,
      token_expires_at: expiresAtIso,
      scopes: grantedScopes,
      missing_scopes: missingScopes,
      message: `Kết nối thành công tài khoản Facebook Admin: ${fbUserName} (ID: ${fbUserId})`
    };
  } catch (err) {
    return {
      success: false,
      message: sanitizeSensitiveText(
        `Lỗi kết nối đến máy chủ Meta Graph API: ${(err as Error).message}`
      )
    };
  }
}

export interface ParsedPageItem {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  avatar_url?: string;
  tasks?: string[];
  is_published?: boolean;
}

export function parseFlexibleMetaInput(rawInput: string): {
  extractedToken: string;
  extractedPages: ParsedPageItem[];
} {
  const input = (rawInput || "").trim();
  const extractedPages: ParsedPageItem[] = [];
  let extractedToken = "";

  // 1. Kiểm tra nếu người dùng dán kèm JSON từ Graph API Explorer ({ "data": [...] } hoặc object Page)
  const firstBrace = input.indexOf("{");
  const lastBrace = input.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = input.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      if (Array.isArray(parsed.data)) {
        for (const item of parsed.data as Array<Record<string, unknown>>) {
          const pid = String(item.id || "").trim();
          const ptoken = String(item.access_token || "").trim();
          const pname = String(
            item.name || item.global_brand_page_name || item.username || `Fanpage ${pid}`
          ).trim();
          if (pid && ptoken) {
            const picObj = (item.picture as { data?: { url?: string } }) || {};
            extractedPages.push({
              id: pid,
              name: pname,
              access_token: ptoken,
              category: String(item.category || "Brand / Page"),
              avatar_url: String(picObj.data?.url || ""),
              tasks: Array.isArray(item.tasks)
                ? item.tasks.map((t) => String(t).toUpperCase())
                : ["CREATE_CONTENT", "MANAGE"],
              is_published: item.is_published !== false
            });
          }
        }
      } else if (parsed.id && parsed.access_token) {
        const pid = String(parsed.id).trim();
        const ptoken = String(parsed.access_token).trim();
        const pname = String(
          parsed.name || parsed.global_brand_page_name || `Fanpage ${pid}`
        ).trim();
        extractedPages.push({
          id: pid,
          name: pname,
          access_token: ptoken,
          category: String(parsed.category || "Brand / Page"),
          tasks: ["CREATE_CONTENT", "MANAGE"],
          is_published: true
        });
      } else if (parsed.access_token && typeof parsed.access_token === "string") {
        extractedToken = parsed.access_token.trim();
      }
    } catch {
      // Không phải JSON hợp lệ thì tiếp tục tách URL/Token
    }
  }

  // 2. Kiểm tra nếu người dùng dán URL Graph API Explorer có chứa ?access_token=... hoặc &access_token=...
  const textOutsideJson =
    firstBrace !== -1 ? input.slice(0, firstBrace) + " " + input.slice(lastBrace + 1) : input;
  const urlTokenMatch = /(?:[?&#]|^)access_token=([^&#\s,"']+)/i.exec(textOutsideJson);
  if (urlTokenMatch && urlTokenMatch[1]) {
    try {
      extractedToken = decodeURIComponent(urlTokenMatch[1].trim());
    } catch {
      extractedToken = urlTokenMatch[1].trim();
    }
  }

  // 3. Nếu chưa có token từ URL, tìm chuỗi token EAA... hoặc chuỗi token trần bên ngoài khối JSON
  if (!extractedToken) {
    const cleanOutside = textOutsideJson.trim().replace(/^["',]+|["',]+$/g, "");
    const eaaMatch = /\b(EAA[A-Za-z0-9_-]{12,})\b/.exec(cleanOutside);
    if (eaaMatch && eaaMatch[1]) {
      extractedToken = eaaMatch[1];
    } else if (cleanOutside.length >= 15 && !cleanOutside.includes("{") && !cleanOutside.includes(" ")) {
      extractedToken = cleanOutside;
    }
  }

  return { extractedToken, extractedPages };
}

export async function connectWithAccessToken(
  db: D1Database,
  env: Env,
  rawAccessToken: string,
  ownerUserId: string,
  reconnectAccountId: string | null = null
): Promise<{
  success: boolean;
  account_id?: string;
  owner_user_id?: string;
  user_id?: string;
  user_name?: string;
  token_expires_at?: string | null;
  scopes?: string[];
  missing_scopes?: string[];
  is_long_lived?: boolean;
  has_user_token?: boolean;
  extracted_pages?: ParsedPageItem[];
  message?: string;
}> {
  const { extractedToken, extractedPages } = parseFlexibleMetaInput(rawAccessToken);

  if ((!extractedToken || extractedToken.length < 15) && extractedPages.length === 0) {
    return {
      success: false,
      message:
        "Vui lòng dán Access Token (EAA...), URL Graph API Explorer hoặc JSON /me/accounts hợp lệ."
    };
  }

  const cfg = getMetaConfig(env);

  try {
    // Trường hợp người dùng chỉ dán trực tiếp JSON danh sách Page ({ "data": [...] }) mà không kèm User Token
    if (!extractedToken && extractedPages.length > 0) {
      const firstPage = extractedPages[0];
      const expiresAtIso = new Date(Date.now() + 60 * 86400 * 1000).toISOString();
      const accountId = await saveFacebookAccount(db, cfg.encryptionKey, {
        facebookUserId: `admin_${firstPage.id}`,
        facebookUserName: `Admin (${firstPage.name})`,
        facebookUserEmail: null,
        accessToken: firstPage.access_token,
        tokenType: "json_imported",
        scopes: REQUIRED_SCOPES,
        missingScopes: [],
        tokenExpiresAt: expiresAtIso,
        status: "connected",
        tokenStatus: "valid",
        accountId: reconnectAccountId,
        ownerUserId
      });

      return {
        success: true,
        account_id: accountId,
        owner_user_id: ownerUserId,
        user_id: `admin_${firstPage.id}`,
        user_name: `Admin (${firstPage.name})`,
        token_expires_at: expiresAtIso,
        scopes: REQUIRED_SCOPES,
        missing_scopes: [],
        is_long_lived: true,
        has_user_token: false,
        extracted_pages: extractedPages,
        message: `Đã nhập trực tiếp ${extractedPages.length} Fanpage từ dữ liệu JSON Graph API Explorer`
      };
    }

    // Bước 1: Nếu có META_APP_ID và META_APP_SECRET, tự động nâng cấp sang Long-Lived User Token (~60 ngày)
    let finalToken = extractedToken;
    let expiresIn = 60 * 86400;
    let isLongLived = false;

    if (cfg.appId && cfg.appSecret) {
      try {
        const llParams = new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: cfg.appId,
          client_secret: cfg.appSecret,
          fb_exchange_token: extractedToken
        });
        const llResp = await fetch(
          `${cfg.graphBase}/oauth/access_token?${llParams.toString()}`
        );
        if (llResp.ok) {
          const llData = (await llResp.json()) as Record<string, unknown>;
          if (llData.access_token) {
            finalToken = String(llData.access_token);
            expiresIn = Number(llData.expires_in || 60 * 86400);
            isLongLived = true;
          }
        }
      } catch {
        // Nếu token thuộc App Graph API Explorer hoặc đã là System User / Long-Lived thì giữ nguyên extractedToken
      }
    }

    // Bước 2: Xác thực Token với Meta Graph API (/me) với fallback nếu thiếu quyền email/name
    let fbUserId = "";
    let fbUserName = "Facebook Admin";
    let fbUserEmail: string | null = null;

    const meResp = await fetch(
      `${cfg.graphBase}/me?fields=id,name,email&access_token=${encodeURIComponent(finalToken)}`
    );
    const meData = (await meResp.json()) as Record<string, unknown>;
    if (meResp.ok && meData.id) {
      fbUserId = String(meData.id);
      fbUserName = String(meData.name || meData.global_brand_page_name || "Facebook Admin");
      fbUserEmail = meData.email ? String(meData.email) : null;
    } else {
      // Fallback gọi /me?fields=id,name (phòng trường hợp token không cấp quyền email)
      const meFallbackResp = await fetch(
        `${cfg.graphBase}/me?fields=id,name&access_token=${encodeURIComponent(finalToken)}`
      );
      const meFallbackData = (await meFallbackResp.json()) as Record<string, unknown>;
      if (meFallbackResp.ok && meFallbackData.id) {
        fbUserId = String(meFallbackData.id);
        fbUserName = String(meFallbackData.name || "Facebook Admin");
      } else if (extractedPages.length > 0) {
        fbUserId = `admin_${extractedPages[0].id}`;
        fbUserName = `Admin (${extractedPages[0].name})`;
      } else {
        const errObj = (meData.error || {}) as Record<string, unknown>;
        return {
          success: false,
          message: sanitizeSensitiveText(
            `Access Token không hợp lệ hoặc đã hết hạn: ${errObj.message || "Lỗi xác thực /me trên Graph API"}`
          )
        };
      }
    }

    // Bước 3: Kiểm tra danh sách quyền đã cấp (/me/permissions)
    const grantedScopes: string[] = [];
    try {
      const permResp = await fetch(
        `${cfg.graphBase}/me/permissions?access_token=${encodeURIComponent(finalToken)}`
      );
      if (permResp.ok) {
        const permData = (await permResp.json()) as {
          data?: Array<{ permission: string; status: string }>;
        };
        for (const item of permData.data || []) {
          if (item.status === "granted") {
            grantedScopes.push(item.permission);
          }
        }
      }
    } catch {
      // Nếu là Page Access Token không có node /permissions thì bỏ qua
    }

    const missingScopes =
      grantedScopes.length > 0
        ? REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s))
        : [];
    const expiresAtIso = new Date(Date.now() + expiresIn * 1000).toISOString();

    const accountId = await saveFacebookAccount(db, cfg.encryptionKey, {
      facebookUserId: fbUserId,
      facebookUserName: fbUserName,
      facebookUserEmail: fbUserEmail,
      accessToken: finalToken,
      tokenType: isLongLived ? "long_lived_user" : "direct_token",
      scopes: grantedScopes.length > 0 ? grantedScopes : REQUIRED_SCOPES,
      missingScopes,
      tokenExpiresAt: expiresAtIso,
      status: "connected",
      tokenStatus: "valid",
      accountId: reconnectAccountId,
      ownerUserId
    });

    return {
      success: true,
      account_id: accountId,
      owner_user_id: ownerUserId,
      user_id: fbUserId,
      user_name: fbUserName,
      token_expires_at: expiresAtIso,
      scopes: grantedScopes,
      missing_scopes: missingScopes,
      is_long_lived: isLongLived,
      has_user_token: true,
      extracted_pages: extractedPages,
      message: `Kết nối thành công tài khoản Facebook Admin: ${fbUserName} (ID: ${fbUserId})`
    };
  } catch (err) {
    return {
      success: false,
      message: sanitizeSensitiveText(
        `Lỗi kết nối đến máy chủ Meta Graph API: ${(err as Error).message}`
      )
    };
  }
}

export async function getConnectionStatus(
  db: D1Database,
  env: Env,
  ownerUserId: string
): Promise<Record<string, unknown>> {
  const cfg = getMetaConfig(env);
  const accounts = await getFacebookAccounts(db, cfg.encryptionKey, false, ownerUserId);
  const connectedAccounts = accounts.filter((a) => a.status === "connected");
  let appDomain = "pagefb.namnangno.click";
  try {
    appDomain = new URL(cfg.redirectUri).hostname;
  } catch {
    // giữ nguyên default
  }
  const graphExplorerUrl = `https://developers.facebook.com/tools/explorer/${cfg.appId}/?method=GET&path=me%2Faccounts&version=${cfg.graphVersion}`;

  if (accounts.length === 0) {
    return {
      is_connected: false,
      status: "disconnected",
      total_accounts: 0,
      connected_accounts: 0,
      user_id: null,
      user_name: null,
      token_expires_at: null,
      days_remaining: null,
      scopes: [],
      missing_scopes: REQUIRED_SCOPES,
      app_id: cfg.appId,
      redirect_uri: cfg.redirectUri,
      app_domain: appDomain,
      graph_explorer_url: graphExplorerUrl,
      accounts: []
    };
  }

  const primary: FacebookAccountRecord = connectedAccounts[0] || accounts[0];
  return {
    is_connected: connectedAccounts.length > 0,
    status: connectedAccounts.length > 0 ? "connected" : primary.status,
    total_accounts: accounts.length,
    connected_accounts: connectedAccounts.length,
    user_id: primary.facebook_user_id,
    user_name: primary.facebook_user_name,
    token_expires_at: primary.token_expires_at,
    days_remaining: primary.days_remaining,
    scopes: primary.scopes,
    missing_scopes: primary.missing_scopes,
    last_synced_at: primary.last_synced_at,
    last_error: primary.last_error,
    app_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    app_domain: appDomain,
    graph_explorer_url: graphExplorerUrl,
    accounts
  };
}

