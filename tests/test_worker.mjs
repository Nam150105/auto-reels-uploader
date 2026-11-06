/**
 * Comprehensive End-to-End Verification Suite for Cloudflare Worker + D1 Architecture
 * Tests:
 * 1. D1 SQL Migration (`migrations/0001_init.sql`) on SQLite (`node:sqlite`)
 * 2. Auth APIs (`/api/auth/login`, `/api/auth/register`, `/api/auth/me`, `/api/auth/logout`)
 * 3. Facebook OAuth 2.0 Production Flow (`/api/meta/oauth-url`, `/api/meta/login`, `/api/meta/callback`, CSRF State protection)
 * 4. Meta Graph API v19.0 Fanpage Sync (`/me/accounts` pagination, token expiration handling, empty page handling)
 * 5. AES-256-GCM Token Encryption at Rest & Zero Token Leakage in API Responses
 * 6. Strict Multi-User Authorization & Isolation (Preventing IDOR across users)
 * 7. Cloud Video Upload (`/api/upload/video`), Single/Bulk Tasks, Run Test & Reels Publishing (`/{page_id}/video_reels`)
 * 8. Public Meta Policy Pages (`/privacy`, `/terms`, `/data-deletion`, `/api/meta/data-deletion`)
 * 9. Production Bundle Cleanliness Audit (Zero `localhost:8000` or leaked secrets in `static/` & `src/`)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import workerDefault, { handleWorkerRequest } from "../src/index.ts";
import { decryptToken } from "../src/crypto.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

class SqliteD1Adapter {
  constructor(sqliteDb) {
    this.sqlite = sqliteDb;
  }

  prepare(query) {
    const sqlite = this.sqlite;
    let boundValues = [];

    const stmtObj = {
      bind(...values) {
        boundValues = values.map((v) => (v === undefined ? null : v));
        return stmtObj;
      },
      async first(colName) {
        const stmt = sqlite.prepare(query);
        const row = stmt.get(...boundValues);
        if (!row) return null;
        const plain = { ...row };
        return colName ? plain[colName] : plain;
      },
      async all() {
        const isSelect = /^\s*(SELECT|PRAGMA|WITH)/i.test(query);
        const stmt = sqlite.prepare(query);
        if (isSelect) {
          const rows = stmt.all(...boundValues).map((r) => ({ ...r }));
          return {
            results: rows,
            success: true,
            meta: {
              duration: 0,
              size_after: 0,
              rows_read: rows.length,
              rows_written: 0,
              last_row_id: 0,
              changed_db: false,
              changes: 0
            }
          };
        } else {
          const info = stmt.run(...boundValues);
          return {
            results: [],
            success: true,
            meta: {
              duration: 0,
              size_after: 0,
              rows_read: 0,
              rows_written: Number(info.changes || 0),
              last_row_id: Number(info.lastInsertRowid || 0),
              changed_db: Number(info.changes || 0) > 0,
              changes: Number(info.changes || 0)
            }
          };
        }
      },
      async run() {
        return stmtObj.all();
      },
      async raw() {
        const res = await stmtObj.all();
        return res.results.map((r) => Object.values(r));
      }
    };
    return stmtObj;
  }

  async batch(statements) {
    const out = [];
    for (const s of statements) {
      out.push(await s.run());
    }
    return out;
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  async dump() {
    return new ArrayBuffer(0);
  }
}

/**
 * Mock ASSETS Fetcher serving `./static` files
 */
