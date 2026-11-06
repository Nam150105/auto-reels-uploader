import unittest
import os
import sys
import tempfile
import json
import time
from unittest.mock import patch, MagicMock

# Đảm bảo đường dẫn import đúng module gốc
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from meta_crypto import encrypt_token, decrypt_token, mask_token
import database
import meta_oauth_service
from meta_graph_service import MetaGraphService
from meta_runner import MetaTestRunner, MetaTaskRunner


class TestMultiAccountIntegration(unittest.TestCase):
    """
    Bộ kiểm thử tích hợp 14 trường hợp bắt buộc đối với hệ thống
    kết nối nhiều tài khoản Facebook Admin (Multi-Account OAuth)
    và tổng hợp Fanpage Nhiều - Nhiều (Many-to-Many).
    """

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

    # -------------------------------------------------------------
    # 1. KẾT NỐI ADMIN A
    # -------------------------------------------------------------
    def test_01_connect_admin_a(self):
        acc_a = database.save_facebook_account(
            user_id="uid_admin_a",
            user_name="Nguyen Van Admin A",
            encrypted_token=encrypt_token("token_user_a"),
            token_expires_at="2027-01-01 00:00:00",
            scopes="pages_show_list,pages_manage_posts,publish_video"
        )
        self.assertIsNotNone(acc_a)
        self.assertEqual(acc_a["user_id"], "uid_admin_a")
        self.assertEqual(acc_a["user_name"], "Nguyen Van Admin A")
        self.assertEqual(acc_a["status"], "connected")
        
        accounts = database.get_facebook_accounts()
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["user_id"], "uid_admin_a")

    # -------------------------------------------------------------
    # 2. LẤY FANPAGE CỦA ADMIN A
    # -------------------------------------------------------------
    def test_02_sync_pages_of_admin_a(self):
        acc_a = database.save_facebook_account(
            user_id="uid_admin_a",
            user_name="Admin A",
            encrypted_token=encrypt_token("token_user_a")
        )
        
        # Giả lập phản hồi từ Meta Graph API /me/accounts của Admin A (2 pages)
        mock_response_data = {
            "data": [
                {
                    "id": "page_101",
                    "name": "Page A1 - Giai Tri",
                    "category": "Entertainment",
                    "access_token": "page_token_101_from_a",
                    "tasks": ["CREATE_CONTENT", "MANAGE"]
                },
                {
                    "id": "page_102",
                    "name": "Page A2 - Am Thuc",
                    "category": "Food",
                    "access_token": "page_token_102_from_a",
                    "tasks": ["CREATE_CONTENT"]
                }
            ],
            "paging": {}
        }

        with patch("requests.get") as mock_get:
            mock_resp = MagicMock()
            mock_resp.json.return_value = mock_response_data
            mock_get.return_value = mock_resp

            res = MetaGraphService.sync_pages(account_id=acc_a["id"])

        self.assertEqual(res["status"], "success")
        self.assertEqual(res["unique_pages_count"], 2)

        pages_a = database.get_facebook_pages(account_ids=[acc_a["id"]])
        self.assertEqual(len(pages_a), 2)
        page_ids = [p["facebook_page_id"] for p in pages_a]
        self.assertIn("page_101", page_ids)
        self.assertIn("page_102", page_ids)

    # -------------------------------------------------------------
    # 3. KẾT NỐI THÊM ADMIN B (KHÔNG GHI ĐÈ ADMIN A)
    # -------------------------------------------------------------
    def test_03_connect_admin_b_without_overwriting_admin_a(self):
        # Kết nối Admin A
        acc_a = database.save_facebook_account(
            user_id="uid_admin_a",
            user_name="Admin A",
            encrypted_token=encrypt_token("token_a")
        )

        # Kết nối tiếp Admin B
        acc_b = database.save_facebook_account(
            user_id="uid_admin_b",
            user_name="Tran Thi Admin B",
            encrypted_token=encrypt_token("token_b"),
            token_expires_at="2027-02-01 00:00:00"
        )

        # Kiểm tra cả 2 tài khoản đều tồn tại và đang kết nối song song
        accounts = database.get_facebook_accounts()
        self.assertEqual(len(accounts), 2)
        
        user_ids = [acc["user_id"] for acc in accounts]
        self.assertIn("uid_admin_a", user_ids)
        self.assertIn("uid_admin_b", user_ids)
        self.assertTrue(all(acc["status"] == "connected" for acc in accounts))

    # -------------------------------------------------------------
    # 4. LẤY FANPAGE CỦA ADMIN B
    # -------------------------------------------------------------
    def test_04_sync_pages_of_admin_b(self):
        acc_b = database.save_facebook_account(
            user_id="uid_admin_b",
            user_name="Admin B",
            encrypted_token=encrypt_token("token_b")
        )

        mock_data_b = {
            "data": [
                {
                    "id": "page_201",
                    "name": "Page B1 - Tin Tuc",
                    "category": "News",
                    "access_token": "page_token_201_from_b",
                    "tasks": ["CREATE_CONTENT", "MANAGE"]
                }
            ],
            "paging": {}
        }

        with patch("requests.get") as mock_get:
            mock_resp = MagicMock()
            mock_resp.json.return_value = mock_data_b
            mock_get.return_value = mock_resp

            res = MetaGraphService.sync_pages(account_id=acc_b["id"])

        self.assertEqual(res["status"], "success")
        pages_b = database.get_facebook_pages(account_ids=[acc_b["id"]])
        self.assertEqual(len(pages_b), 1)
        self.assertEqual(pages_b[0]["facebook_page_id"], "page_201")

    # -------------------------------------------------------------
    # 5. CHỌN TẤT CẢ ADMIN (TỔNG HỢP TOÀN BỘ PAGE)
    # -------------------------------------------------------------
    def test_05_select_all_admins_combined_pages(self):
        acc_a = database.save_facebook_account("uid_a", "Admin A", encrypt_token("tok_a"))
        acc_b = database.save_facebook_account("uid_b", "Admin B", encrypt_token("tok_b"))

        # Gán Page 1 cho A, Page 2 cho B
        database.upsert_facebook_page_and_relation(acc_a["id"], "page_1", "Page One", encrypt_token("p1"), "[]", 1)
        database.upsert_facebook_page_and_relation(acc_b["id"], "page_2", "Page Two", encrypt_token("p2"), "[]", 1)

        # Lấy tất cả (account_ids = None hoặc [acc_a, acc_b])
        all_pages = database.get_facebook_pages()
        self.assertEqual(len(all_pages), 2)
        
        selected_all_pages = database.get_facebook_pages(account_ids=[acc_a["id"], acc_b["id"]])
        self.assertEqual(len(selected_all_pages), 2)

    # -------------------------------------------------------------
    # 6. CHỈ CHỌN ADMIN A
    # -------------------------------------------------------------
    def test_06_filter_only_admin_a(self):
        acc_a = database.save_facebook_account("uid_a", "Admin A", encrypt_token("tok_a"))
        acc_b = database.save_facebook_account("uid_b", "Admin B", encrypt_token("tok_b"))

        database.upsert_facebook_page_and_relation(acc_a["id"], "page_a_only", "Page A Only", encrypt_token("pa"), "[]", 1)
        database.upsert_facebook_page_and_relation(acc_b["id"], "page_b_only", "Page B Only", encrypt_token("pb"), "[]", 1)

        # Lọc chỉ theo Admin A
        pages_only_a = database.get_facebook_pages(account_ids=[acc_a["id"]])
        self.assertEqual(len(pages_only_a), 1)
        self.assertEqual(pages_only_a[0]["facebook_page_id"], "page_a_only")

    # -------------------------------------------------------------
    # 7. CHỌN A VÀ B (GỘP DANH SÁCH & KHỬ TRÙNG LẶP)
    # -------------------------------------------------------------
    def test_07_filter_admin_a_and_admin_b_merged(self):
        acc_a = database.save_facebook_account("uid_a", "Admin A", encrypt_token("tok_a"))
        acc_b = database.save_facebook_account("uid_b", "Admin B", encrypt_token("tok_b"))
        acc_c = database.save_facebook_account("uid_c", "Admin C", encrypt_token("tok_c"))

        database.upsert_facebook_page_and_relation(acc_a["id"], "page_a", "Page A", encrypt_token("pa"), "[]", 1)
        database.upsert_facebook_page_and_relation(acc_b["id"], "page_b", "Page B", encrypt_token("pb"), "[]", 1)
        database.upsert_facebook_page_and_relation(acc_c["id"], "page_c", "Page C", encrypt_token("pc"), "[]", 1)

        # Lọc [A, B] -> Chỉ ra Page A và Page B, không ra Page C
        merged_pages = database.get_facebook_pages(account_ids=[acc_a["id"], acc_b["id"]])
        self.assertEqual(len(merged_pages), 2)
        page_ids = [p["facebook_page_id"] for p in merged_pages]
        self.assertIn("page_a", page_ids)
        self.assertIn("page_b", page_ids)
        self.assertNotIn("page_c", page_ids)

    # -------------------------------------------------------------
    # 8. HAI ADMIN CÙNG QUẢN LÝ MỘT FANPAGE (MANY-TO-MANY & DEDUPLICATION)
    # -------------------------------------------------------------
    def test_08_two_admins_manage_same_page(self):
        acc_a = database.save_facebook_account("uid_a", "Admin A", encrypt_token("tok_a"))
        acc_b = database.save_facebook_account("uid_b", "Admin B", encrypt_token("tok_b"))

        shared_page_id = "shared_page_999"

        # Admin A đồng bộ Page chung
        database.upsert_facebook_page_and_relation(
            account_id=acc_a["id"],
            facebook_page_id=shared_page_id,
            name="Cong Dong Phim Chung",
            encrypted_page_access_token=encrypt_token("token_page_from_admin_a"),
            tasks_json=json.dumps(["CREATE_CONTENT", "MANAGE"]),
            can_post=1
        )

        # Admin B cũng đồng bộ Page chung này
        database.upsert_facebook_page_and_relation(
            account_id=acc_b["id"],
            facebook_page_id=shared_page_id,
            name="Cong Dong Phim Chung (Ten Cap Nhat)",
            encrypted_page_access_token=encrypt_token("token_page_from_admin_b"),
            tasks_json=json.dumps(["CREATE_CONTENT"]),
            can_post=1
        )

        # Kiểm tra 1: Bảng facebook_pages chỉ có duy nhất 1 bản ghi cho page_id này (Không trùng)
        all_pages = database.get_facebook_pages()
        self.assertEqual(len(all_pages), 1)
        self.assertEqual(all_pages[0]["facebook_page_id"], shared_page_id)

        # Kiểm tra 2: Cả 2 Admin đều được liên kết với Page này
        admin_names = all_pages[0]["admin_names"]
        self.assertIn("Admin A", admin_names)
        self.assertIn("Admin B", admin_names)

        # Kiểm tra 3: Lọc theo Admin A vẫn thấy, lọc theo Admin B vẫn thấy, lọc cả 2 chỉ ra 1 dòng
        self.assertEqual(len(database.get_facebook_pages(account_ids=[acc_a["id"]])), 1)
        self.assertEqual(len(database.get_facebook_pages(account_ids=[acc_b["id"]])), 1)
        self.assertEqual(len(database.get_facebook_pages(account_ids=[acc_a["id"], acc_b["id"]])), 1)

    # -------------------------------------------------------------
    # 9. NGẮT KẾT NỐI ADMIN A NHƯNG ADMIN B VẪN CÒN QUYỀN TRÊN PAGE CHUNG
    # -------------------------------------------------------------
    def test_09_disconnect_admin_a_keeps_page_alive_for_admin_b(self):
        acc_a = database.save_facebook_account("uid_a", "Admin A", encrypt_token("tok_a"))
        acc_b = database.save_facebook_account("uid_b", "Admin B", encrypt_token("tok_b"))

        shared_pid = "shared_page_777"
        database.upsert_facebook_page_and_relation(acc_a["id"], shared_pid, "Page Song Song", encrypt_token("tok_a_page"), "[]", 1)
        database.upsert_facebook_page_and_relation(acc_b["id"], shared_pid, "Page Song Song", encrypt_token("tok_b_page"), "[]", 1)

        # Ngắt kết nối Admin A
        database.disconnect_facebook_account(acc_a["id"])

        # Kiểm tra: Admin A đã bị disconnected
        acc_a_after = database.get_facebook_account_by_id(acc_a["id"])
        self.assertEqual(acc_a_after["status"], "disconnected")

        # Kiểm tra: Page Song Song KHÔNG BỊ XÓA vì Admin B vẫn còn kết nối và có quyền!
        page_after = database.get_facebook_page_by_fb_id(shared_pid)
        self.assertIsNotNone(page_after)
        self.assertEqual(page_after["can_post"], 1)
        self.assertEqual(page_after["status"], "connected")

        # Token của Page được đảm bảo chuyển sang token của Admin B
        active_token_enc = database.get_page_active_token(shared_pid)
        self.assertEqual(decrypt_token(active_token_enc), "tok_b_page")

    # -------------------------------------------------------------
    # 10. TOKEN HẾT HẠN HOẶC BỊ THU HỒI
    # -------------------------------------------------------------
    def test_10_token_expired_or_revoked_handling(self):
        acc = database.save_facebook_account(
            user_id="uid_exp",
            user_name="Admin Expired",
            encrypted_token=encrypt_token("invalid_token"),
            token_expires_at="2020-01-01 00:00:00"  # Đã hết hạn trong quá khứ
        )

        # Lấy danh sách account: tính toán trạng thái expired
        accounts = database.get_facebook_accounts()
        self.assertEqual(accounts[0]["status"], "expired")
        self.assertLess(accounts[0]["days_remaining"], 0)

        # Giả lập Graph API báo lỗi 190 (Token revoked / expired)
        with patch("requests.get") as mock_get:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {
                "error": {
                    "message": "Error validating access token: Session has expired.",
                    "code": 190,
                    "type": "OAuthException"
                }
            }
            mock_get.return_value = mock_resp

            res = MetaGraphService.sync_pages(account_id=acc["id"])

        self.assertEqual(res["status"], "error")
        # Kiểm tra trạng thái tài khoản trong DB đã chuyển sang expired
        acc_db = database.get_facebook_account_by_id(acc["id"])
        self.assertEqual(acc_db["status"], "expired")

    # -------------------------------------------------------------
    # 11. NGƯỜI DÙNG TỪ CHỐI CẤP QUYỀN OAUTH
    # -------------------------------------------------------------
    def test_11_user_denies_oauth_permission(self):
        import main
        # Gọi endpoint callback với error="access_denied"
        response = main.meta_oauth_callback_endpoint(
            error="access_denied",
            error_description="Permissions were not granted."
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Kết nối Facebook Thất Bại", response.body.decode("utf-8"))
        self.assertIn("Permissions were not granted", response.body.decode("utf-8"))

    # -------------------------------------------------------------
    # 12. OAUTH CALLBACK CÓ STATE KHÔNG HỢP LỆ (CHỐNG CSRF)
    # -------------------------------------------------------------
    def test_12_oauth_callback_invalid_csrf_state(self):
        # State giả mạo không tồn tại
        res = meta_oauth_service.exchange_code_for_token(code="fake_code_123", state="tampered_csrf_state")
        self.assertEqual(res["status"], "error")
        self.assertIn("CSRF State không hợp lệ", res["message"])

    # -------------------------------------------------------------
    # 13. API PHÂN TRANG FANPAGE (PAGING.NEXT)
    # -------------------------------------------------------------
    def test_13_fanpage_pagination_loop(self):
        acc = database.save_facebook_account("uid_pag", "Admin Paging", encrypt_token("tok_p"))

        page_1_data = {
            "data": [
                {"id": f"page_batch1_{i}", "name": f"Page 1-{i}", "access_token": "tok", "tasks": ["CREATE_CONTENT"]}
                for i in range(5)
            ],
            "paging": {
                "next": "https://graph.facebook.com/v19.0/me/accounts?after=cursor_123"
            }
        }

        page_2_data = {
            "data": [
                {"id": f"page_batch2_{i}", "name": f"Page 2-{i}", "access_token": "tok", "tasks": ["CREATE_CONTENT"]}
                for i in range(5)
            ],
            "paging": {}  # Hết trang tiếp theo
        }

        with patch("requests.get") as mock_get:
            resp1 = MagicMock()
            resp1.json.return_value = page_1_data
            resp2 = MagicMock()
            resp2.json.return_value = page_2_data
            mock_get.side_effect = [resp1, resp2]

            res = MetaGraphService.sync_pages(account_id=acc["id"])

        self.assertEqual(res["status"], "success")
        self.assertEqual(res["unique_pages_count"], 10)

        # Đảm bảo lưu trọn vẹn cả 10 pages không bỏ sót trang nào
        all_pages = database.get_facebook_pages(account_ids=[acc["id"]])
        self.assertEqual(len(all_pages), 10)

    # -------------------------------------------------------------
    # 14. TÀI KHOẢN KHÔNG CÓ QUYỀN QUẢN LÝ PAGE (EMPTY RESULT DIAGNOSTIC)
    # -------------------------------------------------------------
    def test_14_account_with_zero_pages_diagnostic(self):
        acc = database.save_facebook_account("uid_zero", "Admin No Pages", encrypt_token("tok_z"))

        # Phản hồi mảng data rỗng từ Graph API
        with patch("requests.get") as mock_get:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {"data": [], "paging": {}}
            mock_get.return_value = mock_resp

            res = MetaGraphService.sync_pages(account_id=acc["id"])

        # Hệ thống xử lý mượt mà, trả về chẩn đoán rõ ràng, không crash và không bịa dữ liệu ảo
        self.assertEqual(res["status"], "empty")
        self.assertEqual(res["synced_count"], 0)
        self.assertIn("Meta trả về danh sách Fanpage rỗng", res["message"])


if __name__ == "__main__":
    unittest.main()

