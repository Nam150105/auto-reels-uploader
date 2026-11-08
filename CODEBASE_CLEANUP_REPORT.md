# Báo cáo dọn dẹp mã nguồn – auto-reels-uploader

- **Branch:** `cleanup/codebase-cleanup`, tách từ `main` tại commit `ad00013`.
- **Commit, push, merge:** chưa commit, chưa push, chưa merge vào `main`.
- **Tag khôi phục:** `legacy-python-final` trỏ vào `ad00013`. Tag chỉ có ở máy local, chưa push.
- **Ngày thực hiện:** 2026-11-08.
- **Đổi tên Worker:** sau khi dọn dẹp, chủ dự án đã đổi tên Worker trên Cloudflare từ `auto-reels-uploader` thành `reels-uploader`. `wrangler.jsonc` (`name`), README, `deploy_cloudflare.ps1`, `.env.example` và chú thích đầu `src/index.ts` đã được cập nhật theo. Branch `main` vẫn còn tên cũ.

> ⚠️ **Cần xử lý ngay (không thuộc phạm vi dọn dẹp, chưa sửa):** có 2 vấn đề bảo mật ở mục 10.1 và 10.2. Repository đang ở chế độ công khai trên GitHub.

---

## 1. Thống kê trước / sau

| Hạng mục | Trước | Sau |
|---|---|---|
| Tổng số file được git theo dõi | 138 | 88 (gồm cả báo cáo này) |
| Dòng code TypeScript/Vue trong `src/` | 24.321 | 24.083 |
| Dependency (`dependencies` + `devDependencies`) | 1 + 9 | 1 + 8 |
| File legacy (Python, UI cũ, Pages Functions, re-export) | 30 | 0 |
| Bundle build cũ trong `static/assets` | 22 file thừa (25 file) | 0 file thừa (3 file) |
| Export / khai báo không dùng ở đâu | 15 | 0 |
| Import thừa / biến không dùng | 8 | 0 (còn 1 báo nhầm của vue-tsc, xem mục 6) |
| Kết quả `npm test` | 47/47 đạt | 47/47 đạt |
| `npm run typecheck` | 0 lỗi | 0 lỗi |
| `npm run build` | Thành công | Thành công (bundle cũ được dọn tự động) |
| Worker bundle (`wrangler deploy --dry-run`) | — | Thành công, 513 KiB, đủ binding |

Tổng diff so với `main`: 77 file thay đổi, thêm 124 dòng, xóa 33.825 dòng. Phần lớn số dòng bị xóa đến từ 4 nguồn: file `worker-configuration.d.ts` được sinh tự động (16.240 dòng), giao diện cũ, các bundle build cũ và ứng dụng Python.

---

## 2. Kiểm kê (Giai đoạn 1)

| Thành phần | Thực tế |
|---|---|
| Entry point production | `src/index.ts` (`fetch`, `scheduled`, `queue`). `wrangler.jsonc` → `main`. |
| Giao diện | Vue 3 + Vite + Tailwind trong `src/frontend/`, build vào `static/` (`index.html` + `assets/`) |
| Trang tĩnh viết tay | `static/login.html`, `privacy.html`, `terms.html`, `data-deletion.html`, `favicon.svg`. Worker phục vụ qua `serveStaticHtmlAsset`. |
| D1 | `DB` → `auto-reels-db`, `migrations_dir: migrations` (0001 → 0009) |
| R2 | `MEDIA_BUCKET` và `auto_reels_media`, cùng trỏ vào bucket `auto-reels-media` |
| Cron | `*/1 * * * *` |
| Queue | Không bật. Khối cấu hình Queue trong `wrangler.jsonc` đang được comment lại cho gói Paid. Gói Free dùng D1 + Cron + `waitUntil`. |
| Biến môi trường (`vars`) | `META_APP_ID`, `APP_BASE_URL`, `META_REDIRECT_URI`, `META_GRAPH_VERSION`, `MAX_VIDEO_SIZE_MB` |
| Secrets | Hiện chỉ có `META_APP_SECRET` (theo `wrangler secret list`) |
| Build / deploy | Lệnh npm `build`, `build:ui`, `deploy`; `scripts/ci_prepare_cloudflare.mjs` (postinstall + build); `deploy_cloudflare.ps1` |
| Migration dữ liệu | `scripts/migrate_manager_db_to_d1.mjs` (Node, lệnh `d1:seed:local`) |
| Test | `tests/test_worker.mjs`, chạy bằng `npm test`. 8 file test Python không được lệnh npm nào gọi. |
| GitHub Actions | Không có |
| Cloudflare Pages | Tài khoản không có dự án Pages nào (`wrangler pages project list` trả danh sách rỗng) |

