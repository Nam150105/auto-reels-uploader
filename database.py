import os
import sqlite3
import uuid
import hashlib
import hmac
import secrets
import time
from typing import List, Dict, Any, Optional, Tuple
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manager.db")


@contextmanager
def get_connection():
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    try:
        yield conn
    finally:
        conn.close()


# ==========================================
# USER AUTHENTICATION & MANAGEMENT
# ==========================================

def hash_password(password: str, salt: Optional[str] = None) -> Tuple[str, str]:
    if not salt:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000).hex()
    return pwd_hash, salt


def verify_password(password: str, salt: str, password_hash: str) -> bool:
    pwd_hash, _ = hash_password(password, salt)
    return hmac.compare_digest(pwd_hash, password_hash)


def generate_session_token(user_id: str, expire_seconds: int = 7 * 86400) -> str:
    secret = os.getenv("SECRET_KEY", "meta_scheduler_secret_key_2026")
    exp = int(time.time()) + expire_seconds
    raw = f"{user_id}:{exp}"
    sig = hmac.new(secret.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{user_id}:{exp}:{sig}"


def verify_session_token(token: str) -> Optional[str]:
    if not token or ":" not in token:
        return None
    parts = token.split(":")
    if len(parts) != 3:
        return None
    user_id, exp_str, sig = parts
    try:
        exp = int(exp_str)
        if time.time() > exp:
            return None
    except Exception:
        return None
    secret = os.getenv("SECRET_KEY", "meta_scheduler_secret_key_2026")
    raw = f"{user_id}:{exp_str}"
    expected_sig = hmac.new(secret.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()
    if hmac.compare_digest(sig, expected_sig):
        return user_id
    return None


def create_user(
    username: str,
    password: str,
    full_name: Optional[str] = None,
    email: Optional[str] = None,
    role: str = "user"
) -> Dict[str, Any]:
    clean_user = username.strip().lower()
    if not clean_user:
        raise ValueError("Tên đăng nhập không được để trống.")
    if len(password) < 4:
        raise ValueError("Mật khẩu phải có ít nhất 4 ký tự.")

    pwd_hash, salt = hash_password(password)
    user_id = f"usr_{uuid.uuid4().hex[:8]}"

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE username = ?", (clean_user,))
        if cursor.fetchone():
            raise ValueError(f"Tên đăng nhập '{clean_user}' đã tồn tại.")

        cursor.execute(
            """
            INSERT INTO users (id, username, password_hash, salt, full_name, email, role, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
            """,
            (user_id, clean_user, pwd_hash, salt, (full_name or clean_user).strip(), (email or "").strip(), role)
        )
        conn.commit()
    return get_user_by_id(user_id) or {}


def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, full_name, email, role, status, created_at FROM users WHERE id = ?",
            (str(user_id).strip(),)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, full_name, email, role, status, created_at FROM users WHERE username = ?",
            (str(username).strip().lower(),)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def verify_user_credentials(username: str, password: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, password_hash, salt, full_name, email, role, status FROM users WHERE username = ?",
            (str(username).strip().lower(),)
        )
        row = cursor.fetchone()
        if not row:
            return None
        if row["status"] != "active":
            return None
        if verify_password(password, row["salt"], row["password_hash"]):
            return {
                "id": row["id"],
                "username": row["username"],
                "full_name": row["full_name"],
                "email": row["email"],
                "role": row["role"],
                "status": row["status"]
            }
        return None


def get_all_users() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, full_name, email, role, status, created_at FROM users ORDER BY created_at ASC")
        return [dict(r) for r in cursor.fetchall()]


def ensure_default_admin() -> Dict[str, Any]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, full_name, email, role, status FROM users WHERE role = 'admin' LIMIT 1")
        admin = cursor.fetchone()
        if admin:
            return dict(admin)

        pwd_hash, salt = hash_password("admin123")
        admin_id = "usr_admin"
        cursor.execute(
            """
            INSERT OR IGNORE INTO users (id, username, password_hash, salt, full_name, email, role, status, created_at)
            VALUES (?, 'admin', ?, ?, 'Quản Trị Viên', 'admin@namnangno.click', 'admin', 'active', CURRENT_TIMESTAMP)
            """,
            (admin_id, pwd_hash, salt)
        )
        conn.commit()
    return get_user_by_id("usr_admin") or {}


def init_db() -> None:
    with get_connection() as conn:
        cursor = conn.cursor()

        # 0. Bảng users (Quản lý thành viên & Admin hệ thống)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                full_name TEXT,
                email TEXT,
                role TEXT DEFAULT 'user',
                status TEXT DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        cursor.execute("PRAGMA table_info(users);")
        existing_user_cols = [c[1] for c in cursor.fetchall()]
        user_cols_to_add = {
            "full_name": "TEXT",
            "email": "TEXT",
            "role": "TEXT DEFAULT 'user'",
            "status": "TEXT DEFAULT 'active'",
            "created_at": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        }
        for col, col_def in user_cols_to_add.items():
            if col not in existing_user_cols:
                try:
                    cursor.execute(f"ALTER TABLE users ADD COLUMN {col} {col_def};")
                except Exception:
                    pass

        # 1. Bảng profiles (Bảo toàn lịch sử dữ liệu cũ)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                user_agent TEXT,
                screen_resolution TEXT,
                status TEXT DEFAULT 'idle',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        cursor.execute("PRAGMA table_info(profiles);")
        existing_profile_cols = [c[1] for c in cursor.fetchall()]
        profile_cols_to_add = {
            "user_agent": "TEXT",
            "screen_resolution": "TEXT",
            "status": "TEXT DEFAULT 'idle'",
            "created_at": "TEXT"
        }
        for col, col_def in profile_cols_to_add.items():
            if col not in existing_profile_cols:
                try:
                    cursor.execute(f"ALTER TABLE profiles ADD COLUMN {col} {col_def};")
                except Exception:
                    pass

        # 2. Bảng facebook_accounts (Lưu trữ các tài khoản Facebook Admin kết nối OAuth)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS facebook_accounts (
                id TEXT PRIMARY KEY,
                user_id TEXT UNIQUE NOT NULL,
                user_name TEXT,
                encrypted_user_access_token TEXT NOT NULL,
                token_expires_at TEXT,
                scopes TEXT,
                status TEXT DEFAULT 'connected',
                owner_user_id TEXT,
                avatar_url TEXT,
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # Bảng meta_connections (Giữ để tương thích ngược)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS meta_connections (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                user_name TEXT,
                encrypted_user_access_token TEXT NOT NULL,
                token_expires_at TEXT,
                scopes TEXT,
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'connected'
            );
            """
        )

        # 3. Bảng facebook_pages (Lưu trữ danh sách Fanpage đồng bộ từ Meta Graph API - Không trùng page_id)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS facebook_pages (
                id TEXT PRIMARY KEY,
                facebook_page_id TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                category TEXT,
                encrypted_page_access_token TEXT NOT NULL,
                tasks TEXT,
                can_post INTEGER DEFAULT 1,
                connection_id TEXT,
                is_selected INTEGER DEFAULT 1,
                status TEXT DEFAULT 'connected',
                token_status TEXT DEFAULT 'valid',
                last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # Migration cho facebook_pages nếu bảng cũ đã tồn tại và thiếu cột
        cursor.execute("PRAGMA table_info(facebook_pages);")
        existing_fb_page_cols = [c[1] for c in cursor.fetchall()]
        fb_page_cols_to_add = {
            "category": "TEXT",
            "can_post": "INTEGER DEFAULT 1",
            "connection_id": "TEXT",
            "is_selected": "INTEGER DEFAULT 1",
            "status": "TEXT DEFAULT 'connected'",
            "token_status": "TEXT DEFAULT 'valid'",
            "avatar_url": "TEXT",
            "last_synced_at": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
            "created_at": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        }
        for col, col_def in fb_page_cols_to_add.items():
            if col not in existing_fb_page_cols:
                try:
                    cursor.execute(f"ALTER TABLE facebook_pages ADD COLUMN {col} {col_def};")
                except Exception:
                    pass
        cursor.execute("UPDATE facebook_pages SET token_status = 'valid' WHERE token_status IS NULL;")
        cursor.execute("UPDATE facebook_pages SET can_post = 1 WHERE can_post IS NULL;")
        cursor.execute("UPDATE facebook_pages SET is_selected = 1 WHERE is_selected IS NULL;")
        cursor.execute("UPDATE facebook_pages SET status = 'connected' WHERE status IS NULL;")

        # Migration cho facebook_accounts nếu bảng cũ thiếu cột
        cursor.execute("PRAGMA table_info(facebook_accounts);")
        existing_fb_acc_cols = [c[1] for c in cursor.fetchall()]
        fb_acc_cols_to_add = {
            "user_name": "TEXT",
            "token_expires_at": "TEXT",
            "scopes": "TEXT",
            "status": "TEXT DEFAULT 'connected'",
            "owner_user_id": "TEXT",
            "avatar_url": "TEXT",
            "connected_at": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
            "last_synced_at": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        }
        for col, col_def in fb_acc_cols_to_add.items():
            if col not in existing_fb_acc_cols:
                try:
                    cursor.execute(f"ALTER TABLE facebook_accounts ADD COLUMN {col} {col_def};")
                except Exception:
                    pass

        # 4. Bảng facebook_account_pages (Quan hệ Nhiều - Nhiều giữa Facebook Admin Account và Fanpage)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS facebook_account_pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id TEXT NOT NULL,
                facebook_page_id TEXT NOT NULL,
                encrypted_page_access_token TEXT NOT NULL,
                tasks TEXT,
                can_post INTEGER DEFAULT 1,
                token_status TEXT DEFAULT 'valid',
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (account_id) REFERENCES facebook_accounts (id) ON DELETE CASCADE,
                FOREIGN KEY (facebook_page_id) REFERENCES facebook_pages (facebook_page_id) ON DELETE CASCADE,
                UNIQUE(account_id, facebook_page_id)
            );
            """
        )

        # Migration cho facebook_account_pages nếu bảng cũ thiếu cột
        cursor.execute("PRAGMA table_info(facebook_account_pages);")
        existing_fap_cols = [c[1] for c in cursor.fetchall()]
        fap_cols_to_add = {
            "tasks": "TEXT",
            "can_post": "INTEGER DEFAULT 1",
            "token_status": "TEXT DEFAULT 'valid'",
            "synced_at": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        }
        for col, col_def in fap_cols_to_add.items():
            if col not in existing_fap_cols:
                try:
                    cursor.execute(f"ALTER TABLE facebook_account_pages ADD COLUMN {col} {col_def};")
                except Exception:
                    pass
        cursor.execute("UPDATE facebook_account_pages SET token_status = 'valid' WHERE token_status IS NULL;")
        cursor.execute("UPDATE facebook_account_pages SET can_post = 1 WHERE can_post IS NULL;")

        # Tạo chỉ mục tối ưu truy vấn
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fap_account ON facebook_account_pages(account_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fap_page ON facebook_account_pages(facebook_page_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fa_userid ON facebook_accounts(user_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_pages_fbpid ON facebook_pages(facebook_page_id);")

        # Migration: Đồng bộ dữ liệu cũ từ meta_connections sang facebook_accounts nếu có
        cursor.execute(
            """
            INSERT OR IGNORE INTO facebook_accounts (
                id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, status, connected_at, last_synced_at
            )
            SELECT id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, status, connected_at, connected_at
            FROM meta_connections
            WHERE user_id IS NOT NULL;
            """
        )

        # Migration: Đồng bộ liên kết facebook_account_pages từ connection_id cũ nếu có
        cursor.execute(
            """
            INSERT OR IGNORE INTO facebook_account_pages (
                account_id, facebook_page_id, encrypted_page_access_token, tasks, can_post, token_status, synced_at
            )
            SELECT connection_id, facebook_page_id, encrypted_page_access_token, tasks, can_post, 'valid', last_synced_at
            FROM facebook_pages
            WHERE connection_id IS NOT NULL AND connection_id IN (SELECT id FROM facebook_accounts);
            """
        )

        # 5. Bảng tasks (Nhiệm vụ đăng Reels)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id TEXT,
                facebook_page_id TEXT,
                video_path TEXT NOT NULL,
                caption TEXT,
                link_ac TEXT,
                comment_text TEXT,
                schedule_date TEXT,
                schedule_time TEXT,
                status TEXT DEFAULT 'pending',
                video_url TEXT,
                meta_video_id TEXT,
                meta_post_id TEXT,
                publish_mode TEXT DEFAULT 'now',
                error_message TEXT,
                log TEXT,
                done_time TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE SET NULL,
                FOREIGN KEY (facebook_page_id) REFERENCES facebook_pages (facebook_page_id) ON DELETE CASCADE
            );
            """
        )

        # Migration cho tasks nếu bảng cũ đã tồn tại
        cursor.execute("PRAGMA table_info(tasks);")
        existing_task_cols = [c[1] for c in cursor.fetchall()]

        task_cols_to_add = {
            "facebook_page_id": "TEXT",
            "link_ac": "TEXT",
            "comment_text": "TEXT",
            "video_url": "TEXT",
            "meta_video_id": "TEXT",
            "meta_post_id": "TEXT",
            "publish_mode": "TEXT DEFAULT 'now'",
            "error_message": "TEXT",
            "done_time": "TEXT",
            "owner_user_id": "TEXT"
        }
        for col, col_def in task_cols_to_add.items():
            if col not in existing_task_cols:
                try:
                    cursor.execute(f"ALTER TABLE tasks ADD COLUMN {col} {col_def};")
                except Exception:
                    pass

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tasks_page ON tasks(facebook_page_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fa_owner ON facebook_accounts(owner_user_id);")

        conn.commit()

    # Đảm bảo có sẵn tài khoản admin mặc định
    ensure_default_admin()

    # Gán các tài khoản FB và Task cũ chưa có owner sang admin
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE facebook_accounts SET owner_user_id = 'usr_admin' WHERE owner_user_id IS NULL;")
        cursor.execute("UPDATE tasks SET owner_user_id = 'usr_admin' WHERE owner_user_id IS NULL;")
        conn.commit()


# ==========================================
# FACEBOOK ACCOUNTS OPERATIONS (MULTI-ADMIN OAUTH)
# ==========================================

def save_facebook_account(
    user_id: str,
    user_name: Optional[str],
    encrypted_token: str,
    token_expires_at: Optional[str] = None,
    scopes: Optional[str] = None,
    account_id: Optional[str] = None,
    owner_user_id: Optional[str] = None,
    avatar_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    Lưu hoặc cập nhật thông tin tài khoản Facebook Admin:
    - Nếu user_id đã tồn tại: cập nhật token mới và kích hoạt lại (reconnect).
    - Nếu user_id chưa có: tạo một tài khoản Admin mới, KHÔNG ghi đè các tài khoản trước đó.
    """
    clean_uid = str(user_id).strip()
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM facebook_accounts WHERE user_id = ?", (clean_uid,))
        existing = cursor.fetchone()

        if existing:
            acc_id = existing["id"]
            cursor.execute(
                """
                UPDATE facebook_accounts SET
                    user_name = COALESCE(?, user_name),
                    encrypted_user_access_token = ?,
                    token_expires_at = ?,
                    scopes = COALESCE(?, scopes),
                    avatar_url = COALESCE(?, avatar_url),
                    owner_user_id = COALESCE(?, owner_user_id),
                    status = 'connected',
                    connected_at = CURRENT_TIMESTAMP,
                    last_synced_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (user_name, encrypted_token, token_expires_at, scopes, avatar_url, owner_user_id, acc_id)
            )
        else:
            acc_id = account_id or f"acc_{uuid.uuid4().hex[:8]}"
            cursor.execute(
                """
                INSERT INTO facebook_accounts (
                    id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, status, owner_user_id, avatar_url, connected_at, last_synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (acc_id, clean_uid, user_name, encrypted_token, token_expires_at, scopes, owner_user_id, avatar_url)
            )

        # Đồng bộ vào meta_connections để giữ tương thích ngược
        cursor.execute("DELETE FROM meta_connections WHERE user_id = ?", (clean_uid,))
        cursor.execute(
            """
            INSERT INTO meta_connections (
                id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'connected')
            """,
            (acc_id, clean_uid, user_name, encrypted_token, token_expires_at, scopes)
        )

        conn.commit()
    return get_facebook_account_by_id(acc_id) or {}


def save_meta_connection(
    user_id: str,
    user_name: Optional[str],
    encrypted_token: str,
    token_expires_at: Optional[str] = None,
    scopes: Optional[str] = None,
    conn_id: Optional[str] = None
) -> Dict[str, Any]:
    """Tương thích ngược: gọi trực tiếp save_facebook_account."""
    return save_facebook_account(
        user_id=user_id,
        user_name=user_name,
        encrypted_token=encrypted_token,
        token_expires_at=token_expires_at,
        scopes=scopes,
        account_id=conn_id
    )


def get_facebook_accounts(
    status: Optional[str] = None,
    owner_user_id: Optional[str] = None,
    is_admin: bool = False
) -> List[Dict[str, Any]]:
    """Lấy danh sách tất cả Facebook Admin Accounts kèm số lượng Page quản lý."""
    import time
    with get_connection() as conn:
        cursor = conn.cursor()
        query = """
            SELECT 
                fa.id,
                fa.user_id,
                fa.user_name,
                fa.token_expires_at,
                fa.scopes,
                fa.status,
                fa.owner_user_id,
                fa.avatar_url,
                fa.connected_at,
                fa.last_synced_at,
                COUNT(fap.id) AS managed_pages_count,
                COUNT(CASE WHEN fap.can_post = 1 AND fap.token_status = 'valid' THEN 1 END) AS postable_pages_count
            FROM facebook_accounts fa
            LEFT JOIN facebook_account_pages fap ON fa.id = fap.account_id
            WHERE 1=1
        """
        params = []
        if status:
            query += " AND fa.status = ?"
            params.append(status)

        if not is_admin and owner_user_id:
            query += " AND (fa.owner_user_id = ? OR fa.owner_user_id IS NULL)"
            params.append(owner_user_id)

        query += " GROUP BY fa.id ORDER BY fa.connected_at DESC"
        cursor.execute(query, params)
        rows = cursor.fetchall()

        now_ts = time.time()
        results = []
        for r in rows:
            acc = dict(r)
            acc["scopes"] = [s.strip() for s in (acc.get("scopes") or "").split(",") if s.strip()]
            
            # Tính số ngày còn lại của token
            exp_str = acc.get("token_expires_at")
            if exp_str:
                try:
                    exp_ts = time.mktime(time.strptime(exp_str, "%Y-%m-%d %H:%M:%S"))
                    diff_days = int((exp_ts - now_ts) / 86400)
                    acc["days_remaining"] = diff_days
                    if diff_days < 0 and acc["status"] == "connected":
                        acc["status"] = "expired"
                except Exception:
                    acc["days_remaining"] = None
            else:
                acc["days_remaining"] = None

            results.append(acc)
        return results


def get_facebook_account_by_id(account_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, status, owner_user_id, avatar_url, connected_at, last_synced_at
            FROM facebook_accounts
            WHERE id = ? OR user_id = ?
            LIMIT 1
            """,
            (str(account_id).strip(), str(account_id).strip())
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def get_active_meta_connection() -> Optional[Dict[str, Any]]:
    """Lấy tài khoản Facebook Admin đang kết nối mới nhất (hỗ trợ tương thích ngược)."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, user_id, user_name, encrypted_user_access_token, token_expires_at, scopes, connected_at, status
            FROM facebook_accounts
            WHERE status = 'connected'
            ORDER BY connected_at DESC
            LIMIT 1
            """
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def disconnect_facebook_account(account_id: str) -> bool:
    """
    Ngắt kết nối 1 tài khoản Facebook Admin:
    - Đánh dấu tài khoản sang trạng thái 'disconnected'.
    - Đánh dấu token_status = 'invalid' trong facebook_account_pages cho tài khoản này.
    - Với các Fanpage tài khoản này quản lý: Nếu vẫn CÒN Admin khác đang kết nối và có quyền, KHÔNG xóa Fanpage!
    """
    clean_aid = str(account_id).strip()
    with get_connection() as conn:
        cursor = conn.cursor()
        # 1. Tìm các Page mà Admin này quản lý
        cursor.execute(
            "SELECT facebook_page_id FROM facebook_account_pages WHERE account_id = ?",
            (clean_aid,)
        )
        affected_pages = [r["facebook_page_id"] for r in cursor.fetchall()]

        # 2. Cập nhật trạng thái account
        cursor.execute("UPDATE facebook_accounts SET status = 'disconnected' WHERE id = ?", (clean_aid,))
        cursor.execute("UPDATE meta_connections SET status = 'disconnected' WHERE id = ?", (clean_aid,))
        cursor.execute("UPDATE facebook_account_pages SET token_status = 'invalid' WHERE account_id = ?", (clean_aid,))

        # 3. Kiểm tra từng Page bị ảnh hưởng
        for pid in affected_pages:
            cursor.execute(
                """
                SELECT fap.encrypted_page_access_token, fap.tasks, fap.can_post
                FROM facebook_account_pages fap
                JOIN facebook_accounts fa ON fap.account_id = fa.id
                WHERE fap.facebook_page_id = ? AND fa.status = 'connected' AND fap.token_status = 'valid'
                ORDER BY fap.can_post DESC, fap.synced_at DESC
                LIMIT 1
                """,
                (pid,)
            )
            other_active = cursor.fetchone()
            if other_active:
                # Vẫn còn Admin khác có quyền: Giữ Page hoạt động, chuyển token sang Admin đó
                cursor.execute(
                    """
                    UPDATE facebook_pages SET
                        encrypted_page_access_token = ?,
                        tasks = ?,
                        can_post = ?,
                        status = 'connected'
                    WHERE facebook_page_id = ?
                    """,
                    (other_active["encrypted_page_access_token"], other_active["tasks"], other_active["can_post"], pid)
                )
            else:
                # Không còn Admin nào: đánh dấu Page disconnected, can_post = 0 (KHÔNG xóa tác vụ/bản ghi)
                cursor.execute(
                    "UPDATE facebook_pages SET can_post = 0, status = 'disconnected' WHERE facebook_page_id = ?",
                    (pid,)
                )

        conn.commit()
        return True


def delete_facebook_account_local(account_id: str) -> bool:
    """Xóa tài khoản Facebook Admin khỏi tool và cập nhật lại quan hệ các Fanpage."""
    clean_aid = str(account_id).strip()
    disconnect_facebook_account(clean_aid)
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM facebook_account_pages WHERE account_id = ?", (clean_aid,))
        cursor.execute("DELETE FROM facebook_accounts WHERE id = ?", (clean_aid,))
        cursor.execute("DELETE FROM meta_connections WHERE id = ?", (clean_aid,))
        conn.commit()
        return True


def disconnect_meta() -> bool:
    """Tương thích ngược: ngắt kết nối toàn bộ tài khoản Admin."""
    accounts = get_facebook_accounts()
    for acc in accounts:
        disconnect_facebook_account(acc["id"])
    return True


def update_meta_connection_status(conn_id: str, status: str) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE facebook_accounts SET status = ? WHERE id = ?", (status, conn_id))
        cursor.execute("UPDATE meta_connections SET status = ? WHERE id = ?", (status, conn_id))
        conn.commit()
        return cursor.rowcount > 0


# ==========================================
# FACEBOOK PAGES & RELATIONSHIPS OPERATIONS
# ==========================================

def upsert_facebook_page_and_relation(
    account_id: str,
    facebook_page_id: str,
    name: str,
    encrypted_page_access_token: str,
    tasks_json: str,
    can_post: int = 1,
    category: Optional[str] = None,
    avatar_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    Đồng bộ Fanpage theo mô hình Nhiều - Nhiều (Many-to-Many):
    1. Cập nhật bản ghi duy nhất trong bảng facebook_pages (Không bao giờ tạo 2 bản ghi cho cùng 1 page_id).
    2. Cập nhật quan hệ giữa Facebook Admin Account và Fanpage trong bảng facebook_account_pages.
    """
    clean_fbid = str(facebook_page_id).strip()
    clean_aid = str(account_id).strip()

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. Upsert bảng facebook_pages
        cursor.execute("SELECT id, is_selected, can_post FROM facebook_pages WHERE facebook_page_id = ?", (clean_fbid,))
        existing_page = cursor.fetchone()

        if existing_page:
            # Nếu page đã có, chỉ ghi đè token và can_post nếu token mới có quyền đăng (can_post = 1) hoặc page đang thiếu quyền
            should_update_token = (can_post == 1) or (existing_page["can_post"] == 0)
            if should_update_token:
                cursor.execute(
                    """
                    UPDATE facebook_pages SET
                        name = ?,
                        category = COALESCE(?, category),
                        avatar_url = COALESCE(?, avatar_url),
                        encrypted_page_access_token = ?,
                        tasks = ?,
                        can_post = ?,
                        status = 'connected',
                        token_status = 'valid',
                        last_synced_at = CURRENT_TIMESTAMP
                    WHERE facebook_page_id = ?
                    """,
                    (name.strip(), category, avatar_url, encrypted_page_access_token, tasks_json, can_post, clean_fbid)
                )
            else:
                cursor.execute(
                    """
                    UPDATE facebook_pages SET
                        name = ?,
                        category = COALESCE(?, category),
                        avatar_url = COALESCE(?, avatar_url),
                        status = 'connected',
                        last_synced_at = CURRENT_TIMESTAMP
                    WHERE facebook_page_id = ?
                    """,
                    (name.strip(), category, avatar_url, clean_fbid)
                )
        else:
            page_internal_id = f"page_{uuid.uuid4().hex[:8]}"
            cursor.execute(
                """
                INSERT INTO facebook_pages (
                    id, facebook_page_id, name, category, avatar_url, encrypted_page_access_token,
                    tasks, can_post, connection_id, is_selected, status, token_status, last_synced_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'connected', 'valid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (
                    page_internal_id,
                    clean_fbid,
                    name.strip(),
                    category,
                    avatar_url,
                    encrypted_page_access_token,
                    tasks_json,
                    can_post,
                    clean_aid
                )
            )

        # 2. Upsert quan hệ facebook_account_pages nếu account_id tồn tại
        cursor.execute("SELECT id FROM facebook_accounts WHERE id = ?", (clean_aid,))
        if cursor.fetchone():
            cursor.execute(
                """
                INSERT INTO facebook_account_pages (
                    account_id, facebook_page_id, encrypted_page_access_token, tasks, can_post, token_status, synced_at
                ) VALUES (?, ?, ?, ?, ?, 'valid', CURRENT_TIMESTAMP)
                ON CONFLICT(account_id, facebook_page_id) DO UPDATE SET
                    encrypted_page_access_token = excluded.encrypted_page_access_token,
                    tasks = excluded.tasks,
                    can_post = excluded.can_post,
                    token_status = 'valid',
                    synced_at = CURRENT_TIMESTAMP;
                """,
                (clean_aid, clean_fbid, encrypted_page_access_token, tasks_json, can_post)
            )

        conn.commit()

    return get_facebook_page_by_fb_id(clean_fbid) or {}


def upsert_facebook_page(
    facebook_page_id: str,
    name: str,
    encrypted_page_access_token: str,
    tasks_json: str,
    can_post: int = 1,
    connection_id: Optional[str] = None,
    category: Optional[str] = None,
    avatar_url: Optional[str] = None
) -> Dict[str, Any]:
    """Tương thích ngược: tự động gắn connection_id nếu có."""
    acc_id = connection_id
    if not acc_id:
        active = get_active_meta_connection()
        acc_id = active["id"] if active else "legacy_conn"
    return upsert_facebook_page_and_relation(
        account_id=acc_id,
        facebook_page_id=facebook_page_id,
        name=name,
        encrypted_page_access_token=encrypted_page_access_token,
        tasks_json=tasks_json,
        can_post=can_post,
        category=category,
        avatar_url=avatar_url
    )


def get_facebook_pages(
    account_ids: Optional[List[str]] = None,
    search: Optional[str] = None,
    status: Optional[str] = None,
    only_selected: bool = False,
    owner_user_id: Optional[str] = None,
    is_admin: bool = False
) -> List[Dict[str, Any]]:
    """
    Lấy danh sách Fanpage (Đã khử trùng lặp theo page_id), hỗ trợ:
    - Lọc theo 1 hoặc nhiều tài khoản Admin (account_ids).
    - Lọc theo User sở hữu (owner_user_id).
    - Tìm kiếm theo tên Page hoặc Page ID.
    - Kèm danh sách các Admin Account cùng quản lý Page này.
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        query = """
            SELECT 
                p.id,
                p.facebook_page_id,
                p.name,
                p.category,
                p.avatar_url,
                p.tasks,
                p.can_post,
                p.is_selected,
                p.status,
                p.token_status,
                p.last_synced_at,
                p.created_at,
                COUNT(CASE WHEN t.status = 'pending' THEN 1 END) AS pending_count,
                COUNT(t.id) AS total_tasks
            FROM facebook_pages p
            LEFT JOIN tasks t ON p.facebook_page_id = t.facebook_page_id
            WHERE 1=1
        """
        params: List[Any] = []

        # Phân quyền chặt chẽ: User chỉ thấy Page thuộc tài khoản Facebook do chính user kết nối
        if not is_admin and owner_user_id:
            query += """
                AND p.facebook_page_id IN (
                    SELECT fap.facebook_page_id 
                    FROM facebook_account_pages fap
                    JOIN facebook_accounts fa ON fap.account_id = fa.id
                    WHERE (fa.owner_user_id = ? OR fa.owner_user_id IS NULL)
                )
            """
            params.append(owner_user_id)

        # Lọc theo danh sách Admin Accounts được chọn (Tổng hợp & Khử trùng lặp)
        if account_ids:
            clean_aids = [str(a).strip() for a in account_ids if str(a).strip()]
            if clean_aids:
                placeholders = ",".join("?" for _ in clean_aids)
                query += f"""
                    AND p.facebook_page_id IN (
                        SELECT facebook_page_id FROM facebook_account_pages WHERE account_id IN ({placeholders})
                    )
                """
                params.extend(clean_aids)

        if search and search.strip():
            query += " AND (p.name LIKE ? OR p.facebook_page_id LIKE ?)"
            s = f"%{search.strip()}%"
            params.extend([s, s])

        if status and status.strip():
            if status == "can_post":
                query += " AND p.can_post = 1"
            else:
                query += " AND p.status = ?"
                params.append(status.strip())

        if only_selected:
            query += " AND p.is_selected = 1"

        query += " GROUP BY p.facebook_page_id ORDER BY p.name COLLATE NOCASE ASC"
        cursor.execute(query, params)
        rows = cursor.fetchall()

        # Truy vấn các Admin Account liên kết cho từng Page
        results = []
        for r in rows:
            page = dict(r)
            fbid = page["facebook_page_id"]

            cursor.execute(
                """
                SELECT 
                    fa.id AS account_id,
                    fa.user_id,
                    fa.user_name,
                    fa.owner_user_id,
                    fa.avatar_url,
                    fa.status AS account_status,
                    fap.can_post,
                    fap.token_status,
                    fap.synced_at
                FROM facebook_account_pages fap
                JOIN facebook_accounts fa ON fap.account_id = fa.id
                WHERE fap.facebook_page_id = ?
                ORDER BY fa.user_name ASC
                """,
                (fbid,)
            )
            admin_rows = cursor.fetchall()
            admins = [dict(ar) for ar in admin_rows]
            page["admin_accounts"] = admins
            page["admin_names"] = ", ".join(a["user_name"] for a in admins if a.get("user_name")) or "Chưa rõ"

            # Đảm bảo can_post = 1 nếu ít nhất 1 admin còn kết nối và đủ quyền
            any_active_can_post = any(
                a["account_status"] == "connected" and a["can_post"] == 1 and a["token_status"] == "valid"
                for a in admins
            )
            if admins and any_active_can_post:
                page["can_post"] = 1
            elif admins and not any_active_can_post:
                page["can_post"] = 0

            results.append(page)

        return results


def get_page_active_token(facebook_page_id: str) -> Optional[str]:
    """Lấy Page Access Token đang hoạt động và có quyền đăng bài tốt nhất cho Fanpage."""
    clean_fbid = str(facebook_page_id).strip()
    with get_connection() as conn:
        cursor = conn.cursor()
        # Ưu tiên lấy từ facebook_account_pages của tài khoản đang connected và can_post = 1
        cursor.execute(
            """
            SELECT fap.encrypted_page_access_token
            FROM facebook_account_pages fap
            JOIN facebook_accounts fa ON fap.account_id = fa.id
            WHERE fap.facebook_page_id = ? AND fa.status = 'connected' AND fap.can_post = 1 AND fap.token_status = 'valid'
            ORDER BY fap.synced_at DESC
            LIMIT 1
            """,
            (clean_fbid,)
        )
        row = cursor.fetchone()
        if row and row["encrypted_page_access_token"]:
            return row["encrypted_page_access_token"]

        # Fallback lấy từ bảng facebook_pages
        cursor.execute(
            "SELECT encrypted_page_access_token FROM facebook_pages WHERE facebook_page_id = ?",
            (clean_fbid,)
        )
        p_row = cursor.fetchone()
        return p_row["encrypted_page_access_token"] if p_row else None


def get_facebook_page_by_id(page_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT * FROM facebook_pages WHERE id = ?
            """,
            (str(page_id).strip(),)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def get_facebook_page_by_fb_id(facebook_page_id: str) -> Optional[Dict[str, Any]]:
    pages = get_facebook_pages(search=str(facebook_page_id).strip())
    for p in pages:
        if p["facebook_page_id"] == str(facebook_page_id).strip():
            return p
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM facebook_pages WHERE facebook_page_id = ?",
            (str(facebook_page_id).strip(),)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def update_page_selection(facebook_page_id: str, is_selected: bool) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE facebook_pages SET is_selected = ? WHERE facebook_page_id = ? OR id = ?",
            (1 if is_selected else 0, str(facebook_page_id).strip(), str(facebook_page_id).strip())
        )
        conn.commit()
        return cursor.rowcount > 0


def bulk_update_page_selection(
    is_selected: bool,
    facebook_page_ids: Optional[List[str]] = None,
    account_ids: Optional[List[str]] = None
) -> int:
    with get_connection() as conn:
        cursor = conn.cursor()
        val = 1 if is_selected else 0

        if facebook_page_ids:
            clean_ids = [str(pid).strip() for pid in facebook_page_ids if str(pid).strip()]
            if not clean_ids:
                return 0
            placeholders = ",".join("?" for _ in clean_ids)
            cursor.execute(
                f"UPDATE facebook_pages SET is_selected = ? WHERE facebook_page_id IN ({placeholders}) OR id IN ({placeholders})",
                [val] + clean_ids + clean_ids
            )
        elif account_ids:
            clean_aids = [str(a).strip() for a in account_ids if str(a).strip()]
            if clean_aids:
                placeholders = ",".join("?" for _ in clean_aids)
                cursor.execute(
                    f"""
                    UPDATE facebook_pages SET is_selected = ? 
                    WHERE facebook_page_id IN (
                        SELECT facebook_page_id FROM facebook_account_pages WHERE account_id IN ({placeholders})
                    )
                    """,
                    [val] + clean_aids
                )
            else:
                cursor.execute("UPDATE facebook_pages SET is_selected = ?", (val,))
        else:
            cursor.execute("UPDATE facebook_pages SET is_selected = ?", (val,))

        conn.commit()
        return cursor.rowcount


def delete_facebook_page_local(facebook_page_id: str) -> bool:
    """Xóa Page khỏi danh sách quản lý của ứng dụng (KHÔNG xóa Page thực tế trên Facebook)."""
    clean_fbid = str(facebook_page_id).strip()
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM facebook_account_pages WHERE facebook_page_id = ?", (clean_fbid,))
        cursor.execute("DELETE FROM facebook_pages WHERE facebook_page_id = ? OR id = ?", (clean_fbid, clean_fbid))
        conn.commit()
        return cursor.rowcount > 0


def update_facebook_page_status(facebook_page_id: str, status: str) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE facebook_pages SET status = ? WHERE facebook_page_id = ? OR id = ?",
            (status, str(facebook_page_id).strip(), str(facebook_page_id).strip())
        )
        conn.commit()
        return cursor.rowcount > 0


# ==========================================
# PROFILES OPERATIONS (BẢO TOÀN LỊCH SỬ)
# ==========================================

def get_profiles(search: Optional[str] = None) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        query = """
            SELECT 
                p.id, 
                p.name, 
                p.user_agent, 
                p.screen_resolution, 
                p.status, 
                p.created_at,
                COUNT(CASE WHEN t.status = 'pending' THEN 1 END) AS pending_count,
                COUNT(t.id) AS total_tasks
            FROM profiles p
            LEFT JOIN tasks t ON p.id = t.profile_id
            WHERE 1=1
        """
        params = []
        if search and search.strip():
            query += " AND (p.id LIKE ? OR p.name LIKE ?)"
            s = f"%{search.strip()}%"
            params.extend([s, s])

        query += " GROUP BY p.id ORDER BY CAST(p.id AS INTEGER) ASC, p.id ASC"
        cursor.execute(query, params)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]


def get_profile(profile_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, name, user_agent, screen_resolution, status, created_at FROM profiles WHERE id = ?",
            (str(profile_id).strip(),)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def add_profile(
    profile_id: str,
    name: str,
    user_agent: Optional[str] = None,
    screen_resolution: Optional[str] = None,
    status: str = "idle"
) -> Dict[str, Any]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO profiles (id, name, user_agent, screen_resolution, status)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
                name = excluded.name,
                user_agent = COALESCE(excluded.user_agent, profiles.user_agent),
                screen_resolution = COALESCE(excluded.screen_resolution, profiles.screen_resolution);
            """,
            (str(profile_id).strip(), name.strip(), user_agent, screen_resolution, status)
        )
        conn.commit()
    return get_profile(profile_id) or {}


def update_profile_status(profile_id: str, status: str) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE profiles SET status = ? WHERE id = ?", (status, str(profile_id).strip()))
        conn.commit()
        return cursor.rowcount > 0


def update_profile_name(profile_id: str, name: str) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE profiles SET name = ? WHERE id = ?", (name.strip(), str(profile_id).strip()))
        conn.commit()
        return cursor.rowcount > 0


def update_profile(
    profile_id: str,
    name: Optional[str] = None,
    user_agent: Optional[str] = None,
    screen_resolution: Optional[str] = None,
    status: Optional[str] = None
) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        current = get_profile(profile_id)
        if not current:
            return False
        cursor.execute(
            """
            UPDATE profiles SET
                name = COALESCE(?, name),
                user_agent = COALESCE(?, user_agent),
                screen_resolution = COALESCE(?, screen_resolution),
                status = COALESCE(?, status)
            WHERE id = ?
            """,
            (name, user_agent, screen_resolution, status, str(profile_id).strip())
        )
        conn.commit()
        return cursor.rowcount > 0


def delete_profile(profile_id: str) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM tasks WHERE profile_id = ?", (str(profile_id).strip(),))
        cursor.execute("DELETE FROM profiles WHERE id = ?", (str(profile_id).strip(),))
        conn.commit()
        return cursor.rowcount > 0


def delete_profiles_bulk(profile_ids: List[str]) -> int:
    clean_ids = [str(pid).strip() for pid in profile_ids if str(pid).strip()]
    if not clean_ids:
        return 0
    placeholders = ",".join("?" for _ in clean_ids)
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(f"DELETE FROM tasks WHERE profile_id IN ({placeholders})", clean_ids)
        cursor.execute(f"DELETE FROM profiles WHERE id IN ({placeholders})", clean_ids)
        conn.commit()
        return cursor.rowcount


# ==========================================
# TASKS OPERATIONS (FACEBOOK REELS PUBLISH)
# ==========================================

def get_tasks(
    profile_id: Optional[str] = None,
    facebook_page_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    owner_user_id: Optional[str] = None,
    is_admin: bool = False
) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        query = """
            SELECT 
                t.id,
                t.profile_id,
                t.facebook_page_id,
                COALESCE(p.name, legacy_p.name) AS page_name,
                t.video_path,
                t.caption,
                t.link_ac,
                t.comment_text,
                t.schedule_date,
                t.schedule_time,
                t.status,
                t.video_url,
                t.meta_video_id,
                t.meta_post_id,
                t.publish_mode,
                t.error_message,
                t.log,
                t.done_time,
                t.owner_user_id,
                t.created_at
            FROM tasks t
            LEFT JOIN facebook_pages p ON t.facebook_page_id = p.facebook_page_id
            LEFT JOIN profiles legacy_p ON t.profile_id = legacy_p.id
            WHERE 1=1
        """
        params: List[Any] = []

        if not is_admin and owner_user_id:
            query += " AND (t.owner_user_id = ? OR t.owner_user_id IS NULL)"
            params.append(owner_user_id)

        if facebook_page_id:
            query += " AND t.facebook_page_id = ?"
            params.append(str(facebook_page_id).strip())
        if profile_id:
            query += " AND t.profile_id = ?"
            params.append(str(profile_id).strip())
        if status:
            query += " AND t.status = ?"
            params.append(status.strip())
        if search and search.strip():
            query += " AND (t.caption LIKE ? OR t.video_path LIKE ? OR t.comment_text LIKE ? OR CAST(t.id AS TEXT) LIKE ?)"
            s = f"%{search.strip()}%"
            params.extend([s, s, s, s])

        query += " ORDER BY t.id DESC"
        cursor.execute(query, params)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]


def get_task(task_id: int) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT 
                t.id,
                t.profile_id,
                t.facebook_page_id,
                COALESCE(p.name, legacy_p.name) AS page_name,
                t.video_path,
                t.caption,
                t.link_ac,
                t.comment_text,
                t.schedule_date,
                t.schedule_time,
                t.status,
                t.video_url,
                t.meta_video_id,
                t.meta_post_id,
                t.publish_mode,
                t.error_message,
                t.log,
                t.done_time,
                t.owner_user_id,
                t.created_at
            FROM tasks t
            LEFT JOIN facebook_pages p ON t.facebook_page_id = p.facebook_page_id
            LEFT JOIN profiles legacy_p ON t.profile_id = legacy_p.id
            WHERE t.id = ?
            """,
            (task_id,)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def add_task(
    profile_id: Optional[str] = None,
    facebook_page_id: Optional[str] = None,
    video_path: str = "",
    caption: str = "",
    link_ac: str = "",
    comment_text: str = "",
    schedule_date: str = "",
    schedule_time: str = "",
    publish_mode: str = "now",
    owner_user_id: Optional[str] = None
) -> int:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO tasks (
                profile_id, facebook_page_id, video_path, caption, link_ac, comment_text,
                schedule_date, schedule_time, status, publish_mode, video_url, log, done_time, owner_user_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)
            """,
            (
                str(profile_id).strip() if profile_id else None,
                str(facebook_page_id).strip() if facebook_page_id else None,
                video_path.strip(),
                caption.strip() if caption else "",
                link_ac.strip() if link_ac else "",
                comment_text.strip() if comment_text else "",
                schedule_date.strip() if schedule_date else "",
                schedule_time.strip() if schedule_time else "",
                publish_mode,
                str(owner_user_id).strip() if owner_user_id else None
            )
        )
        conn.commit()
        return cursor.lastrowid


def update_task(
    task_id: int,
    facebook_page_id: Optional[str] = None,
    profile_id: Optional[str] = None,
    video_path: Optional[str] = None,
    caption: Optional[str] = None,
    link_ac: Optional[str] = None,
    comment_text: Optional[str] = None,
    schedule_date: Optional[str] = None,
    schedule_time: Optional[str] = None,
    publish_mode: Optional[str] = None
) -> bool:
    current = get_task(task_id)
    if not current:
        return False

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE tasks SET
                facebook_page_id = ?,
                profile_id = ?,
                video_path = ?,
                caption = ?,
                link_ac = ?,
                comment_text = ?,
                schedule_date = ?,
                schedule_time = ?,
                publish_mode = ?
            WHERE id = ?
            """,
            (
                str(facebook_page_id).strip() if facebook_page_id is not None else current["facebook_page_id"],
                str(profile_id).strip() if profile_id is not None else current["profile_id"],
                video_path.strip() if video_path else current["video_path"],
                caption if caption is not None else current["caption"],
                link_ac if link_ac is not None else current["link_ac"],
                comment_text if comment_text is not None else current["comment_text"],
                schedule_date if schedule_date is not None else current["schedule_date"],
                schedule_time if schedule_time is not None else current["schedule_time"],
                publish_mode if publish_mode is not None else current["publish_mode"],
                task_id
            )
        )
        conn.commit()
        return cursor.rowcount > 0


def add_tasks_bulk(
    tasks_list: List[Dict[str, Any]],
    assign_page_ids: Optional[List[str]] = None,
    assign_profile_ids: Optional[List[str]] = None,
    owner_user_id: Optional[str] = None
) -> int:
    if not tasks_list:
        return 0

    inserted_count = 0
    with get_connection() as conn:
        cursor = conn.cursor()
        values = []

        target_pages = [str(p).strip() for p in (assign_page_ids or []) if str(p).strip()]
        target_profiles = [str(p).strip() for p in (assign_profile_ids or []) if str(p).strip()]
        clean_owner = str(owner_user_id).strip() if owner_user_id else None

        for i, item in enumerate(tasks_list):
            if target_pages:
                page_id = target_pages[i % len(target_pages)]
            else:
                raw_pid = item.get("facebook_page_id")
                page_id = str(raw_pid).strip() if raw_pid else None

            if target_profiles:
                profile_id = target_profiles[i % len(target_profiles)]
            else:
                raw_prof = item.get("profile_id")
                profile_id = str(raw_prof).strip() if raw_prof else None

            video_path = str(item.get("video_path", "")).strip()
            caption = str(item.get("caption", "")).strip()
            link_ac = str(item.get("link_ac", "")).strip()
            comment_text = str(item.get("comment_text", "")).strip()
            schedule_date = str(item.get("schedule_date", "")).strip()
            schedule_time = str(item.get("schedule_time", "")).strip()
            publish_mode = str(item.get("publish_mode", "now")).strip()
            item_owner = str(item.get("owner_user_id", "")).strip() or clean_owner

            if not video_path:
                continue

            values.append((
                profile_id, page_id, video_path, caption, link_ac, comment_text,
                schedule_date, schedule_time, 'pending', publish_mode, None, None, None, item_owner
            ))

        if values:
            cursor.executemany(
                """
                INSERT INTO tasks (
                    profile_id, facebook_page_id, video_path, caption, link_ac, comment_text,
                    schedule_date, schedule_time, status, publish_mode, video_url, log, done_time, owner_user_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values
            )
            conn.commit()
            inserted_count = len(values)

    return inserted_count


def delete_task(task_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        return cursor.rowcount > 0


def reset_task(task_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE tasks SET 
                status = 'pending', 
                log = NULL, 
                video_url = NULL, 
                meta_video_id = NULL,
                meta_post_id = NULL,
                error_message = NULL,
                done_time = NULL 
            WHERE id = ?
            """,
            (task_id,)
        )
        conn.commit()
        return cursor.rowcount > 0


def reset_running_tasks() -> int:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE tasks SET status = 'pending', log = 'Đã dừng khẩn cấp' WHERE status = 'running'")
        task_count = cursor.rowcount
        conn.commit()
        return task_count


def update_task_status(
    task_id: int,
    status: str,
    log: Optional[str] = None,
    video_url: Optional[str] = None,
    meta_video_id: Optional[str] = None,
    meta_post_id: Optional[str] = None,
    error_message: Optional[str] = None,
    done_time: Optional[str] = None
) -> None:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE tasks SET 
                status = ?, 
                log = COALESCE(?, log),
                video_url = COALESCE(?, video_url),
                meta_video_id = COALESCE(?, meta_video_id),
                meta_post_id = COALESCE(?, meta_post_id),
                error_message = COALESCE(?, error_message),
                done_time = COALESCE(?, done_time)
            WHERE id = ?
            """,
            (status, log, video_url, meta_video_id, meta_post_id, error_message, done_time, task_id)
        )
        conn.commit()


def get_pending_tasks(
    facebook_page_ids: Optional[List[str]] = None,
    profile_ids: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()
        query = """
            SELECT 
                t.*,
                COALESCE(p.name, legacy_p.name) AS page_name,
                p.encrypted_page_access_token,
                p.can_post
            FROM tasks t
            LEFT JOIN facebook_pages p ON t.facebook_page_id = p.facebook_page_id
            LEFT JOIN profiles legacy_p ON t.profile_id = legacy_p.id
            WHERE t.status = 'pending'
        """
        params: List[Any] = []
        conditions = []

        if facebook_page_ids:
            clean_page_ids = [str(pid).strip() for pid in facebook_page_ids if str(pid).strip()]
            if clean_page_ids:
                placeholders = ",".join("?" for _ in clean_page_ids)
                conditions.append(f"t.facebook_page_id IN ({placeholders})")
                params.extend(clean_page_ids)

        if profile_ids:
            clean_prof_ids = [str(pid).strip() for pid in profile_ids if str(pid).strip()]
            if clean_prof_ids:
                placeholders = ",".join("?" for _ in clean_prof_ids)
                conditions.append(f"t.profile_id IN ({placeholders})")
                params.extend(clean_prof_ids)

        if conditions:
            query += " AND (" + " OR ".join(conditions) + ")"

        query += " ORDER BY t.id ASC"
        cursor.execute(query, params)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
