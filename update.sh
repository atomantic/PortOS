#!/bin/bash
set -euo pipefail

# Ignore SIGPIPE: when PM2 restarts the server mid-update (watch detects
# git changes), the parent Node process dies and our stdout pipe breaks.
trap '' PIPE

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
mkdir -p "$ROOT_DIR/data"

# Log file for external command output — keeps noisy git/npm/node output
# off the parent pipe so broken-pipe errors don't abort the update
UPDATE_LOG="$ROOT_DIR/data/update.log"
: > "$UPDATE_LOG"

# Safe echo — swallows EPIPE so broken stdout doesn't trip set -e
log() {
  echo "$@" 2>/dev/null || true
}

# Step output helper (parsed by updateExecutor for UI progress)
step() {
  local name="$1" status="$2" message="$3"
  log "STEP:$name:$status:$message"
}

# Run an external command, routing stdout/stderr to the log file so
# broken-pipe errors from the parent Node process don't abort the update.
# Returns the command's exit code.
run() {
  "$@" >> "$UPDATE_LOG" 2>&1
}

log "==================================="
log "  PortOS Update"
log "==================================="
log ""

# Wipe a workspace's installed deps so the next `npm install` resolves the tree
# from scratch. node_modules ONLY — every workspace lockfile this script touches
# (root, client, server, autofixer) is tracked, so the pull just brought one that
# is already consistent with the new package.json. Keep it: reinstalling from the
# committed lock is reproducible, while deleting it would let transitive versions
# float past the `overrides` pins.
clean_workspace_deps() {
  local dir="$1"
  rm -rf "$dir/node_modules"
}

# Whether the pulled update changed this workspace's package.json. When it did,
# an in-place `npm install` over a node_modules tree resolved for the PREVIOUS
# major versions can leave a duplicated/stale tree (e.g. a stray react@18 copy
# beside react@19) — which builds fine but throws "Invalid hook call" at
# runtime. A from-scratch reinstall is the only reliable fix for a major bump.
# DEPS_CHANGED_FILES / DEPS_CHANGED_UNKNOWN are populated after the pull below.
DEPS_CHANGED_FILES=""
DEPS_CHANGED_UNKNOWN=0
workspace_deps_changed() {
  local dir="$1"
  [ "$DEPS_CHANGED_UNKNOWN" = "1" ] && return 0
  # RECONCILE (issue #1779): a bare `git pull` (no update.sh) leaves stale
  # node_modules even though HEAD already advanced — so the commit diff above is
  # empty (especially if the user also restarted). PortOS passes the workspaces
  # whose installed deps are stale (detected via npm's install receipt) in
  # PORTOS_FORCE_CLEAN_WORKSPACES so they get the from-scratch reinstall here
  # regardless of the diff. Tokens are dir names (".","client","server","autofixer").
  if [ -n "${PORTOS_FORCE_CLEAN_WORKSPACES:-}" ]; then
    case ",${PORTOS_FORCE_CLEAN_WORKSPACES}," in
      *",${dir},"*) return 0 ;;
    esac
  fi
  local rel="package.json"
  [ "$dir" != "." ] && rel="${dir#./}/package.json"
  printf '%s\n' "$DEPS_CHANGED_FILES" | grep -qx "$rel"
}

# Resilient npm install — retries once after cleaning node_modules on failure
# Handles ENOTEMPTY and other transient npm bugs
safe_install() {
  local dir="${1:-.}"
  local label="${dir}"
  [ "$dir" = "." ] && label="root"

  # Force a clean reinstall when this update changed the workspace's deps —
  # never trust an in-place install across a dependency-manifest change.
  if workspace_deps_changed "$dir"; then
    log "🧹 $label package.json changed in this update — clean reinstall (wiping node_modules)"
    clean_workspace_deps "$dir"
  fi

  log "📦 Installing deps ($label)..."
  # This is an installation/reconciliation path, not dependency authoring.
  # --no-save still honors package-lock.json but prevents older npm versions
  # from rewriting newer lockfile metadata (for example `libc` fields).
  if (cd "$dir" && run npm install --no-save); then
    return 0
  fi

  log "⚠️  npm install failed for $label — cleaning node_modules and retrying..."
  clean_workspace_deps "$dir"
  if (cd "$dir" && run npm install --no-save); then
    return 0
  fi

  log "❌ npm install failed for $label after retry"
  return 1
}