**Phương pháp xác định code thừa:**
1. **Đồ thị import:** dựng từ mọi điểm vào (Worker, giao diện, test, scripts, `vite.config.ts`). Phân giải cả alias `@/` và `@shared/`.
2. **Biến và import thừa:** chạy `tsc` và `vue-tsc` với `--noUnusedLocals`.
3. **Export không dùng:** quét mọi `export` và đếm số lần dùng theo đúng tên trên toàn bộ `src/`, `tests/`, `scripts/`.
4. **Đối chiếu tham chiếu chuỗi:** tìm theo route, tên file và đường dẫn tĩnh, không chỉ theo import.

---

## 3. Các file đã xóa (53 file)

### 3.1 Ứng dụng Python/FastAPI cũ: 23 file, theo xác nhận của bạn

- **Module ở thư mục gốc (14):** `main.py`, `database.py`, `meta_oauth_service.py`, `meta_graph_service.py`, `meta_runner.py`, `meta_crypto.py`, `caption_service.py`, `system_helper.py`, `profile_manager.py`, `migrate_db.py`, `automation.py`, `facebook_service.py`, `gemlogin_service.py`, `grid_helper.py`.
- **Test Python (8):** `tests/test_*.py`.
- **Phụ thuộc Python (1):** `legacy/requirements.txt`, gồm fastapi, uvicorn, playwright, pydantic.

Căn cứ để xóa:
- Không có quy trình production, build, deploy hay `npm test` nào gọi tới Python.
- Mọi endpoint của `main.py` đều đã có bản tương đương trong `src/index.ts`, kể cả các route tương thích `/api/runner/*`, `/api/run`, `/api/system/browse-file`, `/api/system/check-files`. Riêng `/api/profiles/*` (quản lý profile trình duyệt cục bộ) không có.
- `automation.py`, `facebook_service.py`, `gemlogin_service.py` và `grid_helper.py` vốn đã là code chết ngay trong ứng dụng Python, vì `main.py` không import.
- Migration dữ liệu sang D1 do script Node `scripts/migrate_manager_db_to_d1.mjs` làm, không phụ thuộc Python.

Chức năng không được chuyển sang TypeScript:
- Quản lý profile trình duyệt cục bộ (kiểu GemLogin).
- Tự động hóa trình duyệt bằng Playwright.

Bạn đã xác nhận không còn dùng hai chức năng này. Hai chú thích trong `src/utils/crypto.ts` nói về định dạng mật khẩu và token cũ của Python vẫn được giữ, vì dữ liệu cũ trong D1 vẫn cần đọc được.

### 3.2 Giao diện cũ trước khi chuyển sang Vue: 3 file

- **`static/js/app.js`:** logic của giao diện cũ. Không route nào và không trang đang dùng nào tham chiếu tới nó.
- **`static/index.legacy.html`:** trang cũ, file duy nhất tải `/js/app.js`. Không route nào phục vụ nó.
- **`index.html` ở thư mục gốc:** bản sao giống hệt `static/index.legacy.html`. File này nằm ngoài thư mục Assets nên không được phục vụ.

### 3.3 Bundle build cũ: 22 file trong `static/assets/`

`vite.config.ts` đặt `emptyOutDir: false`, vì `static/` còn chứa các trang viết tay. Do đó mỗi lần build lại để lại `app.*.js` và `index.*.css` của lần trước (14 bản JS và 8 bản CSS). Bước dọn tự động ở mục 4 sẽ ngăn việc này lặp lại.

### 3.4 Thành phần không còn dùng: 5 file

| File | Lý do |
|---|---|
| `functions/[[path]].ts` | Cầu nối Cloudflare **Pages** Functions. Dự án deploy bằng Workers và không có dự án Pages nào. |
| `src/meta.ts` | Chỉ re-export các service Meta "để tương thích". Không file nào import. |
| `src/crypto.ts` | Chỉ re-export `src/utils/crypto.ts`. Không file nào import. |
| `worker-configuration.d.ts` | File kiểu 640 KB do `wrangler types` sinh ra. Không nằm trong `include` của `tsconfig.json`, và code dùng kiểu tự định nghĩa trong `src/types.ts`. |
| `legacy/` | Thư mục rỗng sau khi xóa `requirements.txt` |

