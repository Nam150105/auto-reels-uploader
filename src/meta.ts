/**
 * Production Facebook OAuth 2.0 & Meta Graph API v19.0 Service for Cloudflare Workers
 * - Server-side OAuth authorization code exchange & 60-day Long-Lived Token upgrade
 * - CSRF protection backed by Cloudflare D1 (`oauth_states`)
 * - Multi-account & Multi-user isolated `/me/accounts` Fanpage sync with pagination
 * - Official Meta Reels Publishing API (`/{page_id}/video_reels`) supporting Video URLs & Cloud Uploads
 * - Zero token logging & zero secret exposure to frontend
 */

import type { D1Database, Env, FacebookAccountRecord } from "./types.ts";
import { encryptToken, decryptToken, randomUrlSafe, base64UrlToBytes } from "./crypto.ts";
import {
  saveOAuthState,
  consumeOAuthState,
  saveFacebookAccount,
  getFacebookAccounts,
  getFacebookAccountById,
  updateAccountStatus,
  upsertFacebookPageAndRelation,
  getFacebookPages,
  getFacebookPageByFbId,
  getPageActiveEncryptedToken,
  getPendingTasks,
   getTask,
  updateTaskStatus,
  getUploadedVideo,
  nowIsoSql
} from "./db.ts";

export const PRODUCTION_DOMAIN = "https://pagefb.namnangno.click";
export const DEFAULT_META_APP_ID = "1469615908436980";
export const DEFAULT_GRAPH_VERSION = "v19.0";

/**
 * Only request permissions actually used by the Fanpage & Reels management workflow:
 * - public_profile: Identify the connected Facebook Admin account
 * - pages_show_list: List Fanpages via /me/accounts
 * - pages_read_engagement: Read Page metadata & engagement status
 * - pages_manage_posts: Publish & schedule Reels/posts to Fanpages
 * - pages_manage_engagement: Post automated comments on published Reels
 * - pages_read_user_content: Verify Page content & tasks
 */
export const DEFAULT_OAUTH_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_read_user_content"
];

export interface MetaConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  redirectUri: string;
  apiVersion: string;
  encryptionKey: string;
}

export function getMetaConfig(env: Env): MetaConfig {
  const appId = (env.META_APP_ID || DEFAULT_META_APP_ID).trim();
  const appSecret = (env.META_APP_SECRET || "").trim();
  const baseUrl = (env.APP_BASE_URL || PRODUCTION_DOMAIN).trim().replace(/\/+$/, "");
  const redirectUri = (
    env.META_REDIRECT_URI || `${baseUrl}/api/meta/callback`
  ).trim();
  let apiVersion = (env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).trim();
  if (!apiVersion.startsWith("v")) {
    apiVersion = `v${apiVersion}`;
  }
  const encryptionKey = (
    env.ENCRYPTION_KEY ||
    env.SECRET_KEY ||
    env.META_APP_SECRET ||
    "cloudflare_meta_default_encryption_key_2026_v1"
  ).trim();

  return {
    appId,
    appSecret,
    baseUrl,
    redirectUri,
    apiVersion,
    encryptionKey
  };
}

/**
 * Generates Facebook OAuth 2.0 Dialog URL and persists CSRF state in Cloudflare D1.
 */
export async function generateOAuthUrl(
  db: D1Database,
  env: Env,
  options: {
    userId: string;
    accountId?: string | null;
    authType?: string | null;
    scopes?: string[] | null;
  }
): Promise<{
  status: "success" | "error";
  oauth_url?: string;
  state?: string;
  action?: string;
  account_id?: string | null;
  user_id?: string;
  redirect_uri?: string;
  message?: string;
}> {
  const cfg = getMetaConfig(env);
  if (!cfg.appId) {
    return {
      status: "error",
      message: "Chưa cấu hình META_APP_ID trên Cloudflare Worker."
    };
  }

  const state = randomUrlSafe(32);
  const action = options.accountId ? "reconnect" : "connect";

  await saveOAuthState(db, {
    state,
    userId: options.userId,
    accountId: options.accountId || null,
    action,
    redirectUri: cfg.redirectUri,
    expiresInSeconds: 900
  });

  const reqScopes =
    options.scopes && options.scopes.length > 0 ? options.scopes : DEFAULT_OAUTH_SCOPES;
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    state,
    scope: reqScopes.join(","),
    response_type: "code"
  });

  if (options.authType) {
    params.set("auth_type", options.authType);
  }

  const oauthUrl = `https://www.facebook.com/${cfg.apiVersion}/dialog/oauth?${params.toString()}`;

  return {
    status: "success",
    oauth_url: oauthUrl,
    state,
    action,
    account_id: options.accountId || null,
    user_id: options.userId,
    redirect_uri: cfg.redirectUri
  };
}

/**
 * Exchanges Facebook OAuth Authorization Code for Short-Lived Token, upgrades to
 * 60-day Long-Lived User Access Token, fetches `/me` & `/me/permissions`,
 * and stores encrypted token in Cloudflare D1 tied to the authenticated user.
 */
