import unittest
import os
import sys
import tempfile
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from meta_crypto import encrypt_token, decrypt_token
import database
import main

class TestAPIEndpoints(unittest.TestCase):
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

    def test_meta_accounts_api_flow(self):
        # 1. Tạo 2 tài khoản qua DB
        acc1 = database.save_facebook_account("uid_1", "Admin One", encrypt_token("tok_1"))
        acc2 = database.save_facebook_account("uid_2", "Admin Two", encrypt_token("tok_2"))

        # Gán pages
        database.upsert_facebook_page_and_relation(acc1["id"], "page_1", "Page 1", encrypt_token("p1"), "[]", 1)
        database.upsert_facebook_page_and_relation(acc2["id"], "page_2", "Page 2", encrypt_token("p2"), "[]", 1)

        # Test GET /api/meta/accounts
        accounts = main.list_meta_accounts_endpoint()
        self.assertEqual(len(accounts), 2)

        # Test GET /api/meta/accounts/{id}
        single = main.get_meta_account_endpoint(acc1["id"])
        self.assertEqual(single["user_name"], "Admin One")

        # Test GET /api/pages?account_ids=acc1["id"]
        filtered_pages = main.list_pages_endpoint(account_ids=acc1["id"])
        self.assertEqual(len(filtered_pages), 1)
        self.assertEqual(filtered_pages[0]["facebook_page_id"], "page_1")

        # Test GET /api/pages?account_ids=acc1,acc2
        both_pages = main.list_pages_endpoint(account_ids=f"{acc1['id']},{acc2['id']}")
        self.assertEqual(len(both_pages), 2)

        # Test POST /api/pages/bulk-select with account_ids
        bulk_res = main.bulk_select_pages_endpoint(main.PageBulkSelectReq(is_selected=False, account_ids=[acc1["id"]]))
        self.assertTrue(bulk_res["status"] == "success")

        # Test GET /api/status includes accounts
        status = main.get_status_endpoint()
        self.assertIn("accounts", status)
        self.assertEqual(status["connected_accounts"], 2)

        # Test POST /api/meta/accounts/{id}/disconnect
        disc_res = main.disconnect_meta_account_endpoint(acc1["id"])
        self.assertEqual(disc_res["status"], "success")
        self.assertEqual(database.get_facebook_account_by_id(acc1["id"])["status"], "disconnected")

        # Test DELETE /api/meta/accounts/{id}
        del_res = main.delete_meta_account_endpoint(acc1["id"])
        self.assertEqual(del_res["status"], "success")
        self.assertIsNone(database.get_facebook_account_by_id(acc1["id"]))

if __name__ == "__main__":
    unittest.main()
