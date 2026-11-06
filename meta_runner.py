import os
import time
import queue
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Dict, Any, List, Optional, Callable

import database
from caption_service import CaptionService
from meta_graph_service import MetaGraphService
from meta_oauth_service import get_connection_status


class MetaTestRunner:
    """
    Chế độ RUN TEST (Chạy thử an toàn):
    - Kiểm tra kết nối Meta Admin và token hết hạn.
    - Kiểm tra quyền (scopes).
    - Kiểm tra Page Access Token và quyền đăng bài của từng Fanpage được chọn.
    - Kiểm tra đường dẫn video, kích thước, định dạng.
    - Kiểm tra caption, bình luận, lịch đăng.
    - TUYỆT ĐỐI KHÔNG UPLOAD VIDEO VÀ KHÔNG GỌI PUBLISH API TRÊN META.
    """

    @classmethod
    def run_test(
        cls,
        facebook_page_ids: Optional[List[str]] = None,
        task_ids: Optional[List[int]] = None
    ) -> Dict[str, Any]:
        results: Dict[str, Any] = {
            "tested_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "meta_connection": {},
            "pages_validation": [],
            "tasks_validation": [],
            "is_ready_to_publish": False,
            "summary": ""
        }

        # 1. Kiểm tra kết nối Meta Admin
        conn_status = get_connection_status()
        results["meta_connection"] = {
            "is_connected": conn_status["is_connected"],
            "user_name": conn_status.get("user_name"),
            "user_id": conn_status.get("user_id"),
            "token_expires_at": conn_status.get("token_expires_at"),
            "scopes": conn_status.get("scopes", [])
        }

        req_scopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"]
        missing_scopes = [s for s in req_scopes if s not in conn_status.get("scopes", [])]

        if not conn_status["is_connected"]:
            results["status"] = "failed"
            results["message"] = "Thất bại: Chưa kết nối Facebook Admin qua OAuth!"
            results["summary"] = results["message"]
            results["oauth_check"] = {
                "connected": False,
                "user_name": None,
                "user_id": None,
                "token_expires_at": None,
                "missing_scopes": req_scopes
            }
            results["page_checks"] = []
            results["video_checks"] = []
            results["valid_pages_count"] = 0
            results["valid_videos_count"] = 0
            results["invalid_schedules_count"] = 0
            return results

        if missing_scopes:
            results["meta_connection"]["missing_scopes"] = missing_scopes

        # 2. Kiểm tra danh sách Fanpage được chọn
        pages_to_check = []
        if facebook_page_ids:
            for fbid in facebook_page_ids:
                p = database.get_facebook_page_by_fb_id(fbid)
                if p:
                    pages_to_check.append(p)
        else:
            pages_to_check = database.get_facebook_pages(only_selected=True)

        if not pages_to_check:
            results["summary"] = "Thất bại: Chưa chọn Fanpage nào hoặc không có Fanpage trong hệ thống!"
            return results

        valid_pages_count = 0
        for p in pages_to_check:
            fb_id = p["facebook_page_id"]
            check_res = MetaGraphService.check_page_permission(fb_id)
            page_info = {
                "facebook_page_id": fb_id,
                "name": p["name"],
                "can_post": check_res.get("can_post", False),
                "status": check_res.get("status"),
                "message": check_res.get("message")
            }
            if check_res.get("can_post"):
                valid_pages_count += 1
            results["pages_validation"].append(page_info)

        # 3. Kiểm tra danh sách Task
        if task_ids:
            tasks_to_check = [database.get_task(tid) for tid in task_ids if database.get_task(tid)]
        else:
            checked_page_ids = [p["facebook_page_id"] for p in pages_to_check]
            tasks_to_check = database.get_pending_tasks(facebook_page_ids=checked_page_ids)

        valid_tasks_count = 0
        for t in tasks_to_check:
            v_path = t.get("video_path", "").strip().strip('"').strip("'")
            file_exists = os.path.isfile(v_path)
            file_size = os.path.getsize(v_path) if file_exists else 0
            file_ext = os.path.splitext(v_path)[1].lower() if file_exists else ""
            is_valid_format = file_ext in [".mp4", ".mov", ".avi", ".mkv"]

            # Kiểm tra thời gian lên lịch nếu có
            schedule_info = "Đăng ngay"
            schedule_date = t.get("schedule_date")
            schedule_time = t.get("schedule_time")
            schedule_unix = None
            if schedule_date and schedule_time:
                try:
                    dt = datetime.strptime(f"{schedule_date} {schedule_time}", "%Y-%m-%d %H:%M")
                    schedule_unix = int(dt.timestamp())
                    diff = schedule_unix - int(time.time())
                    if 1200 <= diff <= 6480000:
                        schedule_info = f"Meta Scheduled: {schedule_date} {schedule_time}"
                    else:
                        schedule_info = f"App Scheduled: {schedule_date} {schedule_time}"
                except Exception:
                    schedule_info = "Lỗi định dạng ngày giờ"

            task_valid = file_exists and file_size > 0 and is_valid_format and bool(t.get("facebook_page_id"))
            if task_valid:
                valid_tasks_count += 1

            results["tasks_validation"].append({
                "task_id": t["id"],
                "facebook_page_id": t.get("facebook_page_id"),
                "page_name": t.get("page_name"),
                "video_path": v_path,
                "file_exists": file_exists,
                "file_size_mb": round(file_size / (1024 * 1024), 2) if file_exists else 0,
                "is_valid_format": is_valid_format,
                "caption_length": len(t.get("caption") or ""),
                "has_comment": bool((t.get("comment_text") or "").strip()),
                "schedule_info": schedule_info,
                "status": "VALID" if task_valid else "INVALID",
                "error": None if task_valid else "Thiếu file video hoặc sai định dạng hoặc chưa gán Page"
            })

        all_ok = (valid_pages_count > 0) and (valid_tasks_count > 0) and not missing_scopes
        status = "passed" if all_ok else ("warning" if (valid_pages_count > 0 or valid_tasks_count > 0) else "failed")
        results["is_ready_to_publish"] = all_ok
        results["status"] = status
        results["summary"] = (
            f"Run Test hoàn tất: {valid_pages_count}/{len(pages_to_check)} Page hợp lệ, "
            f"{valid_tasks_count}/{len(tasks_to_check)} Task sẵn sàng. "
            f"{'Hệ thống đủ điều kiện chạy thật!' if all_ok else 'Vui lòng kiểm tra các cảnh báo trên!'}"
        )
        results["message"] = results["summary"]
        results["oauth_check"] = {
            "connected": True,
            "user_name": conn_status.get("user_name"),
            "user_id": conn_status.get("user_id"),
            "token_expires_at": conn_status.get("token_expires_at"),
            "days_remaining": conn_status.get("days_remaining"),
            "missing_scopes": missing_scopes,
            "connected_count": conn_status.get("connected_count", 1),
            "accounts": conn_status.get("accounts", [])
        }
        results["page_checks"] = results["pages_validation"]
        results["valid_pages_count"] = valid_pages_count
        results["video_checks"] = [
            {"path": t["video_path"], "exists": t["file_exists"], "size_mb": t["file_size_mb"]}
            for t in results["tasks_validation"]
        ]
        results["valid_videos_count"] = len([v for v in results["video_checks"] if v["exists"]])
        results["invalid_schedules_count"] = len([t for t in results["tasks_validation"] if "Lỗi" in t["schedule_info"]])
        results["schedule_warnings"] = [t["schedule_info"] for t in results["tasks_validation"] if "Lỗi" in t["schedule_info"]]
        return results


