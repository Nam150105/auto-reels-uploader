/**
 * Script Migration Dữ Liệu từ SQLite cục bộ (manager.db) sang Cloudflare D1 SQL
 * - Tự động tạo bản sao lưu (backup) trước khi đọc
 * - Không sửa hoặc xóa manager.db
 * - Tính toán scheduled_at (UTC) từ schedule_date + schedule_time (Asia/Ho_Chi_Minh)
 * - Xuất file migrations/seed_from_manager_db.sql có tính idempotent (INSERT OR IGNORE / ON CONFLICT)
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT_DIR = process.cwd();
const DB_PATH = path.join(ROOT_DIR, "manager.db");
const BACKUP_DIR = path.join(ROOT_DIR, "backups");
const OUTPUT_SQL = path.join(ROOT_DIR, "backups", "seed_from_manager_db.sql");

function sqlLiteral(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  return `'${String(val).replace(/'/g, "''")}'`;
}

function parseVnToUtc(dateStr, timeStr) {
  const d = (dateStr || "").trim();
  const t = (timeStr || "").trim();
  if (!d || !t) return null;
  const mD = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const mT = /^(\d{2}):(\d{2})/.exec(t);
  if (!mD || !mT) return null;
  const utcMs =
    Date.UTC(
      Number(mD[1]),
      Number(mD[2]) - 1,
      Number(mD[3]),
      Number(mT[1]),
      Number(mT[2]),
      0
    ) -
    7 * 3600 * 1000;
  return Math.floor(utcMs / 1000);
}

function runMigration() {
  if (!fs.existsSync(DB_PATH)) {
    console.log("Không tìm thấy manager.db để trích xuất dữ liệu.");
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(BACKUP_DIR, `manager_backup_d1_export_${ts}.db`);
  fs.copyFileSync(DB_PATH, backupFile);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const users = db.prepare("SELECT * FROM users").all();
  const fbAccounts = db.prepare("SELECT * FROM facebook_accounts").all();
  const fbPages = db.prepare("SELECT * FROM facebook_pages").all();
  const fbAccPages = db.prepare("SELECT * FROM facebook_account_pages").all();
  const profiles = db.prepare("SELECT * FROM profiles").all();
  const tasks = db.prepare("SELECT * FROM tasks").all();

  const lines = [
    "-- ============================================================================",
    "-- DATA MIGRATION EXPORT FROM LEGACY manager.db TO CLOUDFLARE D1",
    `-- Generated at: ${new Date().toISOString()}`,
    `-- Source counts: users=${users.length}, accounts=${fbAccounts.length}, pages=${fbPages.length}, links=${fbAccPages.length}, profiles=${profiles.length}, tasks=${tasks.length}`,
    "-- ============================================================================",
    ""
  ];

  for (const u of users) {
    lines.push(
      `INSERT OR IGNORE INTO users (id, username, email, password_hash, full_name, role, is_active, created_at, updated_at) VALUES (${sqlLiteral(u.id)}, ${sqlLiteral(u.username)}, ${sqlLiteral(u.email)}, ${sqlLiteral(u.password_hash)}, ${sqlLiteral(u.full_name)}, ${sqlLiteral(u.role || "member")}, ${Number(u.is_active ?? 1)}, ${sqlLiteral(u.created_at || new Date().toISOString())}, ${sqlLiteral(u.updated_at)});`
    );
  }

  for (const p of profiles) {
    lines.push(
      `INSERT OR IGNORE INTO profiles (id, owner_user_id, name, facebook_page_name, facebook_page_id, status, notes, created_at) VALUES (${sqlLiteral(p.id)}, ${sqlLiteral(p.owner_user_id || "usr_admin")}, ${sqlLiteral(p.name)}, ${sqlLiteral(p.facebook_page_name)}, ${sqlLiteral(p.facebook_page_id)}, ${sqlLiteral(p.status || "idle")}, ${sqlLiteral(p.notes)}, ${sqlLiteral(p.created_at)});`
    );
  }

  for (const fp of fbPages) {
    lines.push(
      `INSERT OR IGNORE INTO facebook_pages (id, owner_user_id, facebook_page_id, page_name, category, avatar_url, page_access_token, token_version, tasks_json, can_post, is_published, is_selected, status, token_status, connected_account_id, last_synced_at, created_at, updated_at) VALUES (${sqlLiteral(fp.id)}, ${sqlLiteral(fp.owner_user_id || "usr_admin")}, ${sqlLiteral(fp.facebook_page_id)}, ${sqlLiteral(fp.page_name)}, ${sqlLiteral(fp.category || "")}, ${sqlLiteral(fp.avatar_url || "")}, '', 'v2', ${sqlLiteral(fp.tasks_json || "[]")}, ${Number(fp.can_post ?? 1)}, ${Number(fp.is_published ?? 1)}, ${Number(fp.is_selected ?? 1)}, ${sqlLiteral(fp.status || "disconnected")}, 'reauth_required', ${sqlLiteral(fp.connected_account_id)}, ${sqlLiteral(fp.last_synced_at)}, ${sqlLiteral(fp.created_at)}, ${sqlLiteral(fp.updated_at)});`
    );
  }

  for (const t of tasks) {
    const schedUtc = parseVnToUtc(t.schedule_date, t.schedule_time);
    const ownerId = t.owner_user_id || "usr_admin";
    const pageId = t.facebook_page_id || t.profile_id || null;
    const idemKey = `migrated_task_${t.id}`;
    lines.push(
      `INSERT OR IGNORE INTO tasks (id, owner_user_id, profile_id, facebook_page_id, video_path, caption, comment_text, schedule_date, schedule_time, scheduled_at, timezone, status, idempotency_key, log, video_id, post_id, video_url, created_at, updated_at) VALUES (${Number(t.id)}, ${sqlLiteral(ownerId)}, ${sqlLiteral(t.profile_id)}, ${sqlLiteral(pageId)}, ${sqlLiteral(t.video_path)}, ${sqlLiteral(t.caption || "")}, ${sqlLiteral(t.comment_text || "")}, ${sqlLiteral(t.schedule_date || "")}, ${sqlLiteral(t.schedule_time || "")}, ${sqlLiteral(schedUtc)}, 'Asia/Ho_Chi_Minh', ${sqlLiteral(t.status || "pending")}, ${sqlLiteral(idemKey)}, ${sqlLiteral(t.log || "")}, ${sqlLiteral(t.video_id || "")}, ${sqlLiteral(t.post_id || "")}, ${sqlLiteral(t.video_url || "")}, ${sqlLiteral(t.created_at)}, ${sqlLiteral(t.updated_at)});`
    );
  }

  fs.writeFileSync(OUTPUT_SQL, lines.join("\n") + "\n", "utf8");
  db.close();

  console.log("=== KẾT QUẢ MIGRATION DỮ LIỆU TỪ manager.db SANG D1 ===");
  console.log(`- Bản backup đã tạo: ${backupFile}`);
  console.log(`- File SQL D1 xuất ra: ${OUTPUT_SQL}`);
  console.log(`- Users giữ nguyên: ${users.length}`);
  console.log(`- Facebook Accounts: ${fbAccounts.length}`);
  console.log(`- Facebook Pages giữ nguyên: ${fbPages.length}`);
  console.log(`- Profiles giữ nguyên: ${profiles.length}`);
  console.log(`- Tasks giữ nguyên: ${tasks.length}`);
}

runMigration();
