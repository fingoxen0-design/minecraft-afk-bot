/**
 * Minecraft 24/7 AFK Bot powered by Mineflayer
 * Supports: Cracked / Offline mode, /login, /server economy, /afk, anti-kick, auto-reconnect, JSON IPC
 */

const fs = require('fs');
const path = require('path');
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

// Safe chat packet wrapper ensuring play state and multi-method delivery
function safeChat(text) {
  if (!bot || !bot._client || bot._client.state !== 'play' || isStopping || isWorldTransferring) {
    return false;
  }
  let sent = false;
  try {
    if (typeof bot.chat === 'function') {
      bot.chat(text);
      sent = true;
    }
  } catch (_) {}

  // Direct packet fallback for commands starting with /
  if (text.startsWith('/')) {
    const cmd = text.slice(1);
    try {
      bot._client.write('chat_command', {
        command: cmd,
        timestamp: BigInt(Date.now()),
        salt: 0n,
        argumentSignatures: [],
        signedPreview: false,
        messageCount: 0,
        acknowledged: Buffer.alloc(3)
      });
      sent = true;
    } catch (_) {}
    try {
      bot._client.write('chat', { message: text });
      sent = true;
    } catch (_) {}
  } else {
    try {
      if (typeof bot._client.chat === 'function') {
        bot._client.chat(text);
        sent = true;
      }
    } catch (_) {}
  }
  return sent;
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

function recognizeDigits(cols, rows, buf, bg, minX, maxX, minY, maxY) {
  try {
    const colCounts = [];
    for (let x = minX; x <= maxX; x++) {
      let count = 0;
      for (let y = minY; y <= maxY; y++) {
        if (buf[y * cols + x] !== bg) count++;
      }
      colCounts.push({ x, count });
    }

    const segments = [];
    let cur = null;
    for (const c of colCounts) {
      if (c.count > 0) {
        if (!cur) cur = { startX: c.x, endX: c.x };
        else cur.endX = c.x;
      } else {
        if (cur) {
          if (cur.endX - cur.startX >= 1) segments.push(cur);
          cur = null;
        }
      }
    }
    if (cur && cur.endX - cur.startX >= 1) segments.push(cur);

    sendIPC('info', `[MAP_DIGITS] Found ${segments.length} digit segment(s): ${JSON.stringify(segments)}`);
    if (segments.length === 0) return null;

    let result = '';
    for (const seg of segments) {
      const sw = seg.endX - seg.startX + 1;
      const sh = maxY - minY + 1;
      const ratio = sw / sh;

      let fgPixels = 0;
      let topHalfFg = 0;
      let bottomHalfFg = 0;
      let leftHalfFg = 0;
      let rightHalfFg = 0;
      const midY = Math.floor((minY + maxY) / 2);
      const midX = Math.floor((seg.startX + seg.endX) / 2);

      for (let y = minY; y <= maxY; y++) {
        for (let x = seg.startX; x <= seg.endX; x++) {
          if (buf[y * cols + x] !== bg) {
            fgPixels++;
            if (y < midY) topHalfFg++;
            else bottomHalfFg++;
            if (x < midX) leftHalfFg++;
            else rightHalfFg++;
          }
        }
      }

      function getCrossingsAt(yRatio) {
        const y = Math.floor(minY + sh * yRatio);
        let crossings = 0;
        let inFg = false;
        for (let x = seg.startX; x <= seg.endX; x++) {
          const isFg = buf[y * cols + x] !== bg;
          if (isFg && !inFg) {
            crossings++;
            inFg = true;
          } else if (!isFg && inFg) {
            inFg = false;
          }
        }
        return crossings;
      }

      const c25 = getCrossingsAt(0.25);
      const c50 = getCrossingsAt(0.50);
      const c75 = getCrossingsAt(0.75);

      let digit = '?';
      if (ratio < 0.38) {
        digit = '1';
      } else if (c50 === 1 && c25 === 2 && c75 === 2) {
        digit = '0';
      } else if (c50 === 3 || c50 === 2) {
        if (c25 === 1 && c75 === 2) digit = '6';
        else if (c25 === 2 && c75 === 1) digit = '9';
        else if (c25 === 2 && c75 === 2 && c50 === 2) digit = '8';
        else if (topHalfFg < bottomHalfFg * 0.7) digit = '2';
        else if (rightHalfFg > leftHalfFg * 1.3) digit = '3';
        else digit = '5';
      } else if (c50 === 1) {
        if (c25 === 1 && topHalfFg > bottomHalfFg * 1.5) digit = '7';
        else if (c75 === 1 && leftHalfFg < rightHalfFg) digit = '4';
        else digit = '1';
      } else {
        digit = '0';
      }

      result += digit;
    }

    return result;
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
        sendIPC('info', `[MAP_SOLVER] Successfully recognized captcha code: "${code}"`);
        setTimeout(() => {
          sendIPC('info', `Submitting captcha code: "${code}"`);
          safeChat(code);
          safeChat(`/captcha ${code}`);
          safeChat(`/code ${code}`);

          setTimeout(() => {
            if (!hasLoggedIn && config.password) {
              sendIPC('info', 'Sending login credentials after captcha solve...');
              safeChat(`/login ${config.password}`);
            }
          }, 1500);
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

      // Immediate authentication on protocol login to prevent 20s captcha/auth timeout kick
      if (config.password && !hasLoggedIn) {
        let authAttempt = 0;
        const authInterval = setInterval(() => {
          if (hasLoggedIn || isStopping || !bot || authAttempt >= 5) {
            clearInterval(authInterval);
            return;
          }
          authAttempt++;
          sendIPC('info', `Sending login credentials (attempt ${authAttempt})...`);
          safeChat(`/login ${config.password}`);
          safeChat(`/register ${config.password} ${config.password}`);

          // Anti-bot human-like micro action
          try {
            if (typeof bot.swingArm === 'function') bot.swingArm('right');
            if (bot.entity) {
              const delta = (Math.random() - 0.5) * 0.1;
              bot.look(bot.entity.yaw + delta, bot.entity.pitch, true);
            }
          } catch (_) {}
        }, 1500);
      }
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
          if (cleanText) {
            const codeMatch = cleanText.match(/(?:\/captcha|\/code)\s+([0-9a-zA-Z]+)/i) ||
                              cleanText.match(/(?:kod|code|captcha)[:\s]+([0-9a-zA-Z]{3,8})/i) ||
                              cleanText.match(/^([0-9a-zA-Z]{4,8})$/);
            if (codeMatch && codeMatch[1]) {
              const captchaCode = codeMatch[1];
              sendIPC('info', `Auto-Captcha: Extracted code "${captchaCode}" from packet ${name}`);
              setTimeout(() => {
                safeChat(captchaCode);
                safeChat(`/captcha ${captchaCode}`);
              }, 500);
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
      sendIPC('info', `Bot spawned (spawn count: ${spawnCount})`);

      // Smart Auth fallback: send /login after delay if prompt not caught
      if (!hasLoggedIn && config.password) {
        setTimeout(() => {
          if (!hasLoggedIn && bot && !isStopping && !isWorldTransferring) {
            sendIPC('info', 'Sending login credentials (spawn fallback)...');
            safeChat(`/login ${config.password}`);
            hasLoggedIn = true;
          }
        }, 1500);
      }

      // Subserver handling
      const targetSub = config.subserver ? config.subserver.toLowerCase() : '';
      if (targetSub === 'lobby' || targetSub === 'hub') {
        // Already on lobby/hub by default
        setTimeout(() => {
          if (currentServer !== config.subserver) {
            currentServer = config.subserver;
            sendIPC('status', 'in_economy', { server: config.subserver });
          }
          triggerAfk();
        }, 2500);
      } else if (hasLoggedIn && config.subserver && currentServer !== config.subserver && !isWorldTransferring) {
        setTimeout(() => {
          if (currentServer !== config.subserver && !isStopping && !isWorldTransferring) {
            sendIPC('info', `Requesting server switch: /server ${config.subserver}`);
            safeChat(`/server ${config.subserver}`);
          }
        }, 2000);
      } else if (currentServer === config.subserver && !isAfkActive) {
        triggerAfk();
      }
    });

    bot.on('respawn', () => {
      sendIPC('server_change', 'Respawn event detected (switching world/server)');
      if (hasLoggedIn) {
        setTimeout(() => {
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
      sendIPC('kicked', `Kicked from server: ${reasonText}`);
      cleanupBot();
      scheduleReconnect();
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
  if (antiKickInterval) {
    clearInterval(antiKickInterval);
    antiKickInterval = null;
  }
  isAfkActive = false;
  hasLoggedIn = false;
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

// Start the bot
createBot();