---

## 4. Các file đã sửa (21 file) và file mới (2 file)

**Code chết đã xóa** (chỉ xóa dòng, không đổi logic):

| File | Đã xóa |
|---|---|
| `src/db.ts` | `revokeAllUserSessions`, `deleteFacebookAccountLocal`, `setTaskCommentDelay`, import kiểu `MetaApiTelemetryRecord` |
| `src/services/metaGraphService.ts` | `syncRecentPageVideos` (85 dòng; chỉ được import thừa ở `src/index.ts`) |
| `src/index.ts` | Import thừa `syncRecentPageVideos`. **Không đổi route nào.** |
| `src/services/facebookPostsService.ts` | Import thừa `decryptToken` |
| `src/utils/crypto.ts` | `hexToBytes`, `verifySessionToken`, `isEncryptedToken` |
| `src/utils/timezone.ts` | Hằng `VN_TIMEZONE` |
| `src/types.ts` | Interface `MetaApiTelemetryRecord` |
| `src/shared/types.ts` | `SingleComposerState`, `PublishMode` |
| `src/frontend/utils/date.ts` | `getVietnamNow`, `formatUtcToVnDisplay`, `addMinutesToVnSlot` |
| `src/frontend/utils/comments.ts` | `cloneComments` |
| `src/frontend/composables/useTasks.ts` | Import kiểu `TaskStatus` |
| `src/frontend/components/common/Header.vue` | Biến `props` không đọc. Vẫn giữ `defineProps`. |
| `src/frontend/components/composer/FacebookPreview.vue` | Biến chỉ số `i` không dùng trong `v-for` |
| `src/frontend/components/schedule/ScheduleView.vue` | Biến `tasks` lấy ra nhưng không dùng |

**Cấu hình:**
- **`package.json`:**
  - Bỏ `@cloudflare/workers-types` (không được dùng; wrangler vẫn tự cài như dependency của nó).
  - `build` và `build:ui` gọi thêm `scripts/prune_static_assets.mjs`.
- **`package-lock.json`:** cập nhật theo lệnh `npm uninstall`.
- **`tsconfig.json`:** bỏ `functions/**/*.ts` khỏi `include`.
- **`.gitignore`:** bỏ phần cache Python.

**Bộ test `tests/test_worker.mjs`.** Mục đích các bài test giữ nguyên, chỉ thay đối tượng kiểm tra:
- **Test 02:** trước kiểm tra `/js/app.js` và `/static/js/app.js` (UI cũ). Giờ kiểm tra bundle Vue thật mà `static/index.html` tham chiếu, qua `/assets/...` và qua tiền tố `/static/...`.
- **Test 27–30:**
  - Bỏ `static/js/app.js` khỏi danh sách file cần quét.
  - Hai kiểm tra trên `app.js` (`handleConnectToken`, `validateVnScheduleClient`) chuyển sang hai hàm tương ứng của giao diện Vue: `connectWithToken`, `isScheduleSlotAllowed`.
- **Test 28 (bảo mật):** trước đây test chứa nguyên văn chuỗi được ghi chú là `META_APP_SECRET`. Giờ test so khớp bằng SHA-256, nên vẫn phát hiện được nếu secret bị lộ vào file mà không còn lưu secret dạng chữ thường. Xem mục 10.1.

**Tài liệu:** `README.md`, cập nhật phần cấu trúc thư mục và các bước deploy cho khớp với code hiện tại.

**File mới:**
- `scripts/prune_static_assets.mjs`: chạy sau `vite build`. Script chỉ giữ những file trong `static/assets` mà `static/index.html` dùng, trực tiếp hoặc gián tiếp (ví dụ ảnh do bundle JS import). Nếu `index.html` không tham chiếu file nào, script dừng và không xóa gì. Có cờ `--dry-run`.
- `CODEBASE_CLEANUP_REPORT.md`: báo cáo này.

---

## 5. Dependency

| Package | Kết luận |
|---|---|
| `@cloudflare/workers-types` | **Đã gỡ.** Không được import, không có trong `tsconfig` `types`. Wrangler vẫn kéo nó về như dependency riêng. |
| `vue` | Giữ: giao diện |
| `vite`, `@vitejs/plugin-vue` | Giữ: build giao diện |
| `tailwindcss`, `postcss`, `autoprefixer` | Giữ: `postcss.config.js`. `postcss` là peer dependency bắt buộc. |
| `typescript`, `vue-tsc` | Giữ: lệnh `typecheck` |
| `wrangler` | Giữ: dev, deploy, migration |

