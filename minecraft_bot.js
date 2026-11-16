/**
 * Minecraft 24/7 AFK Bot powered by Mineflayer
 * Supports: Cracked / Offline mode, /login, /server economy, /afk, anti-kick, auto-reconnect, JSON IPC
 */

const mineflayer = require('mineflayer');

// Argument parsing
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    host: '127.0.0.1',
    port: 25565,
    username: 'AFK_Bot',
    password: '',
    version: false, // auto-detect
    subserver: 'economy',
    antiKick: true,
    reconnect: true,
    reconnectDelayMs: 10000
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
  }
  return config;
}

const config = parseArgs();

function sendIPC(type, message, data = {}) {
  const payload = {
    time: new Date().toISOString(),
    type: type, // 'status', 'chat', 'server_change', 'error', 'info', 'kicked'
    message: message,
    data: data
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

let bot = null;
let antiKickInterval = null;
let isStopping = false;
let currentServer = 'hub';
let isAfkActive = false;
let hasLoggedIn = false;
let spawnCount = 0;

function createBot() {
  if (isStopping) return;

  sendIPC('status', 'connecting', { host: config.host, port: config.port, username: config.username });

  const botOptions = {
    host: config.host,
    port: config.port,
    username: config.username,
    auth: 'offline',
    checkTimeoutInterval: 60000,
    hideErrors: false
  };

  if (config.version) {
    botOptions.version = config.version;
  }

  try {
    bot = mineflayer.createBot(botOptions);
  } catch (err) {
    sendIPC('error', `Failed to initialize bot: ${err.message}`);
    scheduleReconnect();
    return;
  }

  bot.on('login', () => {
    sendIPC('status', 'logged_in', { username: bot.username });
  });

  bot.on('spawn', () => {
    spawnCount++;
    sendIPC('info', `Bot spawned (spawn count: ${spawnCount})`);

    // First spawn: perform auth login/register if password provided
    if (!hasLoggedIn && config.password) {
      setTimeout(() => {
        if (!bot) return;
        sendIPC('info', 'Sending login credentials...');
        bot.chat(`/login ${config.password}`);
        bot.chat(`/register ${config.password} ${config.password}`);
        hasLoggedIn = true;
      }, 1500);
    }

    // Attempt to switch to target subserver (e.g. /server economy)
    if (config.subserver && currentServer !== config.subserver) {
      setTimeout(() => {
        if (!bot) return;
        sendIPC('info', `Requesting server switch: /server ${config.subserver}`);
        bot.chat(`/server ${config.subserver}`);
      }, 3500);
    } else if (currentServer === config.subserver && !isAfkActive) {
      triggerAfk();
    }
  });

  bot.on('respawn', () => {
    sendIPC('server_change', 'Respawn event detected (switching world/server)');
    // Often BungeeCord fires respawn when switching servers
    setTimeout(() => {
      checkAndApplyAfk();
    }, 3000);
  });

  bot.on('messagestr', (message) => {
    const cleanMsg = message.trim();
    if (!cleanMsg) return;

    // Emit chat event
    sendIPC('chat', cleanMsg);

    const lower = cleanMsg.toLowerCase();
    const sub = config.subserver.toLowerCase();

    // Check server switch signals in chat
    if (lower.includes(`connecting to ${sub}`) || 
        lower.includes(`sending you to ${sub}`) || 
        lower.includes(`connected to ${sub}`) ||
        lower.includes(`[${sub}]`)) {
      currentServer = config.subserver;
      sendIPC('status', 'in_economy', { server: config.subserver });
      setTimeout(triggerAfk, 2500);
    }

    // Check if already in economy or received /afk confirmation
    if (lower.includes('you are now afk') || lower.includes('afk rejimiga o\'tdingiz') || lower.includes('is now afk')) {
      isAfkActive = true;
      sendIPC('status', 'afk_active', { server: currentServer });
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

  function tryAutoEat() {
    if (!bot || !bot.inventory || isStopping) return;
    const foodItem = bot.inventory.items().find(i => 
      i.name.includes('cooked') || 
      ['bread', 'apple', 'golden_carrot', 'baked_potato', 'steak'].includes(i.name)
    );
    if (foodItem) {
      bot.equip(foodItem, 'hand', (err) => {
        if (!err && bot) {
          bot.consume(() => {
            sendIPC('info', `Avto-ovqatlanish: ${foodItem.name} iste'mol qilindi.`);
          });
        }
      });
    }
  }

  function triggerAfk() {
    if (!bot || isStopping) return;
    sendIPC('info', 'Sending /afk command...');
    bot.chat('/afk');
    isAfkActive = true;
    sendIPC('status', 'afk_active', { server: config.subserver });
  }

  function checkAndApplyAfk() {
    if (!bot || isStopping) return;
    currentServer = config.subserver;
    sendIPC('status', 'in_economy', { server: config.subserver });
    triggerAfk();
  }

  // Anti-Kick loop (gentle yaw rotation and micro-actions)
  if (config.antiKick) {
    if (antiKickInterval) clearInterval(antiKickInterval);
    antiKickInterval = setInterval(() => {
      if (!bot || !bot.entity || isStopping) return;
      try {
        const yawDelta = (Math.random() - 0.5) * 0.4;
        const newYaw = bot.entity.yaw + yawDelta;
        bot.look(newYaw, bot.entity.pitch, true);

        // Small jump or sneak occasionally if on ground
        if (bot.entity.onGround && Math.random() > 0.6) {
          bot.setControlState('jump', true);
          setTimeout(() => {
            if (bot) bot.setControlState('jump', false);
          }, 350);
        }
        sendIPC('info', 'Anti-kick heartbeat pulse sent');
      } catch (err) {
        // Ignore rotation errors if entity not ready
      }
    }, 45000);
  }

  bot.on('kicked', (reason) => {
    let reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason);
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
}

function cleanupBot() {
  if (antiKickInterval) {
    clearInterval(antiKickInterval);
    antiKickInterval = null;
  }
  isAfkActive = false;
  hasLoggedIn = false;
  if (bot) {
    try {
      bot.removeAllListeners();
    } catch (_) {}
    bot = null;
  }
}

function scheduleReconnect() {
  if (isStopping || !config.reconnect) return;
  sendIPC('status', 'reconnecting', { delayMs: config.reconnectDelayMs });
  setTimeout(() => {
    if (!isStopping) {
      createBot();
    }
  }, config.reconnectDelayMs);
}

// Clean termination handling
function stopBot() {
  isStopping = true;
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
    } else if (input.command === 'chat' && input.text && bot) {
      bot.chat(input.text);
    }
  } catch (_) {}
});

// Start the bot
createBot();
