import os
import secrets
import time
from typing import Dict, Any, Optional, Tuple, List
import requests
from dotenv import load_dotenv

import database
from meta_crypto import encrypt_token, decrypt_token, mask_token

# Tải cấu hình từ .env nếu có
load_dotenv()

DEFAULT_API_VERSION = "v19.0"
DEFAULT_SCOPES = [
    "public_profile",
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "pages_manage_engagement",
    "pages_read_user_content"
]

# Lưu trữ state CSRF tạm thời trong bộ nhớ kèm thông tin phiên kết nối (15 phút)
_csrf_states: Dict[str, Any] = {}


def get_meta_config() -> Dict[str, str]:
    """Lấy thông số cấu hình Meta Developer App từ biến môi trường."""
    app_id = os.getenv("META_APP_ID", "1469615908436980").strip()
    app_secret = os.getenv("META_APP_SECRET", "").strip()
    base_url = os.getenv("APP_BASE_URL", "https://namnangno.click").strip().rstrip("/")
    redirect_uri = os.getenv("META_REDIRECT_URI", f"{base_url}/api/meta/callback").strip()
    api_version = os.getenv("META_GRAPH_VERSION", os.getenv("META_GRAPH_API_VERSION", DEFAULT_API_VERSION)).strip() or DEFAULT_API_VERSION
    if not api_version.startswith("v"):
        api_version = f"v{api_version}"

    return {
        "app_id": app_id,
        "app_secret": app_secret,
        "base_url": base_url,
        "redirect_uri": redirect_uri,
        "api_version": api_version
    }


def generate_oauth_url(
    scopes: Optional[List[str]] = None,
    account_id: Optional[str] = None,
    user_id: Optional[str] = None,
    auth_type: Optional[str] = "rerequest"
) -> Dict[str, Any]:
    """
    Tạo URL đăng nhập Facebook OAuth 2.0 (Authorization Code Flow) kèm mã CSRF State riêng biệt.
    Mỗi lần gọi sẽ tạo một state mới độc lập gắn với user hiện tại, không ghi đè các tài khoản đã kết nối.
    """
    cfg = get_meta_config()
    if not cfg["app_id"]:
        return {
            "status": "error",
            "message": "Chưa cấu hình META_APP_ID trong biến môi trường (.env)."
        }

    # Sinh mã CSRF state ngẫu nhiên và lưu 15 phút kèm thông tin người dùng
    state = secrets.token_urlsafe(32)
    _csrf_states[state] = {
        "expire": time.time() + 900,
        "account_id": account_id,
        "user_id": user_id,
        "action": "reconnect" if account_id else "connect"
    }

    # Dọn dẹp các state đã hết hạn
    now = time.time()
    for s, info in list(_csrf_states.items()):
        exp = info["expire"] if isinstance(info, dict) else info
        if exp < now:
            _csrf_states.pop(s, None)

    req_scopes = scopes or DEFAULT_SCOPES
    scope_str = ",".join(req_scopes)

    oauth_url = (
        f"https://www.facebook.com/{cfg['api_version']}/dialog/oauth"
        f"?client_id={cfg['app_id']}"
        f"&redirect_uri={cfg['redirect_uri']}"
        f"&state={state}"
        f"&scope={scope_str}"
        f"&response_type=code"
    )

    if auth_type:
        oauth_url += f"&auth_type={auth_type}"

    return {
        "status": "success",
        "oauth_url": oauth_url,
        "state": state,
        "action": "reconnect" if account_id else "connect",
        "account_id": account_id,
        "user_id": user_id
    }


def pop_csrf_state(state: str) -> Optional[Dict[str, Any]]:
    """Lấy và xóa CSRF state (One-time consumption)."""
    if not state or state not in _csrf_states:
        return None
    state_info = _csrf_states.pop(state)
    expire = state_info["expire"] if isinstance(state_info, dict) else state_info
    if time.time() > expire:
        return None
    if isinstance(state_info, dict):
        return state_info
    return {"expire": state_info, "account_id": None, "action": "connect"}


def verify_csrf_state(state: str) -> bool:
    """Kiểm tra mã CSRF state để chống tấn công giả mạo yêu cầu (One-time check)."""
    data = pop_csrf_state(state)
    return data is not None


