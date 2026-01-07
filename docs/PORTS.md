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
| 5554 | portos-server | api | Main API server |
| 5555 | portos-client | ui | Vite dev server (React UI) |
| 5556 | portos-browser | cdp | Chrome DevTools Protocol |
| 5557 | portos-browser | health | Browser health check API |
| 5558 | (reserved) | - | Reserved for future PortOS use |
| 5559 | portos-autofixer | api | Autofixer daemon API |
| 5560 | portos-autofixer-ui | ui | Autofixer web UI |

## Defining Ports in ecosystem.config.cjs

Use the `ports` object to define all ports used by a process:

```javascript
{
  name: 'my-app',
  script: 'server.js',
  // PortOS convention: define all ports used by this process
  ports: {
    api: 5570,      // REST API
    health: 5571    // Health check endpoint
  },
  env: {
    PORT: 5570,
    HEALTH_PORT: 5571
  }
}
```

### Multiple Ports Example

For processes that expose multiple ports (like the browser with CDP and health):

```javascript
{
  name: 'portos-browser',
  script: '.browser/server.js',
  ports: { cdp: 5556, health: 5557 },
  env: {
    CDP_PORT: 5556,
    PORT: 5557
  }
}
```

## Guidelines for New Apps

1. **Check Available Ports**: Use PortOS apps list to see which ports are in use
2. **Pick a Contiguous Range**: Choose a starting port and allocate contiguously
3. **Document in ports object**: Always define the `ports` object in ecosystem.config
4. **Avoid Common Ports**: Stay away from well-known ports (80, 443, 3000, 8080, etc.)

## Recommended Port Ranges

| Range | Purpose |
|-------|---------|
| 5554-5560 | PortOS core services |
| 5561-5569 | Reserved for PortOS extensions |
| 5570-5599 | User applications |

## Viewing Port Usage

The PortOS apps list shows all ports for each process:
- Single port: `process-name:5554`
- Multiple ports: `process-name (cdp:5556,health:5557)`

Use the API to get detailed port information:
```bash
curl http://localhost:5554/api/apps | jq '.[].processes'
```
