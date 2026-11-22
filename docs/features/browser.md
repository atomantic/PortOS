# Browser Management

Manage the persistent CDP/Playwright browser instance used by PortOS for web automation, authenticated scraping, and CoS agent tasks.

## Architecture

The browser runs as a separate PM2 process (`portos-browser`) that launches a Chromium instance with Chrome DevTools Protocol (CDP) enabled. The PortOS server communicates with it via HTTP health checks and the CDP debug endpoint.

```
PortOS Server (5555)
  ├── /api/browser routes → browserService.js
  │     ├── Health check → portos-browser health endpoint (5557)
  │     ├── CDP pages → CDP debug endpoint (5556)
  │     └── PM2 commands → pm2 start/stop/restart portos-browser
  └── Browser Page UI → /browser
        └── Polls /api/browser for real-time status

portos-browser (PM2 process)
  ├── Chromium with --remote-debugging-port=5556
  └── Health server on port 5557
```

## Ports

| Port | Purpose |
|------|---------|
| 5556 | Chrome DevTools Protocol (CDP) |
| 5557 | Browser health check endpoint |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/browser` | Full combined status |
| GET | `/api/browser/config` | Get browser configuration |
| PUT | `/api/browser/config` | Update browser configuration |
| POST | `/api/browser/launch` | Start browser via PM2 |
| POST | `/api/browser/stop` | Stop browser via PM2 |
| POST | `/api/browser/restart` | Restart browser via PM2 |
| GET | `/api/browser/health` | Quick health check |
| GET | `/api/browser/process` | PM2 process details |
| GET | `/api/browser/pages` | List open CDP pages |
| GET | `/api/browser/version` | CDP version info |
| GET | `/api/browser/logs` | Recent PM2 logs |
| GET | `/api/browser/vault/logins` | Website-login fill candidates (metadata only; `?origin=` for one exact origin) |
| POST | `/api/browser/vault/fill` | Model-blind credential fill into one tab (`{ targetId, loginId, fields?, selectors? }`) |

## Security

Browser management relies on PortOS's network-level access control (see [Security Model](../API.md#security-model)). The `cdpHost` config is restricted to localhost values (`127.0.0.1`, `localhost`, `::1`) to prevent SSRF via CDP endpoint redirection. Do not expose the PortOS server to untrusted networks.

## Model-blind website-login fill

`POST /api/browser/vault/fill` (and the `browser.vault.fill` agent tool) types a saved [Privacy Vault website login](./privacy-center.md#website-logins) into one managed-browser tab without the caller ever seeing it. `fields` defaults to `identifier` and `password`; request `totp` on the 2FA step for the current code. The response is metadata only, for example `{ ok, origin, filledFields, identifierFilled, totpFilled, submitted: false }`, and the form is never submitted.

The fill fails closed:

- The browser-reported top-frame origin must exactly equal one of the login's origins, both before anything is decrypted and after a short settle window, and the document must be the same one throughout.
- Page scripts run in a CDP isolated world, so a page can't spoof its origin by patching DOM prototypes. Each value write re-checks the live origin in the same task.
- Fields are found only in the verified top document, including open shadow roots. A form in an iframe isn't found, so it can't be filled.
- A main-frame load or navigation, a reverted value, or a missing field refuses the fill (`ORIGIN_MISMATCH`, `NAVIGATED_DURING_FILL`, `VALUE_NOT_RETAINED`, `FIELD_NOT_FOUND`).

The identifier is typed with `Input.insertText`, which framework-controlled forms accept. The password and code are set through the native value setter plus `input`/`change` events, never sent as page-wide keystrokes. The password and generated code are registered with the ephemeral secret scrubber (`server/lib/secretText.js`), so PortOS tool results, prompt scrubbing and DOM reads redact them later.

A script attached directly to the CDP port can still read the DOM; that is host-level access outside PortOS. The fill is gated like every host-control write, and agents additionally need the default-off **website login fill** grant (see [Agent Tools](./agent-context.md#semantic-action-grants)).

## Configuration

Stored in `data/browser-config.json`:

```json
{
  "cdpPort": 5556,
  "cdpHost": "127.0.0.1",
  "healthPort": 5557,
  "autoConnect": true,
  "headless": false,
  "userDataDir": ""
}
```

## Usage

1. Navigate to `/browser` in the PortOS UI
2. Click **Launch Browser** to start the CDP browser process
3. The status dashboard shows real-time connection state, open pages, and process metrics
4. Use the **Config** panel to adjust CDP ports, headless mode, etc.
5. Connect external Playwright scripts to the CDP endpoint shown on the page

## Connecting External Scripts

```javascript
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:5556');
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto('https://example.com');
```
