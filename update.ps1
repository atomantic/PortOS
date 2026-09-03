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

# Headless-install guard (mirrors update.sh). From the `pm2-stop` step below
# until the closing `pm2 start` succeeds, PortOS's PM2 entries are DELETED — the
# install has no server. Every step in between (npm install, setup-db,
# migrations, the client build) can fail, and each of those failures exits this
# script with the apps still deleted and nothing left running to notice: the
# "update deleted portos-server and it never came back" failure. So restore the
# apps on the way out instead of leaving the machine headless.
#
# This block sits here — above every fatal exit in the script, not beside the
# delete it guards — because PowerShell's `exit` inside a function terminates the
# whole script WITHOUT raising a terminating error, bypassing both the trap and
# any later-defined helper. Safe-Install is defined above the delete and called
# below it, so a guard defined between them could never catch its exit.
#
# Starting the pulled tree after a failed install can crash-loop, but a
# crash-looping app the user can see beats a silently headless machine — and the
# recovery only ever runs on a path that was already leaving PortOS down.
$script:Pm2AppsDown = $false

# Which pm2 the recovery can actually reach. It CANNOT assume this checkout's own
# copy: Safe-Install wipes root node_modules whenever the pulled update touched
# root package.json — which every release does, since the version bump lives
# there — and pm2 is a ROOT dependency. So on the most likely failure of all
# (both npm install attempts fail) the checkout's pm2 is already gone by the time
# the recovery runs. Any pm2 CLI can drive the already-running daemon, so falling
# back to one on PATH, or to npx, is fine for a recovery.
function Resolve-Pm2Command {
    if (Test-Path "$RootDir\node_modules\pm2\bin\pm2") {
        return @('node', (Join-Path $RootDir 'node_modules/pm2/bin/pm2'))
    }
    if (Get-Command pm2 -ErrorAction SilentlyContinue) {
        return @('pm2')
    }
    $pinned = try { (Get-Content "$RootDir\package.json" -Raw | ConvertFrom-Json).dependencies.pm2 } catch { $null }
    if ($pinned) { return @('npx', '--yes', "pm2@$pinned") }
    return @('npx', '--yes', 'pm2')
}

