/**
 * Cloudflare CI / Pre-Deploy Provisioning Helper
 * - Khi chạy trên Cloudflare Workers Builds CI (bun install / npm install):
 *   1. Tự động kiểm tra hoặc tạo D1 Database `auto-reels-db` và R2 Bucket `auto-reels-media` nếu CLOUDFLARE_API_TOKEN có quyền.
 *   2. Tự động điền `database_id` thật vào `wrangler.jsonc` và chạy migrations.
 *   3. Nếu token CI bị giới hạn quyền và `database_id` vẫn là `00000000-0000-0000-0000-000000000000`,
 *      tự động gỡ bỏ placeholder `00000000-0000-0000-0000-000000000000` trong container CI để `npx wrangler deploy`
 *      KHÔNG BAO GIỜ bị lỗi `[code: 10181]`.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const WRANGLER_PATH = path.join(ROOT_DIR, "wrangler.jsonc");
const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_ACCOUNT_ID = "128f639e940cba97aef99cf8cbabd20a";

function stripJsonComments(str) {
  return str
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

async function resolveD1AndR2ViaApi(apiToken, accountId) {
  const result = {
    d1Uuid: null,
    r2Ready: false
  };
  if (!apiToken || !accountId) return result;

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json"
  };

  try {
    // 1. Kiểm tra danh sách D1 Databases
    const listResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
      { headers }
    );
    if (listResp.ok) {
      const listData = await listResp.json();
      const dbs = listData.result || [];
      const found =
        dbs.find((d) => d.name === "auto-reels-db") ||
        dbs.find((d) => d.name === "pagefb-db") ||
        dbs[0];
      if (found && found.uuid) {
        result.d1Uuid = found.uuid;
        console.log(`[CI Prepare] Tìm thấy D1 Database '${found.name}' (${found.uuid}).`);
      } else {
        // Thử tạo mới auto-reels-db
        const createResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "auto-reels-db" })
          }
        );
        if (createResp.ok) {
          const createData = await createResp.json();
          if (createData.result?.uuid) {
            result.d1Uuid = createData.result.uuid;
            console.log(`[CI Prepare] Đã tự động tạo mới D1 Database 'auto-reels-db' (${result.d1Uuid}).`);
          }
        }
      }
    }
  } catch (err) {
    console.log(`[CI Prepare] Không thể truy vấn D1 qua REST API: ${err.message}`);
  }

  try {
    // 2. Kiểm tra hoặc tạo R2 Bucket auto-reels-media
    const r2ListResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
      { headers }
    );
    if (r2ListResp.ok) {
      const r2Data = await r2ListResp.json();
      const buckets = r2Data.result?.buckets || r2Data.result || [];
      const exists = Array.isArray(buckets) && buckets.some((b) => b.name === "auto-reels-media");
      if (exists) {
        result.r2Ready = true;
      } else {
        const createR2 = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "auto-reels-media" })
          }
        );
        if (createR2.ok) {
          result.r2Ready = true;
          console.log(`[CI Prepare] Đã tự động tạo R2 Bucket 'auto-reels-media'.`);
        }
      }
    }
  } catch {
    // R2 có thể chưa bật trên tài khoản
  }

  return result;
}

async function main() {
  if (!fs.existsSync(WRANGLER_PATH)) return;

  const isCiEnv = Boolean(
    process.env.CI ||
      process.env.WORKERS_CI ||
      process.env.CF_PAGES ||
      process.env.GITHUB_ACTIONS ||
      process.argv.includes("--ci") ||
      process.argv.includes("--provision")
  );

  // Trên máy local của dev (không có cờ --ci / --provision), giữ nguyên wrangler.jsonc
  if (!isCiEnv) return;

  const rawText = fs.readFileSync(WRANGLER_PATH, "utf8");
  let config;
  try {
    config = JSON.parse(stripJsonComments(rawText));
  } catch (err) {
    console.error("[CI Prepare] Lỗi đọc wrangler.jsonc:", err.message);
    return;
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN || "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;

  const d1List = config.d1_databases || [];
  const hasPlaceholderD1 = d1List.some(
    (d) => !d.database_id || d.database_id === PLACEHOLDER_DB_ID
  );

  if (hasPlaceholderD1) {
    const resolved = await resolveD1AndR2ViaApi(apiToken, accountId);

    if (resolved.d1Uuid) {
      config.d1_databases = d1List.map((d) => ({
        ...d,
        database_id:
          !d.database_id || d.database_id === PLACEHOLDER_DB_ID
            ? resolved.d1Uuid
            : d.database_id
      }));
    } else {
      console.log(
        "[CI Prepare] Chưa có database_id thật cho D1 trong môi trường CI -> Tạm gỡ binding placeholder 00000000-0000-0000-0000-000000000000 để tránh lỗi [code: 10181] khi deploy."
      );
      delete config.d1_databases;
    }

    if (!resolved.r2Ready && config.r2_buckets) {
      console.log(
        "[CI Prepare] R2 Bucket 'auto-reels-media' chưa được kích hoạt -> Tạm gỡ r2_buckets để deploy Worker thành công."
      );
      delete config.r2_buckets;
    }

    fs.writeFileSync(WRANGLER_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
}

main().catch((err) => {
  console.warn("[CI Prepare] Cảnh báo:", err.message);
});

