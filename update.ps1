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
    # Name must differ from $CmdArgs by more than case — PowerShell variable names are
    # case-insensitive, so a $cmdArgs would alias the $CmdArgs parameter and wipe it.
    $cmdRest = @()
    if ($CmdArgs.Count -gt 1) { $cmdRest = $CmdArgs[1..($CmdArgs.Count - 1)] }
    # Native commands (git, npm, node) routinely write progress/status to stderr —
    # `git pull` prints "From https://github.com/..." there on every SUCCESSFUL run.
    # Under the script-level $ErrorActionPreference='Stop', PowerShell promotes that
    # redirected stderr into a terminating NativeCommandError and aborts the update on
    # a command that actually succeeded (issue #1811). Real failures are detected via
    # $LASTEXITCODE by every caller, so downgrade the error action to Continue for the
    # external call only — this assignment is function-scoped and reverts on return.
    $ErrorActionPreference = 'Continue'
    & $cmd @cmdRest >> $UpdateLog 2>&1
}

Write-SafeHost "===================================" -ForegroundColor Cyan
Write-SafeHost "  PortOS Update" -ForegroundColor Cyan
Write-SafeHost "===================================" -ForegroundColor Cyan
Write-SafeHost ""

# Which workspaces' package.json this update touched (populated after the pull
# below). When the pulled update changed a workspace's manifest, an in-place
# `npm install` over a node_modules tree resolved for the PREVIOUS major
# versions can leave a duplicated/stale tree (e.g. a stray react@18 copy beside
# react@19) — which builds fine but throws "Invalid hook call" at runtime. A
# from-scratch reinstall is the only reliable fix for a major dependency bump.
$script:DepsChangedFiles = @()
$script:DepsChangedUnknown = $false

function Test-WorkspaceDepsChanged {
    param([string]$Dir)
    if ($script:DepsChangedUnknown) { return $true }
    # RECONCILE (issue #1779): PortOS passes the workspaces whose installed deps
    # are stale (per npm's install receipt) in PORTOS_FORCE_CLEAN_WORKSPACES, so
    # they get a from-scratch reinstall even when the commit diff is empty (a
    # bare `git pull`, possibly already restarted). Mirrors update.sh.
    if ($env:PORTOS_FORCE_CLEAN_WORKSPACES) {
        $forced = $env:PORTOS_FORCE_CLEAN_WORKSPACES -split ','
        if ($forced -contains $Dir) { return $true }
    }
    $rel = if ($Dir -eq ".") { "package.json" } else { ($Dir -replace '^\./', '') + "/package.json" }
    return $script:DepsChangedFiles -contains $rel
}

# Wipe a workspace's installed deps so the next `npm install` resolves the tree
# from scratch. node_modules is always removed; the lockfile is removed ONLY
# when it's gitignored (the per-install client/server locks) — a tracked root
# or autofixer lock was just pulled and is already consistent with the new
# package.json, so keep it for reproducible resolution.
function Clear-WorkspaceDeps {
    param([string]$Dir)
    if (Test-Path "$Dir/node_modules") {
        Remove-Item -Recurse -Force "$Dir/node_modules" -ErrorAction SilentlyContinue
    }
    git check-ignore -q "$Dir/package-lock.json" 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path "$Dir/package-lock.json")) {
        Remove-Item -Force "$Dir/package-lock.json" -ErrorAction SilentlyContinue
    }
}

# Resilient npm install — retries once after cleaning node_modules on failure
function Safe-Install {
    param([string]$Dir = ".", [string]$Label = "root")

    # Force a clean reinstall when this update changed the workspace's deps —
    # never trust an in-place install across a dependency-manifest change.
    if (Test-WorkspaceDepsChanged -Dir $Dir) {
        Write-SafeHost "🧹 $Label package.json changed in this update — clean reinstall (wiping node_modules)" -ForegroundColor Yellow
        Clear-WorkspaceDeps -Dir $Dir
    }

    Write-SafeHost "📦 Installing deps ($Label)..." -ForegroundColor Yellow
    Push-Location $Dir
    Invoke-Logged npm install
    if ($LASTEXITCODE -eq 0) { Pop-Location; return }

    Write-SafeHost "⚠️  npm install failed for $Label — cleaning node_modules + package-lock.json and retrying..." -ForegroundColor Yellow
    Pop-Location
    Clear-WorkspaceDeps -Dir $Dir
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
# Record main's pre-pull HEAD — captured AFTER any checkout so it's the commit
# the installed node_modules was built from (main, which the rest of this script
# installs/builds), not a feature branch we just left. Diffing this against
# post-pull HEAD yields exactly the pull's delta on main, so a manifest change
# the update brings is detected even when launched from another branch.
$prePullSha = git rev-parse HEAD 2>$null
Invoke-Logged git pull --rebase --autostash
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Step "git-pull" "done" "Latest changes pulled"

# Determine which workspaces' package.json this update touched, so Safe-Install
# can force a clean reinstall for them (see Test-WorkspaceDepsChanged). If the
# from-revision is unknown/unreachable (fresh clone, unrelated history), treat
# deps as changed everywhere — a clean reinstall is the conservative default.
if ($prePullSha) {
    git cat-file -e "$prePullSha^{commit}" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $diff = git diff --name-only $prePullSha HEAD 2>$null
        if ($diff) { $script:DepsChangedFiles = @($diff) }
    } else {
        $script:DepsChangedUnknown = $true
    }
} else {
    $script:DepsChangedUnknown = $true
}
$global:LASTEXITCODE = 0
Write-SafeHost ""

