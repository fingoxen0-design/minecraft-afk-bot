/**
 * Minecraft 24/7 AFK Bot powered by Mineflayer
 * Supports: Cracked / Offline mode, /login, /server economy, /afk, anti-kick, auto-reconnect, JSON IPC
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');

// Auto-load .env file if present
function loadLocalEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch (_) {}
  }
}
loadLocalEnv();

process.on('uncaughtException', (err) => {
  if (err && (err.name === 'PartialReadError' || (err.message && (err.message.includes('Missing characters') || err.message.includes('PartialReadError'))))) {
    return;
  }
  sendIPC('error', `Uncaught exception: ${err ? err.message : 'Unknown'}`);
});

process.on('unhandledRejection', (reason) => {
  sendIPC('info', `Unhandled Rejection: ${reason ? (reason.message || reason) : 'Unknown'}`);
});

// Argument parsing with environment variable defaults
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    host: process.env.DEFAULT_MC_HOST || 'allaysmp.pro',
    port: parseInt(process.env.DEFAULT_MC_PORT || '25565', 10),
    username: process.env.DEFAULT_MC_USERNAME || 'Gotto',
    password: process.env.DEFAULT_MC_PASSWORD || 'bunyod',
    version: process.env.DEFAULT_MC_VERSION || '1.21.4', // auto-detect or version string
    subserver: process.env.DEFAULT_MC_SUBSERVER || 'economy',
    antiKick: true,
    reconnect: true,
    reconnectDelayMs: 15000,
    testMode: false
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key === '--host' && val) config.host = val;
    else if (key === '--port' && val) config.port = parseInt(val, 10);
    else if (key === '--username' && val) config.username = val;
    else if (key === '--password' && val) config.password = val;
    else if (key === '--version' && val && val !== 'auto') config.version = val;
    else if (key === '--subserver' && val) config.subserver = val;
    else if (key === '--no-antikick') config.antiKick = false;
    else if (key === '--no-reconnect') config.reconnect = false;
    else if (key === '--test' || key === '--dry-run') config.testMode = true;
  }
  return config;
}

const config = parseArgs();

function sendIPC(type, message, data = {}) {
  const payload = {
    time: new Date().toISOString(),
    type: type, // 'status', 'chat', 'server_change', 'error', 'info', 'kicked', 'health'
    message: message,
    data: data
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// Standalone diagnostic mode: test server ping & connectivity and exit 0
if (config.testMode) {
  sendIPC('info', `Testing server connectivity for ${config.host}:${config.port}...`);
  mc.ping({ host: config.host, port: config.port, timeout: 5000 }, (err, res) => {
    if (err) {
      sendIPC('error', `Server unreachable: ${err.message}`);
      process.exit(1);
    }
    const versionRes = res && res.version ? res.version.name : 'Unknown';
    const protocolRes = res && res.version ? res.version.protocol : 'Unknown';
    const latency = res && res.latency != null ? res.latency : 'OK';
    sendIPC('status', 'test_ok', {
      host: config.host,
      port: config.port,
      serverVersion: versionRes,
      protocol: protocolRes,
      latency: latency
    });
    process.exit(0);
  });
  return;
}

let bot = null;
let antiKickInterval = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isStopping = false;
let currentServer = 'hub';
let isAfkActive = false;
let hasLoggedIn = false;
let spawnCount = 0;
let isWorldTransferring = false;
let isCaptchaPending = false;
let lastSolvedMapHash = null;
let lastSolvedMapTime = 0;
let lastMapProcessTime = 0;
let lastSubmittedChatCaptcha = '';
let lastSubmittedChatCaptchaTime = 0;

// Managed timers to prevent ghost callbacks across reconnects
const activeTimers = new Set();
function safeTimeout(fn, ms) {
  const t = setTimeout(() => {
    activeTimers.delete(t);
    try { fn(); } catch (_) {}
  }, ms);
  activeTimers.add(t);
  return t;
}
function clearAllPendingTimers() {
  for (const t of activeTimers) {
    clearTimeout(t);
    clearInterval(t);
  }
  activeTimers.clear();
}

// Safe chat packet wrapper ensuring play state and native mineflayer delivery
function safeChat(text) {
  if (!bot || !bot._client || bot._client.state !== 'play' || isStopping || isWorldTransferring) {
    return false;
  }
  try {
    if (typeof bot.chat === 'function') {
      bot.chat(text);
      return true;
    }
  } catch (err) {
    sendIPC('error', `Chat error: ${err.message}`);
  }
  return false;
}

function resolveVersion(callback) {
  if (config.version && config.version !== 'auto') {
    return callback(config.version);
  }
  let called = false;
  const safeCallback = (v) => {
    if (!called) {
      called = true;
      callback(v);
    }
  };

  try {
    mc.ping({ host: config.host, port: config.port, timeout: 5000 }, (err, res) => {
      if (!err && res && res.version) {
        const proto = res.version.protocol;
        const protoMap = {
          775: '1.21.1',
          769: '1.21.4',
          768: '1.21.3',
          767: '1.21',
          765: '1.20.4',
          764: '1.20.2',
          763: '1.20.1',
          762: '1.19.4',
          758: '1.18.2',
          754: '1.16.5'
        };
        if (protoMap[proto]) return safeCallback(protoMap[proto]);
        if (res.version.name && /^\d+\.\d+(\.\d+)?$/.test(res.version.name)) {
          return safeCallback(res.version.name);
        }
      }
      return safeCallback('1.21.4');
    });
  } catch (err) {
    safeCallback('1.21.1');
  }
}

// Standard 8x12 digit templates for normalized grid matching
const DIGIT_TEMPLATES = {
  '0': [
    "01111110",
    "11111111",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11111111",
    "01111110"
  ],
  '1': [
    "00011000",
    "00111000",
    "01111000",
    "00011000",
    "00011000",
    "00011000",
    "00011000",
    "00011000",
    "00011000",
    "00011000",
    "01111110",
    "01111110"
  ],
  '2': [
    "01111110",
    "11111111",
    "11000011",
    "00000011",
    "00000110",
    "00011100",
    "00111000",
    "01110000",
    "11000000",
    "11000011",
    "11111111",
    "11111111"
  ],
  '3': [
    "01111110",
    "11111111",
    "00000011",
    "00000011",
    "00011110",
    "00011110",
    "00000011",
    "00000011",
    "00000011",
    "11000011",
    "11111111",
    "01111110"
  ],
  '4': [
    "00001110",
    "00011110",
    "00110110",
    "01100110",
    "11000110",
    "11000110",
    "11111111",
    "11111111",
    "00000110",
    "00000110",
    "00000110",
    "00000110"
  ],
  '5': [
    "11111111",
    "11111111",
    "11000000",
    "11000000",
    "11111110",
    "11111111",
    "00000011",
    "00000011",
    "00000011",
    "11000011",
    "11111111",
    "01111110"
  ],
  '6': [
    "01111110",
    "11111111",
    "11000000",
    "11000000",
    "11111110",
    "11111111",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11111111",
    "01111110"
  ],
  '7': [
    "11111111",
    "11111111",
    "00000011",
    "00000110",
    "00001100",
    "00011000",
    "00011000",
    "00110000",
    "00110000",
    "01100000",
    "01100000",
    "01100000"
  ],
  '8': [
    "01111110",
    "11111111",
    "11000011",
    "11000011",
    "01111110",
    "11111111",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11111111",
    "01111110"
  ],
  '9': [
    "01111110",
    "11111111",
    "11000011",
    "11000011",
    "11000011",
    "11111111",
    "01111111",
    "00000011",
    "00000011",
    "00000011",
    "11111111",
    "01111110"
  ]
};

const TEMPLATE_VECTORS = {};
for (const d in DIGIT_TEMPLATES) {
  const vec = [];
  for (const row of DIGIT_TEMPLATES[d]) {
    for (let i = 0; i < 8; i++) {
      vec.push(row[i] === '1' ? 1.0 : 0.0);
    }
  }
  TEMPLATE_VECTORS[d] = vec;
}

function extract8x12Vector(isFgFn, minX, maxX, minY, maxY) {
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const vec = [];
  const GW = 8;
  const GH = 12;

  for (let gy = 0; gy < GH; gy++) {
    const y0 = minY + Math.floor((gy * h) / GH);
    const y1 = minY + Math.floor(((gy + 1) * h) / GH);
    const yEnd = Math.max(y0 + 1, y1);

    for (let gx = 0; gx < GW; gx++) {
      const x0 = minX + Math.floor((gx * w) / GW);
      const x1 = minX + Math.floor(((gx + 1) * w) / GW);
      const xEnd = Math.max(x0 + 1, x1);

      let total = 0;
      let fgCount = 0;
      for (let y = y0; y < yEnd; y++) {
        for (let x = x0; x < xEnd; x++) {
          total++;
          if (isFgFn(x, y)) fgCount++;
        }
      }
      vec.push(total > 0 ? fgCount / total : 0);
    }
  }
  return vec;
}

function cosineSimilarity(v1, v2) {
  let dot = 0, n1 = 0, n2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    n1 += v1[i] * v1[i];
    n2 += v2[i] * v2[i];
  }
  if (n1 === 0 || n2 === 0) return 0;
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

function isSingleStroke(isFgFn, minX, maxX, minY, maxY) {
  const h = maxY - minY + 1;
  const w = maxX - minX + 1;
  if (h < 5) return false;

  let singleCrossingRows = 0;
  let maxRowWidth = 0;
  let totalStrokeWidth = 0;
  let strokeCount = 0;

  for (let y = minY; y <= maxY; y++) {
    let crossings = 0;
    let inFg = false;
    let run = 0;
    let maxRunInRow = 0;

    for (let x = minX; x <= maxX; x++) {
      const fg = isFgFn(x, y);
      if (fg) {
        run++;
        if (run > maxRunInRow) maxRunInRow = run;
        if (!inFg) { crossings++; inFg = true; }
      } else {
        run = 0;
        inFg = false;
      }
    }

    if (crossings === 1) {
      singleCrossingRows++;
      totalStrokeWidth += maxRunInRow;
      strokeCount++;
    }
    if (maxRunInRow > maxRowWidth) maxRowWidth = maxRunInRow;
  }

  const avgStrokeWidth = strokeCount > 0 ? totalStrokeWidth / strokeCount : w;
  return (singleCrossingRows >= h * 0.82 && maxRowWidth <= avgStrokeWidth * 1.6 && w <= h * 0.65);
}

function classifyDigit(isFgFn, minX, maxX, minY, maxY) {
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const ratio = w / h;

  // Single stroke (vertical or slanted bar with no branches or loops) is '1'
  if (ratio < 0.35 || isSingleStroke(isFgFn, minX, maxX, minY, maxY)) {
    return '1';
  }

  const vec = extract8x12Vector(isFgFn, minX, maxX, minY, maxY);
  const scores = {};
  for (const d in TEMPLATE_VECTORS) {
    scores[d] = cosineSimilarity(vec, TEMPLATE_VECTORS[d]);
  }

  let totalFg = 0, topFg = 0, bottomFg = 0, leftFg = 0, rightFg = 0;
  const midY = minY + h / 2;
  const midX = minX + w / 2;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (isFgFn(x, y)) {
        totalFg++;
        if (y < midY) topFg++; else bottomFg++;
        if (x < midX) leftFg++; else rightFg++;
      }
    }
  }

  function getCrossingsAt(yRatio) {
    const y = Math.floor(minY + h * yRatio);
    let crossings = 0;
    let inFg = false;
    for (let x = minX; x <= maxX; x++) {
      const fg = isFgFn(x, y);
      if (fg && !inFg) { crossings++; inFg = true; }
      else if (!fg && inFg) { inFg = false; }
    }
    return crossings;
  }

  const c25 = getCrossingsAt(0.25);
  const c50 = getCrossingsAt(0.50);
  const c75 = getCrossingsAt(0.75);

  if (ratio < 0.40 && c25 <= 1 && c50 <= 1 && c75 <= 1) {
    scores['1'] = (scores['1'] || 0) + 0.35;
  }
  if (c25 >= 2 && c50 >= 2 && c75 >= 2) {
    scores['0'] = (scores['0'] || 0) + 0.15;
    scores['8'] = (scores['8'] || 0) + 0.20;
  }
  if (c25 <= 1 && c75 >= 2 && bottomFg > topFg) {
    scores['6'] = (scores['6'] || 0) + 0.25;
  }
  if (c25 >= 2 && c75 <= 1 && topFg > bottomFg) {
    scores['9'] = (scores['9'] || 0) + 0.25;
  }
  if (topFg > bottomFg * 1.5 && c25 <= 1) {
    scores['7'] = (scores['7'] || 0) + 0.20;
  }
  if (c50 >= 2 && rightFg > leftFg && c75 <= 1) {
    scores['4'] = (scores['4'] || 0) + 0.15;
  }

  let bestDigit = '0';
  let bestScore = -1;
  for (const d in scores) {
    if (scores[d] > bestScore) {
      bestScore = scores[d];
      bestDigit = d;
    }
  }
  return bestDigit;
}

function recognizeDigits(cols, rows, buf, bg, minX, maxX, minY, maxY) {
  try {
    const isFg = (x, y) => {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return false;
      return buf[y * cols + x] !== bg;
    };

    // 1. Detect vertical core band (removing top/bottom banners or arcs)
    const rowStats = [];
    const totalW = maxX - minX + 1;
    for (let y = minY; y <= maxY; y++) {
      let cnt = 0;
      let maxRun = 0;
      let curRun = 0;
      for (let x = minX; x <= maxX; x++) {
        if (isFg(x, y)) {
          cnt++;
          curRun++;
          if (curRun > maxRun) maxRun = curRun;
        } else {
          curRun = 0;
        }
      }
      rowStats.push({ y, cnt, maxRun });
    }

    let bandMinY = minY;
    let bandMaxY = maxY;
    for (const r of rowStats) {
      if (r.maxRun > totalW * 0.70 && r.y < minY + (maxY - minY) * 0.35) {
        bandMinY = r.y + 1;
      }
    }
    for (let i = rowStats.length - 1; i >= 0; i--) {
      const r = rowStats[i];
      if (r.maxRun > totalW * 0.70 && r.y > maxY - (maxY - minY) * 0.35) {
        bandMaxY = r.y - 1;
      }
    }
    if (bandMaxY <= bandMinY) {
      bandMinY = minY;
      bandMaxY = maxY;
    }

    // 2. Column histogram in bandMinY..bandMaxY
    const colCounts = [];
    let maxColCount = 0;
    for (let x = minX; x <= maxX; x++) {
      let cnt = 0;
      for (let y = bandMinY; y <= bandMaxY; y++) {
        if (isFg(x, y)) cnt++;
      }
      colCounts.push({ x, cnt });
      if (cnt > maxColCount) maxColCount = cnt;
    }

    if (maxColCount === 0) return null;

    // 3. Peak and Valley Segmentation on Column Histogram
    const smoothed = [];
    for (let i = 0; i < colCounts.length; i++) {
      const p = colCounts[i - 1] ? colCounts[i - 1].cnt : colCounts[i].cnt;
      const c = colCounts[i].cnt;
      const n = colCounts[i + 1] ? colCounts[i + 1].cnt : colCounts[i].cnt;
      smoothed.push({ x: colCounts[i].x, val: 0.25 * p + 0.5 * c + 0.25 * n });
    }

    const splitPoints = [minX];
    for (let i = 2; i < smoothed.length - 2; i++) {
      const cur = smoothed[i].val;
      const prev = smoothed[i - 1].val;
      const next = smoothed[i + 1].val;

      if (cur <= prev && cur <= next) {
        const lastSplit = splitPoints[splitPoints.length - 1];
        const dist = smoothed[i].x - lastSplit;
        const distToEnd = maxX - smoothed[i].x;

        if (dist >= 6 && distToEnd >= 6) {
          const leftPeak = Math.max(...smoothed.slice(Math.max(0, i - 12), i).map(s => s.val));
          const rightPeak = Math.max(...smoothed.slice(i + 1, Math.min(smoothed.length, i + 13)).map(s => s.val));
          if (cur < leftPeak * 0.85 && cur < rightPeak * 0.85) {
            splitPoints.push(smoothed[i].x);
          }
        }
      }
    }
    splitPoints.push(maxX + 1);

    const splitSegments = [];
    for (let i = 0; i < splitPoints.length - 1; i++) {
      splitSegments.push({ startX: splitPoints[i], endX: splitPoints[i + 1] - 1 });
    }

    sendIPC('info', `[MAP_DIGITS] Found ${splitSegments.length} digit segment(s): ${JSON.stringify(splitSegments)}`);
    if (splitSegments.length === 0) return null;

    // 4. For each segment, calculate local bounding box and recognize
    let result = '';
    for (const seg of splitSegments) {
      let dMinY = bandMaxY, dMaxY = bandMinY;
      let dMinX = seg.endX, dMaxX = seg.startX;
      let fgCount = 0;

      for (let y = bandMinY; y <= bandMaxY; y++) {
        for (let x = seg.startX; x <= seg.endX; x++) {
          if (isFg(x, y)) {
            fgCount++;
            if (y < dMinY) dMinY = y;
            if (y > dMaxY) dMaxY = y;
            if (x < dMinX) dMinX = x;
            if (x > dMaxX) dMaxX = x;
          }
        }
      }

      if (fgCount < 10 || dMaxY - dMinY < 5 || dMaxX < dMinX) {
        continue;
      }

      const digit = classifyDigit(isFg, dMinX, dMaxX, dMinY, dMaxY);
      result += digit;
    }

    return result || null;
  } catch (e) {
    return null;
  }
}

function handleMapCaptcha(data) {
  try {
    const cols = data.columns || 0;
    const rows = data.rows || 0;
    const buf = data.data;
    const len = buf ? buf.length : 0;
    sendIPC('info', `[MAP PACKET] itemDamage=${data.itemDamage}, cols=${cols}, rows=${rows}, len=${len}`);
    if (!buf || len === 0 || cols === 0 || rows === 0) return;

    // Fast MD5 hash of map pixel buffer to debounce duplicate packets & burst protection
    const mapHash = crypto.createHash('md5').update(buf).digest('hex');
    const now = Date.now();
    if ((lastSolvedMapHash === mapHash && (now - lastSolvedMapTime < 60000)) || (now - lastMapProcessTime < 3000)) {
      sendIPC('info', `[MAP_SOLVER] Map ${mapHash.slice(0, 8)} debounced (processed recently).`);
      return;
    }
    lastMapProcessTime = now;
    isCaptchaPending = true;

    const freq = {};
    for (let i = 0; i < len; i++) {
      const c = buf[i];
      freq[c] = (freq[c] || 0) + 1;
    }
    let bg = null;
    let maxCount = 0;
    for (const c in freq) {
      if (freq[c] > maxCount) {
        maxCount = freq[c];
        bg = Number(c);
      }
    }

    let minX = cols, maxX = 0, minY = rows, maxY = 0;
    let fgCount = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (buf[y * cols + x] !== bg) {
          fgCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    sendIPC('info', `[MAP ANALYSIS] bg=${bg}, fgCount=${fgCount}, bbox=[${minX},${minY} -> ${maxX},${maxY}]`);

    if (fgCount > 20 && maxX >= minX && maxY >= minY) {
      const asciiLines = [];
      const stepY = (maxY - minY > 50) ? 2 : 1;
      const stepX = (maxX - minX > 90) ? 2 : 1;
      for (let y = minY; y <= maxY; y += stepY) {
        let line = '';
        for (let x = minX; x <= maxX; x += stepX) {
          line += (buf[y * cols + x] !== bg) ? '#' : '.';
        }
        asciiLines.push(line);
      }
      sendIPC('info', `[MAP_ASCII]\n${asciiLines.join('\n')}`);

      const code = recognizeDigits(cols, rows, buf, bg, minX, maxX, minY, maxY);
      if (code) {
        lastSolvedMapHash = mapHash;
        lastSolvedMapTime = Date.now();
        sendIPC('info', `[MAP_SOLVER] Successfully recognized captcha code: "${code}"`);
        safeTimeout(() => {
          sendIPC('info', `Submitting captcha code: "${code}"`);
          safeChat(code);
        }, 800);
      }
    }
  } catch (err) {
    sendIPC('error', `Error analyzing map captcha: ${err.message}`);
  }
}

function createBot() {
  if (isStopping) return;

  resolveVersion((resolvedVersion) => {
    if (isStopping) return;

    sendIPC('status', 'connecting', { host: config.host, port: config.port, username: config.username, version: resolvedVersion });

    const botOptions = {
      host: config.host,
      port: config.port,
      username: config.username,
      version: resolvedVersion,
      auth: 'offline',
      checkTimeoutInterval: 60000,
      hideErrors: true
    };

    try {
      bot = mineflayer.createBot(botOptions);
    } catch (err) {
      sendIPC('error', `Failed to initialize bot: ${err.message}`);
      scheduleReconnect();
      return;
    }

    bot.on('login', () => {
      reconnectAttempts = 0;
      sendIPC('status', 'logged_in', { username: bot.username });

      // Reactive authentication: responds to server chat prompt (/login or /register).
      // Delayed peaceful fallback (6s) only if no prompt and no captcha was seen.
      safeTimeout(() => {
        if (!hasLoggedIn && !isCaptchaPending && config.password && bot && !isStopping) {
          sendIPC('info', 'Sending login credentials (peaceful fallback)...');
          safeChat(`/login ${config.password}`);
        }
      }, 6000);
    });

    // Velocity 1.7.2 configuration transition & packet inspection handling
    if (bot._client) {
      bot._client.on('packet', (data, meta) => {
        const name = meta ? meta.name : '';
        if (name === 'start_configuration') {
          isWorldTransferring = true;
          sendIPC('info', 'World transfer initiated by proxy...');
        } else if (name === 'finish_configuration') {
          sendIPC('server_change', 'Server configuration finished');
          if (isWorldTransferring) {
            isWorldTransferring = false;
            currentServer = config.subserver;
            sendIPC('status', 'in_economy', { server: config.subserver });
            setTimeout(() => {
              triggerAfk();
            }, 3000);
          }
        } else if (['open_window', 'set_slot', 'set_title_text', 'set_subtitle_text', 'set_action_bar_text', 'boss_bar', 'kick_disconnect', 'map', 'system_chat', 'player_chat'].includes(name)) {
          let strings = [];
          function getStrings(obj) {
            if (!obj) return;
            if (typeof obj === 'string') { strings.push(obj); return; }
            if (typeof obj === 'number') { strings.push(String(obj)); return; }
            if (Array.isArray(obj)) { obj.forEach(getStrings); return; }
            if (typeof obj === 'object') {
              if (obj.value != null && typeof obj.value === 'string') strings.push(obj.value);
              if (obj.text != null && typeof obj.text === 'string') strings.push(obj.text);
              for (const k of Object.keys(obj)) {
                if (['color', 'font', 'bold', 'italic', 'underlined', 'strikethrough', 'obfuscated', 'type'].includes(k)) continue;
                getStrings(obj[k]);
              }
            }
          }
          try { getStrings(data); } catch (_) {}
          const cleanText = [...new Set(strings)].filter(s => s.trim().length > 0).join(' ');
          let rawJson = '';
          try { rawJson = JSON.stringify(data).slice(0, 500); } catch (_) {}
          sendIPC('info', `[PACKET:${name}] text="${cleanText}" raw=${rawJson}`);

          // Check if packet text contains captcha instruction or code
          // Explicitly ignore kick_disconnect, disconnect, and system kicks so their text
          // ("You have entered the incorrect captcha code...") NEVER triggers the captcha regex!
          const isKickPacket = ['kick_disconnect', 'disconnect'].includes(name) ||
                               name.toLowerCase().includes('kick') ||
                               name.toLowerCase().includes('disconnect');

          const isKickOrErrorText = /(?:incorrect|wrong|invalid|failed|error|noto'?g'?ri|xato)\s+(?:captcha|code|kod)/i.test(cleanText) ||
                                    /kicked|disconnect|banned|reconnect|too long|timed out|attempts remaining/i.test(cleanText) ||
                                    /you have entered (?:the )?incorrect/i.test(cleanText) ||
                                    /entered\s+the\s+incorrect/i.test(cleanText) ||
                                    /please reconnect/i.test(cleanText);

          if (!hasLoggedIn && !isKickPacket && !isKickOrErrorText && cleanText) {
            const codeMatch = cleanText.match(/(?:\/captcha|\/code)\s+([0-9a-zA-Z]+)/i) ||
                              cleanText.match(/(?:captcha\s+code|kod(?:ni)?(?:\s+kiriting)?|code|kod|captcha)\s*[:=]\s*([0-9a-zA-Z]{3,8})/i) ||
                              cleanText.match(/(?:captcha\s+code|kod(?:ni)?(?:\s+kiriting)?|code|kod|captcha)\s+([0-9]{3,8})\b/i) ||
                              cleanText.match(/^\s*([0-9a-zA-Z]{4,8})\s*$/);
            if (codeMatch && codeMatch[1]) {
              const captchaCode = codeMatch[1].trim();
              const invalidWords = ['incorrect', 'captcha', 'please', 'reconnect', 'failed', 'kicked', 'server', 'player', 'session', 'code', 'kod', 'enter', 'kiriting', 'allaysmp', 'website', 'store', 'discord', 'welcome'];
              const now = Date.now();
              if (!invalidWords.includes(captchaCode.toLowerCase())) {
                if (captchaCode !== lastSubmittedChatCaptcha || (now - lastSubmittedChatCaptchaTime > 5000)) {
                  lastSubmittedChatCaptcha = captchaCode;
                  lastSubmittedChatCaptchaTime = now;
                  sendIPC('info', `Auto-Captcha: Extracted code "${captchaCode}" from packet ${name}`);
                  safeTimeout(() => {
                    sendIPC('info', `Submitting captcha code: "${captchaCode}"`);
                    safeChat(captchaCode);
                  }, 500);
                }
              }
            }
          }

          // Filled map handling (slot 36 = first hotbar slot)
          if (name === 'set_slot' && data && data.item) {
            const itemId = data.item.itemId || data.item.id;
            if (itemId === 982 || (data.item.name && data.item.name.includes('map'))) {
              sendIPC('info', `Received map item in slot ${data.slot}: equipping to hotbar slot 0`);
              try {
                if (bot && typeof bot.setQuickBarSlot === 'function') {
                  bot.setQuickBarSlot(0);
                }
                if (bot && typeof bot.activateItem === 'function') {
                  setTimeout(() => {
                    try { bot.activateItem(); } catch (_) {}
                  }, 800);
                }
              } catch (_) {}
            }
          }

          // Map packet handling (pixel buffer for map captcha)
          if (name === 'map' && data) {
            handleMapCaptcha(data);
          }

          // Auto-solve GUI Captcha if inventory window opens
          if (name === 'open_window' && data) {
            setTimeout(() => {
              if (bot && bot.currentWindow) {
                const items = bot.currentWindow.items();
                const target = items.find(i => i.name.includes('green') || i.name.includes('lime') || i.name.includes('emerald') || i.name.includes('wool') || i.name.includes('star'));
                if (target) {
                  sendIPC('info', `Clicking GUI captcha item: slot ${target.slot} (${target.name})`);
                  bot.clickWindow(target.slot, 0, 0);
                }
              }
            }, 1000);
          }
        }
      });
    }

    bot.on('spawn', () => {
      spawnCount++;
      isWorldTransferring = false;
      sendIPC('info', `Bot spawned (spawn count: ${spawnCount})`);

      // Wait for login before switching subserver
      if (hasLoggedIn) {
        isCaptchaPending = false;
      }

      // Subserver handling
      const targetSub = config.subserver ? config.subserver.toLowerCase() : '';
      if (targetSub === 'lobby' || targetSub === 'hub') {
        // Already on lobby/hub by default
        safeTimeout(() => {
          if (currentServer !== config.subserver) {
            currentServer = config.subserver;
            sendIPC('status', 'in_economy', { server: config.subserver });
          }
          triggerAfk();
        }, 2500);
      } else if (hasLoggedIn && config.subserver && currentServer !== config.subserver) {
        safeTimeout(() => {
          if (currentServer !== config.subserver && !isStopping) {
            sendIPC('info', `Requesting server switch: /server ${config.subserver}`);
            safeChat(`/server ${config.subserver}`);
          }
        }, 2000);
      } else if (currentServer === config.subserver && !isAfkActive) {
        triggerAfk();
      }
    });

    bot.on('respawn', () => {
      isWorldTransferring = false;
      sendIPC('server_change', 'Respawn event detected (switching world/server)');
      if (hasLoggedIn) {
        safeTimeout(() => {
          checkAndApplyAfk();
        }, 3000);
      }
    });

    bot.on('messagestr', (message) => {
      const cleanMsg = message.trim();
      if (!cleanMsg) return;

      sendIPC('chat', cleanMsg);

      const lower = cleanMsg.toLowerCase();
      const sub = config.subserver ? config.subserver.toLowerCase() : '';

      // Check server switch signals in chat
      if (sub) {
        if (lower.includes(`connected to ${sub}`) || 
            lower.includes(`connecting to ${sub}`) || 
            lower.includes(`sending you to ${sub}`) || 
            lower.includes(`[${sub}]`)) {
          currentServer = config.subserver;
          sendIPC('status', 'in_economy', { server: config.subserver });
          setTimeout(triggerAfk, 2000);
        } else if ((sub === 'lobby' || sub === 'hub') && 
                   (lower.includes('already connected to this server') || 
                    lower.includes('already on this server') ||
                    lower.includes('you are currently connected to lobby'))) {
          currentServer = config.subserver;
          sendIPC('status', 'in_economy', { server: config.subserver });
          setTimeout(triggerAfk, 2000);
        }
      }

      // Check if already in economy or received /afk confirmation
      if (lower.includes('you are now afk') || 
          lower.includes('afk rejimiga o\'tdingiz') || 
          lower.includes('is now afk') ||
          lower.includes('afk status: active')) {
        isAfkActive = true;
        sendIPC('status', 'afk_active', { server: currentServer });
      }

      // Auth confirmation detection
      if (lower.includes('you have successfully logged') || 
          lower.includes('successfully logged in') ||
          lower.includes('your login session has been continued') ||
          lower.includes('you are already logged in')) {
        hasLoggedIn = true;
        sendIPC('info', 'Authentication successful / session confirmed.');
        
        // Switch to subserver if target is specified and not lobby
        const targetSub = config.subserver ? config.subserver.toLowerCase() : '';
        if (targetSub && targetSub !== 'lobby' && targetSub !== 'hub' && currentServer !== config.subserver) {
          setTimeout(() => {
            if (currentServer !== config.subserver && !isStopping) {
              sendIPC('info', `Switching to subserver: /server ${config.subserver}`);
              safeChat(`/server ${config.subserver}`);
            }
          }, 1500);
        }
      }

      // Smart Auth: respond cleanly to prompts without sending both in the same tick
      if (lower.includes('/register') && !hasLoggedIn && config.password) {
        setTimeout(() => {
          if (!hasLoggedIn && bot && !isStopping) {
            sendIPC('info', 'Executing registration...');
            safeChat(`/register ${config.password} ${config.password}`);
          }
        }, 800);
      } else if (lower.includes('/login') && !hasLoggedIn && config.password) {
        setTimeout(() => {
          if (!hasLoggedIn && bot && !isStopping) {
            sendIPC('info', 'Executing login...');
            safeChat(`/login ${config.password}`);
          }
        }, 800);
      }
    });

    bot.on('health', () => {
      if (!bot) return;
      const h = bot.health != null ? bot.health.toFixed(0) : '?';
      const f = bot.food != null ? bot.food.toFixed(0) : '?';
      sendIPC('health', `Jon (Health): ${h}/20 | Ovqat (Food): ${f}/20`, { health: bot.health, food: bot.food });

      if (bot.food < 15 && typeof tryAutoEat === 'function') {
        tryAutoEat();
      }
    });

    // GUI Server Selector fallback (using Nether Star item)
    function tryGuiSelectorFallback() {
      if (!bot || !bot.inventory || currentServer === config.subserver || isStopping) return;
      try {
        const star = bot.inventory.items().find(i => i.name === 'nether_star' || i.name.includes('star'));
        if (star) {
          sendIPC('info', 'Attempting GUI Server Selector fallback...');
          bot.equip(star, 'hand').then(() => {
            if (typeof bot.activateItem === 'function') {
              bot.activateItem();
              bot.once('windowOpen', (window) => {
                const sub = config.subserver.toLowerCase();
                let targetSlot = null;
                if (sub.includes('econ')) targetSlot = 13;
                else if (sub.includes('prac')) targetSlot = 10;
                else if (sub.includes('life')) targetSlot = 16;

                if (targetSlot != null) {
                  sendIPC('info', `Clicking GUI slot ${targetSlot} for ${config.subserver}`);
                  bot.clickWindow(targetSlot, 0, 0);
                }
              });
            }
          }).catch(() => {});
        }
      } catch (_) {}
    }

    async function tryAutoEat() {
      if (!bot || !bot.inventory || !bot._client || bot._client.state !== 'play' || isStopping) return;
      try {
        const foodItem = bot.inventory.items().find(i => 
          i.name.includes('cooked') || 
          ['bread', 'apple', 'golden_carrot', 'baked_potato', 'steak', 'carrot', 'baked_potato', 'sweet_berries'].includes(i.name)
        );
        if (foodItem) {
          await bot.equip(foodItem, 'hand');
          if (typeof bot.consume === 'function') {
            await bot.consume();
            sendIPC('info', `Avto-ovqatlanish: ${foodItem.name} iste'mol qilindi.`);
          }
        }
      } catch (_) {}
    }

    function triggerAfk() {
      if (!bot || !bot._client || bot._client.state !== 'play' || isStopping) return;
      sendIPC('info', 'Sending /afk command...');
      safeChat('/afk');
      isAfkActive = true;
      sendIPC('status', 'afk_active', { server: config.subserver });
    }

    function checkAndApplyAfk() {
      if (!bot || !bot._client || bot._client.state !== 'play' || isStopping) return;
      currentServer = config.subserver;
      sendIPC('status', 'in_economy', { server: config.subserver });
      triggerAfk();
    }

    // Hardened Anti-Kick loop (safe arm swing, gentle yaw rotation, micro actions)
    if (config.antiKick) {
      if (antiKickInterval) clearInterval(antiKickInterval);
      antiKickInterval = setInterval(() => {
        if (!bot || !bot.entity || !bot._client || bot._client.state !== 'play' || isStopping) return;
        try {
          // Safe arm swing
          if (typeof bot.swingArm === 'function') {
            bot.swingArm('right');
          }

          // Micro yaw look rotation
          const yawDelta = (Math.random() - 0.5) * 0.2;
          const newYaw = bot.entity.yaw + yawDelta;
          bot.look(newYaw, bot.entity.pitch, true);

          // Gentle head pitch adjustment
          const pitchDelta = (Math.random() - 0.5) * 0.1;
          bot.look(newYaw, bot.entity.pitch + pitchDelta, true);
          sendIPC('info', 'Anti-kick heartbeat pulse sent');
        } catch (err) {
          // Ignore rotation/action errors if entity not ready
        }
      }, 30000);
    }

    bot.on('kicked', (reason) => {
      let reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason);
      try {
        const parsed = typeof reason === 'object' ? reason : JSON.parse(reason);
        if (parsed.value && parsed.value.extra && parsed.value.extra.value && parsed.value.extra.value.value) {
          const list = parsed.value.extra.value.value;
          const textParts = list.map(item => (item.text && item.text.value) ? item.text.value : '').join('');
          if (textParts.trim()) reasonText = textParts.trim().replace(/\n+/g, ' ');
        } else if (parsed.text) {
          reasonText = typeof parsed.text === 'string' ? parsed.text : JSON.stringify(parsed.text);
        }
      } catch (_) {}
      sendIPC('kicked', `Kicked from server: ${reasonText}`, { reason: reasonText });
      cleanupBot();
      // On kick, do NOT attempt a 2nd reconnect automatically! Halt immediately for inspection.
      isStopping = true;
      sendIPC('status', 'kicked', { reason: reasonText });
      process.exit(1);
    });

    bot.on('end', (reason) => {
      sendIPC('status', 'disconnected', { reason: reason || 'Connection ended' });
      cleanupBot();
      scheduleReconnect();
    });

    bot.on('error', (err) => {
      sendIPC('error', `Connection error: ${err.message}`);
      cleanupBot();
      scheduleReconnect();
    });
  });
}

function cleanupBot() {
  clearAllPendingTimers();
  if (antiKickInterval) {
    clearInterval(antiKickInterval);
    antiKickInterval = null;
  }
  isAfkActive = false;
  hasLoggedIn = false;
  isCaptchaPending = false;
  isWorldTransferring = false;
  if (bot) {
    try {
      bot.removeAllListeners();
    } catch (_) {}
    bot = null;
  }
}

// Single-timer debouncing and backoff (15s - 60s) for reconnects
function scheduleReconnect() {
  if (isStopping || !config.reconnect) {
    if (!config.reconnect && !isStopping) {
      process.exit(1);
    }
    return;
  }
  if (reconnectTimer) {
    // Already scheduled, debounce duplicate events
    return;
  }

  reconnectAttempts++;
  const delayMs = Math.min(60000, Math.max(15000, config.reconnectDelayMs * Math.min(reconnectAttempts, 4)));

  sendIPC('status', 'reconnecting', { delayMs: delayMs, attempt: reconnectAttempts });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isStopping) {
      createBot();
    }
  }, delayMs);
}

// Clean termination handling
function stopBot() {
  isStopping = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  cleanupBot();
  sendIPC('status', 'stopped');
  process.exit(0);
}

process.on('SIGINT', stopBot);
process.on('SIGTERM', stopBot);

// Start the bot and stdin listener when run directly as script
if (require.main === module) {
  process.stdin.on('data', (data) => {
    try {
      const input = JSON.parse(data.toString().trim());
      if (input.command === 'stop') {
        stopBot();
      } else if (input.command === 'chat' && input.text) {
        safeChat(input.text);
      }
    } catch (_) {}
  });

  createBot();
}

module.exports = {
  createBot,
  safeChat,
  recognizeDigits,
  handleMapCaptcha,
  classifyDigit,
  parseArgs
};
