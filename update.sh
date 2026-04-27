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

# Pull latest — ensure we're on a branch first (old updater may have left
# the repo in detached HEAD after checking out a tag)
step "git-pull" "running" "Pulling latest changes..."
if ! git symbolic-ref -q HEAD >/dev/null 2>&1; then
  log "⚠️  Detached HEAD detected — checking out main branch"
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

# Stop PM2 apps to release file locks before updating
step "pm2-stop" "running" "Stopping PortOS apps..."
run npm run pm2:stop || true
step "pm2-stop" "done" "Apps stopped"
log ""

# Update dependencies with retry logic
step "npm-install" "running" "Installing all dependencies..."
safe_install .
safe_install client
safe_install server
safe_install autofixer

# Run trusted install scripts skipped by ignore-scripts=true in .npmrc
log "🔧 Rebuilding esbuild & node-pty..."
run node client/node_modules/esbuild/install.js
run node server/node_modules/esbuild/install.js
run npm rebuild node-pty --prefix server
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

# Check for slash-do (optional, used by the PR Reviewer schedule task)
if ! command -v slash-do >/dev/null 2>&1; then
  log "slash-do is not installed. It is used by the PR Reviewer schedule task."
  if [ -t 0 ]; then
    read -p "Install slash-do now? [y/N] " -n 1 -r
    log ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      log "Installing slash-do..."
      if ! run npm install -g slash-do@latest; then
        log "⚠️  Failed to install slash-do. Continuing without it."
      fi
    else
      log "Skipping slash-do install. You can install later with: npm install -g slash-do@latest"
    fi
  else
    log "Skipping slash-do prompt (non-interactive). Install later with: npm install -g slash-do@latest"
  fi
  log ""
fi

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

# Restart PM2 apps — remove marker if restart fails so it isn't misread on boot
step "restart" "running" "Restarting PortOS..."
if ! run npm run pm2:restart; then
  rm -f "$ROOT_DIR/data/update-complete.json"
  exit 1
fi
step "restart" "done" "PortOS restarted"
log ""

# Open the dashboard in the PortOS-managed browser. Fail-soft — never blocks
# the update return.
run node scripts/open-ui-in-browser.js || true

log "==================================="
log "  ✅ Update Complete!"
log "==================================="
log ""
