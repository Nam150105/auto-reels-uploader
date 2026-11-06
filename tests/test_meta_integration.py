import unittest
import os
import sys
import tempfile
import json
from unittest.mock import patch

# Đảm bảo đường dẫn import đúng module gốc
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from meta_crypto import encrypt_token, decrypt_token, mask_token
import database
import meta_oauth_service
from meta_graph_service import MetaGraphService
from meta_runner import MetaTestRunner, MetaTaskRunner


class TestMetaCrypto(unittest.TestCase):
    """Kiểm tra mô đun mã hóa token đối xứng Fernet."""

    def test_encrypt_decrypt_roundtrip(self):
        secret_token = "EAABwzLixnjYBO9876543210very_secret_meta_user_token_xyz"
        encrypted = encrypt_token(secret_token)
        
        self.assertIsNotNone(encrypted)
        self.assertNotEqual(secret_token, encrypted)
        self.assertTrue(encrypted.startswith("gAAAAA")) # Đặc trưng Fernet ciphertext

        decrypted = decrypt_token(encrypted)
        self.assertEqual(secret_token, decrypted)

    def test_empty_or_none_token(self):
        self.assertIsNone(encrypt_token(None))
        self.assertIsNone(encrypt_token(""))
        self.assertIsNone(decrypt_token(None))
        self.assertIsNone(decrypt_token(""))

    def test_mask_token(self):
        token = "EAABwzLixnjYBO9876543210abcdefg123456"
        masked = mask_token(token)
        self.assertTrue(masked.startswith("EAABwz..."))
        self.assertTrue(masked.endswith("3456"))
        self.assertNotIn("9876543210", masked)

        short_token = "abc"
        self.assertEqual(mask_token(short_token), "********")


class TestMetaDatabase(unittest.TestCase):
    """Kiểm tra các bảng dữ liệu Meta và quan hệ CRUD trong SQLite."""

    def setUp(self):
        fd, self.test_db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.original_db_path = database.DB_PATH
        database.DB_PATH = self.test_db_path
        database.init_db()

    def tearDown(self):
        database.DB_PATH = self.original_db_path
        if os.path.exists(self.test_db_path):
            try:
                os.remove(self.test_db_path)
            except Exception:
                pass

    def test_meta_connection_crud(self):
        # 1. Lưu connection
        enc_token = encrypt_token("sample_admin_token_12345")
        database.save_meta_connection(
            user_id="1000889912345",
            user_name="Nguyen Van Admin",
            encrypted_token=enc_token,
            token_expires_at="2027-01-01 00:00:00",
            scopes="pages_show_list,pages_read_engagement,pages_manage_posts,publish_video"
        )

        # 2. Lấy connection đang hoạt động
        conn = database.get_active_meta_connection()
        self.assertIsNotNone(conn)
        self.assertEqual(conn["user_id"], "1000889912345")
        self.assertEqual(conn["user_name"], "Nguyen Van Admin")
        self.assertIn("publish_video", conn["scopes"])
        self.assertEqual(conn["status"], "connected")

        # 3. Disconnect connection
        database.disconnect_meta()
        conn_after = database.get_active_meta_connection()
        self.assertIsNone(conn_after)

    def test_facebook_page_crud_and_selection(self):
        # 1. Lưu connection trước
        database.save_meta_connection(
            user_id="10001",
            user_name="Admin Test",
            encrypted_token=encrypt_token("tok"),
            token_expires_at=None,
            scopes="pages_manage_posts"
        )
        active_conn = database.get_active_meta_connection()

        # 2. Upsert Fanpage
        database.upsert_facebook_page(
            facebook_page_id="page_101",
            name="Fanpage Giai Tri Test",
            category="Media/News Company",
            encrypted_page_access_token=encrypt_token("page_token_101"),
            tasks_json=json.dumps(["CREATE_CONTENT", "MANAGE"]),
            can_post=1,
            connection_id=active_conn["id"]
        )

        pages = database.get_facebook_pages()
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["facebook_page_id"], "page_101")
        self.assertEqual(pages[0]["name"], "Fanpage Giai Tri Test")
        self.assertTrue(pages[0]["can_post"])
        self.assertTrue(pages[0]["is_selected"])

        # 3. Update selection
        database.update_page_selection("page_101", False)
        page_updated = database.get_facebook_page_by_fb_id("page_101")
        self.assertFalse(page_updated["is_selected"])

        # 4. Bulk select
        database.bulk_update_page_selection(True)
        page_updated = database.get_facebook_page_by_fb_id("page_101")
        self.assertTrue(page_updated["is_selected"])

        # 5. Local delete
        database.delete_facebook_page_local("page_101")
        self.assertIsNone(database.get_facebook_page_by_fb_id("page_101"))

    def test_task_with_facebook_page(self):
        # Tạo Page
        database.upsert_facebook_page(
            facebook_page_id="page_202",
            name="Page Review Phim",
            category="Video Creator",
            encrypted_page_access_token=encrypt_token("tok_202"),
            tasks_json=json.dumps(["CREATE_CONTENT"]),
            can_post=1
        )

        # Thêm task liên kết với Fanpage
        task_id = database.add_task(
            facebook_page_id="page_202",
            video_path="C:\\Videos\\clip1.mp4",
            caption="Review tap 1 sieu hot 🔥",
            comment_text="Xem them tai bio",
            schedule_date="2026-12-01",
            schedule_time="19:30",
            publish_mode="scheduled"
        )

        task = database.get_task(task_id)
        self.assertIsNotNone(task)
        self.assertEqual(task["facebook_page_id"], "page_202")
        self.assertEqual(task["page_name"], "Page Review Phim")
        self.assertEqual(task["publish_mode"], "scheduled")
        self.assertEqual(task["status"], "pending")

        # Cập nhật kết quả đăng bài của Meta
        database.update_task_status(
            task_id=task_id,
            status="success",
            meta_video_id="vid_99887766",
            meta_post_id="post_99887766_11",
            video_url="https://www.facebook.com/reel/99887766",
            log="Đã lên lịch thành công trên Fanpage Page Review Phim."
        )

        task_after = database.get_task(task_id)
        self.assertEqual(task_after["status"], "success")
        self.assertEqual(task_after["meta_video_id"], "vid_99887766")
        self.assertEqual(task_after["video_url"], "https://www.facebook.com/reel/99887766")