export async function exchangeCodeForToken(
  db: D1Database,
  env: Env,
  params: {
    code: string;
    state: string;
    fallbackUserId?: string | null;
  }
): Promise<{
  status: "success" | "error";
  message: string;
  account_id?: string;
  owner_user_id?: string;
  user_name?: string;
  user_id?: string;
  avatar_url?: string | null;
  scopes?: string[];
  token_expires_at?: string;
  account?: FacebookAccountRecord;
}> {
  const stateData = await consumeOAuthState(db, params.state);
  if (!stateData) {
    return {
      status: "error",
      message:
        "Mã bảo mật OAuth State không hợp lệ, đã được sử dụng hoặc đã quá hạn (15 phút). Vui lòng thực hiện kết nối lại từ bảng điều khiển!"
    };
  }

  const cfg = getMetaConfig(env);
  if (!cfg.appId || !cfg.appSecret) {
    return {
      status: "error",
      message:
        "Thiếu cấu hình META_APP_SECRET trên Cloudflare Worker Secrets. Quản trị viên vui lòng chạy `npx wrangler secret put META_APP_SECRET`."
    };
  }

  // Validate redirect_uri matches the state record
  const redirectUri = stateData.redirect_uri || cfg.redirectUri;
  const ownerUserId = stateData.user_id || params.fallbackUserId || "usr_admin";

  // Step 1: Exchange Authorization Code for Short-Lived User Access Token
  const tokenEndpoint = `https://graph.facebook.com/${cfg.apiVersion}/oauth/access_token`;
  const shortParams = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    redirect_uri: redirectUri,
    code: params.code
  });

  let shortData: Record<string, unknown>;
  try {
    const resp = await fetch(`${tokenEndpoint}?${shortParams.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    shortData = (await resp.json()) as Record<string, unknown>;
  } catch {
    return {
      status: "error",
      message: "Lỗi kết nối mạng tới máy chủ Meta Graph API khi đổi Authorization Code."
    };
  }

  if (shortData.error) {
    const errObj = shortData.error as Record<string, unknown>;
    const errMsg = String(errObj?.message || "Lỗi xác thực từ Facebook OAuth.");
    return {
      status: "error",
      message: `Meta OAuth từ chối mã truy cập: ${errMsg}`
    };
  }

  const shortToken = String(shortData.access_token || "");
  if (!shortToken) {
    return {
      status: "error",
      message: "Meta không trả về User Access Token hợp lệ."
    };
  }

  // Step 2: Upgrade to Long-Lived User Access Token (60 days)
  let finalToken = shortToken;
  let expiresInSec = Number(shortData.expires_in || 5184000);

  try {
    const longParams = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: shortToken
    });
    const longResp = await fetch(`${tokenEndpoint}?${longParams.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    const longData = (await longResp.json()) as Record<string, unknown>;
    if (typeof longData.access_token === "string" && longData.access_token.length > 0) {
      finalToken = longData.access_token;
      expiresInSec = Number(longData.expires_in || 5184000);
    }
  } catch {
    // Keep shortToken if exchange endpoint experiences transient failure
  }

  const expDate = new Date(Date.now() + expiresInSec * 1000);
  const tokenExpiresAt = expDate.toISOString().replace("T", " ").slice(0, 19);

  // Step 3: Fetch Facebook User Profile (/me)
  let fbUserId = "unknown";
  let fbUserName = "Facebook Admin";
  let avatarUrl: string | null = null;

  try {
    const meParams = new URLSearchParams({
      fields: "id,name,picture.type(large)",
      access_token: finalToken
    });
    const meResp = await fetch(
      `https://graph.facebook.com/${cfg.apiVersion}/me?${meParams.toString()}`,
      { headers: { Accept: "application/json" } }
    );
    const meData = (await meResp.json()) as Record<string, unknown>;
    if (meData.error) {
      const errObj = meData.error as Record<string, unknown>;
      return {
        status: "error",
        message: `Không thể lấy thông tin tài khoản Facebook (/me): ${String(errObj?.message || "Lỗi Graph API")}`
      };
    }
    if (meData.id) {
      fbUserId = String(meData.id);
      fbUserName = String(meData.name || fbUserName);
      const pic = meData.picture as { data?: { url?: string } } | undefined;
      if (pic?.data?.url) {
        avatarUrl = String(pic.data.url);
      }
    }
  } catch {
    return {
      status: "error",
      message: "Lỗi khi truy vấn thông tin cá nhân (/me) từ Meta Graph API."
    };
  }

  // Step 4: Check granted permissions (/me/permissions)
  const grantedScopes: string[] = [];
  try {
    const permParams = new URLSearchParams({ access_token: finalToken });
    const permResp = await fetch(
      `https://graph.facebook.com/${cfg.apiVersion}/me/permissions?${permParams.toString()}`,
      { headers: { Accept: "application/json" } }
    );
    const permData = (await permResp.json()) as {
      data?: Array<{ permission?: string; status?: string }>;
    };
    if (Array.isArray(permData.data)) {
      for (const item of permData.data) {
        if (item.status === "granted" && item.permission) {
          grantedScopes.push(item.permission);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Step 5: Encrypt User Access Token and save to Cloudflare D1
  const encryptedToken = await encryptToken(finalToken, cfg.encryptionKey);
  const account = await saveFacebookAccount(db, {
    userId: fbUserId,
    userName: fbUserName,
    encryptedToken,
    tokenExpiresAt,
    scopes: grantedScopes.join(","),
    accountId: stateData.account_id,
    ownerUserId,
    avatarUrl
  });

  return {
    status: "success",
    message: `Đã kết nối tài khoản Facebook Admin: ${fbUserName} (ID: ${fbUserId})`,
    account_id: account.id,
    owner_user_id: ownerUserId,
    user_name: fbUserName,
    user_id: fbUserId,
    avatar_url: avatarUrl,
    scopes: grantedScopes,
    token_expires_at: tokenExpiresAt,
    account
  };
}

/**
 * Returns the current Facebook connection summary for the authenticated user.
 * Never exposes any raw or encrypted tokens.
 */
export async function getConnectionStatus(
  db: D1Database,
  env: Env,
  ownerUserId: string
): Promise<Record<string, unknown>> {
  const cfg = getMetaConfig(env);
  const accounts = await getFacebookAccounts(db, { ownerUserId, includeEncryptedToken: false });
  const activeAccounts = accounts.filter((a) => a.status === "connected");
  const primaryAcc = activeAccounts[0] || accounts[0] || null;

  const reqScopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
  const currentScopes = primaryAcc ? primaryAcc.scopes : [];
  const missingScopes = primaryAcc
    ? reqScopes.filter((s) => !currentScopes.includes(s))
    : reqScopes;

  return {
    is_connected: activeAccounts.length > 0,
    connected_count: activeAccounts.length,
    total_accounts: accounts.length,
    accounts,
    has_config: Boolean(cfg.appId && cfg.appSecret),
    d1_bound: Boolean(env.DB),
    r2_bound: Boolean(env.VIDEOS_BUCKET),
    app_id: cfg.appId,
    api_version: cfg.apiVersion,
    redirect_uri: cfg.redirectUri,
    user_name: primaryAcc ? primaryAcc.user_name : null,
    user_id: primaryAcc ? primaryAcc.user_id : null,
    scopes: currentScopes,
    missing_scopes: missingScopes,
    token_expires_at: primaryAcc ? primaryAcc.token_expires_at : null,
    days_remaining: primaryAcc ? primaryAcc.days_remaining : null,
    status: primaryAcc ? primaryAcc.status : "disconnected"
  };
}

/**
 * Calls Meta Graph API `GET /v19.0/me/accounts?fields=id,name,access_token,category,picture{url},tasks,is_published&limit=100`
 * with pagination (`paging.next`), encrypts Page Access Tokens, and stores Fanpages in Cloudflare D1.
 */
export async function syncPagesFromMeta(
  db: D1Database,
  env: Env,
  options: {
    accountId?: string | null;
    ownerUserId: string;
  }
): Promise<Record<string, unknown>> {
  const cfg = getMetaConfig(env);
  let accountsToSync: FacebookAccountRecord[] = [];

  if (options.accountId && options.accountId.trim()) {
    const targetAcc = await getFacebookAccountById(
      db,
      options.accountId.trim(),
      options.ownerUserId,
      true
    );
    if (!targetAcc) {
      return {
        status: "error",
        message: `Không tìm thấy tài khoản Facebook Admin (${options.accountId}) thuộc quyền sở hữu của bạn.`
      };
    }
    if (targetAcc.status !== "connected") {
      return {
        status: "error",
        message: `Tài khoản '${targetAcc.user_name}' đang ở trạng thái ngắt kết nối hoặc hết hạn token. Vui lòng bấm 'Kết nối lại'!`
      };
    }
    accountsToSync = [targetAcc];
  } else {
    accountsToSync = await getFacebookAccounts(db, {
      status: "connected",
      ownerUserId: options.ownerUserId,
      includeEncryptedToken: true
    });
  }

  if (accountsToSync.length === 0) {
    return {
      status: "error",
      message:
        "Chưa có tài khoản Facebook Admin nào đang kết nối. Vui lòng nhấn '+ Thêm tài khoản Facebook' để cấp quyền OAuth trước!"
    };
  }

  let totalSyncedPages = 0;
  const totalUniquePages = new Set<string>();
  const accountResults: Array<Record<string, unknown>> = [];

  for (const acc of accountsToSync) {
    const accId = acc.id;
    const accName = acc.user_name || "Facebook Admin";
    const userToken = await decryptToken(acc.encrypted_user_access_token, cfg.encryptionKey);

    if (!userToken) {
      accountResults.push({
        account_id: accId,
        user_name: accName,
        status: "error",
        synced_count: 0,
        error:
          "Không thể giải mã User Access Token (Khóa ENCRYPTION_KEY đã thay đổi hoặc token bị hỏng). Vui lòng nhấn 'Kết nối lại'!"
      });
      continue;
    }

    const initialParams = new URLSearchParams({
      fields: "id,name,access_token,category,picture{url},tasks,is_published",
      limit: "100",
      access_token: userToken
    });

    let nextUrl: string | null =
      `https://graph.facebook.com/${cfg.apiVersion}/me/accounts?${initialParams.toString()}`;
    let accSyncedCount = 0;
    let accError: string | null = null;
    let pageLoops = 0;

    while (nextUrl && pageLoops < 25) {
      pageLoops++;
      let data: Record<string, unknown>;
      try {
        const resp = await fetch(nextUrl, { headers: { Accept: "application/json" } });
        data = (await resp.json()) as Record<string, unknown>;
      } catch {
        accError = `Lỗi kết nối mạng khi đồng bộ Fanpage của tài khoản ${accName}.`;
        break;
      }

      if (data.error) {
        const err = data.error as { code?: number; subcode?: number; message?: string };
        const errCode = Number(err.code || 0);
        const errMsg = String(err.message || "Lỗi Graph API không xác định.");

        if (errCode === 190 || errCode === 102) {
          await updateAccountStatus(db, accId, options.ownerUserId, "expired");
          accError = `Token của tài khoản '${accName}' đã hết hạn hoặc bị thu hồi trên Facebook (Mã lỗi ${errCode}). Vui lòng nhấn 'Kết nối lại'!`;
        } else if (errCode === 10 || errCode === 200 || errCode === 294) {
          accError = `Tài khoản '${accName}' chưa cấp đủ quyền quản lý Fanpage (pages_show_list / pages_manage_posts). Chi tiết: ${errMsg}`;
        } else {
          accError = `Meta Graph API Error (${errCode}): ${errMsg}`;
        }
        break;
      }

      const items = Array.isArray(data.data)
        ? (data.data as Array<Record<string, unknown>>)
        : [];

      for (const item of items) {
        const fbPageId = String(item.id || "").trim();
        const pageName = String(item.name || "").trim();
        const rawPageToken = String(item.access_token || "").trim();
        const tasksList = Array.isArray(item.tasks) ? item.tasks.map(String) : [];
        const category = item.category ? String(item.category) : null;
        const pic = item.picture as { data?: { url?: string } } | undefined;
        const avatarUrl = pic?.data?.url ? String(pic.data.url) : null;

        if (!fbPageId || !pageName || !rawPageToken) continue;

        const canPost = tasksList.some((t) =>
          ["CREATE_CONTENT", "MANAGE", "CREATE_ADS", "MODERATE"].includes(t.toUpperCase())
        )
          ? 1
          : 0;

        const encPageToken = await encryptToken(rawPageToken, cfg.encryptionKey);
        if (!encPageToken) continue;

        await upsertFacebookPageAndRelation(db, {
          accountId: accId,
          ownerUserId: options.ownerUserId,
          facebookPageId: fbPageId,
          name: pageName,
          encryptedPageAccessToken: encPageToken,
          tasksJson: JSON.stringify(tasksList),
          canPost,
          category,
          avatarUrl
        });

        accSyncedCount++;
        totalUniquePages.add(fbPageId);
      }

      const paging = data.paging as { next?: string } | undefined;
      nextUrl = paging?.next ? String(paging.next) : null;
    }

    totalSyncedPages += accSyncedCount;
    accountResults.push({
      account_id: accId,
      user_name: accName,
      status: accError ? "error" : accSyncedCount === 0 ? "empty" : "success",
      synced_count: accSyncedCount,
      error: accError
    });
  }

  const allError = accountResults.length > 0 && accountResults.every((r) => r.status === "error");
  if (allError) {
    const firstErr = String(
      accountResults.find((r) => r.error)?.error || "Đồng bộ Fanpage thất bại."
    );
    return {
      status: "error",
      message: firstErr,
      results: accountResults
    };
  }

  const allEmpty =
    accountResults.every((r) => r.status === "empty" || r.status === "error") &&
    totalUniquePages.size === 0;

  if (allEmpty) {
    return {
      status: "empty",
      message:
        "Meta trả về danh sách Fanpage rỗng (0 trang) cho tài khoản Facebook này.\n" +
        "Nguyên nhân thường gặp:\n" +
        "1. Khi đăng nhập Facebook OAuth, bạn chưa tích chọn các Fanpage muốn cấp quyền cho ứng dụng.\n" +
        "2. Tài khoản Facebook cá nhân chưa được cấp quyền Quản trị viên / Biên tập viên trên Fanpage hoặc Meta Business Suite.\n" +
        "3. Nếu ứng dụng Meta đang ở chế độ Development Mode, tài khoản Facebook đăng nhập cần nằm trong danh sách Quản trị viên / Người kiểm thử (Roles) của App.\n" +
        "Giải pháp: Hãy nhấn 'Kết nối lại' và chọn 'Chỉnh sửa cài đặt trước đó' để tích chọn tất cả Fanpage!",
      synced_count: 0,
      results: accountResults,
      pages: await getFacebookPages(db, { ownerUserId: options.ownerUserId })
    };
  }

  return {
    status: "success",
    message: `Đã đồng bộ thành công ${totalUniquePages.size} Fanpage từ ${accountsToSync.length} tài khoản Facebook Admin!`,
    unique_pages_count: totalUniquePages.size,
    total_synced_pages: totalSyncedPages,
    results: accountResults,
    pages: await getFacebookPages(db, { ownerUserId: options.ownerUserId })
  };
}

/**
 * Verifies a Fanpage's token validity and posting permissions via Meta Graph API.
 */
export async function checkPagePermissionOnMeta(
  db: D1Database,
  env: Env,
  facebookPageId: string,
  ownerUserId: string
): Promise<Record<string, unknown>> {
  const cfg = getMetaConfig(env);
  const pageData = await getFacebookPageByFbId(db, facebookPageId, ownerUserId);
  if (!pageData) {
    return {
      status: "error",
      message: `Không tìm thấy Fanpage ${facebookPageId} trong danh sách quản lý của bạn.`
    };
  }

  const encToken = await getPageActiveEncryptedToken(db, pageData.facebook_page_id, ownerUserId);
  const pageToken = await decryptToken(encToken, cfg.encryptionKey);
  if (!pageToken) {
    return {
      status: "error",
      can_post: false,
      message: "Không thể giải mã Page Access Token. Vui lòng đồng bộ lại Fanpage!"
    };
  }

  const params = new URLSearchParams({
    fields: "id,name,is_published,tasks",
    access_token: pageToken
  });

  let data: Record<string, unknown>;
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${cfg.apiVersion}/${pageData.facebook_page_id}?${params.toString()}`,
      { headers: { Accept: "application/json" } }
    );
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    return {
      status: "error",
      can_post: false,
      message: "Lỗi kết nối mạng tới Meta Graph API khi kiểm tra quyền Fanpage."
    };
  }

  if (data.error) {
    const err = data.error as { code?: number; message?: string };
    return {
      status: "error",
      can_post: false,
      message: `Page Token không hợp lệ hoặc đã hết hạn: ${String(err.message || "Lỗi Graph API")}`
    };
  }

  const tasks = Array.isArray(data.tasks) ? data.tasks.map(String) : [];
  const canPost = tasks.some((t) =>
    ["CREATE_CONTENT", "MANAGE", "CREATE_ADS", "MODERATE"].includes(t.toUpperCase())
  );

  return {
    status: "success",
    facebook_page_id: pageData.facebook_page_id,
    name: String(data.name || pageData.name),
    can_post: canPost,
    tasks,
    admin_names: pageData.admin_names,
    message: canPost
      ? "Page Access Token hợp lệ và đầy đủ quyền đăng Reels (CREATE_CONTENT)!"
      : "Page Access Token hợp lệ nhưng thiếu quyền CREATE_CONTENT trên Fanpage!"
  };
}

/**
 * Helper to check if a video_path is a valid HTTP(S) URL or a Cloud-uploaded video (`cloud://video/...`)
 */
export async function validateVideoSource(
  db: D1Database,
  env: Env,
  videoPath: string,
  ownerUserId: string
): Promise<{
  exists: boolean;
  type: "url" | "cloud" | "local_unsupported";
  sizeMb: number;
  isValidFormat: boolean;
  error?: string;
}> {
  const clean = (videoPath || "").trim().replace(/^["']|["']$/g, "");
  if (!clean) {
    return {
      exists: false,
      type: "local_unsupported",
      sizeMb: 0,
      isValidFormat: false,
      error: "Đường dẫn hoặc URL video đang để trống."
    };
  }

  if (clean.startsWith("cloud://video/")) {
    const videoId = clean.replace("cloud://video/", "").split("/")[0].trim();
    const rec = await getUploadedVideo(db, videoId, ownerUserId);
    if (!rec) {
      return {
        exists: false,
        type: "cloud",
        sizeMb: 0,
        isValidFormat: false,
        error: "Không tìm thấy file video đã tải lên Cloud (R2/D1)."
      };
    }
    return {
      exists: true,
      type: "cloud",
      sizeMb: Number((rec.file_size / (1024 * 1024)).toFixed(2)),
      isValidFormat: true
    };
  }

  if (clean.startsWith("https://") || clean.startsWith("http://")) {
    return {
      exists: true,
      type: "url",
      sizeMb: 1,
      isValidFormat: true
    };
  }

  // Local Windows path (e.g., D:\Videos\...): on Cloudflare Workers edge, direct local PC paths cannot be read unless uploaded or provided via URL
  return {
    exists: false,
    type: "local_unsupported",
    sizeMb: 0,
    isValidFormat: /\.(mp4|mov|avi|mkv)$/i.test(clean),
    error:
      "Ứng dụng đang chạy trực tiếp trên Cloudflare Edge nên không thể đọc ổ cứng máy tính cá nhân (" +
      clean +
      "). Vui lòng bấm '📁 Chọn / Tải Video Lên' hoặc nhập link URL video trực tiếp (https://...mp4)!"
  };
}

/**
 * Publishes or Schedules a Video Reel to a Facebook Fanpage via Meta Graph API v19.0 (`/{page_id}/video_reels`).
 */
export async function publishReelToMeta(
  db: D1Database,
  env: Env,
  params: {
    facebookPageId: string;
    videoPath: string;
    caption?: string;
    commentText?: string;
    scheduleTimeUnix?: number | null;
    ownerUserId: string;
  }
): Promise<{
  status: "success" | "error";
  message: string;
  video_id?: string;
  post_id?: string;
  video_url?: string;
  is_scheduled?: boolean;
}> {
  const cfg = getMetaConfig(env);
  const pageData = await getFacebookPageByFbId(db, params.facebookPageId, params.ownerUserId);
  if (!pageData) {
    return {
      status: "error",
      message: `Không tìm thấy Fanpage ${params.facebookPageId} thuộc quyền quản lý của bạn.`
    };
  }

  const encToken = await getPageActiveEncryptedToken(
    db,
    pageData.facebook_page_id,
    params.ownerUserId
  );
  const pageToken = await decryptToken(encToken, cfg.encryptionKey);
  if (!pageToken) {
    return {
      status: "error",
      message: "Không thể giải mã Page Access Token để đăng Reels. Vui lòng đồng bộ lại Fanpage!"
    };
  }

  const cleanPath = (params.videoPath || "").trim().replace(/^["']|["']$/g, "");
  const sourceCheck = await validateVideoSource(db, env, cleanPath, params.ownerUserId);
  if (!sourceCheck.exists) {
    return {
      status: "error",
      message: sourceCheck.error || `Nguồn video không hợp lệ: ${cleanPath}`
    };
  }

  const startEndpoint = `https://graph.facebook.com/${cfg.apiVersion}/${pageData.facebook_page_id}/video_reels`;

  // Stage 1: Initialize Upload Session (upload_phase=start)
  let videoId = "";
  let uploadUrl = "";
  try {
    const startBody = new URLSearchParams({
      upload_phase: "start",
      access_token: pageToken
    });
    const initResp = await fetch(startEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: startBody.toString()
    });
    const initData = (await initResp.json()) as Record<string, unknown>;
    if (initData.error) {
      const err = initData.error as { message?: string };
      return {
        status: "error",
        message: `Giai đoạn 1 (Khởi tạo phiên Reels) thất bại: ${String(err.message || "Lỗi Graph API")}`
      };
    }
    videoId = String(initData.video_id || "");
    uploadUrl = String(initData.upload_url || "");
  } catch (err) {
    return {
      status: "error",
      message: `Lỗi kết nối ở Giai đoạn 1 (Start Reels): ${err instanceof Error ? err.message : String(err)}`
    };
  }

  if (!videoId || !uploadUrl) {
    return {
      status: "error",
      message: "Meta Graph API không trả về video_id hoặc upload_url."
    };
  }

  // Stage 2: Transfer Video to Meta (`rupload.facebook.com`)
  try {
    if (sourceCheck.type === "url") {
      // Hosted file_url upload: Meta servers download directly from the URL
      const upResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${pageToken}`,
          file_url: cleanPath
        }
      });
      const upData = (await upResp.json()) as Record<string, unknown>;
      if (upData.error) {
        const err = upData.error as { message?: string };
        return {
          status: "error",
          message: `Giai đoạn 2 (Upload từ URL) thất bại: ${String(err.message || "Lỗi tải video")}`
        };
      }
    } else if (sourceCheck.type === "cloud") {
      const cloudId = cleanPath.replace("cloud://video/", "").split("/")[0].trim();
      const videoRec = await getUploadedVideo(db, cloudId, params.ownerUserId);
      if (!videoRec) {
        return {
          status: "error",
          message: "Không tìm thấy dữ liệu video đã tải lên Cloud."
        };
      }

      let binaryBuffer: ArrayBuffer | null = null;
      if (videoRec.r2_key && env.VIDEOS_BUCKET) {
        const r2Obj = await env.VIDEOS_BUCKET.get(videoRec.r2_key);
        if (r2Obj) {
          binaryBuffer = await r2Obj.arrayBuffer();
        }
      }
      if (!binaryBuffer && videoRec.data_base64) {
        const bytes = base64UrlToBytes(videoRec.data_base64);
        binaryBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
      }

      if (!binaryBuffer) {
        return {
          status: "error",
          message: "Không thể đọc nội dung nhị phân của video từ Cloud storage."
        };
      }

      const upResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${pageToken}`,
          offset: "0",
          file_size: String(binaryBuffer.byteLength),
          "Content-Type": "application/octet-stream"
        },
        body: binaryBuffer
      });
      const upData = (await upResp.json()) as Record<string, unknown>;
      if (upData.error) {
        const err = upData.error as { message?: string };
        return {
          status: "error",
          message: `Giai đoạn 2 (Upload Binary) thất bại: ${String(err.message || "Lỗi upload")}`
        };
      }
    }
  } catch (err) {
    return {
      status: "error",
      message: `Lỗi kết nối ở Giai đoạn 2 (Upload Video): ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // Stage 3: Poll Video Processing Status
  const statusUrl = `https://graph.facebook.com/${cfg.apiVersion}/${videoId}?fields=status&access_token=${encodeURIComponent(pageToken)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const stResp = await fetch(statusUrl, { headers: { Accept: "application/json" } });
      const stData = (await stResp.json()) as {
        status?: { video_status?: string };
      };
      const vStatus = stData.status?.video_status;
      if (vStatus === "ready" || vStatus === "complete") {
        break;
      }
    } catch {
      // Ignore transient poll errors
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Stage 4: Finish & Publish or Schedule Reel
  const finishParams = new URLSearchParams({
    upload_phase: "finish",
    video_id: videoId,
    access_token: pageToken
  });

  if (params.caption && params.caption.trim()) {
    finishParams.set("description", params.caption.trim());
  }

  let isScheduled = false;
  if (params.scheduleTimeUnix) {
    const nowUnix = Math.floor(Date.now() / 1000);
    const diff = params.scheduleTimeUnix - nowUnix;
    // Meta Graph API requires scheduled_publish_time between 20 minutes (1200s) and 75 days (6480000s)
    if (diff >= 1200 && diff <= 6480000) {
      finishParams.set("video_state", "SCHEDULED");
      finishParams.set("scheduled_publish_time", String(params.scheduleTimeUnix));
      isScheduled = true;
    } else {
      finishParams.set("video_state", "PUBLISHED");
    }
  } else {
    finishParams.set("video_state", "PUBLISHED");
  }

  let postId = videoId;
  try {
    const finResp = await fetch(startEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: finishParams.toString()
    });
    const finData = (await finResp.json()) as Record<string, unknown>;
    if (finData.error) {
      const err = finData.error as { message?: string };
      return {
        status: "error",
        message: `Giai đoạn 4 (Xuất bản Reels) thất bại: ${String(err.message || "Lỗi Graph API")}`
      };
    }
    if (finData.post_id) {
      postId = String(finData.post_id);
    }
  } catch (err) {
    return {
      status: "error",
      message: `Lỗi mạng ở Giai đoạn 4 (Finish Reels): ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const reelUrl = `https://www.facebook.com/reel/${videoId}`;

  // Stage 5: Automated First Comment if configured
  let commentLog = "";
  if (params.commentText && params.commentText.trim() && !isScheduled) {
    try {
      const cmtBody = new URLSearchParams({
        message: params.commentText.trim(),
        access_token: pageToken
      });
      const cmtResp = await fetch(
        `https://graph.facebook.com/${cfg.apiVersion}/${videoId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: cmtBody.toString()
        }
      );
      const cmtData = (await cmtResp.json()) as Record<string, unknown>;
      if (cmtData.id) {
        commentLog = ` | Đã đăng bình luận tự động (ID: ${String(cmtData.id)})`;
      } else if (cmtData.error) {
        const err = cmtData.error as { message?: string };
        commentLog = ` | Lưu ý bình luận: ${String(err.message || "Không thể bình luận")}`;
      }
    } catch {
      commentLog = " | Không thể gửi bình luận phụ";
    }
  }

  const modeLabel = isScheduled ? "Đã hẹn lịch xuất bản Reels" : "Đã đăng Reels thành công";
  return {
    status: "success",
    message: `${modeLabel} lên Fanpage '${pageData.name}' (Video ID: ${videoId})${commentLog}`,
    video_id: videoId,
    post_id: postId,
    video_url: reelUrl,
    is_scheduled: isScheduled
  };
}

/**
 * Diagnostic Run Test (`POST /api/runner/test`)
 * Validates OAuth connection, Page permissions, video sources, and schedule windows without publishing.
 */
export async function runDiagnosticTest(
  db: D1Database,
  env: Env,
  options: {
    facebookPageIds?: string[] | null;
    taskIds?: number[] | null;
    ownerUserId: string;
  }
): Promise<Record<string, unknown>> {
  const connStatus = await getConnectionStatus(db, env, options.ownerUserId);
  const reqScopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
  const userScopes = Array.isArray(connStatus.scopes) ? (connStatus.scopes as string[]) : [];
  const missingScopes = reqScopes.filter((s) => !userScopes.includes(s));

  if (!connStatus.is_connected) {
    return {
      tested_at: nowIsoSql(),
      status: "failed",
      message: "Thất bại: Chưa kết nối tài khoản Facebook Admin qua OAuth!",
      summary: "Thất bại: Chưa kết nối tài khoản Facebook Admin qua OAuth!",
      is_ready_to_publish: false,
      oauth_check: {
        connected: false,
        user_name: null,
        user_id: null,
        token_expires_at: null,
        missing_scopes: reqScopes
      },
      page_checks: [],
      video_checks: [],
      valid_pages_count: 0,
      valid_videos_count: 0,
      invalid_schedules_count: 0,
      schedule_warnings: []
    };
  }

  let pagesToCheck = await getFacebookPages(db, {
    onlySelected: !options.facebookPageIds || options.facebookPageIds.length === 0,
    ownerUserId: options.ownerUserId
  });

  if (options.facebookPageIds && options.facebookPageIds.length > 0) {
    const idSet = new Set(options.facebookPageIds.map((id) => id.trim()));
    pagesToCheck = pagesToCheck.filter((p) => idSet.has(p.facebook_page_id));
  }

  const pageChecks: Array<Record<string, unknown>> = [];
  let validPagesCount = 0;

  for (const p of pagesToCheck) {
    const checkRes = await checkPagePermissionOnMeta(
      db,
      env,
      p.facebook_page_id,
      options.ownerUserId
    );
    const canPost = Boolean(checkRes.can_post);
    if (canPost) validPagesCount++;
    pageChecks.push({
      facebook_page_id: p.facebook_page_id,
      name: p.name,
      can_post: canPost,
      status: checkRes.status,
      message: checkRes.message
    });
  }

  const checkedPageIds = pagesToCheck.map((p) => p.facebook_page_id);
  const tasksToCheck = await getPendingTasks(db, {
    facebookPageIds: checkedPageIds,
    taskIds: options.taskIds,
    ownerUserId: options.ownerUserId
  });

  const tasksValidation: Array<Record<string, unknown>> = [];
  const videoChecks: Array<Record<string, unknown>> = [];
  const scheduleWarnings: string[] = [];
  let validTasksCount = 0;

  for (const t of tasksToCheck) {
    const vCheck = await validateVideoSource(db, env, t.video_path, options.ownerUserId);
    let scheduleInfo = "Đăng ngay";

    if (t.schedule_date && t.schedule_time) {
      const parsedMs = Date.parse(`${t.schedule_date}T${t.schedule_time}:00+07:00`);
      if (isNaN(parsedMs)) {
        scheduleInfo = `Lỗi định dạng ngày giờ (${t.schedule_date} ${t.schedule_time})`;
        scheduleWarnings.push(`Task #${t.id}: ${scheduleInfo}`);
      } else {
        const diffSec = Math.floor((parsedMs - Date.now()) / 1000);
        if (diffSec >= 1200 && diffSec <= 6480000) {
          scheduleInfo = `Meta Scheduled: ${t.schedule_date} ${t.schedule_time}`;
        } else {
          scheduleInfo = `Lỗi khung giờ hẹn lịch Task #${t.id}: Meta yêu cầu hẹn trước từ 20 phút đến 75 ngày`;
          scheduleWarnings.push(scheduleInfo);
        }
      }
    }

    const isTaskValid =
      vCheck.exists && vCheck.isValidFormat && Boolean(t.facebook_page_id);
    if (isTaskValid) validTasksCount++;

    tasksValidation.push({
      task_id: t.id,
      facebook_page_id: t.facebook_page_id,
      page_name: t.page_name,
      video_path: t.video_path,
      file_exists: vCheck.exists,
      file_size_mb: vCheck.sizeMb,
      is_valid_format: vCheck.isValidFormat,
      caption_length: (t.caption || "").length,
      has_comment: Boolean((t.comment_text || "").trim()),
      schedule_info: scheduleInfo,
      status: isTaskValid ? "VALID" : "INVALID",
      error: isTaskValid ? null : vCheck.error || "Chưa gán Fanpage hoặc nguồn video không hợp lệ"
    });

    videoChecks.push({
      path: t.video_path,
      exists: vCheck.exists,
      size_mb: vCheck.sizeMb,
      error: vCheck.error || null
    });
  }

  const allOk =
    validPagesCount > 0 &&
    (tasksToCheck.length === 0 || validTasksCount > 0) &&
    missingScopes.length === 0 &&
    scheduleWarnings.length === 0;

  const status = allOk
    ? "passed"
    : validPagesCount > 0
    ? "warning"
    : "failed";

  const summary = `Run Test hoàn tất: ${validPagesCount}/${pagesToCheck.length} Fanpage hợp lệ, ${validTasksCount}/${tasksToCheck.length} Task sẵn sàng.`;

  return {
    tested_at: nowIsoSql(),
    status,
    message: summary,
    summary,
    is_ready_to_publish: allOk,
    oauth_check: {
      connected: true,
      user_name: connStatus.user_name,
      user_id: connStatus.user_id,
      token_expires_at: connStatus.token_expires_at,
      days_remaining: connStatus.days_remaining,
      missing_scopes: missingScopes,
      connected_count: connStatus.connected_count,
      accounts: connStatus.accounts
    },
    pages_validation: pageChecks,
    page_checks: pageChecks,
    valid_pages_count: validPagesCount,
    tasks_validation: tasksValidation,
    video_checks: videoChecks,
    valid_videos_count: videoChecks.filter((v) => v.exists).length,
    invalid_schedules_count: scheduleWarnings.length,
    schedule_warnings: scheduleWarnings
  };
}

/**
 * Executes a batch of pending Reels publishing tasks for the user on Cloudflare Workers.
 */
export async function executeTasksBatch(
  db: D1Database,
  env: Env,
  options: {
    tasks: Array<{ id: number }>;
    ownerUserId: string;
    concurrency?: number;
  }
): Promise<void> {
  const limit = Math.max(1, Math.min(options.concurrency || 3, 5));
  const queue = [...options.tasks];

  async function workerLoop(): Promise<void> {
    while (queue.length > 0) {
      const nextItem = queue.shift();
      if (!nextItem) break;

      const currentTask = await getTask(db, nextItem.id, options.ownerUserId);
      if (!currentTask || currentTask.status !== "pending") continue;

      await updateTaskStatus(db, currentTask.id, options.ownerUserId, {
        status: "running",
        log: "Đang tải lên và xuất bản Reels qua Meta Graph API v19.0..."
      });

      let scheduleUnix: number | null = null;
      if (currentTask.schedule_date && currentTask.schedule_time) {
        const parsed = Date.parse(
          `${currentTask.schedule_date}T${currentTask.schedule_time}:00+07:00`
        );
        if (!isNaN(parsed)) {
          scheduleUnix = Math.floor(parsed / 1000);
        }
      }

      try {
        const res = await publishReelToMeta(db, env, {
          facebookPageId: currentTask.facebook_page_id || "",
          videoPath: currentTask.video_path,
          caption: currentTask.caption || "",
          commentText: currentTask.comment_text || "",
          scheduleTimeUnix: scheduleUnix,
          ownerUserId: options.ownerUserId
        });

        if (res.status === "success") {
          await updateTaskStatus(db, currentTask.id, options.ownerUserId, {
            status: "success",
            log: res.message,
            videoUrl: res.video_url || null,
            metaVideoId: res.video_id || null,
            metaPostId: res.post_id || null,
            doneTime: nowIsoSql()
          });
        } else {
          await updateTaskStatus(db, currentTask.id, options.ownerUserId, {
            status: "failed",
            log: `Thất bại: ${res.message}`,
            errorMessage: res.message
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await updateTaskStatus(db, currentTask.id, options.ownerUserId, {
          status: "failed",
          log: `Lỗi ngoại lệ: ${errMsg}`,
          errorMessage: errMsg
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, options.tasks.length) }, () =>
    workerLoop()
  );
  await Promise.all(workers);
}
