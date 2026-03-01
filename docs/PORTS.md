# Port Allocation Guide

PortOS uses a contiguous port allocation scheme to make it easy to understand which ports are in use and which are available.

## Port Allocation Standard

### Convention

1. **Contiguous Ranges**: Each app should use a contiguous block of ports
2. **Labeled Ports**: Use the `ports` object in `ecosystem.config.cjs` to define all ports with descriptive labels
3. **No Gaps**: Avoid leaving gaps between port allocations within an app

### Port Labels

Common port labels:
- `api` - REST API server
- `ui` - Web UI / frontend
- `cdp` - Chrome DevTools Protocol
- `health` - Health check endpoint
- `ws` - WebSocket server

## PortOS Port Allocations

| Port | Process | Label | Description |
|------|---------|-------|-------------|
| 5554 | portos-client | ui | Vite dev server (React UI) |
| 5555 | portos-server | api | Main API server |
| 5556 | portos-browser | cdp | Chrome DevTools Protocol |
| 5557 | portos-browser | health | Browser health check API |
| 5558 | portos-cos | api | CoS Agent Runner (isolated process) |
| 5559 | portos-autofixer | api | Autofixer daemon API |
| 5560 | portos-autofixer-ui | ui | Autofixer web UI |

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

1. **Check Available Ports**: Use PortOS apps list to see which ports are in use
2. **Pick a Contiguous Range**: Choose a starting port and allocate contiguously
3. **Define PORTS Object**: Always define ports in a top-level `PORTS` constant
4. **Avoid Common Ports**: Stay away from well-known ports (80, 443, 3000, 8080, etc.)

## Recommended Port Ranges

| Range | Purpose |
|-------|---------|
| 5554-5560 | PortOS core services |
| 5561-5569 | Reserved for PortOS extensions |
| 5570-5599 | User applications |

## Viewing Port Usage

The PortOS apps list shows all ports for each process:
- Single port: `process-name:5555`
- Multiple ports: `process-name (cdp:5556,health:5557)`

Use the API to get detailed port information:
```bash
curl http://localhost:5555/api/apps | jq '.[].processes'
```
