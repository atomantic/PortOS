# Browser Management

Manage the persistent CDP/Playwright browser instance used by PortOS for web automation, authenticated scraping, and CoS agent tasks.

## Architecture

The browser runs as a separate PM2 process (`portos-browser`) that launches a Chromium instance with Chrome DevTools Protocol (CDP) enabled. The PortOS server communicates with it via HTTP health checks and the CDP debug endpoint.

```
PortOS Server (5554)
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

## Security

Browser management relies on PortOS's network-level access control (see [Security Model](../API.md#security-model)). The `cdpHost` config is restricted to localhost values (`127.0.0.1`, `localhost`, `::1`) to prevent SSRF via CDP endpoint redirection. Do not expose the PortOS server to untrusted networks.

## Configuration

Stored in `data/browser-config.json`:

```json
{
  "cdpPort": 5556,
  "cdpHost": "127.0.0.1",
  "healthPort": 5557,
  "autoConnect": true,
  "headless": true,
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

const browser = await chromium.connectOverCDP('ws://127.0.0.1:5556');
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto('https://example.com');
```
