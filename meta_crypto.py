import os
import base64
from typing import Optional
from cryptography.fernet import Fernet

KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".meta_key")


def _get_or_create_key() -> bytes:
    """
    Lấy hoặc tự động sinh khóa mã hóa đối xứng Fernet (AES-128-CBC + HMAC-SHA256).
    Ưu tiên biến môi trường META_ENCRYPTION_KEY, nếu không có sẽ lưu vào file bảo mật .meta_key.
    """
    env_key = os.getenv("META_ENCRYPTION_KEY")
    if env_key:
        raw_key = env_key.strip().encode("utf-8")
        try:
            # Kiểm tra key hợp lệ bằng cách tạo thử Fernet
            Fernet(raw_key)
            return raw_key
        except Exception:
            pass

    if os.path.exists(KEY_FILE):
        try:
            with open(KEY_FILE, "rb") as f:
                saved_key = f.read().strip()
                Fernet(saved_key)
                return saved_key
        except Exception:
            pass

    # Tự sinh key mới an toàn
    new_key = Fernet.generate_key()
    try:
        with open(KEY_FILE, "wb") as f:
            f.write(new_key)
    except Exception as e:
        print(f"[Crypto Warning] Không thể ghi .meta_key: {e}")
    return new_key


_cipher = Fernet(_get_or_create_key())


def encrypt_token(plain_token: Optional[str]) -> Optional[str]:
    """Mã hóa chuỗi Access Token trước khi lưu vào SQLite database."""
    if not plain_token:
        return None
    try:
        encrypted_bytes = _cipher.encrypt(plain_token.encode("utf-8"))
        return encrypted_bytes.decode("utf-8")
    except Exception as e:
        print(f"[Crypto Error] Lỗi mã hóa token: {e}")
        return None


def decrypt_token(encrypted_token: Optional[str]) -> Optional[str]:
    """Giải mã Access Token khi gọi Meta Graph API ở backend."""
    if not encrypted_token:
        return None
    try:
        decrypted_bytes = _cipher.decrypt(encrypted_token.encode("utf-8"))
        return decrypted_bytes.decode("utf-8")
    except Exception as e:
        print(f"[Crypto Error] Lỗi giải mã token: {e}")
        return None


def mask_token(token: Optional[str]) -> str:
    """Tạo chuỗi che giấu token an toàn cho mục đích kiểm tra trạng thái (không để lộ bí mật)."""
    if not token or len(token) < 12:
        return "********"
    return f"{token[:6]}...{token[-4:]}"

