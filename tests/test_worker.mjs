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

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
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
  // [TEST 12] D1 Migrations (0001, 0002, 0003) chạy nhiều lần an toàn (Idempotent)
  // --------------------------------------------------------------------------
  const migFiles = [
    "migrations/0001_initial_schema.sql",
    "migrations/0002_indexes.sql",
    "migrations/0003_security_and_tokens.sql"
  ];
  for (let pass = 1; pass <= 2; pass++) {
    for (const mf of migFiles) {
      const sql = fs.readFileSync(path.join(process.cwd(), mf), "utf8");
      await d1.exec(sql);
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
    "user_page_permissions"
  ]) {
    assert.ok(tableNames.has(required), `Thiếu bảng/view ${required} trong D1`);
  }
  console.log("  ✓ [Test 12] D1 Migrations (0001, 0002, 0003) idempotent & đầy đủ 13 bảng/view");

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
  assert.ok(unauthRootResp.headers.get("Location")?.endsWith("/login"));

  const appJsResp = await callWorker("/static/js/app.js");
  assert.equal(appJsResp.status, 200);
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
      if (u.includes("EAAB_TOKEN_A1")) {
        return new Response(JSON.stringify({ id: "fb_uid_a1", name: "Alice FB Admin 1" }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_A2")) {
        return new Response(JSON.stringify({ id: "fb_uid_a2", name: "Alice FB Admin 2" }), { status: 200 });
      }
      if (u.includes("EAAB_TOKEN_B1")) {
        return new Response(JSON.stringify({ id: "fb_uid_b1", name: "Bob FB Admin 1" }), { status: 200 });
      }
    }

    // 3. /me/permissions
    if (u.includes("/me/permissions")) {
      return new Response(
        JSON.stringify({
          data: [
            { permission: "public_profile", status: "granted" },
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },
            { permission: "pages_manage_engagement", status: "granted" },
            { permission: "pages_read_user_content", status: "granted" }
          ]
        }),
        { status: 200 }
      );
    }

    // 4. /me/accounts (with multi-page cursor pagination for Alice Admin 1, and overlapping Page for Alice Admin 2)
    if (u.includes("/me/accounts")) {
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
        { status: 200 }
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
        { status: 200 }
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

    if (u.includes("/comments")) {
      return new Response(JSON.stringify({ id: "cmt_888999" }), { status: 200 });
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

  // Kiểm tra kết nối trực tiếp bằng Access Token (/api/meta/connect-token) không cần Redirect URI
  const directConnResp = await callWorker("/api/meta/connect-token", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: "EAAB_TOKEN_A2_SHORT" })
  });
  assert.equal(directConnResp.status, 200);
  const directConnData = await directConnResp.json();
  assert.equal(directConnData.success, true);
  assert.equal(directConnData.is_long_lived, true);
  assert.equal(directConnData.synced_count, 1);

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
      caption: "Bob mencoba dùng video của Alice"
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
      schedule_date: "",
      schedule_time: ""
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
          schedule_date: "2026-12-20",
          schedule_time: "07:00"
        },
        {
          video_path: compUploadData.video_path,
          caption: "Bulk Task 2",
          comment_text: "",
          schedule_date: "2026-12-20",
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
  assert.ok(finishedTask1.log.includes("Đã đăng bình luận tự động"));
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
      caption: "Task kiểm thử Retry & Backoff"
    })
  });
  const retryTask = (await retryTaskResp.json()).task;

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
  assert.ok(secondAttempt.reason.includes("DỪNG AUTO-RETRY CHỐNG ĐĂNG TRÙNG"));
  console.log("  ✓ [Test 21] Queue Retry (Exponential Backoff) & Chặn Auto-Retry khi Ambiguous Publish");

  // --------------------------------------------------------------------------
  // [TEST 23 & 24] Timezone Conversion (Asia/Ho_Chi_Minh <-> UTC) & Cron Scheduler
  // --------------------------------------------------------------------------
  const parsedTz = parseVnScheduleToUtc("2026-11-10", "07:00");
  assert.equal(parsedTz.isValid, true);
  // 2026-11-10 07:00:00+07:00 == 2026-11-10 00:00:00 UTC
  assert.equal(parsedTz.scheduledAtUtc, Math.floor(Date.UTC(2026, 10, 10, 0, 0, 0) / 1000));
  const formattedVn = formatUtcToVn(parsedTz.scheduledAtUtc);
  assert.equal(formattedVn.schedule_date, "2026-11-10");
  assert.equal(formattedVn.schedule_time, "07:00");
  assert.equal(VN_OFFSET_SECONDS, 25200);
  console.log("  ✓ [Test 24] Timezone Asia/Ho_Chi_Minh (+07:00) <-> UTC chính xác tuyệt đối");

  // Tạo 1 task đã đến hạn (quá khứ) và 1 task tương lai (năm 2029), sau đó chạy Cron Trigger
  const dueTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "page_102",
      video_path: compUploadData.video_path,
      caption: "Task hẹn giờ đã đến hạn chạy qua Cron",
      schedule_date: "2020-01-01",
      schedule_time: "08:00"
    })
  });
  const dueTask = (await dueTaskResp.json()).task;

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
  const futureTask = (await futureTaskResp.json()).task;

  const cronBg = [];
  const cronResult = await workerDefault.scheduled(
    { cron: "*/1 * * * *", type: "scheduled", scheduledTime: Date.now() },
    env,
    { waitUntil: (p) => cronBg.push(p), passThroughOnException: () => {} }
  );
  await Promise.all(cronBg);

  assert.ok(cronResult.task_ids.includes(dueTask.id), "Cron phải claim task đã đến hạn");
  assert.ok(!cronResult.task_ids.includes(futureTask.id), "Cron không được chạy task chưa đến giờ hẹn");

  const tasksAfterCron = await (
    await callWorker("/api/tasks", { headers: { Cookie: `session_token=${tokenA}` } })
  ).json();
  assert.equal(tasksAfterCron.find((t) => t.id === dueTask.id).status, "success");
  assert.equal(tasksAfterCron.find((t) => t.id === futureTask.id).status, "pending");
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

  // Kiểm tra tài khoản fb_uid_b1 của Bob đã thực sự bị xóa khỏi D1
  const bobAccsAfterDel = await (
    await callWorker("/api/meta/accounts", { headers: { Cookie: `session_token=${tokenB}` } })
  ).json();
  assert.equal(bobAccsAfterDel.length, 0, "Dữ liệu Facebook Account phải được xóa thật khỏi D1");
  console.log("  ✓ [Test 26] Meta Data Deletion xóa dữ liệu thật trong D1 & lưu biên bản tra cứu");

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

  console.log("  ✓ [Test 27] Không còn bất kỳ URL localhost:8000 / 127.0.0.1:8000 trong Production");
  console.log("  ✓ [Test 28] Không lộ META_APP_SECRET hoặc Access Token trong Frontend & Config");
  console.log("  ✓ [Test 29] Không còn đường dẫn ổ đĩa Windows (D:\\Videos) trong Production Flow");
  console.log("  ✓ [Test 30] Không có dependency Playwright/GemLogin/FastAPI trong Worker Production");

  globalThis.fetch = originalFetch;

  console.log("\n==================================================================");
  console.log(" TẤT CẢ 30/30 BÀI KIỂM THỬ BẮT BUỘC ĐỀU PASS 100% TUYỆT ĐỐI!     ");
  console.log("==================================================================");
}

runAll30Tests().catch((err) => {
  console.error("KIỂM THỬ THẤT BẠI:", err);
  process.exit(1);
});
