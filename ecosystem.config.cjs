module.exports = {
  apps: [
    {
      name: 'portos-server',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      // PortOS convention: define all ports used by this process
      ports: { api: 5554 },
      env: {
        NODE_ENV: 'development',
        PORT: 5554,
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
      ports: { api: 5558 },
      env: {
        NODE_ENV: 'development',
        PORT: 5558,
        HOST: '0.0.0.0'
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
      name: 'portos-client',
      script: 'node_modules/.bin/vite',
      cwd: `${__dirname}/client`,
      args: '--host 0.0.0.0 --port 5555',
      ports: { ui: 5555 },
      env: {
        NODE_ENV: 'development'
      },
      watch: false
    },
    {
      name: 'portos-autofixer',
      script: 'autofixer/server.js',
      cwd: __dirname,
      interpreter: 'node',
      ports: { api: 5559 },
      env: {
        NODE_ENV: 'development',
        PORT: 5559
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
      ports: { ui: 5560 },
      env: {
        NODE_ENV: 'development',
        PORT: 5560
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
      ports: { cdp: 5556, health: 5557 },
      env: {
        NODE_ENV: 'development',
        CDP_PORT: 5556,
        PORT: 5557
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    }
  ]
};
