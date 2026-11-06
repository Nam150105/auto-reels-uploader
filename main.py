import os
import json
import secrets
from typing import List, Optional, Dict, Any, Tuple

from fastapi import FastAPI, HTTPException, Body, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import database
import system_helper
from caption_service import CaptionService
from meta_oauth_service import (
    get_meta_config,
    generate_oauth_url,
    exchange_code_for_token,
    get_connection_status,
    disconnect_admin,
    disconnect_admin_account,
    delete_admin_account
)
from meta_graph_service import MetaGraphService
from meta_runner import MetaTestRunner, runner as meta_runner

app = FastAPI(title="Facebook Reels Scheduler - Meta Graph API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
LOGS_DIR = os.path.join(BASE_DIR, "logs")

os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

# Khởi tạo DB khi khởi động
database.init_db()


# ==========================================
# REVERSE PROXY MIDDLEWARE (CLOUDFLARE TUNNEL)
# ==========================================

@app.middleware("http")
async def proxy_headers_middleware(request: Request, call_next):
    """
    Tin cậy Reverse Proxy headers từ Cloudflare Edge:
    - X-Forwarded-Proto: https -> Đảm bảo request.scope['scheme'] = 'https'
    - X-Forwarded-Host: pagefb.namnangno.click -> Đảm bảo host đúng tên miền công khai
    """
    forwarded_proto = request.headers.get("x-forwarded-proto")
    if forwarded_proto:
        request.scope["scheme"] = forwarded_proto.lower()

    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_host:
        parts = forwarded_host.split(":")
        host = parts[0]
        port = int(parts[1]) if len(parts) > 1 else (443 if request.scope["scheme"] == "https" else 80)
        request.scope["server"] = (host, port)

    response = await call_next(request)
    return response


# ==========================================
# AUTHENTICATION HELPERS
# ==========================================

def get_current_user(request: Request = None) -> Optional[Dict[str, Any]]:
    """Lấy thông tin người dùng hiện tại từ cookie session_token hoặc Bearer header."""
    if not request:
        return None

    token = request.cookies.get("session_token")
    if not token:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()

    if not token:
        return None

    user_id = database.verify_session_token(token)
    if not user_id:
        return None

    return database.get_user_by_id(user_id)


def get_user_context(request: Request = None) -> Tuple[Optional[Dict[str, Any]], Optional[str], bool]:
    if not request:
        return None, None, False
    user = get_current_user(request)
    if user:
        return user, user["id"], (user.get("role") == "admin")
    # Khi không có user đăng nhập: TUYỆT ĐỐI KHÔNG cấp quyền admin mặc định
    return None, None, False


# ==========================================
# PYDANTIC SCHEMAS
# ==========================================

class LoginReq(BaseModel):
    username: str
    password: str


class RegisterReq(BaseModel):
    username: str
    password: str
    full_name: Optional[str] = None
    email: Optional[str] = None


class PageSelectReq(BaseModel):
    is_selected: bool


class PageBulkSelectReq(BaseModel):
    is_selected: bool
    facebook_page_ids: Optional[List[str]] = None
    account_ids: Optional[List[str]] = None


class TaskCreateReq(BaseModel):
    facebook_page_id: Optional[str] = None
    profile_id: Optional[str] = None
    video_path: str
    caption: Optional[str] = ""
    comment_text: Optional[str] = ""
    schedule_date: Optional[str] = ""
    schedule_time: Optional[str] = ""
    publish_mode: Optional[str] = "now"


class TaskUpdateReq(BaseModel):
    facebook_page_id: Optional[str] = None
    profile_id: Optional[str] = None
    video_path: Optional[str] = None
    caption: Optional[str] = None
    comment_text: Optional[str] = None
    schedule_date: Optional[str] = None
    schedule_time: Optional[str] = None
    publish_mode: Optional[str] = None


class BulkTaskItem(BaseModel):
    video_path: str
    caption: Optional[str] = ""
    comment_text: Optional[str] = ""
    schedule_date: Optional[str] = ""
    schedule_time: Optional[str] = ""
    facebook_page_id: Optional[str] = None
    profile_id: Optional[str] = None


class BulkTaskCreateReq(BaseModel):
    tasks: List[BulkTaskItem]
    assign_page_ids: Optional[List[str]] = None
    assign_profile_ids: Optional[List[str]] = None


class RunTestReq(BaseModel):
    facebook_page_ids: Optional[List[str]] = None
    task_ids: Optional[List[int]] = None


class RunTaskReq(BaseModel):
    facebook_page_ids: Optional[List[str]] = None
    profile_ids: Optional[List[str]] = None
    threads: int = Field(default=3, ge=1, le=10)


class RunConfigReq(BaseModel):
    threads: int = 3
    cols: int = 3
    rows: int = 2
    width: int = 400
    height: int = 600
    scale: float = 0.5
    profile_ids: Optional[List[str]] = None
    facebook_page_ids: Optional[List[str]] = None


class ProfilePatchReq(BaseModel):
    name: str


class ProfileBulkCreateReq(BaseModel):
    quantity: int = 1


class ProfileBulkDeleteReq(BaseModel):
    profile_ids: List[str]


class FileCheckReq(BaseModel):
    paths: List[str]


# ==========================================
# 0. AUTHENTICATION APIS (/api/auth/*)
# ==========================================

@app.post("/api/auth/login")
def auth_login_endpoint(payload: LoginReq):
    """Xác thực thông tin đăng nhập và cấp session token an toàn."""
    user = database.verify_user_credentials(payload.username, payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không chính xác.")

    token = database.generate_session_token(user["id"])
    response = JSONResponse({
        "status": "success",
        "message": f"Chào mừng {user.get('full_name') or user['username']}!",
        "user": user,
        "token": token
    })
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=7 * 86400,
        path="/"
    )
    return response


@app.post("/api/auth/register")
def auth_register_endpoint(payload: RegisterReq):
    """Đăng ký tài khoản thành viên mới trên hệ thống."""
    try:
        user = database.create_user(
            username=payload.username,
            password=payload.password,
            full_name=payload.full_name,
            email=payload.email,
            role="user"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    token = database.generate_session_token(user["id"])
    response = JSONResponse({
        "status": "success",
        "message": "Đăng ký tài khoản thành công!",
        "user": user,
        "token": token
    })
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=7 * 86400,
        path="/"
    )
    return response


@app.post("/api/auth/logout")
def auth_logout_endpoint():
    """Đăng xuất và hủy cookie session_token."""
    response = JSONResponse({"status": "success", "message": "Đã đăng xuất thành công."})
    response.delete_cookie(key="session_token", path="/")
    return response


@app.get("/api/auth/me")
def auth_me_endpoint(request: Request):
    """Lấy thông tin tài khoản người dùng đang đăng nhập."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Chưa đăng nhập.")
    return {"status": "success", "user": user}


# ==========================================
# 1. META OAUTH 2.0 APIS (FACEBOOK ADMIN)
# ==========================================

@app.get("/api/meta/status")
def meta_status_endpoint(request: Request = None):
    """Lấy trạng thái kết nối các tài khoản Facebook Admin (phân quyền theo user)."""
    user, owner_uid, is_admin = get_user_context(request)
    return get_connection_status(owner_user_id=owner_uid, is_admin=is_admin)


@app.get("/api/meta/accounts")
def list_meta_accounts_endpoint(status: Optional[str] = None, request: Request = None):
    """Lấy danh sách tất cả các tài khoản Facebook Admin (phân quyền theo user)."""
    user, owner_uid, is_admin = get_user_context(request)
    return database.get_facebook_accounts(status=status, owner_user_id=owner_uid, is_admin=is_admin)


@app.get("/api/meta/accounts/{account_id}")
def get_meta_account_endpoint(account_id: str):
    """Lấy thông tin chi tiết 1 tài khoản Facebook Admin."""
    acc = database.get_facebook_account_by_id(account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Không tìm thấy tài khoản Facebook Admin.")
    return acc


@app.post("/api/meta/accounts/{account_id}/disconnect")
def disconnect_meta_account_endpoint(account_id: str):
    """Ngắt kết nối 1 tài khoản Facebook Admin."""
    res = disconnect_admin_account(account_id)
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return res


@app.delete("/api/meta/accounts/{account_id}")
def delete_meta_account_endpoint(account_id: str):
    """Xóa tài khoản Facebook Admin khỏi hệ thống."""
    res = delete_admin_account(account_id)
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return res


@app.post("/api/meta/accounts/{account_id}/sync")
def sync_account_pages_endpoint(account_id: str):
    """Đồng bộ danh sách Fanpage cho 1 tài khoản Facebook Admin cụ thể."""
    res = MetaGraphService.sync_pages(account_id=account_id)
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return res


@app.get("/api/meta/accounts/{account_id}/reconnect-url")
def reconnect_account_url_endpoint(account_id: str, request: Request = None):
    """Tạo link OAuth để kết nối lại tài khoản Admin cụ thể."""
    user, owner_uid, _ = get_user_context(request)
    res = generate_oauth_url(account_id=account_id, user_id=owner_uid, auth_type="rerequest")
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return res


def extract_request_base_url(request: Request = None) -> Optional[str]:
    if not request:
        return None
    proto = request.headers.get("x-forwarded-proto") or (request.url.scheme if hasattr(request, "url") else "https")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or (request.url.netloc if hasattr(request, "url") else None)
    if host and "testserver" not in host.lower():
        return f"{proto}://{host}"
    return None


@app.get("/api/meta/oauth-url")
def meta_oauth_url_endpoint(account_id: Optional[str] = None, request: Request = None):
    """Tạo URL đăng nhập Facebook OAuth 2.0 kèm CSRF state token riêng biệt."""
    user, owner_uid, _ = get_user_context(request)
    base_url = extract_request_base_url(request)
    res = generate_oauth_url(account_id=account_id, user_id=owner_uid, auth_type="rerequest", custom_base_url=base_url)
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return res


@app.get("/api/meta/login")
def meta_login_redirect_endpoint(
    request: Request = None,
    auth_type: Optional[str] = "rerequest",
    account_id: Optional[str] = None
):
    """
    Nút 'Kết nối tài khoản Facebook':
    Tạo URL OAuth sang https://www.facebook.com/v19.0/dialog/oauth với đầy đủ scopes,
    gắn state với user hiện tại, hỗ trợ auth_type=rerequest và redirect trực tiếp.
    """
    user, owner_uid, _ = get_user_context(request)
    base_url = extract_request_base_url(request)
    res = generate_oauth_url(account_id=account_id, user_id=owner_uid, auth_type=auth_type, custom_base_url=base_url)
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return RedirectResponse(res["oauth_url"], status_code=302)


@app.get("/api/meta/callback")
def meta_oauth_callback_endpoint(
    request: Request = None,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None
):
    """
    Điểm đón Callback từ Meta OAuth:
    1. Đổi code lấy Short-Lived Token
    2. Đổi sang Long-Lived Token (60 ngày)
    3. Lấy thông tin tài khoản Facebook (/v19.0/me?fields=id,name,picture.type(large))
    4. Lấy danh sách Fanpage (/v19.0/me/accounts?fields=id,name,access_token,category,picture{url},tasks&limit=100)
    5. Lưu an toàn vào DB gắn với User đang đăng nhập và redirect về /pages.
    """
    if error:
        err_msg = error_description or error or "Người dùng đã từ chối cấp quyền Facebook OAuth."
        return HTMLResponse(
            f"""
            <!DOCTYPE html>
            <html lang="vi">
            <head><meta charset="UTF-8"><title>Kết nối thất bại</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="min-h-full flex items-center justify-center bg-slate-950 text-slate-100 p-4">
                <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
                    <div class="h-14 w-14 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto mb-4 text-3xl font-bold">✕</div>
                    <h2 class="text-xl font-bold text-white mb-2">Kết nối Facebook Thất Bại</h2>
                    <p class="text-xs text-rose-400 mb-6">{err_msg}</p>
                    <a href="/pages" class="inline-block py-2.5 px-6 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition">
                        Về Bảng Điều Khiển
                    </a>
                </div>
            </body>
            </html>
            """,
            status_code=400
        )

    if not code or not state:
        raise HTTPException(status_code=400, detail="Thiếu tham số code hoặc state từ Meta OAuth.")

    # 1. Đổi code lấy token và lưu an toàn
    exchange_res = exchange_code_for_token(code=code, state=state)
    if exchange_res["status"] == "error":
        return HTMLResponse(
            f"""
            <!DOCTYPE html>
            <html lang="vi">
            <head><meta charset="UTF-8"><title>Lỗi đổi mã truy cập</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="min-h-full flex items-center justify-center bg-slate-950 text-slate-100 p-4">
                <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
                    <div class="h-14 w-14 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto mb-4 text-3xl font-bold">✕</div>
                    <h2 class="text-xl font-bold text-white mb-2">Lỗi Đổi Mã Truy Cập</h2>
                    <p class="text-xs text-rose-400 mb-6">{exchange_res['message']}</p>
                    <a href="/pages" class="inline-block py-2.5 px-6 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition">
                        Về Bảng Điều Khiển
                    </a>
                </div>
            </body>
            </html>
            """,
            status_code=400
        )

    # 2. Tự động đồng bộ danh sách Fanpage ngay sau khi OAuth thành công cho tài khoản này
    acc_id = exchange_res.get("account_id")
    user, owner_uid, is_admin = get_user_context(request)
    sync_res = MetaGraphService.sync_pages(account_id=acc_id, owner_user_id=owner_uid, is_admin=is_admin)

    # 3. Chuyển hướng về giao diện /pages với thông báo thành công
    return HTMLResponse(
        f"""
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="refresh" content="2;url=/pages" />
            <title>Kết Nối Facebook Thành Công</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="min-h-full flex items-center justify-center bg-slate-950 text-slate-100 p-4">
            <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
                <div class="h-14 w-14 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-4 text-3xl font-bold">✓</div>
                <h2 class="text-xl font-bold text-white mb-2">Kết Nối Facebook Thành Công!</h2>
                <p class="text-sm text-slate-300 mb-1">Tài khoản: <b>{exchange_res.get('user_name')}</b></p>
                <p class="text-xs text-slate-400 mb-6">{sync_res.get('message')}</p>
                <p class="text-xs text-slate-500 mb-4 animate-pulse">Đang tự động chuyển hướng về trang Quản lý Fanpage...</p>
                <a href="/pages" class="inline-block py-2.5 px-6 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold rounded-xl shadow-lg transition">
                    Về Trang Quản Lý Ngay
                </a>
            </div>
        </body>
        </html>
        """
    )


@app.post("/api/meta/disconnect")
def meta_disconnect_endpoint():
    """Ngắt kết nối toàn bộ Facebook Admin."""
    return disconnect_admin()


@app.post("/api/meta/sync-pages")
def meta_sync_pages_endpoint(account_id: Optional[str] = None, request: Request = None):
    """Gọi Meta Graph API (/me/accounts) để đồng bộ danh sách Fanpage mới nhất."""
    user, owner_uid, is_admin = get_user_context(request)
    res = MetaGraphService.sync_pages(account_id=account_id, owner_user_id=owner_uid, is_admin=is_admin)
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return res


# ==========================================
# 2. FANPAGE MANAGEMENT APIS
# ==========================================

@app.get("/api/pages")
def list_pages_endpoint(
    account_ids: Optional[str] = Query(None, description="Danh sách account_id phân cách bằng dấu phẩy"),
    search: Optional[str] = None,
    status: Optional[str] = None,
    only_selected: bool = False,
    request: Request = None
):
    """Lấy danh sách Fanpage đã khử trùng lặp, hỗ trợ phân quyền người dùng và lọc theo tài khoản Admin."""
    parsed_account_ids = None
    if isinstance(account_ids, str) and account_ids.strip():
        parsed_account_ids = [a.strip() for a in account_ids.split(",") if a.strip()]

    user, owner_uid, is_admin = get_user_context(request)
    return database.get_facebook_pages(
        account_ids=parsed_account_ids,
        search=search,
        status=status,
        only_selected=only_selected,
        owner_user_id=owner_uid,
        is_admin=is_admin
    )


@app.post("/api/pages/{facebook_page_id}/select")
def select_page_endpoint(facebook_page_id: str, payload: PageSelectReq):
    """Chọn hoặc bỏ chọn 1 Fanpage."""
    success = database.update_page_selection(facebook_page_id, payload.is_selected)
    if not success:
        raise HTTPException(status_code=404, detail="Không tìm thấy Fanpage.")
    return {"status": "success", "facebook_page_id": facebook_page_id, "is_selected": payload.is_selected}


@app.post("/api/pages/bulk-select")
def bulk_select_pages_endpoint(payload: PageBulkSelectReq):
    """Chọn tất cả hoặc bỏ chọn tất cả Fanpage (hỗ trợ theo account_ids)."""
    updated_count = database.bulk_update_page_selection(
        is_selected=payload.is_selected,
        facebook_page_ids=payload.facebook_page_ids,
        account_ids=payload.account_ids
    )
    return {
        "status": "success",
        "updated_count": updated_count,
        "is_selected": payload.is_selected,
        "message": f"Đã {'chọn' if payload.is_selected else 'bỏ chọn'} {updated_count} Fanpage."
    }


@app.post("/api/pages/{facebook_page_id}/check-permission")
def check_page_permission_endpoint(facebook_page_id: str):
    """Kiểm tra quyền đăng bài và tính hợp lệ của Page Access Token."""
    res = MetaGraphService.check_page_permission(facebook_page_id)
    if res["status"] == "error":
        raise HTTPException(status_code=400, detail=res["message"])
    return res


@app.delete("/api/pages/{facebook_page_id}")
def delete_page_endpoint(facebook_page_id: str):
    """Xóa Fanpage khỏi ứng dụng (KHÔNG xóa Page thực tế trên Facebook)."""
    success = database.delete_facebook_page_local(facebook_page_id)
    if not success:
        raise HTTPException(status_code=404, detail="Không tìm thấy Fanpage.")
    return {"status": "success", "message": f"Đã xóa Fanpage {facebook_page_id} khỏi danh sách quản lý."}


# ==========================================
# 3. TASK APIS (REELS PUBLISHING TASKS)
# ==========================================

@app.get("/api/tasks")
def list_tasks_endpoint(
    facebook_page_id: Optional[str] = None,
    profile_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    request: Request = None
):
    user, owner_uid, is_admin = get_user_context(request)
    return database.get_tasks(
        facebook_page_id=facebook_page_id,
        profile_id=profile_id,
        status=status,
        search=search,
        owner_user_id=owner_uid,
        is_admin=is_admin
    )


@app.post("/api/tasks")
def create_task_endpoint(payload: TaskCreateReq, request: Request = None):
    if not payload.video_path or not payload.video_path.strip():
        raise HTTPException(status_code=400, detail="Đường dẫn video không được để trống.")

    user, owner_uid, _ = get_user_context(request)
    task_id = database.add_task(
        facebook_page_id=payload.facebook_page_id,
        profile_id=payload.profile_id,
        video_path=payload.video_path,
        caption=payload.caption or "",
        comment_text=payload.comment_text or "",
        schedule_date=payload.schedule_date or "",
        schedule_time=payload.schedule_time or "",
        publish_mode=payload.publish_mode or "now",
        owner_user_id=owner_uid
    )
    return {"id": task_id, "message": "Tạo task thành công.", "task": database.get_task(task_id)}


@app.put("/api/tasks/{task_id}")
def update_task_endpoint(task_id: int, payload: TaskUpdateReq):
    success = database.update_task(
        task_id=task_id,
        facebook_page_id=payload.facebook_page_id,
        profile_id=payload.profile_id,
        video_path=payload.video_path,
        caption=payload.caption,
        comment_text=payload.comment_text,
        schedule_date=payload.schedule_date,
        schedule_time=payload.schedule_time,
        publish_mode=payload.publish_mode
    )
    if not success:
        raise HTTPException(status_code=404, detail="Không tìm thấy task.")
    return {"message": "Cập nhật task thành công.", "task": database.get_task(task_id)}


@app.post("/api/tasks/bulk")
def create_tasks_bulk_endpoint(payload: BulkTaskCreateReq, request: Request = None):
    if not payload.tasks:
        raise HTTPException(status_code=400, detail="Danh sách task rỗng.")
    tasks_data = [item.model_dump() for item in payload.tasks]
    user, owner_uid, _ = get_user_context(request)
    inserted = database.add_tasks_bulk(
        tasks_list=tasks_data,
        assign_page_ids=payload.assign_page_ids,
        assign_profile_ids=payload.assign_profile_ids,
        owner_user_id=owner_uid
    )
    return {"inserted_count": inserted, "message": f"Đã nhập thành công {inserted} task."}


@app.delete("/api/tasks/{task_id}")
def delete_task_endpoint(task_id: int):
    success = database.delete_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Không tìm thấy task.")
    return {"message": "Đã xóa task."}


@app.post("/api/tasks/{task_id}/reset")
def reset_task_endpoint(task_id: int):
    success = database.reset_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Không tìm thấy task.")
    return {"message": "Đã reset task về trạng thái pending."}


# ==========================================
# 4. RUNNER CONTROLS (TEST RUNNER & TASK RUNNER)
# ==========================================

@app.post("/api/runner/test")
def run_test_endpoint(payload: RunTestReq):
    """
    CHẾ ĐỘ RUN TEST:
    Kiểm tra toàn diện OAuth, Page Token, quyền, video, caption.
    TUYỆT ĐỐI KHÔNG UPLOAD VÀ KHÔNG PUBLISH LÊN FACEBOOK.
    """
    return MetaTestRunner.run_test(
        facebook_page_ids=payload.facebook_page_ids,
        task_ids=payload.task_ids
    )


@app.post("/api/runner/start")
def run_tasks_endpoint(payload: Any = Body(...)):
    """
    CHẾ ĐỘ RUN TASK:
    Thực hiện upload và publish thật qua Meta Graph API theo đa luồng an toàn.
    """
    if isinstance(payload, dict):
        fb_page_ids = payload.get("facebook_page_ids")
        prof_ids = payload.get("profile_ids")
        threads = payload.get("threads", 3)
    else:
        fb_page_ids = getattr(payload, "facebook_page_ids", None)
        prof_ids = getattr(payload, "profile_ids", None)
        threads = getattr(payload, "threads", 3)

    if prof_ids:
        pending_legacy = database.get_pending_tasks(profile_ids=prof_ids)
        if not pending_legacy:
            raise HTTPException(status_code=400, detail="Không có task cần làm!")

    # Lấy danh sách Page được chọn
    target_page_ids = fb_page_ids
    if not target_page_ids:
        selected_pages = database.get_facebook_pages(only_selected=True)
        target_page_ids = [p["facebook_page_id"] for p in selected_pages if p.get("can_post")]

    if not target_page_ids:
        raise HTTPException(status_code=400, detail="Không có Fanpage nào được chọn hoặc có quyền đăng bài!")

    res = meta_runner.start_batch(facebook_page_ids=target_page_ids, threads=threads)
    if res.get("status") == "empty":
        raise HTTPException(status_code=400, detail="Không có task cần làm!")
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message"))

    return res


@app.post("/api/runner/stop")
def stop_tasks_endpoint():
    """Dừng khẩn cấp tiến trình đăng bài."""
    reset_count = meta_runner.stop()
    return {"status": "stopped", "message": f"Đã dừng toàn bộ tiến trình và reset {reset_count} task."}


# Tương thích ngược với các endpoint cũ
@app.post("/api/run")
def legacy_run_endpoint(payload: Any = Body(...)):
    return run_tasks_endpoint(payload)


@app.post("/api/stop")
def legacy_stop_endpoint():
    return stop_tasks_endpoint()


@app.patch("/api/profiles/{profile_id}")
def patch_profile_endpoint(profile_id: str, payload: ProfilePatchReq):
    new_name = payload.name.strip() if payload.name else ""
    if not new_name:
        raise HTTPException(status_code=400, detail="Tên profile không được để trống.")
    success = database.update_profile_name(profile_id, new_name)
    if not success:
        raise HTTPException(status_code=404, detail="Không tìm thấy profile.")
    return {"status": "success", "id": profile_id, "name": new_name}


@app.post("/api/profiles/bulk-create")
def bulk_create_profiles_endpoint(payload: ProfileBulkCreateReq):
    import profile_manager
    return profile_manager.bulk_create_profiles(payload.quantity)


@app.post("/api/profiles/bulk-delete")
def bulk_delete_profiles_endpoint(payload: ProfileBulkDeleteReq):
    import profile_manager
    return profile_manager.delete_profiles_bulk(payload.profile_ids)


@app.get("/api/status")
def get_status_endpoint(request: Request = None):
    user, owner_uid, is_admin = get_user_context(request)
    conn_status = get_connection_status(owner_user_id=owner_uid, is_admin=is_admin)
    all_accounts = database.get_facebook_accounts(owner_user_id=owner_uid, is_admin=is_admin)
    all_pages = database.get_facebook_pages(owner_user_id=owner_uid, is_admin=is_admin)
    all_tasks = database.get_tasks(owner_user_id=owner_uid, is_admin=is_admin)

    pending_tasks = [t for t in all_tasks if t["status"] == "pending"]
    success_tasks = [t for t in all_tasks if t["status"] == "success"]
    failed_tasks = [t for t in all_tasks if t["status"] == "failed"]
    running_tasks = [t for t in all_tasks if t["status"] == "running"]

    return {
        "user": user,
        "meta": conn_status,
        "accounts": all_accounts,
        "is_running": meta_runner.is_running,
        "total_accounts": len(all_accounts),
        "connected_accounts": len([a for a in all_accounts if a["status"] == "connected"]),
        "total_pages": len(all_pages),
        "selected_pages": len([p for p in all_pages if p.get("is_selected")]),
        "total_tasks": len(all_tasks),
        "pending_tasks": len(pending_tasks),
        "success_tasks": len(success_tasks),
        "failed_tasks": len(failed_tasks),
        "running_tasks": len(running_tasks)
    }


# ==========================================
# 5. SYSTEM & FILE HELPERS
# ==========================================

@app.post("/api/system/browse-file")
def browse_file_endpoint():
    path = system_helper.open_windows_file_dialog()
    return {"path": path}


@app.post("/api/system/check-files")
def check_files_endpoint(payload: FileCheckReq):
    result = system_helper.batch_check_files(payload.paths)
    return {"results": result}


# ==========================================
# 6. PUBLIC META POLICY PAGES & DATA DELETION
# (Không yêu cầu đăng nhập, HTTP 200 cho Meta Crawler)
# ==========================================

@app.get("/privacy", response_class=HTMLResponse)
def serve_privacy_page():
    path = os.path.join(STATIC_DIR, "privacy.html")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read(), status_code=200)
    return HTMLResponse("<h1>Chính Sách Quyền Riêng Tư - Quản lý fanpage</h1>", status_code=200)


@app.get("/terms", response_class=HTMLResponse)
def serve_terms_page():
    path = os.path.join(STATIC_DIR, "terms.html")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read(), status_code=200)
    return HTMLResponse("<h1>Điều Khoản Dịch Vụ - Quản lý fanpage</h1>", status_code=200)


@app.get("/data-deletion", response_class=HTMLResponse)
def serve_data_deletion_page():
    path = os.path.join(STATIC_DIR, "data-deletion.html")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read(), status_code=200)
    return HTMLResponse("<h1>Hướng Dẫn Xóa Dữ Liệu - Quản lý fanpage</h1>", status_code=200)


@app.post("/api/meta/data-deletion")
def meta_data_deletion_callback(request: Request = None):
    """
    Điểm đón Facebook Data Deletion Request Callback:
    Trả về URL tra cứu trạng thái và mã xác nhận theo chuẩn Meta Platform.
    """
    confirmation_code = f"DEL_{secrets.token_hex(8).upper()}"
    status_url = f"https://pagefb.namnangno.click/data-deletion-status?code={confirmation_code}"
    return JSONResponse({
        "url": status_url,
        "confirmation_code": confirmation_code
    })


@app.get("/data-deletion-status")
def data_deletion_status_endpoint(code: Optional[str] = None):
    return HTMLResponse(
        f"""
        <!DOCTYPE html>
        <html lang="vi" class="h-full bg-slate-950 text-slate-100">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Trạng Thái Xóa Dữ Liệu - Quản lý fanpage</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="h-full flex items-center justify-center p-4">
            <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-7 text-center shadow-2xl">
                <div class="h-12 w-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-4 text-2xl font-bold">✓</div>
                <h2 class="text-lg font-bold text-white mb-2">Yêu Cầu Xóa Dữ Liệu Đã Được Ghi Nhận</h2>
                <p class="text-xs text-slate-400 mb-4">Mã xác nhận: <code class="font-mono text-emerald-400 font-bold">{code or 'DEL_CONFIRMED'}</code></p>
                <p class="text-xs text-slate-300 mb-6 leading-relaxed">Toàn bộ dữ liệu phiên kết nối, token truy cập và liên kết Fanpage của bạn đã được xóa sạch hoàn toàn khỏi cơ sở dữ liệu hệ thống.</p>
                <a href="/login" class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold inline-block transition">
                    Về Trang Đăng Nhập
                </a>
            </div>
        </body>
        </html>
        """,
        status_code=200
    )


# ==========================================
# 7. NAVIGATION & GUI PAGES
# ==========================================

# Phục vụ giao diện tĩnh Web GUI
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
js_dir = os.path.join(STATIC_DIR, "js")
if os.path.exists(js_dir):
    app.mount("/js", StaticFiles(directory=js_dir), name="js")


@app.get("/login", response_class=HTMLResponse)
def serve_login(request: Request = None):
    """Trang Đăng Nhập / Đăng Ký Hệ Thống."""
    if request:
        user = get_current_user(request)
        if user:
            return RedirectResponse("/pages", status_code=302)
    login_file = os.path.join(STATIC_DIR, "login.html")
    if os.path.exists(login_file):
        with open(login_file, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>Trang Đăng Nhập</h1>")


@app.get("/pages", response_class=HTMLResponse)
def serve_pages_route(request: Request = None):
    """Trang Quản lý Tài khoản Facebook & Fanpage."""
    if request:
        user = get_current_user(request)
        if not user:
            return RedirectResponse("/login", status_code=302)
    index_file = os.path.join(STATIC_DIR, "index.html")
    with open(index_file, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/schedules", response_class=HTMLResponse)
def serve_schedules_route(request: Request = None):
    """Trang Quản lý & Hẹn lịch đăng Reels / Bài viết."""
    if request:
        user = get_current_user(request)
        if not user:
            return RedirectResponse("/login", status_code=302)
    index_file = os.path.join(STATIC_DIR, "index.html")
    with open(index_file, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/reels", response_class=HTMLResponse)
def serve_reels_route(request: Request = None):
    """Alias cho /schedules."""
    return serve_schedules_route(request)


@app.get("/")
def serve_index(request: Request = None):
    """Trang chủ: Tự động chuyển về /pages nếu đã đăng nhập, ngược lại chuyển sang /login."""
    if request:
        user = get_current_user(request)
        if not user:
            return RedirectResponse("/login", status_code=302)
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        with open(index_file, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>Facebook Reels Scheduler - Meta Graph API</h1>")
