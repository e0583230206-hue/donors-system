// error_file/out_file below point at ../logs (frontend/logs) — that
// directory is gitignored and was never created anywhere, so a fresh
// `git pull` deploy had nowhere for pm2 to write until something else
// happened to create it. pm2 loads this file as plain Node, so ensure the
// directory exists before pm2 needs it.
const fs   = require("fs");
const path = require("path");
const LOGS_DIR = path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

module.exports = {
  apps: [
    {
      name: "crm-ivr-server",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      // Default env is production — prevents accidental startup with dev JWT_SECRET.
      // For local development: pm2 start ecosystem.config.js --env development
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: "development",
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      error_file: "../logs/error.log",
      out_file: "../logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
};
