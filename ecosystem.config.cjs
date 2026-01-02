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
    }
  ]
};
