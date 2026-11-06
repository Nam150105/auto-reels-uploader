import unittest
import os
import sys
import tempfile
import json
import asyncio
from starlette.requests import Request

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from meta_crypto import encrypt_token, decrypt_token
import database
import main
from meta_oauth_service import generate_oauth_url

class TestAuthAndPublicPages(unittest.TestCase):
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

    def _create_mock_request(self, token: str = None, host: str = "namnangno.click", proto: str = "https"):
        headers = [
            (b"host", host.encode("utf-8")),
            (b"x-forwarded-proto", proto.encode("utf-8")),
            (b"x-forwarded-host", host.encode("utf-8")),
        ]
        if token:
            headers.append((b"cookie", f"session_token={token}".encode("utf-8")))
        scope = {
            "type": "http",
            "method": "GET",
            "headers": headers,
        }
        return Request(scope)

    def test_01_default_admin_created(self):
        """Đảm bảo tài khoản admin mặc định được tạo tự động với mật khẩu admin123."""
        admin = database.ensure_default_admin()
        self.assertIsNotNone(admin)
        self.assertEqual(admin["username"], "admin")
        self.assertEqual(admin["role"], "admin")

        # Kiểm tra đăng nhập với thông tin đúng
        verified = database.verify_user_credentials("admin", "admin123")
        self.assertIsNotNone(verified)
        self.assertEqual(verified["username"], "admin")

        # Kiểm tra mật khẩu sai
        wrong = database.verify_user_credentials("admin", "wrongpassword")
        self.assertIsNone(wrong)

    def test_02_user_registration_and_login_flow(self):
        """Kiểm tra tạo người dùng mới, kiểm tra trùng lặp và tạo token phiên."""
        u1 = database.create_user("user_a", "password_123", full_name="User Alpha", email="a@example.com")
        self.assertEqual(u1["username"], "user_a")
        self.assertEqual(u1["role"], "user")

        # Đăng ký trùng tên đăng nhập phải báo lỗi
        with self.assertRaises(ValueError):
            database.create_user("user_a", "other_pwd")

        # Đăng nhập thành công
        auth_u1 = database.verify_user_credentials("user_a", "password_123")
        self.assertIsNotNone(auth_u1)

        # Tạo và kiểm tra session token
        token = database.generate_session_token(u1["id"])
        verified_uid = database.verify_session_token(token)
        self.assertEqual(verified_uid, u1["id"])

        # Token giả / bị can thiệp
        tampered_token = token[:-4] + "ffff"
        self.assertIsNone(database.verify_session_token(tampered_token))

        # Token hết hạn
        expired_token = database.generate_session_token(u1["id"], expire_seconds=-10)
        self.assertIsNone(database.verify_session_token(expired_token))

    def test_03_auth_api_endpoints(self):
        """Kiểm tra các endpoint /api/auth/register, /api/auth/login, /api/auth/me, /api/auth/logout."""
        # 1. Đăng ký qua API
        reg_payload = main.RegisterReq(username="newbie", password="secure_pass123", full_name="Newbie User", email="newbie@example.com")
        reg_resp = main.auth_register_endpoint(reg_payload)
        reg_data = json.loads(reg_resp.body.decode("utf-8")) if hasattr(reg_resp, "body") else reg_resp
        self.assertIn("user", reg_data)
        self.assertEqual(reg_data["user"]["username"], "newbie")
        self.assertIn("token", reg_data)
        user_id = reg_data["user"]["id"]
        token = reg_data["token"]

        # 2. Đăng nhập qua API
        login_payload = main.LoginReq(username="newbie", password="secure_pass123")
        login_resp = main.auth_login_endpoint(login_payload)
        login_data = json.loads(login_resp.body.decode("utf-8")) if hasattr(login_resp, "body") else login_resp
        self.assertEqual(login_data["status"], "success")
        self.assertEqual(login_data["user"]["username"], "newbie")

        # Đăng nhập sai mật khẩu -> 401
        with self.assertRaises(main.HTTPException) as cm:
            main.auth_login_endpoint(main.LoginReq(username="newbie", password="wrong_pass"))
        self.assertEqual(cm.exception.status_code, 401)

        # 3. Lấy thông tin user hiện tại qua /api/auth/me với cookie
        req = self._create_mock_request(token=token)
        me_resp = main.auth_me_endpoint(req)
        self.assertEqual(me_resp["user"]["username"], "newbie")

        # 4. /api/auth/me không có token -> 401
        unauth_req = self._create_mock_request(token=None)
        with self.assertRaises(main.HTTPException) as cm2:
            main.auth_me_endpoint(unauth_req)
        self.assertEqual(cm2.exception.status_code, 401)

        # 5. Đăng xuất
        logout_resp = main.auth_logout_endpoint()
        logout_data = json.loads(logout_resp.body.decode("utf-8")) if hasattr(logout_resp, "body") else logout_resp
        self.assertEqual(logout_data["status"], "success")

    def test_04_multi_user_data_isolation(self):
        """Kiểm tra tính độc lập dữ liệu giữa các User và quyền xem tổng quan của Admin."""
        # Tạo 2 user thường và 1 admin
        u_a = database.create_user("alice", "pass123", full_name="Alice")
        u_b = database.create_user("bob", "pass123", full_name="Bob")
        u_adm = database.ensure_default_admin()

        token_a = database.generate_session_token(u_a["id"])
        token_b = database.generate_session_token(u_b["id"])
        token_adm = database.generate_session_token(u_adm["id"])

        req_a = self._create_mock_request(token=token_a)
        req_b = self._create_mock_request(token=token_b)
        req_adm = self._create_mock_request(token=token_adm)

        # Alice kết nối FB account và tạo page
        acc_a = database.save_facebook_account("fb_alice_id", "Alice FB", encrypt_token("tok_a"), owner_user_id=u_a["id"])
        database.upsert_facebook_page_and_relation(acc_a["id"], "page_a", "Alice Page", encrypt_token("p_a"), "[]", 1)

        # Alice tạo task
        task_a_id = database.add_task(
            facebook_page_id="page_a",
            video_path="C:\\videos\\sample_a.mp4",
            caption="Alice video",
            owner_user_id=u_a["id"]
        )

        # Bob kết nối FB account và tạo task
        acc_b = database.save_facebook_account("fb_bob_id", "Bob FB", encrypt_token("tok_b"), owner_user_id=u_b["id"])
        database.upsert_facebook_page_and_relation(acc_b["id"], "page_b", "Bob Page", encrypt_token("p_b"), "[]", 1)
        task_b_id = database.add_task(
            facebook_page_id="page_b",
            video_path="C:\\videos\\sample_b.mp4",
            caption="Bob video",
            owner_user_id=u_b["id"]
        )

        # 1. Bob kiểm tra tài khoản FB -> CHỈ thấy tài khoản của Bob
        b_accounts = main.list_meta_accounts_endpoint(request=req_b)
        self.assertEqual(len(b_accounts), 1)
        self.assertEqual(b_accounts[0]["user_name"], "Bob FB")

        # 2. Bob kiểm tra Pages -> CHỈ thấy page của Bob
        b_pages = main.list_pages_endpoint(request=req_b)
        self.assertEqual(len(b_pages), 1)
        self.assertEqual(b_pages[0]["name"], "Bob Page")

        # 3. Bob kiểm tra Tasks -> CHỈ thấy task của Bob
        b_tasks = main.list_tasks_endpoint(request=req_b)
        self.assertEqual(len(b_tasks), 1)
        self.assertEqual(b_tasks[0]["caption"], "Bob video")

        # 4. Alice kiểm tra tài khoản FB -> CHỈ thấy tài khoản của Alice
        a_accounts = main.list_meta_accounts_endpoint(request=req_a)
        self.assertEqual(len(a_accounts), 1)
        self.assertEqual(a_accounts[0]["user_name"], "Alice FB")

        # 5. Admin kiểm tra -> Thấy toàn bộ 2 tài khoản, 2 pages, 2 tasks
        adm_accounts = main.list_meta_accounts_endpoint(request=req_adm)
        self.assertEqual(len(adm_accounts), 2)
        adm_pages = main.list_pages_endpoint(request=req_adm)
        self.assertEqual(len(adm_pages), 2)
        adm_tasks = main.list_tasks_endpoint(request=req_adm)
        self.assertEqual(len(adm_tasks), 2)

    def test_05_public_meta_pages_and_crawlers(self):
        """Kiểm tra các trang chính sách công khai đạt chuẩn Meta Platform (HTTP 200 không yêu cầu đăng nhập)."""
        # Privacy policy
        priv_resp = main.serve_privacy_page()
        self.assertEqual(priv_resp.status_code, 200)
        priv_html = priv_resp.body.decode("utf-8")
        self.assertIn("1469615908436980", priv_html)
        self.assertIn("Quản lý fanpage", priv_html)

        # Terms of service
        terms_resp = main.serve_terms_page()
        self.assertEqual(terms_resp.status_code, 200)
        terms_html = terms_resp.body.decode("utf-8")
        self.assertIn("Quản lý fanpage", terms_html)

        # Data deletion page
        del_page_resp = main.serve_data_deletion_page()
        self.assertEqual(del_page_resp.status_code, 200)
        del_html = del_page_resp.body.decode("utf-8")
        self.assertIn("Hướng Dẫn Xóa Dữ Liệu", del_html)

        # Data deletion callback API (Meta Platform compliant)
        callback_resp = main.meta_data_deletion_callback()
        self.assertEqual(callback_resp.status_code, 200)
        callback_data = json.loads(callback_resp.body.decode("utf-8"))
        self.assertIn("url", callback_data)
        self.assertIn("confirmation_code", callback_data)
        self.assertTrue(callback_data["confirmation_code"].startswith("DEL_"))

        # Data deletion status page
        status_resp = main.data_deletion_status_endpoint(code="DEL_TEST_123")
        self.assertEqual(status_resp.status_code, 200)
        self.assertIn("DEL_TEST_123", status_resp.body.decode("utf-8"))

    def test_06_meta_oauth_url_and_cloudflare_tunnel(self):
        """Kiểm tra URL OAuth được sinh đúng chuẩn với App ID và Cloudflare Tunnel Domain."""
        res = generate_oauth_url(user_id="usr_test_123", auth_type="rerequest")
        self.assertEqual(res["status"], "success")
        oauth_url = res["oauth_url"]

        self.assertIn("client_id=1469615908436980", oauth_url)
        self.assertTrue(
            "redirect_uri=https://pagefb.namnangno.click/api/meta/callback" in oauth_url or
            "redirect_uri=https://namnangno.click/api/meta/callback" in oauth_url
        )
        self.assertIn("auth_type=rerequest", oauth_url)
        self.assertIn("public_profile", oauth_url)
        self.assertIn("pages_show_list", oauth_url)
        self.assertIn("pages_manage_posts", oauth_url)

if __name__ == "__main__":
    unittest.main()