Không nâng cấp phiên bản thư viện nào.

---

## 6. Thành phần được giữ lại và lý do

| Thành phần | Lý do giữ |
|---|---|
| `deploy_cloudflare.ps1` | Công cụ khởi tạo và deploy, README có nhắc tới |
| `scripts/migrate_manager_db_to_d1.mjs` | Công cụ migration dữ liệu (lệnh `d1:seed:local`). Không đụng tới code migration. |
| `scripts/ci_prepare_cloudflare.mjs` | Chạy ở postinstall và build, dùng trên Cloudflare Workers Builds CI |
| `migrations/0001–0009` | Lịch sử migration, không được sửa |
| `r2-lifecycle.json` | Quy tắc tự xóa video R2 sau 30 ngày |
| `.env.example`, `.dev.vars.example` | Tài liệu biến môi trường. Hai file trùng nội dung một phần nhưng vô hại. |
| `howtorun.txt` | Ghi chú cá nhân của bạn |
| `src/fallback_d1.ts` | Đang được `src/index.ts` dùng khi thiếu binding D1 |
| R2 binding `auto_reels_media` (trùng bucket với `MEDIA_BUCKET`) | Nguyên tắc không đổi binding. Không xóa. |
| Khối Queue bị comment trong `wrangler.jsonc` | Nguyên tắc không đổi cấu hình Queue |
| Mọi API endpoint, kể cả route tương thích mà giao diện Vue không gọi (`/api/insights/reels`, `/api/runner/*`, `/api/system/browse-file`…) | Nguyên tắc không đổi API. Không xác minh được có công cụ bên ngoài gọi hay không. |
| 66 hàm/hằng được `export` nhưng chỉ dùng trong chính file của nó | Code đang chạy. Bỏ chữ `export` không đem lại lợi ích thực tế. |
| Khối "Compatibility Indicators" ẩn trong `src/frontend/index.html` | Test 27–30 kiểm tra các chuỗi này, và đây là thay đổi UI. Không đụng. |
| Biến `i` trong `<template v-for="(part, i)">` (`FacebookPreview.vue`) | vue-tsc báo không dùng, nhưng thực tế biến này là `:key`. Đây là báo nhầm. |
| Thư mục local `backups/`, `logs/`, `profiles/`, `manager.db-shm/-wal`, `.wrangler/` | Không nằm trong git và có thể là dữ liệu của bạn. Không đụng. Có thể xóa tay nếu chắc không cần. |

---

## 7. Kiểm thử đã chạy

Tôi chạy kiểm tra sau mỗi nhóm thay đổi (Python, UI cũ, bundle cũ, Pages Functions, code chết, dependency, tài liệu):

| Lệnh | Kết quả |
|---|---|
| `npm install` | Thành công. npm 11 cảnh báo chặn install script của `esbuild` và `workerd`, xem mục 10.5. |
| `npm run typecheck` (`tsc` + `vue-tsc`) | 0 lỗi |
| `npm test` | 47/47 đạt. Bộ test bao gồm: OAuth và CSRF, phiên đăng nhập, cô lập dữ liệu giữa người dùng, upload R2 (một lần và chia phân đoạn), tạo bài và hẹn lịch, hàng đợi và retry, bình luận hẹn giờ, nhiều bình luận kèm ảnh, thống kê trực tiếp từ Meta, xóa dữ liệu. |
| `npm run build` | Thành công. Bước dọn bundle chạy đúng (giữ 3 file). |
| `npx wrangler deploy --dry-run` | Worker đóng gói thành công. Đủ binding `DB`, `MEDIA_BUCKET`, `auto_reels_media`, `ASSETS` và 5 biến `vars`. |
| So sánh CSS trước/sau | 155 class Tailwind không còn được sinh ra. Đó là các class chỉ giao diện cũ dùng, vì Tailwind từng quét cả `static/index.legacy.html`. Đã đối chiếu: mọi class giao diện Vue dùng vẫn còn đủ. |
| So sánh bundle JS trước/sau nhóm xóa giao diện cũ | Giống hệt từng byte. Mã hash đổi chỉ vì file CSS đi kèm đổi. |
| `git diff main -- wrangler.jsonc migrations/ src/queue src/scheduler src/routes src/services/metaOAuthService.ts src/services/r2MediaService.ts` | Không có thay đổi |

