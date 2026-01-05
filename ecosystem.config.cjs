module.exports = {
  apps: [
    {
      name: 'portos-server',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'development',
        PORT: 5554,
        HOST: '0.0.0.0'
      },
      watch: false,
      max_memory_restart: '500M'
    },
    {
      name: 'portos-client',
      script: 'node_modules/.bin/vite',
      cwd: `${__dirname}/client`,
      args: '--host 0.0.0.0 --port 5555',
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
      env: {
        NODE_ENV: 'development',
        PORT: 5560
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    }
  ]
};
