// Конфигурация PM2 для сервера Signage.
//   Запуск:      pm2 start deploy/ecosystem.config.cjs
//   На сервере всё делает deploy/install.sh; управление — команда `signage` (deploy/signage).
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'signage',
      cwd: path.resolve(__dirname, '..'),
      script: 'packages/server/dist/index.js',
      // Только один процесс: SQLite, WebSocket-хабы и планировщик живут в памяти процесса.
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        CONFIG_PATH: process.env.SIGNAGE_CONFIG || '/etc/signage/config.yaml',
      },
      // Перезапуск при падении: с нарастающей паузой, чтобы не крутиться в цикле.
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      min_uptime: '20s',
      // Страховка от утечек памяти.
      max_memory_restart: '1G',
      // Сервер корректно закрывает БД и соединения по SIGINT/SIGTERM.
      kill_timeout: 10000,
      // Логи сервера — JSON (pino); PM2 добавляет время и складывает в ~/.pm2/logs.
      time: true,
      merge_logs: true,
    },
  ],
};
