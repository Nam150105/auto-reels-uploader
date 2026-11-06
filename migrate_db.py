import os
import sys
import shutil
import sqlite3
import datetime
from typing import Dict, Any, List

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manager.db")

TABLE_COLUMNS_MIGRATION = {
    "users": {
        "username": "TEXT",
        "password_hash": "TEXT",
        "salt": "TEXT",
        "full_name": "TEXT",
        "email": "TEXT",
        "role": "TEXT DEFAULT 'user'",
        "status": "TEXT DEFAULT 'active'",
        "created_at": "TIMESTAMP"
    },
    "profiles": {
        "name": "TEXT",
        "user_agent": "TEXT",
        "screen_resolution": "TEXT",
        "status": "TEXT DEFAULT 'idle'",
        "gemloginProfileId": "TEXT",
        "pageName": "TEXT",
        "pageId": "TEXT",
        "pageUrl": "TEXT",
        "lastCheckedAt": "TIMESTAMP",
        "lastCheckResult": "TEXT",
        "created_at": "TIMESTAMP"
    },
    "facebook_accounts": {
        "user_name": "TEXT",
        "encrypted_user_access_token": "TEXT",
        "token_expires_at": "TEXT",
        "scopes": "TEXT",
        "status": "TEXT DEFAULT 'connected'",
        "owner_user_id": "TEXT",
        "avatar_url": "TEXT",
        "connected_at": "TIMESTAMP",
        "last_synced_at": "TIMESTAMP"
    },
    "meta_connections": {
        "user_name": "TEXT",
        "encrypted_user_access_token": "TEXT",
        "token_expires_at": "TEXT",
        "scopes": "TEXT",
        "connected_at": "TIMESTAMP",
        "status": "TEXT DEFAULT 'connected'"
    },
    "facebook_pages": {
        "name": "TEXT",
        "category": "TEXT",
        "encrypted_page_access_token": "TEXT",
        "tasks": "TEXT",
        "can_post": "INTEGER DEFAULT 1",
        "connection_id": "TEXT",
        "is_selected": "INTEGER DEFAULT 1",
        "status": "TEXT DEFAULT 'connected'",
        "token_status": "TEXT DEFAULT 'valid'",
        "avatar_url": "TEXT",
        "last_synced_at": "TIMESTAMP",
        "created_at": "TIMESTAMP"
    },
    "facebook_account_pages": {
        "encrypted_page_access_token": "TEXT",
        "tasks": "TEXT",
        "can_post": "INTEGER DEFAULT 1",
        "token_status": "TEXT DEFAULT 'valid'",
        "synced_at": "TIMESTAMP"
    },
    "tasks": {
        "profile_id": "TEXT",
        "facebook_page_id": "TEXT",
        "video_path": "TEXT",
        "caption": "TEXT",
        "link_ac": "TEXT",
        "comment_text": "TEXT",
        "schedule_date": "TEXT",
        "schedule_time": "TEXT",
        "status": "TEXT DEFAULT 'pending'",
        "video_url": "TEXT",
        "meta_video_id": "TEXT",
        "meta_post_id": "TEXT",
        "publish_mode": "TEXT DEFAULT 'now'",
        "error_message": "TEXT",
        "log": "TEXT",
        "done_time": "TEXT",
        "owner_user_id": "TEXT",
        "created_at": "TIMESTAMP"
    }
}


def backup_database(db_path: str = DB_PATH) -> Optional[str]:
    """Tự động tạo bản sao lưu an toàn trước khi thực hiện bất kỳ migration nào."""
    if not os.path.exists(db_path):
        print(f"[Backup] Database '{db_path}' không tồn tại. Bỏ qua backup.")
        return None

    backup_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_filename = f"manager_backup_{timestamp}.db"
    backup_path = os.path.join(backup_dir, backup_filename)
    
    shutil.copy2(db_path, backup_path)
    print(f"[Backup] Đã tạo bản sao lưu thành công tại: {backup_path}")
    return backup_path


