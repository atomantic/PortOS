#!/bin/bash
set -e

echo "==================================="
echo "  PortOS Update"
echo "==================================="
echo ""

# Resilient npm install — retries once after cleaning node_modules on failure
# Handles ENOTEMPTY and other transient npm bugs
safe_install() {
  local dir="${1:-.}"
  local label="${dir}"
  [ "$dir" = "." ] && label="root"

  echo "📦 Installing deps ($label)..."
  if (cd "$dir" && npm install 2>&1); then
    return 0
  fi

  echo "⚠️  npm install failed for $label — cleaning node_modules and retrying..."
  rm -rf "$dir/node_modules"
  if (cd "$dir" && npm install 2>&1); then
    return 0
  fi

  echo "❌ npm install failed for $label after retry"
  return 1
}

# Pull latest
echo "Pulling latest changes..."
git pull --rebase --autostash
echo ""

# Stop PM2 apps to release file locks before updating
echo "Stopping PortOS apps..."
npm run pm2:stop 2>/dev/null || true
echo ""

# Update dependencies with retry logic
echo "Updating dependencies..."
safe_install .
safe_install client
safe_install server
echo ""

# Verify critical dependencies exist
if [ ! -f "client/node_modules/vite/bin/vite.js" ]; then
  echo "❌ Critical dependency missing: client/node_modules/vite"
  echo "   Try running: npm run install:all"
  exit 1
fi

# Run setup (data dirs + browser deps)
echo "Ensuring data & browser setup..."
npm run setup
echo ""

# Ghostty sync (if installed)
node scripts/setup-ghostty.js
echo ""

# Restart PM2 apps
echo "Restarting PortOS..."
npm run pm2:restart
echo ""

echo "==================================="
echo "  ✅ Update Complete!"
echo "==================================="
echo ""