# Pull latest — always switch to main (detached HEAD or feature branch both
# need to land on main before pulling, or the version won't advance). The
# rest of the script (install, build, restart) runs on main so the app
# starts on the freshly-pulled revision. Local edits on the original branch
# are stashed first so checkout doesn't abort, and we leave them in the
# stash list afterward — the user can restore with `git stash pop` after
# the update completes (we don't auto-pop because the rest of the script
# needs to keep running with main's contents).
step "git-pull" "running" "Pulling latest changes..."
origin_url=$(git remote get-url origin 2>/dev/null || echo "")
if [ -n "$origin_url" ]; then
  # Redact any embedded credentials (https://user:token@host/...) before logging
  # so PATs don't leak into data/update.log or the update UI step output.
  origin_url_safe=$(printf '%s' "$origin_url" | sed -E 's|://[^@/]+@|://***@|')
  log "🌐 Pulling from origin: $origin_url_safe"
  # Also append directly to $UPDATE_LOG — updateExecutor only forwards STEP:
  # lines, so the `log` above doesn't reach update.log on its own.
  echo "🌐 Pulling from origin: $origin_url_safe" >> "$UPDATE_LOG"
fi
current_branch=$(git symbolic-ref -q --short HEAD 2>/dev/null || echo "")
stashed_for_branch=""
stashed_for_commit=""
if [ "$current_branch" != "main" ]; then
  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    log "⚠️  Stashing local changes from '${current_branch:-detached HEAD}' so checkout can proceed"
    if run git stash push -u -m "portos-update-$(date +%s)"; then
      stashed_for_branch="${current_branch:-detached HEAD}"
      # Capture the original commit SHA so detached-HEAD users can return
      # to the exact tree their stash was taken from.
      stashed_for_commit=$(git rev-parse HEAD)
    fi
  fi
  log "⚠️  On branch '${current_branch:-detached HEAD}' — switching to main for update"
  run git checkout main
fi
# Record main's pre-pull HEAD — captured AFTER any checkout so it's the commit
# the installed node_modules was built from (main, which the rest of this script
# installs/builds), not a feature branch we just left. Diffing this against
# post-pull HEAD yields exactly the pull's delta on main, so a manifest change
# the update brings is detected even when launched from another branch.
pre_pull_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
run git pull --rebase --autostash
step "git-pull" "done" "Latest changes pulled"

# Determine which workspaces' package.json this update touched, so safe_install
# can force a clean reinstall for them (see workspace_deps_changed). If the
# from-revision is unknown/unreachable (fresh clone, unrelated history), treat
# deps as changed everywhere — a clean reinstall is the conservative default.
if [ -n "$pre_pull_sha" ] && git cat-file -e "${pre_pull_sha}^{commit}" 2>/dev/null; then
  DEPS_CHANGED_FILES=$(git diff --name-only "$pre_pull_sha" HEAD 2>/dev/null || echo "")
else
  DEPS_CHANGED_UNKNOWN=1
fi
log ""

# Refresh local submodule metadata from the just-pulled .gitmodules before
# checking out the commits pinned by PortOS. Without sync, a URL/path change in
# .gitmodules can leave an older instance trying to initialize from stale local
# git config. Deliberately omit --remote: the parent commit is the release
# contract, not whichever submodule commit happens to be newest upstream.
step "submodules" "running" "Synchronizing and updating submodules..."
run git submodule sync --recursive
run git submodule update --init --recursive
step "submodules" "done" "Submodules updated"
log ""

