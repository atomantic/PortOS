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

# `npm run setup` is the all-in-one: submodules + root/client/server/autofixer
# deps + esbuild postinstall + node-pty rebuild + data dir, db, and browser
# setup. install:all is kept as a backward-compat alias.
echo "Installing dependencies and running setup..."
if ! npm run setup; then
    echo ""
    echo "==================================="
    echo "  Setup incomplete"
    echo "==================================="
    echo ""
    echo "Fix the issue above, then re-run: ./setup.sh"
    echo ""
    exit 1
fi

echo ""

# Optional Ghostty setup. Skip on non-TTY (CI, piped stdin) so `read` doesn't
# abort the script under `set -e`, and `||` the read itself so a Ctrl-D in an
# interactive shell defaults to "skip" instead of aborting.
if [ -t 0 ]; then
    setup_ghostty=""
    read -p "Set up Ghostty terminal themes? (y/N): " setup_ghostty || true
    if [[ $setup_ghostty =~ ^[Yy]$ ]]; then
        node scripts/setup-ghostty.js
    fi
fi

echo ""

# Optional: start PortOS now. Accept y/yes/Y/YES (and Enter) to start, n/no
# to skip, and reprompt on anything else so a stray "asdf" doesn't silently
# launch pm2. On non-TTY (CI, piped stdin) default to "no" so the script
# completes unattended without auto-launching pm2. A Ctrl-D inside the loop
# is treated as "no" so the script can still finish cleanly.
start_now=0
if [ -t 0 ]; then
    while true; do
        answer=""
        if ! read -p "Start PortOS now via pm2? (Y/n): " answer; then
            start_now=0
            break
        fi
        case "$answer" in
            ""|[Yy]|[Yy][Ee][Ss])
                start_now=1
                break
                ;;
            [Nn]|[Nn][Oo])
                start_now=0
                break
                ;;
            *)
                echo "Please answer yes or no (y/n)."
                ;;
        esac
    done
fi

if [ "$start_now" = "1" ]; then
    echo ""
    echo "Starting PortOS..."
    npm start
    # Open the dashboard in the PortOS-managed browser. Fail-soft.
    node scripts/open-ui-in-browser.js || true
    echo ""
    echo "==================================="
    echo "  PortOS is running"
    echo "==================================="
    echo ""
    echo "Access at: http://localhost:5555"
    echo "Logs:      npm run pm2:logs"
    echo "Stop:      npm run pm2:stop"
    echo ""
else
    echo "==================================="
    echo "  Setup Complete!"
    echo "==================================="
    echo ""
    echo "Start PortOS:"
    echo "  Development:  npm run dev"
    echo "  Production:   npm start (or npm run pm2:start)"
    echo "  Stop:         npm run pm2:stop"
    echo "  Logs:         npm run pm2:logs"
    echo ""
    echo "Access at: http://localhost:5555"
    echo ""
fi
