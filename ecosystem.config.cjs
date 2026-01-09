// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: 5554,           // Express API server
  UI: 5555,            // Vite dev server (client)
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
      env: {
        NODE_ENV: 'development',
        PORT: PORTS.API,
        HOST: '0.0.0.0'
      },
      watch: false,
      max_memory_restart: '500M'
    },
    {
      name: 'portos-cos',
      script: 'server/cos-runner/index.js',
      cwd: __dirname,
      interpreter: 'node',
      // CoS Agent Runner - isolated process for spawning Claude CLI agents
      // Does NOT restart when portos-server restarts, preventing orphaned agents
      // Security: Binds to localhost only - not exposed externally
      env: {
        NODE_ENV: 'development',
        PORT: PORTS.COS,
        HOST: '127.0.0.1'
      },
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
      restart_delay: 10000,
      max_memory_restart: '1G',
      // Important: This process manages long-running agent processes
      // Keep kill_timeout high to allow graceful shutdown of agents
      kill_timeout: 30000
    },
    {
      name: 'portos-ui',
      script: 'node_modules/.bin/vite',
      cwd: `${__dirname}/client`,
      args: `--host 0.0.0.0 --port ${PORTS.UI}`,
      env: {
        NODE_ENV: 'development',
        VITE_PORT: PORTS.UI
      },
      watch: false
    },
    {
      name: 'portos-autofixer',
      script: 'autofixer/server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'development',
        PORT: PORTS.AUTOFIXER
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
      env: {
        NODE_ENV: 'development',
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
      // Security: CDP binds to 127.0.0.1 by default (set CDP_HOST=0.0.0.0 to expose)
      // Remote access should go through portos-server proxy with authentication
      env: {
        NODE_ENV: 'development',
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
