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
    version: process.env.DEFAULT_MC_VERSION || false, // auto-detect or version string
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

// Safe chat packet wrapper ensuring play state
function safeChat(text) {
  if (!bot || !bot._client || bot._client.state !== 'play' || isStopping || isWorldTransferring) {
    return false;
  }
  try {
    if (typeof bot.chat === 'function') {
      bot.chat(text);
      return true;
    } else if (typeof bot._client.chat === 'function') {
      bot._client.chat(text);
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
      return safeCallback('1.21.1');
    });
  } catch (err) {
    safeCallback('1.21.1');
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
        setTimeout(() => {
          if (!hasLoggedIn && bot && !isStopping) {
            sendIPC('info', 'Sending login credentials on protocol login...');
            safeChat(`/login ${config.password}`);
            // Quick register fallback if account is not registered yet
            setTimeout(() => {
              if (!hasLoggedIn && bot && !isStopping) {
                safeChat(`/register ${config.password} ${config.password}`);
              }
            }, 1000);
          }
        }, 1200);
      }
    });

    // Velocity 1.7.2 configuration transition handling
    if (bot._client) {
      bot._client.on('packet', (data, meta) => {
        if (meta && meta.name === 'start_configuration') {
          isWorldTransferring = true;
          sendIPC('info', 'World transfer initiated by proxy...');
        } else if (meta && meta.name === 'finish_configuration') {
          sendIPC('server_change', 'Server configuration finished');
          if (isWorldTransferring) {
            isWorldTransferring = false;
            currentServer = config.subserver;
            sendIPC('status', 'in_economy', { server: config.subserver });
            setTimeout(() => {
              triggerAfk();
            }, 3000);
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
