/**
 * Minecraft 24/7 Multi-Bot Supervisor powered by Mineflayer (Pure Node.js)
 * Architecture:
 * - 11-State Finite State Machine (core/stateManager.js)
 * - Session ID & Stale Timer Invalidation (core/sessionManager.js)
 * - Priority Command Queue with Velocity Proxy Queue-Lock (core/commandQueue.js)
 * - Unified Chat, Ranks, Deduplication, TPA & Owner Auth (managers/chatManager.js)
 * - Exponential Backoff Reconnect & Practice/KitPvP Fallback (managers/recoveryManager.js)
 * - AFK Pool Verification, Shard Stall Monitor & Gentle Anti-Kick (managers/afkManager.js)
 * - Real-Time Dashboard UI with Progress Bar, Shards & Web Actions (webServer.js)
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

// Core modullar
const { StateManager, BOT_STATES, SERVER_STATES, CONNECTION_STATES, AFK_STATES } = require('./core/stateManager');
const SessionManager = require('./core/sessionManager');
const { CommandQueue, PRIORITY } = require('./core/commandQueue');

// Menejerlar
const ChatManager = require('./managers/chatManager');
const RecoveryManager = require('./managers/recoveryManager');
const AfkManager = require('./managers/afkManager');

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

  if (/^\/cmd\s+/i.test(str)) {
    str = str.replace(/^\/cmd\s+/i, '').trim();
  } else if (/^\/cmd$/i.test(str)) {
    return '';
  }

  if (/^\/say\s+/i.test(str)) {
    str = str.replace(/^\/say\s+/i, '').trim();
  }

  if (/^(home(\s+\d+)?|spawn|afk|tpaccept|tpa(\s+.*)?|balance|pay(\s+.*)?|sethome(\s+.*)?)$/i.test(str)) {
    if (!str.startsWith('/')) {
      str = '/' + str;
    }
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
    this.health = 20;
    this.food = 20;
    this.startedAt = null;
    this.lastMessage = '';
    this.manualStopped = false;
    this.targetLocation = 'afk'; // 'afk', 'home', 'spawn', 'warp'

    // 1. 11-Holatli State Machine
    this.stateManager = new StateManager(BOT_STATES.STOPPED);

    // 2. Session Manager (Eski taymerlarni yo'q qilish)
    this.sessionManager = new SessionManager();

    // 3. Priority Command Queue (Velocity Queue-lock)
    this.commandQueue = new CommandQueue({
      minIntervalMs: 1500,
      sendFn: (cmd, item) => this.dispatchChat(cmd, item)
    });

    // 4. Chat Manager (Rang kodlari, deduplikatsiya, TPA va egasi autentifikatsiyasi)
    this.chatManager = new ChatManager({
      botUsername: this.username,
      owners: config.MC_OWNERS
    });

    // 5. Recovery Manager (Exponential backoff & Practice fallback)
    this.recoveryManager = new RecoveryManager({
      initialDelayMs: 3000,
      maxDelayMs: 60000,
      backoffFactor: 2.0
    });

    // 6. AFK Manager (AFK verification & gentle anti-kick)
    this.afkManager = new AfkManager({
      stallThresholdMs: 12 * 60 * 1000,
      antiKickIntervalMs: 4 * 60 * 1000
    });

    // Velocity Proxy Navbat parametrlari (orqaga moslik uchun)
    this.isQueueWaiting = false;
    this.queueStartedAt = null;
    this.queueDurationMs = 80000;
    this.queueTimer = null;

    // Captcha & Safety State
    this.hasLoggedIn = false;
    this.isCaptchaPending = false;
    this.lastCaptchaPng = null;
    this.lastSolvedMapHash = null;
    this.lastSolvedMapTime = 0;
    this.lastMapProcessTime = 0;

    this.initEventWiring();
  }

  // Getters for backwards compatibility
  get status() {
    if (this.isQueueWaiting) return 'in_queue';
    const bState = this.stateManager.botState;
    if (bState === BOT_STATES.AFK_ACTIVE) return 'afk_active';
    if (bState === BOT_STATES.STOPPED) return 'stopped';
    if (bState === BOT_STATES.CONNECTING) return 'connecting';
    if (bState === BOT_STATES.AUTHENTICATING) return 'connecting';
    if (bState === BOT_STATES.LOBBY) return 'logged_in';
    if (bState === BOT_STATES.QUEUE_WAIT) return 'in_queue';
    if (bState === BOT_STATES.VERIFYING_ECONOMY) return 'in_economy';
    if (bState === BOT_STATES.RECOVERING) return 'reconnecting';
    return bState.toLowerCase();
  }

  set status(val) {
    // Orqaga moslik uchun setter
    if (val === 'stopped') this.stateManager.setBotState(BOT_STATES.STOPPED);
    else if (val === 'connecting') this.stateManager.setBotState(BOT_STATES.CONNECTING);
    else if (val === 'in_queue') this.stateManager.setBotState(BOT_STATES.QUEUE_WAIT);
    else if (val === 'afk_active') this.stateManager.setBotState(BOT_STATES.AFK_ACTIVE);
    else if (val === 'logged_in') this.stateManager.setBotState(BOT_STATES.LOBBY);
  }

  get currentServer() {
    return this.stateManager.serverState;
  }

  set currentServer(val) {
    this.stateManager.setServerState(val);
  }

  get isAfk() {
    return this.stateManager.afkState === AFK_STATES.ACTIVE;
  }

  set isAfk(val) {
    this.stateManager.setAfkState(val ? AFK_STATES.ACTIVE : AFK_STATES.INACTIVE);
  }

  initEventWiring() {
    // 1. Chat Manager hodisalari
    this.chatManager.on('ownerCommand', (data) => {
      console.log(`[Mineflayer:${this.username}] [OWNER_CMD] ${data.sender} dan buyruq: ${data.command} (${data.raw})`);
      if (data.command === 'afk') {
        this.safeChat('/afk', true);
      } else if (data.command === 'tp' || data.command === 'tpa') {
        const target = data.args[0] || data.sender;
        this.safeChat(`/tpa ${target}`, true);
      } else if (data.command === 'tpaccept') {
        this.safeChat('/tpaccept', true);
      }
    });

    this.chatManager.on('tpaRequest', (data) => {
      if (data.isOwner) {
        console.log(`[Mineflayer:${this.username}] 🛡️ Egasi (${data.sender}) dan TPA so'rovi qabul qilinmoqda: /tpaccept`);
        this.safeChat('/tpaccept', true);
      } else {
        console.log(`[Mineflayer:${this.username}] ⚠️ Begona o'yinchi (${data.sender}) dan TPA so'rovi e'tiborsiz qoldirildi.`);
      }
    });

    this.chatManager.on('practiceSignal', (data) => {
      console.warn(`[Mineflayer:${this.username}] 🚨 Practice/Hub xabari aniqlandi: "${data.clean}"`);
      this.recoveryManager.handlePracticeDetected(this);
    });

    // 2. AFK Manager hodisalari
    this.afkManager.on('shardStallDetected', () => {
      console.warn(`[Mineflayer:${this.username}] ⚠️ AFK hovuzida shard to'xtab qolgan, qayta /afk yuborilmoqda...`);
      this.safeChat('/afk', true);
    });
    this.afkManager.on('requestShardCheck', () => {
      if (this.isAfk && !this.commandQueue.isQueueLocked()) {
        console.log(`[Mineflayer:${this.username}] Avtomatik Shard balansi yangilanmoqda (/shards)...`);
        this.safeChat('/shards', true);
      }
    });

    // 3. Recovery Manager hodisalari
    this.recoveryManager.on('economyVerificationFailed', () => {
      console.warn(`[Mineflayer:${this.username}] ⚠️ Economy serveriga kirish tasdiqlanmadi (timeout). Qayta ulanish boshlanmoqda.`);
      this.reconnect(3000, 'economy_verification_timeout');
    });
  }

  getSummary() {
    const uptimeSec = this.startedAt && this.stateManager.botState !== BOT_STATES.STOPPED
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;

    const fsmState = this.stateManager.getState();
    const sessionStats = this.sessionManager.getSessionStats();
    const queueStatus = this.commandQueue.getStatus();

    return {
      username: this.username,
      status: this.status,
      bot_state: fsmState.botState,
      server_state: fsmState.serverState,
      connection_state: fsmState.connectionState,
      afk_state: fsmState.afkState,
      current_server: fsmState.serverState,
      is_afk: this.isAfk,
      is_queue_waiting: queueStatus.isLocked,
      queue_remaining_seconds: queueStatus.lockRemainingSec,
      queue_duration_ms: this.queueDurationMs,
      session_id: sessionStats.currentSessionId,
      session_uptime_sec: sessionStats.sessionUptimeSec,
      health: this.health,
      food: this.food,
      uptime: uptimeSec,
      target_location: this.targetLocation,
      last_message: this.lastMessage,
      started_at: this.startedAt,
      is_captcha_pending: this.isCaptchaPending,
      reconnect_retry_count: this.recoveryManager.retryCount,
      players: (this.bot && this.bot.players) ? Object.keys(this.bot.players).length : 0,
      nearby_players: (this.bot && this.bot.entities) ? Object.values(this.bot.entities)
        .filter(e => e.type === 'player' && e.username && e.username !== this.username && this.bot.entity && e.position)
        .map(e => ({
          username: e.username,
          distance: Math.round(this.bot.entity.position.distanceTo(e.position))
        })) : []
    };
  }

  dispatchChat(command, item) {
    if (!this.bot || typeof this.bot.chat !== 'function') {
      return;
    }
    try {
      this.bot.chat(command);
      console.log(`[Mineflayer:${this.username}] [CHAT_OUT] ${command}`);
    } catch (err) {
      console.error(`[Mineflayer:${this.username}] Chat yuborishda xatolik:`, err.message);
    }
  }

  safeChat(message, force = false) {
    const raw = String(message || '').trim();
    if (!raw) return false;

    // Velocity Queue blokirovkasi tekshiruvi
    if (this.isQueueWaiting && !force) {
      const rem = this.commandQueue.getLockRemainingSec();
      console.log(`[Mineflayer:${this.username}] ⚠️ Navbat ketyapti (${rem}s qoldi). Velocity kick oldini olish uchun xabar bloklandi: "${raw}"`);
      return false;
    }

    if (this.bot && typeof this.bot.chat === 'function') {
      this.dispatchChat(raw);
      return true;
    }

    const currentSessionId = this.sessionManager.getCurrentSessionId();
    return this.commandQueue.enqueue(raw, {
      priority: force ? PRIORITY.HIGH : PRIORITY.NORMAL,
      force,
      sessionId: currentSessionId
    });
  }

  startQueueWait(durationMs = 80000) {
    this.isQueueWaiting = true;
    this.queueStartedAt = Date.now();
    this.queueDurationMs = durationMs;

    this.stateManager.setBotState(BOT_STATES.QUEUE_WAIT, 'startQueueWait');
    this.commandQueue.setLock(true, durationMs);
    console.log(`[Mineflayer:${this.username}] ⏳ Velocity navbatga qo'yildi (${Math.round(durationMs / 1000)}s kutish). Kick bo'lmasligi uchun xabar yuborish to'xtatildi.`);

    if (this.queueTimer) {
      this.sessionManager.clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }

    const boundSession = this.sessionManager.getCurrentSessionId();
    this.queueTimer = this.sessionManager.setTimeout(() => {
      this.onQueueWaitComplete();
    }, durationMs, boundSession);

    // Economy kirishini tasdiqlash taymeri
    this.recoveryManager.startEconomyVerification();
  }

  onQueueWaitComplete() {
    this.isQueueWaiting = false;
    this.commandQueue.setLock(false);
    this.queueTimer = null;
    console.log(`[Mineflayer:${this.username}] ✅ 80 soniyalik Velocity navbati tugadi. Buyruqlar qulfi ochildi.`);

    if (this.currentServer === config.MC_SUBSERVER) {
      this.stateManager.setBotState(BOT_STATES.ACTIVATING_AFK, 'queue_complete_economy');
      console.log(`[Mineflayer:${this.username}] Economy serverida /afk yuborilmoqda...`);
      this.safeChat('/afk', true);
      this.stateManager.setBotState(BOT_STATES.AFK_ACTIVE);
      this.isAfk = true;
      this.afkManager.startMonitoring();
    } else {
      console.log(`[Mineflayer:${this.username}] Navbat tugadi, lekin bot hali Economy'ga o'tmagan (${this.currentServer}). Tasdiqlash kutilmoqda...`);
      this.stateManager.setBotState(BOT_STATES.VERIFYING_ECONOMY);
    }
  }

  recoverAfk() {
    if (this.manualStopped) {
      this.manualStopped = false;
    }
    if (!this.bot || this.stateManager.botState === BOT_STATES.STOPPED || this.stateManager.botState === BOT_STATES.OFFLINE) {
      this.start();
      return { success: true, message: 'Bot ishga tushirildi va Lobby -> 80s Queue -> AFK zanjiri boshlandi' };
    }

    if (this.currentServer === config.MC_SUBSERVER && this.isAfk && this.stateManager.botState === BOT_STATES.AFK_ACTIVE) {
      this.safeChat('/afk', true);
      return { success: true, message: 'Bot allaqachon Economy AFK hovuzida, /afk qayta tasdiqlandi' };
    }

    if (this.commandQueue.isQueueLocked()) {
      const rem = this.commandQueue.getLockRemainingSec();
      return { success: true, message: `Bot hozir Velocity navbatida turibdi (${rem}s qoldi). Iltimos kuting.` };
    }

    if (this.currentServer === 'lobby') {
      console.log(`[Mineflayer:${this.username}] [AFK_RECOVER] Lobby dan Economy ga o'tish boshlanmoqda...`);
      this.safeChat(`/server ${config.MC_SUBSERVER}`, true);
      this.startQueueWait(80000);
      return { success: true, message: 'Lobby dan Economy navbatiga qo\'yildi (80s kutish)' };
    }

    console.log(`[Mineflayer:${this.username}] [AFK_RECOVER] Server noaniq, qayta toza ulanish amalga oshirilmoqda...`);
    this.reconnect(2000, 'manual_afk_recover');
    return { success: true, message: 'Bot qayta ulanmoqda va avtomatik AFK hovuziga kiradi' };
  }

  handleMapCaptcha(data) {
    try {
      if (!data || !data.data) return;
      const cols = data.columns || 0;
      const rows = data.rows || 0;
      const x = data.x || 0;
      const y = data.y || 0;
      const buf = Buffer.isBuffer(data.data) ? data.data : Buffer.from(data.data);
      const len = buf ? buf.length : 0;
      if (!buf || len === 0 || cols === 0 || rows === 0) return;

      if (this.supervisor) {
        this.supervisor.lastRawMap = buf;
        this.supervisor.lastMapMeta = { mapId: data.mapId, x, y, cols, rows, len };
      }

      const mapHash = crypto.createHash('md5').update(buf).digest('hex');
      const now = Date.now();
      if (this.lastSolvedMapHash === mapHash && (now - this.lastSolvedMapTime < 45000)) {
        return;
      }
      if (now - this.lastMapProcessTime < 3000) {
        return;
      }
      this.lastMapProcessTime = now;

      createMapPng(buf, cols, rows).then(pngBuf => {
        if (!pngBuf) return;
        this.lastCaptchaPng = pngBuf;
        if (this.supervisor) this.supervisor.lastCaptchaPng = pngBuf;

        this.isCaptchaPending = true;
        return solveMapWithOcr(pngBuf);
      }).then(ocrResult => {
        if (!ocrResult || !ocrResult.code) return;
        const code = ocrResult.code;
        console.log(`[Mineflayer:${this.username}] 🎯 OCR Captcha kodini topdi: "${code}"`);
        this.lastSolvedMapHash = mapHash;
        this.lastSolvedMapTime = Date.now();
        this.safeChat(code, true);
        this.isCaptchaPending = false;
      }).catch(err => {
        console.error(`[Mineflayer:${this.username}] Captcha yechishda xato:`, err.message);
      });
    } catch (e) {
      console.error(`[Mineflayer:${this.username}] handleMapCaptcha error:`, e.message);
    }
  }

  start() {
    if (this.manualStopped) {
      console.log(`[Mineflayer:${this.username}] Bot qo'lda to'xtatilgan, start chaqirildi.`);
      this.manualStopped = false;
    }

    if (this.bot) {
      this.cleanup();
    }

    const sessionId = this.sessionManager.startNewSession('bot_start');
    this.currentServer = 'lobby';
    this.isAfk = false;
    this.hasLoggedIn = false;
    this.startedAt = Date.now();

    this.stateManager.setConnectionState(CONNECTION_STATES.CONNECTING);
    this.stateManager.setBotState(BOT_STATES.CONNECTING, 'start');

    console.log(`[Mineflayer:${this.username}] Minecraft serverga ulanish (Session #${sessionId}): ${config.MC_HOST}:${config.MC_PORT}`);

    const botOptions = {
      host: config.MC_HOST,
      port: config.MC_PORT,
      username: this.username,
      version: config.MC_VERSION || '1.21.1',
      checkTimeoutInterval: 90000,
      keepAlive: true,
      hideErrors: true
    };

    try {
      this.bot = mineflayer.createBot(botOptions);
      this.afkManager.setBot(this.bot);
      this.setupEvents(sessionId);
    } catch (err) {
      console.error(`[Mineflayer:${this.username}] Bot yaratishda xato: ${err.message}`);
      this.scheduleReconnect(15000, 'bot_create_error');
    }
  }

  setupEvents(boundSessionId) {
    const bot = this.bot;

    bot.once('spawn', () => {
      if (!this.sessionManager.isSessionValid(boundSessionId)) return;

      console.log(`[Mineflayer:${this.username}] Muvaffaqiyatli serverga ulandi! (Server: ${this.currentServer})`);
      this.stateManager.setConnectionState(CONNECTION_STATES.CONNECTED);
      this.stateManager.setBotState(BOT_STATES.AUTHENTICATING, 'spawn_event');
      this.currentServer = 'lobby';

      // 1. /login buyrug'i (2 soniyadan keyin)
      this.sessionManager.setTimeout(() => {
        if (!this.hasLoggedIn && this.password) {
          console.log(`[Mineflayer:${this.username}] /login buyrug'i yuborilmoqda...`);
          this.safeChat(`/login ${this.password}`, true);
          this.hasLoggedIn = true;
          this.stateManager.setBotState(BOT_STATES.LOBBY, 'logged_in');
        }

        // 2. /server economy ga o'tish va 80s navbat
        this.sessionManager.setTimeout(() => {
          if (config.MC_SUBSERVER) {
            console.log(`[Mineflayer:${this.username}] Lobby dan ${config.MC_SUBSERVER} ga o'tish (/server ${config.MC_SUBSERVER})...`);
            this.safeChat(`/server ${config.MC_SUBSERVER}`, true);
            this.startQueueWait(80000);
          }
        }, 3000, boundSessionId);
      }, 2000, boundSessionId);
    });

    bot.on('respawn', () => {
      if (!this.sessionManager.isSessionValid(boundSessionId)) return;

      console.log(`[Mineflayer:${this.username}] Server yoki dunyo almashdi (respawn).`);
      if (this.isQueueWaiting) {
        if (this.queueTimer) {
          this.sessionManager.clearTimeout(this.queueTimer);
          this.queueTimer = null;
        }
        this.isQueueWaiting = false;
        this.commandQueue.setLock(false);
      }

      this.currentServer = config.MC_SUBSERVER;
      this.stateManager.setServerState(SERVER_STATES.ECONOMY);
      this.stateManager.setBotState(BOT_STATES.VERIFYING_ECONOMY);
      this.recoveryManager.confirmEconomySuccess();

      this.sessionManager.setTimeout(() => {
        if (this.targetLocation === 'home') {
          console.log(`[Mineflayer:${this.username}] Bot home rejimida, AFK ga o'tilmaydi.`);
          this.isAfk = false;
        } else if (!this.isAfk) {
          console.log(`[Mineflayer:${this.username}] /afk rejimiga o'tilmoqda...`);
          this.stateManager.setBotState(BOT_STATES.ACTIVATING_AFK);
          this.safeChat('/afk', true);
          this.isAfk = true;
          this.stateManager.setBotState(BOT_STATES.AFK_ACTIVE);
          this.afkManager.startMonitoring();
        }
      }, 3500, boundSessionId);
    });

    bot.on('chat', (username, message) => {
      if (!this.sessionManager.isSessionValid(boundSessionId)) return;
      if (username === bot.username) return;
      this.lastMessage = `${username}: ${message}`;
      this.chatManager.parseMessage(`${username}: ${message}`, 'chat');
    });

    bot.on('whisper', (username, message) => {
      if (!this.sessionManager.isSessionValid(boundSessionId)) return;
      if (username === bot.username) return;
      this.lastMessage = `${username} (whisper): ${message}`;
      this.chatManager.parseMessage(`[MSG] ${username} » ${this.username}: ${message}`, 'whisper');
    });

    bot.on('messagestr', (message) => {
      if (!this.sessionManager.isSessionValid(boundSessionId)) return;
      const clean = (message || '').trim();
      if (!clean) return;

      this.lastMessage = clean;

      // 1. Shard Tracker
      if (this.supervisor && this.supervisor.shardTracker) {
        const shardRes = this.supervisor.shardTracker.parseChat(clean);
        if (shardRes && shardRes.amount) {
          this.afkManager.onShardReceived(shardRes.amount, shardRes.total);
        }
      }

      // 2. Chat Manager
      this.chatManager.parseMessage(clean, 'messagestr');

      // 3. AFK Manager verifikatsiyasi
      this.afkManager.verifyAfkMessage(clean);

      // 4. Parol va Login so'rovlarini avtomatik bajarish
      if (!this.hasLoggedIn && this.password) {
        const lower = clean.toLowerCase();
        if (lower.includes('/login') || lower.includes('parol') || lower.includes('login') || lower.includes('autentifikatsiya')) {
          console.log(`[Mineflayer:${this.username}] Tizim /login so'radi, parol yuborilmoqda...`);
          this.safeChat(`/login ${this.password}`, true);
          this.hasLoggedIn = true;
          this.stateManager.setBotState(BOT_STATES.LOBBY);
        }
      }
    });

    bot._client.on('packet', (data, meta) => {
      if (!this.sessionManager.isSessionValid(boundSessionId)) return;
      const name = meta ? meta.name : '';

      if (['title', 'set_title_text', 'set_title_subtitle', 'set_action_bar_text'].includes(name)) {
        const text = extractCleanText(data);
        if (text) {
          this.lastMessage = text;
          if (this.supervisor && this.supervisor.shardTracker) {
            const shardRes = this.supervisor.shardTracker.parseChat(text);
            if (shardRes && shardRes.amount) {
              this.afkManager.onShardReceived(shardRes.amount, shardRes.total);
            }
          }
        }
      }

      if (name === 'map' && data) {
        this.handleMapCaptcha(data);
      }

      if (name === 'set_slot' && data && data.item) {
        const itemId = data.item.itemId || data.item.id;
        if (itemId === 982 || (data.item.name && data.item.name.includes('map'))) {
          try {
            if (bot.setQuickBarSlot) bot.setQuickBarSlot(0);
            this.sessionManager.setTimeout(() => {
              if (bot.activateItem) bot.activateItem();
            }, 800, boundSessionId);
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
      this.stateManager.setConnectionState(CONNECTION_STATES.DISCONNECTED);
      this.stateManager.setBotState(BOT_STATES.RECOVERING, 'kicked');
      this.cleanup();
      this.scheduleReconnect(this.recoveryManager.getBackoffDelay(), 'kick_recovery');
    });

    bot.on('end', (reason) => {
      console.log(`[Mineflayer:${this.username}] Aloqa uzildi (${reason || 'end'}).`);
      this.stateManager.setConnectionState(CONNECTION_STATES.DISCONNECTED);
      this.stateManager.setBotState(BOT_STATES.RECOVERING, 'end');
      this.cleanup();
      this.scheduleReconnect(this.recoveryManager.getBackoffDelay(), 'end_recovery');
    });

    bot.on('error', (err) => {
      console.error(`[Mineflayer:${this.username}] Bot xatosi: ${err.message}`);
      if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].some(code => err.message.includes(code))) {
        this.cleanup();
        this.scheduleReconnect(this.recoveryManager.getBackoffDelay(), 'network_error');
      }
    });
  }

  scheduleReconnect(delayMs = 5000, reason = 'auto') {
    if (this.manualStopped) {
      console.log(`[Mineflayer:${this.username}] Bot qo'lda to'xtatilgan, qayta ulanish bekor qilindi.`);
      return;
    }

    this.stateManager.setBotState(BOT_STATES.COOLDOWN, reason);
    console.log(`[Mineflayer:${this.username}] ⏳ ${Math.round(delayMs / 1000)} soniyadan keyin qayta ulanadi (Sabab: ${reason})...`);

    const boundSession = this.sessionManager.getCurrentSessionId();
    this.sessionManager.setTimeout(() => {
      if (!this.manualStopped) {
        this.start();
      }
    }, delayMs, boundSession);
  }

  reconnect(delayMs = 1000, reason = 'manual') {
    this.cleanup();
    this.scheduleReconnect(delayMs, reason);
  }

  cleanup() {
    this.afkManager.stopMonitoring();
    this.recoveryManager.stopEconomyVerification();
    this.commandQueue.setLock(false);
    this.commandQueue.clear();

    this.isQueueWaiting = false;
    this.queueStartedAt = null;

    if (this.queueTimer) {
      this.sessionManager.clearTimeout(this.queueTimer);
      this.queueTimer = null;
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
    this.stateManager.setConnectionState(CONNECTION_STATES.DISCONNECTED);
  }

  stop() {
    this.manualStopped = true;
    this.sessionManager.clearAllTimers();
    this.cleanup();
    this.stateManager.setBotState(BOT_STATES.STOPPED, 'manual_stop');
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

    this.lastRawMap = null;
    this.lastMapMeta = null;
    this.lastCaptchaPng = null;
  }

  static get extractCleanText() {
    return extractCleanText;
  }

  static get normalizeCommand() {
    return normalizeCommand;
  }

  getSystemStatus() {
    const primary = this.primaryBot;
    const uptimeSec = primary && primary.startedAt && primary.stateManager.botState !== BOT_STATES.STOPPED
      ? Math.floor((Date.now() - primary.startedAt) / 1000)
      : 0;

    return {
      bot: {
        username: primary ? primary.username : 'Gotto',
        status: primary ? primary.status : 'stopped',
        bot_state: primary ? primary.stateManager.botState : 'STOPPED',
        server_state: primary ? primary.stateManager.serverState : 'unknown',
        connection_state: primary ? primary.stateManager.connectionState : 'disconnected',
        afk_state: primary ? primary.stateManager.afkState : 'inactive',
        subserver: primary ? primary.currentServer : 'lobby',
        is_afk: primary ? primary.isAfk : false,
        is_queue_waiting: primary ? primary.commandQueue.isQueueLocked() : false,
        queue_remaining_seconds: primary ? primary.commandQueue.getLockRemainingSec() : 0,
        queue_duration_ms: primary ? primary.queueDurationMs : 80000,
        session_id: primary ? primary.sessionManager.getCurrentSessionId() : 0,
        health: primary ? primary.health : 20,
        food: primary ? primary.food : 20,
        uptime: uptimeSec,
        host: config.MC_HOST,
        port: config.MC_PORT,
        target_location: primary ? primary.targetLocation : 'afk',
        is_captcha_pending: primary ? primary.isCaptchaPending : false
      },
      bots: this.bots.map(b => b.getSummary()),
      shards: this.shardTracker.getSummary(),
      vote: this.tracker.getSummary(),
      config: {
        host: config.MC_HOST,
        port: config.MC_PORT,
        subserver: config.MC_SUBSERVER,
        owners: config.MC_OWNERS,
        auto_afk: config.AUTO_AFK_ON_BOOT
      }
    };
  }

  handleWebAction(path, payload = {}) {
    const primary = this.primaryBot;

    // AFK Tiklash (Lobby -> 80s Queue -> AFK)
    if (path === '/api/bot/recover_afk') {
      if (!primary) return { success: false, error: 'Asosiy bot mavjud emas' };
      return primary.recoverAfk();
    }

    // Shardlarni tekshirish yoki qo'lda qo'shish
    if (path === '/api/shards/add') {
      const amount = payload.amount || 10;
      const total = this.shardTracker.addShards(amount, payload.reason || 'manual_web');
      return { success: true, total_shards: total };
    }

    if (path === '/api/shards/status') {
      return { success: true, shards: this.shardTracker.getSummary() };
    }

    // Botni qayta ishga tushirish
    if (path === '/api/bot/restart') {
      console.log('[WebServer] Veb boshqaruv orqali bot qayta ishga tushirilmoqda...');
      if (primary) {
        primary.reconnect(1000, 'web_restart');
      }
      return { success: true, message: 'Bot qayta ishga tushirilmoqda...' };
    }

    // Botni to'xtatish
    if (path === '/api/bot/stop') {
      console.log('[WebServer] Veb boshqaruv orqali bot to\'xtatilmoqda...');
      this.bots.forEach(b => b.stop());
      return { success: true, message: 'Barcha botlar to\'xtatildi.' };
    }

    // Botni ishga tushirish
    if (path === '/api/bot/start') {
      console.log('[WebServer] Veb boshqaruv orqali bot ishga tushirilmoqda...');
      this.bots.forEach(b => {
        b.manualStopped = false;
        b.start();
      });
      return { success: true, message: 'Botlar ishga tushirildi.' };
    }

    // Chat yuborish
    if (path === '/api/bot/chat') {
      const text = payload.text || payload.message || '';
      if (!text) return { success: false, error: 'Xabar matni kiritilmadi' };
      if (!primary || !primary.bot) return { success: false, error: 'Bot serverga ulanmagan' };

      const normalized = normalizeCommand(text);
      if (!normalized) return { success: false, error: 'Yaroqsiz buyruq' };

      const ok = primary.safeChat(normalized, true);
      return { success: ok, message: ok ? `Buyruq yuborildi: ${normalized}` : 'Buyruq bloklandi (navbatda)' };
    }

    // Vote amallari
    if (path === '/api/vote/record') {
      const voteId = parseInt(payload.vote_id, 10);
      if (!voteId || voteId < 1 || voteId > 4) return { success: false, error: 'Noto\'g\'ri vote_id' };
      this.tracker.recordVote(voteId);
      return { success: true, message: `Vote #${voteId} qayd qilindi` };
    }

    if (path === '/api/vote/set_url') {
      const voteId = parseInt(payload.vote_id, 10);
      const url = payload.url || '';
      const name = payload.name || '';
      if (!voteId || voteId < 1 || voteId > 4) return { success: false, error: 'Noto\'g\'ri vote_id' };
      this.tracker.setVoteUrl(voteId, url, name);
      return { success: true, message: `Vote #${voteId} URL yangilandi` };
    }

    return { success: false, error: `Noma'lum amal: ${path}` };
  }

  start() {
    console.log('='.repeat(60));
    console.log('🚀 Minecraft 24/7 Multi-Bot Supervisor ishga tushmoqda...');
    console.log(`• Server: ${config.MC_HOST}:${config.MC_PORT} (Subserver: ${config.MC_SUBSERVER})`);
    console.log(`• Botlar soni: ${this.bots.length} (${this.bots.map(b => b.username).join(', ')})`);
    console.log(`• Veb Dashboard Porti: ${config.PORT}`);
    console.log('='.repeat(60));

    this.webServer.start();
    if (config.ENABLE_KEEP_ALIVE) {
      this.webServer.startKeepAlive();
    }

    this.bots.forEach(bot => {
      bot.start();
    });
  }

  stop() {
    console.log('[System] Tizim to\'xtatilmoqda...');
    this.bots.forEach(b => b.stop());
    this.webServer.stop();
  }
}

if (require.main === module) {
  const supervisor = new Minecraft247Bot();
  supervisor.start();

  process.on('SIGINT', () => {
    supervisor.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    supervisor.stop();
    process.exit(0);
  });
}

Minecraft247Bot.extractCleanText = extractCleanText;
Minecraft247Bot.normalizeCommand = normalizeCommand;

module.exports = Minecraft247Bot;
