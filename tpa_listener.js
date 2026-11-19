const https = require('https');
let lastSeen = Date.now() - 5000;

function check() {
  https.get('https://minecraft-afk-bot-y7ak.onrender.com/api/logs', res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        const logs = json.logs || [];
        for (const l of logs) {
          const t = l.timestamp * 1000;
          if (t > lastSeen) {
            lastSeen = t;
            if (l.message.includes('sent you a tpa request') && l.message.toLowerCase().includes('fingoxen')) {
              console.log('[TRIGGER] TPA request detected! Sending /tpaccept Fingoxenpro...');
              const data = JSON.stringify({ text: '/tpaccept Fingoxenpro', bot: 'Gotto' });
              const req = https.request('https://minecraft-afk-bot-y7ak.onrender.com/api/bot/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
              });
              req.write(data);
              req.end();
            }
          }
        }
      } catch (_) {}
    });
  }).on('error', () => {});
}

setInterval(check, 1000);
console.log('TPA Auto-Accept Listener active.');
