import os
import json
import sqlite3
import subprocess
import time
import urllib.request
import urllib.parse
from typing import Dict, Any, List, Optional, Tuple

GEMLOGIN_CHROME_EXE = r"C:\Users\phamt\.gemlogin\browser\150\Chrome-bin\chrome.exe"
PROFILES_ROOT = r"F:\.gemlogin\profile\profiles"
GEMLOGIN_DB_PATH = r"C:\Users\phamt\.gemlogin\db.db"

DEFAULT_API_PORTS = [1010, 1011, 2010]


class GemLoginService:
    """
    Module độc lập tích hợp GemLogin Local API và Browser Runner.
    
    Chức năng:
    - Tự động phát hiện cổng GemLogin Local API (1010, 1011, 2010).
    - Lấy danh sách Profile từ API hoặc đọc trực tiếp từ SQLite db.db.
    - Mở Profile qua API (/api/profiles/start/:id) và nhận remote_debugging_address.
    - Cơ chế fallback mở trực tiếp Chrome GemLogin nếu API chưa bật.
    - Đóng Profile an toàn (/api/profiles/close/:id hoặc process kill).
    """

    def __init__(self, preferred_port: Optional[int] = None):
        self.preferred_port = preferred_port
        self._cached_api_url: Optional[str] = None
        self._last_api_check: float = 0
        self._api_status: Dict[str, Any] = {"online": False, "port": None, "base_url": None}

    def check_api_status(self, force_refresh: bool = False) -> Dict[str, Any]:
        """
        Kiểm tra trạng thái kết nối tới GemLogin Local API Server.
        """
        now = time.time()
        if not force_refresh and (now - self._last_api_check < 4.0) and self._cached_api_url:
            return self._api_status

        ports_to_try = [self.preferred_port] if self.preferred_port else []
        ports_to_try.extend([p for p in DEFAULT_API_PORTS if p not in ports_to_try])

        for port in ports_to_try:
            try:
                base_url = f"http://127.0.0.1:{port}"
                req = urllib.request.Request(f"{base_url}/api/status", headers={"accept": "application/json"})
                with urllib.request.urlopen(req, timeout=0.8) as res:
                    if res.status in (200, 204):
                        self._cached_api_url = base_url
                        self._api_status = {
                            "online": True,
                            "port": port,
                            "base_url": base_url,
                            "message": f"GemLogin API đang hoạt động (Port {port})"
                        }
                        self._last_api_check = now
                        return self._api_status
            except Exception:
                # Thử thêm endpoint /api/browser_versions
                try:
                    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/browser_versions", headers={"accept": "application/json"})
                    with urllib.request.urlopen(req, timeout=0.8) as res:
                        if res.status == 200:
                            base_url = f"http://127.0.0.1:{port}"
                            self._cached_api_url = base_url
                            self._api_status = {
                                "online": True,
                                "port": port,
                                "base_url": base_url,
                                "message": f"GemLogin API đang hoạt động (Port {port})"
                            }
                            self._last_api_check = now
                            return self._api_status
                except Exception:
                    pass

        self._cached_api_url = None
        self._api_status = {
            "online": False,
            "port": None,
            "base_url": None,
            "message": "GemLogin API không phản hồi (Vui lòng mở ứng dụng GemLogin)"
        }
        self._last_api_check = now
        return self._api_status

    def get_gemlogin_profiles(self) -> List[Dict[str, Any]]:
        """
        Lấy danh sách các Profile hiện có trong GemLogin.
        Ưu tiên qua Local API, nếu API offline thì đọc trực tiếp từ database C:\\Users\\phamt\\.gemlogin\\db.db.
        """
        api_stat = self.check_api_status()
        if api_stat["online"]:
            try:
                base_url = api_stat["base_url"]
                req = urllib.request.Request(f"{base_url}/api/profiles", headers={"accept": "application/json"})
                with urllib.request.urlopen(req, timeout=2.0) as res:
                    data = json.loads(res.read().decode("utf-8"))
                    profiles_list = data if isinstance(data, list) else data.get("data", [])
                    result = []
                    for p in profiles_list:
                        result.append({
                            "gemloginProfileId": str(p.get("id")),
                            "name": p.get("name") or f"Profile {p.get('id')}",
                            "status": p.get("status", 1),
                            "note": p.get("note", "")
                        })
                    if result:
                        return result
            except Exception as e:
                print(f"[GemLoginService] Lỗi gọi API /api/profiles: {e}")

        # Fallback đọc trực tiếp SQLite db.db của GemLogin
        return self._read_profiles_from_sqlite()

    def _read_profiles_from_sqlite(self) -> List[Dict[str, Any]]:
        """Đọc danh sách Profile trực tiếp từ file C:\\Users\\phamt\\.gemlogin\\db.db."""
        if not os.path.exists(GEMLOGIN_DB_PATH):
            return []
        try:
            conn = sqlite3.connect(GEMLOGIN_DB_PATH)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, status, note FROM profiles ORDER BY id ASC")
            rows = cursor.fetchall()
            conn.close()
            return [
                {
                    "gemloginProfileId": str(r["id"]),
                    "name": r["name"] or f"Profile {r['id']}",
                    "status": r["status"],
                    "note": r["note"] or ""
                }
                for r in rows
            ]
        except Exception as e:
            print(f"[GemLoginService] Lỗi đọc db.db: {e}")
            return []

    def start_profile(
        self,
        gemlogin_profile_id: str,
        win_pos: Tuple[int, int] = (0, 0),
        win_size: Tuple[int, int] = (400, 600)
    ) -> Dict[str, Any]:
        """
        Khởi chạy Profile:
        1. Gọi API: GET /api/profiles/start/{id}?win_pos=x,y&win_size=w,h
        2. Nếu API thành công: Nhận remote_debugging_address (CDP port) từ response.
        3. Nếu API offline: Fallback khởi chạy tiến trình Chrome binary GemLogin với profile folder.
        """
        api_stat = self.check_api_status()
        x, y = win_pos
        w, h = win_size

        if api_stat["online"]:
            base_url = api_stat["base_url"]
            params = urllib.parse.urlencode({
                "win_pos": f"{x},{y}",
                "win_size": f"{w},{h}"
            })
            url = f"{base_url}/api/profiles/start/{gemlogin_profile_id}?{params}"
            try:
                req = urllib.request.Request(url, headers={"accept": "application/json"})
                with urllib.request.urlopen(req, timeout=15.0) as res:
                    data = json.loads(res.read().decode("utf-8"))
                    res_data = data.get("data") if isinstance(data, dict) else {}
                    remote_addr = res_data.get("remote_debugging_address")
                    if remote_addr:
                        return {
                            "method": "api",
                            "remote_debugging_address": remote_addr,
                            "cdp_url": f"http://{remote_addr}",
                            "process": None,
                            "profile_id": gemlogin_profile_id
                        }
            except Exception as e:
                print(f"[GemLoginService] Khởi động profile qua API thất bại: {e}. Đang chuyển sang Direct Launch.")

        # Phương pháp khởi động trực tiếp bằng Chrome GemLogin
        return self._launch_direct_process(gemlogin_profile_id, x, y, w, h)

    def _launch_direct_process(
        self,
        gemlogin_profile_id: str,
        x: int, y: int, w: int, h: int
    ) -> Dict[str, Any]:
        """Khởi chạy Chrome GemLogin với user-data-dir riêng và remote-debugging-port."""
        if not os.path.exists(GEMLOGIN_CHROME_EXE):
            raise FileNotFoundError(f"Không tìm thấy Chrome GemLogin tại: {GEMLOGIN_CHROME_EXE}")

        profile_dir = os.path.join(PROFILES_ROOT, str(gemlogin_profile_id))
        os.makedirs(profile_dir, exist_ok=True)

        # Chọn cổng debug riêng biệt (9200 + hash hoặc số profile)
        try:
            port_offset = int(gemlogin_profile_id) % 500
        except ValueError:
            port_offset = abs(hash(gemlogin_profile_id)) % 500
        debug_port = 9200 + port_offset

        cmd = [
            GEMLOGIN_CHROME_EXE,
            f"--user-data-dir={profile_dir}",
            f"--remote-debugging-port={debug_port}",
            f"--window-position={x},{y}",
            f"--window-size={w},{h}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-blink-features=AutomationControlled",
        ]

        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # Chờ mở cổng CDP
        cdp_ready = False
        start_t = time.time()
        while time.time() - start_t < 10.0:
            try:
                chk_req = urllib.request.Request(f"http://127.0.0.1:{debug_port}/json/version")
                with urllib.request.urlopen(chk_req, timeout=0.5) as chk_res:
                    if chk_res.status == 200:
                        cdp_ready = True
                        break
            except Exception:
                time.sleep(0.3)

        if not cdp_ready:
            time.sleep(2.0)

        return {
            "method": "direct",
            "remote_debugging_address": f"127.0.0.1:{debug_port}",
            "cdp_url": f"http://127.0.0.1:{debug_port}",
            "process": process,
            "profile_id": gemlogin_profile_id
        }

    def close_profile(self, gemlogin_profile_id: str, process: Optional[subprocess.Popen] = None) -> bool:
        """Đóng Profile qua API hoặc terminate process."""
        api_stat = self.check_api_status()
        if api_stat["online"]:
            try:
                base_url = api_stat["base_url"]
                req = urllib.request.Request(f"{base_url}/api/profiles/close/{gemlogin_profile_id}")
                with urllib.request.urlopen(req, timeout=5.0) as res:
                    if res.status == 200:
                        return True
            except Exception:
                pass

        if process:
            try:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=3.0)
                    return True
            except Exception:
                try:
                    process.kill()
                    return True
                except Exception:
                    pass
        return False

