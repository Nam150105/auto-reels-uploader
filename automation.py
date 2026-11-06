import os
import sys
import time
import threading
import subprocess
from datetime import datetime
from typing import Dict, Any, Optional, Tuple, Callable, List

from playwright.sync_api import sync_playwright, Browser, Page

from grid_helper import calculate_window_bounds
from caption_service import CaptionService
from database import update_task_status, update_profile_status, get_profile
from profile_manager import remove_stale_profile_locks

GEMLOGIN_CHROME_EXE = r"C:\Users\phamt\.gemlogin\browser\150\Chrome-bin\chrome.exe"
PROFILES_ROOT = r"E:\TOOL QUẢN LÝ PAGE\profiles"
LOGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")

os.makedirs(LOGS_DIR, exist_ok=True)


def get_profile_dir(profile_id: str) -> str:
    """Xác định thư mục profile độc lập tại E:\\TOOL QUẢN LÝ PAGE\\profiles."""
    primary = os.path.join(PROFILES_ROOT, str(profile_id).strip())
    os.makedirs(primary, exist_ok=True)
    return primary


def kill_process_by_port(port: int) -> None:
    if sys.platform != "win32":
        return
    try:
        output = subprocess.check_output(f"netstat -ano | findstr :{port}", shell=True, text=True)
        for line in output.strip().splitlines():
            parts = line.split()
            if len(parts) >= 5 and "LISTENING" in parts:
                pid = parts[-1]
                subprocess.run(f"taskkill /F /PID {pid}", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def build_chrome_launch_cmd(
    profile_dir: str,
    debug_port: int,
    x: int,
    y: int,
    w: int,
    h: int,
    scale_factor: float = 0.5
) -> List[str]:
    """Tạo danh sách tham số khởi chạy Chrome phục vụ xếp lưới Grid & chống sập GPU AMD."""
    return [
        GEMLOGIN_CHROME_EXE,
        f"--user-data-dir={profile_dir}",
        f"--remote-debugging-port={debug_port}",
        f"--window-position={x},{y}",
        f"--window-size={w},{h}",

        # Ép mức zoom mặc định ngay từ khi khởi động engine (level -3.8 tương đương 50%)
        "--default-zoom-level=-3.8",

        # Cụm cờ chống sập/crash card AMD
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-software-rasterizer",
        "--use-gl=disabled",
        "--disable-features=AudioServiceSandbox,CalculateNativeWinOcclusion",

        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
    ]


def launch_chrome_for_bot(
    profile_id: str,
    slot_index: int,
    total_threads: int = 1,
    custom_w: int = 0,
    custom_h: int = 0,
    cols: int = 3,
    rows: int = 2,
    scale_factor: float = 0.5
) -> Tuple[subprocess.Popen, int, int, int]:
    debug_port = 9200 + slot_index
    kill_process_by_port(debug_port)

    x, y, w, h = calculate_window_bounds(
        slot_index=slot_index,
        total_threads=total_threads,
        custom_w=custom_w,
        custom_h=custom_h,
        cols=cols,
        rows=rows
    )

    profile_dir = get_profile_dir(profile_id)
    remove_stale_profile_locks(profile_dir)

    cmd = build_chrome_launch_cmd(
        profile_dir=profile_dir,
        debug_port=debug_port,
        x=x,
        y=y,
        w=w,
        h=h,
        scale_factor=scale_factor
    )

    process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)
    return process, debug_port, w, h


