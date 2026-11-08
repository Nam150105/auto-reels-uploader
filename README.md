# AUTO REELS UPLOADER – CLOUDFLARE WORKERS FREE PRODUCTION (`https://pagefb.namnangno.click`)

Hệ thống quản lý đa tài khoản Facebook Admin, đồng bộ Fanpage và hẹn lịch đăng Facebook Reels tự động qua **Meta Graph API chính thức**, vận hành 100% trên nền tảng **Cloudflare Workers + Cloudflare D1 + Cloudflare R2 + Queue & Cron Triggers** (tối ưu cho gói **Cloudflare Free**).

---

## 1. Thông Tin Cấu Hình Production

| Thông số | Giá trị chính thức |
| :--- | :--- |
| **Tên ứng dụng Meta** | `Quản lý page` / `Quản lý fanpage` |
| **Meta App ID** | `1469615908436980` |
| **Worker Name** | `reels-uploader` |
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
├── wrangler.jsonc                     # Cấu hình Worker, Assets (./static), D1, R2, Cron Trigger & Custom Domain
├── package.json                       # Scripts build, typecheck, test, d1 migrations, deploy
├── tsconfig.json / tsconfig.app.json  # TypeScript cho Worker (src/) và giao diện Vue (src/frontend)
├── vite.config.ts                     # Build giao diện Vue -> static/ (index.html + assets/)
├── tailwind.config.js, postcss.config.js
├── deploy_cloudflare.ps1              # Script tự động khởi tạo D1/R2, chạy Migrations, Test và Deploy
├── r2-lifecycle.json                  # Quy tắc tự xóa video R2 sau 30 ngày
├── migrations/                        # 0001 → 0009: schema D1 (không sửa các file đã áp dụng)
├── scripts/
│   ├── ci_prepare_cloudflare.mjs      # Tự xử lý D1/R2 binding khi build trên Cloudflare Workers Builds CI
│   ├── migrate_manager_db_to_d1.mjs   # Chuyển dữ liệu manager.db (hệ thống cũ) sang SQL D1
│   └── prune_static_assets.mjs        # Sau mỗi lần build: xóa bundle cũ không còn dùng trong static/assets
├── src/
│   ├── index.ts                       # Worker Entrypoint (fetch, scheduled, queue) & định tuyến API
│   ├── types.ts                       # Kiểu dữ liệu Worker: D1, R2, Queue, Cron & Domain Models
│   ├── db.ts                          # Tầng truy vấn D1 (cô lập dữ liệu theo owner_user_id)
│   ├── fallback_d1.ts                 # Bộ nhớ dự phòng khi chưa gắn D1 binding
│   ├── middleware/auth.ts             # Session D1 thu hồi được, CSRF & Rate Limiting
│   ├── routes/                        # compliance, media (upload video/ảnh), composer (đăng bài mới), response helpers
│   ├── services/                      # Meta OAuth, Graph API (đăng Reels, bình luận), R2 media,
│   │                                  # thống kê trực tiếp từ Meta (liveInsightsService), Reels insights, Facebook posts
│   ├── queue/publishQueue.ts          # Hàng đợi đăng bài: Lease Lock, Idempotency, Backoff, nhiều bình luận / bài
│   ├── scheduler/cronDispatcher.ts    # Cron mỗi phút: bài đến hạn, bình luận hẹn giờ, dọn R2
│   ├── utils/                         # crypto (AES-256-GCM, PBKDF2), timezone (Asia/Ho_Chi_Minh), sanitize
│   ├── shared/types.ts                # Kiểu dữ liệu dùng chung cho giao diện
│   └── frontend/                      # Giao diện Vue 3 + Tailwind (App.vue, components/, composables/, services/api.ts)
├── static/                            # Thư mục Assets được Worker phục vụ
│   ├── index.html, assets/            # Do `npm run build:ui` sinh ra (không sửa tay)
│   ├── login.html                     # Trang Đăng nhập & Đăng ký
│   ├── privacy.html, terms.html, data-deletion.html, favicon.svg
└── tests/
    └── test_worker.mjs                # 47 bài kiểm thử tự động (Unit & Integration)
```

---

## 3. Hướng Dẫn Triển Khai Nhanh (Windows PowerShell)

> Nếu PowerShell báo "running scripts is disabled", dùng `npx.cmd` thay cho `npx`.

```powershell
# 1. Cài đặt dependencies
npm install

# 2. Đăng nhập Cloudflare
npx wrangler login

# 3. Tạo D1 Database và R2 Bucket (lần đầu; hoặc chạy .\deploy_cloudflare.ps1 để tự động hóa)
npx wrangler d1 create auto-reels-db
npx wrangler r2 bucket create auto-reels-media

# 4. Áp dụng D1 Migrations lên Remote
npx wrangler d1 migrations apply auto-reels-db --remote

# 5. Thiết lập Cloudflare Secrets (Không lưu trong code)
npx wrangler secret put META_APP_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY

# 6. Kiểm tra, build giao diện và Deploy
npm run typecheck
npm test
npm run build:ui
npx wrangler deploy
```

> Ứng dụng Python/FastAPI cũ đã được gỡ khỏi repository. Có thể xem lại tại commit `ad00013` (trước khi dọn dẹp).
