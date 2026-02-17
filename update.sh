#!/bin/bash
set -e

echo "==================================="
echo "  PortOS Update"
echo "==================================="
echo ""

# Pull latest
echo "Pulling latest changes..."
git pull --rebase --autostash
echo ""

# Update dependencies
echo "Updating dependencies..."
npm install
cd client && npm install && cd ..
cd server && npm install && cd ..
echo ""

# Run setup (data dirs + browser deps)
echo "Ensuring data & browser setup..."
npm run setup
echo ""

# Ghostty sync (if installed)
node scripts/setup-ghostty.js
echo ""

echo "==================================="
echo "  Update Complete!"
echo "==================================="
echo ""
echo "Restart PortOS:"
echo "  Development:  npm run dev"
echo "  Production:   npm run pm2:restart"
echo ""
