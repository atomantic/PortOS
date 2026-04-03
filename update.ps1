# PortOS Update Script for Windows PowerShell
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir
New-Item -ItemType Directory -Force -Path "$RootDir\data" | Out-Null

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "  PortOS Update" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# Safe write helper — suppresses broken-pipe IOExceptions when the parent
# Node process dies mid-update (mirrors the bash SIGPIPE trap)
function Write-SafeHost {
    param([string]$Text)
    try {
        Write-Host $Text
    } catch {
        if ($_.Exception -is [System.IO.IOException] -or
            $_.Exception.InnerException -is [System.IO.IOException] -or
            $_.Exception.ToString() -like "*The pipe has been ended*") {
            return
        }
        throw
    }
}

# Step output helper (parsed by updateExecutor for UI progress)
function Step {
    param([string]$Name, [string]$Status, [string]$Message)
    Write-SafeHost "STEP:${Name}:${Status}:${Message}"
}

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
Step "git-pull" "running" "Pulling latest changes..."
git pull --rebase --autostash
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Step "git-pull" "done" "Latest changes pulled"
Write-Host ""

# Stop PM2 apps to release file locks before updating
Step "pm2-stop" "running" "Stopping PortOS apps..."
npm run pm2:stop 2>$null
Step "pm2-stop" "done" "Apps stopped"
Write-Host ""

# Update dependencies with retry logic
Step "npm-install" "running" "Installing all dependencies..."
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
Step "npm-install" "done" "Dependencies installed"

# Run setup (data dirs + browser deps)
Write-Host "Ensuring data & browser setup..." -ForegroundColor Yellow
npm run setup
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# Ghostty sync (if installed)
node scripts/setup-ghostty.js
Write-Host ""

# Run data migrations
Step "migrations" "running" "Running data migrations..."
$migrationsScript = Join-Path $RootDir "scripts\run-migrations.js"
if (Test-Path $migrationsScript) {
    node $migrationsScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Step "migrations" "done" "Migrations complete"

# Check for slash-do (optional, used by the PR Reviewer schedule task)
$slashDoFound = Get-Command slash-do -ErrorAction SilentlyContinue
if (-not $slashDoFound) {
    Write-Host "slash-do is not installed. It is used by the PR Reviewer schedule task." -ForegroundColor Yellow
    if ([Environment]::UserInteractive) {
        $reply = Read-Host "Install slash-do now? [y/N]"
        if ($reply -match "^[Yy]$") {
            Write-Host "Installing slash-do..." -ForegroundColor Yellow
            npm install -g slash-do@latest 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host "⚠️  Failed to install slash-do. Continuing without it." -ForegroundColor Red
            }
        } else {
            Write-Host "Skipping slash-do install. You can install later with: npm install -g slash-do@latest"
        }
    } else {
        Write-Host "Skipping slash-do prompt (non-interactive). Install later with: npm install -g slash-do@latest"
    }
    Write-Host ""
}

# Build UI assets for production serving
Step "build" "running" "Building client..."
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Step "build" "done" "Client built"
Write-Host ""

# Write completion marker atomically before restart so server reads it on boot
$Tag = (Get-Content package.json | ConvertFrom-Json).version
$completedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$marker = "{`"version`":`"$Tag`",`"completedAt`":`"$completedAt`"}"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$RootDir\data\update-complete.json.tmp", $marker, $utf8NoBom)
Move-Item -Force "$RootDir\data\update-complete.json.tmp" "$RootDir\data\update-complete.json"

# Restart PM2 apps — remove marker if restart fails so it isn't misread on boot
Step "restart" "running" "Restarting PortOS..."
npm run pm2:restart
if ($LASTEXITCODE -ne 0) {
    if (Test-Path "$RootDir\data\update-complete.json") {
        Remove-Item -Force "$RootDir\data\update-complete.json"
    }
    exit $LASTEXITCODE
}
Step "restart" "done" "PortOS restarted"
Write-Host ""

Write-Host "===================================" -ForegroundColor Green
Write-Host "  ✅ Update Complete!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Green
Write-Host ""
