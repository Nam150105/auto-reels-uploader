import re
from typing import Dict, Any, Tuple, Optional


class CaptionService:
    """
    Dịch vụ xử lý Caption, Regex và bình luận cho Facebook Reels.
    
    Đảm bảo:
    - Không mất ký tự, không mất dòng (newlines).
    - Giữ nguyên dấu nháy đơn ('), nháy kép ("), emoji, hashtag, URL, dấu ngoặc.
    - Không làm hỏng ký tự Unicode tiếng Việt.
    - Phân tách và ghép nối chính xác dữ liệu từ chuỗi dòng hoặc bảng biểu.
    """

    @staticmethod
    def clean_text_preserve_content(text: Optional[str]) -> str:
        """
        Làm sạch khoảng trắng thừa ở đầu/cuối chuỗi nhưng TUYỆT ĐỐI giữ nguyên:
        - Xuống dòng bên trong nội dung (\n, \r\n).
        - Toàn bộ dấu nháy đơn, nháy kép, emoji, unicode.
        """
        if text is None:
            return ""
        # Chỉ loại bỏ khoảng trắng vô nghĩa ở cực đầu và cực đuôi
        return text.strip()

    @staticmethod
    def parse_bulk_line(line: str) -> Optional[Dict[str, str]]:
        """
        Phân tích 1 dòng dữ liệu nhập hàng loạt theo cú pháp:
        Video_Path | Caption | Bình_luận | YYYY-MM-DD | HH:MM
        
        Cho phép Caption hoặc Bình luận chứa dấu ngoặc, emoji, quotes, dấu cách.
        Sử dụng phân tách pipe (|) có giới hạn hoặc kiểm tra từng thành phần.
        """
        if not line or not line.strip():
            return None

        # Chia tối đa 5 phần tử dựa trên dấu pipe
        parts = [p.strip() for p in line.split("|")]
        if not parts or not parts[0]:
            return None

        video_path = parts[0]
        caption = parts[1] if len(parts) > 1 else ""
        comment_text = parts[2] if len(parts) > 2 else ""
        schedule_date = parts[3] if len(parts) > 3 else ""
        schedule_time = parts[4] if len(parts) > 4 else ""

        # Chuẩn hóa ngày nếu có (YYYY-MM-DD)
        if schedule_date:
            date_match = re.search(r"(\d{4}[-/]\d{1,2}[-/]\d{1,2})", schedule_date)
            if date_match:
                schedule_date = date_match.group(1).replace("/", "-")

        # Chuẩn hóa giờ nếu có (HH:MM)
        if schedule_time:
            time_match = re.search(r"(\d{1,2}:\d{2})", schedule_time)
            if time_match:
                schedule_time = time_match.group(1)

        return {
            "video_path": video_path,
            "caption": caption,
            "comment_text": comment_text,
            "schedule_date": schedule_date,
            "schedule_time": schedule_time
        }

    @staticmethod
    def extract_search_keyword(caption: str, max_chars: int = 30) -> str:
        """
        Lấy từ khóa nhận diện bài viết trong Scheduled Content Library mà không làm lỗi dấu nháy.
        Script cũ dùng regex: (.{20})\"?$ làm mất phần đầu và lỗi khi caption ngắn.
        Ở đây: Lấy dòng đầu tiên hoặc N ký tự đầu tiên an toàn cho việc search trên Facebook.
        """
        if not caption:
            return ""
        # Lấy dòng đầu tiên nếu caption nhiều dòng
        first_line = caption.strip().splitlines()[0].strip()
        # Cắt tối đa max_chars ký tự để tìm kiếm an toàn
        return first_line[:max_chars].strip()

    @staticmethod
    def format_comment(comment_text: str) -> str:
        """
        Định dạng bình luận tự động: bảo toàn nguyên vẹn nội dung người dùng nhập.
        """
        if not comment_text or not comment_text.strip():
            return ""
        return comment_text.strip()

