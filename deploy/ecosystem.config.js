'use strict';
/* Пример конфигурации PM2 (Linux/macOS, а также Windows через pm2-windows-service).
   Запуск:  pm2 start deploy/ecosystem.config.js
   Статус:  pm2 status
   Логи:    pm2 logs darkarmy-dossier
   Автозапуск: pm2 save && pm2 startup
*/
module.exports = {
  apps: [
    {
      name: 'darkarmy-dossier',
      cwd: __dirname + '/..',
      script: 'server.js',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '1G',
      kill_timeout: 8000,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './data/pm2-out.log',
      error_file: './data/pm2-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
