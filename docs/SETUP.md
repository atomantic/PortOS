# PortOS Setup Guide

PortOS can automate local installation, certificate provisioning, and launch URLs, but two account-level decisions stay with you: joining a Tailscale tailnet and choosing which AI provider may run work. The CLI and **Settings → Setup** show the same ordered readiness checks so a missing prerequisite is visible instead of becoming a broken URL later.

## First install

```bash
git clone --recurse-submodules https://github.com/atomantic/PortOS.git
cd PortOS
./setup.sh                 # macOS / Linux guided installer
# or: .\setup.ps1         # Windows PowerShell
```

`npm run setup` is the non-wrapper equivalent. All three paths install dependencies, provision PostgreSQL, prepare runtime data and the managed browser, ask about a local LLM when an interactive terminal is available, safely attempt Tailscale certificate provisioning, and print the remaining setup walkthrough.

The network sequence is:

1. Install [Tailscale](https://tailscale.com/download) on the PortOS host.
2. Open Tailscale and sign the host into your tailnet.
3. Enable MagicDNS and **HTTPS Certificates** in the [Tailscale DNS admin](https://login.tailscale.com/admin/dns).
4. Let PortOS run `tailscale cert` with `npm run setup:cert`.
5. Restart PortOS and open the exact URL printed by setup: `https://<machine>.<tailnet>.ts.net:5555`.

The installer performs step 4 automatically whenever the preceding account settings are ready. If an account setting is missing, it exits successfully with the exact next action; it never waits for a hidden prompt and never substitutes an untrusted self-signed certificate unless you explicitly pass `--self-signed`.

## URLs and ports

- `:5555` is always the user-facing PortOS port. It serves HTTP before a certificate exists and HTTPS after the trusted certificate is active.
- `http://localhost:5553` is a host-only HTTP mirror when HTTPS is active. It exists for local scripts and does not work from another device.
- `:5554` is only the Vite development UI.

Run `npm run setup:guide` at any time to print the current walkthrough and correct URL. Add `-- --summary` for one line or `-- --json` for automation. PortOS's managed browser also opens the trusted MagicDNS URL when one is provisioned rather than defaulting to localhost.

## Choose an AI provider

Initial setup is complete once at least one enabled provider is actually runnable. Choose one path under **AI → Providers**:

- **Subscription CLI:** install and authenticate a supported CLI such as Claude Code, Codex, or Antigravity. This is the recommended cost model for sustained autonomous work.
- **API provider:** add a key for the paid provider you intend to use. PortOS never enables a paid provider automatically.
- **Local/private:** install Ollama or LM Studio and download a compatible model under **Models → LLMs**.

The Setup page checks binaries, credentials, local runtimes, and models without making an LLM request. PortOS never performs cold-bootstrap model calls.

## Setup guidance in the app

After PortOS starts:

- The global setup banner names the next missing essential and links to **Settings → Setup**. “Later” hides only the current state for the browser session.
- **Settings → Setup** keeps the complete network walkthrough and AI-provider choice above optional capability health.
- The Dashboard's **Network Exposure** widget shows the next network action.
- **Dev Tools → Instances** exposes the same full network guide alongside peer MagicDNS suggestions.

Certificate provisioning and the PortOS restart are one-click actions in the UI once MagicDNS and the Tailscale admin certificate toggle are ready.

## Updates and recovery

`update.sh`, `update.ps1`, and the in-app updater retry the safe certificate provisioning step on every update, report the current network prerequisite in update progress, and print the full walkthrough afterward. An update does not fail merely because Tailscale is absent or an account toggle still needs you.

Useful checks:

```bash
npm run setup:guide       # ordered network + provider walkthrough
npm run setup:cert        # retry trusted Tailscale certificate provisioning
npm run doctor            # read-only report of all install prerequisites
npm run pm2:restart       # activate a newly provisioned certificate
```

For HTTPS without Tailscale, `npm run setup:cert -- --self-signed` remains an explicit fallback. Browsers will warn because that certificate is not publicly trusted, and a stable MagicDNS URL is still preferable for remote use.