def exchange_code_for_token(code: str, state: str) -> Dict[str, Any]:
    """
    Đổi Authorization Code lấy User Access Token và nâng cấp lên Long-lived Token (60 ngày).
    Tất cả request được thực hiện ở Backend, App Secret không bao giờ lộ ra ngoài.
    Hỗ trợ kết nối nhiều tài khoản Facebook Admin khác nhau mà không ghi đè nhau.
    """
    state_data = pop_csrf_state(state)
    if not state_data:
        return {
            "status": "error",
            "message": "CSRF State không hợp lệ hoặc đã hết hạn. Vui lòng thử kết nối lại!"
        }

    cfg = get_meta_config()
    if not cfg["app_id"] or not cfg["app_secret"]:
        return {
            "status": "error",
            "message": "Thiếu META_APP_ID hoặc META_APP_SECRET ở backend."
        }

    # Bước 1: Đổi code lấy Short-lived User Token
    token_url = f"https://graph.facebook.com/{cfg['api_version']}/oauth/access_token"
    token_params = {
        "client_id": cfg["app_id"],
        "client_secret": cfg["app_secret"],
        "redirect_uri": cfg["redirect_uri"],
        "code": code
    }

    try:
        resp = requests.get(token_url, params=token_params, timeout=20)
        data = resp.json()
    except Exception as e:
        return {"status": "error", "message": f"Lỗi mạng khi kết nối Meta OAuth: {e}"}

    if "error" in data:
        err = data["error"]
        return {
            "status": "error",
            "message": f"Meta OAuth Error: {err.get('message', 'Không xác định')}"
        }

    short_token = data.get("access_token")
    if not short_token:
        return {"status": "error", "message": "Không nhận được access_token từ Meta."}

    # Bước 2: Nâng cấp lên Long-lived User Token (60 ngày)
    long_token = short_token
    expires_in_seconds = data.get("expires_in", 5184000)

    try:
        exchange_params = {
            "grant_type": "fb_exchange_token",
            "client_id": cfg["app_id"],
            "client_secret": cfg["app_secret"],
            "fb_exchange_token": short_token
        }
        long_resp = requests.get(token_url, params=exchange_params, timeout=20)
        long_data = long_resp.json()
        if "access_token" in long_data:
            long_token = long_data["access_token"]
            expires_in_seconds = long_data.get("expires_in", 5184000)
    except Exception as e:
        print(f"[OAuth Warning] Không thể nâng cấp long-lived token: {e}")

    token_expires_at = time.strftime(
        "%Y-%m-%d %H:%M:%S",
        time.localtime(time.time() + expires_in_seconds)
    )

    # Bước 3: Lấy thông tin tài khoản Facebook Admin (ID, Tên, Avatar)
    user_id = "unknown"
    user_name = "Facebook User"
    avatar_url = None
    try:
        me_resp = requests.get(
            f"https://graph.facebook.com/{cfg['api_version']}/me",
            params={"fields": "id,name,picture.type(large)", "access_token": long_token},
            timeout=15
        )
        me_data = me_resp.json()
        if "id" in me_data:
            user_id = str(me_data["id"])
            user_name = me_data.get("name", user_name)
            avatar_url = me_data.get("picture", {}).get("data", {}).get("url")
    except Exception as e:
        print(f"[OAuth Warning] Lỗi lấy thông tin /me: {e}")

    # Bước 4: Kiểm tra các quyền (scopes) đã được cấp
    granted_scopes: List[str] = []
    try:
        perm_resp = requests.get(
            f"https://graph.facebook.com/{cfg['api_version']}/me/permissions",
            params={"access_token": long_token},
            timeout=15
        )
        perm_data = perm_resp.json()
        if "data" in perm_data:
            for p in perm_data["data"]:
                if p.get("status") == "granted":
                    granted_scopes.append(p.get("permission", ""))
    except Exception as e:
        print(f"[OAuth Warning] Lỗi kiểm tra /me/permissions: {e}")

    # Bước 5: Mã hóa Access Token và lưu vào database facebook_accounts
    encrypted_token = encrypt_token(long_token)
    if not encrypted_token:
        return {"status": "error", "message": "Lỗi mã hóa token an toàn."}

    account = database.save_facebook_account(
        user_id=user_id,
        user_name=user_name,
        encrypted_token=encrypted_token,
        token_expires_at=token_expires_at,
        scopes=",".join(granted_scopes),
        account_id=state_data.get("account_id"),
        owner_user_id=state_data.get("user_id"),
        avatar_url=avatar_url
    )

    return {
        "status": "success",
        "message": f"Đã kết nối tài khoản Facebook Admin: {user_name} (ID: {user_id})",
        "account_id": account.get("id"),
        "user_name": user_name,
        "user_id": user_id,
        "avatar_url": avatar_url,
        "scopes": granted_scopes,
        "token_expires_at": token_expires_at,
        "account": account
    }


def get_connection_status(owner_user_id: Optional[str] = None, is_admin: bool = False) -> Dict[str, Any]:
    """Kiểm tra trạng thái kết nối các tài khoản Meta Admin (Tuyệt đối không để lộ token)."""
    cfg = get_meta_config()
    accounts = database.get_facebook_accounts(owner_user_id=owner_user_id, is_admin=is_admin)
    active_accounts = [a for a in accounts if a["status"] == "connected"]
    primary_acc = active_accounts[0] if active_accounts else (accounts[0] if accounts else None)

    return {
        "is_connected": len(active_accounts) > 0,
        "connected_count": len(active_accounts),
        "total_accounts": len(accounts),
        "accounts": accounts,
        "has_config": bool(cfg["app_id"] and cfg["app_secret"]),
        "app_id": cfg["app_id"],
        "api_version": cfg["api_version"],
        "redirect_uri": cfg["redirect_uri"],
        "user_name": primary_acc.get("user_name") if primary_acc else None,
        "user_id": primary_acc.get("user_id") if primary_acc else None,
        "scopes": primary_acc.get("scopes", []) if primary_acc else [],
        "token_expires_at": primary_acc.get("token_expires_at") if primary_acc else None,
        "status": primary_acc.get("status", "disconnected") if primary_acc else "disconnected"
    }


def disconnect_admin() -> Dict[str, Any]:
    """Ngắt kết nối toàn bộ Facebook Admin (hỗ trợ tương thích ngược)."""
    database.disconnect_meta()
    return {
        "status": "success",
        "message": "Đã ngắt kết nối Facebook Admin thành công."
    }


def disconnect_admin_account(account_id: str) -> Dict[str, Any]:
    """Ngắt kết nối 1 tài khoản Facebook Admin cụ thể."""
    success = database.disconnect_facebook_account(account_id)
    return {
        "status": "success" if success else "error",
        "account_id": account_id,
        "message": f"Đã ngắt kết nối tài khoản Facebook Admin {account_id}."
    }


def delete_admin_account(account_id: str) -> Dict[str, Any]:
    """Xóa hoàn toàn tài khoản Facebook Admin khỏi hệ thống."""
    success = database.delete_facebook_account_local(account_id)
    return {
        "status": "success" if success else "error",
        "account_id": account_id,
        "message": f"Đã xóa tài khoản Facebook Admin {account_id} khỏi hệ thống."
    }
