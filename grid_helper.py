import sys
from typing import Tuple


def get_screen_resolution() -> Tuple[int, int]:
    """
    Lấy độ phân giải màn hình chính qua ctypes user32 trên Windows.
    Tự động fallback về 1920x1080 nếu không gọi được.
    """
    if sys.platform == "win32":
        try:
            import ctypes
            user32 = ctypes.windll.user32
            # Đảm bảo nhận đúng toạ độ thực tế không bị ảnh hưởng bởi tỉ lệ DPI scale
            try:
                user32.SetProcessDPIAware()
            except Exception:
                pass
            w = user32.GetSystemMetrics(0)
            h = user32.GetSystemMetrics(1)
            if w > 0 and h > 0:
                return w, h
        except Exception:
            pass
    return 1920, 1080


def calculate_window_bounds(
    slot_index: int,
    total_threads: int = 1,
    custom_w: int = 0,
    custom_h: int = 0,
    cols: int = 3,
    rows: int = 2
) -> Tuple[int, int, int, int]:
    """
    Tính toán toạ độ (x, y) và kích thước (w, h) cho từng cửa sổ Chrome theo ma trận lưới (Grid Matrix).
    
    Công thức ma trận:
        col = slot_index % cols
        row = (slot_index // cols) % rows
        x = col * width
        y = row * height
        
    Tham số:
        slot_index: Chỉ số slot của luồng hiện tại (0, 1, 2...)
        total_threads: Tổng số luồng chạy đồng thời
        custom_w: Chiều rộng tùy biến (<= 0 sẽ tự động chia theo màn hình)
        custom_h: Chiều cao tùy biến (<= 0 sẽ tự động chia theo màn hình)
        cols: Số cột trên màn hình
        rows: Số hàng trên màn hình
        
    Trả về:
        Tuple (x, y, width, height)
    """
    screen_w, screen_h = get_screen_resolution()
    
    # Chuẩn hoá đầu vào
    cols = max(1, int(cols))
    rows = max(1, int(rows))
    slot_index = max(0, int(slot_index))

    if custom_w <= 0 or custom_h <= 0:
        width = screen_w // cols
        height = screen_h // rows
    else:
        width = int(custom_w)
        height = int(custom_h)

    col = slot_index % cols
    row = (slot_index // cols) % rows

    x = col * width
    y = row * height

    return int(x), int(y), int(width), int(height)

