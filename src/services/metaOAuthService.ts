/**
 * Meta Facebook OAuth 2.0 Service (Cloudflare Workers + D1)
 * - Duy nhất phương thức kết nối: Facebook OAuth 2.0 Authorization Code Flow
 * - Lưu CSRF State trong D1 (`oauth_states`), chỉ sử dụng 1 lần (One-Time Use)
 * - Ràng buộc chặt chẽ phiên OAuth với người dùng đang đăng nhập
 * - Nâng cấp Long-Lived User Access Token (~60 ngày) và kiểm tra quyền (/me/permissions)
 */

import type { D1Database, Env, FacebookAccountRecord } from "../types.ts";
import { randomHex, getEncryptionKeyMaterial } from "../utils/crypto.ts";
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
  "pages_manage_engagement"
];

export const ESSENTIAL_PAGE_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts"
];

export function getMetaConfig(env: Env) {
  const appId = (env.META_APP_ID || DEFAULT_META_APP_ID)
    .trim()
    .replace(/^["']|["']$/g, "");
  const appSecret = (env.META_APP_SECRET || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  const baseUrl = (env.APP_BASE_URL || PRODUCTION_DOMAIN)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\/+$/, "");
  const redirectUri = (
    env.META_REDIRECT_URI || `${baseUrl}/api/meta/callback`
  )
    .trim()
    .replace(/^["']|["']$/g, "");
  const graphVersion = (env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION)
    .trim()
    .replace(/^["']|["']$/g, "");
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

let appDomainsSyncedInIsolate = false;

export async function ensureMetaAppDomainsConfigured(env: Env): Promise<{
  checked: boolean;
  updated: boolean;
  app_domains?: string[];
  website_url?: string | null;
}> {
  const cfg = getMetaConfig(env);
  if (
    !cfg.appId ||
    !cfg.appSecret ||
    cfg.appSecret.includes("unit_tests") ||
    cfg.appSecret.includes("your_meta_app_secret")
  ) {
    return { checked: false, updated: false };
  }

  try {
    const targetDomain = new URL(cfg.baseUrl).hostname;
    const appAccessToken = `${cfg.appId}|${cfg.appSecret}`;
    const infoUrl = `${cfg.graphBase}/${cfg.appId}?fields=id,name,app_domains,website_url&access_token=${encodeURIComponent(appAccessToken)}`;
    const infoResp = await fetch(infoUrl);
    if (!infoResp.ok) {
      return { checked: false, updated: false };
    }
    const infoData = (await infoResp.json()) as {
      app_domains?: string[];
      website_url?: string;
    };
    const existingDomains = Array.isArray(infoData.app_domains)
      ? infoData.app_domains
      : [];
    const hasTargetDomain = existingDomains.some(
      (d) => d.toLowerCase() === targetDomain.toLowerCase()
    );
    const hasWebsiteUrl =
      typeof infoData.website_url === "string" &&
      infoData.website_url.includes(targetDomain);

    if (hasTargetDomain && hasWebsiteUrl) {
      appDomainsSyncedInIsolate = true;
      return {
        checked: true,
        updated: false,
        app_domains: existingDomains,
        website_url: infoData.website_url || null
      };
    }

    const mergedDomains = Array.from(
      new Set([...existingDomains, targetDomain])
    );
    const updateParams = new URLSearchParams({
      access_token: appAccessToken,
      app_domains: JSON.stringify(mergedDomains),
      website_url: `${cfg.baseUrl}/`,
      privacy_policy_url: `${cfg.baseUrl}/privacy`,
      terms_of_service_url: `${cfg.baseUrl}/terms`
    });
    const updateResp = await fetch(`${cfg.graphBase}/${cfg.appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: updateParams.toString()
    });
    appDomainsSyncedInIsolate = true;
    return {
      checked: true,
      updated: updateResp.ok,
      app_domains: mergedDomains,
      website_url: `${cfg.baseUrl}/`
    };
  } catch {
    return { checked: false, updated: false };
  }
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
  error_code?: string;
  message?: string;
}> {
  const cfg = getMetaConfig(env);
  if (!cfg.appId || !cfg.appSecret) {
    return {
      success: false,
      error_code: "facebook_error",
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
    };
  }

  if (!appDomainsSyncedInIsolate) {
    await ensureMetaAppDomainsConfigured(env);
  }

  let effectiveRedirectUri = cfg.redirectUri;
  if (customRedirectUri) {
    const trimmed = customRedirectUri.trim();
    try {
      const parsedCustom = new URL(trimmed);
      const parsedConfigured = new URL(cfg.redirectUri);
      if (
        parsedCustom.origin === parsedConfigured.origin &&
        parsedCustom.pathname === "/api/meta/callback"
      ) {
        effectiveRedirectUri = trimmed;
      }
    } catch {
      // Giữ nguyên cfg.redirectUri nếu customRedirectUri không hợp lệ
    }
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
  currentUserId: string | null = null
): Promise<{
  success: boolean;
  error_code?: string;
  account_id?: string;
  owner_user_id?: string;
  user_id?: string;
  user_name?: string;
  token_expires_at?: string | null;
  scopes?: string[];
  missing_scopes?: string[];
  message?: string;
}> {
  if (!code || !state) {
    return {
      success: false,
      error_code: "invalid_state",
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
    };
  }

  const stateCheck = await consumeOAuthState(db, state);
  if (!stateCheck.valid) {
    return {
      success: false,
      error_code: "invalid_state",
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
    };
  }

  // Ràng buộc OAuth callback với đúng người dùng đang đăng nhập ứng dụng
  if (
    currentUserId &&
    stateCheck.owner_user_id &&
    stateCheck.owner_user_id !== currentUserId
  ) {
    return {
      success: false,
      error_code: "user_mismatch",
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
    };
  }

  const ownerUserId = stateCheck.owner_user_id || currentUserId;
  if (!ownerUserId) {
    return {
      success: false,
      error_code: "unauthenticated",
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
    };
  }

  const cfg = getMetaConfig(env);
  if (!cfg.appId || !cfg.appSecret) {
    return {
      success: false,
      error_code: "facebook_error",
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
    };
  }

  const effectiveRedirectUri =
    stateCheck.redirect_after && /^https?:\/\//i.test(stateCheck.redirect_after)
      ? stateCheck.redirect_after
      : cfg.redirectUri;

  try {
    // Bước 1: Đổi authorization code lấy Short-Lived User Access Token
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
      return {
        success: false,
        error_code: "facebook_error",
        message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
      };
    }

    const shortToken = String(tokenData.access_token || "");
    if (!shortToken) {
      return {
        success: false,
        error_code: "invalid_token",
        message: "Kết nối Facebook đã hết hiệu lực, vui lòng kết nối lại"
      };
    }

    // Bước 2: Đổi sang Long-Lived User Access Token (~60 ngày)
    let finalToken = shortToken;
    let expiresIn = Number(tokenData.expires_in || 0);

    try {
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
    } catch {
      // Giữ nguyên shortToken nếu bước nâng cấp long-lived tạm thời không phản hồi
    }

    // Bước 3: Lấy thông tin tài khoản Facebook (GET /me?fields=id,name)
    const meResp = await fetch(
      `${cfg.graphBase}/me?fields=id,name&access_token=${encodeURIComponent(finalToken)}`
    );
    const meData = (await meResp.json()) as Record<string, unknown>;
    if (!meResp.ok || !meData.id) {
      const errObj = (meData.error || {}) as Record<string, unknown>;
      const codeNum = Number(errObj.code || 0);
      return {
        success: false,
        error_code: codeNum === 190 ? "invalid_token" : "facebook_error",
        message:
          codeNum === 190
            ? "Kết nối Facebook đã hết hiệu lực, vui lòng kết nối lại"
            : "Không thể kết nối Facebook lúc này, vui lòng thử lại"
      };
    }

    const fbUserId = String(meData.id);
    const fbUserName = String(meData.name || "Facebook User");

    // Bước 4: Kiểm tra các quyền thực tế đã cấp (GET /me/permissions)
    const grantedScopes: string[] = [];
    const declinedScopes: string[] = [];
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
        } else if (item.status === "declined") {
          declinedScopes.push(item.permission);
        }
      }
    }

    const missingEssential = ESSENTIAL_PAGE_SCOPES.filter(
      (s) =>
        declinedScopes.includes(s) ||
        (grantedScopes.length > 0 && !grantedScopes.includes(s))
    );

    if (missingEssential.length > 0) {
      return {
        success: false,
        error_code: "missing_permissions",
        scopes: grantedScopes,
        missing_scopes: missingEssential,
        message: "Facebook chưa cấp đủ quyền cần thiết"
      };
    }

    const missingScopes = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s));
    const expiresAtIso =
      expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : new Date(Date.now() + 60 * 86400 * 1000).toISOString();

    let accountId: string;
    try {
      accountId = await saveFacebookAccount(db, cfg.encryptionKey, {
        facebookUserId: fbUserId,
        facebookUserName: fbUserName,
        facebookUserEmail: null,
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
    } catch {
      return {
        success: false,
        error_code: "db_error",
        message: "Không thể lưu tài khoản, vui lòng thử lại"
      };
    }

    return {
      success: true,
      account_id: accountId,
      owner_user_id: ownerUserId,
      user_id: fbUserId,
      user_name: fbUserName,
      token_expires_at: expiresAtIso,
      scopes: grantedScopes,
      missing_scopes: missingScopes,
      message: "Đã kết nối tài khoản Facebook thành công"
    };
  } catch {
    return {
      success: false,
      error_code: "facebook_error",
      message: "Không thể kết nối Facebook lúc này, vui lòng thử lại"
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
    accounts
  };
}
