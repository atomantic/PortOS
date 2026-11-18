#!/bin/bash
set -e

# Anchor to the script's own directory so relative paths (e.g. the
# `node -e import('./server/lib/tailscale.js')` detection below) work
# regardless of where the user invokes ./setup.sh from.
cd "$(dirname "$0")"

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

# Keep the pre-install check on the same owner as npm run setup/start/dev.
# Running the Node script here handles excluded release lines (23/25) as well
# as patch floors, without a second semver implementation in shell.
if ! node scripts/checkNodeVersion.js --security; then
    exit 1
fi

# scripts/setup.js is the one install pipeline shared with `npm run setup` and
# setup.ps1: version checks, submodules, root/client/server/autofixer deps + the
# trusted native rebuilds, data dir, db, llm, browser, cert, then ffmpeg,
# slash-do and the setup walkthrough. install:all is kept as a backward-compat
# alias of `npm run setup`. PORTOS_DEFER_SETUP_GUIDE=1 holds the walkthrough
# back so it prints after the start prompt below instead of before it.
echo "Installing dependencies and running setup..."
if ! PORTOS_DEFER_SETUP_GUIDE=1 node scripts/setup.js; then
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

# macOS Tailscale.app CLI is sandboxed (`tailscale cert` can't write outside its
# container → EPERM). Detection delegates to server/lib/tailscale.js so the
# candidate path list stays a single source of truth.
# --input-type=module is required: `node -e` defaults to CommonJS even when
# the package.json declares "type":"module", so a top-level import() in the
# command would be a syntax error and the detection would silently always
# fail (suppressed by `2>/dev/null`). Without this flag the whole
# auto-install branch never runs on macOS.
if node --input-type=module -e "import('./server/lib/tailscale.js').then(m => process.exit(m.hasOnlySandboxedTailscale() ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
    echo "Detected Tailscale.app without the unsandboxed CLI."
    echo "Installing tailscale via Homebrew so 'tailscale cert' can write to data/certs/..."
    brewInstalled=0
    if command -v brew &> /dev/null; then
        if brew install tailscale; then
            brewInstalled=1
        else
            echo "⚠️  brew install tailscale failed — HTTPS via Tailscale won't work until you install it manually."
        fi
    else
        echo "⚠️  Homebrew not found. Install brew (https://brew.sh) then run: brew install tailscale"
        echo "    Without it, the 'Enable HTTPS' button on the Instances page will fail with EPERM."
    fi
    # Re-run cert setup now that the unsandboxed CLI is available. scripts/setup.js
    # already made a safe attempt with only the sandboxed CLI, but it
    # deliberately stayed on HTTP rather than silently creating a self-signed
    # fallback. This second attempt can now write the trusted cert files.
    if [ "$brewInstalled" = "1" ]; then
        echo "Re-running cert provisioning with the freshly-installed Tailscale CLI..."
        npm run setup:cert || echo "⚠️  setup:cert failed — re-run manually if needed."
    fi
    echo ""
fi

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

# Print the URL the user should open. Delegates to scripts/print-access-url.js
# so we share the same cert detection (file presence AND PEM parseability) the
# server uses — otherwise we'd advertise HTTPS URLs the server isn't serving.
print_access_url() {
    node scripts/print-access-url.js
}

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
    print_access_url
    echo ""
    node scripts/setup-guide.js --assume-active
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
    echo "  Production:   npm start"
    echo "  Stop:         npm run pm2:stop"
    echo "  Logs:         npm run pm2:logs"
    echo ""
    print_access_url
    echo ""
    node scripts/setup-guide.js
    echo ""
fi
