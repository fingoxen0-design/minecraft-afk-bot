const https = require('https');
let lastSeen = Date.now() - 5000;

function sendChat(text) {
  const data = JSON.stringify({ text, bot: 'Gotto' });
  const req = https.request('https://minecraft-afk-bot-y7ak.onrender.com/api/bot/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  });
  req.on('error', () => {});
  req.write(data);
  req.end();
}

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
            const msg = (l.message || '').toLowerCase();
            const isTpa = msg.includes('tpa') || msg.includes('teleport') || msg.includes('tpaccept');
            const isOwner = msg.includes('fingoxen');
            if (isTpa && isOwner && (msg.includes('sent you') || msg.includes('requested') || msg.includes('click to accept') || msg.includes('type /tpaccept'))) {
              console.log('[TRIGGER] TPA request from Fingoxen detected! Accepting...');
              sendChat('/tpaccept Fingoxenpro');
              setTimeout(() => sendChat('/tpaccept'), 500);
            }
          }
        }
      } catch (_) {}
    });
  }).on('error', () => {});
}

setInterval(check, 1000);
console.log('TPA Auto-Accept Listener active (Checking every 1s)...');