def safe_terminate_process(process: Optional[subprocess.Popen]) -> None:
    if not process:
        return
    try:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2.0)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def execute_task(
    task: Dict[str, Any],
    slot_index: int,
    total_threads: int = 1,
    custom_w: int = 0,
    custom_h: int = 0,
    cols: int = 3,
    rows: int = 2,
    scale_factor: float = 0.5,
    stop_event: Optional[threading.Event] = None,
    register_process_callback: Optional[Callable] = None,
    unregister_process_callback: Optional[Callable] = None
) -> bool:
    """Thực thi 1 Task lên lịch Reels trên Facebook bằng Playwright qua CDP theo quy trình 6 bước chuẩn xác."""
    task_id = task["id"]
    profile_id = str(task["profile_id"] or "").strip()
    raw_video_path = task["video_path"]
    video_path = raw_video_path.strip().strip('"').strip("'")

    raw_caption = task.get("caption") or ""
    raw_comment = task.get("comment_text") or ""
    schedule_date = task.get("schedule_date") or ""
    schedule_time = task.get("schedule_time") or ""

    caption = CaptionService.clean_text_preserve_content(raw_caption)
    comment_text = CaptionService.clean_text_preserve_content(raw_comment)

    if stop_event and stop_event.is_set():
        update_task_status(task_id, "pending", log="Bị hủy trước khi chạy do dừng khẩn cấp")
        return False

    if not os.path.isfile(video_path):
        err_msg = f"Không tìm thấy file video tại: {video_path}"
        update_task_status(task_id, "failed", log=err_msg)
        return False

    if not profile_id:
        update_task_status(task_id, "failed", log="Task chưa được gán Profile để chạy.")
        return False

    update_task_status(task_id, "running", log="Đang khởi động trình duyệt...")
    update_profile_status(profile_id, "running_bot")

    process: Optional[subprocess.Popen] = None
    browser: Optional[Browser] = None
    page: Optional[Page] = None
    playwright_inst = None

    try:
        process, debug_port, w, h = launch_chrome_for_bot(
            profile_id=profile_id,
            slot_index=slot_index,
            total_threads=total_threads,
            custom_w=custom_w,
            custom_h=custom_h,
            cols=cols,
            rows=rows,
            scale_factor=scale_factor
        )

        if register_process_callback and process:
            register_process_callback(process)

        if stop_event and stop_event.is_set():
            raise InterruptedError("Dừng khẩn cấp")

        playwright_inst = sync_playwright().start()
        browser = playwright_inst.chromium.connect_over_cdp(f"http://127.0.0.1:{debug_port}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.pages[0] if context.pages else context.new_page()

        # Cấp quyền đọc/ghi clipboard
        try:
            context.grant_permissions(["clipboard-read", "clipboard-write"])
        except Exception:
            pass

        # Tạo session CDP và set Zoom Factor tự nhiên như phím tắt Ctrl + Minus
        try:
            cdp = context.new_cdp_session(page)
            cdp.send("Page.enable")
            cdp.send("Page.setZoomFactor", {"zoomFactor": 0.5})  # 0.5 = 50%
        except Exception as e:
            print(f"[!] Warning set zoom: {e}")

        # =====================================================================
        # BƯỚC 1: KIỂM TRA ĐÚNG TÀI KHOẢN / FANPAGE
        # =====================================================================
        update_task_status(task_id, "running", log="Đang xác minh Profile / Fanpage...")
        try:
            page.goto("https://www.facebook.com/profile.php", wait_until="load", timeout=30000)
        except Exception as nav_err:
            print(f"[Task {task_id}] Warning loading profile.php: {nav_err}")

        profile_data = get_profile(profile_id)
        profile_name = (profile_data.get("name") if profile_data else "").strip()

        xpath_check = f'(//span[text()="{profile_name}"])[1]'
        try:
            page.locator(xpath_check).wait_for(state="visible", timeout=8000)
        except Exception:
            # Nếu quá thời gian không tìm thấy -> Chụp ảnh màn hình lưu logs/wrong_account_{task_id}.png
            wrong_account_screenshot = os.path.join(LOGS_DIR, f"wrong_account_{task_id}.png")
            try:
                page.screenshot(path=wrong_account_screenshot)
            except Exception:
                pass
            update_task_status(task_id, "failed", log="Chưa đăng nhập đúng tài khoản")
            return False

        if stop_event and stop_event.is_set():
            raise InterruptedError("Dừng khẩn cấp")

        # =====================================================================
        # BƯỚC 2: TẢI VIDEO & ĐIỀN CAPTION
        # =====================================================================
        update_task_status(task_id, "running", log="Đang tải video lên...")
        page.goto("https://www.facebook.com/reels/create", wait_until="load", timeout=60000)
        page.wait_for_timeout(2500)

        abs_video_path = os.path.abspath(video_path)
        file_input = page.locator('input[type="file"]')
        if file_input.count() > 0:
            file_input.first.set_input_files(abs_video_path)
        else:
            with page.expect_file_chooser(timeout=20000) as fc_info:
                add_btn = page.locator(
                    '//span[text()="Thêm video"] | '
                    '//div[@aria-label="Thêm video"] | '
                    '//span[contains(text(), "Thêm video")] | '
                    '//div[contains(text(), "Thêm video")]'
                ).first
                add_btn.click(timeout=15000, force=True)
            file_chooser = fc_info.value
            file_chooser.set_files(abs_video_path)

        page.wait_for_timeout(4000)

        # Điền Caption
        update_task_status(task_id, "running", log="Đang điền Caption...")
        caption_box_step1 = page.locator(
            '//div[@aria-placeholder="Mô tả thước phim của bạn..."] | '
            '//div[contains(@aria-label, "Mô tả thước phim")] | '
            '//div[@role="textbox" and @contenteditable="true"]'
        )

        if caption_box_step1.count() > 0 and caption_box_step1.first.is_visible():
            if caption:
                caption_box_step1.first.click(force=True)
                page.wait_for_timeout(300)
                caption_box_step1.first.fill(caption)
            page.wait_for_timeout(1000)

            next_btn = page.locator('//div[@aria-label="Tiếp" and @role="button"] | //span[text()="Tiếp"] | //div[text()="Tiếp"]').first
            if next_btn.is_visible():
                next_btn.click(force=True)
                page.wait_for_timeout(2000)
        else:
            # Form mới: Click nút Tiếp trước
            next_btn = page.locator('//div[@aria-label="Tiếp" and @role="button"] | //span[text()="Tiếp"] | //div[text()="Tiếp"]').first
            if next_btn.is_visible():
                next_btn.click(force=True)
                page.wait_for_timeout(2500)

            caption_box_step2 = page.locator(
                '//div[@aria-placeholder="Mô tả thước phim của bạn..."] | '
                '//div[contains(@aria-label, "Mô tả thước phim")] | '
                '//div[@role="textbox" and @contenteditable="true"]'
            )
            if caption and caption_box_step2.count() > 0 and caption_box_step2.first.is_visible():
                caption_box_step2.first.click(force=True)
                page.wait_for_timeout(300)
                caption_box_step2.first.fill(caption)
                page.wait_for_timeout(1000)

        for _ in range(2):
            if page.locator('//span[text()="Lên lịch"] | //span[text()="Lựa chọn lịch đăng"]').count() > 0:
                break
            next_btn_check = page.locator('//div[@aria-label="Tiếp" and @role="button"] | //span[text()="Tiếp"]').first
            if next_btn_check.is_visible():
                next_btn_check.click(force=True)
                page.wait_for_timeout(2000)

        if stop_event and stop_event.is_set():
            raise InterruptedError("Dừng khẩn cấp")

        # =====================================================================
        # BƯỚC 3: CHỜ DUYỆT BẢN QUYỀN
        # =====================================================================
        update_task_status(task_id, "running", log="Đang kiểm duyệt bản quyền...")
        try:
            page.wait_for_selector('//*[contains(text(), "an toàn để đăng")]', timeout=90000)
        except Exception:
            page.wait_for_timeout(3000)

        # =====================================================================
        # BƯỚC 4: MỞ POPUP & XÁC NHẬN "LÊN LỊCH ĐĂNG SAU"
        # =====================================================================
        update_task_status(task_id, "running", log="Đang thiết lập lịch đăng trong popup...")
        schedule_option = page.locator(
            '//span[text()="Lên lịch"] | '
            '//div[@aria-label="Lên lịch"] | '
            '//span[text()="Lựa chọn lịch đăng"] | '
            '//span[contains(text(), "Schedule")] | '
            '//div[contains(text(), "Lên lịch")] | '
            '//div[contains(text(), "Schedule")]'
        ).first
        if schedule_option.is_visible():
            schedule_option.click(force=True)
            time.sleep(1.5)

        # 1. Chờ modal popup hiển thị
        modal = page.locator('//div[@role="dialog"]').first
        modal.wait_for(state="visible", timeout=15000)
        time.sleep(1)

        # =========================================================================
        # HÀM TRỢ GIÚP: GÁN GIÁ TRỊ VÀO INPUT CỦA REACT (BYPASS REACT VALUE TRACKER)
        # =========================================================================
        def set_react_input_value(element_handle, value: str):
            """Gán giá trị vào ô input của React và kích hoạt sự kiện input/change chuẩn"""
            page.evaluate(
                """([el, val]) => {
                    el.focus();
                    // Lấy setter gốc của HTMLInputElement prototype để React không chặn
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeInputValueSetter.call(el, val);
                    
                    // Kích hoạt chuỗi sự kiện để React state cập nhật
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }""",
                [element_handle, value],
            )

        # =========================================================================
        # BƯỚC 1: XỬ LÝ NHẬP NGÀY
        # =========================================================================
        if task.get("schedule_date"):
            raw_date = str(task["schedule_date"]).strip()

            # Chuẩn hóa nếu truyền dạng YYYY-MM-DD -> DD/MM/YYYY
            if "-" in raw_date and len(raw_date.split("-")) == 3:
                p_date = raw_date.split("-")
                formatted_date = f"{p_date[2]}/{p_date[1]}/{p_date[0]}"
            else:
                formatted_date = raw_date

            print(f"[*] Đang nhập ngày: {formatted_date}")

            # Tìm ô Ngày: Thẻ chứa chữ 'Ngày' hoặc thẻ input đầu tiên trong modal
            date_container = modal.locator(
                'xpath=.//div[contains(text(), "Ngày")]/.. | .//span[contains(text(), "Ngày")]/.. | (//div[@role="dialog"]//input)[1]'
            ).first
            date_container.click(force=True)
            time.sleep(0.5)

            # Thử phương án 1: Dùng React Native Setter trên thẻ input
            try:
                date_input_el = modal.locator("xpath=(.//input)[1]").element_handle()
                if date_input_el:
                    set_react_input_value(date_input_el, formatted_date)
            except Exception as e:
                print(f"[!] Warning React setter date: {e}")

            # Thử phương án 2 (Bổ trợ phím cứng): Bôi đen toàn bộ và gõ trực tiếp
            page.keyboard.press("Control+A")
            page.keyboard.press("Backspace")
            time.sleep(0.2)
            page.keyboard.type(formatted_date, delay=50)
            page.keyboard.press("Enter")
            time.sleep(0.5)

        # =========================================================================
        # BƯỚC 2: XỬ LÝ NHẬP GIỜ
        # =========================================================================
        if task.get("schedule_time"):
            formatted_time = str(task["schedule_time"]).strip()
            print(f"[*] Đang nhập giờ: {formatted_time}")

            # Tìm ô Thời gian: Thẻ chứa chữ 'Thời gian' hoặc thẻ input thứ hai trong modal
            time_container = modal.locator(
                'xpath=.//div[contains(text(), "Thời gian")]/.. | .//span[contains(text(), "Thời gian")]/.. | (//div[@role="dialog"]//input)[2]'
            ).first
            time_container.click(force=True)
            time.sleep(0.5)

            # Thử phương án 1: Dùng React Native Setter trên thẻ input
            try:
                time_input_el = modal.locator("xpath=(.//input)[2]").element_handle()
                if time_input_el:
                    set_react_input_value(time_input_el, formatted_time)
            except Exception as e:
                print(f"[!] Warning React setter time: {e}")

            # Thử phương án 2 (Bổ trợ phím cứng): Bôi đen toàn bộ và gõ trực tiếp
            page.keyboard.press("Control+A")
            page.keyboard.press("Backspace")
            time.sleep(0.2)
            page.keyboard.type(formatted_time, delay=50)
            page.keyboard.press("Enter")
            time.sleep(0.5)

        # =========================================================================
        # BƯỚC 3: CLICK NÚT "LÊN LỊCH ĐĂNG SAU"
        # =========================================================================
        btn_confirm = modal.locator(
            'xpath=.//span[text()="Lên lịch đăng sau"] | .//div[@aria-label="Lên lịch đăng sau"] | .//span[text()="Xong"]'
        ).first
        btn_confirm.wait_for(state="visible", timeout=10000)
        btn_confirm.click(force=True)
        print("[+] Đã click nút xác nhận Lên lịch đăng sau thành công!")

        try:
            modal.wait_for(state="hidden", timeout=25000)
        except Exception:
            pass
        time.sleep(2)

        # Đợi modal đóng và URL không còn chứa /reels/create
        try:
            page.wait_for_function('() => !window.location.href.includes("/reels/create")', timeout=30000)
        except Exception:
            page.wait_for_timeout(3000)

        # =====================================================================
        # BƯỚC 5: CỐ GẮNG LẤY LINK VIDEO ĐÃ LÊN LỊCH (BẮT BUỘC CHẠY CHO MỌI TASK)
        # =====================================================================
        update_task_status(task_id, "running", log="Đang lấy liên kết video đã lên lịch...")
        video_url = ""
        caption_keyword = CaptionService.extract_search_keyword(caption, max_chars=25) if caption else ""

        try:
            page.goto("https://www.facebook.com/professional_dashboard/content/content_library/?filter=SCHEDULED", wait_until="load", timeout=60000)
            page.wait_for_timeout(4000)

            post_found = False
            for _ in range(5):
                try:
                    if caption_keyword:
                        match = page.locator(f'//*[contains(text(), "{caption_keyword}")]')
                        if match.count() > 0 and match.first.is_visible():
                            post_found = True
                            break
                    else:
                        first_post = page.locator('div[role="row"], div[role="article"]').first
                        if first_post.is_visible():
                            post_found = True
                            break
                except Exception:
                    pass
                page.wait_for_timeout(2000)

            # Mở menu 3 chấm
            actions_menu = page.locator(
                '(//div[@aria-label="Hành động với bài viết này"])[1] | '
                '(//div[@aria-haspopup="menu"])[1] | '
                '(//div[@role="button" and contains(@aria-label, "Hành động")])[1]'
            ).first
            if actions_menu.is_visible():
                actions_menu.click(force=True)
                page.wait_for_timeout(1000)

                copy_btn = page.locator('//span[text()="Sao chép liên kết"] | //div[contains(text(), "Sao chép liên kết")]').first
                if copy_btn.is_visible():
                    copy_btn.click(force=True)
                    page.wait_for_timeout(1500)

                    # Đọc clipboard trình duyệt
                    try:
                        cb = page.evaluate("navigator.clipboard.readText()")
                        if cb and ("facebook.com" in cb or "fb.watch" in cb):
                            video_url = cb.strip()
                    except Exception:
                        pass

                    # Fallback PowerShell Get-Clipboard trên Windows nếu trang chặn
                    if not video_url and sys.platform == "win32":
                        try:
                            cb_out = subprocess.check_output(["powershell", "-Command", "Get-Clipboard"], text=True)
                            cb_str = cb_out.strip()
                            if "facebook.com" in cb_str or "fb.watch" in cb_str:
                                video_url = cb_str
                        except Exception:
                            pass
        except Exception as link_err:
            print(f"[Task {task_id}] Chú ý lấy liên kết: {link_err}")

        if video_url:
            update_task_status(task_id, "running", video_url=video_url)

        # =====================================================================
        # BƯỚC 6: RẼ NHÁNH XỬ LÝ COMMENT (NHẬP TRỰC TIẾP)
        # =====================================================================
        done_time_now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Nhánh 1: comment_text TRỐNG (Rỗng / None / Chỉ khoảng trắng)
        if not comment_text.strip():
            update_task_status(
                task_id=task_id,
                status="success",
                log="Đã lên lịch",
                video_url=video_url or None,
                done_time=done_time_now
            )
            return True

        # Nhánh 2: comment_text CÓ NỘI DUNG
        update_task_status(task_id, "running", log="Đang nhập bình luận trực tiếp...")
        comment_done = False
        try:
            # Click vào bài viết trên danh sách để mở chi tiết
            if caption_keyword:
                post_click = page.locator(f'//*[contains(text(), "{caption_keyword}")]').first
                if post_click.is_visible():
                    post_click.click(force=True)
            else:
                first_row = page.locator('div[role="row"], div[role="article"]').first
                if first_row.is_visible():
                    first_row.click(force=True)
            page.wait_for_timeout(2500)

            # Click ô bình luận
            cmt_box = page.locator(
                '//div[contains(@aria-label, "Bình luận dưới tên")] | '
                '//div[@role="textbox" and contains(@aria-label, "Bình luận")] | '
                '//div[@role="textbox" and @contenteditable="true"]'
            ).first
            if cmt_box.is_visible():
                cmt_box.click(force=True)
                page.wait_for_timeout(300)
                page.keyboard.press("Control+A")
                page.wait_for_timeout(100)
                page.keyboard.type(comment_text, delay=30)
                page.wait_for_timeout(1500)

                send_btn = page.locator(
                    '//div[@aria-label="Đăng bình luận"] | '
                    '//div[@aria-label="Bình luận"] | '
                    '//span[text()="Đăng bình luận"]'
                ).first
                if send_btn.is_visible():
                    send_btn.click(force=True)
                else:
                    page.keyboard.press("Enter")
                page.wait_for_timeout(5000)
                comment_done = True
        except Exception as cmt_err:
            print(f"[Task {task_id}] Lỗi gõ comment: {cmt_err}")
            comment_done = False

        status_log = "Đã lên lịch và cmt" if comment_done else "Đã lên lịch (Lỗi cmt)"
        update_task_status(
            task_id=task_id,
            status="success",
            log=status_log,
            video_url=video_url or None,
            done_time=done_time_now
        )
        return True

    except Exception as e:
        error_msg = str(e)
        print(f"[Task {task_id}] Thất bại: {error_msg}")
        try:
            if page:
                screenshot_file = os.path.join(LOGS_DIR, f"task_{task_id}.png")
                page.screenshot(path=screenshot_file)
        except Exception:
            pass

        update_task_status(task_id, "failed", log=error_msg)
        return False

    finally:
        try:
            if browser:
                browser.close()
        except Exception:
            pass

        if playwright_inst:
            try:
                playwright_inst.stop()
            except Exception:
                pass

        if register_process_callback and unregister_process_callback and process:
            unregister_process_callback(process)

        safe_terminate_process(process)
        update_profile_status(profile_id, "idle")
