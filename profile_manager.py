import os
import time
import shutil
import random
import subprocess
from typing import Dict, Any, List, Optional
import database

GEMLOGIN_CHROME_EXE = r"C:\Users\phamt\.gemlogin\browser\150\Chrome-bin\chrome.exe"
PROFILES_ROOT = r"E:\TOOL QUẢN LÝ PAGE\profiles"
TEMPLATE_PROFILE_PATH = r"E:\TOOL QUẢN LÝ PAGE\profiles\template\1"

# Lưu trữ các tiến trình Chrome mở thủ công theo profile_id: {profile_id_str: subprocess.Popen}
manual_processes: Dict[str, subprocess.Popen] = {}


def generate_random_user_agent() -> str:
    """Tự sinh User-Agent ngẫu nhiên cho Chrome trên Windows 10/11 (phiên bản 140 - 150)."""
    chrome_version = random.randint(140, 150)
    build_num = random.randint(1000, 9999)
    patch_num = random.randint(10, 199)
    os_ver = random.choice(["Windows NT 10.0; Win64; x64", "Windows NT 10.0; WOW64"])
    return f"Mozilla/5.0 ({os_ver}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chrome_version}.0.{build_num}.{patch_num} Safari/537.36"


def generate_random_resolution() -> str:
    """Tự sinh độ phân giải màn hình phổ biến."""
    resolutions = ["1920x1080", "1600x900", "1366x768", "1536x864", "2560x1440"]
    return random.choice(resolutions)


def get_profile_folder_path(profile_id: str) -> str:
    """Xác định đường dẫn thư mục profile độc lập tại E:\\TOOL QUẢN LÝ PAGE\\profiles."""
    return os.path.join(PROFILES_ROOT, str(profile_id).strip())


def remove_stale_profile_locks(profile_path: str) -> None:
    """
    Xóa file SingletonLock, SingletonCookie, SingletonSocket, LOCK
    để tránh kẹt profile Chrome khi tiến trình trước đó đã đóng.
    """
    if not os.path.isdir(profile_path):
        return
    for lock_name in ["SingletonLock", "SingletonCookie", "SingletonSocket", "LOCK"]:
        lock_file = os.path.join(profile_path, lock_name)
        if os.path.exists(lock_file):
            try:
                os.remove(lock_file)
            except Exception:
                pass


def sync_manual_processes() -> Dict[str, int]:
    """
    Đồng bộ trạng thái các tiến trình mở tay:
    Nếu người dùng tự tắt cửa sổ trình duyệt (X), tự động dọn dẹp và reset status về 'idle'.
    Trả về dict {profile_id: pid} của các tiến trình đang còn sống.
    """
    active_pids: Dict[str, int] = {}
    for pid_str, proc in list(manual_processes.items()):
        if proc.poll() is None:
            active_pids[pid_str] = proc.pid
        else:
            # Process đã kết thúc
            manual_processes.pop(pid_str, None)
            profile_path = get_profile_folder_path(pid_str)
            remove_stale_profile_locks(profile_path)
            prof = database.get_profile(pid_str)
            if prof and prof.get("status") == "running_manual":
                database.update_profile_status(pid_str, "idle")
    return active_pids


def get_next_available_profile_id() -> str:
    """Tìm ID số tiếp theo chưa được sử dụng."""
    existing_profiles = database.get_profiles()
    used_ids = set()
    for p in existing_profiles:
        try:
            used_ids.add(int(p["id"]))
        except ValueError:
            pass
    if os.path.exists(PROFILES_ROOT):
        for entry in os.listdir(PROFILES_ROOT):
            if entry.lower() != "template" and os.path.isdir(os.path.join(PROFILES_ROOT, entry)):
                try:
                    used_ids.add(int(entry))
                except ValueError:
                    pass
    next_id = 1
    while next_id in used_ids:
        next_id += 1
    return str(next_id)


def open_profile_manual(profile_id: str) -> Dict[str, Any]:
    """
    Mở Profile Thủ Công (Manual Mode):
    Mở cửa sổ Chrome độc lập tối đa hóa để người dùng tự thao tác:
    Đăng nhập Facebook, vượt checkpoint, lưu tài khoản.
    """
    profile_id_str = str(profile_id).strip()
    profile_path = get_profile_folder_path(profile_id_str)
    
    # Nếu thư mục chưa tồn tại, tự động tạo mới từ template hoặc thư mục trống
    if not os.path.exists(profile_path):
        os.makedirs(profile_path, exist_ok=True)
        if os.path.exists(TEMPLATE_PROFILE_PATH):
            try:
                shutil.copytree(
                    TEMPLATE_PROFILE_PATH,
                    profile_path,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("*.lock", "SingletonLock", "LOCK")
                )
            except Exception as e:
                print(f"[Warning] Copy template failed: {e}")

    # Đóng tiến trình cũ nếu đang mở để tránh đụng độ SingletonLock
    close_profile_manual(profile_id_str)
    remove_stale_profile_locks(profile_path)

    if not os.path.exists(GEMLOGIN_CHROME_EXE):
        raise FileNotFoundError(f"Không tìm thấy Chrome GemLogin tại: {GEMLOGIN_CHROME_EXE}")

    cmd = [
        GEMLOGIN_CHROME_EXE,
        f"--user-data-dir={profile_path}",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized"
    ]

    process = subprocess.Popen(cmd)
    manual_processes[profile_id_str] = process
    database.update_profile_status(profile_id_str, "running_manual")

    return {
        "status": "opened",
        "profile_id": profile_id_str,
        "pid": process.pid,
        "folder": profile_path,
        "message": f"Đã mở trình duyệt thủ công cho Profile {profile_id_str} (PID: {process.pid})"
    }


