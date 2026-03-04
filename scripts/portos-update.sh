#!/usr/bin/env bash
set -euo pipefail

# PortOS Auto-Update Script
# Usage: bash scripts/portos-update.sh <tag>
# Outputs structured STEP markers for progress tracking:
#   STEP:name:status:message

TAG="${1:?Usage: portos-update.sh <tag>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$ROOT_DIR/data/update.log"

cd "$ROOT_DIR"

# Log helper
log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
  echo "$*" || true
}

# Step output helper
step() {
  local name="$1" status="$2" message="$3"
  log "STEP:$name:$status:$message"
}

log "=== PortOS update to $TAG started ==="

# Step 1: Git fetch
step "git-fetch" "running" "Fetching tags from origin..."
git fetch origin --tags >> "$LOG_FILE" 2>&1
step "git-fetch" "done" "Tags fetched"

# Step 2: Git checkout
step "git-checkout" "running" "Checking out $TAG..."
git checkout "$TAG" >> "$LOG_FILE" 2>&1
step "git-checkout" "done" "Checked out $TAG"

# Step 3: npm install
step "npm-install" "running" "Installing dependencies..."
npm install >> "$LOG_FILE" 2>&1
step "npm-install" "done" "Dependencies installed"

# Step 4: Setup (data dirs, db, browser)
step "setup" "running" "Running setup..."
npm run setup >> "$LOG_FILE" 2>&1
step "setup" "done" "Setup complete"

# Step 5: Migrations
step "migrations" "running" "Running data migrations..."
if [ -f "$ROOT_DIR/scripts/run-migrations.js" ]; then
  node "$ROOT_DIR/scripts/run-migrations.js" >> "$LOG_FILE" 2>&1
fi
step "migrations" "done" "Migrations complete"

# Step 6: Build client
step "build" "running" "Building client..."
npm run build -w client >> "$LOG_FILE" 2>&1
step "build" "done" "Client built"

# Step 7: Restart via PM2
step "restart" "running" "Restarting PortOS..."

log "=== PortOS update to $TAG restarting ==="

# Use the local pm2 binary to restart
node "$ROOT_DIR/node_modules/pm2/bin/pm2" restart ecosystem.config.cjs >> "$LOG_FILE" 2>&1

# Write completion marker after successful restart (server reads this on boot)
echo "{\"version\":\"${TAG#v}\",\"completedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$ROOT_DIR/data/update-complete.json"

step "restart" "done" "PortOS restarted"
