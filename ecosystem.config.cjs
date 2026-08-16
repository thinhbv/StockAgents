module.exports = {
  apps: [
    {
      name: 'data-service',
      script: 'packages/data-service/src/index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      error_file: 'logs/data-service-error.log',
      out_file: 'logs/data-service-out.log',
      time: true,
    },
    {
      name: 'telegram-bot',
      script: 'packages/api/src/telegram_bot.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      error_file: 'logs/telegram-bot-error.log',
      out_file: 'logs/telegram-bot-out.log',
      time: true,
    },
  ],
};
