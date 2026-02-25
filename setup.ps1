# PortOS Setup Script for Windows PowerShell
$ErrorActionPreference = "Stop"

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "  PortOS Setup" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Host "Node.js is required but not installed." -ForegroundColor Red
    Write-Host "Install it from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check Node.js version
$nodeVersion = (node -v) -replace 'v', ''
$majorVersion = [int]($nodeVersion.Split('.')[0])
if ($majorVersion -lt 18) {
    Write-Host "Node.js 18+ required (found v$nodeVersion)" -ForegroundColor Red
    exit 1
}
Write-Host "Found Node.js v$nodeVersion" -ForegroundColor Green

# Install dependencies
# Note: Using --install-links to copy instead of symlink (required for exFAT filesystems)
Write-Host ""
Write-Host "Installing dependencies..." -ForegroundColor Yellow

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

# Run setup scripts
Write-Host ""
Write-Host "Setting up data directory..." -ForegroundColor Yellow
npm run setup
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""

# Optional Ghostty setup
$setupGhostty = Read-Host "Set up Ghostty terminal themes? (y/N)"
if ($setupGhostty -match '^[Yy]$') {
    node scripts/setup-ghostty.js
}

Write-Host ""
Write-Host "===================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Green
Write-Host ""
Write-Host "Start PortOS:"
Write-Host "  Development:  " -NoNewline; Write-Host "npm run dev" -ForegroundColor Cyan
Write-Host "  Production:   " -NoNewline; Write-Host "npm run pm2:start" -ForegroundColor Cyan
Write-Host "  Stop:         " -NoNewline; Write-Host "npm run pm2:stop" -ForegroundColor Cyan
Write-Host "  Logs:         " -NoNewline; Write-Host "npm run pm2:logs" -ForegroundColor Cyan
Write-Host ""
Write-Host "Access at: " -NoNewline; Write-Host "http://localhost:5555" -ForegroundColor Yellow
Write-Host ""
