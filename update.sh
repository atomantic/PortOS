#!/bin/bash
set -euo pipefail

# Ignore SIGPIPE: when PM2 restarts the server mid-update (watch detects
# git changes), the parent Node process dies and our stdout pipe breaks.
trap '' PIPE

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
mkdir -p "$ROOT_DIR/data"

# Safe echo — swallows EPIPE so broken stdout doesn't trip set -e
log() {
  echo "$@" 2>/dev/null || true
}

# Step output helper (parsed by updateExecutor for UI progress)
step() {
  local name="$1" status="$2" message="$3"
  log "STEP:$name:$status:$message"
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
  if (cd "$dir" && npm install 2>&1); then
    return 0
  fi

  log "⚠️  npm install failed for $label — cleaning node_modules and retrying..."
  rm -rf "$dir/node_modules"
  if (cd "$dir" && npm install 2>&1); then
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
  git checkout main
fi
git pull --rebase --autostash
step "git-pull" "done" "Latest changes pulled"
log ""

# Stop PM2 apps to release file locks before updating
step "pm2-stop" "running" "Stopping PortOS apps..."
npm run pm2:stop 2>/dev/null || true
step "pm2-stop" "done" "Apps stopped"
log ""

# Update dependencies with retry logic
step "npm-install" "running" "Installing all dependencies..."
safe_install .
safe_install client
safe_install server
log ""

# Verify critical dependencies exist
if [ ! -f "client/node_modules/vite/bin/vite.js" ]; then
  log "❌ Critical dependency missing: client/node_modules/vite"
  log "   Try running: npm run install:all"
  exit 1
fi
step "npm-install" "done" "Dependencies installed"

# Run setup (data dirs + browser deps)
log "Ensuring data & browser setup..."
npm run setup
log ""

# Ghostty sync (if installed)
node scripts/setup-ghostty.js
log ""

# Run data migrations
step "migrations" "running" "Running data migrations..."
if [ -f "$ROOT_DIR/scripts/run-migrations.js" ]; then
  node "$ROOT_DIR/scripts/run-migrations.js"
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
      if ! npm install -g slash-do@latest; then
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
npm run build
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
if ! npm run pm2:restart; then
  rm -f "$ROOT_DIR/data/update-complete.json"
  exit 1
fi
step "restart" "done" "PortOS restarted"
log ""

log "==================================="
log "  ✅ Update Complete!"
log "==================================="
log ""