# Headless-install guard. From the `pm2-stop` step below until the closing
# `pm2 start` succeeds, PortOS's PM2 entries are DELETED — the install has no
# server. Every step in between (npm install, setup-db, migrations, the client
# build) can fail, and `set -e` would then exit with the apps still deleted and
# nothing left running to notice: the "update deleted portos-server and it never
# came back" failure. #5976 made this script SURVIVE pm2's tree-kill; it did not
# cover the script exiting on its own. So trap the exit and put the apps back.
#
# Starting the pulled tree after a failed install can crash-loop, but a
# crash-looping app the user can see beats a silently headless machine — and the
# recovery only ever runs on a path that was already leaving PortOS down.
PM2_APPS_DOWN=0

# Which pm2 the recovery can actually reach. It CANNOT assume this checkout's
# own copy: `safe_install .` wipes root node_modules whenever the pulled update
# touched root package.json — which every release does, since the version bump
# lives there — and pm2 is a ROOT dependency. So on the most likely failure of
# all (both npm install attempts fail: offline, registry 5xx, ENOSPC) the
# checkout's pm2 is already gone by the time the trap runs, and a hardcoded
# ./node_modules/pm2/bin/pm2 would make the recovery a no-op exactly when it is
# needed most. Prefer the local copy, fall back to a pm2 on PATH, then to npx at
# the version package.json pins. Any pm2 CLI can drive the already-running
# daemon, so a version difference is fine for a recovery.
PM2_CMD=()
resolve_pm2_cmd() {
  if [ -f "$ROOT_DIR/node_modules/pm2/bin/pm2" ]; then
    PM2_CMD=(node "$ROOT_DIR/node_modules/pm2/bin/pm2")
  elif command -v pm2 >/dev/null 2>&1; then
    PM2_CMD=(pm2)
  else
    local pinned
    pinned=$(node -e 'const d=require("./package.json").dependencies||{}; process.stdout.write(typeof d.pm2 === "string" ? d.pm2 : "")' 2>/dev/null || echo "")
    if [ -n "$pinned" ]; then
      PM2_CMD=(npx --yes "pm2@$pinned")
    else
      PM2_CMD=(npx --yes pm2)
    fi
  fi
}

restore_pm2_apps_on_exit() {
  local status=$?
  # Disarm every trap, not just EXIT: a second signal (Ctrl-C twice, an
  # escalating killer) arriving while the recovery's own `pm2 start` and health
  # probe are running would otherwise abort it mid-flight and leave the install
  # headless — exactly the state this function exists to prevent.
  trap - EXIT TERM INT HUP
  if [ "$PM2_APPS_DOWN" = "1" ]; then
    PM2_APPS_DOWN=0
    resolve_pm2_cmd
    log "⚠️  Update is exiting (status $status) with PortOS's apps deleted — restarting them so the install isn't left headless."
    step "restart" "running" "Update failed — restarting PortOS so it isn't left down..."
    # `pm2 start` exiting 0 is not proof the server came back (same reason the
    # verify step below exists) — and this path starts a HALF-INSTALLED tree, so
    # a start that exits 0 and then crash-loops is the likely case here, not the
    # edge case. Never claim a recovery the health probe doesn't confirm.
    if run "${PM2_CMD[@]}" start ecosystem.config.cjs && run node scripts/verify-server-health.js; then
      run "${PM2_CMD[@]}" save || true
      step "restart" "warning" "Update failed, but PortOS was restarted"
      log "✅ PortOS is answering /api/system/health again after the failed update."
    else
      step "restart" "error" "Update failed and PortOS is DOWN"
      log "❌ PortOS is not answering /api/system/health."
      # Name the pm2 that actually exists — the checkout's copy may be the thing
      # a failed install just deleted, so printing it would be a dead-end hint.
      log "    Recover with: ${PM2_CMD[*]} start ecosystem.config.cjs"
    fi
    # Recovery must never turn a failed update into a reported success.
    if [ "$status" -eq 0 ]; then status=1; fi
  fi
  exit "$status"
}
trap restore_pm2_apps_on_exit EXIT
# Turn a fatal signal into an ordinary exit so the EXIT trap above still runs
# (bash does not run an EXIT trap for an untrapped fatal signal).
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

