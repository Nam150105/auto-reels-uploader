import re
import time
from typing import Tuple, Dict, Any, Optional
from playwright.sync_api import Page


class FacebookVerificationResult:
    MATCH = "MATCH"                    # Đúng Fanpage quản lý
    WRONG_PAGE = "WRONG_PAGE"          # Đang ở sai Fanpage
    NOT_LOGGED_IN = "NOT_LOGGED_IN"    # Chưa đăng nhập Facebook
    NO_PAGE_ACCESS = "NO_PAGE_ACCESS"  # Không có quyền truy cập Fanpage
    CHECKPOINT = "CHECKPOINT"          # Bị Facebook yêu cầu xác minh bảo mật
    UNKNOWN = "UNKNOWN"                # Không đủ dữ liệu xác minh


class FacebookService:
    """
    Dịch vụ kiểm tra đăng nhập Facebook và xác minh quyền quản lý Fanpage.
    Đảm bảo kiểm tra thực tế, không suy đoán.
    """

    @staticmethod
    def check_login_status(page: Page, timeout_ms: int = 45000) -> Tuple[str, str]:
        """
        Kiểm tra trạng thái đăng nhập Facebook trên profile.php.
        Trả về (status, message).
        """
        try:
            page.goto("https://www.facebook.com/profile.php", wait_until="load", timeout=timeout_ms)
            page.wait_for_timeout(2500)
        except Exception as e:
            return FacebookVerificationResult.UNKNOWN, f"Không thể tải trang Facebook: {e}"

        current_url = page.url.lower()

        # Kiểm tra checkpoint / bảo mật
        if "checkpoint" in current_url or "confirm" in current_url:
            return FacebookVerificationResult.CHECKPOINT, "Facebook yêu cầu xác minh bảo mật (Checkpoint)"

        # Kiểm tra chưa đăng nhập
        if "login" in current_url or "recover" in current_url or "login.php" in current_url:
            return FacebookVerificationResult.NOT_LOGGED_IN, "Profile chưa đăng nhập Facebook"

        # Kiểm tra các phần tử đăng nhập trên DOM
        login_form = page.locator('input[name="email"], input[name="pass"], button[name="login"]')
        if login_form.count() > 0 and login_form.first.is_visible():
            return FacebookVerificationResult.NOT_LOGGED_IN, "Xuất hiện form đăng nhập Facebook"

        # Kiểm tra thông báo checkpoint trên trang
        checkpoint_text = page.locator('//*[contains(text(), "xác nhận danh tính") or contains(text(), "bảo vệ tài khoản") or contains(text(), "checkpoint")]')
        if checkpoint_text.count() > 0 and checkpoint_text.first.is_visible():
            return FacebookVerificationResult.CHECKPOINT, "Tài khoản bị tạm khóa / Checkpoint"

        return "LOGGED_IN", "Đã đăng nhập Facebook thành công"

    @staticmethod
    def verify_fanpage(
        page: Page,
        expected_page_name: Optional[str] = None,
        expected_page_id: Optional[str] = None,
        expected_page_url: Optional[str] = None,
        timeout_ms: int = 45000
    ) -> Tuple[str, str, Dict[str, Any]]:
        """
        Xác minh danh tính Fanpage và quyền quản lý:
        1. Kiểm tra đăng nhập trước.
        2. Điều hướng tới Page URL hoặc Page ID.
        3. Kiểm tra xem Page có tồn tại và truy cập được không.
        4. Đối chiếu tên Page, Page ID và quyền quản lý thực tế.
        """
        # Bước 1: Kiểm tra đăng nhập
        login_status, login_msg = FacebookService.check_login_status(page, timeout_ms=timeout_ms)
        if login_status != "LOGGED_IN":
            return login_status, login_msg, {}

        # Nếu không có bất kỳ thông tin nào về Page thì không thể xác minh
        if not expected_page_name and not expected_page_id and not expected_page_url:
            return (
                FacebookVerificationResult.UNKNOWN,
                "Chưa cấu hình Tên Fanpage, Page ID hoặc URL để đối chiếu",
                {}
            )

        # Xác định URL đích cần kiểm tra
        target_url = None
        if expected_page_url and expected_page_url.strip():
            target_url = expected_page_url.strip()
            if not target_url.startswith("http"):
                target_url = f"https://www.facebook.com/{target_url.lstrip('/')}"
        elif expected_page_id and expected_page_id.strip():
            target_url = f"https://www.facebook.com/profile.php?id={expected_page_id.strip()}"

        actual_info = {
            "current_url": page.url,
            "detected_name": None,
            "has_manage_access": False
        }

        # Bước 2: Điều hướng tới Page nếu có URL
        if target_url:
            try:
                page.goto(target_url, wait_until="load", timeout=timeout_ms)
                page.wait_for_timeout(3000)
            except Exception as e:
                return FacebookVerificationResult.UNKNOWN, f"Lỗi điều hướng đến Fanpage: {e}", actual_info

        actual_info["current_url"] = page.url

        # Bước 3: Kiểm tra thông báo không truy cập được
        error_locator = page.locator(
            '//*[contains(text(), "Nội dung này hiện không khả dụng") or '
            'contains(text(), "This content isn\'t available right now") or '
            'contains(text(), "Trang này không hoạt động") or '
            'contains(text(), "Page Not Found")]'
        )
        if error_locator.count() > 0 and error_locator.first.is_visible():
            return (
                FacebookVerificationResult.NO_PAGE_ACCESS,
                "Không có quyền truy cập Fanpage hoặc URL không tồn tại",
                actual_info
            )

        # Bước 4: Lấy tên hiển thị của trang hiện tại
        detected_name = None
        # Thử lấy tiêu đề chính H1 trên Header của Page
        h1_loc = page.locator('h1, h2[dir="auto"], span[dir="auto"]')
        if h1_loc.count() > 0:
            for i in range(min(5, h1_loc.count())):
                txt = h1_loc.nth(i).inner_text().strip()
                if txt and len(txt) > 2 and "\n" not in txt:
                    detected_name = txt
                    break

        actual_info["detected_name"] = detected_name

        # Bước 5: Kiểm tra quyền quản lý (nút Quản lý / Dashboard / Đăng bài)
        manage_btn = page.locator(
            '//span[text()="Quản lý"] | '
            '//div[@aria-label="Quản lý"] | '
            '//span[contains(text(), "Bảng điều khiển chuyên nghiệp")] | '
            '//span[text()="Tạo bài viết"] | '
            '//span[text()="Thước phim"] | '
            '//a[contains(@href, "professional_dashboard")]'
        )
        has_manage = (manage_btn.count() > 0 and any(manage_btn.nth(i).is_visible() for i in range(min(3, manage_btn.count()))))
        actual_info["has_manage_access"] = has_manage

        # Bước 6: Đối chiếu tên Page
        if expected_page_name and expected_page_name.strip():
            exp_clean = expected_page_name.strip().lower()
            
            # Kiểm tra text xuất hiện trên trang (như script GemLogin cũ node 77 & 81)
            name_locator = page.locator(f'//*[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "{exp_clean}")]')
            has_name = name_locator.count() > 0

            if not has_name and detected_name:
                has_name = (exp_clean in detected_name.lower() or detected_name.lower() in exp_clean)

            if has_name:
                return (
                    FacebookVerificationResult.MATCH,
                    f"Xác minh thành công: Đúng Fanpage '{expected_page_name}'",
                    actual_info
                )
            else:
                return (
                    FacebookVerificationResult.WRONG_PAGE,
                    f"Sai Fanpage: Đang ở '{detected_name or 'Trang khác'}', không khớp '{expected_page_name}'",
                    actual_info
                )

        # Nếu chỉ có page_id hoặc page_url và vào được không lỗi
        if has_manage:
            return (
                FacebookVerificationResult.MATCH,
                "Xác minh thành công: Có quyền quản trị Page",
                actual_info
            )

        return (
            FacebookVerificationResult.UNKNOWN,
            "Không đủ dữ liệu xác nhận tên Fanpage hoặc quyền quản lý",
            actual_info
        )

