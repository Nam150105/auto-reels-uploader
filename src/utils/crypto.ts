/**
 * Web Crypto Security Utilities for Cloudflare Workers
 * - AES-256-GCM Token Encryption with random 12-byte IV, Auth Tag & Versioning (enc:v2:...)
 * - Key Rotation support (rotateEncryptionKey)
 * - Safe Token Masking (maskToken)
 * - PBKDF2-HMAC-SHA256 Password Hashing with random 16-byte salt
 * - HMAC-SHA256 & SHA-256 Session Token Hashing
 */

import type { Env } from "../types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  const binary = atob(b64);
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

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function getEncryptionKeyMaterial(env?: Env): string {
  return (
    env?.TOKEN_ENCRYPTION_KEY ||
    env?.ENCRYPTION_KEY ||
    env?.SESSION_SECRET ||
    env?.SECRET_KEY ||
    "cloudflare_d1_default_token_key_2026_v2"
  );
}

export function getSessionSecretMaterial(env?: Env): string {
  return (
    env?.SESSION_SECRET ||
    env?.SECRET_KEY ||
    env?.TOKEN_ENCRYPTION_KEY ||
    "cloudflare_d1_default_session_secret_2026_v2"
  );
}

// ==========================================
// 1. PASSWORD HASHING (PBKDF2-HMAC-SHA256)
// ==========================================

export async function hashPassword(
  password: string,
  saltHex?: string,
  iterations = 100000
): Promise<string> {
  const salt = saltHex || randomHex(16);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  const hashHex = bytesToHex(new Uint8Array(derivedBits));
  return `pbkdf2_sha256$${iterations}$${salt}$${hashHex}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash) return false;
  try {
    // Support 4-part format: pbkdf2_sha256$iterations$salt$hash
    const parts = storedHash.split("$");
    if (parts.length === 4 && parts[0] === "pbkdf2_sha256") {
      const iterations = parseInt(parts[1], 10) || 100000;
      const salt = parts[2];
      const expected = await hashPassword(password, salt, iterations);
      return timingSafeEqualStr(expected, storedHash);
    }
    // Support legacy 3-part format from Python database.py: pbkdf2_sha256$salt$hash (100,000 iterations)
    if (parts.length === 3 && parts[0] === "pbkdf2_sha256") {
      const salt = parts[1];
      const hashPart = parts[2];
      const computed4 = await hashPassword(password, salt, 100000);
      const computedHashPart = computed4.split("$")[3];
      return timingSafeEqualStr(computedHashPart, hashPart);
    }
    return false;
  } catch {
    return false;
  }
}

// ==========================================
// 2. SESSION SIGNING & VERIFICATION
// ==========================================

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export async function generateSessionToken(
  userId: string,
  secretKey: string,
  sessionId?: string,
  ttlSeconds = 7 * 86400
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sid = sessionId || `ses_${randomHex(12)}`;
  const payload = `${userId}:${expiresAt}:${sid}`;
  const signature = await hmacSha256Hex(secretKey, payload);
  const rawToken = `${payload}:${signature}`;
  return bytesToBase64Url(encoder.encode(rawToken));
}

export async function verifySessionTokenDetailed(
  token: string,
  secretKey: string
): Promise<{ userId: string; expiresAt: number; sessionId: string | null } | null> {
  if (!token) return null;
  try {
    const decoded = decoder.decode(base64UrlToBytes(token));
    const parts = decoded.split(":");
    if (parts.length === 4) {
      const [userId, expiresStr, sessionId, signature] = parts;
      const expiresAt = parseInt(expiresStr, 10);
      if (isNaN(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) {
        return null;
      }
      const payload = `${userId}:${expiresStr}:${sessionId}`;
      const expectedSig = await hmacSha256Hex(secretKey, payload);
      if (!timingSafeEqualStr(signature, expectedSig)) {
        return null;
      }
      return { userId, expiresAt, sessionId };
    }
    if (parts.length === 3) {
      const [userId, expiresStr, signature] = parts;
      const expiresAt = parseInt(expiresStr, 10);
      if (isNaN(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) {
        return null;
      }
      const payload = `${userId}:${expiresStr}`;
      const expectedSig = await hmacSha256Hex(secretKey, payload);
      if (!timingSafeEqualStr(signature, expectedSig)) {
        return null;
      }
      return { userId, expiresAt, sessionId: null };
    }
    return null;
  } catch {
    return null;
  }
}

// ==========================================
// 3. AES-256-GCM TOKEN ENCRYPTION & ROTATION
// ==========================================

async function deriveAesGcmKey(rawSecret: string): Promise<CryptoKey> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawSecret));
  return crypto.subtle.importKey(
    "raw",
    hashBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function detectTokenVersion(value: string | null | undefined): string {
  if (!value) return "none";
  if (value.startsWith("enc:v3:")) return "v3";
  if (value.startsWith("enc:v2:")) return "v2";
  if (value.startsWith("enc:v1:")) return "v1";
  return "plaintext";
}

export async function encryptToken(
  plaintext: string,
  rawSecret: string,
  version: "v2" | "v3" = "v2"
): Promise<string> {
  if (!plaintext) return "";
  const prefix = `enc:${version}:`;
  if (plaintext.startsWith(prefix)) return plaintext;

  // If already encrypted with another version, decrypt not possible without key, only wrap plaintext
  const key = await deriveAesGcmKey(rawSecret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encoder.encode(plaintext)
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);

  return `${prefix}${bytesToBase64Url(combined)}`;
}

export async function decryptToken(
  ciphertext: string,
  rawSecret: string,
  fallbackSecrets: string[] = []
): Promise<string> {
  if (!ciphertext) return "";

  if (ciphertext.startsWith("enc:v2:") || ciphertext.startsWith("enc:v3:")) {
    const encoded = ciphertext.slice(7);
    const combined = base64UrlToBytes(encoded);
    if (combined.length <= 12) return "";
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    const candidateSecrets = [rawSecret, ...fallbackSecrets].filter(Boolean);
    for (const sec of candidateSecrets) {
      try {
        const key = await deriveAesGcmKey(sec);
        const plainBuffer = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, tagLength: 128 },
          key,
          data
        );
        return decoder.decode(plainBuffer);
      } catch {
        // Try next candidate key if rotation happened
      }
    }
    return "";
  }

  // Legacy Fernet token from Python meta_crypto.py (enc:v1:...) cannot be decrypted without old Fernet key
  if (ciphertext.startsWith("enc:v1:")) {
    return "";
  }

  // Unencrypted plaintext token (e.g. during legacy migration before re-encryption)
  return ciphertext;
}

export async function rotateEncryptionKey(
  ciphertext: string,
  oldSecret: string,
  newSecret: string,
  targetVersion: "v2" | "v3" = "v3"
): Promise<{ success: boolean; encrypted: string }> {
  if (!ciphertext) return { success: false, encrypted: "" };
  const plaintext = await decryptToken(ciphertext, oldSecret, [newSecret]);
  if (!plaintext) {
    return { success: false, encrypted: "" };
  }
  const reEncrypted = await encryptToken(plaintext, newSecret, targetVersion);
  return { success: true, encrypted: reEncrypted };
}

export function maskToken(token: string | null | undefined): string {
  if (!token) return "";
  const clean = String(token).trim();
  if (clean.length <= 10) return "***";
  return `${clean.slice(0, 4)}***...***${clean.slice(-4)}`;
}

