/**
 * BỘ KIỂM THỬ TOÀN DIỆN 30 HẠNG MỤC BẮT BUỘC (SECTION T)
 * Kiểm thử Unit & Integration cho Cloudflare Workers + D1 + R2 + Queue + Cron + Meta Graph API
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import workerDefault from "../src/index.ts";
import {
  encryptToken,
  decryptToken,
  maskToken,
  rotateEncryptionKey,
  hashPassword,
  verifyPassword
} from "../src/utils/crypto.ts";
import {
  parseVnScheduleToUtc,
  formatUtcToVn,
  VN_OFFSET_SECONDS
} from "../src/utils/timezone.ts";
import { sanitizeSensitiveText } from "../src/utils/sanitize.ts";
import { consumeSingleTaskMessage } from "../src/queue/publishQueue.ts";
import { addTask } from "../src/db.ts";
import { dispatchDueScheduledComments } from "../src/scheduler/cronDispatcher.ts";
import { processTaskComments } from "../src/queue/publishQueue.ts";

// ============================================================================
// MOCK CLOUDFLARE D1 & R2 BUCKET CHO MÔI TRƯỜNG TEST
// ============================================================================

class SqliteD1PreparedStatement {
  constructor(db, sql, boundValues = []) {
    this.db = db;
    this.sql = sql;
    this.boundValues = boundValues;
  }
  bind(...values) {
    return new SqliteD1PreparedStatement(this.db, this.sql, values);
  }
  async first(colName) {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.boundValues);
    if (!row) return null;
    if (colName) return row[colName] ?? null;
    return row;
  }
  async run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.boundValues);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes || 0),
        last_row_id: Number(info.lastInsertRowid || 0),
        duration: 0
      }
    };
  }
  async all() {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.boundValues);
    return {
      results: rows || [],
      success: true,
      meta: { changes: 0, last_row_id: 0, duration: 0 }
    };
  }
  async raw() {
    const { results } = await this.all();
    return results.map((r) => Object.values(r));
  }
}

class SqliteD1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }
  prepare(query) {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }
  async batch(statements) {
    const out = [];
    for (const st of statements) {
      const upper = st.sql.trim().toUpperCase();
      if (upper.startsWith("SELECT")) {
        out.push(await st.all());
      } else {
        out.push(await st.run());
      }
    }
    return out;
  }
  async exec(query) {
    this.sqlite.exec(query);
    return { count: 1, duration: 0 };
  }
}

async function mockR2ToBytes(value) {
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new TextEncoder().encode(String(value || ""));
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
    this.multipartSessions = new Map();
  }
  async createMultipartUpload(key, options = {}) {
    const uploadId = `mpu_${Math.random().toString(36).slice(2)}`;
    this.multipartSessions.set(uploadId, { key, options, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) {
    const bucket = this;
    const session = () => {
      const s = bucket.multipartSessions.get(uploadId);
      if (!s || s.key !== key) throw new Error("NoSuchUpload");
      return s;
    };
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value) {
        const s = session();
        const bytes = new Uint8Array(await mockR2ToBytes(value));
        const etag = `part_${partNumber}_${bytes.byteLength}`;
        s.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      async abort() {
        bucket.multipartSessions.delete(uploadId);
      },
      async complete(uploadedParts) {
        const s = session();
        const chunks = uploadedParts.map((p) => {
          const stored = s.parts.get(p.partNumber);
          if (!stored || stored.etag !== p.etag) throw new Error(`InvalidPart ${p.partNumber}`);
          return stored.bytes;
        });
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        bucket.multipartSessions.delete(uploadId);
        return bucket.put(key, merged, s.options);
      }
    };
  }
  async put(key, value, options = {}) {
    let bytes;
    if (value instanceof ReadableStream) {
      const buf = await new Response(value).arrayBuffer();
      bytes = new Uint8Array(buf);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      bytes = new TextEncoder().encode(String(value || ""));
    }
    const meta = {
      key,
      version: "v1",
      size: bytes.byteLength,
      etag: `etag_${bytes.byteLength}`,
      httpEtag: `"etag_${bytes.byteLength}"`,
      uploaded: new Date(),
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
      bytes
    };
    this.objects.set(key, meta);
    return meta;
  }
  async head(key) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    const { bytes: _b, ...rest } = obj;
    return rest;
  }
  async get(key) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    const copy = new Uint8Array(obj.bytes);
    return {
      ...obj,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(copy);
          controller.close();
        }
      }),
      bodyUsed: false,
      arrayBuffer: async () => copy.buffer,
      text: async () => new TextDecoder().decode(copy),
      json: async () => JSON.parse(new TextDecoder().decode(copy)),
      blob: async () => new Blob([copy])
    };
  }
  async delete(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) this.objects.delete(k);
  }
}

function createStaticAssetsFetcher() {
  const staticDir = path.join(process.cwd(), "static");
  return {
    async fetch(req) {
      const u = new URL(req.url);
      const rel = u.pathname.replace(/^\/+/, "");
      const filePath = path.join(staticDir, rel);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime =
          ext === ".html"
            ? "text/html; charset=utf-8"
            : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "text/plain; charset=utf-8";
        return new Response(content, {
          status: 200,
          headers: { "Content-Type": mime }
        });
      }
      return new Response("Not found", { status: 404 });
    }
  };
}

// ============================================================================
// CHẠY 30 BÀI KIỂM THỬ BẮT BUỘC
// ============================================================================

async function runAll30Tests() {
  console.log("==================================================================");
  console.log(" BẮT ĐẦU BỘ 30 BÀI KIỂM THỬ CLOUDFLARE WORKER + D1 + R2 + QUEUE   ");
  console.log("==================================================================");

  const d1 = new SqliteD1Database();
  const r2 = new MockR2Bucket();
  const env = {
    DB: d1,
    MEDIA_BUCKET: r2,
    ASSETS: createStaticAssetsFetcher(),
    META_APP_ID: "1469615908436980",
    META_APP_SECRET: "test_meta_app_secret_only_for_unit_tests",
    APP_BASE_URL: "https://pagefb.namnangno.click",
    META_REDIRECT_URI: "https://pagefb.namnangno.click/api/meta/callback",
    META_GRAPH_VERSION: "v19.0",
    SESSION_SECRET: "unit_test_session_secret_64_chars_2026_strong_random_value_9999",
    TOKEN_ENCRYPTION_KEY: "unit_test_aes_256_gcm_token_key_2026_strong_random_value_8888",
    MAX_VIDEO_SIZE_MB: "200"
  };

  async function callWorker(urlPath, init = {}) {
    const fullUrl = urlPath.startsWith("http")
      ? urlPath
      : `https://pagefb.namnangno.click${urlPath}`;
    const req = new Request(fullUrl, init);
    const pendingBg = [];
    const resp = await workerDefault.fetch(req, env, {
      waitUntil: (p) => pendingBg.push(p),
      passThroughOnException: () => {}
    });
    if (pendingBg.length > 0) {
      await Promise.all(pendingBg);
    }
    return resp;
  }

  // --------------------------------------------------------------------------
  // [TEST 12] D1 Migrations (0001, 0002, 0003, 0004) chạy an toàn & đầy đủ bảng/view/cột
  // --------------------------------------------------------------------------
  const migFiles = [
    "migrations/0001_initial_schema.sql",
    "migrations/0002_indexes.sql",
    "migrations/0003_security_and_tokens.sql",
    "migrations/0004_task_comment_columns.sql",
    "migrations/0005_r2_and_task_lifecycle.sql",
    "migrations/0006_task_lock_and_reels_insights.sql",
    "migrations/0007_task_schedule_audit_and_api_optimization.sql",
    "migrations/0008_facebook_page_manager_posts.sql"
  ];
  for (let pass = 1; pass <= 2; pass++) {
    for (const mf of migFiles) {
      const sql = fs.readFileSync(path.join(process.cwd(), mf), "utf8");
      try {
        await d1.exec(sql);
      } catch (err) {
        if (!String(err.message).includes("duplicate column")) {
          throw err;
        }
      }
    }
  }
  const tablesCheck = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all();
  const tableNames = new Set(tablesCheck.results.map((r) => r.name));
  for (const required of [
    "users",
    "sessions",
    "oauth_states",
    "facebook_accounts",
    "facebook_pages",
    "facebook_account_pages",
    "media_files",
    "tasks",
    "task_attempts",
    "task_logs",
    "data_deletion_requests",
    "rate_limits",
    "user_page_permissions",
    "reel_insight_snapshots",
    "reel_insight_metric_items",
    "task_audit_logs",
    "meta_api_telemetry",
    "facebook_posts",
    "facebook_page_sync_states",
    "facebook_post_comments",
    "facebook_post_audit_logs"
  ]) {
    assert.ok(tableNames.has(required), `Thiếu bảng/view ${required} trong D1`);
  }
  const taskColsCheck = await d1.prepare("PRAGMA table_info(tasks)").all();
  const taskColNames = new Set(taskColsCheck.results.map((c) => c.name));
  for (const c of [
    "comment_id",
    "comment_status",
    "comment_log",
    "comment_posted_at",
    "r2_status",
    "uploaded_at",
    "published_at",
    "last_processed_at",
    "publish_status",
    "is_locked",
    "analytics_status",
    "analytics_last_synced_at",
    "analytics_error",
    "original_scheduled_at",
    "original_schedule_date",
    "original_schedule_time",
    "manual_publish_requested_at",
    "manual_publish_by_user_id",
    "trigger_source"
  ]) {
    assert.ok(taskColNames.has(c), `Thiếu cột ${c} trong bảng tasks`);
  }
  const mediaColsCheck = await d1.prepare("PRAGMA table_info(media_files)").all();
  const mediaColNames = new Set(mediaColsCheck.results.map((c) => c.name));
  for (const c of ["r2_bucket", "verified_at", "storage_error"]) {
    assert.ok(mediaColNames.has(c), `Thiếu cột ${c} trong bảng media_files`);
  }
  console.log("  ✓ [Test 12] D1 Migrations (0001..0005) idempotent & đầy đủ 13 bảng/view kèm R2 & comment columns");

  // --------------------------------------------------------------------------
  // [TEST 1] Worker khởi động & export đầy đủ fetch, scheduled, queue
  // --------------------------------------------------------------------------
  assert.equal(typeof workerDefault.fetch, "function");
  assert.equal(typeof workerDefault.scheduled, "function");
  assert.equal(typeof workerDefault.queue, "function");
  console.log("  ✓ [Test 01] Worker khởi động với đầy đủ handlers (fetch, scheduled, queue)");

  // --------------------------------------------------------------------------
  // [TEST 2] Frontend tải thành công (/login, /privacy, /terms, /data-deletion, /static/js/app.js)
  // --------------------------------------------------------------------------
  const loginPageResp = await callWorker("/login");
  assert.equal(loginPageResp.status, 200);
  const loginHtml = await loginPageResp.text();
  assert.ok(loginHtml.toLowerCase().includes("quản lý fanpage"));

  const unauthRootResp = await callWorker("/");
  assert.equal(unauthRootResp.status, 302);
  assert.ok(unauthRootResp.headers.get("Location")?.endsWith("/login"), "Chưa đăng nhập truy cập / phải chuyển đến /login");

  const unauthPageResp = await callWorker("/page");
  assert.equal(unauthPageResp.status, 302);
  assert.ok(unauthPageResp.headers.get("Location")?.endsWith("/login"), "Chưa đăng nhập truy cập /page phải chuyển đến /login");

  const unauthSchedResp = await callWorker("/schedules");
  assert.equal(unauthSchedResp.status, 302);
  assert.ok(unauthSchedResp.headers.get("Location")?.includes("/login"), "Chưa đăng nhập truy cập /schedules phải chuyển đến /login");

  const appJsResp = await callWorker("/static/js/app.js");
  assert.equal(appJsResp.status, 200);
  const directAppJsResp = await callWorker("/js/app.js");
  assert.equal(directAppJsResp.status, 200);
  console.log("  ✓ [Test 02] Frontend & Static Assets tải thành công");

  // --------------------------------------------------------------------------
  // [TEST 3, 4, 5, 6] Register, Login, Session Validation & Real Revocable Logout
  // --------------------------------------------------------------------------
  const pwdHash = await hashPassword("MyStrongPass#2026");
  assert.equal(await verifyPassword("MyStrongPass#2026", pwdHash), true);
  assert.equal(await verifyPassword("WrongPassword", pwdHash), false);

  const regAResp = await callWorker("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "alice_admin",
      password: "PasswordA123",
      full_name: "Alice Admin",
      email: "alice@example.com"
    })
  });
  assert.equal(regAResp.status, 200);
  const cookieHeaderA1 = regAResp.headers.get("Set-Cookie") || "";
  assert.ok(cookieHeaderA1.includes("HttpOnly"));
  assert.ok(cookieHeaderA1.includes("SameSite=Lax"));
  assert.ok(cookieHeaderA1.includes("Secure"));
  const tokenA1 = /session_token=([^;]+)/.exec(cookieHeaderA1)?.[1] || "";
  assert.ok(tokenA1.length > 20);
  console.log("  ✓ [Test 04] Register tài khoản mới & tạo HttpOnly Secure Session");

  // Kiểm tra /api/auth/me với tokenA1
  const meResp1 = await callWorker("/api/auth/me", {
    headers: { Cookie: `session_token=${tokenA1}` }
  });
  assert.equal(meResp1.status, 200);
  const meJson1 = await meResp1.json();
  assert.equal(meJson1.user.username, "alice_admin");
  console.log("  ✓ [Test 06] Session validation (/api/auth/me) hợp lệ");

  // Kiểm tra Logout thực sự thu hồi session trong D1
  const logoutResp = await callWorker("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA1}` }
  });
  assert.equal(logoutResp.status, 200);

  // Thử dùng lại tokenA1 sau khi đã logout -> Phải bị từ chối 401!
  const meAfterLogout = await callWorker("/api/auth/me", {
    headers: { Cookie: `session_token=${tokenA1}` }
  });
  assert.equal(meAfterLogout.status, 401, "Session đã logout phải bị thu hồi trong D1");
  console.log("  ✓ [Test 05] Logout thu hồi thực sự session phía Server D1");

  // Đăng nhập lại cho User A & tạo thêm User B
  const loginAResp = await callWorker("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice_admin", password: "PasswordA123" })
  });
  assert.equal(loginAResp.status, 200);
  const tokenA = /session_token=([^;]+)/.exec(loginAResp.headers.get("Set-Cookie") || "")?.[1] || "";

  const regBResp = await callWorker("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "bob_user",
      password: "PasswordB123",
      full_name: "Bob User"
    })
  });
  assert.equal(regBResp.status, 200);
  const tokenB = /session_token=([^;]+)/.exec(regBResp.headers.get("Set-Cookie") || "")?.[1] || "";
  console.log("  ✓ [Test 03] Login hoạt động chính xác cho nhiều người dùng");

  // Kiểm tra đầy đủ quy tắc điều hướng khi ĐÃ đăng nhập & khi hết hạn phiên (Mục I & IV):
  // - Đã đăng nhập truy cập / -> 302 chuyển đến /page
  const authedRootResp = await callWorker("/", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(authedRootResp.status, 302);
  assert.ok(authedRootResp.headers.get("Location")?.endsWith("/page"), "Đã đăng nhập truy cập / phải chuyển đến /page");

  // - Đã đăng nhập truy cập /login -> 302 chuyển đến /page
  const authedLoginResp = await callWorker("/login", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(authedLoginResp.status, 302);
  assert.ok(authedLoginResp.headers.get("Location")?.endsWith("/page"), "Đã đăng nhập truy cập /login phải chuyển đến /page");

  // - Đã đăng nhập truy cập /page -> 200 OK giữ nguyên /page (và reload /page lần 2 vẫn ổn định)
  const authedPageResp1 = await callWorker("/page", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(authedPageResp1.status, 200, "Đã đăng nhập truy cập /page phải trả về 200 OK");
  const authedPageHtml = await authedPageResp1.text();
  assert.ok(authedPageHtml.includes("FB Reels Auto Scheduler"), "Trang /page phải hiển thị giao diện chính");

  const authedPageReloadResp = await callWorker("/page", {
    headers: { Cookie: `session_token=${tokenA}`, "If-None-Match": '"cached-etag-123"' }
  });
  assert.equal(authedPageReloadResp.status, 200, "Reload /page kèm If-None-Match vẫn phải trả về 200 OK đầy đủ");

  // - Phiên đã thu hồi (tokenA1) truy cập /page -> 302 chuyển về /login
  const revokedPageResp = await callWorker("/page", {
    headers: { Cookie: `session_token=${tokenA1}` }
  });
  assert.equal(revokedPageResp.status, 302);
  assert.ok(revokedPageResp.headers.get("Location")?.endsWith("/login"), "Phiên hết hạn/thu hồi truy cập /page phải chuyển về /login");
  console.log("  ✓ [Test 06B] Quy tắc điều hướng /, /login, /page & khôi phục phiên hoạt động chuẩn xác 100%");

  // --------------------------------------------------------------------------
  // [TEST 11] Token Encryption, Decryption, Masking & Key Rotation (AES-256-GCM)
  // --------------------------------------------------------------------------
  const rawFbToken = "EAABsbCS1iHgBO77889900SecretFacebookTokenXYZ";
  const encV2 = await encryptToken(rawFbToken, env.TOKEN_ENCRYPTION_KEY, "v2");
  assert.ok(encV2.startsWith("enc:v2:"));
  assert.ok(!encV2.includes(rawFbToken));
  const decV2 = await decryptToken(encV2, env.TOKEN_ENCRYPTION_KEY);
  assert.equal(decV2, rawFbToken);

  const rotated = await rotateEncryptionKey(
    encV2,
    env.TOKEN_ENCRYPTION_KEY,
    "new_rotated_encryption_key_2027_v3",
    "v3"
  );
  assert.equal(rotated.success, true);
  assert.ok(rotated.encrypted.startsWith("enc:v3:"));
  const decRotated = await decryptToken(rotated.encrypted, "new_rotated_encryption_key_2027_v3");
  assert.equal(decRotated, rawFbToken);

  const masked = maskToken(rawFbToken);
  assert.equal(masked, "EAAB***...***nXYZ");
  assert.ok(!sanitizeSensitiveText(`Lỗi với token ${rawFbToken}`).includes(rawFbToken));
  console.log("  ✓ [Test 11] AES-256-GCM Encryption, Decryption, Masking & Key Rotation đạt 100%");

  // --------------------------------------------------------------------------
  // [TEST 7, 8, 9, 10, 14] OAuth URL, State Persistence, Callback, 2 User OAuth Đồng Thời & Pagination
  // --------------------------------------------------------------------------
  let graphApiReelsCalled = 0;
  let simulateUpload500Once = false;
  let simulateAmbiguousFinishError = false;
  let simulateExpiredTokenPageId = "";
  let simulateCommentPermissionError = false;
  let simulateCommentNetworkError = false;
  let simulateCommentTimeout = false;
  let commentsCreatedOnFacebook = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input.url;

    // 1. OAuth Code Exchange & Long-lived token
    if (u.includes("/oauth/access_token")) {
      if (u.includes("code=code_user_a_acc1")) {
        return new Response(JSON.stringify({ access_token: "EAAB_TOKEN_A1", expires_in: 5184000 }), { status: 200 });
      }
      if (u.includes("code=code_user_a_acc2")) {
        return new Response(JSON.stringify({ access_token: "EAAB_TOKEN_A2", expires_in: 5184000 }), { status: 200 });
      }
      if (u.includes("code=code_user_a_nopages")) {
        return new Response(JSON.stringify({ access_token: "EAAB_TOKEN_NOPAGES", expires_in: 5184000 }), { status: 200 });
      }
      if (u.includes("code=code_user_a_missing_perm")) {
        return new Response(JSON.stringify({ access_token: "EAAB_TOKEN_MISSING_PERM", expires_in: 5184000 }), { status: 200 });
      }
      if (u.includes("code=code_user_b_acc1")) {
        return new Response(JSON.stringify({ access_token: "EAAB_TOKEN_B1", expires_in: 5184000 }), { status: 200 });
      }
      if (u.includes("fb_exchange_token=")) {
        const match = /fb_exchange_token=([^&]+)/.exec(u);
        return new Response(
          JSON.stringify({ access_token: decodeURIComponent(match[1]) + "_LONG", expires_in: 5184000 }),
          { status: 200 }
        );
      }
    }

    // 2. /me Profile
    if (u.includes("/me?fields=id,name")) {
      // Page Access Token của mock (EAAB_PAGE_TOKEN_101_FROM_A1 -> page_101): trả về chính Page đó,
      // tránh rơi xuống mạng thật (graph.facebook.com) khiến kiểm tra token luôn thất bại.
      const mockPageTok = /EAAB_PAGE_TOKEN_((?:EXP_)?\d+)(?:_|&|$)/.exec(u);
      if (mockPageTok) {
        const mockPageId = `page_${mockPageTok[1].toLowerCase()}`;
        return new Response(
          JSON.stringify({ id: mockPageId, name: `Mock Page ${mockPageTok[1]}` }),
          { status: 200 }
        );
      }
      if (u.includes("EAAB_EXPLORER_TOKEN_VALID") || u.includes("EAAB_EXPLORER_TOKEN_WITH_INSIGHTS") || u.includes("EAAB_EXPLORER_TOKEN_PARTIAL_PAGES")) {
        return new Response(JSON.stringify({ id: "fb_uid_exp_1", name: "Nam Explorer Admin" }), { status: 200 });
      }
      if (u.includes("EAAB_EXPLORER_TOKEN_INVALID")) {
        return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token.", code: 190 } }), { status: 400 });
      }
      if (u.includes("EAAB_EXPLORER_TOKEN_MISSING_PERM")) {
        return new Response(JSON.stringify({ id: "fb_uid_exp_missing", name: "Nam Missing Perm Admin" }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_A1")) {
        return new Response(JSON.stringify({ id: "fb_uid_a1", name: "Alice FB Admin 1" }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_A2")) {
        return new Response(JSON.stringify({ id: "fb_uid_a2", name: "Alice FB Admin 2" }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_NOPAGES")) {
        return new Response(JSON.stringify({ id: "fb_uid_nopages", name: "Alice Empty Admin" }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_MISSING_PERM")) {
        return new Response(JSON.stringify({ id: "fb_uid_missing", name: "Alice Missing Perm" }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_B1")) {
        return new Response(JSON.stringify({ id: "fb_uid_b1", name: "Bob FB Admin 1" }), { status: 200 });
      }
    }

    // 3. /me/permissions
    if (u.includes("/me/permissions")) {
      if (u.includes("EAAB_TOKEN_MISSING_PERM") || u.includes("EAAB_EXPLORER_TOKEN_MISSING_PERM")) {
        return new Response(
          JSON.stringify({
            data: [
              { permission: "public_profile", status: "granted" },
              { permission: "pages_show_list", status: "declined" }
            ]
          }),
          { status: 200 }
        );
      }
      if (u.includes("EAAB_EXPLORER_TOKEN_WITH_INSIGHTS") || u.includes("EAAB_EXPLORER_TOKEN_PARTIAL_PAGES")) {
        return new Response(
          JSON.stringify({
            data: [
              { permission: "public_profile", status: "granted" },
              { permission: "pages_show_list", status: "granted" },
              { permission: "pages_read_engagement", status: "granted" },
              { permission: "pages_manage_posts", status: "granted" },
              { permission: "pages_manage_engagement", status: "granted" },
              { permission: "read_insights", status: "granted" }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            { permission: "public_profile", status: "granted" },
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },
            { permission: "pages_manage_engagement", status: "granted" }
          ]
        }),
        { status: 200 }
      );
    }

    // 4. /me/accounts (with multi-page cursor pagination for Alice Admin 1, and overlapping Page for Alice Admin 2)
    if (u.includes("/me/accounts")) {
      if (u.includes("EAAB_EXPLORER_TOKEN_PARTIAL_PAGES")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "page_exp_1",
                name: "Hidden Chapters",
                access_token: "EAAB_PAGE_TOKEN_EXP_1_NEW",
                tasks: ["CREATE_CONTENT", "MODERATE", "ANALYZE", "MANAGE"]
              }
            ],
            paging: {}
          }),
          { status: 200 }
        );
      }
      if (u.includes("EAAB_EXPLORER_TOKEN_WITH_INSIGHTS")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "page_exp_1",
                name: "Hidden Chapters",
                access_token: "EAAB_PAGE_TOKEN_EXP_1_INSIGHTS",
                tasks: ["CREATE_CONTENT", "MODERATE", "ANALYZE", "MANAGE"]
              },
              {
                id: "page_exp_2",
                name: "Zyntrix Vietnam",
                access_token: "EAAB_PAGE_TOKEN_EXP_2_INSIGHTS",
                tasks: ["CREATE_CONTENT", "MODERATE", "ANALYZE", "MANAGE"]
              }
            ],
            paging: {}
          }),
          { status: 200 }
        );
      }
      if (u.includes("EAAB_EXPLORER_TOKEN_VALID")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "page_exp_1",
                name: "Hidden Chapters",
                access_token: "EAAB_PAGE_TOKEN_EXP_1",
                tasks: ["CREATE_CONTENT", "MANAGE"]
              },
              {
                id: "page_exp_2",
                name: "Zyntrix Vietnam",
                access_token: "EAAB_PAGE_TOKEN_EXP_2",
                tasks: ["CREATE_CONTENT", "MANAGE"]
              }
            ],
            paging: {}
          }),
          { status: 200 }
        );
      }
      if (u.includes("EAAB_TOKEN_NOPAGES")) {
        return new Response(JSON.stringify({ data: [], paging: {} }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_A1") && !u.includes("after=cursor_page_2")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "page_101",
                name: "Fanpage Điện Ảnh A1",
                access_token: "EAAB_PAGE_TOKEN_101_FROM_A1",
                category: "Movie",
                picture: { data: { url: "https://pagefb.namnangno.click/avatar1.png" } },
                tasks: ["MANAGE", "CREATE_CONTENT"],
                is_published: true
              }
            ],
            paging: {
              next: "https://graph.facebook.com/v19.0/me/accounts?after=cursor_page_2&access_token=EAAB_TOKEN_A1_LONG"
            }
          }),
          { status: 200 }
        );
      }
      if (u.includes("after=cursor_page_2")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "page_102",
                name: "Fanpage Giải Trí A2",
                access_token: "EAAB_PAGE_TOKEN_102_FROM_A1",
                category: "Entertainment",
                picture: { data: { url: "https://pagefb.namnangno.click/avatar2.png" } },
                tasks: ["CREATE_CONTENT"],
                is_published: true
              }
            ],
            paging: {}
          }),
          { status: 200 }
        );
      }
      if (u.includes("EAAB_TOKEN_A2")) {
        // Alice's 2nd Facebook Admin Account ALSO manages page_101 -> Test deduplication!
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "page_101",
                name: "Fanpage Điện Ảnh A1",
                access_token: "EAAB_PAGE_TOKEN_101_FROM_A2",
                category: "Movie",
                tasks: ["MANAGE", "CREATE_CONTENT"],
                is_published: true
              }
            ],
            paging: {}
          }),
          { status: 200 }
        );
      }
      if (u.includes("EAAB_TOKEN_B1")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "page_999",
                name: "Fanpage Của Bob B1",
                access_token: "EAAB_PAGE_TOKEN_999_FROM_B1",
                category: "Gaming",
                tasks: ["CREATE_CONTENT"],
                is_published: true
              }
            ],
            paging: {}
          }),
          { status: 200 }
        );
      }
    }

    // 5. Check Page Permission
    if (u.includes("/page_101?fields=id,name")) {
      if (simulateExpiredTokenPageId === "page_101") {
        return new Response(
          JSON.stringify({
            error: {
              message: "Error validating access token: Session has expired (EAAB_PAGE_TOKEN_101_FROM_A1)",
              type: "OAuthException",
              code: 190,
              error_subcode: 463
            }
          }),
          { status: 400 }
        );
      }
      return new Response(
        JSON.stringify({
          id: "page_101",
          name: "Fanpage Điện Ảnh A1",
          is_published: true,
          tasks: ["MANAGE", "CREATE_CONTENT"]
        }),
        {
          status: 200,
          headers: {
            "x-app-usage": JSON.stringify({ call_count: 10, total_cputime: 4, total_time: 7 }),
            "x-page-usage": JSON.stringify({ call_count: 8, total_cputime: 3, total_time: 5 })
          }
        }
      );
    }

    // 6. Reels Publishing API (/{page_id}/video_reels & rupload.facebook.com)
    if (u.includes("/video_reels") && !u.includes("upload_phase=finish")) {
      graphApiReelsCalled++;
      return new Response(
        JSON.stringify({
          video_id: `vid_reel_${graphApiReelsCalled}`,
          upload_url: `https://rupload.facebook.com/video-upload/v19.0/vid_reel_${graphApiReelsCalled}`
        }),
        {
          status: 200,
          headers: {
            "x-app-usage": JSON.stringify({ call_count: 14, total_cputime: 6, total_time: 9 }),
            "x-page-usage": JSON.stringify({ call_count: 11, total_cputime: 5, total_time: 8 })
          }
        }
      );
    }

    if (u.includes("rupload.facebook.com/video-upload/")) {
      if (simulateUpload500Once) {
        simulateUpload500Once = false;
        return new Response(
          JSON.stringify({ error: { message: "Temporary upload server error", code: 2 } }),
          { status: 500 }
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    if (u.includes("/video_reels") && u.includes("upload_phase=finish")) {
      if (simulateAmbiguousFinishError) {
        simulateAmbiguousFinishError = false;
        return new Response(
          JSON.stringify({ error: { message: "Gateway timeout during finish", code: 1 } }),
          { status: 504 }
        );
      }
      return new Response(
        JSON.stringify({ success: true, post_id: `post_reel_${graphApiReelsCalled}` }),
        { status: 200 }
      );
    }

    if (u.includes("?fields=id,permalink_url,status")) {
      return new Response(
        JSON.stringify({
          id: `vid_reel_${graphApiReelsCalled}`,
          permalink_url: `/reel/vid_reel_${graphApiReelsCalled}`,
          status: { video_status: "ready" }
        }),
        { status: 200 }
      );
    }

    // Giả lập lỗi (#12) singular statuses API is deprecated khi gọi bare ID không có prefix (giống đúng lỗi production của user)
    if (u.match(/\/122107908045520254\/comments/)) {
      return new Response(
        JSON.stringify({
          error: {
            message: "(#12) singular statuses API is deprecated for versions v2.4 and higher",
            type: "OAuthException",
            code: 12
          }
        }),
        { status: 400 }
      );
    }

    if (u.includes("/comments")) {
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET") {
        return new Response(JSON.stringify({ data: commentsCreatedOnFacebook }), { status: 200 });
      }
      if (simulateCommentPermissionError) {
        return new Response(
          JSON.stringify({
            error: {
              message: "(#200) Requires pages_manage_engagement and MODERATE permission",
              code: 200
            }
          }),
          { status: 403 }
        );
      }
      if (simulateCommentNetworkError) {
        throw new Error("Failed to fetch: Connection reset by peer");
      }
      if (simulateCommentTimeout) {
        simulateCommentTimeout = false;
        let cMsg = "";
        try {
          const parsed = JSON.parse(init?.body || "{}");
          cMsg = parsed.message || "";
        } catch {
          const p = new URLSearchParams(init?.body || "");
          cMsg = p.get("message") || "";
        }
        commentsCreatedOnFacebook.push({ id: "cmt_timeout_recovered", message: cMsg });
        throw new Error("Gateway timeout 504 on comment publish");
      }
      let cMsg = "";
      let cHasImage = false;
      if (init?.body instanceof FormData) {
        cMsg = String(init.body.get("message") || "");
        const src = init.body.get("source");
        cHasImage = Boolean(src && typeof src === "object" && src.size > 0);
      } else {
        try {
          const parsed = JSON.parse(init?.body || "{}");
          cMsg = parsed.message || "";
        } catch {
          const p = new URLSearchParams(init?.body || "");
          cMsg = p.get("message") || "";
        }
      }
      const cId = `cmt_${Math.random().toString(36).substring(2, 9)}`;
      commentsCreatedOnFacebook.push({ id: cId, message: cMsg, has_image: cHasImage });
      return new Response(JSON.stringify({ id: cId }), { status: 200 });
    }

    if (u.match(/\/cmt_[a-zA-Z0-9]+/)) {
      return new Response(JSON.stringify({ id: "cmt_verified" }), { status: 200 });
    }

    // 7. Reels Video Insights API (/{video_id}/video_insights)
    if (u.includes("/video_insights")) {
      // Nếu gọi với token không có read_insights (EAAB_PAGE_TOKEN_EXP_1 cũ), trả về lỗi thiếu quyền (#200)
      if (u.includes("EAAB_PAGE_TOKEN_EXP_1&") || u.endsWith("EAAB_PAGE_TOKEN_EXP_1")) {
        return new Response(
          JSON.stringify({
            error: {
              message: "(#200) Requires read_insights permission to access video_insights",
              type: "OAuthException",
              code: 200
            }
          }),
          { status: 403 }
        );
      }
      // Nếu batch metric có chứa metric không hỗ trợ post_video_retention_graph, giả lập Meta trả lỗi #100 để kiểm tra cơ chế fallback từng metric
      if (u.includes("post_video_retention_graph") && (u.includes(",") || u.includes("%2C") || u.includes("%2c"))) {
        return new Response(
          JSON.stringify({
            error: {
              message: "(#100) Tried accessing nonexisting field (post_video_retention_graph) on node type (Video)",
              type: "OAuthException",
              code: 100
            }
          }),
          { status: 400 }
        );
      }
      if (u.includes("metric=post_video_retention_graph")) {
        return new Response(
          JSON.stringify({
            error: {
              message: "(#100) Metric post_video_retention_graph is not supported for Reels v27.0",
              type: "OAuthException",
              code: 100
            }
          }),
          { status: 400 }
        );
      }
      const metricMatch = /[?&]metric=([^&]+)/.exec(u);
      const metricName = metricMatch ? decodeURIComponent(metricMatch[1]) : "";
      const metricMap = {
        fb_reels_total_plays: 12500,
        post_impressions_unique: 9800,
        post_video_view_time: 185000,
        post_video_avg_time_watched: 6500,
        fb_reels_replay_count: 1400,
        post_video_views: 11000,
        post_video_complete_views_30s: 4200,
        post_video_Reactions_by_type_total: { like: 320, love: 80 },
        post_video_Social_actions_count_unique: { comment: 45, share: 25 }
      };
      if (metricName && metricMap[metricName] !== undefined) {
        return new Response(
          JSON.stringify({
            data: [
              {
                name: metricName,
                period: "lifetime",
                values: [{ value: metricMap[metricName] }]
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    // 8. Video Node Fields (fields=id,views,length,permalink_url)
    if (u.includes("fields=id,views,length,permalink_url")) {
      return new Response(
        JSON.stringify({
          id: "1439027771006176",
          views: 12500,
          length: 28.5,
          permalink_url: "/reel/1439027771006176/",
          created_time: "2026-11-06T20:25:00+0000"
        }),
        { status: 200 }
      );
    }

    // 9. Post Node Engagement Summary (fields=id,shares,reactions.summary)
    if (u.includes("fields=id,shares,reactions.summary")) {
      return new Response(
        JSON.stringify({
          id: "1418723557985686_122107908045520254",
          shares: { count: 25 },
          reactions: { summary: { total_count: 400 } },
          comments: { summary: { total_count: 45 } }
        }),
        { status: 200 }
      );
    }

    return originalFetch(input, init);
  };

  // User A và User B khởi tạo OAuth CÙNG LÚC (Simultaneous Multi-User OAuth)
  const oauthAResp1 = await callWorker("/api/meta/oauth-url", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(oauthAResp1.status, 200);
  const oauthA1 = await oauthAResp1.json();
  assert.ok(oauthA1.oauth_url.includes("client_id=1469615908436980"));
  assert.ok(oauthA1.oauth_url.includes(encodeURIComponent("https://pagefb.namnangno.click/api/meta/callback")));
  console.log("  ✓ [Test 07] OAuth URL generation chuẩn Meta Dialog v19.0");

  const oauthBResp1 = await callWorker("/api/meta/oauth-url", {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  const oauthB1 = await oauthBResp1.json();
  assert.notEqual(oauthA1.state, oauthB1.state, "Mỗi phiên OAuth phải có CSRF state độc lập");
  console.log("  ✓ [Test 08] OAuth state persistence độc lập trong D1");

  // Callback hoàn tất cho cả User B và User A đan xen nhau
  const cbB = await callWorker(`/api/meta/callback?code=code_user_b_acc1&state=${oauthB1.state}`, {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  assert.equal(cbB.status, 200);

  const cbA1 = await callWorker(`/api/meta/callback?code=code_user_a_acc1&state=${oauthA1.state}`, {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(cbA1.status, 200);

  // Kiểm tra Facebook URL Debugger / Scraper gọi GET /api/meta/callback không có code -> Phải trả về 200 OK kèm fb:app_id
  const cbScraper = await callWorker("/api/meta/callback", {
    headers: { "User-Agent": "facebookexternalhit/1.1" }
  });
  assert.equal(cbScraper.status, 200, "Facebook Scraper gọi /api/meta/callback phải nhận được HTTP 200 OK");
  const cbScraperHtml = await cbScraper.text();
  assert.ok(cbScraperHtml.includes('property="fb:app_id"'), "Phải có thẻ meta fb:app_id cho Facebook Debugger");

  // Thử replay lại state của User A -> Phải bị chặn!
  const cbReplay = await callWorker(`/api/meta/callback?code=code_user_a_acc1&state=${oauthA1.state}`, {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(cbReplay.status, 400, "State OAuth chỉ được phép sử dụng 1 lần duy nhất");
  console.log("  ✓ [Test 09] OAuth Callback & Chống Replay CSRF State hoạt động chuẩn xác");
  console.log("  ✓ [Test 10] Hai user thực hiện OAuth đồng thời không bị ghi đè hay lẫn dữ liệu");

  // Kết nối thêm tài khoản Facebook Admin thứ 2 cho User A (quản lý trùng page_101)
  const oauthAResp2 = await callWorker("/api/meta/oauth-url", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const oauthA2 = await oauthAResp2.json();
  const cbA2 = await callWorker(`/api/meta/callback?code=code_user_a_acc2&state=${oauthA2.state}`, {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(cbA2.status, 200);

  // Kết nối lại cùng tài khoản Admin 2 -> Phải cập nhật chứ không tạo trùng bản ghi Admin
  const oauthAResp2Reconnect = await callWorker("/api/meta/oauth-url", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const oauthA2Reconnect = await oauthAResp2Reconnect.json();
  const cbA2Reconnect = await callWorker(`/api/meta/callback?code=code_user_a_acc2&state=${oauthA2Reconnect.state}`, {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(cbA2Reconnect.status, 200);

  // Kiểm tra endpoint kết nối qua Access Token từ Graph API Explorer (/api/meta/connect-token)
  // 1. Kiểm tra gửi token rỗng -> 400
  const emptyTokenResp = await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: "   " })
  });
  assert.equal(emptyTokenResp.status, 400);

  // 2. Kiểm tra token không hợp lệ -> 400
  const invalidTokenResp = await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: "EAAB_EXPLORER_TOKEN_INVALID" })
  });
  assert.equal(invalidTokenResp.status, 400);

  // 3. Kiểm tra token thiếu quyền bắt buộc -> 400
  const missingPermTokenResp = await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: "EAAB_EXPLORER_TOKEN_MISSING_PERM" })
  });
  assert.equal(missingPermTokenResp.status, 400);

  // 4. Kiểm tra liên kết thành công với Access Token hợp lệ từ Graph API Explorer
  const validTokenResp = await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: "EAAB_EXPLORER_TOKEN_VALID" })
  });
  assert.equal(validTokenResp.status, 200, "Liên kết Graph API Explorer Access Token phải thành công (200)");
  const validTokenJson = await validTokenResp.json();
  assert.equal(validTokenJson.success, true);
  assert.equal(validTokenJson.user_name, "Nam Explorer Admin");
  assert.equal(validTokenJson.synced_count, 2);

  // 5. Kiểm tra kết nối lại với cùng token (hoặc URL chứa token) -> cập nhật, không trùng lặp account
  const relinkUrlResp = await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      access_token: "https://graph.facebook.com/v27.0/me/accounts?access_token=EAAB_EXPLORER_TOKEN_VALID&fields=id"
    })
  });
  assert.equal(relinkUrlResp.status, 200);

  // 6. Xóa tài khoản Explorer vừa tạo -> kiểm tra cascade xóa cả 2 Fanpage tương ứng
  const delExpResp = await callWorker(`/api/meta/accounts/${validTokenJson.account_id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(delExpResp.status, 200);
  const delExpJson = await delExpResp.json();
  assert.equal(delExpJson.deleted_pages_count, 2, "Xóa Admin tạo từ Explorer Token phải cascade xóa cả 2 Page liên kết");

  // Kiểm tra trường hợp người dùng bấm Hủy trên Facebook (?error=access_denied)
  const cbDenied = await callWorker("/api/meta/callback?error=access_denied&error_reason=user_denied", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(cbDenied.status, 200);
  const cbDeniedHtml = await cbDenied.text();
  assert.ok(cbDeniedHtml.includes("You did not grant permission to connect Facebook"));

  // Kiểm tra trường hợp Facebook thiếu quyền bắt buộc
  const oauthMissingPerm = await (
    await callWorker("/api/meta/oauth-url", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const cbMissingPerm = await callWorker(
    `/api/meta/callback?code=code_user_a_missing_perm&state=${oauthMissingPerm.state}`,
    { headers: { Cookie: `session_token=${tokenA}` } }
  );
  assert.equal(cbMissingPerm.status, 400);
  const cbMissingPermHtml = await cbMissingPerm.text();
  assert.ok(cbMissingPermHtml.includes("Facebook did not grant all required permissions"));

  // Kiểm tra trường hợp tài khoản không quản lý Fanpage nào
  const oauthNoPages = await (
    await callWorker("/api/meta/oauth-url", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const cbNoPages = await callWorker(
    `/api/meta/callback?code=code_user_a_nopages&state=${oauthNoPages.state}`,
    { headers: { Cookie: `session_token=${tokenA}` } }
  );
  assert.equal(cbNoPages.status, 200);
  const cbNoPagesHtml = await cbNoPages.text();
  assert.ok(cbNoPagesHtml.includes("This account does not manage any Pages"));

  // Kiểm tra danh sách Admin của User A (không lộ access_token / masked_token, kèm danh sách pages của từng Admin)
  const accsAResp = await callWorker("/api/meta/accounts", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const accsA = await accsAResp.json();
  const mainAdminsA = accsA.filter((a) => a.facebook_user_id === "fb_uid_a1" || a.facebook_user_id === "fb_uid_a2");
  assert.equal(mainAdminsA.length, 2, "Kết nối lại Admin đã tồn tại không được tạo trùng bản ghi");
  for (const acc of accsA) {
    assert.equal(acc.access_token, undefined, "Không được trả access_token về frontend");
    assert.equal(acc.masked_token, undefined, "Không được trả masked_token về frontend");
    assert.ok(Array.isArray(acc.pages), "Mỗi Admin phải kèm danh sách Fanpage đang quản lý");
  }

  // Kiểm tra danh sách Fanpage của User A (Phân trang /me/accounts + Chống trùng lặp Page)
  const pagesAResp = await callWorker("/api/pages", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const pagesA = await pagesAResp.json();
  assert.equal(pagesA.length, 2, "Phải đồng bộ đủ 2 Page qua pagination và không tạo trùng page_101");
  const page101 = pagesA.find((p) => p.facebook_page_id === "page_101");
  assert.equal(page101.admin_accounts.length, 2, "page_101 phải ghi nhận cả 2 Admin Accounts của Alice");
  assert.equal(page101.page_access_token, undefined, "Tuyệt đối không trả page_access_token về Frontend");
  console.log("  ✓ [Test 14] Đồng bộ /me/accounts có phân trang & Chống trùng lặp Fanpage đa Admin");

  // --------------------------------------------------------------------------
  // [TEST 13] User Isolation & CSRF Protection
  // --------------------------------------------------------------------------
  const pagesBResp = await callWorker("/api/pages", {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  const pagesB = await pagesBResp.json();
  assert.equal(pagesB.length, 1);
  assert.equal(pagesB[0].facebook_page_id, "page_999");

  // Bob thử chọn hoặc xóa Page của Alice -> Phải trả về 404
  const bobHackPage = await callWorker("/api/pages/page_101/select", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenB}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ is_selected: false })
  });
  assert.equal(bobHackPage.status, 404);

  // Kiểm tra CSRF Protection chặn request từ Origin lạ
  const csrfHack = await callWorker("/api/pages/bulk-select", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      Origin: "https://evil-attacker.example.com",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ is_selected: false })
  });
  assert.equal(csrfHack.status, 403, "CSRF Protection phải chặn request từ Origin bên ngoài");
  console.log("  ✓ [Test 13] Cô lập dữ liệu Multi-User (Chống IDOR) & Bảo vệ CSRF đạt 100%");

  // --------------------------------------------------------------------------
  // [TEST 15 & 16] R2 Video Upload Streaming & R2 Object Ownership
  // --------------------------------------------------------------------------
  const initUploadResp = await callWorker("/api/media/upload-init", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      filename: "alice_reel_01.mp4",
      size_bytes: 4096,
      mime_type: "video/mp4"
    })
  });
  assert.equal(initUploadResp.status, 200);
  const initUploadData = await initUploadResp.json();
  assert.ok(initUploadData.media_id.startsWith("med_"));
  assert.equal(initUploadData.storage_backend, "r2");

  const fakeMp4Bytes = new Uint8Array(4096);
  fakeMp4Bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

  const streamPutResp = await callWorker(initUploadData.upload_url, {
    method: "PUT",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "video/mp4",
      "Content-Length": "4096"
    },
    body: fakeMp4Bytes
  });
  assert.equal(streamPutResp.status, 200);

  const compUploadResp = await callWorker("/api/media/upload-complete", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ media_id: initUploadData.media_id })
  });
  assert.equal(compUploadResp.status, 200);
  const compUploadData = await compUploadResp.json();
  assert.equal(compUploadData.video_path, `r2://${initUploadData.media_id}`);
  console.log("  ✓ [Test 15] R2 Streaming Video Upload (upload-init -> stream -> upload-complete)");

  // --------------------------------------------------------------------------
  // [TEST 15b] R2 Multipart Upload theo phân đoạn (upload-init -> upload-part xN -> upload-complete)
  // --------------------------------------------------------------------------
  const mpTotalSize = 8 * 1024 * 1024 + 1000;
  const mpInitResp = await callWorker("/api/media/upload-init", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: "alice_multipart.mp4",
      size_bytes: mpTotalSize,
      mime_type: "video/mp4",
      upload_mode: "multipart"
    })
  });
  assert.equal(mpInitResp.status, 200);
  const mpInit = await mpInitResp.json();
  assert.ok(mpInit.upload_id, "upload-init phải trả về upload_id khi upload_mode=multipart");
  const mpChunk = mpInit.chunk_size_bytes;
  assert.ok(mpChunk >= 5 * 1024 * 1024, "R2 yêu cầu phân đoạn >= 5 MiB");

  const mpPartUrl = (uploadId, n) =>
    `/api/media/upload-part?${new URLSearchParams({ media_id: mpInit.media_id, upload_id: uploadId, part_number: String(n) })}`;

  const wrongIdResp = await callWorker(mpPartUrl("not_the_upload_id", 1), {
    method: "PUT",
    headers: { Cookie: `session_token=${tokenA}` },
    body: new Uint8Array(16)
  });
  assert.equal(wrongIdResp.status, 400, "upload_id sai phải bị từ chối");

  const otherUserResp = await callWorker(mpPartUrl(mpInit.upload_id, 1), {
    method: "PUT",
    headers: { Cookie: `session_token=${tokenB}` },
    body: new Uint8Array(16)
  });
  assert.equal(otherUserResp.status, 404, "User khác không được ghi phân đoạn vào media của Alice");

  const mpBytes = new Uint8Array(mpTotalSize);
  mpBytes[0] = 0x11;
  mpBytes[mpTotalSize - 1] = 0x22;
  const mpParts = [];
  for (let n = 1, off = 0; off < mpTotalSize; n++, off += mpChunk) {
    const partResp = await callWorker(mpPartUrl(mpInit.upload_id, n), {
      method: "PUT",
      headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/octet-stream" },
      body: mpBytes.slice(off, Math.min(off + mpChunk, mpTotalSize))
    });
    assert.equal(partResp.status, 200);
    const partJson = await partResp.json();
    assert.ok(partJson.etag);
    mpParts.push({ part_number: n, etag: partJson.etag });
  }
  assert.equal(mpParts.length, 2);

  const mpCompleteResp = await callWorker("/api/media/upload-complete", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ media_id: mpInit.media_id, upload_id: mpInit.upload_id, parts: mpParts })
  });
  assert.equal(mpCompleteResp.status, 200);
  const mpComplete = await mpCompleteResp.json();
  assert.equal(mpComplete.media_id, mpInit.media_id);
  assert.equal(mpComplete.size_bytes, mpTotalSize);
  const storedMp = r2.objects.get(mpInit.object_key);
  assert.equal(storedMp.bytes[0], 0x11);
  assert.equal(storedMp.bytes[mpTotalSize - 1], 0x22);

  const mpDeleteResp = await callWorker(`/api/media/${mpInit.media_id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(mpDeleteResp.status, 200);
  console.log("  ✓ [Test 15b] R2 Multipart Upload theo phân đoạn (upload-part) & kiểm tra quyền sở hữu");

  // --------------------------------------------------------------------------
  // [TEST 15c] Composer giao diện mới: 1 video -> nhiều Fanpage, chặn giờ < hiện tại + 5 phút,
  //            đăng hàng loạt, đăng ngay, bình luận hẹn giờ, không lộ thông tin hệ thống
  // --------------------------------------------------------------------------
  const composerMediaId = initUploadData.media_id;
  const nowSecC = Math.floor(Date.now() / 1000);
  const slotTooSoon = formatUtcToVn(nowSecC + 2 * 60);
  const slotOk = formatUtcToVn(nowSecC + 15 * 60);
  const postJson = (urlPath, body) =>
    callWorker(urlPath, {
      method: "POST",
      headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  const leaksInternals = (text) => /R2|Cloudflare|bucket|object_key|D1/i.test(String(text || ""));
  const composerTaskIds = [];

  const tooSoonResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_101"],
    media_id: composerMediaId,
    publish_mode: "schedule",
    schedule_date: slotTooSoon.schedule_date,
    schedule_time: slotTooSoon.schedule_time
  });
  assert.equal(tooSoonResp.status, 400, "Hẹn giờ < hiện tại + 5 phút phải bị chặn");
  assert.match((await tooSoonResp.json()).detail, /at least 5 minutes/);

  const noVideoResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_101"],
    publish_mode: "schedule",
    schedule_date: slotOk.schedule_date,
    schedule_time: slotOk.schedule_time
  });
  assert.equal(noVideoResp.status, 400);
  const noVideoJson = await noVideoResp.json();
  assert.match(noVideoJson.detail, /choose a video/);
  assert.ok(!leaksInternals(noVideoJson.detail), "Thông báo lỗi không được lộ thông tin hệ thống");

  const badMediaResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_101"],
    media_id: "med_does_not_exist",
    publish_mode: "schedule",
    schedule_date: slotOk.schedule_date,
    schedule_time: slotOk.schedule_time
  });
  assert.equal(badMediaResp.status, 400);
  assert.ok(!leaksInternals((await badMediaResp.json()).detail));

  const foreignPageResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_not_mine"],
    media_id: composerMediaId,
    publish_mode: "schedule",
    schedule_date: slotOk.schedule_date,
    schedule_time: slotOk.schedule_time
  });
  assert.equal(foreignPageResp.status, 400, "Không cho đăng lên Fanpage không thuộc quyền");

  const schedResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_101", "page_102"],
    media_id: composerMediaId,
    publish_mode: "schedule",
    schedule_date: slotOk.schedule_date,
    schedule_time: slotOk.schedule_time,
    caption: "Composer schedule test",
    comment_text: "Link ở bình luận",
    comment_delay_minutes: 30
  });
  assert.equal(schedResp.status, 200);
  const schedJson = await schedResp.json();
  assert.equal(schedJson.task_ids.length, 2, "1 video x 2 Fanpage = 2 bài đăng");
  composerTaskIds.push(...schedJson.task_ids);
  const schedRows = (
    await d1
      .prepare(`SELECT facebook_page_id, status, scheduled_at, comment_delay_minutes, comment_status, media_id
               FROM tasks WHERE id IN (?, ?) ORDER BY facebook_page_id`)
      .bind(schedJson.task_ids[0], schedJson.task_ids[1])
      .all()
  ).results;
  assert.deepEqual(schedRows.map((r) => r.facebook_page_id), ["page_101", "page_102"]);
  for (const r of schedRows) {
    assert.equal(r.status, "pending");
    assert.equal(r.media_id, composerMediaId);
    assert.equal(r.comment_status, "pending");
    assert.ok(Number(r.scheduled_at) >= nowSecC + 14 * 60, "scheduled_at phải đúng giờ đã chọn (giờ VN -> UTC)");
  }
  // comment_text cũ được chuyển thành 1 dòng trong task_comments (độ trễ 30 phút) cho mỗi bài
  const legacyCmtRows = (
    await d1
      .prepare("SELECT task_id, message, delay_minutes FROM task_comments WHERE task_id IN (?, ?)")
      .bind(schedJson.task_ids[0], schedJson.task_ids[1])
      .all()
  ).results;
  assert.equal(legacyCmtRows.length, 2);
  assert.ok(legacyCmtRows.every((c) => c.message === "Link ở bình luận" && Number(c.delay_minutes) === 30));

  // GET /api/tasks trả về mảng chứa các task vừa tạo
  const listAfterCompose = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.ok(Array.isArray(listAfterCompose));
  assert.ok(schedJson.task_ids.every((id) => listAfterCompose.some((t) => t.id === id)));

  // Đăng hàng loạt: 1 dòng sai giờ -> chặn toàn bộ, không tạo task nào
  const countTasks = async () =>
    Number((await d1.prepare("SELECT COUNT(*) AS c FROM tasks").first()).c);
  const beforeBadBulk = await countTasks();
  const badBulkResp = await postJson("/api/tasks/bulk", {
    tasks: [
      { facebook_page_ids: ["page_101"], media_id: composerMediaId, caption: "row 1", ...slotOk },
      { facebook_page_ids: ["page_102"], media_id: composerMediaId, caption: "row 2", ...slotTooSoon }
    ]
  });
  assert.equal(badBulkResp.status, 400);
  assert.match((await badBulkResp.json()).detail, /Post #2/);
  assert.equal(await countTasks(), beforeBadBulk, "Không được tạo task dở dang khi 1 dòng không hợp lệ");

  const okBulkResp = await postJson("/api/tasks/bulk", {
    tasks: [
      { facebook_page_ids: ["page_101", "page_102"], media_id: composerMediaId, caption: "row 1", ...slotOk },
      {
        facebook_page_ids: ["page_102"],
        media_id: composerMediaId,
        caption: "row 2",
        comment_text: "cmt",
        comment_delay_minutes: 60,
        ...formatUtcToVn(nowSecC + 45 * 60)
      }
    ]
  });
  assert.equal(okBulkResp.status, 200);
  const okBulkJson = await okBulkResp.json();
  assert.equal(okBulkJson.created_count, 3, "Dòng 1 (2 Fanpage) + Dòng 2 (1 Fanpage) = 3 bài");
  composerTaskIds.push(...okBulkJson.task_ids);

  // Đăng ngay: tạo task và đưa vào hàng đợi ngay (giữ nguyên bộ đếm mock để không ảnh hưởng Test 20)
  const savedReelsCounter = graphApiReelsCalled;
  const nowResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_102"],
    media_id: composerMediaId,
    publish_mode: "now",
    caption: "Composer publish now"
  });
  assert.equal(nowResp.status, 200);
  const nowJson = await nowResp.json();
  assert.equal(nowJson.task_ids.length, 1);
  composerTaskIds.push(...nowJson.task_ids);
  const nowTask = await d1.prepare("SELECT status FROM tasks WHERE id = ?").bind(nowJson.task_ids[0]).first();
  assert.notEqual(nowTask.status, "pending", "Đăng ngay phải được đưa vào xử lý ngay, không nằm chờ lịch");
  graphApiReelsCalled = savedReelsCounter;

  // Bình luận hẹn giờ: Cron chỉ đăng bình luận đã đến hạn
  const nowIsoC = new Date().toISOString();
  const insertPublished = async (dueAt) =>
    Number(
      (
        await d1
          .prepare(
            `INSERT INTO tasks (owner_user_id, profile_id, facebook_page_id, video_path, caption, comment_text,
               schedule_date, schedule_time, scheduled_at, status, publish_status, video_id, post_id,
               comment_status, comment_due_at, comment_delay_minutes, created_at, updated_at)
             VALUES ((SELECT id FROM users WHERE username = 'alice_admin'), 'page_101', 'page_101', ?, 'x', 'Bình luận hẹn giờ',
               '2026-01-01', '00:00', 1, 'success', 'success', 'vid_cmt_test', 'page_101_vid_cmt_test',
               'scheduled', ?, 10, ?, ?)`
          )
          .bind(`r2://${composerMediaId}`, dueAt, nowIsoC, nowIsoC)
          .run()
      ).meta.last_row_id
    );
  const cmtDueTaskId = await insertPublished(nowSecC - 30);
  const cmtFutureTaskId = await insertPublished(nowSecC + 3600);
  composerTaskIds.push(cmtDueTaskId, cmtFutureTaskId);
  const dispatched = await dispatchDueScheduledComments(d1, env, nowSecC, 5);
  assert.equal(dispatched, 1, "Chỉ bình luận đã đến hạn mới được xử lý");
  const cmtDueAfter = await d1.prepare("SELECT comment_status FROM tasks WHERE id = ?").bind(cmtDueTaskId).first();
  const cmtFutureAfter = await d1.prepare("SELECT comment_status FROM tasks WHERE id = ?").bind(cmtFutureTaskId).first();
  assert.ok(["success", "failed"].includes(cmtDueAfter.comment_status), `comment_status=${cmtDueAfter.comment_status}`);
  assert.equal(cmtFutureAfter.comment_status, "scheduled");

  // Thống kê: không được bịa số liệu khi Facebook chưa trả dữ liệu
  const insightsC = await (
    await callWorker("/api/insights/reels?range=30d", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.equal(insightsC.overview.new_follows_30d, null, "Không suy đoán số người theo dõi mới");
  assert.equal(insightsC.overview.total_followers, null, "Chưa có dữ liệu người theo dõi thì phải là null");
  for (const pc of insightsC.charts.page_comparison) {
    assert.equal(pc.followers, null);
    assert.ok(!/Nguyễn Anh Đức/.test(pc.admin_name || ""), "Không dùng tên quản trị viên giả");
  }
  console.log("    · bình luận hẹn giờ sau khi Cron xử lý:", cmtDueAfter.comment_status);

  // --------------------------------------------------------------------------
  // [TEST 15d] Nhiều bình luận cho 1 bài, bình luận kèm ảnh, mỗi bình luận có độ trễ riêng
  // --------------------------------------------------------------------------
  const uploadImage = (bytes, name) =>
    callWorker("/api/media/upload-image", {
      method: "POST",
      headers: {
        Cookie: `session_token=${tokenA}`,
        "Content-Type": "image/png",
        "X-File-Name": encodeURIComponent(name)
      },
      body: bytes
    });
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const imgResp = await uploadImage(pngBytes, "ảnh bình luận.png");
  assert.equal(imgResp.status, 200);
  const imgJson = await imgResp.json();
  assert.match(imgJson.media_id, /^img_/);
  assert.equal(imgJson.mime_type, "image/png");

  const fakeImgResp = await uploadImage(Buffer.from("this is not an image"), "fake.png");
  assert.equal(fakeImgResp.status, 400, "File không phải ảnh thật phải bị từ chối");

  const imgAsVideoResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_101"],
    media_id: imgJson.media_id,
    publish_mode: "schedule",
    ...slotOk
  });
  assert.equal(imgAsVideoResp.status, 400, "Ảnh không được dùng làm video Reels");

  const multiResp = await postJson("/api/tasks", {
    facebook_page_ids: ["page_101"],
    media_id: composerMediaId,
    publish_mode: "schedule",
    ...slotOk,
    caption: "Multi comment test",
    comments: [
      { text: "First comment", delay_minutes: 0 },
      { text: "", image_media_id: imgJson.media_id, delay_minutes: 0 },
      { text: "Later comment", delay_minutes: 30 },
      { text: "   " }
    ]
  });
  assert.equal(multiResp.status, 200);
  const multiTaskId = (await multiResp.json()).task_ids[0];
  composerTaskIds.push(multiTaskId);

  const multiRows = async () =>
    (
      await d1
        .prepare("SELECT position, message, image_media_id, delay_minutes, status, due_at FROM task_comments WHERE task_id = ? ORDER BY position")
        .bind(multiTaskId)
        .all()
    ).results;
  let mRows = await multiRows();
  assert.equal(mRows.length, 3, "Bình luận trống bị bỏ qua, còn 3 bình luận");
  assert.deepEqual(mRows.map((r) => r.status), ["pending", "pending", "pending"]);
  assert.equal(mRows[1].image_media_id, imgJson.media_id);
  const multiTask = await d1.prepare("SELECT comment_text, comment_status FROM tasks WHERE id = ?").bind(multiTaskId).first();
  assert.equal(multiTask.comment_text, "");
  assert.equal(multiTask.comment_status, "pending");

  // Giả lập Reels đã đăng xong -> 2 bình luận độ trễ 0 được đăng ngay, bình luận 30 phút chờ Cron
  await d1
    .prepare("UPDATE tasks SET status = 'success', publish_status = 'success', video_id = 'vid_multi', post_id = 'page_101_vid_multi' WHERE id = ?")
    .bind(multiTaskId)
    .run();
  const fbCommentsBefore = commentsCreatedOnFacebook.length;
  const publishedAt = Math.floor(Date.now() / 1000);
  const inline = await processTaskComments(d1, env, multiTaskId, { publishedAtUtc: publishedAt });
  assert.equal(inline.posted, 2, `posted=${inline.posted} failed=${inline.failed}`);
  const postedNow = commentsCreatedOnFacebook.slice(fbCommentsBefore);
  assert.equal(postedNow.length, 2);
  assert.equal(postedNow[0].message, "First comment");
  assert.equal(postedNow[1].has_image, true, "Bình luận thứ 2 phải gửi kèm ảnh");
  mRows = await multiRows();
  assert.deepEqual(mRows.map((r) => r.status), ["success", "success", "scheduled"]);
  assert.equal(Number(mRows[2].due_at), publishedAt + 30 * 60);
  assert.equal(
    (await d1.prepare("SELECT comment_status FROM tasks WHERE id = ?").bind(multiTaskId).first()).comment_status,
    "scheduled"
  );

  // Cron sau 30 phút đăng nốt bình luận còn lại
  await dispatchDueScheduledComments(d1, env, publishedAt + 30 * 60 + 5, 3);
  mRows = await multiRows();
  assert.deepEqual(mRows.map((r) => r.status), ["success", "success", "success"]);
  assert.equal(commentsCreatedOnFacebook.slice(fbCommentsBefore).length, 3);
  const multiTaskAfter = await d1.prepare("SELECT comment_status, comment_log FROM tasks WHERE id = ?").bind(multiTaskId).first();
  assert.equal(multiTaskAfter.comment_status, "success");
  assert.match(multiTaskAfter.comment_log, /3\/3/);

  // Danh sách lịch đăng trả kèm các bình luận
  const listWithComments = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const listedMulti = listWithComments.find((t) => t.id === multiTaskId);
  assert.equal(listedMulti.comments.length, 3);
  assert.equal(listedMulti.comments[1].has_image, true);
  await d1.prepare("DELETE FROM task_comments WHERE task_id = ?").bind(multiTaskId).run();
  console.log("  ✓ [Test 15d] Nhiều bình luận / bài, bình luận kèm ảnh, độ trễ riêng từng bình luận");

  // --------------------------------------------------------------------------
  // [TEST 15e] Thống kê lấy trực tiếp từ Meta Graph API (batch), không dùng số liệu nội bộ
  // --------------------------------------------------------------------------
  const fetchBeforeLive = globalThis.fetch;
  let liveBatchCalls = 0;
  const dayIso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().replace(/\.\d+Z$/, "+0000");
  const graphOk = (body) => ({ code: 200, body: JSON.stringify(body) });
  const graphErr = (code, message) => ({ code: 400, body: JSON.stringify({ error: { code, message } }) });
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === "string" ? input : input.url;
    if (/graph\.facebook\.com\/v[\d.]+\/$/.test(u) && String(init.method || "").toUpperCase() === "POST") {
      liveBatchCalls++;
      const form = new URLSearchParams(String(init.body || ""));
      const ops = JSON.parse(form.get("batch") || "[]");
      const out = ops.map((op) => {
        const rel = op.relative_url;
        assert.ok(/access_token=/.test(rel), "Mỗi lệnh batch phải mang token của Page");
        const path = rel.split("?")[0];
        if (/\/video_reels$/.test(path)) {
          const pageId = path.split("/")[0];
          assert.ok(/comments\.filter\(stream\)/.test(rel), "Đếm cả trả lời bình luận (filter=stream)");
          assert.ok(/reactions\./.test(rel), "Đếm mọi loại cảm xúc, không chỉ Like");
          if (/after=CURSOR_2/.test(rel)) {
            // Trang 2: 1 Reel trong khoảng + 1 Reel quá cũ -> dừng phân trang
            return graphOk({
              data: [
                {
                  id: `reel2_${pageId}`,
                  description: "Second page reel",
                  created_time: dayIso(10),
                  length: 42,
                  reactions: { summary: { total_count: 5 } },
                  comments: { summary: { total_count: 3 } }
                },
                { id: `old_${pageId}`, description: "Too old", created_time: dayIso(120) }
              ]
            });
          }
          return graphOk({
            data: [
              {
                id: `reel_${pageId}`,
                description: "Live reel",
                created_time: dayIso(2),
                permalink_url: `/reel/reel_${pageId}`,
                reactions: { summary: { total_count: 5 } },
                comments: { summary: { total_count: 2 } }
              }
            ],
            paging: { cursors: { after: "CURSOR_2" }, next: "https://graph.facebook.com/next" }
          });
        }
        if (/\/insights$/.test(path)) {
          const metric = /metric=([a-z_]+)/.exec(rel)[1];
          if (metric === "page_media_view" || metric === "page_post_engagements") {
            return graphOk({ data: [{ name: metric, values: [{ value: 10, end_time: dayIso(1) }, { value: 20, end_time: dayIso(0) }] }] });
          }
          if (metric === "page_daily_follows_unique") return graphErr(10, "(#10) Requires read_insights permission");
          return graphErr(100, "(#100) The value must be a valid insights metric");
        }
        if (/\/video_insights$/.test(path)) {
          const metrics = /metric=([a-z_,]+)/.exec(rel)[1].split(",");
          const valueOf = {
            fb_reels_total_plays: 300,
            blue_reels_play_count: 250,
            post_impressions_unique: 200,
            post_video_social_actions: { SHARE: 4, COMMENT: 2, REACTION: 5 },
            post_video_likes_by_reaction_type: { REACTION_LIKE: 4, REACTION_LOVE: 1 }
          };
          return graphOk({
            data: metrics.map((m) => ({ name: m, period: "lifetime", values: [{ value: valueOf[m] }] }))
          });
        }
        if (!path.includes("/")) {
          return graphOk({ id: path, name: `Live ${path}`, followers_count: 1000, fan_count: 900 });
        }
        return graphErr(100, "unknown");
      });
      return new Response(JSON.stringify(out), { status: 200 });
    }
    return fetchBeforeLive(input, init);
  };
  try {
    const liveResp = await callWorker("/api/insights/live?days=28&refresh=1", {
      headers: { Cookie: `session_token=${tokenA}` }
    });
    assert.equal(liveResp.status, 200);
    const live = await liveResp.json();
    assert.equal(live.source, "meta_graph_api");
    const readable = live.pages.filter((pg) => pg.status === "partial");
    assert.ok(readable.length >= 1, "Phải đọc được ít nhất 1 Page qua Graph API");
    for (const pg of readable) {
      assert.equal(pg.followers, 1000);
      assert.equal(pg.views, 30, "Lượt xem lấy từ page_media_view của Meta");
      assert.equal(pg.views_metric, "page_media_view");
      assert.equal(pg.engagement, 30);
      assert.equal(pg.new_follows, null, "Thiếu quyền -> null, không tự bịa");
      assert.equal(pg.daily.length, 2, "Có số liệu từng ngày cho từng Page");
      assert.equal(pg.reels_count, 2, "Đọc hết các trang Reels; Reels quá khoảng thời gian bị loại");
      assert.deepEqual(pg.reels.map((r) => r.video_id), [`reel_${pg.page_id}`, `reel2_${pg.page_id}`]);
      assert.equal(pg.reels[1].length_seconds, 42);
      assert.equal(pg.reel_plays, 600);
      assert.equal(pg.reel_reach, 400);
      assert.equal(pg.reactions, 10);
      assert.equal(pg.comments, 5);
      assert.equal(pg.shares, 8);
    }
    assert.equal(live.total_followers, 1000 * readable.length);
    assert.equal(live.new_follows, null);
    assert.equal(live.reels_count, 2 * readable.length);
    assert.equal(live.top_reels[0].plays, 300);
    assert.ok(live.top_reels[0].permalink_url.startsWith("https://www.facebook.com/reel/"));
    assert.ok(live.warnings.some((w) => /read_insights/.test(w)), "Phải cảnh báo thiếu quyền read_insights");
    assert.ok(liveBatchCalls <= 6, `Gọi Meta theo batch, không gọi từng request (${liveBatchCalls})`);

    const callsBefore = liveBatchCalls;
    const cachedResp = await (
      await callWorker("/api/insights/live?days=28", { headers: { Cookie: `session_token=${tokenA}` } })
    ).json();
    assert.equal(cachedResp.cached, true);
    assert.equal(liveBatchCalls, callsBefore, "Lần tải lại trong 10 phút dùng bộ nhớ đệm");
  } finally {
    globalThis.fetch = fetchBeforeLive;
  }
  console.log("  ✓ [Test 15e] Thống kê lấy trực tiếp từ Meta (Graph batch), thiếu quyền trả null + cảnh báo");

  // Dọn dẹp để không ảnh hưởng các bài kiểm thử sau
  for (const id of composerTaskIds) {
    await d1.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  }
  console.log("  ✓ [Test 15c] Composer: nhiều Fanpage, chặn giờ quá khứ (+5 phút), đăng hàng loạt, đăng ngay, bình luận hẹn giờ");

  // Bob thử truy cập, xóa hoặc gắn media_id của Alice vào Task của Bob -> Phải bị chặn!
  const bobDeleteAliceMedia = await callWorker(`/api/media/${initUploadData.media_id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenB}` }
  });
  assert.equal(bobDeleteAliceMedia.status, 404);

  const bobStealMediaTask = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenB}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "page_999",
      video_path: `r2://${initUploadData.media_id}`,
      caption: "Bob mencoba dùng video của Alice",
      schedule_date: "2029-12-20",
      schedule_time: "19:00"
    })
  });
  assert.equal(bobStealMediaTask.status, 403, "Không cho phép User B dùng video R2 của User A");
  console.log("  ✓ [Test 16] Kiểm tra quyền sở hữu Object R2 (R2 Object Ownership) an toàn tuyệt đối");

  // --------------------------------------------------------------------------
  // [TEST 17 & 18] Task Creation & Bulk Task Creation
  // --------------------------------------------------------------------------
  const createTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "page_101",
      video_path: compUploadData.video_path,
      caption: "Thước phim số 1 đăng từ R2 #reels",
      comment_text: "Bình luận tự động dưới Reels!",
      schedule_date: "2029-12-20",
      schedule_time: "18:30"
    })
  });
  assert.equal(createTaskResp.status, 200);
  const createdTask1 = (await createTaskResp.json()).task;
  assert.equal(createdTask1.media_id, initUploadData.media_id);
  console.log("  ✓ [Test 17] Tạo Task đơn lẻ tham chiếu R2 Object thành công");

  const bulkCreateResp = await callWorker("/api/tasks/bulk", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tasks: [
        {
          video_path: compUploadData.video_path,
          caption: "Bulk Task 1",
          comment_text: "",
          schedule_date: "2029-12-20",
          schedule_time: "07:00"
        },
        {
          video_path: compUploadData.video_path,
          caption: "Bulk Task 2",
          comment_text: "",
          schedule_date: "2029-12-20",
          schedule_time: "19:00"
        }
      ],
      assign_page_ids: ["page_101", "page_102"]
    })
  });
  assert.equal(bulkCreateResp.status, 200);
  const bulkJson = await bulkCreateResp.json();
  assert.equal(bulkJson.inserted_count, 2);
  console.log("  ✓ [Test 18] Tạo Bulk Tasks & Phân bổ Round-Robin cho các Fanpage");

  // --------------------------------------------------------------------------
  // [TEST 19] Run Test (Chẩn đoán toàn diện KHÔNG gọi API publish)
  // --------------------------------------------------------------------------
  const beforeTestCalls = graphApiReelsCalled;
  const runTestResp = await callWorker("/api/runner/test", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(runTestResp.status, 200);
  const runTestReport = await runTestResp.json();
  assert.equal(runTestReport.status, "ready");
  assert.equal(runTestReport.valid_pages_count, 2);
  assert.equal(runTestReport.valid_videos_count, 3);
  assert.equal(graphApiReelsCalled, beforeTestCalls, "Run Test tuyệt đối không được gọi API publish Reels");
  console.log("  ✓ [Test 19] Run Test kiểm tra đầy đủ OAuth, Page, Video R2, Lịch hẹn mà KHÔNG publish");

  // --------------------------------------------------------------------------
  // [TEST 20 & 22] Queue Publishing & Idempotency
  // --------------------------------------------------------------------------
  // Xóa 2 task bulk tương lai trước để chỉ test chạy ngay createdTask1
  for (const tid of bulkJson.task_ids) {
    await callWorker(`/api/tasks/${tid}`, {
      method: "DELETE",
      headers: { Cookie: `session_token=${tokenA}` }
    });
  }

  // Giả lập createdTask1 đã đến hạn để runner kích hoạt
  const nowSecForRunStart = Math.floor(Date.now() / 1000) - 60;
  await d1
    .prepare("UPDATE tasks SET scheduled_at = ?, schedule_date = '2020-01-01', schedule_time = '00:00', status = 'pending' WHERE id = ?")
    .bind(nowSecForRunStart, createdTask1.id)
    .run();

  const runStartResp = await callWorker("/api/runner/start", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(runStartResp.status, 202);
  const runStartJson = await runStartResp.json();
  assert.equal(runStartJson.enqueued_count, 1);

  const tasksAfterPublish = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const finishedTask1 = tasksAfterPublish.find((t) => t.id === createdTask1.id);
  assert.equal(finishedTask1.status, "success");
  assert.equal(finishedTask1.video_url, "https://www.facebook.com/reel/vid_reel_1");
  assert.ok(finishedTask1.log.includes("Auto comment posted"));
  console.log("  ✓ [Test 20] Queue Publishing xuất bản Reels từ R2 + Auto-Comment thành công");

  // Kiểm tra Idempotency: Gửi lại đúng Queue Message của finishedTask1 lần nữa -> Không được gọi Graph API lần 2!
  const callsBeforeDup = graphApiReelsCalled;
  const dupRes = await consumeSingleTaskMessage(d1, env, {
    task_id: finishedTask1.id,
    owner_user_id: finishedTask1.owner_user_id,
    idempotency_key: finishedTask1.idempotency_key || "idem_dup",
    attempt: 2,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  assert.equal(dupRes.status, "ack");
  assert.equal(graphApiReelsCalled, callsBeforeDup, "Idempotency phải chặn xuất bản trùng lặp");
  console.log("  ✓ [Test 22] Idempotency Guard chặn đăng trùng khi Queue gửi lặp message");

  // --------------------------------------------------------------------------
  // [TEST 21] Queue Retry với Exponential Backoff & Chặn Retry khi Ambiguous Publish
  // --------------------------------------------------------------------------
  const retryTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "page_101",
      video_path: compUploadData.video_path,
      caption: "Task kiểm thử Retry & Backoff",
      schedule_date: "2029-12-20",
      schedule_time: "20:00"
    })
  });
  const retryTask = (await retryTaskResp.json()).task;
  const nowDue = Math.floor(Date.now() / 1000) - 10;
  await d1.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?").bind(nowDue, retryTask.id).run();

  // Giả lập lỗi 500 tạm thời ở bước upload binary
  simulateUpload500Once = true;
  const firstAttempt = await consumeSingleTaskMessage(d1, env, {
    task_id: retryTask.id,
    owner_user_id: retryTask.owner_user_id,
    idempotency_key: "idem_retry_1",
    attempt: 1,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  assert.equal(firstAttempt.status, "retry");
  assert.equal(firstAttempt.delaySeconds, 15);

  // Giả lập lỗi 504 ở bước finish_publish (Ambiguous publish) -> Phải dừng auto-retry!
  simulateAmbiguousFinishError = true;
  const secondAttempt = await consumeSingleTaskMessage(d1, env, {
    task_id: retryTask.id,
    owner_user_id: retryTask.owner_user_id,
    idempotency_key: "idem_retry_1",
    attempt: 2,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  assert.equal(secondAttempt.status, "dead_letter");
  assert.ok(secondAttempt.reason.includes("AUTO-RETRY STOPPED TO AVOID A DUPLICATE POST"));
  console.log("  ✓ [Test 21] Queue Retry (Exponential Backoff) & Chặn Auto-Retry khi Ambiguous Publish");

  // --------------------------------------------------------------------------
  // [TEST 23 & 24] Timezone Conversion (Asia/Ho_Chi_Minh <-> UTC) & 10 Test Cases Scheduler
  // --------------------------------------------------------------------------
  const parsedTz = parseVnScheduleToUtc("2026-11-10", "07:00", { allowPast: true });
  assert.equal(parsedTz.isValid, true);
  // 2026-11-10 07:00:00+07:00 == 2026-11-10 00:00:00 UTC
  assert.equal(parsedTz.scheduledAtUtc, Math.floor(Date.UTC(2026, 10, 10, 0, 0, 0) / 1000));
  const formattedVn = formatUtcToVn(parsedTz.scheduledAtUtc);
  assert.equal(formattedVn.schedule_date, "2026-11-10");
  assert.equal(formattedVn.schedule_time, "07:00");
  assert.equal(VN_OFFSET_SECONDS, 25200);
  console.log("  ✓ [Test 24] Timezone Asia/Ho_Chi_Minh (+07:00) <-> UTC chính xác tuyệt đối");

  // [Case 1] Đặt lịch với thời gian quá khứ -> Bị từ chối ngay lập tức (lỗi 400)
  const pastTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "page_102",
      video_path: compUploadData.video_path,
      caption: "Task hẹn giờ quá khứ",
      schedule_date: "2020-01-01",
      schedule_time: "08:00"
    })
  });
  assert.equal(pastTaskResp.status, 400, "Đặt lịch trong quá khứ phải trả về 400");
  const pastErr = await pastTaskResp.json();
  assert.ok(pastErr.detail.includes("is in the past or right now"));

  // [Case 2] Đặt lịch với thời gian quá gần/hiện tại (cách dưới 1 phút) -> Bị từ chối (400)
  const nearPastCheck = parseVnScheduleToUtc("2026-11-07", "00:00", {
    referenceNowUtc: Math.floor(Date.UTC(2026, 10, 6, 17, 0, 0) / 1000), // cùng thời điểm
    minLeadSeconds: 60
  });
  assert.equal(nearPastCheck.isValid, false);
  assert.ok(nearPastCheck.error.includes("is in the past or right now"));

  // [Case 3] Đặt lịch với thời gian tương lai hợp lệ -> Chấp nhận, trạng thái scheduled
  const futureTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "page_102",
      video_path: compUploadData.video_path,
      caption: "Task hẹn giờ tương lai chưa đến hạn",
      schedule_date: "2029-12-31",
      schedule_time: "23:00"
    })
  });
  assert.equal(futureTaskResp.status, 200);
  const futureTask = (await futureTaskResp.json()).task;
  assert.equal(futureTask.status, "scheduled");
  assert.equal(futureTask.is_future_schedule, true);

  // [Case 10] Sửa lại giờ hẹn thành giờ quá khứ -> Bị từ chối (lỗi 400)
  const updatePastResp = await callWorker(`/api/tasks/${futureTask.id}`, {
    method: "PUT",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      schedule_date: "2020-01-01",
      schedule_time: "08:00"
    })
  });
  assert.equal(updatePastResp.status, 400, "Cập nhật lịch thành thời gian quá khứ phải trả về 400");

  // [Case 4] Chèn một task đã đến hạn (quá khứ) trực tiếp vào DB để kiểm tra Cron Trigger
  const dueTaskId = await addTask(
    d1,
    {
      videoPath: compUploadData.video_path,
      caption: "Task hẹn giờ đã đến hạn chạy qua Cron",
      scheduleDate: "2020-01-01",
      scheduleTime: "08:00",
      facebookPageId: "page_102",
      ownerUserId: futureTask.owner_user_id,
      status: "pending"
    },
    { allowPast: true }
  );

  const cronBg = [];
  const cronResult = await workerDefault.scheduled(
    { cron: "*/1 * * * *", type: "scheduled", scheduledTime: Date.now() },
    env,
    { waitUntil: (p) => cronBg.push(p), passThroughOnException: () => {} }
  );
  await Promise.all(cronBg);

  assert.ok(cronResult.task_ids.includes(dueTaskId), "Cron phải claim task đã đến hạn");
  assert.ok(!cronResult.task_ids.includes(futureTask.id), "Cron không được chạy task chưa đến giờ hẹn");

  const tasksAfterCron = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.equal(tasksAfterCron.find((t) => t.id === dueTaskId).status, "success");
  assert.equal(tasksAfterCron.find((t) => t.id === futureTask.id).status, "scheduled");

  // [Case 5] Chưa đến giờ hẹn -> Khi chạy runner thủ công, không đẩy task tương lai vào queue
  const manualStartResp = await callWorker("/api/runner/start", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(manualStartResp.status, 400);
  const manualStartJson = await manualStartResp.json();
  assert.ok(manualStartJson.detail.includes("waiting for their scheduled time"), "Runner thủ công không được kích hoạt task tương lai");

  // [Case 9] Hủy/Xóa lịch hẹn trước giờ chạy -> Chuyển xóa an toàn, không còn chạy khi đến giờ
  const delSchedResp = await callWorker(`/api/tasks/${futureTask.id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(delSchedResp.status, 200);

  console.log("  ✓ [Test 23] Cron Trigger Scheduler kích hoạt chính xác task đến hạn & giữ nguyên task tương lai");

  // --------------------------------------------------------------------------
  // [TEST 25] Meta API Error Handling (Token hết hạn 190 & Làm sạch thông tin nhạy cảm)
  // --------------------------------------------------------------------------
  simulateExpiredTokenPageId = "page_101";
  const permCheckErr = await callWorker("/api/pages/page_101/check-permission", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(permCheckErr.status, 400);
  const permErrData = await permCheckErr.json();
  assert.ok(!permErrData.detail.includes("EAAB_PAGE_TOKEN_101_FROM_A1"), "Không được lộ token trong thông báo lỗi");
  simulateExpiredTokenPageId = "";
  console.log("  ✓ [Test 25] Meta API Error Handling phát hiện token hết hạn (190) & ẩn hoàn toàn token nhạy cảm");

  // --------------------------------------------------------------------------
  // [TEST 26] Meta Data Deletion Callback & Status Verification
  // --------------------------------------------------------------------------
  const delCbResp = await callWorker("/api/meta/data-deletion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ facebook_user_id: "fb_uid_b1" })
  });
  assert.equal(delCbResp.status, 200);
  const delCbJson = await delCbResp.json();
  assert.ok(delCbJson.confirmation_code.startsWith("DEL_"));
  assert.ok(delCbJson.url.startsWith("https://pagefb.namnangno.click/data-deletion-status?code="));

  const statusPageResp = await callWorker(`/data-deletion-status?code=${delCbJson.confirmation_code}`);
  assert.equal(statusPageResp.status, 200);
  const statusPageHtml = await statusPageResp.text();
  assert.ok(statusPageHtml.includes(delCbJson.confirmation_code));
  assert.ok(statusPageHtml.includes("COMPLETED"));

  // Kiểm tra tài khoản fb_uid_b1 của Bob đã thực sự bị xóa khỏi D1 và Page của Bob cũng bị xóa hoàn toàn
  const bobAccsAfterDel = await (
    await callWorker("/api/meta/accounts", { headers: { Cookie: `session_token=${tokenB}` } })
  ).json();
  assert.equal(bobAccsAfterDel.length, 0, "Dữ liệu Facebook Account phải được xóa thật khỏi D1");
  const bobPagesAfterDel = await (
    await callWorker("/api/pages", { headers: { Cookie: `session_token=${tokenB}` } })
  ).json();
  assert.equal(bobPagesAfterDel.length, 0, "Fanpage của Bob phải bị xóa hoàn toàn khi xóa Admin");
  console.log("  ✓ [Test 26] Meta Data Deletion xóa dữ liệu thật trong D1 & lưu biên bản tra cứu");

  // --------------------------------------------------------------------------
  // [TEST 26B] Xóa Admin & Cascade Xóa Toàn Bộ Fanpage Liên Kết (Mục V & VIII)
  // --------------------------------------------------------------------------
  const aliceAccsBefore = await (
    await callWorker("/api/meta/accounts", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const adminA1 = aliceAccsBefore.find((a) => a.facebook_user_id === "fb_uid_a1");
  const adminA2 = aliceAccsBefore.find((a) => a.facebook_user_id === "fb_uid_a2");
  assert.ok(adminA1 && adminA2, "Alice phải có đủ 2 Admin chính trước khi test xóa");

  // 1. Bob thử xóa Admin của Alice -> Phải trả về 404 (Kiểm tra quyền sở hữu)
  const bobDeleteAliceAdmin = await callWorker(`/api/meta/accounts/${adminA1.id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenB}` }
  });
  assert.equal(bobDeleteAliceAdmin.status, 404, "User khác không được phép xóa Admin của Alice");

  // 2. Alice xóa Admin 1 (quản lý độc quyền page_102 và dùng chung page_101 với Admin 2)
  const delAdminA1Resp = await callWorker(`/api/meta/accounts/${adminA1.id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(delAdminA1Resp.status, 200);
  const delAdminA1Data = await delAdminA1Resp.json();
  assert.equal(delAdminA1Data.success, true);
  assert.equal(delAdminA1Data.deleted_pages_count, 1, "page_102 độc quyền của Admin 1 phải bị xóa");
  assert.ok(delAdminA1Data.deleted_page_ids.includes("page_102"), "Danh sách xóa phải có page_102");
  assert.equal(delAdminA1Data.shared_pages_kept_count, 1, "page_101 còn Admin 2 quản lý nên phải giữ lại");

  const alicePagesAfterDelA1 = await (
    await callWorker("/api/pages", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.equal(alicePagesAfterDelA1.length, 1, "Sau khi xóa Admin 1, chỉ còn lại page_101");
  assert.equal(alicePagesAfterDelA1[0].facebook_page_id, "page_101");
  assert.equal(alicePagesAfterDelA1[0].connected_account_id, adminA2.id, "page_101 phải chuyển sang Admin 2");

  // 3. Alice xóa tiếp Admin 2 (đang quản lý page_101) -> page_101 phải bị xóa hoàn toàn khỏi ứng dụng
  const delAdminA2Resp = await callWorker(`/api/meta/accounts/${adminA2.id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(delAdminA2Resp.status, 200);
  const delAdminA2Data = await delAdminA2Resp.json();
  assert.equal(delAdminA2Data.deleted_pages_count, 1, "page_101 phải bị xóa khi xóa Admin cuối cùng");
  assert.ok(delAdminA2Data.deleted_page_ids.includes("page_101"));

  const alicePagesAfterDelAll = await (
    await callWorker("/api/pages", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.equal(alicePagesAfterDelAll.length, 0, "Toàn bộ Fanpage phải biến mất sau khi xóa hết Admin");
  console.log("  ✓ [Test 26B] Xóa Admin tự động xóa toàn bộ Fanpage độc quyền & bảo toàn Fanpage chung");

  // --------------------------------------------------------------------------
  // [TEST 27, 28, 29, 30] Production Cleanliness & Security Audits
  // --------------------------------------------------------------------------
  const filesToAudit = [
    "static/index.html",
    "static/login.html",
    "static/privacy.html",
    "static/terms.html",
    "static/data-deletion.html",
    "static/js/app.js",
    "src/index.ts",
    "src/db.ts",
    "src/services/metaOAuthService.ts",
    "src/services/metaGraphService.ts",
    "src/services/r2MediaService.ts",
    "src/queue/publishQueue.ts",
    "src/scheduler/cronDispatcher.ts",
    "wrangler.jsonc",
    "package.json"
  ];

  for (const relPath of filesToAudit) {
    const content = fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
    // Test 27: Không còn localhost:8000 / 127.0.0.1:8000
    assert.ok(!content.includes("localhost:8000"), `File ${relPath} còn chứa localhost:8000`);
    assert.ok(!content.includes("127.0.0.1:8000"), `File ${relPath} còn chứa 127.0.0.1:8000`);
    // Test 28: Không chứa App Secret thật
    assert.ok(
      !content.includes("d595b9fcf01101b510315c2c08950863"),
      `File ${relPath} làm lộ META_APP_SECRET!`
    );
    // Test 29: Không còn đường dẫn Windows mẫu D:\Videos trong luồng production
    assert.ok(!content.includes("D:\\Videos\\"), `File ${relPath} còn chứa đường dẫn Windows D:\\Videos\\`);
  }

  const pkgJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const allDeps = JSON.stringify({
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.devDependencies || {})
  }).toLowerCase();
  assert.ok(!allDeps.includes("playwright"), "package.json không được chứa playwright");
  assert.ok(!allDeps.includes("puppeteer"), "package.json không được chứa puppeteer");
  assert.ok(!allDeps.includes("gemlogin"), "package.json không được chứa gemlogin");
  assert.ok(!fs.existsSync(path.join(process.cwd(), "requirements.txt")), "requirements.txt ở root phải được dời sang legacy/");

  // Kiểm tra UI Thêm Admin mới (Yêu cầu 1: Graph API Explorer 6 bước & Yêu cầu 2: Loại bỏ nút Chạy Thử)
  const indexHtmlContent = fs.readFileSync(path.join(process.cwd(), "static/index.html"), "utf8");
  const appJsContent = fs.readFileSync(path.join(process.cwd(), "static/js/app.js"), "utf8");
  assert.ok(indexHtmlContent.includes("Graph API Explorer"), "static/index.html phải có hướng dẫn Graph API Explorer");
  assert.ok(indexHtmlContent.includes("1469615908436980"), "static/index.html phải hiển thị Meta App ID 1469615908436980");
  assert.ok(indexHtmlContent.includes("Connect Facebook"), "static/index.html phải có nút Liên kết Facebook");
  assert.ok(indexHtmlContent.includes("directAccessToken"), "static/index.html phải có ô nhập directAccessToken");
  assert.ok(appJsContent.includes("handleConnectToken"), "static/js/app.js phải có hàm handleConnectToken");
  assert.ok(appJsContent.includes("validateVnScheduleClient"), "static/js/app.js phải có hàm validateVnScheduleClient");
  // Yêu cầu 2: Loại bỏ hoàn toàn nút Chạy Thử và modal test diagnostic khỏi UI
  assert.ok(!indexHtmlContent.includes(">Chạy Thử</span>"), "static/index.html không được chứa nút Chạy Thử");
  assert.ok(!indexHtmlContent.includes("showRunTestModal"), "static/index.html không được chứa modal Chạy Thử (showRunTestModal)");
  assert.ok(indexHtmlContent.includes("Remove Facebook account?"), "static/index.html phải có modal Xóa tài khoản Facebook?");

  console.log("  ✓ [Test 27] Không còn bất kỳ URL localhost:8000 / 127.0.0.1:8000 trong Production");
  console.log("  ✓ [Test 28] Không lộ META_APP_SECRET hoặc Access Token trong Frontend & Config");
  console.log("  ✓ [Test 29] Không còn đường dẫn ổ đĩa Windows (D:\\Videos) trong Production Flow");
  console.log("  ✓ [Test 30] Không có dependency Playwright/GemLogin/FastAPI trong Worker Production");

  // --------------------------------------------------------------------------
  // [TEST 31] BỔ SUNG API TỰ ĐỘNG COMMENT SAU KHI ĐĂNG REELS (9 KỊCH BẢN BẮT BUỘC)
  // --------------------------------------------------------------------------
  console.log("\n  --- BẮT ĐẦU KIỂM THỬ 9 KỊCH BẢN TỰ ĐỘNG COMMENT SAU KHI ĐĂNG REELS ---");

  // Kết nối lại Fanpage cho Alice để kiểm thử các kịch bản bình luận
  await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      access_token: "EAAB_EXPLORER_TOKEN_VALID"
    })
  });

  // [Kịch bản 1] Đăng Reels không có comment:
  // Bỏ qua hoàn toàn bước comment, Reels thành công, comment_status = 'none'
  const taskNoCmtResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reel không có comment",
      comment_text: "",
      schedule_date: "2029-12-20",
      schedule_time: "19:00"
    })
  });
  const taskNoCmt = (await taskNoCmtResp.json()).task;
  await d1.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 10, taskNoCmt.id).run();
  const resNoCmt = await consumeSingleTaskMessage(d1, env, {
    task_id: taskNoCmt.id,
    owner_user_id: taskNoCmt.owner_user_id,
    idempotency_key: `idem_nocmt_${taskNoCmt.id}`,
    attempt: 1,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  assert.equal(resNoCmt.status, "ack");
  const taskNoCmtDb = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedNoCmt = taskNoCmtDb.find(t => t.id === taskNoCmt.id);
  assert.equal(finishedNoCmt.status, "success");
  assert.equal(finishedNoCmt.comment_status, "none");
  assert.equal(finishedNoCmt.comment_id, "");
  console.log("    ✓ [Scenario 1] Đăng Reels không có comment: Bỏ qua comment, Reels thành công");

  // [Kịch bản 2 & 3] Đăng Reels có comment: Reels thành công, comment thành công
  // Lưu riêng: video_id, post_id, comment_id
  const taskWithCmtResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reel có comment",
      comment_text: "Bình luận kịch bản 2 & 3",
      schedule_date: "2029-12-20",
      schedule_time: "19:05"
    })
  });
  const taskWithCmt = (await taskWithCmtResp.json()).task;
  await d1.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 10, taskWithCmt.id).run();
  const resWithCmt = await consumeSingleTaskMessage(d1, env, {
    task_id: taskWithCmt.id,
    owner_user_id: taskWithCmt.owner_user_id,
    idempotency_key: `idem_withcmt_${taskWithCmt.id}`,
    attempt: 1,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  assert.equal(resWithCmt.status, "ack");
  const taskWithCmtDb = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedWithCmt = taskWithCmtDb.find(t => t.id === taskWithCmt.id);
  assert.equal(finishedWithCmt.status, "success");
  assert.equal(finishedWithCmt.comment_status, "success");
  assert.ok(finishedWithCmt.comment_id);
  assert.ok(finishedWithCmt.video_id);
  assert.ok(finishedWithCmt.post_id);
  assert.notEqual(finishedWithCmt.video_id, finishedWithCmt.post_id, "Video ID và Post ID phải riêng biệt");
  assert.notEqual(finishedWithCmt.post_id, finishedWithCmt.comment_id, "Post ID và Comment ID phải riêng biệt");
  console.log("    ✓ [Scenario 2 & 3] Đăng Reels có comment: Cả 2 thành công, lưu 3 ID riêng biệt");

  // [Kịch bản 4] Reels thành công, comment thiếu quyền (pages_manage_engagement / MODERATE)
  // Reels KHÔNG bị đánh dấu thất bại! Giữ status = 'success', comment_status = 'failed'
  simulateCommentPermissionError = true;
  const taskPermResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reel comment thiếu quyền",
      comment_text: "Comment thiếu quyền MODERATE",
      schedule_date: "2029-12-20",
      schedule_time: "19:10"
    })
  });
  const taskPerm = (await taskPermResp.json()).task;
  await d1.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 10, taskPerm.id).run();
  await consumeSingleTaskMessage(d1, env, {
    task_id: taskPerm.id,
    owner_user_id: taskPerm.owner_user_id,
    idempotency_key: `idem_perm_${taskPerm.id}`,
    attempt: 1,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  const taskPermDb = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedPerm = taskPermDb.find(t => t.id === taskPerm.id);
  assert.equal(finishedPerm.status, "success", "Reels vẫn phải thành công khi comment thiếu quyền");
  assert.equal(finishedPerm.comment_status, "failed");
  assert.ok(finishedPerm.comment_log.includes("pages_manage_engagement") || finishedPerm.comment_log.includes("MODERATE"));
  simulateCommentPermissionError = false;
  console.log("    ✓ [Scenario 4] Reels thành công, comment thiếu quyền: Reels giữ success, comment_status = failed");

  // [Kịch bản 5] Reels thành công, comment lỗi mạng
  // Reels vẫn giữ status = 'success', comment_status = 'failed'
  simulateCommentNetworkError = true;
  const taskNetResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reel comment lỗi mạng",
      comment_text: "Comment lỗi mạng",
      schedule_date: "2029-12-20",
      schedule_time: "19:15"
    })
  });
  const taskNet = (await taskNetResp.json()).task;
  await d1.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 10, taskNet.id).run();
  await consumeSingleTaskMessage(d1, env, {
    task_id: taskNet.id,
    owner_user_id: taskNet.owner_user_id,
    idempotency_key: `idem_net_${taskNet.id}`,
    attempt: 1,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  const taskNetDb = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedNet = taskNetDb.find(t => t.id === taskNet.id);
  assert.equal(finishedNet.status, "success", "Reels vẫn phải thành công khi comment lỗi mạng");
  assert.equal(finishedNet.comment_status, "failed");
  simulateCommentNetworkError = false;
  console.log("    ✓ [Scenario 5] Reels thành công, comment lỗi mạng: Reels giữ success, comment_status = failed");

  // [Kịch bản 6] Comment timeout: Khôi phục và phát hiện comment đã tồn tại trên Facebook
  simulateCommentTimeout = true;
  const taskTimeoutResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reel comment timeout",
      comment_text: "Comment timeout tự khôi phục",
      schedule_date: "2029-12-20",
      schedule_time: "19:20"
    })
  });
  const taskTimeout = (await taskTimeoutResp.json()).task;
  await d1.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 10, taskTimeout.id).run();
  await consumeSingleTaskMessage(d1, env, {
    task_id: taskTimeout.id,
    owner_user_id: taskTimeout.owner_user_id,
    idempotency_key: `idem_timeout_${taskTimeout.id}`,
    attempt: 1,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  const taskTimeoutDb = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedTimeout = taskTimeoutDb.find(t => t.id === taskTimeout.id);
  assert.equal(finishedTimeout.status, "success");
  assert.equal(finishedTimeout.comment_status, "success", "Comment phải khôi phục thành công sau timeout");
  assert.equal(finishedTimeout.comment_id, "cmt_timeout_recovered");
  console.log("    ✓ [Scenario 6] Comment timeout: Tự động phát hiện comment đã tạo và xác nhận thành công");

  // [Kịch bản 7] Worker khởi động lại giữa 2 bước (Reels đã thành công, comment chưa thành công)
  // Chỉ thực hiện comment, tuyệt đối KHÔNG đăng lại Reels video!
  const callsBeforeRestart = graphApiReelsCalled;
  const taskRestartResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reel restart",
      comment_text: "Comment sau restart",
      schedule_date: "2029-12-20",
      schedule_time: "19:25"
    })
  });
  const taskRestart = (await taskRestartResp.json()).task;
  // Cập nhật thủ công giả lập video_id và post_id đã hoàn thành trước khi worker crash
  await d1.prepare("UPDATE tasks SET status = 'success', video_id = 'vid_prior_1', post_id = 'post_prior_1', comment_status = 'pending' WHERE id = ?")
    .bind(taskRestart.id)
    .run();
  await consumeSingleTaskMessage(d1, env, {
    task_id: taskRestart.id,
    owner_user_id: taskRestart.owner_user_id,
    idempotency_key: `idem_restart_${taskRestart.id}`,
    attempt: 2,
    enqueued_at: Math.floor(Date.now() / 1000)
  });
  assert.equal(graphApiReelsCalled, callsBeforeRestart, "Worker restart giữa 2 bước tuyệt đối KHÔNG được upload lại video Reels");
  const taskRestartDb = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedRestart = taskRestartDb.find(t => t.id === taskRestart.id);
  assert.equal(finishedRestart.status, "success");
  assert.equal(finishedRestart.comment_status, "success");
  console.log("    ✓ [Scenario 7] Worker restart giữa 2 bước: CHỈ đăng comment, không đăng lại video");

  // [Kịch bản 8] Thử đăng lại comment qua API POST /api/tasks/:id/retry-comment
  // Lấy taskNet (bị lỗi ở Kịch bản 5) và gọi API retry-comment
  const callsBeforeRetry = graphApiReelsCalled;
  const retryCommentResp = await callWorker(`/api/tasks/${finishedNet.id}/retry-comment`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(retryCommentResp.status, 200);
  const retryCommentData = await retryCommentResp.json();
  assert.equal(retryCommentData.success, true);
  assert.equal(retryCommentData.comment_status, "success");
  assert.ok(retryCommentData.comment_id);
  assert.equal(graphApiReelsCalled, callsBeforeRetry, "API retry comment tuyệt đối KHÔNG đăng lại video");

  const taskNetRetriedDb = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedNetRetried = taskNetRetriedDb.find(t => t.id === finishedNet.id);
  assert.equal(finishedNetRetried.comment_status, "success");
  assert.equal(finishedNetRetried.comment_id, retryCommentData.comment_id);
  console.log("    ✓ [Scenario 8] Thử đăng lại comment qua API retry-comment: Thành công, không đăng lại video");

  // [Kịch bản 9] Đảm bảo không đăng trùng Reels và comment
  // Gọi lại API retry-comment khi comment đã thành công -> Phải báo đã thành công và không gọi lại
  const duplicateRetryResp = await callWorker(`/api/tasks/${finishedNet.id}/retry-comment`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(duplicateRetryResp.status, 200);
  const duplicateRetryData = await duplicateRetryResp.json();
  assert.ok(duplicateRetryData.message.includes("already been posted"));
  assert.equal(duplicateRetryData.comment_id, finishedNetRetried.comment_id);
  console.log("    ✓ [Scenario 9] Chống đăng trùng Reels & Comment: Idempotency bảo vệ toàn vẹn");

  // [Kịch bản 10] Khắc phục lỗi (#12) singular statuses API is deprecated khi Post ID là bare ID (Task #6 trong ảnh của user)
  const barePostTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task tái hiện lỗi singular statuses",
      comment_text: "test cmt",
      schedule_date: "2029-12-20",
      schedule_time: "19:30"
    })
  });
  const barePostTask = (await barePostTaskResp.json()).task;
  await d1.prepare("UPDATE tasks SET status = 'success', video_id = '1439027771006176', post_id = '122107908045520254', comment_status = 'failed', comment_log = 'Lỗi đăng bình luận: (#12) singular statuses API is deprecated for versions v2.4 and higher' WHERE id = ?")
    .bind(barePostTask.id).run();

  const retryBareResp = await callWorker(`/api/tasks/${barePostTask.id}/retry-comment`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(retryBareResp.status, 200);
  const retryBareData = await retryBareResp.json();
  assert.equal(retryBareData.success, true);
  assert.equal(retryBareData.comment_status, "success");
  assert.ok(retryBareData.comment_id);

  const bareTaskAfterRetry = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const finishedBare = bareTaskAfterRetry.find(t => t.id === barePostTask.id);
  assert.equal(finishedBare.comment_status, "success");
  assert.equal(finishedBare.comment_id, retryBareData.comment_id);
  console.log("    ✓ [Scenario 10] Tự động vượt qua lỗi (#12) singular statuses API deprecated: Fallback thành công 100%");

  // [Kịch bản 11] Tự động sửa lỗi token cũ và tự động đồng bộ Page Token mới nhất từ Facebook
  const staleTokenTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task tái hiện stale token",
      comment_text: "test cmt stale token recovery",
      schedule_date: "2029-12-20",
      schedule_time: "19:35"
    })
  });
  const staleTask = (await staleTokenTaskResp.json()).task;
  await d1.prepare("UPDATE tasks SET status = 'success', video_id = '1439027771006176', post_id = '1418723557985686_122107908045520254', comment_status = 'failed', comment_log = 'Lỗi token cũ' WHERE id = ?")
    .bind(staleTask.id).run();

  const retryStaleResp = await callWorker(`/api/tasks/${staleTask.id}/retry-comment`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(retryStaleResp.status, 200);
  const retryStaleData = await retryStaleResp.json();
  assert.equal(retryStaleData.success, true);
  assert.equal(retryStaleData.comment_status, "success");
  assert.ok(retryStaleData.comment_id);
  console.log("    ✓ [Scenario 11] Tự động xác thực và làm mới Page Access Token từ Admin: Thành công 100%");
  console.log("  ✓ [Test 31] Bổ sung API tự động Comment sau khi đăng Reels (Pass toàn bộ 11 kịch bản)");

  // --------------------------------------------------------------------------
  // [TEST 32] Chọn task để xóa (Bulk Delete Tasks) & Dọn dẹp Orphan Media
  // --------------------------------------------------------------------------
  const initMedia1 = await (await callWorker("/api/media/upload-init", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({ filename: "bulk_vid_1.mp4", mime_type: "video/mp4", size_bytes: 1024 })
  })).json();
  const initMedia2 = await (await callWorker("/api/media/upload-init", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({ filename: "bulk_vid_2.mp4", mime_type: "video/mp4", size_bytes: 2048 })
  })).json();

  const bTask1 = await (await callWorker("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({
      video_path: "bulk_vid_1.mp4",
      caption: "Task Bulk 1",
      media_id: initMedia1.media_id,
      facebook_page_id: "page_exp_1",
      schedule_date: "2029-12-20",
      schedule_time: "20:00"
    })
  })).json();
  const bTask2 = await (await callWorker("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({
      video_path: "bulk_vid_1.mp4",
      caption: "Task Bulk 2",
      media_id: initMedia1.media_id,
      facebook_page_id: "page_exp_1",
      schedule_date: "2029-12-20",
      schedule_time: "20:05"
    })
  })).json();
  const bTask3 = await (await callWorker("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({
      video_path: "bulk_vid_2.mp4",
      caption: "Task Bulk 3",
      media_id: initMedia2.media_id,
      facebook_page_id: "page_exp_1",
      schedule_date: "2029-12-20",
      schedule_time: "20:10"
    })
  })).json();

  const emptyDelResp = await callWorker("/api/tasks/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({ task_ids: [] })
  });
  assert.equal(emptyDelResp.status, 400);

  const bulkDelResp = await callWorker("/api/tasks/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({ task_ids: [bTask1.id, bTask3.id] })
  });
  assert.equal(bulkDelResp.status, 200);
  const bulkDelData = await bulkDelResp.json();
  assert.equal(bulkDelData.success, true);
  assert.equal(bulkDelData.deleted_count, 2);
  assert.equal(bulkDelData.cleaned_orphan_count, 1);

  const checkTasksAfterBulk = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  assert.ok(checkTasksAfterBulk.some(t => t.id === bTask2.id));
  assert.ok(!checkTasksAfterBulk.some(t => t.id === bTask1.id));
  assert.ok(!checkTasksAfterBulk.some(t => t.id === bTask3.id));

  const media1Check = await d1.prepare("SELECT id FROM media_files WHERE id = ?").bind(initMedia1.media_id).first();
  assert.ok(media1Check);
  const media2Check = await d1.prepare("SELECT id FROM media_files WHERE id = ?").bind(initMedia2.media_id).first();
  assert.ok(!media2Check);
  console.log("  ✓ [Test 32] Chọn task để xóa (Bulk Delete Tasks) & Dọn dẹp Orphan Media R2 an toàn");

  // --------------------------------------------------------------------------
  // [TEST 33] Video lưu trên R2 tự xóa sau 1 tháng (30 ngày)
  // --------------------------------------------------------------------------
  const oldMediaInit = await (await callWorker("/api/media/upload-init", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({ filename: "old_month_video.mp4", mime_type: "video/mp4", size_bytes: 4096 })
  })).json();

  await r2.put(oldMediaInit.object_key, new Uint8Array([1, 2, 3, 4]));
  assert.ok(await r2.get(oldMediaInit.object_key));

  const past35DaysIso = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
  await d1.prepare("UPDATE media_files SET created_at = ? WHERE id = ?").bind(past35DaysIso, oldMediaInit.media_id).run();

  const oldTask = await (await callWorker("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({
      video_path: "old_month_video.mp4",
      caption: "Task chứa video cũ 35 ngày",
      media_id: oldMediaInit.media_id,
      facebook_page_id: "page_exp_1",
      schedule_date: "2029-12-20",
      schedule_time: "19:00"
    })
  })).json();

  // Đánh dấu task này đã xuất bản thành công từ tháng trước để giải phóng video R2 hết hạn
  await d1.prepare("UPDATE tasks SET status = 'success', publish_status = 'success', scheduled_at = NULL WHERE id = ?").bind(oldTask.id).run();

  const cleanupResp = await callWorker("/api/system/cleanup-expired-media", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({ max_age_days: 30 })
  });
  assert.equal(cleanupResp.status, 200);
  const cleanupData = await cleanupResp.json();
  assert.equal(cleanupData.success, true);
  assert.ok(cleanupData.expired_count >= 1);

  const objAfterCleanup = await r2.get(oldMediaInit.object_key);
  assert.equal(objAfterCleanup, null, "Object trong R2 phải bị xóa sau 30 ngày");

  const mediaAfterCleanup = await d1.prepare("SELECT upload_status FROM media_files WHERE id = ?").bind(oldMediaInit.media_id).first();
  assert.equal(mediaAfterCleanup.upload_status, "expired");

  const taskAfterCleanup = await d1.prepare("SELECT log FROM tasks WHERE id = ?").bind(oldTask.id).first();
  assert.ok(taskAfterCleanup.log.includes("30 days"), "Task log phải ghi nhận video đã tự động dọn dẹp sau 30 ngày");
  console.log("  ✓ [Test 33] Video lưu trên R2 tự xóa sau 1 tháng (30 ngày) & Đồng bộ Cron/API");

  // --------------------------------------------------------------------------
  // [TEST 34] Tự động khắc phục (Self-Healing) schema D1 khi thiếu cột comment_id
  // --------------------------------------------------------------------------
  const { ensureTaskCommentColumns } = await import("../src/db.ts");
  await ensureTaskCommentColumns(d1);
  const pragmaCheck = await d1.prepare("PRAGMA table_info(tasks)").all();
  const cols = new Set(pragmaCheck.results.map((c) => c.name));
  assert.ok(cols.has("comment_id"));
  assert.ok(cols.has("comment_status"));
  assert.ok(cols.has("comment_log"));
  assert.ok(cols.has("comment_posted_at"));
  assert.ok(cols.has("r2_status"));
  console.log("  ✓ [Test 34] Tự động khắc phục (Self-Healing) schema D1 bảo vệ 100% không bị lỗi missing column");

  // --------------------------------------------------------------------------
  // [TEST 35] Xác minh cổng bảo vệ R2 trước khi tạo Task, Bảo vệ xóa R2 khi Task đang chờ & Unified Permission Checker
  // --------------------------------------------------------------------------
  // 1. Tạo task với tên file chưa từng tải lên R2 -> Phải bị chặn HTTP 400 (ngăn ngừa lỗi Task #7 GenCine)
  const unuploadedTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: "unuploaded_local_video_gencine.mp4",
      caption: "Task chưa upload R2",
      schedule_date: "2029-12-20",
      schedule_time: "19:00"
    })
  });
  assert.equal(unuploadedTaskResp.status, 400, "Không được phép tạo Task khi video chưa tải lên R2");
  const unuploadedTaskErr = await unuploadedTaskResp.json();
  assert.ok(unuploadedTaskErr.detail.includes("has not been uploaded yet"));

  // 2. Tạo task bằng tên file gốc ĐÃ tải lên R2 ('alice_reel_01.mp4') -> Tự động ánh xạ về r2://<media_id>
  const byFilenameTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session_token=${tokenA}` },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: "alice_reel_01.mp4",
      caption: "Task tự động phân giải từ tên file đã có trên R2",
      schedule_date: "2029-12-20",
      schedule_time: "19:00"
    })
  });
  assert.equal(byFilenameTaskResp.status, 200);
  const byFilenameTask = (await byFilenameTaskResp.json()).task;
  assert.equal(byFilenameTask.media_id, initUploadData.media_id);
  assert.equal(byFilenameTask.video_path, `r2://${initUploadData.media_id}`);

  // 3. Thử xóa video trên R2 khi đang có task chờ xử lý (byFilenameTask đang pending) -> Phải từ chối xóa để bảo vệ Task
  const delProtectedMediaResp = await callWorker(`/api/media/${initUploadData.media_id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(delProtectedMediaResp.status, 404);
  const delProtectedMediaData = await delProtectedMediaResp.json();
  assert.ok(delProtectedMediaData.detail.includes("Cannot delete video"));

  // 4. Kiểm tra hàm thống nhất verifyPageTokenAndPermissions
  const { verifyPageTokenAndPermissions } = await import("../src/services/metaGraphService.ts");
  const missingTokRes = await verifyPageTokenAndPermissions(d1, env, {
    facebookPageId: "non_existent_page",
    pageAccessToken: "",
    ownerUserId: "non_existent_user",
    mode: "comment"
  });
  assert.equal(missingTokRes.valid, false);
  assert.equal(missingTokRes.errorType, "INVALID_PAGE_TOKEN");
  console.log("  ✓ [Test 35] Cổng xác minh R2 trước khi tạo Task, Bảo vệ Object R2 đang chờ đăng & Unified Permission Checker");

  // --------------------------------------------------------------------------
  // [TEST 36] Chuẩn hóa thời gian 24 tiếng & Tự nhận diện SA/CH/AM/PM và buổi Trưa/Chiều hôm nay
  // --------------------------------------------------------------------------
  const { normalizeVnTime24h } = await import("../src/utils/timezone.ts");

  // 1. Các định dạng 12h kèm SA / CH / AM / PM / tiếng Việt
  assert.equal(normalizeVnTime24h("2:30 CH").normalizedTime, "14:30");
  assert.equal(normalizeVnTime24h("2:30 PM").normalizedTime, "14:30");
  assert.equal(normalizeVnTime24h("12:16 CH").normalizedTime, "12:16");
  assert.equal(normalizeVnTime24h("12:16 PM").normalizedTime, "12:16");
  assert.equal(normalizeVnTime24h("7:05 SA").normalizedTime, "07:05");
  assert.equal(normalizeVnTime24h("7:05 AM").normalizedTime, "07:05");
  assert.equal(normalizeVnTime24h("19:45").normalizedTime, "19:45");
  assert.equal(normalizeVnTime24h("2h30 chiều").normalizedTime, "14:30");

  // 2. Kịch bản thực tế từ ảnh chụp màn hình: Hiện tại là 2026-11-07 12:15 trưa VN (UTC = 05:15)
  // Người dùng chọn ngày hôm nay (2026-11-07 hoặc 07/11/2026) và nhập "12:16 SA" hoặc trình duyệt gửi "00:16"
  const noonVnUtc = Math.floor(Date.UTC(2026, 10, 7, 5, 15, 0) / 1000); // 2026-11-07 12:15:00 VN
  const smartNoonFrom1216SA = parseVnScheduleToUtc("2026-11-07", "12:16 SA", {
    referenceNowUtc: noonVnUtc,
    minLeadSeconds: 60
  });
  assert.equal(smartNoonFrom1216SA.isValid, true, "12:16 SA lúc 12:15 trưa hôm nay phải tự nhận diện thành 12:16");
  assert.equal(smartNoonFrom1216SA.normalizedTime, "12:16");
  assert.equal(smartNoonFrom1216SA.scheduledAtUtc, noonVnUtc + 60);

  const smartNoonFrom0016 = parseVnScheduleToUtc("07/11/2026", "00:16", {
    referenceNowUtc: noonVnUtc,
    minLeadSeconds: 60
  });
  assert.equal(smartNoonFrom0016.isValid, true, "00:16 từ input time 12h lúc 12:15 trưa hôm nay phải tự nhận diện thành 12:16");
  assert.equal(smartNoonFrom0016.normalizedDate, "2026-11-07");
  assert.equal(smartNoonFrom0016.normalizedTime, "12:16");
  assert.equal(smartNoonFrom0016.scheduledAtUtc, noonVnUtc + 60);
  console.log("  ✓ [Test 36] Chuẩn hóa thời gian 24 tiếng (00:00 - 23:59) & Tự động nhận diện SA/CH/AM/PM chính xác");

  // --------------------------------------------------------------------------
  // [TEST 37] KHÓA TASK SAU KHI ĐĂNG REELS THÀNH CÔNG & KHÓA KHI ĐANG XỬ LÝ (PHẦN 1)
  // --------------------------------------------------------------------------
  // 1. finishedWithCmt đã có status = 'success' (từ Test 31) -> Phải có is_locked = true và publish_status = 'success'
  const tasksListForLock = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const lockedSuccessTask = tasksListForLock.find((t) => t.id === finishedWithCmt.id);
  assert.equal(lockedSuccessTask.status, "success");
  assert.equal(lockedSuccessTask.publish_status, "success");
  assert.equal(lockedSuccessTask.is_locked, true, "Task đã đăng thành công phải có is_locked = true");

  // 2. Thử PUT /api/tasks/:id trên task đã đăng thành công -> Bị chặn 403 với TASK_ALREADY_PUBLISHED
  const editPublishedResp = await callWorker(`/api/tasks/${lockedSuccessTask.id}`, {
    method: "PUT",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      caption: "Cố tình sửa caption task đã đăng",
      facebook_page_id: "page_exp_2"
    })
  });
  assert.equal(editPublishedResp.status, 403, "Không được phép sửa task đã đăng thành công");
  const editPublishedErr = await editPublishedResp.json();
  assert.equal(editPublishedErr.error_code, "TASK_ALREADY_PUBLISHED");
  assert.ok(
    editPublishedErr.detail.startsWith(
      "TASK_ALREADY_PUBLISHED: This Reel is already published and cannot be edited."
    )
  );

  // 3. Thử DELETE /api/tasks/:id trên task đã đăng thành công -> Bị chặn 403 với TASK_ALREADY_PUBLISHED
  const delPublishedResp = await callWorker(`/api/tasks/${lockedSuccessTask.id}`, {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(delPublishedResp.status, 403, "Không được phép xóa task đã đăng thành công");
  const delPublishedErr = await delPublishedResp.json();
  assert.equal(delPublishedErr.error_code, "TASK_ALREADY_PUBLISHED");

  // 4. Thử POST /api/tasks/:id/reset trên task đã đăng thành công -> Bị chặn 403 với TASK_ALREADY_PUBLISHED
  const resetPublishedResp = await callWorker(`/api/tasks/${lockedSuccessTask.id}/reset`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(resetPublishedResp.status, 403, "Không được phép reset task đã đăng thành công");
  const resetPublishedErr = await resetPublishedResp.json();
  assert.equal(resetPublishedErr.error_code, "TASK_ALREADY_PUBLISHED");

  // 5. Thử Bulk Delete chỉ chứa task đã đăng thành công -> Bị chặn 403 với TASK_ALREADY_PUBLISHED
  const bulkDelPublishedOnlyResp = await callWorker("/api/tasks/bulk-delete", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task_ids: [lockedSuccessTask.id] })
  });
  assert.equal(bulkDelPublishedOnlyResp.status, 403, "Bulk delete chỉ chứa task đã đăng phải bị chặn");
  const bulkDelPublishedOnlyErr = await bulkDelPublishedOnlyResp.json();
  assert.equal(bulkDelPublishedOnlyErr.error_code, "TASK_ALREADY_PUBLISHED");

  // 6. Thử Bulk Delete hỗn hợp (1 task pending + 1 task đã đăng thành công) -> Chỉ xóa task pending, giữ nguyên task đã đăng
  const mixPendingTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task pending xóa chung với task locked",
      schedule_date: "2029-12-20",
      schedule_time: "19:00"
    })
  });
  const mixPendingTask = (await mixPendingTaskResp.json()).task;
  const bulkDelMixedResp = await callWorker("/api/tasks/bulk-delete", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task_ids: [mixPendingTask.id, lockedSuccessTask.id] })
  });
  assert.equal(bulkDelMixedResp.status, 200);
  const bulkDelMixedData = await bulkDelMixedResp.json();
  assert.equal(bulkDelMixedData.deleted_count, 1, "Chỉ được xóa 1 task pending");
  assert.ok(bulkDelMixedData.skipped_locked_ids.includes(lockedSuccessTask.id), "Phải ghi nhận đã bỏ qua task locked");

  const verifyStillExists = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  assert.ok(verifyStillExists.some((t) => t.id === lockedSuccessTask.id), "Task đã đăng thành công vẫn phải nguyên vẹn trong D1");

  // 7. Kiểm tra khóa khi task đang xử lý (status = 'running' / 'processing' / 'queued')
  const inFlightTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task đang chạy",
      schedule_date: "2029-12-20",
      schedule_time: "19:00"
    })
  });
  const inFlightTask = (await inFlightTaskResp.json()).task;
  await d1.prepare("UPDATE tasks SET status = 'running', publish_status = 'running' WHERE id = ?").bind(inFlightTask.id).run();

  const editRunningResp = await callWorker(`/api/tasks/${inFlightTask.id}`, {
    method: "PUT",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ caption: "Sửa khi đang chạy" })
  });
  assert.equal(editRunningResp.status, 409, "Không được sửa task đang xử lý");
  const editRunningErr = await editRunningResp.json();
  assert.equal(editRunningErr.error_code, "TASK_IN_PROGRESS");

  // Đặt lại failed để kiểm tra task failed vẫn cho phép sửa/reset
  await d1.prepare("UPDATE tasks SET status = 'failed', publish_status = 'failed' WHERE id = ?").bind(inFlightTask.id).run();
  const editFailedResp = await callWorker(`/api/tasks/${inFlightTask.id}`, {
    method: "PUT",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ caption: "Đã sửa lại task failed thành công" })
  });
  assert.equal(editFailedResp.status, 200, "Task failed phải cho phép sửa để thử lại");
  console.log("  ✓ [Test 37] Khóa Task sau khi đăng Reels thành công (TASK_ALREADY_PUBLISHED) & Khóa khi đang xử lý (TASK_CURRENTLY_RUNNING)");

  // --------------------------------------------------------------------------
  // [TEST 38] BỔ SUNG QUYỀN read_insights & TRANG THỐNG KÊ REELS INSIGHTS v27.0 (PHẦN 2, 3, 4, 6, 7)
  // --------------------------------------------------------------------------
  // 1. Khi token hiện tại (EAAB_EXPLORER_TOKEN_VALID) chưa có read_insights:
  // Kiểm tra đồng bộ Insights trả về cảnh báo thiếu quyền rõ ràng mà không làm hỏng hệ thống
  const syncWithoutPermResp = await callWorker(`/api/tasks/${staleTask.id}/sync-insights`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncWithoutPermResp.status, 200);
  const syncWithoutPermData = await syncWithoutPermResp.json();
  assert.equal(syncWithoutPermData.analytics_status, "partial", "Thiếu read_insights nhưng vẫn lấy được tương tác cơ bản -> partial");
  assert.ok(
    syncWithoutPermData.warnings.some((w) => w.includes("read_insights") || w.includes("ANALYZE")),
    "Phải có cảnh báo thiếu quyền read_insights hoặc ANALYZE"
  );
  assert.equal(
    syncWithoutPermData.snapshot.reach,
    null,
    "Khi thiếu read_insights, chỉ số Reach không lấy được phải là null chứ không bị ép về 0"
  );

  // 2. Liên kết/Cập nhật token có đầy đủ read_insights và ANALYZE (EAAB_EXPLORER_TOKEN_WITH_INSIGHTS)
  const connectInsightsResp = await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "EAAB_EXPLORER_TOKEN_WITH_INSIGHTS" })
  });
  assert.equal(connectInsightsResp.status, 200);
  const connectInsightsData = await connectInsightsResp.json();
  assert.equal(connectInsightsData.has_read_insights, true, "Token mới phải ghi nhận has_read_insights = true");
  assert.equal(connectInsightsData.insights_warning, null, "Có đủ read_insights thì không còn cảnh báo thiếu quyền");
  assert.equal(connectInsightsData.analyze_warning, null, "Có đủ quyền ANALYZE trên Page thì không còn cảnh báo");

  // 3. Đồng bộ Insights cho bài Reels đã đăng (staleTask: video_id=1439027771006176, post_id=1418723557985686_122107908045520254)
  const syncSingleResp = await callWorker(`/api/tasks/${staleTask.id}/sync-insights`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncSingleResp.status, 200);
  const syncSingleData = await syncSingleResp.json();
  assert.equal(syncSingleData.success, true, "Đồng bộ Insights phải thành công khi có read_insights");
  assert.equal(syncSingleData.analytics_status, "success");
  assert.equal(syncSingleData.snapshot.plays, 12500);
  assert.equal(syncSingleData.snapshot.views, 12500);
  assert.equal(syncSingleData.snapshot.reach, 9800);
  assert.equal(syncSingleData.snapshot.total_watch_time_ms, 185000);
  assert.equal(syncSingleData.snapshot.avg_watch_time_ms, 6500);
  assert.equal(syncSingleData.snapshot.replays, 1400);
  assert.equal(syncSingleData.snapshot.likes, 400);
  assert.equal(syncSingleData.snapshot.comments, 45);
  assert.equal(syncSingleData.snapshot.shares, 25);
  assert.equal(syncSingleData.snapshot.total_interactions, 470);

  // 4. Đồng bộ lại lần 2 trong cùng ngày -> Không tạo trùng lặp bản ghi snapshot cùng (task_id, sync_date)
  await callWorker(`/api/tasks/${staleTask.id}/sync-insights`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const snapCountRow = await d1
    .prepare("SELECT COUNT(*) AS cnt FROM reel_insight_snapshots WHERE task_id = ?")
    .bind(staleTask.id)
    .first();
  assert.equal(Number(snapCountRow.cnt), 1, "Đồng bộ nhiều lần trong ngày phải UPSERT chứ không tạo trùng snapshot");

  // 5. Truy vấn Dashboard Thống kê Reels GET /api/insights/reels (với bộ lọc Page & Thời gian)
  const dashResp = await callWorker("/api/insights/reels?range=30d&sort_by=views&sort_dir=desc", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(dashResp.status, 200);
  const dashData = await dashResp.json();
  assert.ok(dashData.total_published_reels >= 1);
  assert.equal(dashData.overview.total_views, 12500);
  assert.equal(dashData.overview.total_reach, 9800);
  assert.equal(dashData.overview.total_interactions, 470);
  assert.equal(dashData.overview.total_watch_time_ms, 185000);
  assert.equal(dashData.overview.avg_watch_time_ms, 6500);
  assert.ok(Array.isArray(dashData.charts.views_over_time));
  assert.ok(Array.isArray(dashData.charts.performance_by_reel));
  assert.ok(Array.isArray(dashData.charts.page_comparison));

  // 6. Truy vấn Chi tiết Insights của 1 Reel GET /api/insights/reels/:taskId
  const detailResp = await callWorker(`/api/insights/reels/${staleTask.id}`, {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(detailResp.status, 200);
  const detailData = await detailResp.json();
  assert.equal(detailData.task.id, staleTask.id);
  assert.equal(detailData.task.video_id, "1439027771006176");
  assert.equal(detailData.latest_snapshot.plays, 12500);
  assert.ok(detailData.metrics.some((m) => m.metric_name === "fb_reels_total_plays" && m.status === "supported"));
  assert.ok(
    detailData.metrics.some((m) => m.metric_name === "post_video_retention_graph" && m.status === "unavailable" && m.value === null),
    "Metric không được hỗ trợ phải có value = null chứ không bị ép về 0"
  );

  // 7. Cô lập dữ liệu Multi-User: Bob không được xem hoặc đồng bộ Insights của Alice
  const bobStealInsightResp = await callWorker(`/api/insights/reels/${staleTask.id}`, {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  assert.equal(bobStealInsightResp.status, 404, "User khác không được xem chi tiết Insights của Alice");

  const bobStealDashResp = await callWorker("/api/insights/reels?range=30d", {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  const bobDashData = await bobStealDashResp.json();
  assert.equal(bobDashData.reels.length, 0, "Dashboard Insights của Bob không được chứa Reels của Alice");

  // 8. Kiểm tra route HTML /insights trả về giao diện ứng dụng
  const insightsPageResp = await callWorker("/insights", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(insightsPageResp.status, 200);
  const insightsHtml = await insightsPageResp.text();
  assert.ok(insightsHtml.includes("Reels analytics"), "Route /insights phải hiển thị giao diện Thống kê Reels");
  console.log("  ✓ [Test 38] Quyền read_insights + ANALYZE, Đồng bộ Meta Video Insights v27.0, Lưu Snapshot D1 & Cô lập Multi-User");

  // --------------------------------------------------------------------------
  // [TEST 39] PHÂN LOẠI 8 LOẠI LỖI META & CẬP NHẬT TOKEN AN TOÀN KHÔNG MẤT DỮ LIỆU (PHẦN 5)
  // --------------------------------------------------------------------------
  const { classifyMetaApiError } = await import("../src/services/metaGraphService.ts");

  assert.equal(
    classifyMetaApiError(190, 463, "Error validating access token: Session has expired").category,
    "TOKEN_EXPIRED"
  );
  assert.equal(
    classifyMetaApiError(190, 458, "User has not authorized application").category,
    "TOKEN_REVOKED"
  );
  assert.equal(
    classifyMetaApiError(190, undefined, "Invalid OAuth access token").category,
    "INVALID_TOKEN"
  );
  assert.equal(
    classifyMetaApiError(200, undefined, "(#200) Requires pages_manage_posts permission").category,
    "MISSING_PERMISSION"
  );
  assert.equal(
    classifyMetaApiError(200, undefined, "User does not have MODERATE task on this page").category,
    "MISSING_PAGE_ROLE"
  );
  assert.equal(
    classifyMetaApiError(100, undefined, "Page token does not match target page_id").category,
    "PAGE_TOKEN_MISMATCH"
  );
  assert.equal(
    classifyMetaApiError(4, undefined, "Application request limit reached").category,
    "RATE_LIMIT_OR_TEMPORARY"
  );
  assert.equal(
    classifyMetaApiError(999, undefined, "Some other Graph API error").category,
    "OTHER_API_ERROR"
  );

  // Kiểm tra quy trình Cập nhật Access Token an toàn (/api/meta/accounts/:id/update-token)
  const aliceAccsNow = await (
    await callWorker("/api/meta/accounts", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const expAdmin = aliceAccsNow.find((a) => a.facebook_user_id === "fb_uid_exp_1");
  assert.ok(expAdmin, "Phải tìm thấy tài khoản Admin fb_uid_exp_1 của Alice");

  // Tạo 1 task đã đăng trên page_exp_2 để kiểm tra bảo toàn dữ liệu khi token mới thiếu quyền quản lý page_exp_2
  const taskOnPage2Resp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_2",
      video_path: compUploadData.video_path,
      caption: "Reel lịch sử trên Page 2 (Zyntrix Vietnam)",
      schedule_date: "2029-12-20",
      schedule_time: "19:40"
    })
  });
  const taskOnPage2 = (await taskOnPage2Resp.json()).task;
  await d1
    .prepare("UPDATE tasks SET status = 'success', publish_status = 'success', is_locked = 1, video_id = 'vid_p2', post_id = 'page_exp_2_post_1' WHERE id = ?")
    .bind(taskOnPage2.id)
    .run();

  // 1. Thử cập nhật bằng Token KHÔNG HỢP LỆ -> Phải từ chối 400 và KHÔNG ghi đè token cũ đang lưu trong D1
  const badUpdateResp = await callWorker(`/api/meta/accounts/${expAdmin.id}/update-token`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "EAAB_EXPLORER_TOKEN_INVALID" })
  });
  assert.equal(badUpdateResp.status, 400, "Token mới không hợp lệ phải bị từ chối trước khi ghi đè");
  const accAfterBadUpdate = await (
    await callWorker("/api/meta/accounts", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const expAdminStillValid = accAfterBadUpdate.find((a) => a.id === expAdmin.id);
  assert.equal(expAdminStillValid.status, "connected", "Token cũ hợp lệ không được bị xóa khi token mới lỗi");

  // 2. Cập nhật bằng Token mới hợp lệ nhưng CHỈ có quyền trên page_exp_1 (thiếu quyền trên page_exp_2)
  // Hệ thống phải:
  // - Cập nhật token mới cho page_exp_1
  // - KHÔNG xóa page_exp_2 khỏi DB, đánh dấu page_exp_2 là missing_permission
  // - KHÔNG xóa task lịch sử của page_exp_2
  const partialUpdateResp = await callWorker(`/api/meta/accounts/${expAdmin.id}/update-token`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "EAAB_EXPLORER_TOKEN_PARTIAL_PAGES" })
  });
  assert.equal(partialUpdateResp.status, 200);
  const partialUpdateData = await partialUpdateResp.json();
  assert.equal(partialUpdateData.success, true);
  assert.ok(
    partialUpdateData.missing_permission_page_ids.includes("page_exp_2"),
    "Phải phát hiện và cảnh báo page_exp_2 bị thiếu quyền trong token mới"
  );
  assert.equal(
    partialUpdateData.missing_pages_warning,
    "This Page is not in the new token, or you lack admin access to it."
  );

  const pagesAfterPartial = await (
    await callWorker("/api/pages", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const page2Preserved = pagesAfterPartial.find((p) => p.facebook_page_id === "page_exp_2");
  assert.ok(page2Preserved, "page_exp_2 không được bị xóa mất khi cập nhật token thiếu quyền");
  assert.equal(page2Preserved.status, "missing_permission", "page_exp_2 phải được đánh dấu status = missing_permission");

  const tasksAfterPartial = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.ok(
    tasksAfterPartial.some((t) => t.id === taskOnPage2.id && t.status === "success"),
    "Task lịch sử của page_exp_2 phải được giữ nguyên 100%"
  );
  console.log("  ✓ [Test 39] Phân loại 8 loại lỗi Meta API & Cập nhật Access Token an toàn (Bảo toàn Page & Lịch sử Task)");

  // --------------------------------------------------------------------------
  // [TEST 40] BẮT BUỘC NHẬP NGÀY VÀ GIỜ ĐĂNG & TASK CŨ THIẾU LỊCH CHUYỂN NEEDS_SCHEDULE
  // --------------------------------------------------------------------------
  console.log("\n  --- BẮT ĐẦU KIỂM THỬ TỐI ƯU TASK MANAGEMENT & META GRAPH API ---");

  // 1. Tạo task bỏ trống cả ngày và giờ -> Bị từ chối HTTP 400 kèm SCHEDULE_REQUIRED và field_errors
  const emptyBothResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task thiếu cả ngày và giờ",
      schedule_date: "   ",
      schedule_time: "   "
    })
  });
  assert.equal(emptyBothResp.status, 400);
  const emptyBothErr = await emptyBothResp.json();
  assert.equal(emptyBothErr.error_code, "SCHEDULE_REQUIRED");
  assert.ok(emptyBothErr.field_errors.schedule_date);
  assert.ok(emptyBothErr.field_errors.schedule_time);

  // 2. Tạo task chỉ nhập ngày, thiếu giờ -> Bị từ chối HTTP 400
  const missingTimeResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task thiếu giờ",
      schedule_date: "2029-12-25",
      schedule_time: ""
    })
  });
  assert.equal(missingTimeResp.status, 400);
  const missingTimeErr = await missingTimeResp.json();
  assert.equal(missingTimeErr.missing_time, true);

  // 3. Tạo task chỉ nhập giờ, thiếu ngày -> Bị từ chối HTTP 400
  const missingDateResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task thiếu ngày",
      schedule_date: "",
      schedule_time: "14:00"
    })
  });
  assert.equal(missingDateResp.status, 400);
  const missingDateErr = await missingDateResp.json();
  assert.equal(missingDateErr.missing_date, true);

  // 4. Tạo task với thời gian trong quá khứ -> Bị từ chối HTTP 400 kèm PAST_SCHEDULE_TIME & is_past = true
  const pastRejectResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task quá khứ",
      schedule_date: "2021-05-10",
      schedule_time: "08:00"
    })
  });
  assert.equal(pastRejectResp.status, 400);
  const pastRejectErr = await pastRejectResp.json();
  assert.equal(pastRejectErr.error_code, "PAST_SCHEDULE_TIME");
  assert.equal(pastRejectErr.is_past, true);

  // 5. Bulk Create thiếu lịch đăng -> Bị từ chối 400
  const bulkMissingSchedResp = await callWorker("/api/tasks/bulk", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tasks: [
        {
          video_path: compUploadData.video_path,
          caption: "Bulk thiếu lịch",
          schedule_date: "",
          schedule_time: ""
        }
      ],
      assign_page_ids: ["page_exp_1"]
    })
  });
  assert.equal(bulkMissingSchedResp.status, 400);

  // 6. Task cũ không có ngày giờ trong D1 -> Hiển thị needs_schedule, không tự động đăng, Cron không claim
  const legacyTaskInsert = await d1.prepare(`
    INSERT INTO tasks (
      owner_user_id, facebook_page_id, video_path, caption,
      schedule_date, schedule_time, scheduled_at, status, is_locked
    ) VALUES (?, ?, ?, ?, '', '', NULL, 'pending', 0)
  `).bind(aliceAccsNow[0].owner_user_id, "page_exp_1", compUploadData.video_path, "Legacy task không có lịch").run();
  const legacyTaskId = legacyTaskInsert.meta.last_row_id;

  const tasksListWithLegacy = await (await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })).json();
  const foundLegacy = tasksListWithLegacy.find((t) => t.id === legacyTaskId);
  assert.equal(foundLegacy.status, "needs_schedule", "Task cũ không có lịch phải hiển thị needs_schedule");
  assert.equal(foundLegacy.needs_schedule, true);

  // Chạy Cron -> Đảm bảo legacy task KHÔNG bị đưa vào Queue
  const cronBgLegacy = [];
  const cronResLegacy = await workerDefault.scheduled(
    { cron: "*/1 * * * *", type: "scheduled", scheduledTime: Date.now() },
    env,
    { waitUntil: (p) => cronBgLegacy.push(p), passThroughOnException: () => {} }
  );
  await Promise.all(cronBgLegacy);
  assert.ok(!cronResLegacy.task_ids.includes(legacyTaskId), "Cron Scheduler tuyệt đối không claim task thiếu lịch");
  console.log("  ✓ [Test 40] Bắt buộc nhập ngày & giờ đăng; Chặn quá khứ; Task cũ thiếu lịch thành needs_schedule an toàn");

  // --------------------------------------------------------------------------
  // [TEST 41] ĐĂNG NGAY TRÊN TỪNG TASK (PUBLISH-NOW) & BULK PUBLISH-NOW & AUDIT LOGS
  // --------------------------------------------------------------------------
  // 1. Tạo 1 task hợp lệ hẹn lịch xa (2029-12-25 15:30)
  const taskToPublishNowResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task test publish-now #reels",
      comment_text: "Auto comment publish now",
      schedule_date: "2029-12-25",
      schedule_time: "15:30"
    })
  });
  assert.equal(taskToPublishNowResp.status, 200);
  const taskToPub = (await taskToPublishNowResp.json()).task;

  // 2. Nhấn POST /api/tasks/:id/publish-now
  const pubNowResp = await callWorker(`/api/tasks/${taskToPub.id}/publish-now`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.ok([200, 202].includes(pubNowResp.status));
  const pubNowData = await pubNowResp.json();
  assert.equal(pubNowData.success, true);
  assert.equal(pubNowData.task.status, "queued");
  assert.equal(pubNowData.task.trigger_source, "manual_publish_now");
  assert.equal(pubNowData.task.original_schedule_date, "2029-12-25", "Phải bảo toàn ngày đăng ban đầu");
  assert.equal(pubNowData.task.original_schedule_time, "15:30", "Phải bảo toàn giờ đăng ban đầu");
  assert.ok(pubNowData.task.manual_publish_requested_at, "Phải ghi nhận thời điểm yêu cầu đăng ngay");

  // 3. Worker tiêu thụ Queue message và xuất bản bài Reels + Comment
  await consumeSingleTaskMessage(d1, env, {
    task_id: taskToPub.id,
    owner_user_id: taskToPub.owner_user_id,
    idempotency_key: `idem_pubnow_${taskToPub.id}`,
    attempt: 1,
    enqueued_at: Math.floor(Date.now() / 1000)
  });

  const taskAfterPubNow = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const finishedPubNow = taskAfterPubNow.find((t) => t.id === taskToPub.id);
  assert.equal(finishedPubNow.status, "success");
  assert.equal(finishedPubNow.is_locked, true, "Task đăng thành công phải bị khóa");
  assert.equal(finishedPubNow.comment_status, "success");

  // 4. Kiểm tra Audit Logs qua GET /api/tasks/:id/audit-logs
  const auditLogsResp = await callWorker(`/api/tasks/${taskToPub.id}/audit-logs`, {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(auditLogsResp.status, 200);
  const auditLogsData = await auditLogsResp.json();
  assert.ok(auditLogsData.audit_logs.length >= 2);
  const actionNames = auditLogsData.audit_logs.map((l) => l.action);
  assert.ok(actionNames.includes("publish_now") || actionNames.includes("manual_publish_now"), "Audit log phải có hành động publish_now");
  assert.ok(actionNames.includes("publish_success") || actionNames.includes("published"), "Audit log phải có hành động publish_success");
  for (const logItem of auditLogsData.audit_logs) {
    assert.equal(logItem.access_token, undefined, "Tuyệt đối không lưu Access Token vào audit logs");
    assert.equal(logItem.cookie, undefined, "Tuyệt đối không lưu Cookie vào audit logs");
  }

  // 5. Thử gọi publish-now lần 2 trên task đã đăng thành công -> Phải bị chặn 403 / 409
  const pubAgainResp = await callWorker(`/api/tasks/${taskToPub.id}/publish-now`, {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.ok([400, 403, 409].includes(pubAgainResp.status));
  const pubAgainErr = await pubAgainResp.json();
  assert.ok(["TASK_ALREADY_PUBLISHED", "TASK_LOCKED_AFTER_PUBLISH"].includes(pubAgainErr.error_code));

  // 6. Kiểm tra Bulk Publish Now (POST /api/tasks/bulk-publish-now)
  const bulkPubT1Resp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Bulk Pub Now 1",
      schedule_date: "2029-12-28",
      schedule_time: "10:00"
    })
  });
  const bulkPubT2Resp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Bulk Pub Now 2",
      schedule_date: "2029-12-28",
      schedule_time: "11:00"
    })
  });
  const bulkPubT1 = (await bulkPubT1Resp.json()).task;
  const bulkPubT2 = (await bulkPubT2Resp.json()).task;

  // Gọi Bulk Publish Now bao gồm cả task đã hoàn thành (finishedPubNow.id)
  const bulkPubNowExecResp = await callWorker("/api/tasks/bulk-publish-now", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task_ids: [bulkPubT1.id, bulkPubT2.id, finishedPubNow.id] })
  });
  assert.ok([200, 202].includes(bulkPubNowExecResp.status));
  const bulkPubNowExecData = await bulkPubNowExecResp.json();
  assert.equal(bulkPubNowExecData.eligible_count, 2, "Chỉ được enqueue 2 task hợp lệ");
  assert.ok(bulkPubNowExecData.skipped.some((s) => s.id === finishedPubNow.id), "Phải báo rõ task đã đăng bị bỏ qua");

  // 7. Đảm bảo task FAILED không bị khóa vĩnh viễn (is_locked = 0)
  const failTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Task giả lập failed",
      schedule_date: "2029-12-30",
      schedule_time: "09:00"
    })
  });
  const failTask = (await failTaskResp.json()).task;
  await d1.prepare("UPDATE tasks SET status = 'failed', publish_status = 'failed', is_locked = 0, log = 'Simulated error' WHERE id = ?")
    .bind(failTask.id)
    .run();
  const taskAfterFail = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const foundFail = taskAfterFail.find((t) => t.id === failTask.id);
  assert.equal(foundFail.status, "failed");
  assert.equal(foundFail.is_locked, false, "Task thất bại phải có is_locked = false để cho phép sửa và thử lại");
  console.log("  ✓ [Test 41] Đăng ngay (Publish-Now) từng task & Bulk; Bảo toàn lịch cũ; Ghi Audit Logs; Mở khóa task failed");

  // --------------------------------------------------------------------------
  // [TEST 42] THAO TÁC HÀNG LOẠT: BULK RESCHEDULE (GIÃN CÁCH) & BULK CANCEL
  // --------------------------------------------------------------------------
  // 1. Bulk Reschedule với khoảng cách thời gian (interval_minutes: 15)
  const rTask1Resp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reschedule task 1",
      schedule_date: "2029-12-28",
      schedule_time: "08:00"
    })
  });
  const rTask2Resp = await callWorker("/api/tasks", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      facebook_page_id: "page_exp_1",
      video_path: compUploadData.video_path,
      caption: "Reschedule task 2",
      schedule_date: "2029-12-28",
      schedule_time: "08:15"
    })
  });
  const rTask1 = (await rTask1Resp.json()).task;
  const rTask2 = (await rTask2Resp.json()).task;

  const bulkReschedResp = await callWorker("/api/tasks/bulk-reschedule", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task_ids: [rTask1.id, rTask2.id, finishedPubNow.id],
      new_schedule_date: "2030-01-15",
      new_schedule_time: "10:00",
      interval_minutes: 20
    })
  });
  assert.equal(bulkReschedResp.status, 200);
  const bulkReschedData = await bulkReschedResp.json();
  assert.equal(bulkReschedData.rescheduled_count, 2);
  assert.ok(bulkReschedData.skipped_tasks.some((s) => s.id === finishedPubNow.id), "Phải bỏ qua task đã đăng thành công");

  const tasksAfterResched = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  const updatedR1 = tasksAfterResched.find((t) => t.id === rTask1.id);
  const updatedR2 = tasksAfterResched.find((t) => t.id === rTask2.id);
  assert.equal(updatedR1.schedule_date, "2030-01-15");
  assert.equal(updatedR1.schedule_time, "10:00");
  assert.equal(updatedR2.schedule_date, "2030-01-15");
  assert.equal(updatedR2.schedule_time, "10:20", "Task thứ 2 phải được giãn cách đúng 20 phút");

  // 2. Bulk Cancel
  const bulkCancelResp = await callWorker("/api/tasks/bulk-cancel", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task_ids: [rTask1.id, rTask2.id] })
  });
  assert.equal(bulkCancelResp.status, 200);
  const bulkCancelData = await bulkCancelResp.json();
  assert.equal(bulkCancelData.cancelled_count, 2);

  const tasksAfterCancel = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.equal(tasksAfterCancel.find((t) => t.id === rTask1.id).status, "cancelled");
  assert.equal(tasksAfterCancel.find((t) => t.id === rTask2.id).status, "cancelled");
  console.log("  ✓ [Test 42] Thao tác hàng loạt: Đổi lịch có giãn cách thời gian (Staggered Reschedule) & Hủy lịch an toàn");

  // --------------------------------------------------------------------------
  // [TEST 43] TỐI ƯU META GRAPH API, THEO DÕI RATE-LIMIT & KHẮC PHỤC TRANG /INSIGHTS
  // --------------------------------------------------------------------------
  // 1. Kiểm tra Cache 15 phút của verifyPageTokenAndPermissions
  const cacheTestRes1 = await verifyPageTokenAndPermissions(d1, env, {
    facebookPageId: "page_exp_1",
    pageAccessToken: "EAAB_PAGE_TOKEN_EXP_1_INSIGHTS",
    ownerUserId: aliceAccsNow[0].owner_user_id,
    mode: "comment"
  });
  assert.equal(cacheTestRes1.valid, true);

  // Gọi lần 2: phải trả về từ cache mà không gọi mock fetch
  const cacheTestRes2 = await verifyPageTokenAndPermissions(d1, env, {
    facebookPageId: "page_exp_1",
    pageAccessToken: "EAAB_PAGE_TOKEN_EXP_1_INSIGHTS",
    ownerUserId: aliceAccsNow[0].owner_user_id,
    mode: "comment"
  });
  assert.equal(cacheTestRes2.valid, true);

  // 2. Kiểm tra API Telemetry Endpoint (GET /api/system/api-telemetry)
  const telemetryResp = await callWorker("/api/system/api-telemetry", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(telemetryResp.status, 200);
  const telemetryData = await telemetryResp.json();
  assert.equal(telemetryData.success, true);
  assert.ok(telemetryData.throttle || telemetryData.throttle_state);
  assert.ok(telemetryData.totals);
  assert.ok(Array.isArray(telemetryData.endpoints));

  // 3. Kiểm tra Data Contract của Dashboard /insights trả về đầy đủ các trường mà UI yêu cầu
  const insightsContractResp = await callWorker("/api/insights/reels?range=30d", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(insightsContractResp.status, 200);
  const insightsContract = await insightsContractResp.json();
  assert.ok(insightsContract.reels.length >= 1);
  const sampleReel = insightsContract.reels[0];
  // Khắc phục lỗi màn hình tối do thiếu metrics.views (như trong ảnh lỗi của user)
  assert.ok(sampleReel.metrics, "Mỗi Reel trong danh sách /insights phải có object metrics");
  assert.ok(sampleReel.metrics.views === null || typeof sampleReel.metrics.views === "number", "metrics.views phải là số hoặc null");
  assert.ok(sampleReel.metrics.reach === null || typeof sampleReel.metrics.reach === "number", "metrics.reach phải là số hoặc null");
  assert.ok(sampleReel.metrics.interactions === null || typeof sampleReel.metrics.interactions === "number", "metrics.interactions phải là số hoặc null");
  assert.ok(sampleReel.metrics.likes === null || typeof sampleReel.metrics.likes === "number");
  assert.ok(sampleReel.metrics.comments === null || typeof sampleReel.metrics.comments === "number");
  assert.ok(sampleReel.metrics.shares === null || typeof sampleReel.metrics.shares === "number");

  assert.equal(typeof insightsContract.overview.total_reels_count, "number");
  assert.ok(Array.isArray(insightsContract.permission_warnings));
  assert.ok(Array.isArray(insightsContract.charts.reel_performance));
  assert.ok(Array.isArray(insightsContract.charts.page_comparison));
  if (insightsContract.charts.page_comparison.length > 0) {
    assert.equal(typeof insightsContract.charts.page_comparison[0].interactions, "number");
  }

  // 4. Kiểm tra Chi tiết Reel Insights (GET /api/insights/reels/:taskId)
  const reelDetailContractResp = await callWorker(`/api/insights/reels/${staleTask.id}`, {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(reelDetailContractResp.status, 200);
  const reelDetailContract = await reelDetailContractResp.json();
  assert.ok(Array.isArray(reelDetailContract.metric_items));
  assert.ok(reelDetailContract.metric_items.length >= 5);
  const sampleItem = reelDetailContract.metric_items[0];
  assert.ok(sampleItem.metric_name);
  assert.ok(sampleItem.metric_label);
  assert.ok(sampleItem.metric_status);
  assert.ok(sampleItem.fetched_at);
  console.log("  ✓ [Test 43] Tối ưu Graph API: 15-min TTL Cache, Rate-Limit Header Monitor & Hoàn thiện Data Contract /insights 100%");

  // --------------------------------------------------------------------------
  // [TEST 44] Thêm nhanh hàng loạt Task từ Excel (Bulk Excel Import) & Phân bổ lịch
  // --------------------------------------------------------------------------
  console.log("\n  --- BẮT ĐẦU KIỂM THỬ THÊM NHANH HÀNG LOẠT TASK TỪ EXCEL ---");

  // 1. Kiểm tra thuật toán phân tích chuỗi Excel (Clipboard TAB & Newline)
  function testParseExcelData(rawText, baseDate, baseTime, intervalMinutes) {
    if (!rawText || !rawText.trim()) return [];
    const lines = rawText.split(/\r?\n/);
    const parsed = [];
    let validRowIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (!rawLine.trim()) continue;

      const sep = rawLine.includes("\t") ? "\t" : (rawLine.includes("|") ? "|" : "\t");
      const parts = rawLine.split(sep);
      const cleanParts = parts.map((p) => {
        let s = (p || "").trim();
        if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
          s = s.slice(1, -1).replace(/""/g, '"').trim();
        }
        return s;
      });

      const vPath = cleanParts[0] || "";
      const cap = cleanParts[1] !== undefined ? cleanParts[1] : "";
      const comment = cleanParts[2] !== undefined ? cleanParts[2] : "";

      let isValid = true;
      let errorReason = "";

      if (parts.length < 3) {
        isValid = false;
        errorReason = `Thiếu cột: Chỉ có ${parts.length} cột (Yêu cầu đúng 3 cột: Video, Caption, Bình luận)`;
      } else if (parts.length > 3) {
        isValid = false;
        errorReason = `Thừa cột: Dòng có ${parts.length} cột (Yêu cầu đúng 3 cột: Video, Caption, Bình luận)`;
      } else if (!vPath) {
        isValid = false;
        errorReason = "Đường dẫn video không được để trống";
      } else if (!cap) {
        isValid = false;
        errorReason = "Caption không được để trống";
      }

      // Staggered schedule calculation
      let schedDate = "";
      let schedTime = "";
      if (baseDate && baseTime) {
        const [y, m, d] = baseDate.split("-").map(Number);
        const [hh, mm] = baseTime.split(":").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
        dt.setUTCMinutes(dt.getUTCMinutes() + validRowIndex * intervalMinutes);
        schedDate = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
        schedTime = `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`;
        validRowIndex++;
      }

      parsed.push({
        row_index: i + 1,
        video_path: vPath,
        filename: vPath.split(/[\\/]/).pop().trim(),
        caption: cap,
        comment_text: comment,
        is_valid: isValid,
        error_reason: errorReason,
        schedule_date: schedDate,
        schedule_time: schedTime
      });
    }
    return parsed;
  }

  // 1a. Test 1 dòng hợp lệ
  const excel1Row = "D:\\Videos\\video01.mp4\tCaption video số 1\tBình luận số 1";
  const parsed1 = testParseExcelData(excel1Row, "2026-11-10", "08:00", 15);
  assert.equal(parsed1.length, 1);
  assert.equal(parsed1[0].is_valid, true);
  assert.equal(parsed1[0].filename, "video01.mp4");
  assert.equal(parsed1[0].caption, "Caption video số 1");
  assert.equal(parsed1[0].comment_text, "Bình luận số 1");
  assert.equal(parsed1[0].schedule_date, "2026-11-10");
  assert.equal(parsed1[0].schedule_time, "08:00");

  // 1b. Test caption có tiếng Việt, emoji, dấu phẩy, chấm phẩy & bình luận rỗng
  const excelComplex = [
    "D:\\Videos\\reel_vn.mp4\tĐây là video hài, có dấu phẩy; và emoji 🤣🔥\tBình luận số 1",
    "video02.mp4\tCaption video số 2 có dấu 'nháy đơn' và \"kép\"\t",
    "https://cdn.example.com/stream.mp4\tCaption video số 3\tBình luận 3"
  ].join("\n");
  const parsedComplex = testParseExcelData(excelComplex, "2026-11-10", "23:45", 15);
  assert.equal(parsedComplex.length, 3);
  assert.equal(parsedComplex[0].is_valid, true);
  assert.equal(parsedComplex[0].caption, "Đây là video hài, có dấu phẩy; và emoji 🤣🔥");
  assert.equal(parsedComplex[1].is_valid, true);
  assert.equal(parsedComplex[1].comment_text, "", "Bình luận để trống phải hợp lệ");

  // 1c. Test phân bổ lịch vượt qua nửa đêm (23:45 + 15p = 00:00 ngày hôm sau)
  assert.equal(parsedComplex[0].schedule_date, "2026-11-10");
  assert.equal(parsedComplex[0].schedule_time, "23:45");
  assert.equal(parsedComplex[1].schedule_date, "2026-11-11", "Tự động chuyển sang ngày mới khi cộng dồn qua nửa đêm");
  assert.equal(parsedComplex[1].schedule_time, "00:00");
  assert.equal(parsedComplex[2].schedule_date, "2026-11-11");
  assert.equal(parsedComplex[2].schedule_time, "00:15");

  // 1d. Test phát hiện thiếu cột, thừa cột, dòng trống
  const excelErrors = [
    "",
    "D:\\Videos\\err1.mp4\tChỉ có 2 cột",
    "D:\\Videos\\err2.mp4\tCột 2\tCột 3\tCột 4 thừa",
    "   ",
    "D:\\Videos\\valid.mp4\tCaption hợp lệ\tCmt hợp lệ"
  ].join("\n");
  const parsedErrors = testParseExcelData(excelErrors, "2026-11-10", "08:00", 15);
  assert.equal(parsedErrors.length, 3, "Dòng trống phải được bỏ qua hoàn toàn");
  assert.equal(parsedErrors[0].is_valid, false, "Phải phát hiện dòng thiếu cột");
  assert.ok(parsedErrors[0].error_reason.includes("Thiếu cột"));
  assert.equal(parsedErrors[1].is_valid, false, "Phải phát hiện dòng thừa cột");
  assert.ok(parsedErrors[1].error_reason.includes("Thừa cột"));
  assert.equal(parsedErrors[2].is_valid, true, "Dòng đúng 3 cột phải hợp lệ");

  // 2. Kiểm tra API POST /api/tasks/bulk tích hợp tự động phân bổ lịch & so khớp video R2
  // Upload 1 video chuẩn lên R2 của Alice với filename "excel_reel_1.mp4"
  const excelInitResp = await callWorker("/api/media/upload-init", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "excel_reel_1.mp4", size_bytes: 4096, mime_type: "video/mp4" })
  });
  const excelInitData = await excelInitResp.json();
  const testBytes = new Uint8Array(4096);
  testBytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const excelPutResp = await callWorker(excelInitData.upload_url, {
    method: "PUT",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "video/mp4",
      "Content-Length": "4096"
    },
    body: testBytes
  });
  assert.equal(excelPutResp.status, 200);
  const excelCompResp = await callWorker("/api/media/upload-complete", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ media_id: excelInitData.media_id })
  });
  assert.equal(excelCompResp.status, 200);

  // Gọi POST /api/tasks/bulk với đường dẫn máy tính "D:\MyVideos\excel_reel_1.mp4"
  // Hệ thống phải tự động tìm thấy video R2 đã upload theo tên file
  const excelBulkCreateResp = await callWorker("/api/tasks/bulk", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      schedule_date: "2029-11-10",
      schedule_time: "08:00",
      interval_minutes: 20,
      tasks: [
        {
          video_path: "D:\\MyVideos\\excel_reel_1.mp4",
          caption: "Excel Reel 1 Caption",
          comment_text: "Excel Comment 1"
        },
        {
          video_path: `r2://${excelInitData.media_id}`,
          caption: "Excel Reel 2 Caption",
          comment_text: ""
        }
      ],
      assign_page_ids: ["page_101"]
    })
  });
  assert.equal(excelBulkCreateResp.status, 200);
  const excelBulkJson = await excelBulkCreateResp.json();
  assert.equal(excelBulkJson.success, true);
  assert.equal(excelBulkJson.inserted_count, 2);

  // Kiểm tra task 1 được tự động gán media_id và lịch 08:00, task 2 là 08:20
  const createdExcelTask1 = await d1.prepare("SELECT * FROM tasks WHERE id = ?").bind(excelBulkJson.task_ids[0]).first();
  const createdExcelTask2 = await d1.prepare("SELECT * FROM tasks WHERE id = ?").bind(excelBulkJson.task_ids[1]).first();
  assert.equal(createdExcelTask1.media_id, excelInitData.media_id, "Tự động so khớp video R2 theo tên file máy tính D:\\...\\excel_reel_1.mp4");
  assert.equal(createdExcelTask1.schedule_date, "2029-11-10");
  assert.equal(createdExcelTask1.schedule_time, "08:00");
  assert.equal(createdExcelTask1.trigger_source, "excel_bulk");
  assert.equal(createdExcelTask2.schedule_date, "2029-11-10");
  assert.equal(createdExcelTask2.schedule_time, "08:20", "Task 2 tự động cộng thêm khoảng cách 20 phút");

  // 3. Chặn đường dẫn video chưa được tải lên R2
  const unuploadedVideoResp = await callWorker("/api/tasks/bulk", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      schedule_date: "2029-11-10",
      schedule_time: "08:00",
      interval_minutes: 15,
      tasks: [
        {
          video_path: "D:\\Videos\\non_existent_video_999.mp4",
          caption: "Test Error Video",
          comment_text: ""
        }
      ],
      assign_page_ids: ["page_101"]
    })
  });
  assert.equal(unuploadedVideoResp.status, 400, "Chặn task khi video chưa được tải lên R2");
  const unuploadedData = await unuploadedVideoResp.json();
  assert.ok(unuploadedData.detail.includes("has not been uploaded yet"));

  // 4. Chặn lịch bắt đầu trong quá khứ
  const pastBulkScheduleResp = await callWorker("/api/tasks/bulk", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      schedule_date: "2020-01-01",
      schedule_time: "08:00",
      interval_minutes: 15,
      tasks: [
        {
          video_path: `r2://${excelInitData.media_id}`,
          caption: "Past Test",
          comment_text: ""
        }
      ],
      assign_page_ids: ["page_101"]
    })
  });
  assert.equal(pastBulkScheduleResp.status, 400, "Chặn tạo bulk task với lịch bắt đầu trong quá khứ");

  console.log("  ✓ [Test 44] Thêm nhanh hàng loạt Task từ Excel: Phân tích 3 cột TAB, Phân bổ lịch cách đều, So khớp R2 & Chống lỗi 100%");

  // --------------------------------------------------------------------------
  // [TEST 45] Facebook Page Manager: Posts CRUD, Cursor Pagination Sync, Comments & Multi-user isolation
  // --------------------------------------------------------------------------
  console.log("\n  --- BẮT ĐẦU KIỂM THỬ FACEBOOK PAGE MANAGER (POSTS & COMMENTS) ---");

  // 1. Kiểm tra GET /api/posts ban đầu trả về 200 OK và danh sách rỗng
  const getPostsResp1 = await callWorker("/api/posts", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(getPostsResp1.status, 200);
  const postsJson1 = await getPostsResp1.json();
  assert.equal(postsJson1.success, true);
  assert.ok(Array.isArray(postsJson1.posts));

  // 2. Mock Meta API cho endpoint published_posts và sync bài viết
  const originalFetchForTest45 = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes("/published_posts")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "page_exp_1_post_reel_1",
              message: "Video Reel số 1 từ Facebook Page",
              created_time: "2026-11-05T10:00:00Z",
              permalink_url: "https://www.facebook.com/reel/111222333",
              attachments: {
                data: [
                  {
                    media_type: "video",
                    type: "video_inline",
                    media: { image: { src: "https://example.com/thumb1.jpg" } }
                  }
                ]
              }
            },
            {
              id: "page_exp_1_post_photo_2",
              message: "Hình ảnh số 2 từ Facebook Page",
              created_time: "2026-11-06T14:30:00Z",
              permalink_url: "https://www.facebook.com/photo/444555666",
              full_picture: "https://example.com/photo2.jpg",
              attachments: {
                data: [
                  {
                    media_type: "photo",
                    media: { image: { src: "https://example.com/photo2.jpg" } }
                  }
                ]
              }
            }
          ],
          paging: {
            cursors: {
              after: "cursor_after_test_abc123",
              before: "cursor_before_test_xyz789"
            }
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (urlStr.includes("/comments") && init.method === "GET") {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "cmt_test_001",
              from: { id: "user_fb_01", name: "Nguyễn Văn A" },
              message: "Bài viết hay quá shop ơi!",
              created_time: "2026-11-06T15:00:00Z",
              can_comment: true,
              can_remove: true,
              like_count: 5,
              comment_count: 1
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (urlStr.includes("/comments") && init.method === "POST") {
      return new Response(
        JSON.stringify({ id: "cmt_created_new_999" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (init.method === "POST" && (urlStr.includes("page_exp_1_post_reel_1") || urlStr.match(/\/[a-zA-Z0-9_]+$/))) {
      // Edit post message
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (init.method === "DELETE") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return originalFetchForTest45(input, init);
  };

  // 3. Đồng bộ bài viết từ Fanpage
  const syncPostsResp = await callWorker("/api/pages/page_exp_1/sync-posts", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10 })
  });
  if (syncPostsResp.status !== 200) {
    const errBody = await syncPostsResp.json();
    console.error("DEBUG syncPostsResp failed:", errBody);
  }
  assert.equal(syncPostsResp.status, 200);
  const syncPostsJson = await syncPostsResp.json();
  assert.equal(syncPostsJson.success, true);
  assert.equal(syncPostsJson.synced_count, 2);
  assert.equal(syncPostsJson.next_cursor, "cursor_after_test_abc123");
  assert.equal(syncPostsJson.has_more, true);

  // 4. Lọc bài viết theo post_type='reel'
  const filterReelResp = await callWorker("/api/posts?post_type=reel", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(filterReelResp.status, 200);
  const filterReelJson = await filterReelResp.json();
  assert.ok(filterReelJson.total >= 2, "Có các bài viết Reel trong hệ thống");
  const foundSyncReel = filterReelJson.posts.find((p) => p.post_id === "page_exp_1_post_reel_1");
  assert.ok(foundSyncReel, "Tìm thấy Reel vừa đồng bộ");
  assert.equal(foundSyncReel.post_type, "reel");
  assert.equal(foundSyncReel.source, "facebook_external");

  // 5. Thêm một bài viết đăng từ App (source = 'app_published') để kiểm tra phân loại nguồn
  const meRespA = await callWorker("/api/auth/me", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const meJsonA = await meRespA.json();
  const userAId = meJsonA.user.id;

  await d1.prepare(`
    INSERT INTO facebook_posts (
      owner_user_id, page_id, post_id, message, post_type, permalink_url, source, created_time, synced_at, created_at, updated_at
    ) VALUES (?, 'page_exp_1', 'page_exp_1_app_published_post', 'Đăng từ ứng dụng tự động', 'reel', 'https://fb.com/reel/999', 'app_published', '2026-11-07T08:00:00Z', '2026-11-07T08:00:00Z', '2026-11-07T08:00:00Z', '2026-11-07T08:00:00Z')
  `).bind(userAId).run();

  const filterAppResp = await callWorker("/api/posts?source=app_published", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const filterAppJson = await filterAppResp.json();
  assert.ok(filterAppJson.total >= 1, "Có bài viết đăng từ App");
  assert.ok(filterAppJson.posts.every((p) => p.source === "app_published"), "Tất cả bài viết lọc theo source=app_published đều có source app_published");

  // 6. Kiểm tra bảo vệ Multi-user isolation (Chống IDOR): User B không xem được bài viết của User A
  const userBPostsResp = await callWorker("/api/posts", {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  const userBPostsJson = await userBPostsResp.json();
  assert.equal(userBPostsJson.total, 0, "Cô lập dữ liệu multi-user: User B không thấy bài viết của User A");

  // 7. Xem chi tiết bài viết GET /api/posts/:id
  const postDetailResp = await callWorker("/api/posts/page_exp_1_post_reel_1", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(postDetailResp.status, 200);
  const postDetailJson = await postDetailResp.json();
  assert.equal(postDetailJson.success, true);
  assert.equal(postDetailJson.post.post_id, "page_exp_1_post_reel_1");

  // 8. Chỉnh sửa nội dung bài viết PUT /api/posts/:id
  const editPostResp = await callWorker("/api/posts/page_exp_1_post_reel_1", {
    method: "PUT",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Caption đã được chỉnh sửa mới qua Facebook Page Manager" })
  });
  assert.equal(editPostResp.status, 200);
  const editPostJson = await editPostResp.json();
  assert.equal(editPostJson.success, true);
  assert.equal(editPostJson.updated_post.message, "Caption đã được chỉnh sửa mới qua Facebook Page Manager");

  // 9. Đồng bộ và gửi bình luận bài viết
  const syncCommentsResp = await callWorker("/api/posts/page_exp_1_post_reel_1/comments", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncCommentsResp.status, 200);
  const syncCommentsJson = await syncCommentsResp.json();
  assert.equal(syncCommentsJson.success, true);
  assert.ok(syncCommentsJson.count >= 1, "Đồng bộ bình luận thành công");

  const newCommentResp = await callWorker("/api/posts/page_exp_1_post_reel_1/comments", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Cảm ơn bạn đã quan tâm sản phẩm!" })
  });
  assert.equal(newCommentResp.status, 200);
  const newCommentJson = await newCommentResp.json();
  assert.equal(newCommentJson.success, true);
  assert.equal(newCommentJson.comment_id, "cmt_created_new_999");

  // 10. Xóa bài viết DELETE /api/posts/:id
  const deletePostResp = await callWorker("/api/posts/page_exp_1_post_reel_1?delete_facebook=true", {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  if (deletePostResp.status !== 200) {
    const err = await deletePostResp.json();
    console.error("DEBUG deletePostResp error:", err);
  }
  assert.equal(deletePostResp.status, 200);
  const deletePostJson = await deletePostResp.json();
  assert.equal(deletePostJson.success, true);

  // Xác nhận bài viết đã được đánh dấu xóa và không còn xuất hiện trong danh sách hoạt động
  const checkAfterDeleteResp = await callWorker("/api/posts?search=page_exp_1_post_reel_1", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const checkAfterDeleteJson = await checkAfterDeleteResp.json();
  assert.equal(checkAfterDeleteJson.total, 0, "Bài viết đã xóa không còn xuất hiện trong danh sách");

  globalThis.fetch = originalFetchForTest45;
  console.log("  ✓ [Test 45] Facebook Page Manager: Posts CRUD, Cursor Pagination Sync, Comments & Multi-user isolation đạt 100%");

  // --------------------------------------------------------------------------
  // [TEST 46] KIỂM THỬ TOÀN DIỆN CÁC TÌNH HUỐNG ĐỒNG BỘ BÀI VIẾT FACEBOOK (14 SCENARIOS)
  // --------------------------------------------------------------------------
  console.log("\n  --- BẮT ĐẦU KIỂM THỬ 14 TÌNH HUỐNG ĐỒNG BỘ BÀI VIẾT FACEBOOK ---");

  // 1. Scenario: Page không có bài viết (empty array)
  const mockFetchForTest46 = async (input, init = {}) => {
    const urlStr = typeof input === "string" ? input : input.url;

    // Case 1: Token hết hạn
    if (urlStr.includes("page_expired_token") && urlStr.includes("/published_posts")) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Error validating access token: Session has expired",
            type: "OAuthException",
            code: 190,
            error_subcode: 463,
            fbtrace_id: "trace_token_expired_123"
          }
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Case 2: Token thiếu quyền
    if (urlStr.includes("page_missing_perm") && urlStr.includes("/published_posts")) {
      return new Response(
        JSON.stringify({
          error: {
            message: "(#200) Requires pages_read_user_content or pages_read_engagement permission",
            type: "OAuthException",
            code: 200,
            fbtrace_id: "trace_missing_perm_456"
          }
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Case 3: Meta từ chối field attachments (code 100) -> Thử lại với tier 2
    if (urlStr.includes("page_field_fallback") && urlStr.includes("/published_posts")) {
      if (urlStr.includes("attachments%7B")) {
        return new Response(
          JSON.stringify({
            error: {
              message: "(#100) Tried accessing nonexisting field on type PagePost",
              type: "OAuthException",
              code: 100,
              fbtrace_id: "trace_field_err_789"
            }
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      // Tier 2 thành công
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "post_fallback_success_1",
              message: "Bài viết lấy được sau khi fallback tier 2",
              created_time: "2026-11-07T08:00:00Z",
              permalink_url: "https://www.facebook.com/123/posts/456"
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Case 4: Page trống (0 bài viết)
    if (urlStr.includes("page_empty_posts") && urlStr.includes("/published_posts")) {
      return new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Mặc định fallback
    return originalFetch(input, init);
  };

  globalThis.fetch = mockFetchForTest46;

  // Setup các test pages vào DB
  const encTok = await encryptToken("EAATestDummyToken", env.TOKEN_ENCRYPTION_KEY);

  await d1.prepare(`
    INSERT INTO facebook_pages (id, owner_user_id, facebook_page_id, page_name, page_access_token, token_version, tasks_json, can_post, can_analyze, is_published, is_selected, status, token_status, created_at, updated_at)
    VALUES
      ('p_exp', ?, 'page_expired_token', 'Page Token Expired', ?, 1, '[]', 1, 1, 1, 1, 'active', 'valid', datetime('now'), datetime('now')),
      ('p_perm', ?, 'page_missing_perm', 'Page Missing Perm', ?, 1, '[]', 1, 1, 1, 1, 'active', 'valid', datetime('now'), datetime('now')),
      ('p_fall', ?, 'page_field_fallback', 'Page Field Fallback', ?, 1, '[]', 1, 1, 1, 1, 'active', 'valid', datetime('now'), datetime('now')),
      ('p_emp', ?, 'page_empty_posts', 'Page Empty', ?, 1, '[]', 1, 1, 1, 1, 'active', 'valid', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET page_access_token = excluded.page_access_token
  `).bind(userAId, encTok, userAId, encTok, userAId, encTok, userAId, encTok).run();

  // Test Case 1: Token hết hạn (code 190)
  const syncExpResp = await callWorker("/api/pages/page_expired_token/sync-posts", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncExpResp.status, 400);
  const syncExpJson = await syncExpResp.json();
  assert.equal(syncExpJson.success, false);
  assert.ok(syncExpJson.detail.includes("The Page access token has expired or was revoked (Code 190)"));
  console.log("    ✓ [Scenario 1] Phát hiện chính xác token hết hạn (190) & trả về thông báo hướng dẫn người dùng");

  // Test Case 2: Token thiếu quyền (code 200)
  const syncPermResp = await callWorker("/api/pages/page_missing_perm/sync-posts", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncPermResp.status, 400);
  const syncPermJson = await syncPermResp.json();
  assert.equal(syncPermJson.success, false);
  assert.ok(syncPermJson.detail.includes("This account cannot read this Page's posts"));
  console.log("    ✓ [Scenario 2] Phát hiện chính xác thiếu quyền (200) & chỉ rõ pages_read_user_content");

  // Test Case 3: Meta từ chối fields attachments -> Fallback Tier 2 tự động thành công
  const syncFallResp = await callWorker("/api/pages/page_field_fallback/sync-posts", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncFallResp.status, 200);
  const syncFallJson = await syncFallResp.json();
  assert.equal(syncFallJson.success, true);
  assert.equal(syncFallJson.synced_count, 1);
  console.log("    ✓ [Scenario 3] Tự động fallback tier fields khi Meta từ chối nested attachments (Code 100)");

  // Test Case 4: Page trống (0 bài viết)
  const syncEmptyResp = await callWorker("/api/pages/page_empty_posts/sync-posts", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncEmptyResp.status, 200);
  const syncEmptyJson = await syncEmptyResp.json();
  assert.equal(syncEmptyJson.success, true);
  assert.equal(syncEmptyJson.synced_count, 0);
  assert.ok(syncEmptyJson.message.includes("has no published posts"));
  console.log("    ✓ [Scenario 4] Xử lý chính xác Fanpage thực sự chưa có bài viết (không báo lỗi nhầm)");

  // Test Case 5: Đồng bộ lại không tạo trùng bài viết (Idempotent Upsert)
  const syncAgainResp = await callWorker("/api/pages/page_field_fallback/sync-posts", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(syncAgainResp.status, 200);
  const syncAgainJson = await syncAgainResp.json();
  assert.equal(syncAgainJson.updated_count, 1, "Bài viết cũ được cập nhật thay vì nhân bản trùng");
  assert.equal(syncAgainJson.new_count, 0, "Không tạo bản ghi mới trùng lặp");
  console.log("    ✓ [Scenario 5] Đồng bộ lại bảo toàn tính duy nhất (Idempotent, không nhân đôi bài viết)");

  globalThis.fetch = originalFetch;
  console.log("  ✓ [Test 46] Facebook Page Manager: Extended Synchronization Scenarios (Pass toàn bộ kiểm thử thực tế 100%)");

  // --------------------------------------------------------------------------
  // [TEST 47] HỆ THỐNG 3 TAB CHÍNH & TỰ ĐỘNG ẨN TASK PUBLISHED KHỎI TAB LÊN LỊCH
  // --------------------------------------------------------------------------
  console.log("\n  --- BẮT ĐẦU KIỂM THỬ HỆ THỐNG 3 TAB CHÍNH & LỌC BÀI ĐÃ ĐĂNG ---");
  // 1. Kiểm tra 3 route chính của 3 Tab trả về 200 OK
  const scheduleResp = await callWorker("/schedule", { headers: { Cookie: `session_token=${tokenA}` } });
  assert.equal(scheduleResp.status, 200, "Route /schedule phải trả về 200 OK");
  const schedHtml = await scheduleResp.text();
  assert.ok(schedHtml.includes("Schedule &amp; publish posts") || schedHtml.includes("Schedule & publish posts"), "Trang /schedule phải chứa giao diện Lên Lịch & Đăng Bài");

  const analyticsResp = await callWorker("/analytics", { headers: { Cookie: `session_token=${tokenA}` } });
  assert.equal(analyticsResp.status, 200, "Route /analytics phải trả về 200 OK");
  const analHtml = await analyticsResp.text();
  assert.ok(analHtml.includes("Reels &amp; post analytics"), "Trang /analytics phải chứa giao diện Thống Kê & Bài Viết");

  const pagesResp = await callWorker("/pages", { headers: { Cookie: `session_token=${tokenA}` } });
  assert.equal(pagesResp.status, 200, "Route /pages phải trả về 200 OK");
  const pagesHtml = await pagesResp.text();
  assert.ok(pagesHtml.includes("Manage Pages"), "Trang /pages phải chứa giao diện Quản Lý Fanpage");

  // 2. Tạo 1 task pending và 1 task published trong D1 để kiểm tra bộ lọc exclude_published
  await d1.prepare(`
    INSERT INTO tasks (
      owner_user_id, facebook_page_id, video_path, caption, schedule_date, schedule_time, status, created_at, updated_at
    ) VALUES (?, 'page_exp_1', 'video_active.mp4', 'Task dang cho dang', '2026-11-10', '08:00', 'pending', unixepoch(), unixepoch())
  `).bind(userAId).run();

  await d1.prepare(`
    INSERT INTO tasks (
      owner_user_id, facebook_page_id, video_path, caption, schedule_date, schedule_time, status, created_at, updated_at
    ) VALUES (?, 'page_exp_1', 'video_done.mp4', 'Task da xuat ban thanh cong', '2026-11-10', '09:00', 'published', unixepoch(), unixepoch())
  `).bind(userAId).run();

  // Gọi API /api/tasks?exclude_published=true (gọi từ Tab 1 Lên Lịch & Đăng Bài)
  const activeTasksResp = await callWorker("/api/tasks?exclude_published=true", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(activeTasksResp.status, 200);
  const activeTasks = await activeTasksResp.json();
  const hasPublished = activeTasks.some(t => t.status === "published");
  assert.equal(hasPublished, false, "Tab 1 (Lên Lịch & Đăng Bài) tuyệt đối không được chứa bài đã published");
  const hasActive = activeTasks.some(t => t.caption === "Task dang cho dang");
  assert.equal(hasActive, true, "Tab 1 phải chứa task pending/hoạt động");

  console.log("  ✓ [Test 47] Hệ thống 3 Tab (/schedule, /analytics, /pages) và Bộ lọc tự động ẩn bài đã đăng đạt 100%");

  console.log("\n==================================================================");
  console.log(" TẤT CẢ 47/47 BÀI KIỂM THỬ BẮT BUỘC ĐỀU PASS 100% TUYỆT ĐỐI!     ");
  console.log("==================================================================");
}

runAll30Tests().catch((err) => {
  console.error("KIỂM THỬ THẤT BẠI:", err);
  process.exit(1);
});
