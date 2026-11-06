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
  message?: string;
}> {
  const cleanedToken = (rawAccessToken || "").trim().replace(/^["']|["']$/g, "");
  if (!cleanedToken || cleanedToken.length < 15) {
    return {
      success: false,
      message: "Vui lòng nhập chuỗi Access Token hợp lệ từ Meta Graph API Explorer."
    };
  }

  const cfg = getMetaConfig(env);

  try {
    // Bước 1: Nếu có META_APP_ID và META_APP_SECRET, tự động nâng cấp sang Long-Lived User Token (~60 ngày)
    let finalToken = cleanedToken;
    let expiresIn = 60 * 86400;
    let isLongLived = false;

    if (cfg.appId && cfg.appSecret) {
      try {
        const llParams = new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: cfg.appId,
          client_secret: cfg.appSecret,
          fb_exchange_token: cleanedToken
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
        // Nếu token đã là System User / Long-Lived hoặc không cần exchange, tiếp tục dùng cleanedToken
      }
    }

    // Bước 2: Xác thực Token với Meta Graph API (/me)
    const meResp = await fetch(
      `${cfg.graphBase}/me?fields=id,name,email&access_token=${encodeURIComponent(finalToken)}`
    );
    const meData = (await meResp.json()) as Record<string, unknown>;
    if (!meResp.ok || !meData.id) {
      const errObj = (meData.error || {}) as Record<string, unknown>;
      return {
        success: false,
        message: sanitizeSensitiveText(
          `Access Token không hợp lệ hoặc đã hết hạn: ${errObj.message || "Lỗi xác thực /me trên Graph API"}`
        )
      };
    }

    const fbUserId = String(meData.id);
    const fbUserName = String(meData.name || "Facebook Admin");
    const fbUserEmail = meData.email ? String(meData.email) : null;

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