function Restore-Pm2Apps {
    if (-not $script:Pm2AppsDown) { return }
    $script:Pm2AppsDown = $false
    try {
        # @() at the call site is what keeps the shape right: `return` ENUMERATES
        # an array into the output stream, so a single-element branch would arrive
        # as a bare string and `$pm2 + @('start', …)` would concatenate into one
        # garbage token. @() collects the stream back into a flat array. Every
        # branch must therefore return a PLAIN array — a `,@(…)` wrapper would
        # emit the array as one item and @() would nest rather than flatten it.
        $pm2 = @(Resolve-Pm2Command)
        Write-SafeHost "⚠️  Update is exiting with PortOS's apps deleted — restarting them so the install isn't left headless." -ForegroundColor Yellow
        Step "restart" "running" "Update failed — restarting PortOS so it isn't left down..."
        # `pm2 start` exiting 0 is not proof the server came back (same reason the
        # verify step below exists) — and this path starts a HALF-INSTALLED tree, so
        # a start that exits 0 and then crash-loops is the likely case here, not the
        # edge case. Never claim a recovery the health probe doesn't confirm.
        $ecosystem = Join-Path $RootDir 'ecosystem.config.cjs'
        $startArgs = $pm2 + @('start', $ecosystem)
        Invoke-Logged @startArgs
        if ($LASTEXITCODE -eq 0) { Invoke-Logged node (Join-Path $RootDir 'scripts/verify-server-health.js') }
        if ($LASTEXITCODE -eq 0) {
            $saveArgs = $pm2 + @('save')
            Invoke-Logged @saveArgs
            Step "restart" "warning" "Update failed, but PortOS was restarted"
            Write-SafeHost "✅ PortOS is answering /api/system/health again after the failed update." -ForegroundColor Green
        } else {
            Step "restart" "error" "Update failed and PortOS is DOWN"
            Write-SafeHost "❌ PortOS is not answering /api/system/health." -ForegroundColor Red
            # Name the pm2 that actually exists — the checkout's copy may be the
            # thing a failed install just deleted, so printing it would be a dead end.
            Write-SafeHost "    Recover with: $($pm2 -join ' ') start $ecosystem" -ForegroundColor Red
        }
    } catch {
        # A throwing recovery must not replace the real update failure, and must
        # not re-enter the trap below.
        Write-SafeHost "❌ PortOS restart attempt failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# Every fatal exit in this script goes through here, so the recovery cannot be
# forgotten at one of the call sites. Before the delete it is a no-op.
function Stop-UpdateScript {
    param([int]$Code = 1)
    Restore-Pm2Apps
    # Recovery must never turn a failed update into a reported success.
    if ($Code -eq 0) { $Code = 1 }
    exit $Code
}

# Backstop for a terminating error nobody converted into a Stop-UpdateScript
# call; `break` rethrows so the script still exits non-zero.
trap {
    Restore-Pm2Apps
    break
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
# from scratch. node_modules ONLY — every workspace lockfile this script touches
# (root, client, server, autofixer) is tracked, so the pull just brought one that
# is already consistent with the new package.json. Keep it: reinstalling from the
# committed lock is reproducible, while deleting it would let transitive versions
# float past the `overrides` pins.
function Clear-WorkspaceDeps {
    param([string]$Dir)
    if (Test-Path "$Dir/node_modules") {
        Remove-Item -Recurse -Force "$Dir/node_modules" -ErrorAction SilentlyContinue
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
    # This is an installation/reconciliation path, not dependency authoring.
    # --no-save still honors package-lock.json but prevents older npm versions
    # from rewriting newer lockfile metadata (for example `libc` fields).
    Invoke-Logged npm install --no-save
    if ($LASTEXITCODE -eq 0) { Pop-Location; return }

    Write-SafeHost "⚠️  npm install failed for $Label — cleaning node_modules and retrying..." -ForegroundColor Yellow
    Pop-Location
    Clear-WorkspaceDeps -Dir $Dir
    Push-Location $Dir
    Invoke-Logged npm install --no-save
    if ($LASTEXITCODE -eq 0) { Pop-Location; return }

    Pop-Location
    Write-SafeHost "❌ npm install failed for $Label after retry" -ForegroundColor Red
    Stop-UpdateScript 1
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
    if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
}
# Record main's pre-pull HEAD — captured AFTER any checkout so it's the commit
# the installed node_modules was built from (main, which the rest of this script
# installs/builds), not a feature branch we just left. Diffing this against
# post-pull HEAD yields exactly the pull's delta on main, so a manifest change
# the update brings is detected even when launched from another branch.
$prePullSha = git rev-parse HEAD 2>$null
Invoke-Logged git pull --rebase --autostash
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
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

# Refresh local submodule metadata from the just-pulled .gitmodules before
# checking out the commits pinned by PortOS. Without sync, a URL/path change in
# .gitmodules can leave an older instance trying to initialize from stale local
# git config. Deliberately omit --remote: the parent commit is the release
# contract, not whichever submodule commit happens to be newest upstream.
Step "submodules" "running" "Synchronizing and updating submodules..."
Invoke-Logged git submodule sync --recursive
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
Invoke-Logged git submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
Step "submodules" "done" "Submodules updated"
Write-SafeHost ""

# Remove ONLY PortOS's apps from the shared PM2 daemon — never `pm2 kill`, which
# tears down the daemon and stops EVERY other project's apps on this machine.
# The daemon itself is left alone here; whether it also needs an in-place reload
# is decided in the restart step below, against the freshly installed pm2.
Step "pm2-stop" "running" "Stopping PortOS apps..."
# Arm the latch BEFORE the delete (see update.sh) so an interruption during the
# delete itself still reaches the recovery.
$script:Pm2AppsDown = $true
Invoke-Logged node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent
$global:LASTEXITCODE = 0
Step "pm2-stop" "done" "Apps stopped"
Write-SafeHost ""

# Update dependencies with retry logic
Step "npm-install" "running" "Installing all dependencies..."
Safe-Install -Dir "." -Label "root"
Safe-Install -Dir "client" -Label "client"
Safe-Install -Dir "server" -Label "server"
Safe-Install -Dir "autofixer" -Label "autofixer"

# Run trusted install scripts skipped by ignore-scripts=true in each workspace's
# .npmrc. The allowlist lives in scripts/trusted-rebuilds.js — a single home
# shared with `npm run setup`, scripts/ensure-deps.js, setup.ps1, update.sh and CI,
# so a package can never be granted an install-time execution slot in one path but
# not another.
# Only the server needs rebuilds; client/autofixer have no install-script deps
# (vite 8 dropped the esbuild binary dependency that used to be the reason).
Write-SafeHost "🔧 Rebuilding trusted native dependencies..." -ForegroundColor Yellow
Invoke-Logged node scripts/trusted-rebuilds.js server
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
Write-SafeHost ""

# Verify critical dependencies exist
if (-not (Test-Path "client/node_modules/vite/bin/vite.js")) {
    Write-SafeHost "❌ Critical dependency missing: client/node_modules/vite" -ForegroundColor Red
    Write-SafeHost "   Try running: npm run install:all"
    Stop-UpdateScript 1
}
Step "npm-install" "done" "Dependencies installed"

# Run data/db/browser setup. Don't call `npm run setup` — that re-runs the
# installs we just did above. These scripts are the data-side half of
# `npm run setup` and are idempotent.
Step "setup" "running" "Running setup..."
Invoke-Logged node scripts/setup-data.js
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
Invoke-Logged node scripts/setup-db.js
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
Invoke-Logged node scripts/setup-browser.js
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
Invoke-Logged node scripts/setup-ghostty.js
Step "setup" "done" "Setup complete"
Write-SafeHost ""

# Retry the safe Tailscale certificate path on every update. Missing sign-in,
# MagicDNS, or the admin HTTPS toggle is reported as guidance rather than a
# failed update; setup-guide owns the shared human-readable next step.
Step "network-setup" "running" "Checking Tailscale, MagicDNS, and HTTPS..."
Invoke-Logged node scripts/setup-cert.js
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
$networkSummary = & {
    $ErrorActionPreference = 'Continue'
    & node scripts/setup-guide.js --summary 2>> $UpdateLog
}
if ($LASTEXITCODE -ne 0 -or -not $networkSummary) {
    $networkSummary = "Network setup checked"
    $global:LASTEXITCODE = 0
}
Step "network-setup" "done" ($networkSummary -join " ")
Write-SafeHost ""

# Run data migrations
Step "migrations" "running" "Running data migrations..."
$migrationsScript = Join-Path $RootDir "scripts\run-migrations.js"
if (Test-Path $migrationsScript) {
    Invoke-Logged node $migrationsScript
    if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
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
if ($LASTEXITCODE -ne 0) { Stop-UpdateScript $LASTEXITCODE }
Step "build" "done" "Client built"
Write-SafeHost ""

# Write completion marker atomically before restart so server reads it on boot
$Tag = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Tag) {
    Write-SafeHost "❌ Failed to determine package version from package.json" -ForegroundColor Red
    Stop-UpdateScript 1
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
# `pm2 update` reloads the daemon in place, refreshing its cached
# ProcessContainerFork.js path (a stale path from a daemon originally launched by
# another project — e.g. a Yarn PnP zip cache — makes future fork() calls crash
# with MODULE_NOT_FOUND). It also RESTARTS every co-located app on the shared
# daemon, so run it only when the daemon isn't already the one this checkout's
# node_modules would launch. The probe runs here, after npm install, so a pm2
# version bump in the pulled update is part of the comparison.
Invoke-Logged node scripts/pm2-daemon-refresh.js
if ($LASTEXITCODE -eq 0) {
    Invoke-Logged node ./node_modules/pm2/bin/pm2 update
}
$global:LASTEXITCODE = 0
Invoke-Logged node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent
$global:LASTEXITCODE = 0
Invoke-Logged node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs
if ($LASTEXITCODE -ne 0) {
    if (Test-Path "$RootDir\data\update-complete.json") {
        Remove-Item -Force "$RootDir\data\update-complete.json"
    }
    Stop-UpdateScript $LASTEXITCODE
}
$script:Pm2AppsDown = $false
Invoke-Logged node ./node_modules/pm2/bin/pm2 save
$global:LASTEXITCODE = 0
Step "restart" "done" "PortOS started"
Write-SafeHost ""

# Defense in depth (#5976): `pm2 start` exiting 0 is not proof the server came
# back — a half-failed delete/start bracket leaves the install headless, and
# this script is the only PortOS process still running to notice. Poll
# /api/system/health, and on failure spend one more `pm2 start` before saying
# so loudly. Mirrors update.sh.
$verifyFailed = 0
Step "verify" "running" "Verifying PortOS came back..."
Invoke-Logged node scripts/verify-server-health.js
if ($LASTEXITCODE -eq 0) {
    Step "verify" "done" "PortOS is answering /api/system/health"
} else {
    Write-SafeHost "PortOS did not answer /api/system/health after the restart - re-running pm2 start" -ForegroundColor Yellow
    Invoke-Logged node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs
    $global:LASTEXITCODE = 0
    Invoke-Logged node scripts/verify-server-health.js
    if ($LASTEXITCODE -eq 0) {
        Step "verify" "done" "PortOS recovered after a second pm2 start"
        Write-SafeHost "PortOS recovered after a second pm2 start" -ForegroundColor Green
    } else {
        $verifyFailed = 1
        Step "verify" "warning" "PortOS is not answering /api/system/health"
        Write-SafeHost "PortOS is STILL not answering /api/system/health." -ForegroundColor Red
        Write-SafeHost "    Recover with: node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs" -ForegroundColor Red
    }
}
$global:LASTEXITCODE = 0
Write-SafeHost ""

# Open the dashboard in the PortOS-managed browser. Fail-soft — explicitly
# reset $LASTEXITCODE to 0 after the call so a non-zero exit from the auto-
# open script doesn't propagate as the script's own exit code (the update
# is already complete by this point).
Invoke-Logged node scripts/open-ui-in-browser.js
$global:LASTEXITCODE = 0

if ($verifyFailed -eq 0) {
    Write-SafeHost "===================================" -ForegroundColor Green
    Write-SafeHost "  ✅ Update Complete!" -ForegroundColor Green
    Write-SafeHost "===================================" -ForegroundColor Green
} else {
    # The source update finished, but the install is down. Say so where the
    # banner would have been — a wrapper reading only the tail of the log, or
    # this script's exit status, must not read a headless install as a clean run.
    Write-SafeHost "===================================" -ForegroundColor Red
    Write-SafeHost "  ⚠️  Update applied, but PortOS is DOWN" -ForegroundColor Red
    Write-SafeHost "===================================" -ForegroundColor Red
}
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

$setupGuide = & {
    $ErrorActionPreference = 'Continue'
    & node scripts/setup-guide.js --assume-active 2>$null
}
$global:LASTEXITCODE = 0
if ($setupGuide) {
    $setupGuide | ForEach-Object { Write-SafeHost $_ -ForegroundColor Cyan }
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

# Exit non-zero when the install did not come back. This script outlives the
# server it restarts, so its status is the only signal a caller still has.
exit $verifyFailed
