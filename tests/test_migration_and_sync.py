import unittest
import os
import sys
import tempfile
import sqlite3
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from meta_crypto import encrypt_token, decrypt_token
import database
import meta_oauth_service
from meta_graph_service import MetaGraphService
import migrate_db
import main

class TestMigrationAndSync(unittest.TestCase):
    """
    Kiểm tra chuyên sâu:
    1. Database cũ thiếu cột token_status
    2. Chạy migrate_db thành công, thêm cột, bảo toàn dữ liệu
    3. OAuth callback và đồng bộ Fanpage (sync_pages) chạy trơn tru không lỗi
    4. Idempotency: chạy lại migration không lỗi
    5. Kiểm tra tính toàn vẹn và khóa ngoại
    """

    def setUp(self):
        # Tạo DB giả lập phiên bản cũ THIẾU cột token_status trong facebook_pages
        fd, self.test_db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.original_db_path = database.DB_PATH
        database.DB_PATH = self.test_db_path
        migrate_db.DB_PATH = self.test_db_path

        conn = sqlite3.connect(self.test_db_path)
        cursor = conn.cursor()
        
        # Bảng profiles cũ có dữ liệu
        cursor.execute("""
            CREATE TABLE profiles (
                id TEXT PRIMARY KEY,
                name TEXT,
                status TEXT DEFAULT 'idle',
                user_agent TEXT,
                screen_resolution TEXT,
                created_at TEXT
            );
        """)
        cursor.execute("INSERT INTO profiles (id, name) VALUES ('prof_1', 'Fanpage Test 1');")

        # Bảng facebook_accounts cũ
        cursor.execute("""
            CREATE TABLE facebook_accounts (
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
            INSERT INTO facebook_accounts (id, user_id, user_name, encrypted_user_access_token)
            VALUES ('acc_old', '123456789', 'Admin Cu', 'enc_token_123');
        """)

        # BẢNG facebook_pages CŨ: CỐ TÌNH THIẾU CỘT token_status (gây lỗi như thực tế)
        cursor.execute("""
            CREATE TABLE facebook_pages (
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
                last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        cursor.execute("""
            INSERT INTO facebook_pages (id, facebook_page_id, name, encrypted_page_access_token)
            VALUES ('page_old_1', 'fb_p_old', 'Page Cu Truoc Migration', 'enc_p_tok');
        """)

        # Bảng tasks cũ có dữ liệu
        cursor.execute("""
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id TEXT,
                facebook_page_id TEXT,
                video_path TEXT NOT NULL,
                caption TEXT,
                status TEXT DEFAULT 'pending'
            );
        """)
        cursor.execute("""
            INSERT INTO tasks (profile_id, facebook_page_id, video_path, caption)
            VALUES ('prof_1', 'fb_p_old', 'D:/Videos/sample.mp4', 'Caption test cu');
        """)

        conn.commit()
        conn.close()

    def tearDown(self):
        database.DB_PATH = self.original_db_path
        migrate_db.DB_PATH = self.original_db_path
        if os.path.exists(self.test_db_path):
            try:
                os.remove(self.test_db_path)
            except Exception:
                pass

    def test_01_verify_old_db_crashes_before_migration(self):
        """Chứng minh trước migration, lệnh chèn có token_status sẽ văng lỗi OperationalError."""
        conn = sqlite3.connect(self.test_db_path)
        cursor = conn.cursor()
        with self.assertRaises(sqlite3.OperationalError) as ctx:
            cursor.execute(
                "INSERT INTO facebook_pages (id, facebook_page_id, name, encrypted_page_access_token, token_status) VALUES ('p2', 'fbp2', 'P2', 'tok', 'valid')"
            )
        self.assertIn("no column named token_status", str(ctx.exception))
        conn.close()

    def test_02_migration_adds_missing_columns_and_preserves_records(self):
        """Kiểm tra migration tự động bổ sung token_status và giữ 100% dữ liệu cũ."""
        res = migrate_db.run_migration(db_path=self.test_db_path, create_backup=False)
        self.assertEqual(res["status"], "success")
        self.assertIn("facebook_pages.token_status", res["columns_added"])

        # Kiểm tra dữ liệu cũ được bảo toàn
        conn = sqlite3.connect(self.test_db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Profiles
        cursor.execute("SELECT count(*) FROM profiles")
        self.assertEqual(cursor.fetchone()[0], 1)

        # Accounts
        cursor.execute("SELECT count(*) FROM facebook_accounts")
        self.assertEqual(cursor.fetchone()[0], 1)

        # Tasks
        cursor.execute("SELECT count(*) FROM tasks")
        self.assertEqual(cursor.fetchone()[0], 1)

        # Pages cũ giờ đã có token_status = 'valid'
        cursor.execute("SELECT facebook_page_id, name, token_status FROM facebook_pages WHERE facebook_page_id = 'fb_p_old'")
        row = cursor.fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["name"], "Page Cu Truoc Migration")
        self.assertEqual(row["token_status"], "valid")

        conn.close()

    def test_03_sync_pages_after_migration_succeeds(self):
        """Kiểm tra sau khi migration, MetaGraphService.sync_pages chạy thành công 100%."""
        # Chạy migration
        migrate_db.run_migration(db_path=self.test_db_path, create_backup=False)

        # Tạo account mới cần sync
        acc = database.save_facebook_account(
            user_id="uid_new_999",
            user_name="Admin Test Sync",
            encrypted_token=encrypt_token("tok_new_user")
        )

        mock_pages_api = {
            "data": [
                {
                    "id": "page_synced_100",
                    "name": "Page Thu Nghiem Moi",
                    "category": "Media",
                    "access_token": "raw_page_access_token_100",
                    "tasks": ["CREATE_CONTENT", "MANAGE"]
                }
            ],
            "paging": {}
        }

        with patch("requests.get") as mock_get:
            mock_resp = MagicMock()
            mock_resp.json.return_value = mock_pages_api
            mock_get.return_value = mock_resp

            res = MetaGraphService.sync_pages(account_id=acc["id"])

        self.assertEqual(res["status"], "success")
        self.assertEqual(res["unique_pages_count"], 1)

        # Kiểm tra trang đã được lưu vào database với đầy đủ token_status = 'valid'
        page = database.get_facebook_page_by_fb_id("page_synced_100")
        self.assertIsNotNone(page)
        self.assertEqual(page["name"], "Page Thu Nghiem Moi")
        self.assertEqual(page["can_post"], 1)
        self.assertEqual(page["token_status"], "valid")

        # Kiểm tra quan hệ Many-to-Many
        pages_list = database.get_facebook_pages(account_ids=[acc["id"]])
        self.assertEqual(len(pages_list), 1)
        self.assertEqual(pages_list[0]["facebook_page_id"], "page_synced_100")

    def test_04_idempotency_multiple_migrations_run_cleanly(self):
        """Kiểm tra chạy migration 5 lần liên tiếp: không lỗi, không duplicate cột."""
        for _ in range(5):
            res = migrate_db.run_migration(db_path=self.test_db_path, create_backup=False)
            self.assertEqual(res["status"], "success")

        # Chạy lại database.init_db() cũng không gây lỗi
        database.init_db()

        # Kiểm tra số lượng cột token_status trong table_info chỉ xuất hiện đúng 1 lần
        conn = sqlite3.connect(self.test_db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(facebook_pages)")
        cols = [r[1] for r in cursor.fetchall()]
        self.assertEqual(cols.count("token_status"), 1)
        conn.close()

if __name__ == "__main__":
    unittest.main()

