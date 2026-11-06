import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database
from gemlogin_service import GemLoginService
from caption_service import CaptionService


class TestGemLoginIntegration(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        database.init_db()

    def test_01_add_and_get_profile(self):
        p = database.add_profile(
            profile_id="29",
            name="Movie Haven",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36",
            screen_resolution="1920x1080"
        )
        self.assertEqual(p["id"], "29")
        self.assertEqual(p["name"], "Movie Haven")
        self.assertEqual(p["user_agent"], "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36")
        self.assertEqual(p["screen_resolution"], "1920x1080")

        fetched = database.get_profile("29")
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched["name"], "Movie Haven")

    def test_02_gemlogin_service_read_profiles(self):
        svc = GemLoginService()
        status = svc.check_api_status()
        self.assertIn("online", status)
        self.assertIn("port", status)

        profs = svc.get_gemlogin_profiles()
        self.assertIsInstance(profs, list)
        if profs:
            first = profs[0]
            self.assertIn("name", first)

    def test_03_profile_update_and_delete(self):
        p = database.add_profile(
            profile_id="99",
            name="Test Page 99",
            screen_resolution="1366x768"
        )
        self.assertEqual(p["id"], "99")

        # Update
        success = database.update_profile(
            profile_id="99",
            name="Test Page 99 Updated",
            screen_resolution="1920x1080"
        )
        self.assertTrue(success)
        updated = database.get_profile("99")
        self.assertEqual(updated["name"], "Test Page 99 Updated")
        self.assertEqual(updated["screen_resolution"], "1920x1080")

        # Delete
        del_success = database.delete_profile("99")
        self.assertTrue(del_success)
        self.assertIsNone(database.get_profile("99"))


if __name__ == "__main__":
    unittest.main()
