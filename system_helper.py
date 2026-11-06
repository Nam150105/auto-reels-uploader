import os
import subprocess
import threading
from typing import Optional, List, Dict, Any


def browse_video_file_tkinter() -> Optional[str]:
    """Mở hộp thoại Open File của Windows bằng thư viện tkinter."""
    try:
        import tkinter as tk
        from tkinter import filedialog
        
        root = tk.Tk()
        root.withdraw()  # Ẩn cửa sổ gốc
        root.wm_attributes("-topmost", 1)  # Đưa hộp thoại lên trên cùng màn hình
        
        file_path = filedialog.askopenfilename(
            title="Chọn file video tải lên",
            filetypes=[
                ("Video Files (*.mp4;*.mov;*.mkv;*.avi;*.webm)", "*.mp4;*.mov;*.mkv;*.avi;*.webm"),
                ("MP4 Videos (*.mp4)", "*.mp4"),
                ("All Files (*.*)", "*.*")
            ]
        )
        root.destroy()
        return file_path if (file_path and file_path.strip()) else None
    except Exception as e:
        print(f"[browse_video_file_tkinter error]: {e}")
        return None


def browse_video_file_powershell() -> Optional[str]:
    """Fallback: Mở hộp thoại Open File bằng lệnh PowerShell System.Windows.Forms."""
    ps_script = """
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = "Chọn file video"
    $dlg.Filter = "Video Files (*.mp4, *.mov, *.mkv)|*.mp4;*.mov;*.mkv|All Files (*.*)|*.*"
    $dlg.Multiselect = $false
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dlg.FileName
    }
    """
    try:
        res = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", ps_script],
            text=True,
            timeout=60
        )
        path = res.strip()
        return path if path else None
    except Exception as e:
        print(f"[browse_video_file_powershell error]: {e}")
        return None


def browse_video_file() -> Optional[str]:
    """Mở hộp thoại Windows chọn file video, tự động fallback nếu cần."""
    # Thử qua Tkinter trước
    path = browse_video_file_tkinter()
    if not path:
        # Nếu Tkinter không trả về do lỗi hoặc cancel, thử kiểm tra
        pass
    return path


def check_file_exists(file_path: str) -> bool:
    """Kiểm tra đường dẫn file có tồn tại trên máy hay không."""
    if not file_path or not file_path.strip():
        return False
    # Loại bỏ dấu ngoặc kép thừa nếu có
    clean_path = file_path.strip().strip('"').strip("'")
    return os.path.isfile(clean_path)


def batch_check_files(paths: List[str]) -> Dict[str, bool]:
    """Kiểm tra tồn tại cho một danh sách đường dẫn video (dùng cho Live Preview bảng Excel)."""
    result = {}
    for p in paths:
        clean_p = p.strip().strip('"').strip("'") if p else ""
        result[p] = os.path.isfile(clean_p) if clean_p else False
    return result

