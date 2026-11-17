module.exports = {
  apps: [
    {
      name: "mc-afk-bot",
      script: "bot.js",
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
