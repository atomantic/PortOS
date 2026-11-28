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

# Keep the pre-install check on the same owner as npm run setup/start/dev.
# The Node script handles excluded release lines (23/25) as well as patch
# floors, without a second semver implementation in PowerShell.
node scripts/checkNodeVersion.js --security
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$nodeVersion = (node -v) -replace '^v', ''
if (-not $nodeVersion) {
    Write-Host "Unable to read the Node.js version after the compatibility check." -ForegroundColor Red
    exit 1
}
Write-Host "Found Node.js v$nodeVersion" -ForegroundColor Green
Write-Host ""

# scripts/setup.js is the one install pipeline shared with `npm run setup` and
# setup.sh: version checks, submodules, root/client/server deps (cwd-based
# installs, so no --prefix directory symlink that would need Developer Mode or admin
# rights on Windows) + the trusted native rebuilds, data dir, db, llm, browser, cert,
# then ffmpeg, slash-do and the setup walkthrough. This script keeps only the
# Windows-specific prompts around it.
node scripts/setup.js
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Setup incomplete. Fix the issue above, then re-run: .\setup.ps1" -ForegroundColor Red
    exit $LASTEXITCODE
}

# Optional Ghostty setup. Skip when stdin is redirected or the session is
# non-interactive (including `powershell -NonInteractive`) so automated/CI
# runs do not block or fail on Read-Host.
if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ""
    $setupGhostty = ""
    try {
        $setupGhostty = Read-Host "Set up Ghostty terminal themes? (y/N)"
    } catch {
        $setupGhostty = ""
    }
    if ($setupGhostty -match '^[Yy]$') {
        node scripts/setup-ghostty.js
    }
}

Write-Host ""
Write-Host "===================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Green
Write-Host ""
Write-Host "Start PortOS:"
Write-Host "  Development:  " -NoNewline; Write-Host "npm run dev" -ForegroundColor Cyan
Write-Host "  Production:   " -NoNewline; Write-Host "npm start" -ForegroundColor Cyan
Write-Host "  Stop:         " -NoNewline; Write-Host "npm run pm2:stop" -ForegroundColor Cyan
Write-Host "  Logs:         " -NoNewline; Write-Host "npm run pm2:logs" -ForegroundColor Cyan
Write-Host ""
node scripts/print-access-url.js | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
Write-Host ""
