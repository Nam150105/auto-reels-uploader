import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from caption_service import CaptionService


class TestCaptionService(unittest.TestCase):
    
    def test_01_normal_caption(self):
        line = "E:\\video.mp4 | Thước phim review hay | Xem full tại cmt | 2026-11-05 | 10:00"
        res = CaptionService.parse_bulk_line(line)
        self.assertIsNotNone(res)
        self.assertEqual(res["caption"], "Thước phim review hay")
        self.assertEqual(res["comment_text"], "Xem full tại cmt")
        self.assertEqual(res["schedule_date"], "2026-11-05")
        self.assertEqual(res["schedule_time"], "10:00")

    def test_02_multiline_caption(self):
        caption_multiline = "Dòng 1: Mở đầu\nDòng 2: Nội dung chính\nDòng 3: Kết thúc"
        cleaned = CaptionService.clean_text_preserve_content(caption_multiline)
        self.assertIn("\n", cleaned)
        self.assertEqual(len(cleaned.splitlines()), 3)
        self.assertEqual(cleaned.splitlines()[0], "Dòng 1: Mở đầu")
        self.assertEqual(cleaned.splitlines()[2], "Dòng 3: Kết thúc")

    def test_03_single_quotes(self):
        caption = "It's a wonderful day with friend's story and 'special' moments"
        cleaned = CaptionService.clean_text_preserve_content(caption)
        self.assertEqual(cleaned, caption)
        self.assertIn("It's", cleaned)
        self.assertIn("'special'", cleaned)

    def test_04_double_quotes(self):
        caption = 'Câu chuyện "Người Đàn Ông Thầm Lặng" và chiếc bánh "$40,000"'
        cleaned = CaptionService.clean_text_preserve_content(caption)
        # Không được xóa hay làm mất dấu nháy kép như script cũ
        self.assertEqual(cleaned, caption)
        self.assertIn('"Người Đàn Ông Thầm Lặng"', cleaned)
        self.assertIn('"$40,000"', cleaned)

    def test_05_emoji(self):
        caption = "Review phim siêu kịch tính 🎬🍿! Đừng bỏ lỡ 🔥✨🚀"
        cleaned = CaptionService.clean_text_preserve_content(caption)
        self.assertEqual(cleaned, caption)
        self.assertIn("🎬", cleaned)
        self.assertIn("🔥", cleaned)

    def test_06_hashtag(self):
        caption = "Video ngắn thịnh hành #reels #viral #facebookreels #trending2026"
        cleaned = CaptionService.clean_text_preserve_content(caption)
        self.assertEqual(cleaned, caption)
        self.assertIn("#reels", cleaned)
        self.assertIn("#viral", cleaned)

    def test_07_url(self):
        caption = "Xem thông tin chi tiết tại https://example.com/watch?v=12345&ref=fb"
        cleaned = CaptionService.clean_text_preserve_content(caption)
        self.assertEqual(cleaned, caption)
        self.assertIn("https://example.com/watch?v=12345&ref=fb", cleaned)

    def test_08_parentheses_and_brackets(self):
        caption = "[Tập 10] Cuộc chiến vương quyền (Bản Full HD) {Vietsub + Thuyết Minh}"
        cleaned = CaptionService.clean_text_preserve_content(caption)
        self.assertEqual(cleaned, caption)
        self.assertIn("[Tập 10]", cleaned)
        self.assertIn("(Bản Full HD)", cleaned)

    def test_09_unicode_vietnamese(self):
        caption = "Thước phim chứa đầy đủ dấu tiếng Việt: ắ, ằ, ẳ, ẵ, ặ, ấ, ầ, ẩ, ẫ, ậ, đ, ê, ô, ơ, ư"
        cleaned = CaptionService.clean_text_preserve_content(caption)
        self.assertEqual(cleaned, caption)

    def test_10_empty_caption(self):
        cleaned = CaptionService.clean_text_preserve_content("")
        self.assertEqual(cleaned, "")
        cleaned_none = CaptionService.clean_text_preserve_content(None)
        self.assertEqual(cleaned_none, "")

    def test_11_separate_comment(self):
        line = "E:\\video.mp4 | Caption có nội dung | Link mua hàng: bit.ly/123 | 2026-11-05 | 11:30"
        res = CaptionService.parse_bulk_line(line)
        self.assertIsNotNone(res)
        self.assertEqual(res["comment_text"], "Link mua hàng: bit.ly/123")
        formatted = CaptionService.format_comment(res["comment_text"])
        self.assertEqual(formatted, "Link mua hàng: bit.ly/123")

    def test_12_spaces_and_newlines(self):
        caption = "   \n\n  Nội dung chính với nhiều khoảng trắng   và dòng mới \nTiếp theo   \n\n  "
        cleaned = CaptionService.clean_text_preserve_content(caption)
        self.assertTrue(cleaned.startswith("Nội dung"))
        self.assertTrue(cleaned.endswith("Tiếp theo"))
        self.assertIn("\n", cleaned)


if __name__ == "__main__":
    unittest.main()

