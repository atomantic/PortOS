# PortOS Update Script for Windows PowerShell
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir
New-Item -ItemType Directory -Force -Path "$RootDir\data" | Out-Null

# Log file for external command output — keeps noisy git/npm/node output
# off the parent pipe so broken-pipe errors don't abort the update
$UpdateLog = Join-Path $RootDir "data\update.log"
"" | Set-Content -Path $UpdateLog

# Safe write helper — suppresses broken-pipe IOExceptions when the parent
# Node process dies mid-update (mirrors the bash SIGPIPE trap)
function Write-SafeHost {
    param(
        [string]$Text,
        [string]$ForegroundColor = ""
    )
    try {
        if ($ForegroundColor) {
            Write-Host $Text -ForegroundColor $ForegroundColor
        } else {
            Write-Host $Text
        }
    } catch {
        if ($_.Exception -is [System.IO.IOException] -or
            $_.Exception.InnerException -is [System.IO.IOException] -or
            $_.Exception.ToString() -like "*The pipe has been ended*") {
            return
        }
        throw
    }
}

# Safe stdout helper for machine-readable output consumed by the parent process.
# Uses [Console]::Out.WriteLine so STEP markers reach stdout even when Write-Host
# is redirected to the information stream.
function Write-SafeStdout {
    param([string]$Text)
    try {
        [Console]::Out.WriteLine($Text)
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
    Write-SafeStdout "STEP:${Name}:${Status}:${Message}"
}

# Run an external command, routing stdout/stderr to the log file so
# broken-pipe errors from the parent Node process don't abort the update
function Invoke-Logged {
    param([Parameter(ValueFromRemainingArguments)]$CmdArgs)
    $cmd = $CmdArgs[0]
    $args = @()
    if ($CmdArgs.Count -gt 1) { $args = $CmdArgs[1..($CmdArgs.Count - 1)] }
    & $cmd @args >> $UpdateLog 2>&1
}

Write-SafeHost "===================================" -ForegroundColor Cyan
Write-SafeHost "  PortOS Update" -ForegroundColor Cyan
Write-SafeHost "===================================" -ForegroundColor Cyan
Write-SafeHost ""

# Resilient npm install — retries once after cleaning node_modules on failure
function Safe-Install {
    param([string]$Dir = ".", [string]$Label = "root")

    Write-SafeHost "📦 Installing deps ($Label)..." -ForegroundColor Yellow
    Push-Location $Dir
    Invoke-Logged npm install
    if ($LASTEXITCODE -eq 0) { Pop-Location; return }

    Write-SafeHost "⚠️  npm install failed for $Label — cleaning node_modules and retrying..." -ForegroundColor Yellow
    Pop-Location
    if (Test-Path "$Dir/node_modules") {
        Remove-Item -Recurse -Force "$Dir/node_modules" -ErrorAction SilentlyContinue
    }
    Push-Location $Dir
    Invoke-Logged npm install
    if ($LASTEXITCODE -eq 0) { Pop-Location; return }

    Pop-Location
    Write-SafeHost "❌ npm install failed for $Label after retry" -ForegroundColor Red
    exit 1
}

# Pull latest — ensure we're on a branch first (old updater may have left
# the repo in detached HEAD after checking out a tag)
Step "git-pull" "running" "Pulling latest changes..."
$headRef = git symbolic-ref -q HEAD 2>$null
if (-not $headRef) {
    Write-SafeHost "⚠️  Detached HEAD detected — checking out main branch" -ForegroundColor Yellow
    Invoke-Logged git checkout main
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Invoke-Logged git pull --rebase --autostash
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Step "git-pull" "done" "Latest changes pulled"
Write-SafeHost ""

# Update submodules (slash-do and any others)
Step "submodules" "running" "Updating submodules..."
Invoke-Logged git submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Step "submodules" "done" "Submodules updated"
Write-SafeHost ""

# Stop PM2 apps to release file locks before updating
Step "pm2-stop" "running" "Stopping PortOS apps..."
Invoke-Logged npm run pm2:stop
Step "pm2-stop" "done" "Apps stopped"
Write-SafeHost ""

# Update dependencies with retry logic
Step "npm-install" "running" "Installing all dependencies..."
Safe-Install -Dir "." -Label "root"
Safe-Install -Dir "client" -Label "client"
Safe-Install -Dir "server" -Label "server"
Safe-Install -Dir "autofixer" -Label "autofixer"

# Run trusted install scripts skipped by ignore-scripts=true in .npmrc
Write-SafeHost "🔧 Rebuilding esbuild & node-pty..." -ForegroundColor Yellow
Invoke-Logged node client/node_modules/esbuild/install.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged node server/node_modules/esbuild/install.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged npm rebuild node-pty --prefix server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-SafeHost ""

# Verify critical dependencies exist
if (-not (Test-Path "client/node_modules/vite/bin/vite.js")) {
    Write-SafeHost "❌ Critical dependency missing: client/node_modules/vite" -ForegroundColor Red
    Write-SafeHost "   Try running: npm run install:all"
    exit 1
}
Step "npm-install" "done" "Dependencies installed"

# Run data/db/browser setup. Don't call `npm run setup` — that re-runs the
# installs we just did above. The three scripts here are the data-side half
# of `npm run setup` and are idempotent.
Step "setup" "running" "Running setup..."
Invoke-Logged node scripts/setup-data.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged node scripts/setup-db.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged node scripts/setup-browser.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged node scripts/setup-ghostty.js
Step "setup" "done" "Setup complete"
Write-SafeHost ""

# Run data migrations
Step "migrations" "running" "Running data migrations..."
$migrationsScript = Join-Path $RootDir "scripts\run-migrations.js"
if (Test-Path $migrationsScript) {
    Invoke-Logged node $migrationsScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Step "migrations" "done" "Migrations complete"

# Check for slash-do (optional, used by the PR Reviewer schedule task)
$slashDoFound = Get-Command slash-do -ErrorAction SilentlyContinue
if (-not $slashDoFound) {
    Write-SafeHost "slash-do is not installed. It is used by the PR Reviewer schedule task." -ForegroundColor Yellow
    if ([Environment]::UserInteractive) {
        $reply = Read-Host "Install slash-do now? [y/N]"
        if ($reply -match "^[Yy]$") {
            Write-SafeHost "Installing slash-do..." -ForegroundColor Yellow
            Invoke-Logged npm install -g slash-do@latest
            if ($LASTEXITCODE -ne 0) {
                Write-SafeHost "⚠️  Failed to install slash-do. Continuing without it." -ForegroundColor Red
            }
        } else {
            Write-SafeHost "Skipping slash-do install. You can install later with: npm install -g slash-do@latest"
        }
    } else {
        Write-SafeHost "Skipping slash-do prompt (non-interactive). Install later with: npm install -g slash-do@latest"
    }
    Write-SafeHost ""
}

# Build UI assets for production serving
Step "build" "running" "Building client..."
Invoke-Logged npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Step "build" "done" "Client built"
Write-SafeHost ""

# Write completion marker atomically before restart so server reads it on boot
$Tag = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Tag) {
    Write-SafeHost "❌ Failed to determine package version from package.json" -ForegroundColor Red
    exit 1
}
$completedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$markerObj = @{ version = $Tag; completedAt = $completedAt }
$marker = $markerObj | ConvertTo-Json -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$RootDir\data\update-complete.json.tmp", $marker, $utf8NoBom)
Move-Item -Force "$RootDir\data\update-complete.json.tmp" "$RootDir\data\update-complete.json"

# Restart PM2 apps — remove marker if restart fails so it isn't misread on boot
Step "restart" "running" "Restarting PortOS..."
Invoke-Logged npm run pm2:restart
if ($LASTEXITCODE -ne 0) {
    if (Test-Path "$RootDir\data\update-complete.json") {
        Remove-Item -Force "$RootDir\data\update-complete.json"
    }
    exit $LASTEXITCODE
}
Step "restart" "done" "PortOS restarted"
Write-SafeHost ""

# Open the dashboard in the PortOS-managed browser. Fail-soft — explicitly
# reset $LASTEXITCODE to 0 after the call so a non-zero exit from the auto-
# open script doesn't propagate as the script's own exit code (the update
# is already complete by this point).
Invoke-Logged node scripts/open-ui-in-browser.js
$global:LASTEXITCODE = 0

Write-SafeHost "===================================" -ForegroundColor Green
Write-SafeHost "  ✅ Update Complete!" -ForegroundColor Green
Write-SafeHost "===================================" -ForegroundColor Green
Write-SafeHost ""
