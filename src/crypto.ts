/**
 * Cloudflare Worker Web Crypto Security Module
 * - AES-256-GCM encryption for Facebook User & Page Access Tokens
 * - PBKDF2-HMAC-SHA256 password hashing (100,000 iterations)
 * - HMAC-SHA256 stateless session token signing & verification
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(base64Url: string): Uint8Array {
  let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function randomHex(byteLength = 16): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function randomUrlSafe(byteLength = 32): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const effectiveSecret = (secret || "").trim() || "cloudflare_meta_default_encryption_key_2026_v1";
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(effectiveSecret));
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts a Facebook User Access Token or Page Access Token using AES-256-GCM.
 * Output format: `enc:v2:<iv_base64url>:<ciphertext_base64url>`
 */
export async function encryptToken(plainText: string, encryptionKey: string): Promise<string> {
  if (!plainText) return "";
  if (plainText.startsWith("enc:v2:")) return plainText;

  const key = await deriveAesKey(encryptionKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const encryptedBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plainText)
  );

  return `enc:v2:${bytesToBase64Url(iv)}:${bytesToBase64Url(new Uint8Array(encryptedBuf))}`;
}

/**
 * Decrypts an AES-256-GCM encrypted token (`enc:v2:...`).
 */
export async function decryptToken(cipherText: string | null | undefined, encryptionKey: string): Promise<string | null> {
  if (!cipherText) return null;

  if (cipherText.startsWith("enc:v2:")) {
    const parts = cipherText.split(":");
    if (parts.length !== 4) return null;
    try {
      const iv = base64UrlToBytes(parts[2]);
      const data = base64UrlToBytes(parts[3]);
      const key = await deriveAesKey(encryptionKey);
      const decryptedBuf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        data
      );
      return decoder.decode(decryptedBuf);
    } catch {
      return null;
    }
  }

  // Fallback for legacy unencrypted or test tokens if not prefixed with enc:v1:
  if (cipherText.startsWith("enc:v1:")) {
    return null;
  }
  return cipherText;
}

/**
 * Masks an access token so raw secrets are never exposed in responses or logs.
 */
export function maskToken(token: string | null | undefined): string {
  if (!token || token.length < 12) return "••••••••";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

/**
 * PBKDF2-HMAC-SHA256 Password Hashing (100,000 iterations)
 */
export async function hashPassword(
  password: string,
  existingSalt?: string
): Promise<{ hash: string; salt: string }> {
  const salt = existingSalt || randomHex(16);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 100000
    },
    baseKey,
    256
  );
  return {
    hash: bytesToHex(new Uint8Array(derivedBits)),
    salt
  };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string
): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  return timingSafeEqualStr(hash, expectedHash);
}

/**
 * Generates an HMAC-SHA256 signed session token: `userId:expUnix:hexSig`
 */
export async function generateSessionToken(
  userId: string,
  secretKey: string,
  expireSeconds = 7 * 86400
): Promise<string> {
  const effectiveSecret = (secretKey || "").trim() || "meta_scheduler_secret_key_2026";
  const exp = Math.floor(Date.now() / 1000) + expireSeconds;
  const payload = `${userId}:${exp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(effectiveSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const sigHex = bytesToHex(new Uint8Array(sigBuf));
  return `${userId}:${exp}:${sigHex}`;
}

/**
 * Verifies an HMAC-SHA256 signed session token and returns the `userId` if valid and not expired.
 */
export async function verifySessionToken(
  token: string | null | undefined,
  secretKey: string
): Promise<string | null> {
  if (!token || !token.includes(":")) return null;
  const parts = token.split(":");
  if (parts.length !== 3) return null;

  const [userId, expStr, sigHex] = parts;
  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) {
    return null;
  }

  const effectiveSecret = (secretKey || "").trim() || "meta_scheduler_secret_key_2026";
  const payload = `${userId}:${expStr}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(effectiveSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedHex = bytesToHex(new Uint8Array(expectedBuf));

  if (timingSafeEqualStr(sigHex, expectedHex)) {
    return userId;
  }
  return null;
}

