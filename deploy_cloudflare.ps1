# ============================================================================
# SCRIPT TRIỂN KHAI TỰ ĐỘNG CLOUDFLARE WORKERS + D1 (WINDOWS POWERSHELL)
# Domain : https://pagefb.namnangno.click
# App ID : 1469615908436980
# ============================================================================

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " TRIỂN KHAI HỆ THỐNG QUẢN LÝ FANPAGE LÊN CLOUDFLARE EDGE  " -ForegroundColor Cyan
Write-Host " Domain: https://pagefb.namnangno.click                   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Cài đặt dependencies nếu chưa có
if (-not (Test-Path "node_modules")) {
    Write-Host "`n[1/5] Đang cài đặt gói phụ thuộc (typescript, wrangler)..." -ForegroundColor Yellow
    npm.cmd install
} else {
    Write-Host "`n[1/5] Đã có node_modules." -ForegroundColor Green
}

# 2. Kiểm tra TypeScript Typecheck
Write-Host "`n[2/5] Đang kiểm tra TypeScript (tsc --noEmit)..." -ForegroundColor Yellow
npx.cmd tsc --noEmit
Write-Host "✓ TypeScript hợp lệ 100%!" -ForegroundColor Green

# 3. Kiểm tra / Khởi tạo Cloudflare D1 Database
$wranglerContent = Get-Content "wrangler.toml" -Raw
if ($wranglerContent -match "00000000-0000-0000-0000-000000000000") {
    Write-Host "`n[3/5] Đang khởi tạo Cloudflare D1 Database 'pagefb-db'..." -ForegroundColor Yellow
    $d1Output = npx.cmd wrangler d1 create pagefb-db 2>&1 | Out-String
    Write-Host $d1Output
    if ($d1Output -match 'database_id\s*=\s*"([a-f0-9\-]{36})"') {
        $newDbId = $Matches[1]
        Write-Host "✓ Đã nhận database_id: $newDbId. Đang cập nhật vào wrangler.toml..." -ForegroundColor Green
        $updatedToml = $wranglerContent -replace "00000000-0000-0000-0000-000000000000", $newDbId
        Set-Content -Path "wrangler.toml" -Value $updatedToml -Encoding UTF8
    } else {
        Write-Host "⚠ Nếu database 'pagefb-db' đã tồn tại trên tài khoản của bạn, hãy chạy: npx.cmd wrangler d1 list và điền database_id vào wrangler.toml" -ForegroundColor Yellow
    }
}

# 4. Chạy Migration lên Cloudflare D1 Remote
Write-Host "`n[4/5] Đang áp dụng Database Schema (migrations/0001_init.sql) lên Cloudflare D1..." -ForegroundColor Yellow
npx.cmd wrangler d1 migrations apply pagefb-db --remote

# 5. Deploy Worker + Static Assets lên https://pagefb.namnangno.click
Write-Host "`n[5/5] Đang deploy ứng dụng lên Cloudflare Workers (https://pagefb.namnangno.click)..." -ForegroundColor Yellow
npx.cmd wrangler deploy

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host " HOÀN TẤT DEPLOY LÊN https://pagefb.namnangno.click !     " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

