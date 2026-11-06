# AUTO REELS UPLOADER – CLOUDFLARE WORKERS FREE PRODUCTION (`https://pagefb.namnangno.click`)

Hệ thống quản lý đa tài khoản Facebook Admin, đồng bộ Fanpage và hẹn lịch đăng Facebook Reels tự động qua **Meta Graph API chính thức**, vận hành 100% trên nền tảng **Cloudflare Workers + Cloudflare D1 + Cloudflare R2 + Queue & Cron Triggers** (tối ưu cho gói **Cloudflare Free**).

---

## 1. Thông Tin Cấu Hình Production

| Thông số | Giá trị chính thức |
| :--- | :--- |
| **Tên ứng dụng Meta** | `Quản lý page` / `Quản lý fanpage` |
| **Meta App ID** | `1469615908436980` |
| **Worker Name** | `auto-reels-uploader` |
| **Production Domain** | `https://pagefb.namnangno.click` |
| **Facebook OAuth Redirect URI** | `https://pagefb.namnangno.click/api/meta/callback` |
| **Chính Sách Quyền Riêng Tư** | `https://pagefb.namnangno.click/privacy` |
| **Điều Khoản Dịch Vụ** | `https://pagefb.namnangno.click/terms` |
| **Hướng Dẫn Xóa Dữ Liệu** | `https://pagefb.namnangno.click/data-deletion` |
| **Data Deletion Callback URL** | `https://pagefb.namnangno.click/api/meta/data-deletion` |
| **Tra Cứu Trạng Thái Xóa Dữ Liệu** | `https://pagefb.namnangno.click/data-deletion-status` |

---

## 2. Cấu Trúc Thư Mục (`Cloudflare-Native`)

```text
auto-reels-uploader/
├── wrangler.jsonc                     # Cấu hình Cloudflare Worker, Assets, D1, R2, Cron Trigger & Custom Domain
├── package.json                       # Scripts dev, test, d1 migrations, r2 create, deploy
├── tsconfig.json                      # Cấu hình TypeScript chuẩn WebWorker ES2022
├── deploy_cloudflare.ps1              # Script tự động khởi tạo D1/R2, chạy Migrations, Test và Deploy
├── migrations/
│   ├── 0001_initial_schema.sql        # Schema 12 bảng chuẩn Multi-User (users, sessions, oauth_states, media_files, tasks...)
│   ├── 0002_indexes.sql               # Indexes tối ưu Cloudflare Free Plan (user_id, facebook_page_id, status, scheduled_at)
│   └── 0003_security_and_tokens.sql   # View user_page_permissions & bảng security_key_metadata
├── scripts/
│   ├── ci_prepare_cloudflare.mjs      # Tự động xử lý D1/R2 binding khi build trên Cloudflare Workers Builds CI
│   └── migrate_manager_db_to_d1.mjs   # Trích xuất dữ liệu từ manager.db cũ sang SQL D1 (tự động tạo backup trước)
├── src/
│   ├── index.ts                       # Worker Entrypoint (fetch, scheduled, queue handlers)
│   ├── types.ts                       # Định nghĩa kiểu dữ liệu TypeScript cho D1, R2, Queue, Cron & Domain Models
│   ├── db.ts                          # Tầng truy vấn D1 (Zero N+1 query, cô lập dữ liệu theo owner_user_id)
│   ├── fallback_d1.ts                 # Bộ nhớ dự phòng an toàn khi chưa gắn D1 binding
│   ├── middleware/
│   │   └── auth.ts                    # Xác thực Session D1 có thể thu hồi, CSRF Protection & Rate Limiting
│   ├── services/
│   │   ├── metaOAuthService.ts        # Luồng Facebook OAuth 2.0 Authorization Code & Long-Lived Token (~60 ngày)
│   │   ├── metaGraphService.ts        # Đồng bộ /me/accounts phân trang, Run Test & Xuất bản Reels /{page_id}/video_reels
│   │   └── r2MediaService.ts          # Streaming Upload Video trực tiếp lên Cloudflare R2 (auto-reels-media)
│   ├── queue/
│   │   └── publishQueue.ts            # Queue Producer & Consumer (Lease Lock, Idempotency, Exponential Backoff)
│   ├── scheduler/
│   │   └── cronDispatcher.ts          # Cron Trigger Scheduler chuyển đổi Asia/Ho_Chi_Minh <-> UTC
│   ├── routes/
│   │   ├── complianceRoutes.ts        # /privacy, /terms, /data-deletion, /api/meta/data-deletion
│   │   ├── mediaRoutes.ts             # /api/media/upload-init, /api/media/upload-stream/*, /api/media/upload-complete
│   │   └── responseHelpers.ts         # Helpers phản hồi JSON/HTML
│   └── utils/
│       ├── crypto.ts                  # AES-256-GCM (enc:v2:...), Key Rotation, Masking & PBKDF2-HMAC-SHA256
│       ├── timezone.ts                # Chuyển đổi múi giờ Asia/Ho_Chi_Minh (+07:00) <-> UTC timestamp
│       └── sanitize.ts                # Tự động ẩn mọi Access Token / App Secret khỏi log và thông báo lỗi
├── static/
│   ├── index.html                     # Giao diện Bảng điều khiển Quản lý Fanpage & Lên lịch Reels
│   ├── login.html                     # Giao diện Đăng nhập & Đăng ký thành viên
│   ├── privacy.html                   # Trang Chính sách Quyền riêng tư
│   ├── terms.html                     # Trang Điều khoản Dịch vụ
│   ├── data-deletion.html             # Trang Hướng dẫn Xóa dữ liệu người dùng
│   └── js/app.js                      # Logic Frontend Vue 3 (Smart Polling tối ưu Free Plan + Upload R2)
└── tests/
    └── test_worker.mjs                # Bộ 30 bài kiểm thử tự động bắt buộc (Unit & Integration Tests)
```

---

## 3. Hướng Dẫn Triển Khai Nhanh (Windows PowerShell)

```powershell
# 1. Cài đặt dependencies
npm install

# 2. Đăng nhập Cloudflare
npx wrangler login

# 3. Tạo D1 Database và R2 Bucket (hoặc chạy .\deploy_cloudflare.ps1 để tự động hóa)
npx wrangler d1 create auto-reels-db
npx wrangler r2 bucket create auto-reels-media

# 4. Áp dụng D1 Migrations lên Remote
npx wrangler d1 migrations apply auto-reels-db --remote

# 5. Thiết lập Cloudflare Secrets (Không lưu trong code)
npx wrangler secret put META_APP_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY

# 6. Chạy kiểm thử 30 bài test và Deploy
npm test
npx wrangler deploy
```
