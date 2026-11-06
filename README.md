# Hệ Thống Quản Lý Facebook Fanpage & Hẹn Lịch Đăng Reels (Cloudflare-Native Architecture)

Ứng dụng quản lý đa tài khoản Facebook Admin, đồng bộ Fanpage tự động và xuất bản / hẹn lịch đăng Facebook Reels thông qua **Meta Graph API v19.0** chạy trực tiếp 100% trên hạ tầng **Cloudflare Workers + Cloudflare D1**.

- **Production Domain:** `https://pagefb.namnangno.click`
- **Facebook App ID:** `1469615908436980` (*Quản lý fanpage*)
- **Facebook OAuth Callback URL:** `https://pagefb.namnangno.click/api/meta/callback`
- **Không sử dụng:** `localhost:8000`, Cloudflare Tunnel, VPS hay máy tính cá nhân bật 24/7.

---

## 1. Kiến Trúc Hệ Thống (Cloudflare-Native)

| Thành phần | Dịch vụ Cloudflare | Vai trò |
| :--- | :--- | :--- |
| **Frontend UI** | Cloudflare Workers Static Assets (`./static`) | Giao diện Vue 3 + Tailwind CSS phục vụ tại `https://pagefb.namnangno.click` |
| **Backend API** | Cloudflare Workers (`src/index.ts`) & Pages Functions (`functions/[[path]].ts`) | Xử lý toàn bộ `/api/*`, Facebook OAuth 2.0, Meta Graph API v19.0, phân quyền người dùng |
| **Database** | Cloudflare D1 (`DB` binding) | Cơ sở dữ liệu quan hệ SQLite Serverless (`users`, `oauth_states`, `facebook_accounts`, `facebook_pages`, `facebook_account_pages`, `tasks`) |
| **Bảo mật Token** | Web Crypto API (`AES-256-GCM`) + Cloudflare Secrets | Mã hóa toàn bộ `User Access Token` và `Page Access Token` trước khi lưu vào D1 |
| **Lưu trữ Video** | Direct URL (`https://...mp4`) / Cloudflare R2 (`VIDEOS_BUCKET`) / D1 Staging | Cho phép tải video từ trình duyệt lên Cloud hoặc truyền URL trực tiếp cho Meta Reels API |

---

## 2. Cấu Trúc Thư Mục Chính

```text
├── src/
│   ├── index.ts              # Cloudflare Worker Entrypoint & Router (/api/* + Page routes)
│   ├── meta.ts               # Facebook OAuth 2.0 & Meta Graph API v19.0 Service
│   ├── db.ts                 # Cloudflare D1 Data Access Layer (Multi-user isolation)
│   ├── crypto.ts             # Web Crypto AES-256-GCM, PBKDF2-SHA256 & HMAC-SHA256
│   ├── fallback_d1.ts        # Fallback adapter an toàn khi chưa gắn D1 binding
│   └── types.ts              # TypeScript Interfaces cho Cloudflare Bindings
├── functions/
│   └── [[path]].ts           # Tương thích tự động nếu deploy qua Cloudflare Pages
├── migrations/
│   └── 0001_init.sql         # Schema khởi tạo Cloudflare D1 (users, oauth_states, accounts, pages, tasks)
├── static/
│   ├── index.html            # Giao diện Bảng điều khiển chính (Quản lý Fanpage & Lịch đăng Reels)
│   ├── login.html            # Trang Đăng nhập / Đăng ký thành viên hệ thống
│   ├── privacy.html          # Chính sách quyền riêng tư (/privacy)
│   ├── terms.html            # Điều khoản dịch vụ (/terms)
│   ├── data-deletion.html    # Hướng dẫn xóa dữ liệu người dùng (/data-deletion)
│   └── js/app.js             # Logic Frontend Vue 3 (Relative API `/api/...`)
├── tests/
│   └── test_worker.mjs       # Bộ kiểm thử tự động toàn diện cho Cloudflare Worker & D1
├── wrangler.toml             # Cấu hình Cloudflare Workers, Custom Domain & D1
├── package.json              # Scripts build, typecheck, migrate, test, deploy
└── tsconfig.json             # Cấu hình TypeScript chuẩn WebWorker ES2022
```

---

## 3. Hướng Dẫn Triển Khai Lên Cloudflare (Windows PowerShell)

