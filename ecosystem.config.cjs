// =============================================================================
// PM2 Ecosystem Configuration - shared constants and app definitions
// =============================================================================
const path = require('path');
const LOG_DATE_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSS[Z]';
const IS_WIN = process.platform === 'win32';

// Shared env inherited by all apps (merged into each app's env)
const BASE_ENV = {
  NODE_ENV: 'development',
  TZ: 'UTC'  // All log timestamps and Date operations in UTC
};

const PORTS = {
  API: 5555,           // Express API server
  UI: 5554,            // Vite dev server (client)
  CDP: 5556,           // Chrome DevTools Protocol (browser automation)
  CDP_HEALTH: 5557,    // Browser health check endpoint
  COS: 5558,           // Chief of Staff agent runner
  AUTOFIXER: 5559,     // Autofixer API
  AUTOFIXER_UI: 5560   // Autofixer UI
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
        HOST: '0.0.0.0'
      },
      watch: ['server'],
      ignore_watch: ['node_modules', '**/*.test.js'],
      max_memory_restart: '2G'
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
      script: path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js'),
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
