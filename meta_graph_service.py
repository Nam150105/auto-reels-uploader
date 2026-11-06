import os
import time
import json
from typing import Dict, Any, List, Optional, Tuple
import requests

import database
from meta_crypto import encrypt_token, decrypt_token
from meta_oauth_service import get_meta_config

TIMEOUT_SECONDS = 30


class MetaGraphService:
    """
    Dịch vụ tương tác trực tiếp với Meta Graph API và Facebook Reels Publishing API:
    - Tự động lấy và đồng bộ danh sách Fanpage (/me/accounts) từ nhiều tài khoản Facebook Admin với phân trang (paging.next).
    - Lưu trữ quan hệ Nhiều - Nhiều (Many-to-Many) giữa Facebook Admin Accounts và Fanpages (facebook_account_pages).
    - Khử trùng lặp Fanpage: Không tạo 2 bản ghi cho cùng 1 page_id.
    - Kiểm tra quyền quản trị Fanpage.
    - Đăng Video Reels qua API chính thức (Initialize, Upload binary, Check status, Publish, Get URL).
    - Đăng bình luận tự động qua Graph API nếu có comment_text.
    """

    @classmethod
    def get_api_version(cls) -> str:
        cfg = get_meta_config()
        return cfg.get("api_version") or "v19.0"

    @classmethod
    def sync_pages(
        cls,
        account_id: Optional[str] = None,
        owner_user_id: Optional[str] = None,
        is_admin: bool = False
    ) -> Dict[str, Any]:
        """
        Gọi GET /me/accounts để lấy toàn bộ danh sách Fanpage người dùng có quyền quản lý.
        - Nếu có account_id: đồng bộ cho tài khoản Admin cụ thể.
        - Nếu không có account_id: đồng bộ cho TẤT CẢ các tài khoản Admin đang kết nối (hoặc theo owner_user_id).
        Xử lý đầy đủ pagination (paging.next) để không bao giờ bỏ sót Page.
        Lưu Page an toàn vào database với Page Access Token được mã hóa.
        """
        accounts_to_sync = []
        if account_id:
            target_acc = database.get_facebook_account_by_id(account_id)
            if not target_acc:
                return {
                    "status": "error",
                    "message": f"Không tìm thấy tài khoản Facebook Admin {account_id} trong hệ thống."
                }
            if target_acc.get("status") != "connected":
                return {
                    "status": "error",
                    "message": f"Tài khoản Admin '{target_acc.get('user_name')}' đang bị ngắt kết nối. Vui lòng kết nối lại trước khi đồng bộ!"
                }
            accounts_to_sync.append(target_acc)
        else:
            accounts_to_sync = database.get_facebook_accounts(status="connected", owner_user_id=owner_user_id, is_admin=is_admin)

        if not accounts_to_sync:
            return {
                "status": "error",
                "message": "Chưa có tài khoản Facebook Admin nào đang kết nối. Vui lòng bấm '+ Thêm tài khoản Facebook' trước!"
            }

        version = cls.get_api_version()
        total_synced_pages = 0
        total_unique_pages = set()
        account_results: List[Dict[str, Any]] = []

        for acc in accounts_to_sync:
            acc_id = acc["id"]
            acc_name = acc.get("user_name", "Admin")
            enc_user_token = acc.get("encrypted_user_access_token")
            user_token = decrypt_token(enc_user_token)

            if not user_token:
                account_results.append({
                    "account_id": acc_id,
                    "user_name": acc_name,
                    "status": "error",
                    "message": "Không thể giải mã User Access Token. Vui lòng kết nối lại!"
                })
                continue

            endpoint_url: Optional[str] = f"https://graph.facebook.com/{version}/me/accounts"
            params: Optional[Dict[str, Any]] = {
                "fields": "id,name,access_token,category,picture{url},tasks,is_published",
                "limit": 100,
                "access_token": user_token
            }

            acc_synced_count = 0
            acc_error = None

            # Phân trang toàn bộ kết quả (Pagination loop)
            while endpoint_url:
                try:
                    resp = requests.get(endpoint_url, params=params, timeout=TIMEOUT_SECONDS)
                    data = resp.json()
                except Exception as e:
                    acc_error = f"Lỗi mạng khi tải Fanpage của Admin {acc_name}: {e}"
                    break

                if "error" in data:
                    err = data["error"]
                    err_msg = err.get("message", "Lỗi không xác định")
                    acc_error = f"Graph API Error: {err_msg}"
                    # Nếu token hết hạn hoặc bị thu hồi
                    if err.get("code") in [190, 102]:
                        database.update_meta_connection_status(acc_id, "expired")
                    break

                page_items = data.get("data", [])
                for item in page_items:
                    fb_id = str(item.get("id", "")).strip()
                    name = str(item.get("name", "")).strip()
                    raw_page_token = item.get("access_token")
                    tasks_list = item.get("tasks", [])
                    category = item.get("category", "")
                    avatar_url = item.get("picture", {}).get("data", {}).get("url")

                    if not fb_id or not name or not raw_page_token:
                        continue

                    # Kiểm tra quyền đăng bài: cần CREATE_CONTENT hoặc MANAGE hoặc CREATE_ADS
                    can_post = 1 if any(t in ["CREATE_CONTENT", "MANAGE", "CREATE_ADS"] for t in tasks_list) else 0

                    # Mã hóa Page Access Token
                    enc_page_token = encrypt_token(raw_page_token)
                    if not enc_page_token:
                        continue

                    # Lưu hoặc cập nhật quan hệ Nhiều - Nhiều
                    database.upsert_facebook_page_and_relation(
                        account_id=acc_id,
                        facebook_page_id=fb_id,
                        name=name,
                        encrypted_page_access_token=enc_page_token,
                        tasks_json=json.dumps(tasks_list, ensure_ascii=False),
                        can_post=can_post,
                        category=category,
                        avatar_url=avatar_url
                    )
                    acc_synced_count += 1
                    total_unique_pages.add(fb_id)

                # Phân trang qua paging.next
                paging = data.get("paging", {})
                endpoint_url = paging.get("next")
                params = None

            total_synced_pages += acc_synced_count
            account_results.append({
                "account_id": acc_id,
                "user_name": acc_name,
                "status": "error" if acc_error else ("empty" if acc_synced_count == 0 else "success"),
                "synced_count": acc_synced_count,
                "error": acc_error
            })

        all_empty = all(r["status"] == "empty" for r in account_results if r["status"] != "error")
        all_error = all(r["status"] == "error" for r in account_results)

        if all_error:
            first_err = next(r["error"] for r in account_results if r.get("error"))
            return {"status": "error", "message": first_err, "results": account_results}

        if all_empty and len(total_unique_pages) == 0:
            return {
                "status": "empty",
                "message": (
                    "Meta trả về danh sách Fanpage rỗng (0 trang) cho các tài khoản Admin này.\n"
                    "Lý do thường gặp:\n"
                    "1. Tài khoản Facebook Admin chưa được cấp quyền quản lý Fanpage nào.\n"
                    "2. Khi đăng nhập OAuth, người dùng chưa tích chọn cấp quyền cho Fanpage cần quản lý.\n"
                    "3. Fanpage thuộc Business Suite cần cấp quyền Employee/Admin cho tài khoản.\n"
                    "Vui lòng kiểm tra lại quyền trên Facebook và nhấn 'Đồng bộ Fanpage'!"
                ),
                "synced_count": 0,
                "results": account_results
            }

        return {
            "status": "success",
            "message": f"Đã đồng bộ thành công {len(total_unique_pages)} Fanpage từ {len(accounts_to_sync)} tài khoản Facebook Admin!",
            "unique_pages_count": len(total_unique_pages),
            "total_synced_pages": total_synced_pages,
            "results": account_results,
            "pages": database.get_facebook_pages()
        }

    @classmethod
    def check_page_permission(cls, facebook_page_id: str) -> Dict[str, Any]:
        """Kiểm tra quyền truy cập và tính hợp lệ của Page Access Token."""
        page_data = database.get_facebook_page_by_fb_id(facebook_page_id)
        if not page_data:
            return {"status": "error", "message": f"Không tìm thấy Fanpage {facebook_page_id} trong hệ thống."}

        enc_token = database.get_page_active_token(facebook_page_id) or page_data.get("encrypted_page_access_token")
        page_token = decrypt_token(enc_token)
        if not page_token:
            return {"status": "error", "message": "Lỗi giải mã Page Access Token."}

        version = cls.get_api_version()
        url = f"https://graph.facebook.com/{version}/{facebook_page_id}"
        try:
            resp = requests.get(
                url,
                params={"fields": "id,name,is_published,tasks", "access_token": page_token},
                timeout=15
            )
            data = resp.json()
        except Exception as e:
            return {"status": "error", "message": f"Lỗi mạng khi kiểm tra Page: {e}"}

        if "error" in data:
            err = data["error"]
            msg = err.get("message", "Lỗi kiểm tra quyền")
            return {"status": "error", "can_post": False, "message": f"Page Token bị lỗi: {msg}"}

        tasks = data.get("tasks", [])
        can_post = any(t in ["CREATE_CONTENT", "MANAGE", "CREATE_ADS"] for t in tasks)

        return {
            "status": "success",
            "facebook_page_id": facebook_page_id,
            "name": data.get("name"),
            "can_post": can_post,
            "tasks": tasks,
            "admin_names": page_data.get("admin_names", ""),
            "message": "Page Access Token hợp lệ và có quyền đăng bài!" if can_post else "Page thiếu quyền CREATE_CONTENT!"
        }

    # =========================================================================
    # REELS PUBLISHING API CHÍNH THỨC CỦA META
    # =========================================================================

    @classmethod
    def publish_reel(
        cls,
        facebook_page_id: str,
        video_path: str,
        caption: str = "",
        comment_text: str = "",
        schedule_time_unix: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Thực hiện quy trình đăng Reel lên Fanpage bằng Reels Publishing API chính thức:
        Bước 1: Khởi tạo upload: POST /{page-id}/video_reels (upload_phase=start) -> video_id, upload_url
        Bước 2: Upload file nhị phân lên upload_url
        Bước 3: Kiểm tra trạng thái xử lý video (GET /{video_id}?fields=status)
        Bước 4: Publish Reel: POST /{page-id}/video_reels (upload_phase=finish)
        Bước 5: Lấy URL và đăng bình luận nếu có
        """
        # 1. Kiểm tra Page và Token đang hoạt động tốt nhất
        page_data = database.get_facebook_page_by_fb_id(facebook_page_id)
        if not page_data:
            return {"status": "error", "message": f"Không tìm thấy cấu hình Fanpage {facebook_page_id}."}

        enc_token = database.get_page_active_token(facebook_page_id) or page_data.get("encrypted_page_access_token")
        page_token = decrypt_token(enc_token)
        if not page_token:
            return {"status": "error", "message": "Không thể giải mã Page Access Token để đăng bài."}

        # 2. Kiểm tra file video vật lý
        clean_path = video_path.strip().strip('"').strip("'")
        if not os.path.isfile(clean_path):
            return {"status": "error", "message": f"File video không tồn tại: {clean_path}"}

        file_size = os.path.getsize(clean_path)
        if file_size <= 0:
            return {"status": "error", "message": "File video rỗng (0 bytes)."}

        version = cls.get_api_version()
        start_endpoint = f"https://graph.facebook.com/{version}/{facebook_page_id}/video_reels"

        # Giai đoạn 1: Khởi tạo upload session
        try:
            init_payload = {
                "upload_phase": "start",
                "access_token": page_token
            }
            init_resp = requests.post(start_endpoint, data=init_payload, timeout=TIMEOUT_SECONDS)
            init_data = init_resp.json()
        except Exception as e:
            return {"status": "error", "message": f"Giai đoạn 1 (Start) lỗi kết nối: {e}"}

        if "error" in init_data:
            return {"status": "error", "message": f"Giai đoạn 1 thất bại: {init_data['error'].get('message')}"}

        video_id = init_data.get("video_id")
        upload_url = init_data.get("upload_url")
        if not video_id or not upload_url:
            return {"status": "error", "message": "Meta không trả về video_id hoặc upload_url."}

        # Giai đoạn 2: Truyền tải file video nhị phân (Binary Streaming)
        try:
            with open(clean_path, "rb") as video_file:
                video_bytes = video_file.read()

            upload_headers = {
                "Authorization": f"OAuth {page_token}",
                "offset": "0",
                "file_size": str(file_size),
                "Content-Type": "application/octet-stream"
            }
            upload_resp = requests.post(upload_url, headers=upload_headers, data=video_bytes, timeout=180)
            upload_data = upload_resp.json()
        except Exception as e:
            return {"status": "error", "message": f"Giai đoạn 2 (Upload Binary) lỗi: {e}"}

        if "success" not in upload_data and not upload_data.get("success", False):
            if "error" in upload_data:
                return {"status": "error", "message": f"Upload video thất bại: {upload_data['error'].get('message')}"}

        # Giai đoạn 3: Polling trạng thái xử lý video
        status_endpoint = f"https://graph.facebook.com/{version}/{video_id}"
        video_ready = False
        max_attempts = 15
        for _ in range(max_attempts):
            time.sleep(2)
            try:
                st_resp = requests.get(
                    status_endpoint,
                    params={"fields": "status", "access_token": page_token},
                    timeout=TIMEOUT_SECONDS
                )
                st_data = st_resp.json()
                video_status = st_data.get("status", {}).get("video_status")
                if video_status in ["ready", "complete"]:
                    video_ready = True
                    break
            except Exception:
                pass

        # Giai đoạn 4: Hoàn tất đăng Reels hoặc Lên lịch hẹn giờ
        finish_payload: Dict[str, Any] = {
            "upload_phase": "finish",
            "video_id": video_id,
            "access_token": page_token
        }

        if caption and caption.strip():
            finish_payload["description"] = caption.strip()

        is_scheduled = False
        if schedule_time_unix:
            current_time = int(time.time())
            diff = schedule_time_unix - current_time
            # Meta Graph API yêu cầu hẹn giờ từ 20 phút (1200s) đến 75 ngày (6480000s)
            if 1200 <= diff <= 6480000:
                finish_payload["video_state"] = "SCHEDULED"
                finish_payload["scheduled_publish_time"] = schedule_time_unix
                is_scheduled = True
            else:
                finish_payload["video_state"] = "PUBLISHED"
        else:
            finish_payload["video_state"] = "PUBLISHED"

        try:
            fin_resp = requests.post(start_endpoint, data=finish_payload, timeout=TIMEOUT_SECONDS)
            fin_data = fin_resp.json()
        except Exception as e:
            return {"status": "error", "message": f"Giai đoạn 4 (Finish) lỗi: {e}"}

        if "error" in fin_data:
            return {"status": "error", "message": f"Finish Reels thất bại: {fin_data['error'].get('message')}"}

        post_id = fin_data.get("post_id") or video_id
        reel_url = f"https://www.facebook.com/reel/{video_id}"

        # Giai đoạn 5: Đăng bình luận tự động nếu người dùng có cấu hình
        comment_log = ""
        if comment_text and comment_text.strip():
            try:
                time.sleep(1.5)
                cmt_url = f"https://graph.facebook.com/{version}/{post_id}/comments"
                cmt_resp = requests.post(
                    cmt_url,
                    data={"message": comment_text.strip(), "access_token": page_token},
                    timeout=TIMEOUT_SECONDS
                )
                cmt_data = cmt_resp.json()
                if "id" in cmt_data:
                    comment_log = " • Đã bình luận thành công"
                else:
                    comment_log = f" • Lỗi bình luận: {cmt_data.get('error', {}).get('message', 'Không rõ')}"
            except Exception as e:
                comment_log = f" • Lỗi gửi bình luận: {e}"

        action_desc = "Đã lên lịch thành công" if is_scheduled else "Đã đăng Reels thành công"
        return {
            "status": "success",
            "message": f"{action_desc} lên Fanpage {page_data.get('name')}{comment_log}",
            "video_id": video_id,
            "post_id": post_id,
            "video_url": reel_url,
            "is_scheduled": is_scheduled
        }
