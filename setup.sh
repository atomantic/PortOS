#!/bin/bash
set -e

echo "==================================="
echo "  PortOS Setup"
echo "==================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Node.js is required but not installed."
    echo "Install it from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Node.js 18+ required (found v$NODE_VERSION)"
    exit 1
fi

echo "Installing dependencies..."
npm install
cd client && npm install && cd ..
cd server && npm install && cd ..

echo ""
echo "Setting up data directory..."
npm run setup

echo ""

# Optional Ghostty setup
read -p "Set up Ghostty terminal themes? (y/N): " setup_ghostty
if [[ $setup_ghostty =~ ^[Yy]$ ]]; then
    node scripts/setup-ghostty.js
fi

echo ""
echo "==================================="
echo "  Setup Complete!"
echo "==================================="
echo ""
echo "Start PortOS:"
echo "  Development:  npm run dev"
echo "  Production:   npm run pm2:start"
echo "  Stop:         npm run pm2:stop"
echo "  Logs:         npm run pm2:logs"
echo ""
echo "Access at: http://localhost:5555"
echo ""