def close_profile_manual(profile_id: str) -> bool:
    """Đóng tiến trình Chrome mở thủ công của profile và giải phóng lock."""
    profile_id_str = str(profile_id).strip()
    proc = manual_processes.get(profile_id_str)
    terminated = False
    if proc:
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
            terminated = True
        except Exception:
            try:
                proc.kill()
                terminated = True
            except Exception:
                pass
        manual_processes.pop(profile_id_str, None)

    profile_path = get_profile_folder_path(profile_id_str)
    remove_stale_profile_locks(profile_path)

    database.update_profile_status(profile_id_str, "idle")
    return terminated


def delete_profile_physical(profile_id: str) -> None:
    """Đóng tiến trình Chrome mở thủ công và xóa thư mục profile trên ổ cứng, chống kẹt lock Windows."""
    profile_id_str = str(profile_id).strip()
    close_profile_manual(profile_id_str)
    profile_path = get_profile_folder_path(profile_id_str)
    if os.path.exists(profile_path) and profile_id_str.lower() != "template":
        for attempt in range(3):
            try:
                shutil.rmtree(profile_path)
                break
            except Exception:
                time.sleep(0.1)
                if attempt == 2:
                    shutil.rmtree(profile_path, ignore_errors=True)


def delete_profiles_bulk(profile_ids: List[str]) -> Dict[str, Any]:
    """Xóa hàng loạt profile: kill process, xóa thư mục vật lý, xóa record trong database."""
    deleted_ids = []
    for pid in profile_ids:
        pid_str = str(pid).strip()
        if not pid_str:
            continue
        delete_profile_physical(pid_str)
        deleted_ids.append(pid_str)

    deleted_count = database.delete_profiles_bulk(deleted_ids)
    return {
        "status": "success",
        "deleted_count": deleted_count,
        "deleted_ids": deleted_ids,
        "message": f"Đã xóa thành công {deleted_count} profile cùng thư mục dữ liệu và task liên quan."
    }


def clone_profile(source_id: str, new_id: str, new_name: str) -> Dict[str, Any]:
    """
    Clone Profile (Nhân bản giữ nguyên Cookie & Session):
    Sao chép toàn bộ thư mục profile nguồn sang thư mục mới bằng shutil.copytree.
    """
    source_id_str = str(source_id).strip()
    new_id_str = str(new_id).strip()
    new_name_str = new_name.strip()

    if not new_id_str:
        new_id_str = get_next_available_profile_id()
    if not new_name_str:
        new_name_str = f"Clone of {source_id_str}"

    src_path = get_profile_folder_path(source_id_str)
    if not os.path.exists(src_path):
        raise FileNotFoundError(f"Không tìm thấy thư mục profile nguồn: {src_path}")

    dest_path = os.path.join(PROFILES_ROOT, new_id_str)
    if os.path.exists(dest_path):
        raise FileExistsError(f"Thư mục Profile đích đã tồn tại: {dest_path}")

    # Copy giữ nguyên toàn bộ cookies, local storage
    shutil.copytree(
        src_path,
        dest_path,
        ignore=shutil.ignore_patterns("*.lock", "SingletonLock", "LOCK", "Crashpad", "GPUCache")
    )

    # Lấy thông số từ profile nguồn hoặc sinh mới
    src_profile = database.get_profile(source_id_str)
    ua = src_profile.get("user_agent") if src_profile else generate_random_user_agent()
    res = src_profile.get("screen_resolution") if src_profile else generate_random_resolution()

    created = database.add_profile(
        profile_id=new_id_str,
        name=new_name_str,
        user_agent=ua,
        screen_resolution=res,
        status="idle"
    )

    return {
        "status": "success",
        "profile": created,
        "folder": dest_path,
        "message": f"Nhân bản thành công từ Profile {source_id_str} sang {new_id_str} ({new_name_str})"
    }


