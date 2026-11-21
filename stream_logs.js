const https = require('https');

process.stdout.write('\x1b]0;[Gotto] Minecraft AFK Bot — Jonli Loglar\x07');
console.log('====================================================');
console.log('🟢 [Gotto] Minecraft AFK Bot — Jonli Jonli Loglar');
console.log('Server: https://minecraft-afk-bot-y7ak.onrender.com');
console.log('====================================================\n');

let lastTimestamp = 0;
let isFirstRun = true;

function fetchLogs() {
  https.get('https://minecraft-afk-bot-y7ak.onrender.com/api/logs', (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(raw);
        const logs = json.logs || [];
        const bot = (json.data && json.data.bot) || {};

        if (isFirstRun) {
          console.log(`[STATUS] Bot: ${bot.username || 'Gotto'} | Server: ${bot.server || 'economy'} | Holat: ${bot.status || 'N/A'} | AFK: ${bot.is_afk ? 'HA' : 'YOQ'} | HP: ${bot.health || 20}/20 | Food: ${bot.food || 20}/20`);
          console.log(`[UPTIME] ${bot.uptime_text || 'N/A'}\n----------------------------------------------------`);
          
          // Oxirgi 25 ta logni chiqarish
          const startIdx = Math.max(0, logs.length - 25);
          for (let i = startIdx; i < logs.length; i++) {
            console.log(`[${logs[i].time}] ${logs[i].message}`);
          }
          if (logs.length > 0) {
            lastTimestamp = logs[logs.length - 1].timestamp;
          }
          isFirstRun = false;
        } else {
          for (const l of logs) {
            if (l.timestamp > lastTimestamp) {
              console.log(`[${l.time}] ${l.message}`);
              lastTimestamp = l.timestamp;
            }
          }
        }
      } catch (e) {
        // Parse error ignored
      }
    });
  }).on('error', (err) => {
    console.error(`[Xatolik] Bog'lanishda uzilish: ${err.message}`);
  });
}

// Boshlash va har 1.5 soniyada yangilash
fetchLogs();
setInterval(fetchLogs, 1500);
