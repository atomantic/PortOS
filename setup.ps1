# PortOS Setup Script for Windows PowerShell
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

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
Write-Host ""

# Update submodules (slash-do and any others)
Write-Host "Updating submodules..." -ForegroundColor Yellow
git submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# Install dependencies — use Push-Location instead of --prefix so npm doesn't
# create a directory symlink (root package into sub-package node_modules), which
# requires Developer Mode or admin rights on Windows.
Write-Host "Installing dependencies..." -ForegroundColor Yellow

Write-Host "  Installing root dependencies..."
npm install
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

Write-Host "  Installing autofixer dependencies..."
Push-Location autofixer
npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

# Rebuild native bindings
Write-Host ""
Write-Host "Rebuilding esbuild & node-pty..." -ForegroundColor Yellow
node client/node_modules/esbuild/install.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node server/node_modules/esbuild/install.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm rebuild node-pty --prefix server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Run data setup scripts
Write-Host ""
Write-Host "Setting up data directory..." -ForegroundColor Yellow
node scripts/setup-data.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-db.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-browser.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Optional Ghostty setup
Write-Host ""
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
Write-Host "  Production:   " -NoNewline; Write-Host "npm start" -ForegroundColor Cyan; Write-Host " (or npm run pm2:start)" -NoNewline -ForegroundColor Gray; Write-Host ""
Write-Host "  Stop:         " -NoNewline; Write-Host "npm run pm2:stop" -ForegroundColor Cyan
Write-Host "  Logs:         " -NoNewline; Write-Host "npm run pm2:logs" -ForegroundColor Cyan
Write-Host ""
Write-Host "Access at: " -NoNewline; Write-Host "http://localhost:5555" -ForegroundColor Yellow
Write-Host ""