def create_new_profile(profile_id: Optional[str] = None, name: Optional[str] = None) -> Dict[str, Any]:
    """
    Tạo Profile Mới (Random Fingerprint):
    Tự sinh User-Agent ngẫu nhiên, độ phân giải ngẫu nhiên.
    Khởi tạo thư mục profile mới (sử dụng template nếu có).
    """
    pid_str = str(profile_id).strip() if (profile_id and str(profile_id).strip()) else get_next_available_profile_id()
    name_str = name.strip() if (name and name.strip()) else f"Nick {pid_str}"

    dest_path = os.path.join(PROFILES_ROOT, pid_str)
    os.makedirs(dest_path, exist_ok=True)

    # Nếu có thư mục template mẫu, copy cấu trúc nền tảng
    if os.path.exists(TEMPLATE_PROFILE_PATH):
        try:
            shutil.copytree(
                TEMPLATE_PROFILE_PATH,
                dest_path,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("*.lock", "SingletonLock", "LOCK")
            )
        except Exception as e:
            print(f"[Warning] Copy template failed: {e}")

    ua = generate_random_user_agent()
    res = generate_random_resolution()

    created = database.add_profile(
        profile_id=pid_str,
        name=name_str,
        user_agent=ua,
        screen_resolution=res,
        status="idle"
    )

    return {
        "status": "success",
        "profile": created,
        "folder": dest_path,
        "message": f"Đã tạo Profile mới {pid_str} ({name_str})"
    }


def bulk_create_profiles(quantity: int = 1) -> Dict[str, Any]:
    """
    Tạo hàng loạt profile siêu tốc (Bulk Create):
    Tự sinh ID ngẫu nhiên không trùng lặp, tự đặt tên theo mẫu Profile {STT},
    random fingerprint (User-Agent, Screen Resolution) và khởi tạo thư mục.
    """
    qty = max(1, min(int(quantity), 50))
    created_list = []

    # Thu thập toàn bộ ID đã có (cả trong DB và trên ổ đĩa)
    existing_profiles = database.get_profiles()
    used_ids = set(str(p["id"]) for p in existing_profiles)
    if os.path.exists(PROFILES_ROOT):
        for entry in os.listdir(PROFILES_ROOT):
            if entry.lower() != "template":
                used_ids.add(entry)

    next_num = 1
    for _ in range(qty):
        while str(next_num) in used_ids or os.path.exists(os.path.join(PROFILES_ROOT, str(next_num))):
            next_num += 1

        pid_str = str(next_num)
        used_ids.add(pid_str)
        name_str = f"Profile {pid_str}"

        dest_path = os.path.join(PROFILES_ROOT, pid_str)
        os.makedirs(dest_path, exist_ok=True)
        os.makedirs(os.path.join(dest_path, "Default"), exist_ok=True)

        if os.path.exists(TEMPLATE_PROFILE_PATH):
            try:
                shutil.copytree(
                    TEMPLATE_PROFILE_PATH,
                    dest_path,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("*.lock", "SingletonLock", "LOCK")
                )
            except Exception as e:
                pass

        ua = generate_random_user_agent()
        res = generate_random_resolution()

        created = database.add_profile(
            profile_id=pid_str,
            name=name_str,
            user_agent=ua,
            screen_resolution=res,
            status="idle"
        )
        created_list.append(created)

    return {
        "status": "success",
        "created_count": len(created_list),
        "profiles": created_list,
        "message": f"Đã tạo thành công {len(created_list)} Profile mới!"
    }


def scan_existing_profiles() -> List[Dict[str, Any]]:
    """
    Quét các thư mục profile đã có sẵn trong PROFILES_ROOT (E:\\TOOL QUẢN LÝ PAGE\\profiles)
    và tự động nạp vào Database nếu chưa có.
    """
    found_profiles = []
    scanned_folders = set()

    if os.path.exists(PROFILES_ROOT):
        for entry in os.listdir(PROFILES_ROOT):
            if entry.lower() == "template":
                continue
            full_path = os.path.join(PROFILES_ROOT, entry)
            if os.path.isdir(full_path):
                scanned_folders.add(entry)

    # So sánh với database
    existing_db = {p["id"]: p for p in database.get_profiles()}

    # Sắp xếp an toàn hỗ trợ cả số nguyên và chuỗi
    sorted_folders = sorted(
        scanned_folders,
        key=lambda x: (0, int(x)) if x.isdigit() else (1, str(x))
    )

    for folder_name in sorted_folders:
        if folder_name not in existing_db:
            default_name = f"Profile {folder_name}"
            ua = generate_random_user_agent()
            res = generate_random_resolution()
            created = database.add_profile(
                profile_id=folder_name,
                name=default_name,
                user_agent=ua,
                screen_resolution=res,
                status="idle"
            )
            found_profiles.append(created)

    return found_profiles