# Remove ONLY PortOS's apps from the shared PM2 daemon — never `pm2 kill`, which
# tears down the daemon and stops EVERY other project's apps on this machine.
# The daemon itself is left alone here; whether it also needs an in-place reload
# is decided in the restart step below, against the freshly installed pm2.
step "pm2-stop" "running" "Stopping PortOS apps..."
# Arm the latch BEFORE the delete, not after: bash runs a pending signal trap
# only between statements, so a TERM arriving while `pm2 delete` is still
# running would otherwise reach the EXIT trap with the latch still 0 and skip
# the recovery — the exact window the signal traps exist for. Recovering apps
# that were never deleted is a harmless no-op restart on an already-failing path.
PM2_APPS_DOWN=1
run node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent || true
step "pm2-stop" "done" "Apps stopped"
log ""

# Update dependencies with retry logic
step "npm-install" "running" "Installing all dependencies..."
safe_install .
safe_install client
safe_install server
safe_install autofixer

# Run trusted install scripts skipped by ignore-scripts=true in each workspace's
# .npmrc. The allowlist lives in scripts/trusted-rebuilds.js — a single home
# shared with `npm run setup`, scripts/ensure-deps.js, setup.ps1, update.ps1 and CI,
# so a package can never be granted an install-time execution slot in one path but
# not another.
# Only the server needs rebuilds; client/autofixer have no install-script deps
# (vite 8 dropped the esbuild binary dependency that used to be the reason).
log "🔧 Rebuilding trusted native dependencies..."
run node scripts/trusted-rebuilds.js server
log ""

# Verify critical dependencies exist
if [ ! -f "client/node_modules/vite/bin/vite.js" ]; then
  log "❌ Critical dependency missing: client/node_modules/vite"
  log "   Try running: npm run install:all"
  exit 1
fi
step "npm-install" "done" "Dependencies installed"

# Run data/db/browser setup. Don't call `npm run setup` — that re-runs the
# installs we just did above. These scripts are the data-side half of
# `npm run setup` and are idempotent.
step "setup" "running" "Running setup..."
run node scripts/setup-data.js
run node scripts/setup-db.js
run node scripts/setup-browser.js
run node scripts/setup-ghostty.js || true
step "setup" "done" "Setup complete"
log ""

# Retry the safe Tailscale certificate path on every update. setup-cert exits 0
# with an actionable explanation when a human-only prerequisite (sign-in,
# MagicDNS, HTTPS Certificates) is missing, so updates never hang or fail on it.
step "network-setup" "running" "Checking Tailscale, MagicDNS, and HTTPS..."
run node scripts/setup-cert.js
network_summary=$(node scripts/setup-guide.js --summary 2>> "$UPDATE_LOG" || true)
step "network-setup" "done" "${network_summary:-Network setup checked}"
log ""

# Ensure ffmpeg is present — it's a runtime dependency for the media/video
# features (camera-device enumeration, video generation, thumbnailing, audio
# mux) that server/lib/ffmpeg.js shells out to, not an npm package. Without it
# those paths fail at runtime with `spawn ffmpeg ENOENT`. update.sh has no TTY,
# so the Linux package-manager branches are gated on passwordless sudo
# (`sudo -n`) — never block the unattended update waiting on a password prompt.
# All branches are fail-soft: the update completes regardless.
step "ffmpeg" "running" "Checking ffmpeg..."
if command -v ffmpeg &> /dev/null; then
  step "ffmpeg" "done" "ffmpeg present"