class TestMetaOAuthService(unittest.TestCase):
    """Kiểm tra luồng tạo và thẩm định mã bảo mật CSRF State OAuth 2.0."""

    @patch("meta_oauth_service.get_meta_config")
    def test_csrf_state_generation_and_validation(self, mock_config):
        mock_config.return_value = {
            "app_id": "123456789012345",
            "app_secret": "abcdef1234567890abcdef1234567890",
            "redirect_uri": "http://localhost:8000/api/meta/callback",
            "api_version": "v19.0"
        }

        res = meta_oauth_service.generate_oauth_url()
        self.assertEqual(res["status"], "success")
        self.assertIn("oauth_url", res)
        self.assertIn("state", res)
        self.assertIn("client_id=123456789012345", res["oauth_url"])
        
        state = res["state"]
        self.assertTrue(len(state) > 16)

        # State hợp lệ lần đầu
        is_valid = meta_oauth_service.verify_csrf_state(state)
        self.assertTrue(is_valid)

        # State dùng 1 lần (One-time token): lần thứ 2 phải thất bại để chống replay attack
        is_replayed = meta_oauth_service.verify_csrf_state(state)
        self.assertFalse(is_replayed)

    def test_invalid_csrf_state(self):
        self.assertFalse(meta_oauth_service.verify_csrf_state("fake_invalid_state_12345"))
        self.assertFalse(meta_oauth_service.verify_csrf_state(""))
        self.assertFalse(meta_oauth_service.verify_csrf_state(None))


class TestMetaRunners(unittest.TestCase):
    """Kiểm tra TestRunner chẩn đoán và TaskRunner đa luồng."""

    def setUp(self):
        fd, self.test_db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.original_db_path = database.DB_PATH
        database.DB_PATH = self.test_db_path
        database.init_db()

    def tearDown(self):
        database.DB_PATH = self.original_db_path
        if os.path.exists(self.test_db_path):
            try:
                os.remove(self.test_db_path)
            except Exception:
                pass

    def test_run_test_diagnostics_without_publishing(self):
        """Kiểm tra chế độ RUN TEST tuyệt đối không upload hay publish video."""
        # Setup Meta connection và Page
        database.save_meta_connection(
            user_id="10008899",
            user_name="Admin Diag",
            encrypted_token=encrypt_token("tok_diag"),
            token_expires_at="2027-01-01 00:00:00",
            scopes="pages_show_list,pages_read_engagement,pages_manage_posts"
        )

        database.upsert_facebook_page(
            facebook_page_id="page_diag_01",
            name="Diagnostic Test Page",
            category="Community",
            encrypted_page_access_token=encrypt_token("dummy_token"),
            tasks_json=json.dumps(["CREATE_CONTENT"]),
            can_post=1
        )

        # Tạo file video tạm thời
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(b"fake video binary header content")
            temp_vid_path = f.name

        try:
            task_id = database.add_task(
                facebook_page_id="page_diag_01",
                video_path=temp_vid_path,
                caption="Test caption #reels",
                comment_text="",
                schedule_date="",
                schedule_time=""
            )

            with patch.object(MetaGraphService, "check_page_permission", return_value={"status": "success", "can_post": True, "message": "OK"}):
                test_report = MetaTestRunner.run_test(
                    facebook_page_ids=["page_diag_01"],
                    task_ids=[task_id]
                )

            # Kiểm tra cấu trúc báo cáo chẩn đoán
            self.assertIn("status", test_report)
            self.assertIn("oauth_check", test_report)
            self.assertIn("page_checks", test_report)
            self.assertIn("video_checks", test_report)

            # File video tạm đã được tạo nên tồn tại
            self.assertEqual(test_report["valid_videos_count"], 1)
            self.assertTrue(test_report["video_checks"][0]["exists"])
            self.assertEqual(test_report["status"], "passed")

            # Đảm bảo task vẫn ở trạng thái pending, không hề bị thay đổi sang running/success
            task = database.get_task(task_id)
            self.assertEqual(task["status"], "pending")

        finally:
            if os.path.exists(temp_vid_path):
                try:
                    os.remove(temp_vid_path)
                except Exception:
                    pass

    def test_task_runner_stop_mechanism(self):
        """Kiểm tra cơ chế dừng khẩn cấp TaskRunner."""
        runner = MetaTaskRunner()
        self.assertFalse(runner.is_running)
        
        # Test stop khi không chạy
        reset_count = runner.stop()
        self.assertEqual(reset_count, 0)
        self.assertFalse(runner.is_running)


if __name__ == "__main__":
    unittest.main()
