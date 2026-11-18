const fs = require('fs');
const path = require('path');

// Oddiy .env faylini tashqi kutubxonalarsiz o'qish
function loadEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

module.exports = {
  // Minecraft Server
  MC_HOST: process.env.MC_HOST || 'allaysmp.pro',
  MC_PORT: parseInt(process.env.MC_PORT || '25565', 10),
  MC_VERSION: process.env.MC_VERSION || '1.21.1',
  MC_SUBSERVER: process.env.MC_SUBSERVER || 'economy',
  MC_USERNAME: process.env.MC_USERNAME || 'Gotto',
  MC_PASSWORD: process.env.MC_PASSWORD || 'bunyod',
  BOT_ACCOUNTS: [
    {
      username: process.env.MC_USERNAME || 'Gotto',
      password: process.env.MC_PASSWORD || 'bunyod'
    }
  ],
  AUTO_AFK_ON_BOOT: (process.env.AUTO_AFK_ON_BOOT || 'true').toLowerCase() === 'true',

  // 4 ta Ovoz Berish (Vote) Sozlamalari
  VOTE_1_URL: process.env.VOTE_1_URL || 'https://minecraft-mp.com/server/350645/vote/',
  VOTE_2_URL: process.env.VOTE_2_URL || '',
  VOTE_3_URL: process.env.VOTE_3_URL || '',
  VOTE_4_URL: process.env.VOTE_4_URL || '',
  COOLDOWN_HOURS: parseFloat(process.env.COOLDOWN_HOURS || '15.0'),

  // Render & Veb Server
  PORT: parseInt(process.env.PORT || process.env.HEALTH_PORT || '8080', 10),
  HOST: process.env.HEALTH_HOST || '0.0.0.0',
  SERVER_PUBLIC_URL: (process.env.RENDER_EXTERNAL_URL || process.env.SERVER_PUBLIC_URL || 'https://minecraft-afk-bot-y7ak.onrender.com').replace(/\/$/, ''),
  ENABLE_KEEP_ALIVE: (process.env.ENABLE_KEEP_ALIVE || 'true').toLowerCase() === 'true',
  KEEP_ALIVE_INTERVAL: parseInt(process.env.KEEP_ALIVE_INTERVAL || '180', 10)
};
