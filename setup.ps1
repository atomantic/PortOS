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

# Check Node.js version. Vite 8 (client build) requires ^20.19 || >=22.12, so an
# older install fails at `npm run build` rather than here. This mirrors MIN_NODE
# in scripts/checkNodeVersion.js, which owns the floor and re-checks it at the
# head of `npm run setup` below; scripts/node-version-drift.test.js keeps the two
# literals in sync.
$nodeVersion = (node -v) -replace 'v', ''
$majorVersion = [int]($nodeVersion.Split('.')[0])
$minorVersion = [int]($nodeVersion.Split('.')[1])
if ($majorVersion -lt 22 -or ($majorVersion -eq 22 -and $minorVersion -lt 12)) {
    Write-Host "Node.js 22.12+ required (found v$nodeVersion) - see .nvmrc" -ForegroundColor Red
    exit 1
}
Write-Host "Found Node.js v$nodeVersion" -ForegroundColor Green
Write-Host ""

# Update submodules (slash-do and any others)
Write-Host "Updating submodules..." -ForegroundColor Yellow
git submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# Install dependencies — --no-save honors each committed lockfile without
# rewriting it through the local npm's lockfile schema. Use Push-Location instead
# of --prefix so npm doesn't create a directory symlink (root package into
# sub-package node_modules), which requires Developer Mode or admin rights on Windows.
Write-Host "Installing dependencies..." -ForegroundColor Yellow

Write-Host "  Installing root dependencies..."
npm install --no-save
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "  Installing client dependencies..."
Push-Location client
npm install --no-save
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "  Installing server dependencies..."
Push-Location server
npm install --no-save
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "  Installing autofixer dependencies..."
Push-Location autofixer
npm install --no-save
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

# Run trusted install scripts skipped by ignore-scripts=true in each workspace's
# .npmrc. The allowlist lives in scripts/trusted-rebuilds.js — a single home shared
# with `npm run setup`, scripts/ensure-deps.js, update.sh/update.ps1 and CI, so a
# package can never be granted an install-time execution slot in one path but not
# another. Only the server needs rebuilds; client/autofixer/browser have no
# install-script deps — vite 8 dropped the esbuild binary dependency that used to be
# the reason, which is also what made the old hardcoded esbuild/install.js path fail
# with MODULE_NOT_FOUND on Windows (issue #1792).
Write-Host ""
Write-Host "Rebuilding trusted native dependencies..." -ForegroundColor Yellow
node scripts/trusted-rebuilds.js server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Run data setup scripts
Write-Host ""
Write-Host "Setting up data directory..." -ForegroundColor Yellow
node scripts/setup-data.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-db.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-llm.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-browser.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-cert.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/setup-guide.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Install/update slash-do (project-level slash commands for Claude Code et al.)
# via npx. Failures are non-fatal — PortOS still works without the
# user-global command pool.
Write-Host ""
Write-Host "Installing/updating slash-do commands (npx slash-do@latest)..." -ForegroundColor Yellow
# Pipe "a" so slash-do's "multiple environments detected" prompt auto-selects
# all detected envs instead of hanging on readline when stdin is not a TTY.
"a" | & npx --yes slash-do@latest
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  slash-do install failed — skipping (you can re-run later: npx slash-do@latest)" -ForegroundColor Yellow
    $global:LASTEXITCODE = 0
}

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
node scripts/print-access-url.js | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
Write-Host ""
