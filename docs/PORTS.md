# Port Allocation Guide

PortOS uses a contiguous port allocation scheme to make it easy to understand which ports are in use and which are available.

## Port Allocation Standard

### Convention

1. **Contiguous Ranges**: Each app should use a contiguous block of ports
2. **Labeled Ports**: Define all ports in the top-level `PORTS` object in `ecosystem.config.cjs` (mirrored — manually kept in sync — in `server/lib/ports.js`, since the ESM server can't `require()` the CommonJS config); the per-process label map for PM2 processes lives in `server/services/apps.js`. Infrastructure dependencies (such as PostgreSQL on 5561) are provisioned via `scripts/setup-db.js` / Docker Compose rather than registered as PM2 processes in `apps.js`. The mirror carries every port literal, including both PostgreSQL ports; the config's mode-dependent `POSTGRES` (resolved from `PGMODE` at load time) is exposed in the mirror as `resolvePostgresPort(pgMode)` over the `POSTGRES_NATIVE` / `POSTGRES_DOCKER` literals, so `server/lib/ports.js` stays free of filesystem reads. `server/lib/ports.test.js` fails if the two drift apart
3. **No Gaps**: Avoid leaving gaps between port allocations within an app

### Port Labels

Common port labels:
- `api` - REST API server
- `api-local` - Loopback-only HTTP mirror of an API that is served over HTTPS
- `ui` - Web UI / frontend
- `devUi` - Vite dev server for a UI that production serves from its API process
- `cdp` - Chrome DevTools Protocol
- `health` - Health check endpoint
- `ws` - WebSocket server

## PortOS Port Allocations

| Port | Process | Label | Description |
|------|---------|-------|-------------|
| 5553 | portos-server | api-local | Loopback-only HTTP mirror of the API (only listens when HTTPS is active on 5555). Lets `http://localhost:5553` work without cert warnings. Override with `PORTOS_HTTP_PORT`. |
| 5554 | portos-ui | devUi | Vite dev server (React UI) — only present in `npm run dev`; `npm start` serves the built client from :5555 directly. |
| 5555 | portos-server | api | Main API server — **always the user-facing port**. Switches between HTTP and HTTPS based on whether `data/certs/{cert,key}.pem` exists. |
| 5556 | portos-browser | cdp | Chrome DevTools Protocol |
| 5557 | portos-browser | health | Browser health check API |
| 5558 | portos-cos | api | CoS Agent Runner (isolated process) |
| 5559 | portos-autofixer | api | Autofixer daemon API |
| 5560 | portos-autofixer-ui | ui | Autofixer web UI |
| 5561 | portos-db (Docker container) | - | Infrastructure dependency: PostgreSQL Docker container provisioned by `scripts/setup-db.js` / Docker Compose (not a PM2 process in `server/services/apps.js`; native mode uses system pg on 5432). |
| 5562 | portos-whisper | whisper-server | Loopback whisper.cpp speech-to-text server. |
| 5563 | portos-server | eidoverse-host | Optional HTTPS/WebSocket bridge for the embedded Eidoverse Worlds page. Starts on demand and forwards to the managed app on loopback `:8940`. |
| 5568 | portos-llama-server | - | Loopback llama.cpp speculative-decoding server. Optional PM2 process, started/stopped from Models → LLMs. |
| 8000 | portos-mtplx | - | Loopback MTPLX OpenAI-compatible API (upstream's own default, kept so the shipped provider presets match). Optional PM2 process, started/stopped from Models → LLMs. See [features/mtplx.md](./features/mtplx.md). |
| 18020 | vLLM (Docker) | - | Loopback vLLM Qwen3.8-27B / DFlash 2 container on an RTX 3090 host. Operator-started (`docker compose --profile single up -d`) — PortOS never brings it up on boot. See [features/qwen38-rtx3090.md](./features/qwen38-rtx3090.md). |
| 18021 | SGLang (Docker) | - | Loopback SGLang Qwen3.8-27B container on a Hopper/Blackwell host. Operator-started (`docker compose up -d`) — PortOS never brings it up on boot. See [features/sglang-qwen38.md](./features/sglang-qwen38.md). |

## How `:5555`, `:5553`, and `:5554` Relate

These three ports are easy to confuse, so:

```
                          ┌─ :5555 ─ HTTPS app (Tailscale cert)            ← always user-facing
remote browser  ──────────┤
                          └─ :5555 ─ HTTP app (no cert)                    ← always user-facing

local scripts / curl  ────── :5553 ─ HTTP loopback mirror (HTTPS mode only, 127.0.0.1)

vite dev (npm run dev)  ──── :5554 ─ Vite dev server (dev only, separate process)
```

Rules of thumb:
1. **`:5555` is the only port a remote user ever needs.** The scheme (HTTP vs HTTPS) flips based on whether a TLS cert is provisioned (`npm run setup:cert`); the port number does not.
2. **`:5553` is a convenience for local terminals.** When HTTPS is on, `https://localhost:5555` would trip a cert warning (the cert covers `<machine>.<tailnet>.ts.net`, not `localhost`). The loopback HTTP mirror on `:5553` lets curl/scripts skip TLS entirely. It binds to `127.0.0.1` only — never reachable over the network.
3. **`:5554` is `vite dev` only.** In `npm run dev`, Vite serves the React UI from `:5554` and proxies `/api`, `/data` and `/socket.io` to `:5555`. In `npm start` (production), the React build is served from `:5555` itself; `:5554` is unused.
   - **A server-owned path must never be answered by an SPA fallback — and there are two of them.** Neither 404s. In dev, Vite answers an unproxied path with `index.html` and a `200`; in production the fallback in `server/index.js` skips a request only when its path carries a file extension, so an EXTENSIONLESS one falls through the same way. Either shape hands a binary loader HTML, which fails far from the cause (a missing `/data/image-to-3d` proxy entry surfaced as `Unexpected token '<' … is not valid JSON` from the GLB viewer, which took its whole route down), or hands an API client HTML with a success status.
   - **Dev side:** `/data` is proxied as one wildcard prefix, so a new mount is covered the moment it is added.
   - **Production side:** `server/lib/assetRoutePrefixes.js` lists the namespaces the server owns (`SERVER_OWNED_PREFIXES`) alongside the exact client routes inside them (`spaPaths` — `/data` itself is the Data Manager page), and `mountAssetRoutes` closes each one with a terminating 404 (#4688).
   - `scripts/dev-proxy-drift.test.js` fails if the proxy, the mounts, and the client's own routes drift apart. It reads both `NAV_COMMANDS` and `App.jsx`'s nested `<Route>` tree, so a new page under a server-owned prefix — which the terminator would otherwise 404 silently — fails the build even when only its `:id` detail route exists.

## Defining Ports in ecosystem.config.cjs

Define all ports in a top-level `PORTS` object as the single source of truth:

```javascript
// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: 5570,        // REST API server
  UI: 5571,         // Web UI
  CDP: 5572         // Chrome DevTools Protocol
};

module.exports = {
  PORTS, // Export for other configs to reference

  apps: [
    {
      name: 'my-api',
      script: 'server.js',
      env: {
        PORT: PORTS.API
      }
    },
    {
      name: 'my-ui',
      script: 'node_modules/.bin/vite',
      args: `--port ${PORTS.UI}`,
      env: {
        VITE_PORT: PORTS.UI
      }
    }
  ]
};
```

### Benefits

- **Single Source of Truth**: Each port defined once
- **Importable**: Other configs can `require('./ecosystem.config.cjs').PORTS`
- **Clear Comments**: Document what each port is for
- **DRY**: No duplication between `ports` object and `env` vars

### Port Detection

PortOS automatically detects ports from env vars:
- `PORT` → labeled as `api` (or `ui` for `-ui`/`-client` processes, `health` for `-browser` processes with CDP)
- `CDP_PORT` → labeled as `cdp`
- `VITE_PORT` → labeled as `ui`
- `--port` in args → labeled as `ui`

## Guidelines for New Apps

1. **Never bind a managed app inside `5553-5569`** — that whole band belongs to PortOS and its extensions, whether or not a given port currently shows a listener. Managed apps start at `5570`. See the warning below for why a collision here does not announce itself.
2. **Check Available Ports**: Use PortOS apps list to see which ports are in use
3. **Pick a Contiguous Range**: Choose a starting port and allocate contiguously
4. **Define PORTS Object**: Always define ports in a top-level `PORTS` constant
5. **Avoid Common Ports**: Stay away from well-known ports (80, 443, 3000, 8080, etc.)

## Recommended Port Ranges

| Range | Purpose |
|-------|---------|
| 5553-5561 | PortOS core services (includes the `:5553` loopback mirror and the `portos-db` Docker container on `:5561`) |
| 5562-5569 | Reserved for PortOS extensions. Assigned: 5562 whisper, 5563 Eidoverse bridge (on demand), 5568 llama-server. Unassigned but still reserved: 5564-5567, 5569 |
| 5570-5599 | User applications — **put managed apps here** |

> **A collision inside `5553-5569` is silent, not loud.** The natural assumption is
> that a second listener on a taken port fails with `EADDRINUSE`, so an accidental
> overlap would announce itself. It does not. A wildcard bind (`0.0.0.0`) does **not**
> collide with an existing address-specific bind (`127.0.0.1`, a Tailscale address) —
> macOS and the BSDs accept both, and the *specific* bind then wins every connection.
> Two processes each believe they own the port; one of them quietly receives nothing.
>
> This is not hypothetical. A managed app bound `127.0.0.1:5563` and the Tailscale
> address explicitly, while PortOS's Eidoverse bridge bound the wildcard. Both started
> without an error, PortOS logged `🌐 Eidoverse host listening`, and the Eidoverse page
> served the other app's admin UI. Nothing in either process reported a problem.
>
> The on-demand ports (5563, 5568) are the easiest to get wrong, because they are free
> at boot and only bind once a user opens the relevant page — so a port scan taken at
> install time shows them available. Treat the whole band as taken regardless.
>
> `server/services/eidoverseHost.js` now probes `127.0.0.1:<port>` before binding and
> fails with `EIDOVERSE_HOST_PORT_CONFLICT` (409) rather than serving into the void.
> That guard covers the Eidoverse bridge only — it is not a general defence, which is
> why the range rule above still matters.

PostgreSQL in native mode listens on the system default `:5432`, outside these ranges. Two third-party
local runtimes also sit outside them, each on its own upstream default so an unmodified install works
against PortOS without editing anything: MTPLX on `:8000` and the vLLM Qwen3.8-27B container on
`:18020` (`syv-ai/qwen38-27b-rtx3090`'s own compose file). The SGLang Qwen3.8-27B container sits
next to it on `:18021` — that port is PortOS's own choice rather than an upstream default, since
SGLang publishes an image but no compose project (its own default is `:30000`).

## Viewing Port Usage

The PortOS apps list (returned by `GET /api/apps`) shows registered PM2 processes and their mapped ports:
- Single port: `process-name:5555`
- Multiple ports: `process-name (cdp:5556,health:5557)`

Note that `GET /api/apps` only returns PM2 processes defined in `server/services/apps.js` (`portos-server`, `portos-cos`, `portos-ui`, `portos-autofixer`, `portos-autofixer-ui`, `portos-browser`). Infrastructure dependencies like `portos-db` (Docker container on port 5561, managed via `scripts/setup-db.js` / Docker Compose) are not PM2 processes and do not appear in `GET /api/apps`.

Use the API to get detailed port information for registered PM2 processes:
```bash
curl http://localhost:5555/api/apps | jq '.[].processes'
```
