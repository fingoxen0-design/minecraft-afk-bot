module.exports = {
  apps: [
    {
      name: "mc-vote-afk-bot",
      script: "bot.py",
      interpreter: "python",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
