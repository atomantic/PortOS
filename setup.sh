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
    # Re-run cert setup now that the unsandboxed CLI is available. `npm run
    # setup` already ran setup-cert.js with only the sandboxed CLI, falling
    # back to self-signed; without this re-run the instance stays on the
    # fallback cert until the user manually invokes `npm run setup:cert`.
    if [ "$brewInstalled" = "1" ]; then
        echo "Re-running cert provisioning with the freshly-installed Tailscale CLI..."
        npm run setup:cert || echo "⚠️  setup:cert failed — re-run manually if needed."
    fi
    echo ""
fi

# Install/update slash-do (project-level slash commands for Claude Code et al.)
# via npx. Auto-detects the installed AI environments and lays down the latest
# command set under ~/.claude/commands (or per-environment equivalent). The
# git submodule at lib/slashdo is the in-repo source for inline command loading
# from CoS agents — `npx slash-do@latest` complements that by keeping the
# user-global command pool current. Failures are non-fatal: PortOS still works
# without the global slash commands.
echo "Installing/updating slash-do commands (npx slash-do@latest)..."
# Pipe "a" so slash-do's "multiple environments detected" prompt auto-selects
# all detected envs instead of hanging on readline when stdin is not a TTY.
if ! echo a | npx --yes slash-do@latest; then
    echo "⚠️  slash-do install failed — skipping (you can re-run later: npx slash-do@latest)"
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
    print_access_url
    echo ""
fi