else
  log "🎞️  ffmpeg not found — required for camera devices, video generation, and thumbnails."
  case "$(uname -s)" in
    Darwin)
      if command -v brew &> /dev/null; then
        log "📦 Installing ffmpeg via Homebrew..."
        run brew install ffmpeg || log "⚠️  brew install ffmpeg failed — install manually: brew install ffmpeg"
      else
        log "⚠️  Homebrew not found. Install brew (https://brew.sh) then run: brew install ffmpeg"
      fi
      ;;
    Linux)
      # Prefix with sudo only when not root; update.sh has no TTY so sudo must
      # be passwordless (sudo -n). A root container needs no sudo at all (and
      # the Docker image has no sudo binary). If we're non-root and can't get
      # passwordless sudo, we can't escalate — print the manual hint.
      SUDO=""
      can_install=1
      if [ "$(id -u)" -ne 0 ]; then
        if sudo -n true 2>/dev/null; then
          SUDO="sudo -n"
        else
          can_install=0
        fi
      fi
      if [ "$can_install" -eq 0 ]; then
        log "⚠️  ffmpeg missing and passwordless sudo unavailable — install manually: sudo apt-get install ffmpeg (or your distro's equivalent)."
      elif command -v apt-get &> /dev/null; then
        log "📦 Installing ffmpeg via apt-get..."
        (run $SUDO apt-get update && run $SUDO apt-get install -y ffmpeg) || log "⚠️  apt-get install ffmpeg failed — install manually: sudo apt-get install ffmpeg"
      elif command -v dnf &> /dev/null; then
        log "📦 Installing ffmpeg via dnf..."
        run $SUDO dnf install -y ffmpeg || log "⚠️  dnf install ffmpeg failed — install manually: sudo dnf install ffmpeg"
      elif command -v pacman &> /dev/null; then
        log "📦 Installing ffmpeg via pacman..."
        run $SUDO pacman -S --noconfirm ffmpeg || log "⚠️  pacman -S ffmpeg failed — install manually: sudo pacman -S ffmpeg"
      else
        log "⚠️  No known package manager (apt-get/dnf/pacman). Install ffmpeg manually so media/video features work."
      fi
      ;;
    *)
      log "⚠️  Unrecognized platform — install ffmpeg manually so media/video features work."
      ;;
  esac
  if command -v ffmpeg &> /dev/null; then
    step "ffmpeg" "done" "ffmpeg installed"
  else
    step "ffmpeg" "done" "ffmpeg unavailable (media/video features degraded)"
  fi
fi
log ""

# Run data migrations
step "migrations" "running" "Running data migrations..."
if [ -f "$ROOT_DIR/scripts/run-migrations.js" ]; then
  run node "$ROOT_DIR/scripts/run-migrations.js"
fi
step "migrations" "done" "Migrations complete"

# Install/update slash-do commands. Replaces the previous interactive prompt
# with an always-on `npx slash-do@latest` call so the user-global command
# pool stays current across updates without user intervention. Failures are
# non-fatal — the PR Reviewer schedule task is the only consumer and it
# fails gracefully if the binary is missing.
# Pipe "a" so slash-do's "multiple environments detected" prompt auto-selects
# all detected envs instead of hanging on readline (update.sh has no TTY).
step "slash-do" "running" "Installing/updating slash-do commands..."
if ! echo a | run npx --yes slash-do@latest; then
  log "⚠️  slash-do install/update failed. Continuing without it (re-run later: npx slash-do@latest)."
fi
step "slash-do" "done" "slash-do commands installed/updated"
log ""

# Build UI assets for production serving
step "build" "running" "Building client..."
run npm run build
step "build" "done" "Client built"
log ""

# Determine post-update version from package.json (fail if unreadable)
TAG=$(node -e 'const pkg = JSON.parse(require("fs").readFileSync("package.json","utf8")); if (typeof pkg.version !== "string") process.exit(1); process.stdout.write(pkg.version.trim());')
if [ -z "$TAG" ]; then
  log "❌ Failed to determine package version from package.json"
  exit 1
fi