# Update submodules (slash-do and any others)
Step "submodules" "running" "Updating submodules..."
Invoke-Logged git submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Step "submodules" "done" "Submodules updated"
Write-SafeHost ""

# Remove ONLY PortOS's apps from the shared PM2 daemon — never `pm2 kill`, which
# tears down the daemon and stops EVERY other project's apps on this machine.
# `pm2 update` then reloads the daemon in place from this checkout's node_modules,
# refreshing its cached ProcessContainerFork.js path (a stale path from a daemon
# originally launched by another project — e.g. a Yarn PnP zip cache — makes
# future fork() calls crash with MODULE_NOT_FOUND) while leaving other projects'
# apps running instead of killing them.
Step "pm2-stop" "running" "Stopping PortOS apps..."
Invoke-Logged node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent
$global:LASTEXITCODE = 0
Invoke-Logged node ./node_modules/pm2/bin/pm2 update
$global:LASTEXITCODE = 0
Step "pm2-stop" "done" "Apps stopped"
Write-SafeHost ""

# Update dependencies with retry logic
Step "npm-install" "running" "Installing all dependencies..."
Safe-Install -Dir "." -Label "root"
Safe-Install -Dir "client" -Label "client"
Safe-Install -Dir "server" -Label "server"
Safe-Install -Dir "autofixer" -Label "autofixer"

# Run trusted install scripts skipped by ignore-scripts=true in .npmrc.
# Use `npm rebuild esbuild` rather than a hardcoded node_modules/esbuild/install.js
# path: esbuild is no longer hoisted to the top of either tree (it nests under
# vite/vitest), and the server has no direct esbuild dependency at all since
# vitest 4 → vite 8 dropped it — so the old install.js path 404'd and crashed
# the update. `npm rebuild` finds esbuild wherever it lives and no-ops cleanly
# when absent. Server rebuild is non-fatal (esbuild is a test-only transitive
# there, not needed for runtime or the production build).
Write-SafeHost "🔧 Rebuilding esbuild, node-pty & sharp..." -ForegroundColor Yellow
Invoke-Logged npm rebuild esbuild --prefix client
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Logged npm rebuild esbuild --prefix server
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
# npx writes status to stderr; scope the same Continue downgrade as Invoke-Logged
# around this stdin-piped call so it isn't aborted by a NativeCommandError (#1811).
# $LASTEXITCODE set inside the script block still propagates to the check below.
& {
    $ErrorActionPreference = 'Continue'
    "a" | & npx --yes slash-do@latest >> $UpdateLog 2>&1
}
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

# Start PM2 apps — use `start` not `restart` (restart against a config doesn't
# reliably start processes that
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

# Tell the user where to open PortOS — leads with the working local URL
# (http://localhost:5553 mirror in HTTPS mode, :5555 in plain-HTTP mode) so they
# don't land on a dead http://localhost:5555 when a Tailscale cert has forced
# :5555 into TLS-only. Mirrors setup.sh's print_access_url banner; gated on the
# same cert predicate the server uses, so we never advertise a URL it isn't serving.
$accessUrl = & node scripts/print-access-url.js 2>$null
$global:LASTEXITCODE = 0
if ($accessUrl) {
    $accessUrl | ForEach-Object { Write-SafeHost $_ -ForegroundColor Cyan }
    Write-SafeHost ""
}

if ($stashedForBranch) {
    Write-SafeHost "ℹ️  Your local changes from '$stashedForBranch' were stashed for the update." -ForegroundColor Cyan
    if ($stashedForBranch -eq "detached HEAD") {
        Write-SafeHost "    To restore them: git checkout $stashedForCommit; git stash pop" -ForegroundColor Cyan
    } else {
        Write-SafeHost "    To restore them: git checkout '$stashedForBranch'; git stash pop" -ForegroundColor Cyan
    }
    Write-SafeHost "    The stash entry is at the top of 'git stash list'." -ForegroundColor Cyan
}
