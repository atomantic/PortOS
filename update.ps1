# PortOS Update Script for Windows PowerShell
$ErrorActionPreference = "Stop"

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "  PortOS Update" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# Resilient npm install — retries once after cleaning node_modules on failure
function Safe-Install {
    param([string]$Dir = ".", [string]$Label = "root")

    Write-Host "📦 Installing deps ($Label)..." -ForegroundColor Yellow
    Push-Location $Dir
    npm install 2>&1
    if ($LASTEXITCODE -eq 0) { Pop-Location; return }

    Write-Host "⚠️  npm install failed for $Label — cleaning node_modules and retrying..." -ForegroundColor Yellow
    Pop-Location
    if (Test-Path "$Dir/node_modules") {
        Remove-Item -Recurse -Force "$Dir/node_modules" -ErrorAction SilentlyContinue
    }
    Push-Location $Dir
    npm install 2>&1
    if ($LASTEXITCODE -eq 0) { Pop-Location; return }

    Pop-Location
    Write-Host "❌ npm install failed for $Label after retry" -ForegroundColor Red
    exit 1
}

# Pull latest
Write-Host "Pulling latest changes..." -ForegroundColor Yellow
git pull --rebase --autostash
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# Stop PM2 apps to release file locks before updating
Write-Host "Stopping PortOS apps..." -ForegroundColor Yellow
npm run pm2:stop 2>$null
Write-Host ""

# Update dependencies with retry logic
Write-Host "Updating dependencies..." -ForegroundColor Yellow
Safe-Install -Dir "." -Label "root"
Safe-Install -Dir "client" -Label "client"
Safe-Install -Dir "server" -Label "server"
Write-Host ""

# Verify critical dependencies exist
if (-not (Test-Path "client/node_modules/vite/bin/vite.js")) {
    Write-Host "❌ Critical dependency missing: client/node_modules/vite" -ForegroundColor Red
    Write-Host "   Try running: npm run install:all"
    exit 1
}

# Run setup (data dirs + browser deps)
Write-Host "Ensuring data & browser setup..." -ForegroundColor Yellow
npm run setup
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# Ghostty sync (if installed)
node scripts/setup-ghostty.js
Write-Host ""

# Restart PM2 apps
Write-Host "Restarting PortOS..." -ForegroundColor Yellow
npm run pm2:restart
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

Write-Host "===================================" -ForegroundColor Green
Write-Host "  ✅ Update Complete!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Green
Write-Host ""
