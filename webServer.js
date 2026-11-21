const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const url = require('url');
const config = require('./config');

class LogBuffer {
  constructor(maxHours = 2.0, maxEntries = 1500) {
    this.maxSeconds = maxHours * 3600;
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  add(message, level = 'INFO') {
    const now = Date.now() / 1000;
    const date = new Date();
    const timeStr = date.toTimeString().split(' ')[0];
    const cutoff = now - this.maxSeconds;

    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      this.entries.shift();
    }
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }

    this.entries.push({
      timestamp: now,
      time: timeStr,
      level: level,
      message: String(message).trim()
    });
  }

  getLogs(since = 0, limit = 0) {
    const now = Date.now() / 1000;
    const cutoff = now - this.maxSeconds;
    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      this.entries.shift();
    }
    let list = this.entries;
    if (since > 0) {
      list = list.filter(e => e.timestamp > since);
    }
    if (limit > 0 && list.length > limit) {
      list = list.slice(-limit);
    }
    return [...list];
  }
}

const globalLogBuffer = new LogBuffer(2.0, 1500);

// console.log va console.error ni ushlab LogBuffer ga yozish
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  originalLog.apply(console, args);
  const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  globalLogBuffer.add(text, 'INFO');
};

console.error = function (...args) {
  originalError.apply(console, args);
  const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  globalLogBuffer.add(text, 'ERROR');
};

const DASHBOARD_FILE = path.resolve(__dirname, 'dashboard.html');
let cachedDashboardHtml = '';
function getDashboardHtml() {
  try {
    if (!cachedDashboardHtml) {
      if (fs.existsSync(DASHBOARD_FILE)) {
        cachedDashboardHtml = fs.readFileSync(DASHBOARD_FILE, 'utf-8');
      }
    }
  } catch (_) {}
  return cachedDashboardHtml || '<!DOCTYPE html><html><head><title>Minecraft 24/7 AFK Bot</title></head><body>Dashboard</body></html>';
}
const HTML_DASHBOARD = getDashboardHtml();

class WebServer {
  constructor(port = config.PORT, host = config.HOST, getStatusCallback = null, actionCallback = null, supervisor = null) {
    this.port = port;
    this.host = host;
    this.getStatusCallback = getStatusCallback;
    this.actionCallback = actionCallback;
    this.supervisor = supervisor;
    this.server = null;
    this.startTime = Date.now();
    this.keepAliveTimer = null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cleanPath = parsedUrl.pathname.replace(/\/$/, '') || '/';

      const isHead = req.method === 'HEAD';
      const sendJson = (status, data) => {
        const body = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': body.length
        });
        if (isHead) { res.end(); return; }
        res.end(body);
      };

      // GET va HEAD so'rovlar
      if (req.method === 'GET' || isHead) {
        if (cleanPath === '/' || cleanPath === '/logs' || cleanPath === '/dashboard') {
          const body = Buffer.from(getDashboardHtml(), 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-cache'
          });
          if (isHead) { res.end(); return; }
          res.end(body);
          return;
        }

        if (cleanPath === '/api/raw_map.bin') {
          const raw = (this.supervisor && this.supervisor.lastRawMap) ? this.supervisor.lastRawMap : Buffer.alloc(0);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': raw.length
          });
          res.end(raw);
          return;
        }

        if (cleanPath === '/api/captcha.png' || cleanPath === '/api/captcha/image') {
          const botParam = parsedUrl.searchParams.get('bot');
          let png = null;
          if (this.supervisor) {
            if (botParam && this.supervisor.bots) {
              const targetBot = this.supervisor.bots.find(b => b.username.toLowerCase() === botParam.toLowerCase());
              if (targetBot && targetBot.lastCaptchaPng) png = targetBot.lastCaptchaPng;
            }
            if (!png && this.supervisor.lastCaptchaPng) {
              png = this.supervisor.lastCaptchaPng;
            }
          }
          if (png) {
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Length': png.length,
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(png);
            return;
          }
          const blankPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2d0000000049454e44ae426082', 'hex');
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': blankPng.length,
            'Cache-Control': 'no-cache'
          });
          res.end(blankPng);
          return;
        }

        if (cleanPath === '/api/logs') {
          const uptime = Math.floor((Date.now() - this.startTime) / 1000);
          const since = parseFloat(parsedUrl.searchParams.get('since') || '0');
          const limit = parseInt(parsedUrl.searchParams.get('limit') || '0', 10);
          const logs = globalLogBuffer.getLogs(since, limit);
          const data = this.getStatusCallback ? this.getStatusCallback() : {};
          sendJson(200, {
            status: 'healthy',
            uptime: uptime,
            count: logs.length,
            total_count: globalLogBuffer.entries.length,
            window_hours: 2.0,
            data: data,
            logs: logs
          });
          return;
        }

        if (cleanPath === '/health' || cleanPath === '/ping') {
          const uptime = Math.floor((Date.now() - this.startTime) / 1000);
          const data = this.getStatusCallback ? this.getStatusCallback() : {};
          sendJson(200, {
            status: 'healthy',
            uptime: uptime,
            data: data
          });
          return;
        }

        sendJson(404, { error: 'Not Found' });
        return;
      }

      // POST so'rovlar
      if (req.method === 'POST') {
        let bodyRaw = '';
        req.on('data', chunk => { bodyRaw += chunk; });
        req.on('end', () => {
          let payload = {};
          if (bodyRaw) {
            try { payload = JSON.parse(bodyRaw); } catch (_) {}
          }

          if (this.actionCallback) {
            try {
              const result = this.actionCallback(cleanPath, payload);
              sendJson(200, result);
              return;
            } catch (err) {
              sendJson(500, { success: false, error: err.message });
              return;
            }
          }

          sendJson(400, { success: false, error: 'Action handler topilmadi' });
        });
        return;
      }

      sendJson(405, { error: 'Method Not Allowed' });
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`[WebServer] Veb Dashboard ishga tushdi: http://${this.host}:${this.port} (Health: /health)`);
    });
  }

  startKeepAlive(externalUrl = config.SERVER_PUBLIC_URL, intervalSec = config.KEEP_ALIVE_INTERVAL) {
    if (!externalUrl) return;
    const target = `${externalUrl.replace(/\/$/, '')}/health`;
    console.log(`[KeepAlive] 24/7 Render anti-sleep tizimi faol: ${target} (har ${Math.round(intervalSec / 60)} daqiqada)`);

    const ping = () => {
      try {
        const client = target.startsWith('https') ? https : http;
        const req = client.get(target, { headers: { 'User-Agent': 'Render-KeepAlive/2.0' }, timeout: 15000 }, (res) => {
          if (res.statusCode === 200) {
            console.log('[KeepAlive] Render uyg\'oq saqlandi (Status: 200 OK)');
          } else {
            console.log(`[KeepAlive] Kutilmagan status: ${res.statusCode}`);
          }
        });
        req.on('error', (err) => {
          console.log(`[KeepAlive] Ping ogohlantirishi: ${err.message}`);
        });
        req.on('timeout', () => {
          req.destroy();
        });
      } catch (err) {
        console.log(`[KeepAlive] Xatolik: ${err.message}`);
      }
    };

    setTimeout(ping, 10000);
    this.keepAliveTimer = setInterval(ping, intervalSec * 1000);
  }

  stop() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.server) {
      this.server.close();
      console.log('[WebServer] Veb server to\'xtatildi.');
    }
  }
}

module.exports = { WebServer, globalLogBuffer };