### Bước 1: Cài đặt gói phụ thuộc & Đăng nhập Wrangler
Mở **Windows PowerShell** tại thư mục dự án (`E:\TOOL QUẢN LÝ PAGE`) và chạy:

```powershell
npm.cmd install
npx.cmd wrangler login
```

### Bước 2: Khởi tạo Cloudflare D1 Database
Chạy lệnh tạo database `pagefb-db` trên tài khoản Cloudflare của bạn:

```powershell
npx.cmd wrangler d1 create pagefb-db
```

Sau khi lệnh chạy xong, terminal sẽ in ra `database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`. Hãy copy mã `database_id` đó và thay vào dòng `database_id` trong file `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "pagefb-db"
database_id = "<DÁN_DATABASE_ID_CỦA_BẠN_VÀO_ĐÂY>"
migrations_dir = "migrations"
```

### Bước 3: Áp dụng Database Migration lên Cloudflare D1
Chạy lệnh sau để tạo toàn bộ bảng (`users`, `oauth_states`, `facebook_accounts`, `facebook_pages`, `facebook_account_pages`, `tasks`) trên Cloudflare D1:

```powershell
npx.cmd wrangler d1 migrations apply pagefb-db --remote
```

### Bước 4: Thiết lập các Biến Bí Mật (Cloudflare Secrets)
Không lưu khóa bí mật trong code. Hãy nạp `META_APP_SECRET`, `SECRET_KEY`, và `ENCRYPTION_KEY` lên Cloudflare Secrets bằng 3 lệnh sau:

```powershell
npx.cmd wrangler secret put META_APP_SECRET
# Nhập App Secret của ứng dụng Meta (1469615908436980) khi được hỏi

npx.cmd wrangler secret put SECRET_KEY
# Nhập chuỗi ngẫu nhiên bất kỳ (tối thiểu 32 ký tự) để ký cookie phiên đăng nhập

npx.cmd wrangler secret put ENCRYPTION_KEY
# Nhập chuỗi ngẫu nhiên bất kỳ (tối thiểu 32 ký tự) để mã hóa AES-256-GCM cho Access Token
```

### Bước 5: Deploy Ứng Dụng Lên `https://pagefb.namnangno.click`
```powershell
npx.cmd wrangler deploy
```
*(Do `wrangler.toml` đã cấu hình `routes = [{ pattern = "pagefb.namnangno.click", custom_domain = true }]`, Cloudflare sẽ tự động gắn Custom Domain `pagefb.namnangno.click` và cấp chứng chỉ SSL trực tiếp cho Worker).*

---

## 4. Cấu Hình Meta Developer Portal (`App ID: 1469615908436980`)

Truy cập [Meta for Developers](https://developers.facebook.com/apps/1469615908436980) và kiểm tra:

1. **App Settings > Basic:**
   - **App Domains:** `pagefb.namnangno.click`
   - **Privacy Policy URL:** `https://pagefb.namnangno.click/privacy`
   - **Terms of Service URL:** `https://pagefb.namnangno.click/terms`
   - **User Data Deletion:** Chọn *Data Deletion Instructions URL* hoặc *Callback URL*: `https://pagefb.namnangno.click/data-deletion` (hoặc `https://pagefb.namnangno.click/api/meta/data-deletion`)
   - **Website > Site URL:** `https://pagefb.namnangno.click/`
2. **Facebook Login > Settings:**
   - **Client OAuth Login:** `Yes`
   - **Web OAuth Login:** `Yes`
   - **Enforce HTTPS:** `Yes`
   - **Valid OAuth Redirect URIs:**
     ```text
     https://pagefb.namnangno.click/api/meta/callback
     ```
3. **Permissions & Features (App Review):**
   - `public_profile`
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `pages_manage_engagement`
   - `pages_read_user_content`
   *(Lưu ý: Nếu ứng dụng đang ở chế độ **Development**, các tài khoản Facebook cá nhân đăng nhập cần được thêm vào mục **App Roles > Roles (Administrators / Developers / Testers)**. Để mọi người dùng Facebook bên ngoài đều đăng nhập và lấy được danh sách Fanpage, cần chuyển App sang chế độ **Live** và hoàn tất **Advanced Access** cho các quyền Page).*

