# PM2 Configuration Pattern

This document describes the recommended PM2 configuration pattern for PortOS sub-projects.

## Overview

PM2 is a process manager for Node.js applications. We use `ecosystem.config.cjs` files to define process configurations declaratively.

## File Format

Use CommonJS format (`.cjs`) for ecosystem files to ensure compatibility across all environments:

```javascript
module.exports = {
  apps: [
    // Process definitions go here
  ]
};
```

## Basic Process Definition

```javascript
module.exports = {
  apps: [
    {
      name: 'my-app',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      ports: { api: 5570 },
      env: {
        NODE_ENV: 'development',
        PORT: 5570,
        HOST: '0.0.0.0'
      },
      watch: false,
      max_memory_restart: '500M'
    }
  ]
};
```

## Configuration Fields

### Required Fields

| Field | Description |
|-------|-------------|
| `name` | Unique process name (used by PM2 for identification) |
| `script` | Path to the entry script |
| `cwd` | Working directory (use `__dirname` for relative paths) |

### Recommended Fields

| Field | Description | Default |
|-------|-------------|---------|
| `interpreter` | Node interpreter path | `'node'` |
| `ports` | Port allocation object (PortOS convention) | - |
| `env` | Environment variables | `{}` |
| `watch` | Enable file watching | `false` |
| `max_memory_restart` | Restart if memory exceeds threshold | - |

### Resilience Fields

For services that should auto-recover from failures:

```javascript
{
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s',
  restart_delay: 5000
}
```

| Field | Description |
|-------|-------------|
| `autorestart` | Restart on crash |
| `max_restarts` | Maximum consecutive restarts before giving up |
| `min_uptime` | Minimum uptime before considering "stable" |
| `restart_delay` | Delay (ms) between restart attempts |

## Port Allocation Convention

Define all ports in a `ports` object for documentation and PortOS integration:

```javascript
{
  name: 'my-app',
  // PortOS convention: define all ports used by this process
  ports: { api: 5570, health: 5571 },
  env: {
    PORT: 5570,
    HEALTH_PORT: 5571
  }
}
```

### Common Port Labels

- `api` - REST API server
- `ui` - Web UI / frontend
- `cdp` - Chrome DevTools Protocol
- `health` - Health check endpoint
- `ws` - WebSocket server

See `PORTS.md` for the full port allocation guide.

## Common Patterns

### Server Process

```javascript
{
  name: 'myapp-server',
  script: 'server/index.js',
  cwd: __dirname,
  interpreter: 'node',
  ports: { api: 5570 },
  env: {
    NODE_ENV: 'development',
    PORT: 5570,
    HOST: '0.0.0.0'
  },
  watch: false,
  max_memory_restart: '500M'
}
```

### Vite Dev Server (React/Vue UI)

```javascript
{
  name: 'myapp-client',
  script: 'node_modules/.bin/vite',
  cwd: `${__dirname}/client`,
  args: '--host 0.0.0.0 --port 5571',
  ports: { ui: 5571 },
  env: {
    NODE_ENV: 'development'
  },
  watch: false
}
```

### Background Daemon

```javascript
{
  name: 'myapp-worker',
  script: 'worker/index.js',
  cwd: __dirname,
  interpreter: 'node',
  ports: {},  // No ports if internal-only
  env: {
    NODE_ENV: 'development'
  },
  watch: false,
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s',
  restart_delay: 5000
}
```

### Multi-Port Service

```javascript
{
  name: 'myapp-browser',
  script: '.browser/server.js',
  cwd: __dirname,
  interpreter: 'node',
  ports: { cdp: 5572, health: 5573 },
  env: {
    NODE_ENV: 'development',
    CDP_PORT: 5572,
    PORT: 5573
  },
  watch: false,
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s',
  restart_delay: 5000
}
```

## PM2 Commands

### Starting/Stopping

```bash
# Start all processes defined in ecosystem file
pm2 start ecosystem.config.cjs

# Restart all processes
pm2 restart ecosystem.config.cjs

# Stop all processes
pm2 stop ecosystem.config.cjs
```

### Monitoring

```bash
# View process list
pm2 list

# View logs
pm2 logs

# View logs for specific process
pm2 logs myapp-server
```

### Important Rules

1. **Never use `pm2 kill` or `pm2 delete all`** - This affects all PM2 processes on the system, not just yours

2. **Always use ecosystem file** for restart/stop operations:
   ```bash
   pm2 restart ecosystem.config.cjs  # Correct
   pm2 restart all                   # Dangerous - affects all apps
   ```

3. **Use `pm2 save`** after changes to persist the process list:
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   ```

## Complete Example

Here's a complete ecosystem file for a typical monorepo:

```javascript
module.exports = {
  apps: [
    {
      name: 'myapp-server',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      ports: { api: 5570 },
      env: {
        NODE_ENV: 'development',
        PORT: 5570,
        HOST: '0.0.0.0'
      },
      watch: false,
      max_memory_restart: '500M'
    },
    {
      name: 'myapp-client',
      script: 'node_modules/.bin/vite',
      cwd: `${__dirname}/client`,
      args: '--host 0.0.0.0 --port 5571',
      ports: { ui: 5571 },
      env: {
        NODE_ENV: 'development'
      },
      watch: false
    },
    {
      name: 'myapp-worker',
      script: 'worker/index.js',
      cwd: __dirname,
      interpreter: 'node',
      ports: {},
      env: {
        NODE_ENV: 'development'
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    }
  ]
};
```

## Environment-Specific Configuration

For different environments (dev/prod), use environment blocks:

```javascript
{
  name: 'myapp-server',
  script: 'server/index.js',
  env: {
    NODE_ENV: 'development',
    PORT: 5570
  },
  env_production: {
    NODE_ENV: 'production',
    PORT: 5570
  }
}
```

Start with specific environment:
```bash
pm2 start ecosystem.config.cjs --env production
```

## Integration with PortOS

When your app follows these patterns, PortOS can:
- Display port allocations in the apps list
- Track process health and memory usage
- Provide one-click restart/stop controls
- Show consolidated logs

Register your ecosystem file with PortOS to enable management features.