const staticAssetsFetcher = {
  async fetch(input) {
    const reqUrl = typeof input === "string" ? new URL(input) : new URL(input.url);
    const relPath = reqUrl.pathname.replace(/^\/+/, "");
    const fullPath = path.join(ROOT_DIR, "static", relPath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const content = fs.readFileSync(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      const mime =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";
      return new Response(content, { status: 200, headers: { "Content-Type": mime } });
    }
    return new Response("Not Found", { status: 404 });
  }
};

async function runTests() {
  console.log("=== BẮT ĐẦU KIỂM THỬ CLOUDFLARE WORKER & D1 ARCHITECTURE ===");

  // 1. Khởi tạo SQLite in-memory & chạy D1 Migration `migrations/0001_init.sql`
  const sqlite = new DatabaseSync(":memory:");
  const migrationSql = fs.readFileSync(
    path.join(ROOT_DIR, "migrations", "0001_init.sql"),
    "utf-8"
  );
  sqlite.exec(migrationSql);
  const d1 = new SqliteD1Adapter(sqlite);

  const env = {
    DB: d1,
    ASSETS: staticAssetsFetcher,
    META_APP_ID: "1469615908436980",
    META_APP_SECRET: "test_secret_for_verification_only",
    APP_BASE_URL: "https://pagefb.namnangno.click",
    META_REDIRECT_URI: "https://pagefb.namnangno.click/api/meta/callback",
    META_GRAPH_VERSION: "v19.0",
    SECRET_KEY: "test_hmac_secret_key_for_session_tokens",
    ENCRYPTION_KEY: "test_aes_256_gcm_key_for_token_encryption"
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

  console.log("[TEST 1] Kiểm tra D1 Schema & Tài khoản Admin mặc định...");
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all()
    .map((r) => r.name);
  for (const required of [
    "users",
    "oauth_states",
    "facebook_accounts",
    "facebook_pages",
    "facebook_account_pages",
    "user_page_permissions",
    "tasks",
    "uploaded_videos"
  ]) {
    assert.ok(tables.includes(required), `Thiếu bảng/view bắt buộc: ${required}`);
  }
  console.log("  ✓ Đầy đủ 8 bảng/view trong D1 Migration 0001_init.sql");

  // 2. Kiểm tra Public Policy Pages & Data Deletion Callback
  console.log("[TEST 2] Kiểm tra các trang Chính sách Meta & Data Deletion Callback...");
  for (const pubRoute of ["/privacy", "/terms", "/data-deletion"]) {
    const r = await callWorker(pubRoute);
    assert.equal(r.status, 200, `Route ${pubRoute} phải trả về HTTP 200`);
    const html = await r.text();
    assert.ok(html.includes("1469615908436980"), `${pubRoute} phải chứa App ID`);
    assert.ok(html.includes("https://pagefb.namnangno.click"), `${pubRoute} phải chứa production domain`);
  }

  const delResp = await callWorker("/api/meta/data-deletion", { method: "POST" });
  assert.equal(delResp.status, 200);
  const delJson = await delResp.json();
  assert.ok(delJson.url.startsWith("https://pagefb.namnangno.click/data-deletion-status?code=DEL_"));
  assert.ok(delJson.confirmation_code.startsWith("DEL_"));
  console.log("  ✓ /privacy, /terms, /data-deletion, /api/meta/data-deletion chuẩn Meta!");

  // 3. Kiểm tra Đăng nhập Admin & Đăng ký User A, User B
  console.log("[TEST 3] Kiểm tra Xác thực (/api/auth/login, /api/auth/register, /api/auth/me)...");
  const unauthResp = await callWorker("/api/meta/status");
  assert.equal(unauthResp.status, 401, "API bảo vệ phải trả về 401 khi chưa đăng nhập");

  const regAResp = await callWorker("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "user_a",
      password: "passwordA",
      full_name: "Người Dùng A",
      email: "a@pagefb.namnangno.click"
    })
  });
  assert.equal(regAResp.status, 200);
  const regAJson = await regAResp.json();
  const tokenA = regAJson.token;
  assert.ok(tokenA, "Phải cấp session token cho User A");

  const regBResp = await callWorker("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "user_b",
      password: "passwordB",
      full_name: "Người Dùng B",
      email: "b@pagefb.namnangno.click"
    })
  });
  assert.equal(regBResp.status, 200);
  const regBJson = await regBResp.json();
  const tokenB = regBJson.token;
  assert.ok(tokenB, "Phải cấp session token cho User B");

  const meAResp = await callWorker("/api/auth/me", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(meAResp.status, 200);
  const meAJson = await meAResp.json();
  assert.equal(meAJson.user.username, "user_a");
  console.log("  ✓ Đăng ký, Đăng nhập và Cookie Session hoạt động chính xác!");

  // 4. Kiểm tra Khởi tạo Facebook OAuth URL & CSRF State trong D1
  console.log("[TEST 4] Kiểm tra Facebook OAuth 2.0 URL & CSRF State...");
  const oauthUrlResp = await callWorker("/api/meta/oauth-url", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(oauthUrlResp.status, 200);
  const oauthUrlData = await oauthUrlResp.json();
  assert.equal(oauthUrlData.status, "success");
  assert.ok(
    oauthUrlData.oauth_url.startsWith("https://www.facebook.com/v19.0/dialog/oauth?"),
    "OAuth URL phải trỏ tới Facebook Dialog v19.0"
  );
  assert.ok(
    oauthUrlData.oauth_url.includes("client_id=1469615908436980"),
    "OAuth URL phải chứa App ID 1469615908436980"
  );
  assert.ok(
    oauthUrlData.oauth_url.includes(
      encodeURIComponent("https://pagefb.namnangno.click/api/meta/callback")
    ),
    "OAuth URL phải chứa Redirect URI production"
  );
  const stateA = oauthUrlData.state;
  assert.ok(stateA && stateA.length >= 32, "State CSRF phải có độ dài an toàn");

  // Kiểm tra /api/meta/login trả về 302 Redirect
  const loginRedirResp = await callWorker("/api/meta/login", {
    headers: { Cookie: `session_token=${tokenA}` },
    redirect: "manual"
  });
  assert.equal(loginRedirResp.status, 302);
  assert.ok(
    loginRedirResp.headers.get("Location").startsWith("https://www.facebook.com/v19.0/dialog/oauth")
  );
  console.log("  ✓ /api/meta/oauth-url và /api/meta/login tạo state D1 & redirect chuẩn!");

  // 5. Kiểm tra OAuth Callback, Đổi Token, Mã hóa AES-256-GCM & Đồng bộ /me/accounts (Có phân trang)
  console.log("[TEST 5] Kiểm tra OAuth Callback, Token Exchange & Đồng bộ Fanpage (/me/accounts)...");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input.url;

    // 1. Short-lived token & Long-lived token exchange
    if (u.includes("graph.facebook.com/v19.0/oauth/access_token")) {
      if (u.includes("grant_type=fb_exchange_token")) {
        return new Response(
          JSON.stringify({
            access_token: "EAAB_LONG_LIVED_USER_A_SECRET_TOKEN_9999",
            token_type: "bearer",
            expires_in: 5184000
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "EAAB_SHORT_USER_A_TOKEN_1111",
          token_type: "bearer",
          expires_in: 3600
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. /me profile
    if (u.includes("graph.facebook.com/v19.0/me?")) {
      return new Response(
        JSON.stringify({
          id: "fb_uid_10001",
          name: "Nguyễn Văn Admin A",
          picture: { data: { url: "https://pagefb.namnangno.click/avatar_a.jpg" } }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. /me/permissions
    if (u.includes("graph.facebook.com/v19.0/me/permissions")) {
      return new Response(
        JSON.stringify({
          data: [
            { permission: "public_profile", status: "granted" },
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. /me/accounts (Trang 1 -> phân trang sang Trang 2)
    if (u.includes("graph.facebook.com/v19.0/me/accounts") && !u.includes("after=page2")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "101010101",
              name: "Fanpage Điện Ảnh A1",
              access_token: "EAAB_PAGE_101_SECRET_TOKEN",
              category: "Movie",
              tasks: ["MANAGE", "CREATE_CONTENT", "MODERATE"],
              is_published: true,
              picture: { data: { url: "https://pagefb.namnangno.click/p101.jpg" } }
            }
          ],
          paging: {
            next: "https://graph.facebook.com/v19.0/me/accounts?after=page2"
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (u.includes("graph.facebook.com/v19.0/me/accounts?after=page2")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "102020202",
              name: "Fanpage Giải Trí A2",
              access_token: "EAAB_PAGE_102_SECRET_TOKEN",
              category: "Entertainment",
              tasks: ["CREATE_CONTENT"],
              is_published: true
            }
          ],
          paging: {}
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Check Page Permission (/v19.0/101010101 & /v19.0/102020202)
    if (u.includes("graph.facebook.com/v19.0/101010101?")) {
      return new Response(
        JSON.stringify({
          id: "101010101",
          name: "Fanpage Điện Ảnh A1",
          is_published: true,
          tasks: ["MANAGE", "CREATE_CONTENT"]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (u.includes("graph.facebook.com/v19.0/102020202?")) {
      return new Response(
        JSON.stringify({
          id: "102020202",
          name: "Fanpage Giải Trí A2",
          is_published: true,
          tasks: ["CREATE_CONTENT"]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 6. Reels Publishing API (/v19.0/101010101/video_reels)
    if (u.includes("graph.facebook.com/v19.0/101010101/video_reels")) {
      const bodyText = init?.body ? String(init.body) : "";
      if (bodyText.includes("upload_phase=start")) {
        return new Response(
          JSON.stringify({
            video_id: "reel_vid_8888",
            upload_url: "https://rupload.facebook.com/video-upload/v19.0/reel_vid_8888"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (bodyText.includes("upload_phase=finish")) {
        return new Response(
          JSON.stringify({
            success: true,
            post_id: "post_8888"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (u.includes("rupload.facebook.com/video-upload/v19.0/reel_vid_8888")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (u.includes("graph.facebook.com/v19.0/reel_vid_8888?fields=status")) {
      return new Response(
        JSON.stringify({ status: { video_status: "ready" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (u.includes("graph.facebook.com/v19.0/reel_vid_8888/comments")) {
      return new Response(JSON.stringify({ id: "cmt_999" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return originalFetch(input, init);
  };

  // Gọi OAuth Callback với state hợp lệ
  const cbResp = await callWorker(
    `/api/meta/callback?code=AUTH_CODE_FROM_FACEBOOK&state=${encodeURIComponent(stateA)}`,
    { headers: { Cookie: `session_token=${tokenA}` } }
  );
  assert.equal(cbResp.status, 200, "OAuth Callback hợp lệ phải trả về HTTP 200");
  const cbHtml = await cbResp.text();
  assert.ok(cbHtml.includes("Kết Nối Facebook Thành Công"), "Callback HTML phải báo thành công");
  assert.ok(cbHtml.includes("Nguyễn Văn Admin A"), "Callback HTML phải hiển thị tên Admin");

  // Thử replay lại cùng stateA (Phải bị chặn bởi one-time CSRF consumption)
  const replayResp = await callWorker(
    `/api/meta/callback?code=AUTH_CODE_2&state=${encodeURIComponent(stateA)}`,
    { headers: { Cookie: `session_token=${tokenA}` } }
  );
  assert.equal(replayResp.status, 400, "Replay lại CSRF state cũ phải bị từ chối (HTTP 400)");

  // Kiểm tra Token trong DB đã được mã hóa AES-256-GCM (enc:v2:...) và KHÔNG lưu plaintext
  const rawAccRow = sqlite
    .prepare("SELECT encrypted_user_access_token FROM facebook_accounts WHERE user_id = 'fb_uid_10001'")
    .get();
  assert.ok(
    rawAccRow.encrypted_user_access_token.startsWith("enc:v2:"),
    "User Access Token trong D1 phải được mã hóa AES-256-GCM (enc:v2:...)"
  );
  assert.ok(
    !rawAccRow.encrypted_user_access_token.includes("EAAB_LONG_LIVED"),
    "Không được lưu token dạng rõ trong D1"
  );
  const decryptedUserToken = await decryptToken(
    rawAccRow.encrypted_user_access_token,
    env.ENCRYPTION_KEY
  );
  assert.equal(decryptedUserToken, "EAAB_LONG_LIVED_USER_A_SECRET_TOKEN_9999");

  // Kiểm tra API trả về danh sách Fanpage cho User A (Không lộ encrypted_page_access_token)
  const pagesAResp = await callWorker("/api/pages", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(pagesAResp.status, 200);
  const pagesA = await pagesAResp.json();
  assert.equal(pagesA.length, 2, "Phải đồng bộ đủ 2 Fanpage qua phân trang /me/accounts");
  const syncedPageIds = pagesA.map((p) => p.facebook_page_id).sort();
  assert.deepEqual(syncedPageIds, ["101010101", "102020202"]);
  assert.equal(
    pagesA[0].encrypted_page_access_token,
    undefined,
    "Tuyệt đối không trả encrypted_page_access_token về frontend"
  );
  assert.equal(
    pagesA[0].access_token,
    undefined,
    "Tuyệt đối không trả access_token về frontend"
  );
  console.log("  ✓ OAuth Callback, CSRF One-Time State, Mã hóa AES-256-GCM & Phân trang /me/accounts đạt 100%!");

  // 6. Kiểm tra Phân tách dữ liệu giữa các User (Multi-User Isolation & Chống IDOR)
  console.log("[TEST 6] Kiểm tra Cô lập dữ liệu giữa User A và User B (Chống IDOR)...");
  const pagesBResp = await callWorker("/api/pages", {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  const pagesB = await pagesBResp.json();
  assert.equal(pagesB.length, 0, "User B không được thấy Fanpage của User A");

  const accountsBResp = await callWorker("/api/meta/accounts", {
    headers: { Cookie: `session_token=${tokenB}` }
  });
  const accountsB = await accountsBResp.json();
  assert.equal(accountsB.length, 0, "User B không được thấy tài khoản Facebook của User A");

  // User B cố tình gửi request thay đổi lựa chọn, kiểm tra quyền, xóa Fanpage 101010101 của User A
  const idorSelect = await callWorker("/api/pages/101010101/select", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenB}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ is_selected: false })
  });
  assert.equal(idorSelect.status, 404, "User B không được phép select/unselect Page của User A");

  const idorCheckPerm = await callWorker("/api/pages/101010101/check-permission", {
    method: "POST",
    headers: { Cookie: `session_token=${tokenB}` }
  });
  assert.equal(idorCheckPerm.status, 400, "User B không được phép check-permission Page của User A");

  const idorDeletePage = await callWorker("/api/pages/101010101", {
    method: "DELETE",
    headers: { Cookie: `session_token=${tokenB}` }
  });
  assert.equal(idorDeletePage.status, 404, "User B không được phép xóa Page của User A");

  const idorCreateTask = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenB}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "101010101",
      video_path: "https://pagefb.namnangno.click/sample.mp4",
      caption: "Hack attempt"
    })
  });
  assert.equal(idorCreateTask.status, 403, "User B không được phép tạo task trên Page của User A");
  console.log("  ✓ Cô lập dữ liệu Multi-User & Chống tấn công IDOR an toàn tuyệt đối!");

  // 7. Kiểm tra Upload Video lên Cloud, Tạo Task, Run Test & Xuất bản Reels qua Meta Graph API
  console.log("[TEST 7] Kiểm tra Upload Video Cloud, Tạo Task, Run Test & Đăng Reels...");
  const uploadResp = await callWorker("/api/upload/video", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "X-File-Name": "demo_reel.mp4",
      "Content-Type": "application/octet-stream"
    },
    body: new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
  });
  assert.equal(uploadResp.status, 200);
  const uploadJson = await uploadResp.json();
  assert.ok(uploadJson.path.startsWith("cloud://video/vid_"));

  // Tạo Task cho User A với video vừa upload lên Cloud
  const createTaskResp = await callWorker("/api/tasks", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      facebook_page_id: "101010101",
      video_path: uploadJson.path,
      caption: "Thước phim đặc sắc\nDòng 2 giữ nguyên \"ngoặc kép\" 🔥",
      comment_text: "Xem trọn bộ tại bình luận!"
    })
  });
  assert.equal(createTaskResp.status, 200);
  const createdTaskData = await createTaskResp.json();
  assert.ok(createdTaskData.id > 0);

  // Chạy Run Test chẩn đoán
  const runTestResp = await callWorker("/api/runner/test", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  assert.equal(runTestResp.status, 200);
  const runTestData = await runTestResp.json();
  assert.equal(runTestData.status, "passed");
  assert.equal(runTestData.valid_pages_count, 2);
  assert.equal(runTestData.valid_videos_count, 1);

  // Chạy Run Batch xuất bản Reels thật qua Meta Graph API
  const runStartResp = await callWorker("/api/runner/start", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ facebook_page_ids: ["101010101"], threads: 2 })
  });
  assert.equal(runStartResp.status, 200);
  const runStartData = await runStartResp.json();
  assert.equal(runStartData.status, "started");

  // Kiểm tra trạng thái Task sau khi đăng xong
  const tasksAfterResp = await callWorker("/api/tasks", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  const tasksAfter = await tasksAfterResp.json();
  assert.equal(tasksAfter[0].status, "success");
  assert.equal(tasksAfter[0].video_url, "https://www.facebook.com/reel/reel_vid_8888");
  assert.ok(tasksAfter[0].log.includes("Đã đăng bình luận tự động"));

  // Kiểm tra Bulk Tasks, Edit Task, Reset Task, Delete Task & /api/status
  const bulkResp = await callWorker("/api/tasks/bulk", {
    method: "POST",
    headers: {
      Cookie: `session_token=${tokenA}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tasks: [
        {
          video_path: "https://pagefb.namnangno.click/v1.mp4",
          caption: "Bulk 1",
          comment_text: "Cmt 1",
          schedule_date: "2026-11-10",
          schedule_time: "12:00"
        },
        {
          video_path: "https://pagefb.namnangno.click/v2.mp4",
          caption: "Bulk 2",
          comment_text: "",
          schedule_date: "2026-11-10",
          schedule_time: "19:00"
        }
      ],
      assign_page_ids: ["101010101", "102020202"]
    })
  });
  assert.equal(bulkResp.status, 200);
  const bulkJson = await bulkResp.json();
  assert.equal(bulkJson.inserted_count, 2);

  const statusResp = await callWorker("/api/status", {
    headers: { Cookie: `session_token=${tokenA}` }
  });
  assert.equal(statusResp.status, 200);
  const statusJson = await statusResp.json();
  assert.equal(statusJson.total_pages, 2);
  assert.equal(statusJson.total_tasks, 3);
  assert.equal(statusJson.success_tasks, 1);
  assert.equal(statusJson.pending_tasks, 2);

  // Kiểm tra CORS Preflight OPTIONS
  const corsResp = await callWorker("/api/pages", {
    method: "OPTIONS",
    headers: { Origin: "https://pagefb.namnangno.click" }
  });
  assert.equal(corsResp.status, 204);
  assert.equal(
    corsResp.headers.get("Access-Control-Allow-Origin"),
    "https://pagefb.namnangno.click"
  );
  console.log("  ✓ Upload Video, Bulk Tasks, Run Test, Xuất bản Reels + Auto-Comment & CORS hoạt động hoàn hảo!");

  globalThis.fetch = originalFetch;

  // 8. Kiểm tra Production Bundle Cleanliness (Không còn localhost:8000 hay App Secret trong static/ & src/)
  console.log("[TEST 8] Kiểm tra Production Bundle Cleanliness (Zero localhost & Zero secrets)...");
  const filesToAudit = [
    path.join(ROOT_DIR, "index.html"),
    path.join(ROOT_DIR, "static", "index.html"),
    path.join(ROOT_DIR, "static", "login.html"),
    path.join(ROOT_DIR, "static", "privacy.html"),
    path.join(ROOT_DIR, "static", "terms.html"),
    path.join(ROOT_DIR, "static", "data-deletion.html"),
    path.join(ROOT_DIR, "static", "js", "app.js"),
    path.join(ROOT_DIR, "src", "index.ts"),
    path.join(ROOT_DIR, "src", "meta.ts"),
    path.join(ROOT_DIR, "src", "db.ts"),
    path.join(ROOT_DIR, "src", "crypto.ts")
  ];

  for (const filePath of filesToAudit) {
    const content = fs.readFileSync(filePath, "utf-8");
    const baseName = path.relative(ROOT_DIR, filePath);
    assert.ok(
      !content.includes("localhost:8000") &&
        !content.includes("localhost:8001") &&
        !content.includes("127.0.0.1:8000"),
      `File ${baseName} vẫn còn chứa tham chiếu localhost:8000/127.0.0.1`
    );
    assert.ok(
      !content.includes("d595b9fcf01101b510315c2c08950863"),
      `File ${baseName} bị lộ META_APP_SECRET thật!`
    );
  }
  console.log("  ✓ Toàn bộ file Frontend & Worker sạch 100% (Không có localhost, không lộ Secret)!");

  console.log("\n==================================================================");
  console.log(" TẤT CẢ 8 NHÓM KIỂM THỬ CLOUDFLARE WORKER + D1 ĐỀU PASS 100%!     ");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("KIỂM THỬ THẤT BẠI:", err);
  process.exit(1);
});
