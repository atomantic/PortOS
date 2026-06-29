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
# from scratch. node_modules is always removed; the lockfile is removed ONLY
# when it's gitignored (the per-install client/server locks) — a tracked root
# or autofixer lock was just pulled and is already consistent with the new
# package.json, so keep it for reproducible resolution.
clean_workspace_deps() {
  local dir="$1"
  rm -rf "$dir/node_modules"
  if git check-ignore -q "$dir/package-lock.json" 2>/dev/null; then
    rm -f "$dir/package-lock.json"
  fi
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
  if (cd "$dir" && run npm install); then
    return 0
  fi

  log "⚠️  npm install failed for $label — cleaning node_modules + package-lock.json and retrying..."
  clean_workspace_deps "$dir"
  if (cd "$dir" && run npm install); then
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

# Update submodules (slash-do and any others)
step "submodules" "running" "Updating submodules..."
run git submodule update --init --recursive
step "submodules" "done" "Submodules updated"
log ""

# Remove ONLY PortOS's apps from the shared PM2 daemon — never `pm2 kill`, which
# tears down the daemon and stops EVERY other project's apps on this machine.
# `pm2 update` then reloads the daemon in place from our local node_modules,
# refreshing its cached ProcessContainerFork.js path (a stale path from a daemon
# originally launched by another project — e.g. a Yarn PnP zip cache — makes all
# subsequent fork() calls crash with MODULE_NOT_FOUND) while resurrecting other
# projects' apps instead of killing them.
step "pm2-stop" "running" "Stopping PortOS apps..."
run node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent || true
run node ./node_modules/pm2/bin/pm2 update || true
step "pm2-stop" "done" "Apps stopped"
log ""

# Update dependencies with retry logic
step "npm-install" "running" "Installing all dependencies..."
safe_install .
safe_install client
safe_install server
safe_install autofixer

# Run trusted install scripts skipped by ignore-scripts=true in .npmrc.
# Use `npm rebuild esbuild` rather than a hardcoded node_modules/esbuild/install.js
# path: esbuild is no longer hoisted to the top of either tree (it nests under
# vite/vitest), and the server has no direct esbuild dependency at all since
# vitest 4 → vite 8 dropped it — so the old `node server/node_modules/esbuild/install.js`
# path 404'd and hard-crashed the whole update under `set -e`. `npm rebuild`
# finds esbuild wherever it lives, runs its install script, and no-ops cleanly
# when the package is absent. Server rebuild is fault-tolerant (esbuild is a
# test-only transitive there, not needed for runtime or the production build).
log "🔧 Rebuilding esbuild, node-pty & sharp..."
run npm rebuild esbuild --prefix client
run npm rebuild esbuild --prefix server || true
run npm rebuild node-pty sharp --prefix server
log ""

# Verify critical dependencies exist
if [ ! -f "client/node_modules/vite/bin/vite.js" ]; then
  log "❌ Critical dependency missing: client/node_modules/vite"
  log "   Try running: npm run install:all"
  exit 1
fi
step "npm-install" "done" "Dependencies installed"

# Run data/db/browser setup. Don't call `npm run setup` — that re-runs the
# installs we just did above. The three scripts here are the data-side half
# of `npm run setup` and are idempotent.
step "setup" "running" "Running setup..."
run node scripts/setup-data.js
run node scripts/setup-db.js
run node scripts/setup-browser.js
run node scripts/setup-ghostty.js || true
step "setup" "done" "Setup complete"
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
run node ./node_modules/pm2/bin/pm2 delete ecosystem.config.cjs --silent || true
if ! run node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs; then
  rm -f "$ROOT_DIR/data/update-complete.json"
  exit 1
fi
run node ./node_modules/pm2/bin/pm2 save || true
step "restart" "done" "PortOS started"
log ""

# Open the dashboard in the PortOS-managed browser. Fail-soft — never blocks
# the update return.
run node scripts/open-ui-in-browser.js || true

log "==================================="
log "  ✅ Update Complete!"
log "==================================="
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

if [ -n "$stashed_for_branch" ]; then
  log "ℹ️  Your local changes from '$stashed_for_branch' were stashed for the update."
  if [ "$stashed_for_branch" = "detached HEAD" ]; then
    log "    To restore them: git checkout $stashed_for_commit && git stash pop"
  else
    log "    To restore them: git checkout '$stashed_for_branch' && git stash pop"
  fi
  log "    The stash entry is at the top of 'git stash list'."
fi
