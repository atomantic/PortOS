// =============================================================================
// PM2 Ecosystem Configuration - shared constants and app definitions
// =============================================================================
const path = require('path');
const LOG_DATE_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSS[Z]';
const IS_WIN = process.platform === 'win32';

// Shared env inherited by all apps (merged into each app's env)
const BASE_ENV = {
  NODE_ENV: 'development',
  TZ: 'UTC',  // All log timestamps and Date operations in UTC
  // Pin the install root explicitly so data-root resolution never derives it
  // from the executing file's location. A server/agent booted from inside a CoS
  // git worktree (data/cos/worktrees/agent-*) would otherwise resolve `data/`
  // to the worktree's nonexistent tree and crash boot migrations (#1947).
  PORTOS_DATA_ROOT: __dirname
};

// Read a couple of machine-local settings from .env (pm2 doesn't auto-load it
// here): PGMODE → PostgreSQL port; PORTOS_SERVER_MAX_MEMORY → the restart ceiling
// below. An explicit process.env wins over the .env file so a one-off shell
// override still works.
const fs = require('fs');
const envFile = path.join(__dirname, '.env');
let pgMode = 'docker';
let envMaxMemory = null;
try {
  const envContent = fs.readFileSync(envFile, 'utf8');
  const modeMatch = envContent.match(/^PGMODE=(\w+)/m);
  if (modeMatch) pgMode = modeMatch[1];
  const memMatch = envContent.match(/^PORTOS_SERVER_MAX_MEMORY=(\S+)/m);
  if (memMatch) envMaxMemory = memMatch[1];
} catch { /* no .env file — default to docker */ }

// pm2 restarts portos-server when its RSS crosses this — originally a memory-leak
// safety valve. The committed default stays modest so the guard still fires on a
// small install (a fork on an 8 GB box), but it's overridable per-machine via
// PORTOS_SERVER_MAX_MEMORY (.env or shell env; e.g. '32G' on a 128 GB
// workstation) since a too-low ceiling causes spurious restarts that disrupt SSE
// streams and long jobs. (Training is no longer collateral damage from these
// restarts — it's spawned detached into its own process group — but fewer
// restarts is still better.)
const SERVER_MAX_MEMORY = process.env.PORTOS_SERVER_MAX_MEMORY || envMaxMemory || '4G';

const PORTS = {
  API: 5555,           // Express API server (HTTPS when Tailscale cert is active)
  API_LOCAL: 5553,     // Loopback-only HTTP mirror of API — only binds when HTTPS is active on :API.
                       // Lets http://localhost work without cert warnings. Override w/ PORTOS_HTTP_PORT.
  UI: 5554,            // Vite dev server (client)
  CDP: 5556,           // Chrome DevTools Protocol (browser automation)
  CDP_HEALTH: 5557,    // Browser health check endpoint
  COS: 5558,           // Chief of Staff agent runner
  AUTOFIXER: 5559,     // Autofixer API
  AUTOFIXER_UI: 5560,  // Autofixer UI
  POSTGRES_DOCKER: 5561, // PostgreSQL Docker container (host port mapping)
  POSTGRES: pgMode === 'native' ? 5432 : 5561 // Active PostgreSQL port (unused in file mode)
};

module.exports = {
  PORTS, // Export for other configs to reference

  apps: [
    {
      name: 'portos-server',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        PORT: PORTS.API,
        PORTOS_HTTP_PORT: PORTS.API_LOCAL, // Loopback HTTP mirror when HTTPS is active
        HOST: '0.0.0.0',
        PGPORT: PORTS.POSTGRES,
        PGPASSWORD: process.env.PGPASSWORD || 'portos',
        ...(pgMode === 'file' ? { MEMORY_BACKEND: 'file' } : {}),
        PATH: process.env.PATH // Inherit PATH for git/node access in child processes
      },
      // Filewatch is OFF for portos-server. The image gen path (codex / local
      // MLX / external) writes lots of files: the rendered PNG, a sidecar
      // metadata JSON, atomic-renamed media-jobs.json, plus per-job temp
      // scratch. Even with `watch: ['server']` + a broad ignore_watch list,
      // chokidar occasionally races on the atomic rename target (write to
      // tmp → rename onto final path) and fires a change event for a path
      // that the ignore globs *should* have excluded. The symptom in the
      // wild is "SIGINT received" 5–30s after an image render completes,
      // killing in-flight jobs.
      //
      // Code edits are picked up by a manual `pm2 restart ecosystem.config.cjs`
      // — that's the documented workflow anyway (pm2 restart doesn't rebuild
      // the client; you need npm run build / npm start). So losing the
      // auto-restart-on-save behavior costs nothing in practice.
      //
      // To re-enable for ad-hoc dev work: flip this to `watch: ['server']`
      // and add `'**/data/**'` (plus `'**/node_modules'`, `'**/logs/**'`,
      // `'**/.cache/**'`, `'**/portos-stepwise-*/**'`) to `ignore_watch`.
      watch: false,
      max_memory_restart: SERVER_MAX_MEMORY
      // NOTE: do NOT set `treekill: false` here to protect long media jobs from
      // restart-SIGINT. Tried 2026-06-14: pm2 then fails to reap the old node
      // process on restart, so it lingers holding :5555 and the new instance
      // EADDRINUSE-crash-loops. The right place to isolate a multi-hour trainer
      // from pm2's parent-tree kill is the spawn side (double-fork / reparent to
      // launchd so it leaves the ppid tree), NOT disabling treekill server-wide.
      // Raising max_memory_restart (above) already removes the most common
      // restart trigger; full isolation is tracked in PLAN.
    },
    {
      name: 'portos-cos',
      script: 'server/cos-runner/index.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      // CoS Agent Runner - isolated process for spawning Claude CLI agents
      // Does NOT restart when portos-server restarts, preventing orphaned agents
      // Security: Binds to localhost only - not exposed externally
      env: {
        ...BASE_ENV,
        PORT: PORTS.COS,
        HOST: '127.0.0.1'
      },
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
      restart_delay: 10000,
      max_memory_restart: '2G',
      // Important: This process manages long-running agent processes
      // Keep kill_timeout high to allow graceful shutdown of agents
      kill_timeout: 30000
    },
    {
      name: 'portos-ui',
      script: path.join(__dirname, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
      cwd: path.join(__dirname, 'client'),
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      args: `--host 0.0.0.0 --port ${PORTS.UI}`,
      env: {
        ...BASE_ENV,
        VITE_PORT: PORTS.UI
      },
      watch: false
    },
    {
      name: 'portos-autofixer',
      script: 'autofixer/server.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        PORT: PORTS.AUTOFIXER,
        PATH: process.env.PATH // Inherit PATH for nvm/node access in child processes
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    },
    {
      name: 'portos-autofixer-ui',
      script: 'autofixer/ui.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        PORT: PORTS.AUTOFIXER_UI
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    },
    {
      name: 'portos-browser',
      script: 'browser/server.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      // Security: CDP binds to 127.0.0.1 by default (set CDP_HOST=0.0.0.0 to expose)
      // Remote access should go through portos-server proxy with authentication
      env: {
        ...BASE_ENV,
        CDP_PORT: PORTS.CDP,
        CDP_HOST: '127.0.0.1',
        PORT: PORTS.CDP_HEALTH
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    }
  ]
};