# Write completion marker atomically via Node (version passed as env var to avoid injection)
TAG="$TAG" ROOT_DIR="$ROOT_DIR" node -e '
  const fs = require("fs");
  const path = require("path");
  const marker = JSON.stringify({ version: process.env.TAG, completedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(process.env.ROOT_DIR, "data", "update-complete.json.tmp"), marker);
' && mv "$ROOT_DIR/data/update-complete.json.tmp" "$ROOT_DIR/data/update-complete.json"

# Start PM2 apps — use `start` not `restart` (restart against a config doesn't
# reliably start processes that
# aren't currently managed, leaving the app stopped after an update that ran
# while PortOS wasn't running). `delete --silent` first so a partial prior
# state doesn't make `start` a no-op, then `save` so the apps come back on
# reboot. Remove the completion marker if start fails so it isn't misread on boot.
step "restart" "running" "Starting PortOS..."
# `pm2 update` reloads the daemon in place, refreshing its cached
# ProcessContainerFork.js path (a stale path from a daemon originally launched by
# another project — e.g. a Yarn PnP zip cache — makes all subsequent fork() calls
# crash with MODULE_NOT_FOUND). It also RESTARTS every co-located app on the
# shared daemon, so run it only when the daemon isn't already the one this
# checkout's node_modules would launch. The probe runs here, after npm install,
# so a pm2 version bump in the pulled update is part of the comparison.
if run node scripts/pm2-daemon-refresh.js; then
  run node ./node_modules/pm2/bin/pm2 update || true
fi
run node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent || true
if ! run node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs; then
  rm -f "$ROOT_DIR/data/update-complete.json"
  exit 1
fi
PM2_APPS_DOWN=0
run node ./node_modules/pm2/bin/pm2 save || true
step "restart" "done" "PortOS started"
log ""

# Defense in depth (#5976): `pm2 start` exiting 0 is not proof the server came
# back — a half-failed delete/start bracket leaves the install headless, and
# this script is the only PortOS process still running to notice. Poll
# /api/system/health, and on failure spend one more `pm2 start` before saying
# so loudly. A recovery that only fires when the probe fails cannot make a
# healthy update worse.
verify_failed=0
step "verify" "running" "Verifying PortOS came back..."
if run node scripts/verify-server-health.js; then
  step "verify" "done" "PortOS is answering /api/system/health"
else
  log "⚠️  PortOS did not answer /api/system/health after the restart — re-running pm2 start"
  run node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs || true
  if run node scripts/verify-server-health.js; then
    step "verify" "done" "PortOS recovered after a second pm2 start"
    log "✅ PortOS recovered after a second pm2 start"
  else
    verify_failed=1
    step "verify" "warning" "PortOS is not answering /api/system/health"
    log "❌ PortOS is STILL not answering /api/system/health."
    log "    Recover with: node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs"
  fi
fi
log ""

# Open the dashboard in the PortOS-managed browser. Fail-soft — never blocks
# the update return.
run node scripts/open-ui-in-browser.js || true

if [ "$verify_failed" -eq 0 ]; then
  log "==================================="
  log "  ✅ Update Complete!"
  log "==================================="
else
  # The source update finished, but the install is down. Say so where the
  # banner would have been — a wrapper reading only the tail of the log, or
  # this script's exit status, must not read a headless install as a clean run.
  log "==================================="
  log "  ⚠️  Update applied, but PortOS is DOWN"
  log "==================================="
fi
log ""

# Tell the user where to open PortOS — leads with the working local URL
# (http://localhost:5553 mirror in HTTPS mode, :5555 in plain-HTTP mode) so they
# don't land on a dead http://localhost:5555 when a Tailscale cert has forced
# :5555 into TLS-only. Mirrors setup.sh's print_access_url banner; gated on the
# same cert predicate the server uses, so we never advertise a URL it isn't serving.
access_url=$(node scripts/print-access-url.js 2>/dev/null || true)
if [ -n "$access_url" ]; then
  log "$access_url"
  log ""
fi

setup_guide=$(node scripts/setup-guide.js --assume-active 2>/dev/null || true)
if [ -n "$setup_guide" ]; then
  log "$setup_guide"
  log ""
fi

if [ -n "$stashed_for_branch" ]; then
  log "ℹ️  Your local changes from '$stashed_for_branch' were stashed for the update."
  if [ "$stashed_for_branch" = "detached HEAD" ]; then
    log "    To restore them: git checkout $stashed_for_commit && git stash pop"
  else
    log "    To restore them: git checkout '$stashed_for_branch' && git stash pop"
  fi
  log "    The stash entry is at the top of 'git stash list'."
fi

# Exit non-zero when the install did not come back. This script outlives the
# server it restarts, so its status is the only signal a caller still has.
exit "$verify_failed"
