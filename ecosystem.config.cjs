module.exports = {
  apps: [
    {
      name: 'xiaoji-discord-bot',
      script: 'src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      min_uptime: '10s',
      max_restarts: 10,
      kill_timeout: 10000,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: 'logs/xiaoji-out.log',
      error_file: 'logs/xiaoji-error.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
