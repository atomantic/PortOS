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

# Pull latest — always switch to main (detached HEAD or feature branch both
# need to land on main before pulling, or the version won't advance). The
# rest of the script (install, build, restart) runs on main so the app
# starts on the freshly-pulled revision. Local edits on the original branch
# are stashed first so checkout doesn't abort, and we leave them in the
# stash list afterward — the user can restore with `git stash pop` after
# the update completes (we don't auto-pop because the rest of the script
# needs to keep running with main's contents).
Step "git-pull" "running" "Pulling latest changes..."
$originUrl = git remote get-url origin 2>$null
if ($originUrl) {
    # Redact any embedded credentials (https://user:token@host/...) before logging
    # so PATs don't leak into data/update.log or the update UI step output.
    $originUrlSafe = $originUrl -replace '(://)[^@/]+@', '$1***@'
    Write-SafeHost "🌐 Pulling from origin: $originUrlSafe"
    # Also append directly to $UpdateLog — updateExecutor only forwards STEP:
    # lines, so Write-SafeHost above doesn't reach update.log on its own.
    Add-Content -Path $UpdateLog -Value "🌐 Pulling from origin: $originUrlSafe"
}
$headRef = git symbolic-ref -q HEAD 2>$null
$currentBranch = if ($headRef) { $headRef -replace "refs/heads/", "" } else { "" }
$stashedForBranch = ""
$stashedForCommit = ""
if ($currentBranch -ne "main") {
    $hasChanges = $false
    git diff --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { $hasChanges = $true }
    if (-not $hasChanges) {
        git diff --cached --quiet 2>$null
        if ($LASTEXITCODE -ne 0) { $hasChanges = $true }
    }
    if (-not $hasChanges) {
        $untracked = git ls-files --others --exclude-standard
        if ($untracked) { $hasChanges = $true }
    }
    if ($hasChanges) {
        $branchLabel = if ($currentBranch) { $currentBranch } else { "detached HEAD" }
        Write-SafeHost "⚠️  Stashing local changes from '$branchLabel' so checkout can proceed" -ForegroundColor Yellow
        Invoke-Logged git stash push -u -m "portos-update-$([int][double]::Parse((Get-Date -UFormat %s)))"
        if ($LASTEXITCODE -eq 0) {
            $stashedForBranch = $branchLabel
            # Capture the original commit SHA so detached-HEAD users can return
            # to the exact tree their stash was taken from.
            $stashedForCommit = git rev-parse HEAD
        }
    }
    if (-not $currentBranch) {
        $detachedCommit = git rev-parse --short HEAD
        Write-SafeHost "⚠️  On detached HEAD (commit $detachedCommit) — switching to main for update" -ForegroundColor Yellow
    } else {
        Write-SafeHost "⚠️  On branch '$currentBranch' — switching to main for update" -ForegroundColor Yellow
    }
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

# Kill PM2 daemon entirely — pm2 stop/restart only signal app processes but
# leave the daemon alive. If the daemon was originally launched from a different
# project, it can cache a stale ProcessContainerFork.js path and crash future
# fork() calls with MODULE_NOT_FOUND. Killing the daemon mirrors update.sh and
# forces a fresh launch from this checkout on restart.
Step "pm2-stop" "running" "Stopping PortOS apps..."
Invoke-Logged node ./node_modules/pm2/bin/pm2 kill
if ($LASTEXITCODE -ne 0) {
    Write-SafeHost "⚠️  PM2 daemon was not running or could not be killed; continuing update" -ForegroundColor Yellow
}
Step "pm2-stop" "done" "Apps stopped"
Write-SafeHost ""

# Update dependencies with retry logic
Step "npm-install" "running" "Installing all dependencies..."
Safe-Install -Dir "." -Label "root"
Safe-Install -Dir "client" -Label "client"
Safe-Install -Dir "server" -Label "server"
Safe-Install -Dir "autofixer" -Label "autofixer"

# Run trusted install scripts skipped by ignore-scripts=true in .npmrc
Write-SafeHost "🔧 Rebuilding esbuild, node-pty & sharp..." -ForegroundColor Yellow
Invoke-Logged node client/node_modules/esbuild/install.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged node server/node_modules/esbuild/install.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged npm rebuild node-pty sharp --prefix server
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

# Install/update slash-do commands. Replaces the previous interactive prompt
# with an always-on `npx slash-do@latest` call so the user-global command
# pool stays current across updates. Failures are non-fatal.
# Pipe "a" so slash-do's "multiple environments detected" prompt auto-selects
# all detected envs instead of hanging on readline (update.ps1 has no TTY).
Step "slash-do" "running" "Installing/updating slash-do commands..."
"a" | & npx --yes slash-do@latest >> $UpdateLog 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-SafeHost "⚠️  slash-do install/update failed. Continuing (re-run later: npx slash-do@latest)." -ForegroundColor Yellow
    $global:LASTEXITCODE = 0
}
Step "slash-do" "done" "slash-do commands installed/updated"
Write-SafeHost ""

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

# Start PM2 apps — `pm2 kill` above tore down the daemon, so use `start` not
# `restart` (restart against a config doesn't reliably start processes that
# aren't currently managed, leaving the app stopped after an update that ran
# while PortOS wasn't running). `delete --silent` first so a partial prior
# state doesn't make `start` a no-op, then `save` so the apps come back on
# reboot. Remove the completion marker if start fails so it isn't misread on boot.
Step "restart" "running" "Starting PortOS..."
Invoke-Logged node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent
$global:LASTEXITCODE = 0
Invoke-Logged node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs
if ($LASTEXITCODE -ne 0) {
    if (Test-Path "$RootDir\data\update-complete.json") {
        Remove-Item -Force "$RootDir\data\update-complete.json"
    }
    exit $LASTEXITCODE
}
Invoke-Logged node ./node_modules/pm2/bin/pm2 save
$global:LASTEXITCODE = 0
Step "restart" "done" "PortOS started"
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

if ($stashedForBranch) {
    Write-SafeHost "ℹ️  Your local changes from '$stashedForBranch' were stashed for the update." -ForegroundColor Cyan
    if ($stashedForBranch -eq "detached HEAD") {
        Write-SafeHost "    To restore them: git checkout $stashedForCommit; git stash pop" -ForegroundColor Cyan
    } else {
        Write-SafeHost "    To restore them: git checkout '$stashedForBranch'; git stash pop" -ForegroundColor Cyan
    }
    Write-SafeHost "    The stash entry is at the top of 'git stash list'." -ForegroundColor Cyan
}
