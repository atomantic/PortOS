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

# Resilient npm install — retries once after cleaning node_modules on failure
# Handles ENOTEMPTY and other transient npm bugs
safe_install() {
  local dir="${1:-.}"
  local label="${dir}"
  [ "$dir" = "." ] && label="root"

  log "📦 Installing deps ($label)..."
  if (cd "$dir" && run npm install); then
    return 0
  fi

  log "⚠️  npm install failed for $label — cleaning node_modules and retrying..."
  rm -rf "$dir/node_modules"
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
run git pull --rebase --autostash
step "git-pull" "done" "Latest changes pulled"
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

# Run trusted install scripts skipped by ignore-scripts=true in .npmrc
log "🔧 Rebuilding esbuild, node-pty & sharp..."
run node client/node_modules/esbuild/install.js
run node server/node_modules/esbuild/install.js
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

if [ -n "$stashed_for_branch" ]; then
  log "ℹ️  Your local changes from '$stashed_for_branch' were stashed for the update."
  if [ "$stashed_for_branch" = "detached HEAD" ]; then
    log "    To restore them: git checkout $stashed_for_commit && git stash pop"
  else
    log "    To restore them: git checkout '$stashed_for_branch' && git stash pop"
  fi
  log "    The stash entry is at the top of 'git stash list'."
fi