class MetaTaskRunner:
    """
    Chế độ RUN TASK (Chạy thật qua Meta Graph API):
    - Đa luồng xử lý an toàn (Worker Pool).
    - Khóa chống trùng lặp Task (Idempotency).
    - Xử lý phân bổ nhiều Task cho nhiều Page.
    - Cập nhật tiến độ và URL bài đăng thời gian thực.
    - Cơ chế dừng khẩn cấp an toàn.
    """

    def __init__(self):
        self.is_running = False
        self.stop_event = threading.Event()
        self.executor: Optional[ThreadPoolExecutor] = None
        self.runner_thread: Optional[threading.Thread] = None
        self.task_locks: Dict[int, threading.Lock] = {}
        self.task_locks_guard = threading.Lock()

    def get_task_lock(self, task_id: int) -> threading.Lock:
        with self.task_locks_guard:
            if task_id not in self.task_locks:
                self.task_locks[task_id] = threading.Lock()
            return self.task_locks[task_id]

    def start_batch(
        self,
        facebook_page_ids: Optional[List[str]],
        threads: int = 3
    ) -> Dict[str, Any]:
        if self.is_running:
            return {"status": "error", "message": "Hệ thống đang chạy một tiến trình khác."}

        # Lấy danh sách task pending thuộc các Page được chọn
        pending_tasks = database.get_pending_tasks(facebook_page_ids=facebook_page_ids)
        if not pending_tasks:
            return {"status": "empty", "message": "Không có task cần làm!"}

        self.stop_event.clear()
        self.is_running = True

        self.runner_thread = threading.Thread(
            target=self._run_worker_pool,
            args=(pending_tasks, max(1, min(threads, 10))),
            daemon=True
        )
        self.runner_thread.start()

        return {
            "status": "started",
            "total_tasks": len(pending_tasks),
            "threads": threads,
            "message": f"Bắt đầu đăng {len(pending_tasks)} task qua Meta Graph API với {threads} luồng."
        }

    def _run_worker_pool(self, tasks: List[Dict[str, Any]], threads: int):
        print(f"[MetaRunner] Khởi động {threads} luồng xử lý {len(tasks)} task qua Meta Graph API...")

        with ThreadPoolExecutor(max_workers=threads) as executor:
            self.executor = executor
            futures = []

            for task in tasks:
                if self.stop_event.is_set():
                    break

                def worker_job(t=task):
                    if self.stop_event.is_set():
                        return
                    task_id = t["id"]
                    t_lock = self.get_task_lock(task_id)

                    with t_lock:
                        # Kiểm tra lại trạng thái trước khi thực thi để tránh đăng trùng
                        cur = database.get_task(task_id)
                        if not cur or cur["status"] != "pending":
                            return

                        database.update_task_status(task_id, "running", log="Đang kết nối Meta Graph API...")
                        try:
                            # Tính toán thời gian hẹn giờ (nếu có)
                            schedule_date = t.get("schedule_date")
                            schedule_time = t.get("schedule_time")
                            schedule_unix = None
                            if schedule_date and schedule_time:
                                try:
                                    dt = datetime.strptime(f"{schedule_date} {schedule_time}", "%Y-%m-%d %H:%M")
                                    schedule_unix = int(dt.timestamp())
                                except Exception:
                                    pass

                            # Gọi dịch vụ đăng Reels chính thức
                            res = MetaGraphService.publish_reel(
                                facebook_page_id=t["facebook_page_id"],
                                video_path=t["video_path"],
                                caption=t.get("caption") or "",
                                comment_text=t.get("comment_text") or "",
                                schedule_time_unix=schedule_unix
                            )

                            if res["status"] == "success":
                                done_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                                database.update_task_status(
                                    task_id=task_id,
                                    status="success",
                                    log=res.get("message", "Đăng thành công"),
                                    video_url=res.get("video_url"),
                                    meta_video_id=res.get("video_id"),
                                    meta_post_id=res.get("post_id"),
                                    done_time=done_time
                                )
                                print(f"[MetaRunner] Task #{task_id} thành công! URL: {res.get('video_url')}")
                            else:
                                err_msg = res.get("message", "Lỗi đăng bài")
                                database.update_task_status(
                                    task_id=task_id,
                                    status="failed",
                                    log=f"Thất bại: {err_msg}",
                                    error_message=err_msg
                                )
                                print(f"[MetaRunner] Task #{task_id} thất bại: {err_msg}")

                        except Exception as e:
                            err_msg = str(e)
                            database.update_task_status(
                                task_id=task_id,
                                status="failed",
                                log=f"Exception: {err_msg}",
                                error_message=err_msg
                            )
                            print(f"[MetaRunner] Task #{task_id} ngoại lệ: {err_msg}")

                f = executor.submit(worker_job)
                futures.append(f)

            for f in as_completed(futures):
                try:
                    f.result()
                except Exception as e:
                    print(f"[MetaRunner Error]: {e}")

        self.is_running = False
        self.executor = None
        database.reset_running_tasks()
        print("[MetaRunner] Đã hoàn thành toàn bộ batch task qua Meta API.")

    def stop(self) -> int:
        self.stop_event.set()
        if self.executor:
            try:
                self.executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            self.executor = None
        reset_count = database.reset_running_tasks()
        self.is_running = False
        return reset_count


runner = MetaTaskRunner()
