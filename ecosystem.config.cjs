// ecosystem.config.cjs — Konfigurasi PM2 untuk Oracle Cloud
// Jalankan dengan: pm2 start ecosystem.config.cjs
// Dokumentasi: https://pm2.keymetrics.io/docs/usage/application-declaration/

module.exports = {
  apps: [
    {
      name: 'wabot',
      script: 'src/index.js',

      // Node.js ESM membutuhkan flag ini
      interpreter_args: '--experimental-vm-modules',

      // Matikan restart otomatis yang agresif.
      // Bot kadang butuh waktu reconnect — jangan langsung restart.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',       // anggap crash kalau mati dalam 30 detik
      restart_delay: 5000,     // tunggu 5 detik sebelum restart

      // Log — PM2 menyimpan otomatis di ~/.pm2/logs/
      error_file: '/opt/wabot/logs/error.log',
      out_file:   '/opt/wabot/logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Variabel lingkungan production
      // Semua nilainya diambil dari /opt/wabot/.env via dotenv di dalam kode.
      // PM2 cukup tahu ini adalah mode production.
      env: {
        NODE_ENV: 'production',
      },

      // Monitoring memory: restart kalau melebihi 600MB
      // (Baileys normal di ~200MB, tapi bisa naik saat sync)
      max_memory_restart: '600M',

      // Jangan pakai cluster mode — Baileys tidak thread-safe
      instances: 1,
      exec_mode: 'fork',
    },
  ],
};
