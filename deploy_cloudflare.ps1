# ==============================================================================
# KỊCH BẢN TỰ ĐỘNG HÓA DEPLOY LÊN CLOUDFLARE WORKERS + D1 + R2 (POWERSHELL)
# Worker Name : auto-reels-uploader
# Domain      : https://pagefb.namnangno.click
# Meta App ID : 1469615908436980
# ==============================================================================

$ErrorActionPreference = "Stop"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  DEPLOY CLOUDFLARE WORKER + D1 + R2: auto-reels-uploader       " -ForegroundColor Cyan
Write-Host "  Production URL: https://pagefb.namnangno.click                " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# Bước 1: Kiểm tra đăng nhập Cloudflare
Write-Host "`n[1/6] Kiểm tra tài khoản Cloudflare Wrangler..." -ForegroundColor Yellow
npx.cmd wrangler whoami
if ($LASTEXITCODE -ne 0) {
    Write-Host "Chưa đăng nhập Cloudflare. Đang mở trình duyệt để xác thực..." -ForegroundColor Yellow
    npx.cmd wrangler login
}

# Bước 2: Khởi tạo hoặc lấy ID của D1 Database (auto-reels-db)
Write-Host "`n[2/6] Kiểm tra / Tạo cơ sở dữ liệu Cloudflare D1 (auto-reels-db)..." -ForegroundColor Yellow
$wranglerContent = Get-Content -Path "wrangler.jsonc" -Raw

if ($wranglerContent -match '00000000-0000-0000-0000-000000000000') {
    Write-Host "Đang tạo D1 Database 'auto-reels-db'..." -ForegroundColor Cyan
    $d1Output = npx.cmd wrangler d1 create auto-reels-db 2>&1 | Out-String
    Write-Host $d1Output

    if ($d1Output -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
        $realDbId = $Matches[1]
        Write-Host "-> Đã lấy được database_id: $realDbId. Đang cập nhật wrangler.jsonc..." -ForegroundColor Green
        $wranglerContent = $wranglerContent -replace '00000000-0000-0000-0000-000000000000', $realDbId
        Set-Content -Path "wrangler.jsonc" -Value $wranglerContent -Encoding UTF8
    } else {
        Write-Host "Lưu ý: Nếu database 'auto-reels-db' đã tồn tại trước đó, đang tra cứu danh sách D1..." -ForegroundColor Yellow
        $d1List = npx.cmd wrangler d1 list 2>&1 | Out-String
        if ($d1List -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
            $realDbId = $Matches[1]
            Write-Host "-> Đã tìm thấy database_id: $realDbId. Đang cập nhật wrangler.jsonc..." -ForegroundColor Green
            $wranglerContent = $wranglerContent -replace '00000000-0000-0000-0000-000000000000', $realDbId
            Set-Content -Path "wrangler.jsonc" -Value $wranglerContent -Encoding UTF8
        }
    }
}

# Bước 3: Khởi tạo R2 Bucket (auto-reels-media)
Write-Host "`n[3/6] Kiểm tra / Tạo Cloudflare R2 Bucket (auto-reels-media)..." -ForegroundColor Yellow
try {
    npx.cmd wrangler r2 bucket create auto-reels-media 2>&1 | Out-Null
    Write-Host "-> R2 Bucket 'auto-reels-media' đã sẵn sàng!" -ForegroundColor Green
} catch {
    Write-Host "-> R2 Bucket 'auto-reels-media' đã tồn tại hoặc chưa bật R2 trên Dashboard." -ForegroundColor Gray
}

# Bước 4: Chạy D1 Schema Migrations trên Remote Cloudflare
Write-Host "`n[4/6] Áp dụng Schema Migrations (0001, 0002, 0003, 0004) lên Cloudflare D1 Remote..." -ForegroundColor Yellow
npx.cmd wrangler d1 migrations apply auto-reels-db --remote

# Bước 5: Kiểm tra bộ 30 bài test tự động trước khi Deploy
Write-Host "`n[5/6] Chạy bộ 30 bài kiểm thử tự động (Unit & Integration Tests)..." -ForegroundColor Yellow
node tests/test_worker.mjs

# Bước 6: Deploy Worker & Static Assets lên Cloudflare Edge
Write-Host "`n[6/6] Đang Deploy Worker + Static Assets lên https://pagefb.namnangno.click ..." -ForegroundColor Yellow
npx.cmd wrangler deploy

Write-Host "`n================================================================" -ForegroundColor Green
Write-Host "  HOÀN TẤT DEPLOY LÊN CLOUDFLARE!                               " -ForegroundColor Green
Write-Host "  - Trang chủ     : https://pagefb.namnangno.click              " -ForegroundColor Green
Write-Host "  - Đăng nhập     : https://pagefb.namnangno.click/login        " -ForegroundColor Green
Write-Host "  - OAuth Callback: https://pagefb.namnangno.click/api/meta/callback" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
