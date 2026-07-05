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
