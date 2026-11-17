const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebServer } = require('../webServer');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function post(url, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

test('WebServer - GET /health and /logs', async () => {
  const ws = new WebServer(55541, '127.0.0.1', () => ({ botStatus: 'afk_active' }), null);
  ws.start();

  await new Promise(r => setTimeout(r, 100));

  try {
    // 1. /health
    const health = await get('http://127.0.0.1:55541/health');
    assert.strictEqual(health.status, 200);
    const healthJson = JSON.parse(health.body);
    assert.strictEqual(healthJson.status, 'healthy');
    assert.strictEqual(healthJson.data.botStatus, 'afk_active');

    // 2. /logs
    const logs = await get('http://127.0.0.1:55541/logs');
    assert.strictEqual(logs.status, 200);
    assert.ok(logs.body.includes('Minecraft 24/7 AFK Bot'));
  } finally {
    ws.stop();
  }
});

test('WebServer - POST actions', async () => {
  const actionHandler = (path, payload) => {
    if (path === '/api/bot/chat') {
      return { success: true, text: payload.text };
    }
    return { success: false };
  };

  const ws = new WebServer(55542, '127.0.0.1', null, actionHandler);
  ws.start();

  await new Promise(r => setTimeout(r, 100));

  try {
    const res = await post('http://127.0.0.1:55542/api/bot/chat', { text: '/server economy' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.text, '/server economy');
  } finally {
    ws.stop();
  }
});
