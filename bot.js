/**
 * Minecraft 24/7 Multi-Bot Supervisor powered by Mineflayer (Pure Node.js)
 * Supports multiple accounts simultaneously: Gotto, fingoxenPro, etc.
 * Zero Python, Zero Telegram, 4x Vote Tracker, Web Dashboard, Anti-Sleep Keep-Alive
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const config = require('./config');
const VoteTracker = require('./voteTracker');
const ShardTracker = require('./shardTracker');
const { WebServer, globalLogBuffer } = require('./webServer');
const { createMapPng, solveMapWithOcr } = require('./captchaSolver');

process.on('uncaughtException', (err) => {
  const msg = err ? (err.message || String(err)) : '';
  if (err && (err.name === 'PartialReadError' || msg.includes('PartialReadError') || msg.includes('timed out after') || msg.includes('Missing characters') || msg.includes('ECONNRESET'))) {
    return;
  }
  console.error('[UncaughtException]', err ? err.message : err);
});

// Minecraft NBT/Compound matnlaridan toza, tushunarli matnni ajratib olish
function extractCleanText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') {
    return obj.replace(/§[0-9a-fk-or]/gi, '').trim();
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return String(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(extractCleanText).filter(Boolean).join('');
  }
  if (typeof obj === 'object') {
    let res = '';
    if (obj.text && typeof obj.text === 'string') {
      res += obj.text.replace(/§[0-9a-fk-or]/gi, '');
    } else if (obj.text) {
      res += extractCleanText(obj.text);
    }
    if (obj.value) {
      res += extractCleanText(obj.value);
    }
    if (obj.extra) {
      res += extractCleanText(obj.extra);
    }
    return res.trim();
  }
  return '';
}

// Buyruq va chatlarni tozalash, Telegram /cmd, /say qoldiqlarini to'g'rilash
function normalizeCommand(raw) {
  let str = String(raw || '').trim();
  if (!str) return '';

  // 1. Eski Telegram bot prefikslarini tozalash (/cmd va /say)
  if (/^\/cmd\s+/i.test(str)) {
    str = str.replace(/^\/cmd\s+/i, '').trim();
  } else if (/^\/cmd$/i.test(str)) {
    return '';
  }

  if (/^\/say\s+/i.test(str)) {
    str = str.replace(/^\/say\s+/i, '').trim();
  }

  // 2. '/' siz kiritilgan server buyruqlarini avtomatik '/' bilan to'ldirish
  const knownCommands = [
    'tpaccept', 'tpa', 'tpahere', 'home', 'spawn', 'afk', 'warp',
    'balance', 'bal', 'money', 'pay', 'vote', 'server', 'login',
    'register', 'shards', 'shard', 'clan', 'help', 'msg', 'tell', 'w', 'r'
  ];

  const firstWord = str.split(/\s+/)[0].toLowerCase();
  if (knownCommands.includes(firstWord) && !str.startsWith('/')) {
    str = '/' + str;
  }

  return str;
}

class SingleBotInstance {
  constructor(account, supervisor) {
    this.account = account;
    this.username = account.username;
    this.password = account.password;
    this.supervisor = supervisor;

    this.bot = null;
    this.status = 'stopped'; // stopped, connecting, logged_in, in_queue, in_economy, afk_active, reconnecting, kicked
    this.currentServer = 'lobby'; // Har doim 'lobby' dan boshlaydi
    this.isAfk = false;
    this.health = 20;
    this.food = 20;
    this.startedAt = null;
    this.lastMessage = '';
    this.manualStopped = false;
    this.reconnectTimer = null;
    this.antiKickInterval = null;
    this.watchdogInterval = null;
    this.shardCheckInterval = null;
    this.lastShardCheck = 0;
    this.pendingTimers = [];

    // Velocity Proxy Navbat (Queue) Boshqaruvi (60-80s)
    this.isQueueWaiting = false;
    this.queueStartedAt = null;
    this.queueDurationMs = 80000; // 80 soniya
    this.queueTimer = null;

    // Captcha & Safety State
    this.hasLoggedIn = false;
    this.isCaptchaPending = false;
    this.lastCaptchaPng = null;
    this.lastCaptchaTime = 0;
    this.lastSubmittedCaptcha = null;
    this.lastSubmittedCaptchaTime = 0;
    this.lastSolvedMapHash = null;
    this.lastSolvedMapTime = 0;
    this.lastMapProcessTime = 0;
    this.targetLocation = 'afk'; // 'afk', 'home', 'spawn', 'warp'
  }

  getSummary() {
    const uptimeSec = this.startedAt && this.status !== 'stopped'
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;

    const queueRemSec = (this.isQueueWaiting && this.queueStartedAt)
      ? Math.max(0, Math.ceil((this.queueDurationMs - (Date.now() - this.queueStartedAt)) / 1000))
      : 0;

    return {
      username: this.username,
      status: this.status,
      is_afk: this.isAfk,
      server: this.currentServer,
      is_queue_waiting: this.isQueueWaiting,
      queue_remaining_seconds: queueRemSec,
      health: this.health,
      food: this.food,
      uptime_seconds: uptimeSec,
      uptime_text: `${hours}s ${mins}d ${secs}sek`,
      last_message: this.lastMessage,
      host: config.MC_HOST,
      subserver: config.MC_SUBSERVER,
      manual_stopped: this.manualStopped,
      target_location: this.targetLocation,
      captchaPending: this.isCaptchaPending,
      hasCaptchaPng: !!this.lastCaptchaPng,
      lastCaptchaTime: this.lastCaptchaTime,
      ping: (this.bot && this.bot.player && typeof this.bot.player.ping === 'number') ? this.bot.player.ping : 0,
      position: this.bot && this.bot.entity ? {
        x: Math.round(this.bot.entity.position.x),
        y: Math.round(this.bot.entity.position.y),
        z: Math.round(this.bot.entity.position.z)
      } : null,
      nearby_players: (this.bot && this.bot.entities && this.bot.entity) ? Object.values(this.bot.entities)
        .filter(e => e.type === 'player' && e.username && e.username !== this.username && e.position)
        .map(e => ({
          username: e.username,
          distance: Math.round(this.bot.entity.position.distanceTo(e.position))
        })) : []
    };
  }

  safeTimeout(fn, delay) {
    const t = setTimeout(() => {
      this.pendingTimers = this.pendingTimers.filter(x => x !== t);
      fn();
    }, delay);
    this.pendingTimers.push(t);
    return t;
  }

  clearAllTimers() {
    this.pendingTimers.forEach(t => clearTimeout(t));
    this.pendingTimers = [];
    if (this.antiKickInterval) {
      clearInterval(this.antiKickInterval);
      this.antiKickInterval = null;
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    if (this.shardCheckInterval) {
      clearInterval(this.shardCheckInterval);
      this.shardCheckInterval = null;
    }
  }

  safeChat(rawMessage, force = false) {
    if (!this.bot || typeof this.bot.chat !== 'function') {
      return false;
    }
    const message = normalizeCommand(rawMessage);
    if (!message) return false;

    // 1. Agar Velocity navbat ketayotgan bo'lsa va bu majburiy (force) bo'lmasa:
    // Velocity Proxy "An internal error occurred in your connection" xatosi bilan kick qilmasligi uchun buyruq to'xtatiladi!
    if (this.isQueueWaiting && !force) {
      const remaining = Math.max(0, Math.ceil((this.queueDurationMs - (Date.now() - this.queueStartedAt)) / 1000));
      console.log(`[Mineflayer:${this.username}] ⚠️ Navbat ketyapti (${remaining}s qoldi). Velocity kick oldini olish uchun xabar bloklandi: "${message}"`);
      return false;
    }

    const lower = message.toLowerCase();
    if (lower.startsWith('/home') || lower.startsWith('/spawn') || lower.startsWith('/warp')) {
      this.targetLocation = lower.startsWith('/home') ? 'home' : (lower.startsWith('/spawn') ? 'spawn' : 'warp');
      this.isAfk = false;
      this.status = `at_${this.targetLocation}`;
      if (this.antiKickInterval) {
        clearInterval(this.antiKickInterval);
        this.antiKickInterval = null;
      }
      console.log(`[Mineflayer:${this.username}] Maxsus manzil rejimi: ${this.targetLocation} (AFK majburlash to'xtatildi)`);
    } else if (lower.startsWith('/afk')) {
      this.targetLocation = 'afk';
    }

    try {
      this.bot.chat(String(message));
      console.log(`[Mineflayer:${this.username}] [CHAT_OUT] ${message}`);
      return true;
    } catch (err) {
      console.error(`[Mineflayer:${this.username}] Chat yuborishda xato: ${err.message}`);
      return false;
    }
  }

  startQueueWait(durationMs = 80000) {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.isQueueWaiting = true;
    this.queueStartedAt = Date.now();
    this.queueDurationMs = durationMs;
    this.status = 'in_queue';
    this.currentServer = 'lobby';
    console.log(`[Mineflayer:${this.username}] ⏳ Velocity navbatga qo'yildi (${Math.round(durationMs / 1000)}s kutish). Kick bo'lmasligi uchun xabar yuborish to'xtatildi.`);

    this.queueTimer = setTimeout(() => {
      this.isQueueWaiting = false;
      this.queueTimer = null;
      console.log(`[Mineflayer:${this.username}] ⏰ 80 soniyalik navbat vaqti tugadi. Economy va AFK holatiga o'tilmoqda...`);

      this.currentServer = config.MC_SUBSERVER;
      if (this.targetLocation === 'afk' && !this.isAfk) {
        console.log(`[Mineflayer:${this.username}] /afk buyrug'i yuborilmoqda...`);
        this.safeChat('/afk', true);
        this.isAfk = true;
        this.status = 'afk_active';
        this.safeStartAfkMovement();
        this.startShardChecker();
      } else if (this.targetLocation === 'home') {
        this.safeChat('/home 1', true);
      }
    }, durationMs);
  }

  recoverToLobby() {
    console.log(`[Mineflayer:${this.username}] 🔄 Adashgan holatdan (Practice/KitPvP) Lobby ga qayta ulanish boshlandi...`);
    this.cleanup();
    this.scheduleReconnect(3000);
  }

  recoverAfk() {
    if (this.manualStopped) {
      this.manualStopped = false;
    }
    if (!this.bot || this.status === 'stopped' || this.status === 'disconnected' || this.status === 'kicked') {
      this.start();
      return { success: true, message: 'Bot ishga tushirildi va Lobby -> 80s Queue -> AFK zanjiri boshlandi' };
    }

    // 1. Agar bot allaqachon Economy'da va AFK faol bo'lsa
    if (this.currentServer === config.MC_SUBSERVER && this.isAfk && this.status === 'afk_active') {
      this.safeChat('/afk', true);
      return { success: true, message: 'Bot allaqachon Economy AFK hovuzida, /afk qayta tasdiqlandi' };
    }

    // 2. Agar navbatda turgan bo'lsa
    if (this.isQueueWaiting) {
      const rem = Math.max(0, Math.ceil((this.queueDurationMs - (Date.now() - this.queueStartedAt)) / 1000));
      return { success: true, message: `Bot hozir Velocity navbatida turibdi (${rem}s qoldi). Iltimos kuting.` };
    }

    // 3. Agar bot Lobby'da bo'lsa
    if (this.currentServer === 'lobby' || this.currentServer === 'hub') {
      console.log(`[Mineflayer:${this.username}] [RECOVER] Lobby dan ${config.MC_SUBSERVER} navbatiga kirish boshlandi...`);
      this.safeChat(`/server ${config.MC_SUBSERVER}`, true);
      this.startQueueWait(80000);
      return { success: true, message: `Lobby dan ${config.MC_SUBSERVER} ga o'tish yuborildi. 80 soniya navbat kutilmoqda.` };
    }

    // 4. Agar boshqa serverda bo'lsa
    console.log(`[Mineflayer:${this.username}] [RECOVER] Server: ${this.currentServer}. Lobby orqali qayta tiklanmoqda...`);
    this.recoverToLobby();
    return { success: true, message: 'Kutilmagan serverdan Lobby ga qayta ulanilmoqda' };
  }

  startShardChecker() {
    if (this.shardCheckInterval) return;
    this.shardCheckInterval = setInterval(() => {
      if (!this.bot || this.manualStopped || !this.isAfk || this.status !== 'afk_active') return;

      // Har 5 daqiqada (300 soniya) AFK hovuzida +10 shard beriladi
      if (this.supervisor && this.supervisor.shardTracker) {
        const newTotal = this.supervisor.shardTracker.addShards(10, 'afk_pool');
        console.log(`[ShardTracker] 💎 +10 Shards (AFK Hovuzida 5 daqiqa). Jami: ${this.supervisor.shardTracker.formatCount(newTotal)} Shard`);
      }

      // Har 15 daqiqada bir marta serverdan aniq balansni so'rash
      const now = Date.now();
      if (now - this.lastShardCheck > 15 * 60 * 1000) {
        this.lastShardCheck = now;
        console.log(`[ShardTracker] Serverdan /shards balansi tekshirilmoqda...`);
        this.safeChat('/shards', true);
      }
    }, 300000); // Har 5 daqiqa
  }

  safeStartAfkMovement() {
    if (this.antiKickInterval) return;
    this.antiKickInterval = setInterval(() => {
      if (!this.bot || !this.bot.entity || !this.isAfk) return;
      try {
        const yaw = (Math.random() - 0.5) * Math.PI;
        const pitch = (Math.random() - 0.5) * 0.4;
        this.bot.look(yaw, pitch, true, () => {});

        if (Math.random() > 0.6) {
          this.bot.setControlState('jump', true);
          this.safeTimeout(() => {
            if (this.bot) this.bot.setControlState('jump', false);
          }, 350);
        }
      } catch (_) {}
    }, 45000); // Har 45 soniyada yengil harakat
  }

  startWatchdog() {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    this.watchdogInterval = setInterval(() => {
      if (!this.bot || this.manualStopped || this.isCaptchaPending) return;

      // 1. Agar bot Velocity navbatida bo'lsa, mutlaqo tegilmaydi!
      if (this.isQueueWaiting || this.status === 'in_queue') {
        const rem = Math.max(0, Math.ceil((this.queueDurationMs - (Date.now() - this.queueStartedAt)) / 1000));
        console.log(`[Watchdog:${this.username}] Velocity navbat kutilmoqda (${rem}s qoldi). Hech qanday buyruq yuborilmaydi.`);
        return;
      }

      // 2. Agar bot 'home' rejimida bo'lsa
      if (this.targetLocation === 'home') {
        if (this.currentServer === config.MC_SUBSERVER && this.status !== 'at_home') {
          console.log(`[Watchdog:${this.username}] Bot home rejimida, /home 1 qayta tekshirilmoqda...`);
          this.safeChat('/home 1', true);
          this.status = 'at_home';
        }
        return;
      }

      // 3. Agar bot Lobby'da qolib ketgan bo'lsa
      if (this.currentServer === 'lobby' || this.currentServer === 'hub') {
        console.log(`[Watchdog:${this.username}] Bot Lobby'da turibdi. /server ${config.MC_SUBSERVER} yuborilmoqda va 80s navbat kutiladi...`);
        this.safeChat(`/server ${config.MC_SUBSERVER}`, true);
        this.startQueueWait(80000);
        return;
      }

      // 4. Agar bot Economy serverda bo'lsa, lekin AFK rejimida bo'lmasa
      if (this.currentServer === config.MC_SUBSERVER && (this.status !== 'afk_active' || !this.isAfk)) {
        console.log(`[Watchdog:${this.username}] Bot Economy serverda, lekin AFK emas (${this.status}). /afk yuborilmoqda...`);
        this.safeChat('/afk', true);
        this.isAfk = true;
        this.status = 'afk_active';
        this.safeStartAfkMovement();
        this.startShardChecker();
      }
    }, 60000); // Har 60 soniyada holatni nazorat qiladi
  }

  handleMapCaptcha(data) {
    try {
      if (!data || !data.data) return;
      const cols = data.columns || 0;
      const rows = data.rows || 0;
      const x = data.x || 0;
      const y = data.y || 0;
      const buf = data.data;
      const len = buf ? buf.length : 0;
      console.log(`[Mineflayer:${this.username}] [MAP_PACKET] mapId:${data.mapId} x:${x} y:${y} cols:${cols} rows:${rows} len:${len}`);
      if (!buf || len === 0 || cols === 0 || rows === 0) return;

      if (this.supervisor) {
        this.supervisor.lastRawMap = buf;
        this.supervisor.lastMapMeta = { mapId: data.mapId, x, y, cols, rows, len };
      }
      const mapHash = crypto.createHash('md5').update(buf).digest('hex');
      const now = Date.now();

      if ((this.lastSolvedMapHash === mapHash && (now - this.lastSolvedMapTime < 60000)) || (now - this.lastMapProcessTime < 5000)) {
        return;
      }
      this.lastMapProcessTime = now;
      this.isCaptchaPending = true;
      this.lastCaptchaTime = now;

      this.lastCaptchaPng = createMapPng(cols, rows, buf, 2);
      console.log(`[Mineflayer:${this.username}] [MAP_CAPTCHA] 256x256 PNG yaratildi (${this.lastCaptchaPng ? this.lastCaptchaPng.length : 0} bayt). Veb panelda jonli ko'rinadi: /api/captcha.png`);

      solveMapWithOcr(this.lastCaptchaPng).then((ocrCode) => {
        if (ocrCode && ocrCode.length >= 3 && ocrCode.length <= 6) {
          console.log(`[Mineflayer:${this.username}] [MAP_OCR_SUCCESS] OCR orqali captcha kodi aniqlandi: "${ocrCode}"`);
          this.safeTimeout(() => {
            if (this.isCaptchaPending) {
              this.lastSubmittedCaptcha = ocrCode;
              this.lastSubmittedCaptchaTime = Date.now();
              this.lastSolvedMapHash = mapHash;
              this.lastSolvedMapTime = Date.now();
              console.log(`[Mineflayer:${this.username}] Captcha kodi yuborilmoqda: "${ocrCode}"`);
              this.safeChat(ocrCode);
            }
          }, 1200);
        } else {
          console.log(`[Mineflayer:${this.username}] [MAP_OCR_PENDING] Captcha kodi veb interfeys orqali kiritilishi mumkin: ${config.SERVER_PUBLIC_URL}`);
        }
      }).catch(err => {
        console.error(`[Mineflayer:${this.username}] OCR tahlilida xato: ${err.message}`);
      });
    } catch (err) {
      console.error(`[Mineflayer:${this.username}] Map Captcha tahlilida xato: ${err.message}`);
    }
  }

  start() {
    if (this.manualStopped) {
      console.log(`[Supervisor:${this.username}] Bot qo'lda to'xtatilgan (manual_stopped).`);
      return;
    }

    if (this.bot) {
      this.cleanup();
    }

    this.currentServer = 'lobby';
    this.isAfk = false;
    this.hasLoggedIn = false;
    this.status = 'connecting';
    this.startedAt = Date.now();
    console.log(`[Mineflayer:${this.username}] Minecraft serverga ulanish: ${config.MC_HOST}:${config.MC_PORT}`);

    const botOptions = {
      host: config.MC_HOST,
      port: config.MC_PORT,
      username: this.username,
      version: config.MC_VERSION || false,
      auth: 'offline',
      checkTimeoutInterval: 120000,
      keepAlive: true,
      hideErrors: true
    };

    try {
      this.bot = mineflayer.createBot(botOptions);
      this.setupEvents();
    } catch (err) {
      console.error(`[Mineflayer:${this.username}] Bot yaratishda xato: ${err.message}`);
      this.scheduleReconnect(30000);
    }
  }

  setupEvents() {
    const bot = this.bot;

    bot.once('spawn', () => {
      console.log(`[Mineflayer:${this.username}] Muvaffaqiyatli serverga ulandi! (Server: ${this.currentServer})`);
      this.status = 'logged_in';
      this.currentServer = 'lobby';
      this.startWatchdog();

      this.safeTimeout(() => {
        if (!this.hasLoggedIn && this.password) {
          console.log(`[Mineflayer:${this.username}] /login buyrug'i yuborilmoqda...`);
          this.safeChat(`/login ${this.password}`, true);
          this.hasLoggedIn = true;
        }

        this.safeTimeout(() => {
          if (config.MC_SUBSERVER) {
            console.log(`[Mineflayer:${this.username}] Lobby dan ${config.MC_SUBSERVER} ga o'tish (/server ${config.MC_SUBSERVER})...`);
            this.safeChat(`/server ${config.MC_SUBSERVER}`, true);
            this.startQueueWait(80000);
          }
        }, 3000);
      }, 2000);
    });

    bot.on('respawn', () => {
      console.log(`[Mineflayer:${this.username}] Server yoki dunyo almashdi (respawn).`);
      if (this.isQueueWaiting) {
        if (this.queueTimer) {
          clearTimeout(this.queueTimer);
          this.queueTimer = null;
        }
        this.isQueueWaiting = false;
      }
      this.currentServer = config.MC_SUBSERVER;
      this.safeTimeout(() => {
        if (this.targetLocation === 'home') {
          console.log(`[Mineflayer:${this.username}] Bot home rejimida, AFK ga o'tilmaydi.`);
          this.status = 'at_home';
          this.isAfk = false;
        } else if (!this.isAfk) {
          console.log(`[Mineflayer:${this.username}] /afk rejimiga o'tilmoqda...`);
          this.safeChat('/afk', true);
          this.isAfk = true;
          this.status = 'afk_active';
          this.safeStartAfkMovement();
          this.startShardChecker();
        }
      }, 3500);
    });

    const handleOwnerCommand = (sender, text) => {
      const uLower = (sender || '').toLowerCase();
      const isOwner = (config.MC_OWNERS || []).some(o => uLower.includes(o) || o.includes(uLower));
      if (!isOwner) return false;

      const mLower = (text || '').trim().toLowerCase();
      if (['!tpa', 'tpa', '/tpa', '!tp', 'tp', '/tp', '!come', 'kel'].includes(mLower)) {
        console.log(`[Mineflayer:${this.username}] [OWNER_CMD] ${sender} dan TPA chaqiruvi, /tpa ${sender} yuborilmoqda...`);
        this.safeChat(`/tpa ${sender}`);
        return true;
      } else if (['!tpaccept', 'tpaccept', 'qabul'].includes(mLower)) {
        console.log(`[Mineflayer:${this.username}] [OWNER_CMD] /tpaccept yuborilmoqda...`);
        this.safeChat('/tpaccept');
        return true;
      } else if (mLower === '!afk') {
        console.log(`[Mineflayer:${this.username}] [OWNER_CMD] /afk yuborilmoqda...`);
        this.safeChat('/afk');
        return true;
      }
      return false;
    };

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.lastMessage = `${username}: ${message}`;
      console.log(`[Mineflayer:${this.username}] [CHAT] <${username}> ${message}`);
      handleOwnerCommand(username, message);
    });

    bot.on('whisper', (username, message) => {
      if (username === bot.username) return;
      this.lastMessage = `${username} (whisper): ${message}`;
      console.log(`[Mineflayer:${this.username}] [WHISPER] <${username}> ${message}`);
      handleOwnerCommand(username, message);
    });

    bot.on('messagestr', (message) => {
      const clean = (message || '').trim();
      if (!clean) return;
      this.lastMessage = clean;
      console.log(`[Mineflayer:${this.username}] [MSG] ${clean}`);

      // Shard xabarlarini tahlil qilish
      if (this.supervisor && this.supervisor.shardTracker) {
        this.supervisor.shardTracker.parseChat(clean);
      }

      const lower = clean.toLowerCase();

      // Practice / KitPvP / Fallback ga tushib qolganini aniqlash:
      const isPracticeOrDead = lower.includes('has been killed by') ||
                               lower.includes('kitpvp') ||
                               lower.includes('connected to practice') ||
                               lower.includes('joined practice') ||
                               lower.includes('[practice]') ||
                               lower.includes('fallen into the void') ||
                               (lower.includes('practice') && lower.includes('server'));
      if (isPracticeOrDead) {
        console.log(`[Mineflayer:${this.username}] 🚨 Practice/KitPvP serveri aniqlandi! Zudlik bilan Lobby ga qayta ulanilmoqda...`);
        this.recoverToLobby();
        return;
      }

      // TPA so'rovlarini egadan kelganda avtomatik qabul qilish (Auto-TPACCEPT)
      const hasTpaPrompt = lower.includes('sent you a tpa request') || lower.includes('has requested') || lower.includes('teleport to you') || lower.includes('/tpaccept') || lower.includes('tpa');
      if (hasTpaPrompt) {
        const isOwner = (config.MC_OWNERS || []).some(o => lower.includes(o)) || lower.includes('fingoxen');
        if (isOwner) {
          console.log(`[Mineflayer:${this.username}] [AUTO-TPA] Egadan TPA so'rovi aniqlandi! /tpaccept qilinmoqda...`);
          const tpMatch = clean.match(/\/tpaccept\s+([a-zA-Z0-9_]+)/i);
          const targetPlayer = tpMatch ? tpMatch[1] : 'Fingoxenpro';
          this.safeTimeout(() => {
            this.safeChat(`/tpaccept ${targetPlayer}`, true);
            this.safeChat('/tpaccept', true);
          }, 500);
        }
      }

      // Egadan kelgan barcha chat va buyruqlarni o'qish (Global chat, whisper, PM, rankli formatlar)
      const isOwnerMsg = (config.MC_OWNERS || []).some(o => lower.includes(o)) || lower.includes('fingoxen');
      if (isOwnerMsg) {
        // Chat formatlari: "Fingoxenpro: !tp", "[VIP] Fingoxenpro: kel", "Fingoxenpro » !tp", "Fingoxenpro -> me: !tp"
        const chatMatch = clean.match(/^(?:\[[^\]]+\]\s*)?([a-zA-Z0-9_]{3,16})\s*(?::|»|>|->\s*(?:me|gotto):?)\s*(.+)$/i);
        if (chatMatch) {
          const sender = chatMatch[1];
          const text = chatMatch[2].trim();
          handleOwnerCommand(sender, text);
        } else {
          // Xabar matnida egasi va buyruq so'zi bo'lsa (masalan: kel, !tp, !tpa, !afk)
          const cmdMatch = clean.match(/(!tp|!tpa|!tpaccept|!afk|\bkel\b|\bqabul\b)/i);
          if (cmdMatch) {
            handleOwnerCommand('Fingoxenpro', cmdMatch[1]);
          }
        }
      }

      // Home ga yetib kelganini aniqlash
      if (lower.includes('teleported to your home') || lower.includes('homes • teleported')) {
        this.status = 'at_home';
        this.isAfk = false;
        this.targetLocation = 'home';
        console.log(`[Mineflayer:${this.username}] Bot muvaffaqiyatli /home 1 ga keldi! Fingoxenpro xabardor qilinmoqda...`);
        this.safeTimeout(() => {
          this.safeChat('/msg Fingoxenpro Men /home 1 daman, /tpa Gotto deb yozing!', true);
        }, 1200);
      }

      // Fingoxenpro serverga kirganida chaqirish
      if (lower.includes('fingoxenpro') && (lower.includes('joined') || lower.includes('has joined'))) {
        console.log(`[Mineflayer:${this.username}] Fingoxenpro serverga kirdi!`);
        if (this.targetLocation === 'home' || this.status === 'at_home') {
          this.safeTimeout(() => {
            this.safeChat('/msg Fingoxenpro Men /home 1 daman, /tpa Gotto deb yozing!', true);
          }, 2000);
        }
      }

      // Captcha yechilganini aniqlash
      if (lower.includes('solved') || lower.includes('welcome') || lower.includes('sending you to') || lower.includes('successfully') || lower.includes('logged in')) {
        this.isCaptchaPending = false;
      }

      // AFK hududiga tushganini aniqlash
      if (lower.includes('teleported to the afk area') || lower.includes('afk area') || lower.includes('you are now afk')) {
        this.isAfk = true;
        this.currentServer = config.MC_SUBSERVER;
        this.status = 'afk_active';
        this.safeStartAfkMovement();
        this.startShardChecker();
        console.log(`[Mineflayer:${this.username}] Bot rasman AFK hududida (afk_active)!`);
      }

      // Economy serverga tushganini aniqlash
      const sub = (config.MC_SUBSERVER || 'economy').toLowerCase();
      if (lower.includes(`sending you to ${sub}`) || lower.includes(`connected to ${sub}`) || lower.includes(`joined ${sub}`) || lower.includes(`[${sub}]`)) {
        if (this.isQueueWaiting) {
          if (this.queueTimer) {
            clearTimeout(this.queueTimer);
            this.queueTimer = null;
          }
          this.isQueueWaiting = false;
        }
        this.currentServer = config.MC_SUBSERVER;
        this.status = 'in_economy';
        console.log(`[Mineflayer:${this.username}] ${config.MC_SUBSERVER} serveriga muvaffaqiyatli o'tildi!`);

        this.safeTimeout(() => {
          if (!this.isAfk && this.targetLocation === 'afk') {
            console.log(`[Mineflayer:${this.username}] /afk rejimiga o'tilmoqda...`);
            this.safeChat('/afk', true);
            this.isAfk = true;
            this.status = 'afk_active';
            this.safeStartAfkMovement();
            this.startShardChecker();
          } else if (this.targetLocation === 'home') {
            console.log(`[Mineflayer:${this.username}] Home 1 ga o'tilmoqda...`);
            this.safeChat('/home 1', true);
          }
        }, 3000);
      }

      // Agar lobbiyda ekanligi aniqlansa
      if (lower.includes('connected to lobby') || lower.includes('connected to hub') || lower.includes('joined lobby')) {
        this.currentServer = 'lobby';
        this.isAfk = false;
        if (!this.isQueueWaiting) {
          console.log(`[Mineflayer:${this.username}] Lobbiyda ekanligi aniqlandi. ${config.MC_SUBSERVER} ga o'tish yuborilmoqda va 80s navbat kutiladi...`);
          this.safeTimeout(() => {
            this.safeChat(`/server ${config.MC_SUBSERVER}`, true);
            this.startQueueWait(80000);
          }, 1500);
        }
      }

      // Ro'yxatdan o'tish so'ralsa
      if (lower.includes('/register') || lower.includes('royxat')) {
        this.safeTimeout(() => {
          if (this.password) {
            console.log(`[Mineflayer:${this.username}] /register buyrug'i yuborilmoqda...`);
            this.safeChat(`/register ${this.password} ${this.password}`, true);
            this.hasLoggedIn = true;
          }
        }, 1200);
      }
      // Parol so'ralsa
      else if (lower.includes('/login') || lower.includes('parol')) {
        this.safeTimeout(() => {
          if (this.password) {
            this.safeChat(`/login ${this.password}`, true);
            this.hasLoggedIn = true;
          }
        }, 1200);
      }
    });

    // Xom paketlarni (Map Captcha & Title) kuzatish
    bot._client.on('packet', (data, meta) => {
      const name = meta ? meta.name : '';

      if (['title', 'set_title_text', 'set_title_subtitle', 'set_action_bar_text'].includes(name)) {
        const text = extractCleanText(data);
        if (text && text.length > 0 && !text.includes('{"type"')) {
          console.log(`[Mineflayer:${this.username}] [TITLE] ${text}`);
        }
      }

      // Map Captcha
      if (name === 'map' && data) {
        this.handleMapCaptcha(data);
      }

      // Set slot (Map berilsa qo'lga olish)
      if (name === 'set_slot' && data && data.item) {
        const itemId = data.item.itemId || data.item.id;
        if (itemId === 982 || (data.item.name && data.item.name.includes('map'))) {
          try {
            if (bot.setQuickBarSlot) bot.setQuickBarSlot(0);
            this.safeTimeout(() => {
              if (bot.activateItem) bot.activateItem();
            }, 800);
          } catch (_) {}
        }
      }
    });

    bot.on('health', () => {
      this.health = bot.health;
      this.food = bot.food;
    });

    bot.on('kicked', (reason) => {
      let rText = typeof reason === 'string' ? reason : JSON.stringify(reason);
      console.log(`[Mineflayer:${this.username}] 🚨 KICK: Serverdan chiqarildi! (${rText})`);
      this.status = 'kicked';
      this.cleanup();
      this.scheduleReconnect(12000);
    });

    bot.on('end', (reason) => {
      console.log(`[Mineflayer:${this.username}] Aloqa uzildi (${reason || 'end'}).`);
      this.status = 'disconnected';
      this.cleanup();
      this.scheduleReconnect(15000);
    });

    bot.on('error', (err) => {
      console.error(`[Mineflayer:${this.username}] Bot xatosi: ${err.message}`);
      if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].some(code => err.message.includes(code))) {
        this.cleanup();
        this.scheduleReconnect(20000);
      }
    });
  }

  cleanup() {
    this.clearAllTimers();
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    this.isQueueWaiting = false;
    this.queueStartedAt = null;
    if (this.shardCheckInterval) {
      clearInterval(this.shardCheckInterval);
      this.shardCheckInterval = null;
    }
    if (this.bot) {
      try {
        this.bot.removeAllListeners();
        if (this.bot._client) this.bot._client.removeAllListeners();
        this.bot.quit();
      } catch (_) {}
      this.bot = null;
    }
    this.currentServer = 'lobby';
    this.isAfk = false;
    this.hasLoggedIn = false;
    this.isCaptchaPending = false;
  }

  scheduleReconnect(delayMs = 15000) {
    if (this.manualStopped || this.reconnectTimer) return;
    this.status = 'reconnecting';
    console.log(`[Supervisor:${this.username}] ${delayMs / 1000} soniyadan so'ng avtomatik qayta ulaniladi...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualStopped) {
        this.start();
      }
    }, delayMs);
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.manualStopped = true;
    this.cleanup();
    this.status = 'stopped';
    console.log(`[Mineflayer:${this.username}] Bot to'xtatildi.`);
  }
}

class Minecraft247Bot {
  constructor() {
    this.accounts = config.BOT_ACCOUNTS || [
      { username: config.MC_USERNAME || 'Gotto', password: config.MC_PASSWORD || 'bunyod' }
    ];
    this.bots = this.accounts.map(acc => new SingleBotInstance(acc, this));
    this.primaryBot = this.bots[0];

    // 4x Vote Tracker
    this.tracker = new VoteTracker();

    // Shard Tracker (Doimiy AFK shard monitoring)
    this.shardTracker = new ShardTracker();

    // Veb Server
    this.webServer = new WebServer(
      config.PORT,
      config.HOST,
      () => this.getSystemStatus(),
      (path, payload) => this.handleWebAction(path, payload),
      this
    );
  }

  // Backward compatibility getters
  get bot() { return this.primaryBot.bot; }
  get status() { return this.primaryBot.status; }
  get currentServer() { return this.primaryBot.currentServer; }
  get isAfk() { return this.primaryBot.isAfk; }
  get health() { return this.primaryBot.health; }
  get food() { return this.primaryBot.food; }
  get startedAt() { return this.primaryBot.startedAt; }
  get lastMessage() { return this.primaryBot.lastMessage; }
  get manualStopped() { return this.primaryBot.manualStopped; }
  get isCaptchaPending() { return this.bots.some(b => b.isCaptchaPending); }
  get lastCaptchaPng() {
    const pendingBot = this.bots.find(b => b.isCaptchaPending && b.lastCaptchaPng);
    return pendingBot ? pendingBot.lastCaptchaPng : this.primaryBot.lastCaptchaPng;
  }
  get lastCaptchaTime() {
    const pendingBot = this.bots.find(b => b.isCaptchaPending && b.lastCaptchaPng);
    return pendingBot ? pendingBot.lastCaptchaTime : this.primaryBot.lastCaptchaTime;
  }

  getSystemStatus() {
    return {
      bot: this.primaryBot.getSummary(),
      bots: this.bots.map(b => b.getSummary()),
      shards: this.shardTracker.getSummary(),
      vote: this.tracker.getSummary(),
      config: {
        host: config.MC_HOST,
        port: config.MC_PORT,
        username: config.MC_USERNAME,
        subserver: config.MC_SUBSERVER,
        version: config.MC_VERSION
      }
    };
  }

  safeChat(message, targetBotName = null) {
    let success = false;
    for (const b of this.bots) {
      if (!targetBotName || targetBotName === 'all' || b.username.toLowerCase() === targetBotName.toLowerCase()) {
        const ok = b.safeChat(message);
        if (ok) success = true;
      }
    }
    return success;
  }

  recoverAfk(targetBotName = 'all') {
    let lastRes = null;
    for (const b of this.bots) {
      if (!targetBotName || targetBotName === 'all' || b.username.toLowerCase() === targetBotName.toLowerCase()) {
        lastRes = b.recoverAfk();
      }
    }
    return lastRes || { success: true, message: 'AFK tiklash harakati yuborildi' };
  }

  handleWebAction(actionPath, payload) {
    if (actionPath === '/api/bot/start') {
      const target = payload && payload.bot ? String(payload.bot) : 'all';
      this.startBot(target);
      return { success: true, message: `Bot(${target}) ishga tushirildi` };
    }

    if (actionPath === '/api/bot/stop') {
      const target = payload && payload.bot ? String(payload.bot) : 'all';
      this.stopBot(target);
      return { success: true, message: `Bot(${target}) to'xtatildi` };
    }

    if (actionPath === '/api/bot/recover_afk') {
      const target = payload && payload.bot ? String(payload.bot) : 'all';
      const res = this.recoverAfk(target);
      return res;
    }

    if (actionPath === '/api/shards/check') {
      const ok = this.safeChat('/shards', 'all');
      return { success: ok, message: ok ? 'Serverga /shards tekshirish buyrug\'i yuborildi' : 'Bot faol emas' };
    }

    if (actionPath === '/api/shards/add') {
      const amount = (payload && payload.amount) ? parseInt(payload.amount, 10) : 10;
      const total = this.shardTracker.addShards(amount, 'manual_web');
      return { success: true, message: `+${amount} Shards qo'shildi. Jami: ${this.shardTracker.formatCount(total)}`, total };
    }

    if (actionPath === '/api/captcha/solve') {
      const code = (payload && payload.code) ? String(payload.code).trim() : '';
      if (!code) return { success: false, message: 'Kod kiritilmagan' };

      const targetName = payload && payload.bot ? String(payload.bot) : null;
      let targetBot = targetName ? this.bots.find(b => b.username.toLowerCase() === targetName.toLowerCase()) : null;
      if (!targetBot) {
        targetBot = this.bots.find(b => b.isCaptchaPending) || this.primaryBot;
      }

      console.log(`[Mineflayer:${targetBot.username}] Veb panel orqali captcha kodi kiritildi: "${code}"`);
      const ok = targetBot.safeChat(code, true);
      targetBot.isCaptchaPending = false;
      return { success: ok, message: ok ? `Kod (${targetBot.username}) yuborildi: ${code}` : 'Bot faol emas' };
    }

    if (actionPath === '/api/bot/chat') {
      const text = (payload && payload.text) ? String(payload.text).trim() : '';
      if (!text) return { success: false, message: 'Xabar bo\'sh bo\'lishi mumkin emas' };
      const target = payload && payload.bot ? String(payload.bot) : 'all';
      const ok = this.safeChat(text, target);
      return { success: ok, message: ok ? `Xabar yuborildi: ${text}` : 'Bot(lar) faol emas yoki navbatda' };
    }

    if (actionPath === '/api/vote/record') {
      const slotId = (payload && payload.vote_id) ? payload.vote_id : 1;
      this.tracker.recordVote(slotId);
      return { success: true, message: `Vote #${slotId} uchun ovoz berildi deb qayd etildi` };
    }

    if (actionPath === '/api/vote/set_url') {
      const slotId = (payload && payload.vote_id) ? payload.vote_id : 1;
      const url = (payload && payload.url) ? payload.url : '';
      const name = payload ? payload.name : null;
      this.tracker.setVoteUrl(slotId, url, name);
      return { success: true, message: `Vote #${slotId} havolasi yangilandi` };
    }

    return { success: false, message: `Noma'lum buyruq: ${actionPath}` };
  }

  startBot(targetName = 'all') {
    let delay = 0;
    for (const b of this.bots) {
      if (targetName === 'all' || b.username.toLowerCase() === targetName.toLowerCase()) {
        b.manualStopped = false;
        setTimeout(() => {
          b.start();
        }, delay);
        delay += 8000; // Har bir bot orasida 8 soniya farq
      }
    }
  }

  stopBot(targetName = 'all') {
    for (const b of this.bots) {
      if (targetName === 'all' || b.username.toLowerCase() === targetName.toLowerCase()) {
        b.stop();
      }
    }
  }

  start() {
    console.log('='.repeat(60));
    console.log('🚀 MINECRAFT 24/7 MULTI-BOT SUPERVISOR (NODE.JS)');
    console.log(`• Minecraft Server: ${config.MC_HOST}:${config.MC_PORT}`);
    console.log(`• Subserver: ${config.MC_SUBSERVER}`);
    console.log(`• Botlar soni: ${this.bots.length} (${this.bots.map(b => b.username).join(', ')})`);
    console.log(`• Veb Dashboard Porti: ${config.PORT}`);
    console.log('='.repeat(60));

    // 1. Veb Server
    this.webServer.start();

    // 2. Render Keep-Alive (anti-sleep)
    if (config.ENABLE_KEEP_ALIVE) {
      this.webServer.startKeepAlive(config.SERVER_PUBLIC_URL, config.KEEP_ALIVE_INTERVAL);
    }

    // 3. Ovoz Berish (Vote) eslatma sikli (faqat manzili bor serverlar uchun)
    setInterval(() => {
      for (const v of this.tracker.getAllVotes()) {
        const rawSlot = this.tracker.state.votes && this.tracker.state.votes[String(v.id)];
        if (v.url && v.url.trim() && this.tracker.isTimeToVote(v.id) && rawSlot && !rawSlot.alert_sent) {
          console.log(`[VoteTracker] 🗳 DIQQAT: ${v.name} saytida ovoz berish vaqti keldi! (${v.url})`);
          rawSlot.alert_sent = true;
          this.tracker.saveState();
        }
      }
    }, 60000);

    // 4. Avtomatik botlarni ishga tushirish
    if (config.AUTO_AFK_ON_BOOT) {
      this.startBot();
    }
  }

  stop() {
    console.log('[System] Tizim to\'xtatilmoqda...');
    this.stopBot('all');
    this.webServer.stop();
  }
}

const botInstance = new Minecraft247Bot();

process.on('SIGINT', () => {
  console.log('\n[Signal] SIGINT qabul qilindi.');
  botInstance.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Signal] SIGTERM qabul qilindi.');
  botInstance.stop();
  process.exit(0);
});

if (require.main === module) {
  botInstance.start();
}

Minecraft247Bot.extractCleanText = extractCleanText;
Minecraft247Bot.normalizeCommand = normalizeCommand;

module.exports = Minecraft247Bot;
