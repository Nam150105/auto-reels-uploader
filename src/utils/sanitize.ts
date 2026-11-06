/**
 * Sanitization & Security Filtering Utilities
 * Tuyệt đối không để lộ Access Token, App Secret hoặc khóa mã hóa vào log hay lỗi trả về Frontend
 */

export function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Làm sạch chuỗi log/error để đảm bảo không chứa Facebook Access Token (EAA...),
 * token đã mã hóa (enc:v2:...), hoặc query param access_token=...
 */
export function sanitizeSensitiveText(input: unknown): string {
  if (input === null || input === undefined) return "";
  let text = typeof input === "string" ? input : JSON.stringify(input);

  // 1. Che chuỗi query access_token=... hoặc client_secret=...
  text = text.replace(
    /([?&](?:access_token|client_secret|appsecret_proof|fb_exchange_token)=)([^&\s"']+)/gi,
    "$1[REDACTED]"
  );

  // 2. Che chuỗi JSON "access_token": "..." hoặc "page_access_token": "..."
  text = text.replace(
    /("(?:access_token|page_access_token|client_secret|secret)"\s*:\s*")([^"]+)(")/gi,
    "$1[REDACTED]$3"
  );

  // 3. Che token Meta Graph API bắt đầu bằng EAA...
  text = text.replace(/\bEAA[A-Za-z0-9_\-]{12,}\b/g, "EAA[REDACTED_META_TOKEN]");

  // 4. Che chuỗi token mã hóa enc:v1:... / enc:v2:... / enc:v3:...
  text = text.replace(/\benc:v[123]:[A-Za-z0-9_\-=]+\b/g, "enc:[REDACTED]");

  return text;
}

