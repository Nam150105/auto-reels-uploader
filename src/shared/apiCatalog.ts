/**
 * Catalog of every HTTP API endpoint, shown on the admin "API" screen.
 * tests/test_worker.mjs checks that every "/api/..." route in the Worker source is listed here.
 *
 * access: public = no login, user = logged-in user (own data only), admin = admin account only
 */

export type ApiAccess = "public" | "user" | "admin";

export interface ApiEndpoint {
  group: string;
  method: string;
  path: string;
  access: ApiAccess;
  description: string;
}

export const API_CATALOG: ApiEndpoint[] = [
  // Đăng nhập
  { group: "Đăng nhập", method: "POST", path: "/api/auth/login", access: "public", description: "Đăng nhập bằng tên đăng nhập và mật khẩu" },
  { group: "Đăng nhập", method: "POST", path: "/api/auth/register", access: "public", description: "Đã tắt (luôn trả 403). Tài khoản do admin cấp qua /api/admin/users" },
  { group: "Đăng nhập", method: "POST", path: "/api/auth/logout", access: "public", description: "Đăng xuất phiên hiện tại" },
  { group: "Đăng nhập", method: "GET", path: "/api/auth/me", access: "public", description: "Thông tin tài khoản đang đăng nhập" },
  { group: "Đăng nhập", method: "POST", path: "/api/auth/change-password", access: "user", description: "Tự đổi mật khẩu (cần mật khẩu hiện tại)" },

  // Facebook
  { group: "Facebook", method: "GET", path: "/api/meta/callback", access: "public", description: "Facebook trả về sau khi đăng nhập kết nối" },
  { group: "Facebook", method: "GET, POST", path: "/api/meta/data-deletion", access: "public", description: "Yêu cầu xoá dữ liệu từ Facebook" },
  { group: "Facebook", method: "GET", path: "/api/meta/status", access: "user", description: "Trạng thái kết nối Facebook" },
  { group: "Facebook", method: "GET", path: "/api/meta/accounts", access: "user", description: "Danh sách tài khoản Facebook đã kết nối (alias /api/accounts)" },
  { group: "Facebook", method: "GET", path: "/api/accounts", access: "user", description: "Alias của /api/meta/accounts" },
  { group: "Facebook", method: "GET", path: "/api/meta/oauth-url", access: "user", description: "Tạo link đăng nhập Facebook" },
  { group: "Facebook", method: "GET", path: "/api/meta/login", access: "user", description: "Chuyển sang trang đăng nhập Facebook" },
  { group: "Facebook", method: "POST", path: "/api/meta/connect-token", access: "user", description: "Kết nối bằng Access Token (alias connect-direct-token)" },
  { group: "Facebook", method: "POST", path: "/api/meta/connect-direct-token", access: "user", description: "Alias của /api/meta/connect-token" },
  { group: "Facebook", method: "POST", path: "/api/meta/accounts/:id/update-token", access: "user", description: "Cập nhật token cho tài khoản Facebook" },
  { group: "Facebook", method: "POST", path: "/api/meta/sync-pages", access: "user", description: "Đồng bộ lại toàn bộ Fanpage" },
  { group: "Facebook", method: "POST", path: "/api/meta/disconnect", access: "user", description: "Ngắt kết nối mọi tài khoản Facebook" },
  { group: "Facebook", method: "POST", path: "/api/meta/accounts/:id/sync", access: "user", description: "Đồng bộ Fanpage của một tài khoản" },
  { group: "Facebook", method: "GET, POST", path: "/api/meta/accounts/:id/reconnect", access: "user", description: "Kết nối lại một tài khoản (cũng: /reconnect-url)" },
  { group: "Facebook", method: "POST", path: "/api/meta/accounts/:id/disconnect", access: "user", description: "Ngắt kết nối một tài khoản" },
  { group: "Facebook", method: "DELETE", path: "/api/meta/accounts/:id", access: "user", description: "Xoá tài khoản Facebook và Fanpage đi kèm" },
  { group: "Facebook", method: "GET", path: "/api/meta/app-check", access: "user", description: "Kiểm tra cấu hình ứng dụng Facebook" },

  // Fanpage
  { group: "Fanpage", method: "GET", path: "/api/pages", access: "user", description: "Danh sách Fanpage" },
  { group: "Fanpage", method: "POST", path: "/api/pages/bulk-select", access: "user", description: "Chọn / bỏ chọn nhiều Fanpage" },
  { group: "Fanpage", method: "POST", path: "/api/pages/:id/select", access: "user", description: "Chọn / bỏ chọn một Fanpage" },
  { group: "Fanpage", method: "POST", path: "/api/pages/:id/check-permission", access: "user", description: "Kiểm tra quyền đăng bài của Fanpage" },
  { group: "Fanpage", method: "DELETE", path: "/api/pages/:id", access: "user", description: "Xoá Fanpage khỏi hệ thống" },
  { group: "Fanpage", method: "POST", path: "/api/pages/:id/sync-posts", access: "user", description: "Đồng bộ bài viết của Fanpage" },

  // Bài đăng / lịch đăng
  { group: "Lịch đăng", method: "GET", path: "/api/tasks", access: "user", description: "Danh sách bài đăng / lịch đăng" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks", access: "user", description: "Tạo một bài đăng" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/bulk", access: "user", description: "Tạo nhiều bài đăng" },
  { group: "Lịch đăng", method: "DELETE", path: "/api/tasks/bulk", access: "user", description: "Xoá nhiều bài đăng" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/bulk-delete", access: "user", description: "Xoá nhiều bài đăng" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/bulk-publish-now", access: "user", description: "Đăng ngay nhiều bài" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/bulk-reschedule", access: "user", description: "Đổi giờ đăng nhiều bài" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/bulk-cancel", access: "user", description: "Huỷ nhiều bài" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/cleanup-completed", access: "user", description: "Dọn các bài đã đăng xong" },
  { group: "Lịch đăng", method: "PUT", path: "/api/tasks/:id", access: "user", description: "Sửa bài đăng" },
  { group: "Lịch đăng", method: "DELETE", path: "/api/tasks/:id", access: "user", description: "Xoá bài đăng" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/:id/publish-now", access: "user", description: "Đăng ngay (cũng: /publish)" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/:id/reset", access: "user", description: "Đặt lại bài lỗi để đăng lại" },
  { group: "Lịch đăng", method: "GET", path: "/api/tasks/:id/logs", access: "user", description: "Nhật ký xử lý bài" },
  { group: "Lịch đăng", method: "GET", path: "/api/tasks/:id/attempts", access: "user", description: "Các lần thử đăng" },
  { group: "Lịch đăng", method: "GET", path: "/api/tasks/:id/audit-logs", access: "user", description: "Lịch sử thay đổi bài" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/:id/comment", access: "user", description: "Thêm bình luận tự động" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/:id/retry-comment", access: "user", description: "Thử lại bình luận lỗi" },
  { group: "Lịch đăng", method: "POST", path: "/api/tasks/:id/sync-insights", access: "user", description: "Cập nhật số liệu của một Reels" },

  // Bài viết & bình luận trên Fanpage
  { group: "Bài viết Fanpage", method: "GET", path: "/api/posts", access: "user", description: "Danh sách bài viết trên Fanpage" },
  { group: "Bài viết Fanpage", method: "GET", path: "/api/posts/:id", access: "user", description: "Chi tiết bài viết" },
  { group: "Bài viết Fanpage", method: "PUT", path: "/api/posts/:id", access: "user", description: "Sửa bài viết" },
  { group: "Bài viết Fanpage", method: "DELETE", path: "/api/posts/:id", access: "user", description: "Xoá bài viết" },
  { group: "Bài viết Fanpage", method: "GET", path: "/api/posts/:id/comments", access: "user", description: "Bình luận của bài viết" },
  { group: "Bài viết Fanpage", method: "POST", path: "/api/posts/:id/comments", access: "user", description: "Bình luận vào bài viết" },
  { group: "Bài viết Fanpage", method: "POST", path: "/api/comments/:id/reply", access: "user", description: "Trả lời bình luận" },
  { group: "Bài viết Fanpage", method: "POST", path: "/api/comments/:id/hide", access: "user", description: "Ẩn / hiện bình luận" },
  { group: "Bài viết Fanpage", method: "DELETE", path: "/api/comments/:id", access: "user", description: "Xoá bình luận" },

  // Video / ảnh
  { group: "Video & ảnh", method: "POST", path: "/api/media/upload-init", access: "user", description: "Bắt đầu tải video lên" },
  { group: "Video & ảnh", method: "PUT, POST", path: "/api/media/upload-stream/:id", access: "user", description: "Tải video lên một lần" },
  { group: "Video & ảnh", method: "PUT, POST", path: "/api/media/upload-part", access: "user", description: "Tải lên từng phần video" },
  { group: "Video & ảnh", method: "POST", path: "/api/media/upload-complete", access: "user", description: "Hoàn tất tải video" },
  { group: "Video & ảnh", method: "PUT, POST", path: "/api/media/upload-image", access: "user", description: "Tải ảnh (cho bình luận)" },
  { group: "Video & ảnh", method: "GET", path: "/api/media", access: "user", description: "Danh sách file đã tải" },
  { group: "Video & ảnh", method: "DELETE", path: "/api/media/:id", access: "user", description: "Xoá file" },
  { group: "Video & ảnh", method: "GET", path: "/api/media/:id/stream", access: "user", description: "Xem video (cũng: /api/videos/:id)" },
  { group: "Video & ảnh", method: "POST", path: "/api/upload/video", access: "user", description: "Tải video (kiểu cũ)" },
  { group: "Video & ảnh", method: "POST", path: "/api/media/cleanup-expired", access: "user", description: "Dọn video hết hạn (cũng: /api/system/cleanup-expired-media)" },

  // Thống kê
  { group: "Thống kê", method: "GET", path: "/api/insights", access: "user", description: "Thống kê đã lưu (cập nhật 3 tiếng/lần)" },
  { group: "Thống kê", method: "GET", path: "/api/insights/live", access: "user", description: "Giống /api/insights (giữ cho tương thích)" },
  { group: "Thống kê", method: "POST", path: "/api/insights/refresh", access: "user", description: "Đồng bộ thống kê từ Facebook ngay" },
  { group: "Thống kê", method: "GET", path: "/api/insights/reels", access: "user", description: "Thống kê theo từng Reels" },
  { group: "Thống kê", method: "GET", path: "/api/insights/reels/:id", access: "user", description: "Chi tiết số liệu một Reels" },
  { group: "Thống kê", method: "POST", path: "/api/insights/sync", access: "user", description: "Cập nhật số liệu các Reels" },

  // Hệ thống
  { group: "Hệ thống", method: "GET", path: "/api/status", access: "user", description: "Tình trạng hệ thống của tài khoản" },
  { group: "Hệ thống", method: "GET", path: "/api/system/quota", access: "user", description: "Hạn mức sử dụng" },
  { group: "Hệ thống", method: "GET", path: "/api/system/api-telemetry", access: "user", description: "Thống kê gọi API Facebook" },
  { group: "Hệ thống", method: "POST", path: "/api/system/check-files", access: "user", description: "Kiểm tra file video của các bài" },
  { group: "Hệ thống", method: "GET", path: "/api/system/browse-file", access: "user", description: "Xem thông tin file" },
  { group: "Hệ thống", method: "POST", path: "/api/runner/test", access: "user", description: "Chạy thử bộ đăng bài" },
  { group: "Hệ thống", method: "POST", path: "/api/runner/start", access: "user", description: "Đăng các bài đến hạn ngay (cũng: /api/run)" },
  { group: "Hệ thống", method: "POST", path: "/api/runner/stop", access: "user", description: "Dừng bộ đăng bài (cũng: /api/stop)" },
  { group: "Hệ thống", method: "POST", path: "/api/run", access: "user", description: "Alias của /api/runner/start" },
  { group: "Hệ thống", method: "POST", path: "/api/stop", access: "user", description: "Alias của /api/runner/stop" },
  { group: "Hệ thống", method: "POST", path: "/api/system/cleanup-expired-media", access: "user", description: "Alias của /api/media/cleanup-expired" },

  // Quản trị
  { group: "Quản trị", method: "GET", path: "/api/admin/overview", access: "admin", description: "Tổng quan: người dùng, đang online, tài khoản FB, Fanpage, bài đăng" },
  { group: "Quản trị", method: "GET", path: "/api/admin/users", access: "admin", description: "Danh sách người dùng kèm số liệu" },
  { group: "Quản trị", method: "POST", path: "/api/admin/users", access: "admin", description: "Thêm người dùng" },
  { group: "Quản trị", method: "GET", path: "/api/admin/users/:id", access: "admin", description: "Chi tiết người dùng: tài khoản FB, Fanpage, phiên đăng nhập" },
  { group: "Quản trị", method: "PUT", path: "/api/admin/users/:id", access: "admin", description: "Sửa thông tin, quyền, khoá / mở khoá" },
  { group: "Quản trị", method: "DELETE", path: "/api/admin/users/:id", access: "admin", description: "Xoá người dùng và toàn bộ dữ liệu của họ" },
  { group: "Quản trị", method: "POST", path: "/api/admin/users/:id/password", access: "admin", description: "Đặt mật khẩu mới cho người dùng" },
  { group: "Quản trị", method: "POST", path: "/api/admin/users/:id/revoke-sessions", access: "admin", description: "Đăng xuất người dùng khỏi mọi thiết bị" },
  { group: "Quản trị", method: "GET", path: "/api/admin/sessions", access: "admin", description: "Danh sách phiên đăng nhập" },
  { group: "Quản trị", method: "POST", path: "/api/admin/sessions/:id/revoke", access: "admin", description: "Đăng xuất một phiên" },
  { group: "Quản trị", method: "GET", path: "/api/admin/api-catalog", access: "admin", description: "Danh sách toàn bộ API (trang này)" }
];
