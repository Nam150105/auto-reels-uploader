/**
 * Authentication, Revocable Server-Side Sessions, CSRF Protection & Rate Limiting Middleware
 * - Không bao giờ tin user_id hoặc owner_user_id gửi từ Frontend
 * - Mọi phiên đăng nhập được lưu vào bảng `sessions` trong D1 (hỗ trợ thu hồi ngay lập tức khi Logout)
 * - Bảo vệ CSRF cho các request thay đổi dữ liệu (POST/PUT/DELETE)
 * - Rate Limit cho /api/auth/login và /api/auth/register
 */

import type { D1Database, Env, UserRecord, SessionRecord } from "../types.ts";
import {
  generateSessionToken,
  verifySessionTokenDetailed,
  getSessionSecretMaterial,
  sha256Hex,
  randomHex
} from "../utils/crypto.ts";
import {
  createSessionRecord,
  getValidSessionByTokenHash,
  revokeSessionByTokenHash,
  getUserById,
  checkRateLimit
} from "../db.ts";

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function makeSessionCookie(
  token: string,
  isHttps: boolean,
  maxAgeSeconds = 7 * 86400
): string {
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

export function clearSessionCookie(isHttps: boolean): string {
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

export async function issueUserSession(
  request: Request,
  db: D1Database,
  env: Env,
  userId: string,
  ttlSeconds = 7 * 86400
): Promise<{ token: string; csrfToken: string; session: SessionRecord }> {
  const secretKey = getSessionSecretMaterial(env);
  const sessionId = `ses_${randomHex(12)}`;
  const csrfToken = randomHex(16);
  const token = await generateSessionToken(userId, secretKey, sessionId, ttlSeconds);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const ipAddress =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "127.0.0.1";
  const userAgent = request.headers.get("User-Agent") || "";

  const session = await createSessionRecord(db, {
    sessionId,
    userId,
    tokenHash,
    csrfToken,
    ipAddress,
    userAgent,
    expiresAt
  });

  return { token, csrfToken, session };
}

export function extractRawSessionToken(request: Request): string {
  const cookies = parseCookies(request.headers.get("Cookie"));
  let token = cookies["session_token"] || "";
  if (!token) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }
  }
  return token;
}

export async function authenticateRequest(
  request: Request,
  db: D1Database,
  env: Env
): Promise<{ user: UserRecord | null; session: SessionRecord | null }> {
  const token = extractRawSessionToken(request);
  if (!token) return { user: null, session: null };

  const secretKey = getSessionSecretMaterial(env);
  const verified = await verifySessionTokenDetailed(token, secretKey);
  if (!verified) return { user: null, session: null };

  const tokenHash = await sha256Hex(token);
  const dbSession = await getValidSessionByTokenHash(db, tokenHash);

  // Nếu token có sessionId (phiên bản mới), bắt buộc phải tồn tại và chưa bị thu hồi trong bảng sessions
  if (verified.sessionId) {
    if (!dbSession) {
      return { user: null, session: null };
    }
  }

  const user = await getUserById(db, verified.userId);
  if (!user) return { user: null, session: null };

  return { user, session: dbSession };
}

export async function revokeRequestSession(
  request: Request,
  db: D1Database
): Promise<boolean> {
  const token = extractRawSessionToken(request);
  if (!token) return false;
  const tokenHash = await sha256Hex(token);
  return revokeSessionByTokenHash(db, tokenHash);
}

/**
 * Kiểm tra chống tấn công CSRF đối với các request thay đổi dữ liệu (POST, PUT, DELETE, PATCH)
 * - Chấp nhận nếu Origin / Referer cùng host với request URL hoặc APP_BASE_URL
 * - Chấp nhận nếu không có Origin header (same-origin fetch từ một số trình duyệt/client nội bộ)
 * - Từ chối nếu Origin header đến từ một tên miền bên ngoài khác
 */
export function verifyCsrfProtection(request: Request, env: Env): { valid: boolean; reason?: string } {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { valid: true };
  }

  const url = new URL(request.url);
  if (url.pathname === "/api/meta/data-deletion") {
    // Meta server-to-server signed_request callback
    return { valid: true };
  }

  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const allowedHosts = new Set<string>([
    url.host.toLowerCase(),
    "pagefb.namnangno.click"
  ]);

  if (env.APP_BASE_URL) {
    try {
      allowedHosts.add(new URL(env.APP_BASE_URL).host.toLowerCase());
    } catch {
      // ignore invalid URL
    }
  }

  if (origin && origin !== "null") {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (!allowedHosts.has(originHost)) {
        return {
          valid: false,
          reason: `CSRF Protection: Origin '${origin}' không được phép gọi API thay đổi dữ liệu.`
        };
      }
    } catch {
      return { valid: false, reason: "CSRF Protection: Origin header không hợp lệ." };
    }
  } else if (referer) {
    try {
      const refHost = new URL(referer).host.toLowerCase();
      if (!allowedHosts.has(refHost)) {
        return {
          valid: false,
          reason: `CSRF Protection: Referer '${referer}' không hợp lệ.`
        };
      }
    } catch {
      return { valid: false, reason: "CSRF Protection: Referer header không hợp lệ." };
    }
  }

  return { valid: true };
}

export async function enforceAuthRateLimit(
  request: Request,
  db: D1Database,
  action: "login" | "register"
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "local";
  const key = `auth_${action}_${ip}`;
  const maxAttempts = action === "login" ? 15 : 10;
  const windowSeconds = 300; // 5 minutes
  const res = await checkRateLimit(db, key, maxAttempts, windowSeconds);
  return { allowed: res.allowed, retryAfterSeconds: res.retryAfterSeconds };
}