def run_migration(db_path: str = DB_PATH, create_backup: bool = True) -> Dict[str, Any]:
    """
    Thực hiện migration an toàn và có tính Idempotent (chạy nhiều lần không lỗi):
    1. Backup DB trước khi thay đổi
    2. Kiểm tra schema thực tế của từng bảng
    3. Thêm các cột còn thiếu
    4. Cập nhật giá trị mặc định cho cột mới
    5. Đảm bảo toàn bộ khóa chính, khóa ngoại, quan hệ và số lượng bản ghi nguyên vẹn
    """
    report: Dict[str, Any] = {
        "backup_path": None,
        "missing_columns_found": {},
        "columns_added": [],
        "records_count_before": {},
        "records_count_after": {},
        "integrity_check": None,
        "fk_check": None,
        "status": "success"
    }

    if not os.path.exists(db_path):
        print(f"[Migration] File database {db_path} chưa tồn tại.")
        return report

    if create_backup:
        report["backup_path"] = backup_database(db_path)

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.execute("PRAGMA foreign_keys = ON;")
    cursor = conn.cursor()

    try:
        # 1. Đảm bảo toàn bộ các bảng bắt buộc đều tồn tại (CREATE TABLE IF NOT EXISTS)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                full_name TEXT,
                email TEXT,
                role TEXT DEFAULT 'user',
                status TEXT DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                user_agent TEXT,
                screen_resolution TEXT,
                status TEXT DEFAULT 'idle',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS facebook_accounts (
                id TEXT PRIMARY KEY,
                user_id TEXT UNIQUE NOT NULL,
                user_name TEXT,
                encrypted_user_access_token TEXT NOT NULL,
                token_expires_at TEXT,
                scopes TEXT,
                status TEXT DEFAULT 'connected',
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS meta_connections (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                user_name TEXT,
                encrypted_user_access_token TEXT NOT NULL,
                token_expires_at TEXT,
                scopes TEXT,
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'connected'
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS facebook_pages (
                id TEXT PRIMARY KEY,
                facebook_page_id TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                category TEXT,
                encrypted_page_access_token TEXT NOT NULL,
                tasks TEXT,
                can_post INTEGER DEFAULT 1,
                connection_id TEXT,
                is_selected INTEGER DEFAULT 1,
                status TEXT DEFAULT 'connected',
                token_status TEXT DEFAULT 'valid',
                last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS facebook_account_pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id TEXT NOT NULL,
                facebook_page_id TEXT NOT NULL,
                encrypted_page_access_token TEXT NOT NULL,
                tasks TEXT,
                can_post INTEGER DEFAULT 1,
                token_status TEXT DEFAULT 'valid',
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (account_id) REFERENCES facebook_accounts (id) ON DELETE CASCADE,
                FOREIGN KEY (facebook_page_id) REFERENCES facebook_pages (facebook_page_id) ON DELETE CASCADE,
                UNIQUE(account_id, facebook_page_id)
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id TEXT,
                facebook_page_id TEXT,
                video_path TEXT NOT NULL,
                caption TEXT,
                link_ac TEXT,
                comment_text TEXT,
                schedule_date TEXT,
                schedule_time TEXT,
                status TEXT DEFAULT 'pending',
                video_url TEXT,
                meta_video_id TEXT,
                meta_post_id TEXT,
                publish_mode TEXT DEFAULT 'now',
                error_message TEXT,
                log TEXT,
                done_time TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE SET NULL,
                FOREIGN KEY (facebook_page_id) REFERENCES facebook_pages (facebook_page_id) ON DELETE CASCADE
            );
        """)

        # 2. Đếm số lượng bản ghi ban đầu
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence'")
        tables = [row[0] for row in cursor.fetchall()]
        for t in tables:
            cursor.execute(f"SELECT count(*) FROM '{t}'")
            report["records_count_before"][t] = cursor.fetchone()[0]

        print(f"\n[Migration] Bản ghi ban đầu trong database:")
        for t, count in report["records_count_before"].items():
            print(f"  • {t}: {count} bản ghi")

        # 3. Kiểm tra và bổ sung cột cho từng bảng
        for tbl_name, col_dict in TABLE_COLUMNS_MIGRATION.items():
            cursor.execute(f"PRAGMA table_info('{tbl_name}')")
            existing_cols = {r[1]: r for r in cursor.fetchall()}
            missing_in_tbl = []

            for col_name, col_def in col_dict.items():
                if col_name not in existing_cols:
                    missing_in_tbl.append(col_name)
                    alter_sql = f"ALTER TABLE {tbl_name} ADD COLUMN {col_name} {col_def};"
                    print(f"[Migration] Bổ sung cột thiếu: {tbl_name}.{col_name} ({col_def})")
                    cursor.execute(alter_sql)
                    report["columns_added"].append(f"{tbl_name}.{col_name}")

            if missing_in_tbl:
                report["missing_columns_found"][tbl_name] = missing_in_tbl

        # 4. Đồng bộ dữ liệu tương thích ngược nếu có
        cursor.execute("""
            INSERT OR IGNORE INTO facebook_accounts (
                id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, status, connected_at, last_synced_at
            )
            SELECT id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, status, connected_at, connected_at
            FROM meta_connections
            WHERE user_id IS NOT NULL;
        """)

        cursor.execute("""
            INSERT OR IGNORE INTO facebook_account_pages (
                account_id, facebook_page_id, encrypted_page_access_token, tasks, can_post, token_status, synced_at
            )
            SELECT connection_id, facebook_page_id, encrypted_page_access_token, tasks, can_post, 'valid', last_synced_at
            FROM facebook_pages
            WHERE connection_id IS NOT NULL AND connection_id IN (SELECT id FROM facebook_accounts);
        """)

        # 3. Điền giá trị mặc định cho các dòng hiện tại nếu NULL
        if "facebook_pages" in tables:
            cursor.execute("UPDATE facebook_pages SET token_status = 'valid' WHERE token_status IS NULL;")
            cursor.execute("UPDATE facebook_pages SET can_post = 1 WHERE can_post IS NULL;")
            cursor.execute("UPDATE facebook_pages SET is_selected = 1 WHERE is_selected IS NULL;")
            cursor.execute("UPDATE facebook_pages SET status = 'connected' WHERE status IS NULL;")
            cursor.execute("UPDATE facebook_pages SET last_synced_at = CURRENT_TIMESTAMP WHERE last_synced_at IS NULL;")
            cursor.execute("UPDATE facebook_pages SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;")

        if "facebook_account_pages" in tables:
            cursor.execute("UPDATE facebook_account_pages SET token_status = 'valid' WHERE token_status IS NULL;")
            cursor.execute("UPDATE facebook_account_pages SET can_post = 1 WHERE can_post IS NULL;")
            cursor.execute("UPDATE facebook_account_pages SET synced_at = CURRENT_TIMESTAMP WHERE synced_at IS NULL;")

        if "facebook_accounts" in tables:
            cursor.execute("UPDATE facebook_accounts SET status = 'connected' WHERE status IS NULL;")
            cursor.execute("UPDATE facebook_accounts SET connected_at = CURRENT_TIMESTAMP WHERE connected_at IS NULL;")
            cursor.execute("UPDATE facebook_accounts SET last_synced_at = CURRENT_TIMESTAMP WHERE last_synced_at IS NULL;")

        if "tasks" in tables:
            cursor.execute("UPDATE tasks SET status = 'pending' WHERE status IS NULL;")
            cursor.execute("UPDATE tasks SET publish_mode = 'now' WHERE publish_mode IS NULL;")
            cursor.execute("UPDATE tasks SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;")

        # 4. Đảm bảo các Index cần thiết
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fap_account ON facebook_account_pages(account_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fap_page ON facebook_account_pages(facebook_page_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fa_userid ON facebook_accounts(user_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tasks_page ON tasks(facebook_page_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_pages_fbpid ON facebook_pages(facebook_page_id);")

        conn.commit()

        # 5. Đếm số lượng bản ghi sau migration để kiểm chứng không mất dữ liệu
        for t in tables:
            cursor.execute(f"SELECT count(*) FROM '{t}'")
            report["records_count_after"][t] = cursor.fetchone()[0]

        # 6. Kiểm tra toàn vẹn DB và Khóa ngoại
        cursor.execute("PRAGMA integrity_check;")
        integrity = cursor.fetchall()
        report["integrity_check"] = [r[0] for r in integrity]

        cursor.execute("PRAGMA foreign_key_check;")
        fk_issues = cursor.fetchall()
        report["fk_check"] = fk_issues

        print("\n[Migration] Kiểm tra toàn vẹn SQLite:")
        print(f"  • Integrity Check: {report['integrity_check']}")
        print(f"  • Foreign Key Check: {report['fk_check'] if report['fk_check'] else 'OK (Không có lỗi FK)'}")

        print(f"\n[Migration] Bản ghi sau migration:")
        for t, count in report["records_count_after"].items():
            print(f"  • {t}: {count} bản ghi (Ban đầu: {report['records_count_before'][t]})")

    except Exception as e:
        conn.rollback()
        report["status"] = "error"
        report["error"] = str(e)
        print(f"[Migration] LỖI MIGRATION: {e}")
        raise
    finally:
        conn.close()

    return report


if __name__ == "__main__":
    print("=== BẮT ĐẦU CHẠY MIGRATION DATABASE ===")
    res = run_migration()
    print("\n=== KẾT QUẢ MIGRATION ===")
    print(f"Status: {res['status']}")
    print(f"Columns added: {res['columns_added']}")