---

## 8. Kết quả build

- **Giao diện:** `static/index.html`, `static/assets/app.*.js` (≈217 KB, gzip ≈69 KB), `static/assets/index.*.css` (≈43 KB, trước là ≈52 KB) và `telegram-admin-qr.*.png`.
- **Worker:** tổng dung lượng upload 513,66 KiB (gzip 101,88 KiB). Thư mục Assets có 10 file.

---

## 9. Chức năng chưa thể xác minh

Các luồng sau chỉ được kiểm tra bằng bộ test với Meta và Cloudflare giả lập, chưa chạy trên môi trường thật:
- Đăng nhập Facebook OAuth thật
- Đăng Reels thật
- Upload lên R2 thật
- Cron trên Cloudflare
- Lời gọi Graph Batch của màn Thống kê

Theo nguyên tắc dọn dẹp, mã của các luồng này không bị sửa (mục 7). Rủi ro thay đổi hành vi vì vậy rất thấp, nhưng không phải bằng không. Nên thử nhanh trên production sau khi merge.

---

## 10. Rủi ro còn tồn tại

### 10.1 ⚠️ META_APP_SECRET có thể đã bị lộ công khai

- **Hiện trạng:** chuỗi 32 ký tự hex được ghi chú là `META_APP_SECRET` nằm trong `tests/test_worker.mjs` từ commit đầu tiên `51719f1`. Repository `Nam150105/auto-reels-uploader` đang công khai.
- **Đã làm:** branch này không còn chuỗi đó. Nhưng chuỗi vẫn còn trong lịch sử git.
- **Cần làm:**
  1. Vào Meta App Dashboard → Cài đặt → Cơ bản, bấm **Đặt lại** App Secret.
  2. Chạy `npx wrangler secret put META_APP_SECRET` với giá trị mới.
  3. Nếu muốn xóa khỏi lịch sử git, phải viết lại lịch sử (`git filter-repo`) và force-push. Việc này ảnh hưởng mọi bản clone, nên chưa làm.

### 10.2 ⚠️ Khóa mã hóa token đang dùng giá trị mặc định công khai

- **Hiện trạng:** `wrangler secret list` chỉ có `META_APP_SECRET`. Khi thiếu `TOKEN_ENCRYPTION_KEY` (và các tên dự phòng `ENCRYPTION_KEY`, `SESSION_SECRET`, `SECRET_KEY`), `getEncryptionKeyMaterial()` dùng chuỗi viết cứng trong `src/utils/crypto.ts`. Chuỗi này công khai trên GitHub. Nghĩa là access token Facebook trong D1 thực chất được mã hóa bằng một khóa ai cũng biết. Session cũng dùng chung cơ chế dự phòng này.
- **Cần làm** (không làm ở đây vì nguyên tắc số 10):
  1. Đặt `TOKEN_ENCRYPTION_KEY` và `SESSION_SECRET` ngẫu nhiên.
  2. Mã hóa lại token đang lưu (đã có sẵn `rotateEncryptionKey` trong `crypto.ts`), hoặc cho người dùng kết nối lại Facebook.
  3. Lưu ý: nếu chỉ đặt khóa mới mà không mã hóa lại, các token cũ sẽ không giải mã được.

### 10.3 Bundle cũ bị xóa

Một trình duyệt đang giữ `index.html` cũ trong cache có thể tải bundle cũ, nhận lỗi 404 và hiện trang trắng cho tới khi tải lại trang. Lỗi chỉ xảy ra một lần ngay sau khi deploy.

### 10.4 Graph API v19.0

`META_GRAPH_VERSION` vẫn là `v19.0`. Meta App đang đặt chế độ "Nâng cấp tất cả lệnh gọi" lên v27.0, nên hiện chạy ổn. Không đổi trong đợt dọn dẹp này.

### 10.5 npm chặn install script của `esbuild` và `workerd`

Các binary đã cài sẵn từ trước, và build, test, `wrangler` đều chạy bình thường. Trên máy mới, nếu `vite build` hoặc `wrangler dev` báo thiếu binary, chạy `npm install-scripts approve esbuild workerd`.

### 10.6 Endpoint tương thích cũ vẫn còn

Ví dụ `/api/system/browse-file`, `/api/runner/*`, `/api/insights/reels`. Tôi giữ lại vì không xác minh được có công cụ bên ngoài gọi hay không. Nếu chắc chắn không còn ai gọi, có thể gỡ trong một đợt riêng.
