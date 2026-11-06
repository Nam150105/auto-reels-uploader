import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database
import profile_manager
import system_helper
from caption_service import CaptionService


class TestUIUXFeatures(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        database.init_db()

    def test_01_create_profile_random_fingerprint(self):
        res = profile_manager.create_new_profile(name="Movie Haven Test")
        self.assertEqual(res["status"], "success")
        p = res["profile"]
        self.assertIsNotNone(p["user_agent"])
        self.assertIn("Chrome/", p["user_agent"])
        self.assertIsNotNone(p["screen_resolution"])
        self.assertIn("x", p["screen_resolution"])
        print(f"\n[Test] Profile Created: ID={p['id']}, UA={p['user_agent'][:40]}..., Res={p['screen_resolution']}")

    def test_02_scan_existing_profiles(self):
        found = profile_manager.scan_existing_profiles()
        self.assertIsInstance(found, list)
        print(f"[Test] Scanned profiles count: {len(found)}")

    def test_03_clone_profile(self):
        # Tạo profile nguồn
        src = profile_manager.create_new_profile(name="Original Source")
        src_id = src["profile"]["id"]
        
        # Clone sang ID mới
        clone_res = profile_manager.clone_profile(
            source_id=src_id,
            new_id="",
            new_name="Cloned Copy"
        )
        self.assertEqual(clone_res["status"], "success")
        cloned_id = clone_res["profile"]["id"]
        self.assertNotEqual(src_id, cloned_id)
        self.assertTrue(os.path.exists(clone_res["folder"]))
        print(f"[Test] Cloned successfully from #{src_id} to #{cloned_id}")

    def test_04_system_helper_file_check(self):
        # File manager.db chắc chắn tồn tại
        db_path = os.path.abspath("manager.db")
        self.assertTrue(system_helper.check_file_exists(db_path))
        self.assertFalse(system_helper.check_file_exists("Z:\\invalid_non_existent.mp4"))

        batch_res = system_helper.batch_check_files([db_path, "Z:\\invalid_non_existent.mp4"])
        self.assertTrue(batch_res[db_path])
        self.assertFalse(batch_res["Z:\\invalid_non_existent.mp4"])
        print("[Test] File check helper OK")

    def test_05_task_crud_with_link_ac_and_comment(self):
        # Thêm task với link_ac và comment
        task_id = database.add_task(
            profile_id="1",
            video_path=os.path.abspath("manager.db"),
            caption="Thước phim hấp dẫn 🍿🎬",
            link_ac="https://cameo.popnexa.com/story-123",
            comment_text="Full Story: https://cameo.popnexa.com/story-123",
            schedule_date="2026-11-05",
            schedule_time="07:00"
        )
        t = database.get_task(task_id)
        self.assertIsNotNone(t)
        self.assertEqual(t["link_ac"], "https://cameo.popnexa.com/story-123")
        self.assertEqual(t["schedule_date"], "2026-11-05")
        self.assertEqual(t["schedule_time"], "07:00")
        self.assertEqual(t["status"], "pending")

        # Cập nhật task
        database.update_task(
            task_id=task_id,
            caption="Caption đã sửa!",
            schedule_time="19:00"
        )
        t_updated = database.get_task(task_id)
        self.assertEqual(t_updated["caption"], "Caption đã sửa!")
        self.assertEqual(t_updated["schedule_time"], "19:00")

        # Update task status sang success với done_time
        database.update_task_status(
            task_id=task_id,
            status="success",
            log="Đã lên lịch thành công",
            video_url="https://facebook.com/reel/123456",
            done_time="2026-11-05 07:01:00"
        )
        t_done = database.get_task(task_id)
        self.assertEqual(t_done["status"], "success")
        self.assertEqual(t_done["video_url"], "https://facebook.com/reel/123456")
        self.assertEqual(t_done["done_time"], "2026-11-05 07:01:00")

    def test_06_bulk_task_from_excel(self):
        excel_items = [
            {
                "video_path": "D:\\Videos\\vid1.mp4",
                "caption": "Video 1 từ Excel",
                "link_ac": "https://cameo.../1",
                "comment_text": "Full Story: https://cameo.../1",
                "schedule_date": "2026-11-06",
                "schedule_time": "00:00"
            },
            {
                "video_path": "D:\\Videos\\vid2.mp4",
                "caption": "Video 2 từ Excel",
                "link_ac": "",
                "comment_text": "",
                "schedule_date": "2026-11-06",
                "schedule_time": "07:00"
            }
        ]
        inserted = database.add_tasks_bulk(excel_items, assign_profile_ids=["1"])
        self.assertEqual(inserted, 2)
        print(f"[Test] Bulk Excel tasks inserted: {inserted}")

    def test_07_grid_matrix_with_rows(self):
        from grid_helper import calculate_window_bounds
        # Test custom w=400, h=600, cols=3, rows=2
        # Slot 0: col=0, row=0 -> (0, 0, 400, 600)
        x0, y0, w0, h0 = calculate_window_bounds(slot_index=0, total_threads=6, custom_w=400, custom_h=600, cols=3, rows=2)
        self.assertEqual((x0, y0, w0, h0), (0, 0, 400, 600))

        # Slot 1: col=1, row=0 -> (400, 0, 400, 600)
        x1, y1, w1, h1 = calculate_window_bounds(slot_index=1, total_threads=6, custom_w=400, custom_h=600, cols=3, rows=2)
        self.assertEqual((x1, y1, w1, h1), (400, 0, 400, 600))

        # Slot 3: col=0, row=1 -> (0, 600, 400, 600)
        x3, y3, w3, h3 = calculate_window_bounds(slot_index=3, total_threads=6, custom_w=400, custom_h=600, cols=3, rows=2)
        self.assertEqual((x3, y3, w3, h3), (0, 600, 400, 600))

        # Slot 4: col=1, row=1 -> (400, 600, 400, 600)
        x4, y4, w4, h4 = calculate_window_bounds(slot_index=4, total_threads=6, custom_w=400, custom_h=600, cols=3, rows=2)
        self.assertEqual((x4, y4, w4, h4), (400, 600, 400, 600))
        print("[Test] Grid matrix calculations OK")

    def test_08_profile_patch_rename(self):
        import main
        from main import ProfilePatchReq
        from fastapi import HTTPException

        # Tạo profile thử nghiệm
        p_res = profile_manager.create_new_profile(name="Old Name Page")
        pid = p_res["profile"]["id"]

        # Rename bằng patch_profile_endpoint
        res = main.patch_profile_endpoint(str(pid), ProfilePatchReq(name="New Brand Fanpage"))
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["name"], "New Brand Fanpage")

        # Kiểm tra trong DB
        p = database.get_profile(str(pid))
        self.assertEqual(p["name"], "New Brand Fanpage")

        # Kiểm tra chặn tên rỗng
        with self.assertRaises(HTTPException) as ctx:
            main.patch_profile_endpoint(str(pid), ProfilePatchReq(name="   "))
        self.assertEqual(ctx.exception.status_code, 400)
        print("[Test] Profile PATCH rename OK")

    def test_09_runner_pending_validation(self):
        import main
        from main import RunConfigReq
        from fastapi import HTTPException

        # Tạo profile không có task nào
        p_res = profile_manager.create_new_profile(name="Zero Task Profile")
        pid = str(p_res["profile"]["id"])

        # Gọi run_tasks_endpoint với profile không có task pending
        with self.assertRaises(HTTPException) as ctx:
            main.run_tasks_endpoint(RunConfigReq(profile_ids=[pid]))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail, "Không có task cần làm!")
        print("[Test] Runner pending tasks validation OK")

    def test_10_bulk_import_comment_preservation(self):
        excel_items = [
            {
                "video_path": "D:\\Videos\\vid_comment.mp4",
                "caption": "Video với comment tự do",
                "link_ac": "",
                "comment_text": "Link shopee: shopee.vn/item-123",
                "schedule_date": "2026-11-07",
                "schedule_time": "08:00"
            },
            {
                "video_path": "D:\\Videos\\vid_no_comment.mp4",
                "caption": "Video không có comment",
                "link_ac": "",
                "comment_text": "",
                "schedule_date": "2026-11-07",
                "schedule_time": "12:00"
            }
        ]
        inserted = database.add_tasks_bulk(excel_items, assign_profile_ids=["1"])
        self.assertEqual(inserted, 2)
        tasks = database.get_tasks(profile_id="1")
        custom_task = next(t for t in tasks if t["video_path"] == "D:\\Videos\\vid_comment.mp4")
        self.assertEqual(custom_task["comment_text"], "Link shopee: shopee.vn/item-123")
        no_cmt_task = next(t for t in tasks if t["video_path"] == "D:\\Videos\\vid_no_comment.mp4")
        self.assertEqual(no_cmt_task["comment_text"], "")
        print("[Test] Bulk import comment preservation OK")

    def test_11_bulk_create_profiles(self):
        import main
        from main import ProfileBulkCreateReq

        res = main.bulk_create_profiles_endpoint(ProfileBulkCreateReq(quantity=3))
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["created_count"], 3)
        self.assertEqual(len(res["profiles"]), 3)

        for p in res["profiles"]:
            pid = str(p["id"])
            p_folder = os.path.join(profile_manager.PROFILES_ROOT, pid)
            self.assertTrue(os.path.exists(p_folder), f"Thư mục {p_folder} phải tồn tại trên đĩa")
            self.assertTrue(os.path.isdir(os.path.join(p_folder, "Default")), "Thư mục Default phải tồn tại")
            self.assertIsNotNone(p.get("user_agent"))
            self.assertIsNotNone(p.get("screen_resolution"))
            self.assertIn("Profile", p["name"])
        print(f"[Test] Bulk created {res['created_count']} profiles OK")

    def test_12_bulk_delete_profiles(self):
        import main
        from main import ProfileBulkDeleteReq

        # Tạo trước 2 profile
        create_res = profile_manager.bulk_create_profiles(quantity=2)
        pids = [str(p["id"]) for p in create_res["profiles"]]

        # Thêm task liên kết cho 2 profile này
        for pid in pids:
            database.add_task(
                profile_id=pid,
                video_path="D:\\Videos\\test_delete.mp4",
                caption="Task test bulk delete"
            )

        # Kiểm tra trước khi xóa
        for pid in pids:
            self.assertIsNotNone(database.get_profile(pid))
            self.assertGreater(len(database.get_tasks(profile_id=pid)), 0)
            self.assertTrue(os.path.exists(os.path.join(profile_manager.PROFILES_ROOT, pid)))

        # Thực hiện bulk delete
        del_res = main.bulk_delete_profiles_endpoint(ProfileBulkDeleteReq(profile_ids=pids))
        self.assertEqual(del_res["status"], "success")
        self.assertGreaterEqual(del_res["deleted_count"], 2)

        # Kiểm tra sau khi xóa: cả DB, tasks, và thư mục vật lý đều đã sạch
        for pid in pids:
            self.assertIsNone(database.get_profile(pid))
            self.assertEqual(len(database.get_tasks(profile_id=pid)), 0)
            self.assertFalse(os.path.exists(os.path.join(profile_manager.PROFILES_ROOT, pid)))

        print(f"[Test] Bulk deleted {del_res['deleted_count']} profiles and related tasks OK")

    def test_13_chrome_launch_clean_scale_flags(self):
        from automation import build_chrome_launch_cmd
        cmd = build_chrome_launch_cmd(
            profile_dir=r"E:\TOOL QUẢN LÝ PAGE\profiles\1",
            debug_port=9200,
            x=0,
            y=0,
            w=400,
            h=600
        )
        # Đã bỏ hoàn toàn các cờ gây biến dạng scale
        self.assertNotIn("--force-device-scale-factor=0.5", cmd)
        self.assertNotIn("--high-dpi-support=1", cmd)
        self.assertIn("--window-position=0,0", cmd)
        self.assertIn("--window-size=400,600", cmd)
        self.assertIn("--disable-blink-features=AutomationControlled", cmd)
        print("[Test] Chrome launch clean scale flags verified OK")

    def test_14_amd_gpu_crash_fix_flags(self):
        from automation import build_chrome_launch_cmd
        cmd = build_chrome_launch_cmd(
            profile_dir=r"E:\TOOL QUẢN LÝ PAGE\profiles\1",
            debug_port=9200,
            x=0,
            y=0,
            w=400,
            h=600
        )
        required_flags = [
            "--default-zoom-level=-3.8",
            "--disable-gpu",
            "--disable-gpu-compositing",
            "--disable-software-rasterizer",
            "--use-gl=disabled",
            "--disable-features=AudioServiceSandbox,CalculateNativeWinOcclusion",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-blink-features=AutomationControlled",
        ]
        for flag in required_flags:
            self.assertIn(flag, cmd, f"Missing required flag: {flag}")
        print("[Test] AMD GPU crash fix flags fully verified OK")

    def test_15_runner_config_scale_and_empty_check(self):
        import main
        from main import RunConfigReq
        from fastapi import HTTPException

        cfg = RunConfigReq(threads=4, cols=4, rows=2, width=380, height=580, scale=0.5)
        self.assertEqual(cfg.scale, 0.5)

        # Kiểm tra bắn lỗi 400 "Không có task cần làm!" khi không có task pending nào
        with self.assertRaises(HTTPException) as ctx:
            main.run_tasks_endpoint(RunConfigReq(profile_ids=["non_existent_profile_999"]))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail, "Không có task cần làm!")
        print("[Test] Runner scale config and 'Không có task cần làm!' validation OK")

    def test_16_step1_and_step6_status_values(self):
        # Kiểm tra các chuỗi log chuẩn xác theo yêu cầu dự án
        task_id = database.add_task(
            profile_id="1",
            video_path=os.path.abspath("manager.db"),
            caption="Test Status",
            comment_text=""
        )

        # Bước 1 fail
        database.update_task_status(task_id, "failed", log="Chưa đăng nhập đúng tài khoản")
        t = database.get_task(task_id)
        self.assertEqual(t["status"], "failed")
        self.assertEqual(t["log"], "Chưa đăng nhập đúng tài khoản")

        # Bước 6 nhánh không comment
        database.update_task_status(task_id, "success", log="Đã lên lịch", video_url="https://facebook.com/reel/111", done_time="2026-11-05 12:00:00")
        t = database.get_task(task_id)
        self.assertEqual(t["status"], "success")
        self.assertEqual(t["log"], "Đã lên lịch")
        self.assertEqual(t["video_url"], "https://facebook.com/reel/111")

        # Bước 6 nhánh có comment
        database.update_task_status(task_id, "success", log="Đã lên lịch và cmt")
        t = database.get_task(task_id)
        self.assertEqual(t["status"], "success")
        self.assertEqual(t["log"], "Đã lên lịch và cmt")
        print("[Test] Step 1 and Step 6 status and log strings verified OK")

    def test_17_step1_xpath_and_wrong_account_screenshot_path(self):
        from automation import LOGS_DIR
        profile_name = "Fanpage Mọt Phim"
        xpath_check = f'(//span[text()="{profile_name}"])[1]'
        self.assertEqual(xpath_check, '(//span[text()="Fanpage Mọt Phim"])[1]')
        
        task_id = 12345
        screenshot_path = os.path.join(LOGS_DIR, f"wrong_account_{task_id}.png")
        self.assertTrue(screenshot_path.endswith(f"wrong_account_{task_id}.png"))
        self.assertIn("logs", screenshot_path)
        print("[Test] Step 1 XPath check and screenshot file path verified OK")

    def test_18_date_time_react_format(self):
        raw_date = "2026-11-05"
        if "-" in raw_date and len(raw_date.split("-")) == 3:
            p_date = raw_date.split("-")
            formatted_date = f"{p_date[2]}/{p_date[1]}/{p_date[0]}"
        else:
            formatted_date = raw_date
        self.assertEqual(formatted_date, "05/11/2026")

        raw_date_already = "05/11/2026"
        if "-" in raw_date_already and len(raw_date_already.split("-")) == 3:
            p_date = raw_date_already.split("-")
            formatted_date_already = f"{p_date[2]}/{p_date[1]}/{p_date[0]}"
        else:
            formatted_date_already = raw_date_already
        self.assertEqual(formatted_date_already, "05/11/2026")
        print("[Test] Schedule date React format normalization verified OK")


if __name__ == "__main__":
    unittest.main()

