# PortOS Update Script for Windows PowerShell
$ErrorActionPreference = "Stop"

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "  PortOS Update" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# Pull latest
Write-Host "Pulling latest changes..." -ForegroundColor Yellow
git pull --rebase --autostash
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# Update dependencies
Write-Host "Updating dependencies..." -ForegroundColor Yellow

Write-Host "  Installing root dependencies..."
npm install --install-links
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "  Installing client dependencies..."
Push-Location client
npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "  Installing server dependencies..."
Push-Location server
npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location
Write-Host ""

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
Write-Host "  Update Complete!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Green
Write-Host ""
