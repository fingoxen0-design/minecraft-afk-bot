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
const { WebServer, globalLogBuffer } = require('./webServer');
const { createMapPng, solveMapWithOcr } = require('./captchaSolver');

process.on('uncaughtException', (err) => {
  if (err && (err.name === 'PartialReadError' || (err.message && err.message.includes('PartialReadError')))) {
    return;
  }
  console.error('[UncaughtException]', err ? err.message : err);
});

class SingleBotInstance {
  constructor(account, supervisor) {
    this.account = account;
    this.username = account.username;
    this.password = account.password;
    this.supervisor = supervisor;

    this.bot = null;
    this.status = 'stopped'; // stopped, connecting, logged_in, in_economy, afk_active, reconnecting, kicked
    this.currentServer = 'hub';
    this.isAfk = false;
    this.health = 20;
    this.food = 20;
    this.startedAt = null;
    this.lastMessage = '';
    this.manualStopped = false;
    this.reconnectTimer = null;
    this.antiKickInterval = null;
    this.pendingTimers = [];

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
  }

  getSummary() {
    const uptimeSec = this.startedAt && this.status !== 'stopped'
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;

    return {
      username: this.username,
      status: this.status,
      is_afk: this.isAfk,
      server: this.currentServer,
      health: this.health,
      food: this.food,
      uptime_seconds: uptimeSec,
      uptime_text: `${hours}s ${mins}d ${secs}sek`,
      last_message: this.lastMessage,
      host: config.MC_HOST,
      subserver: config.MC_SUBSERVER,
      manual_stopped: this.manualStopped,
      captchaPending: this.isCaptchaPending,
      hasCaptchaPng: !!this.lastCaptchaPng,
      lastCaptchaTime: this.lastCaptchaTime
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
  }

  safeChat(message) {
    if (!this.bot || typeof this.bot.chat !== 'function') {
      return false;
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

    this.status = 'connecting';
    this.startedAt = Date.now();
    console.log(`[Mineflayer:${this.username}] Minecraft serverga ulanish: ${config.MC_HOST}:${config.MC_PORT}`);

    const botOptions = {
      host: config.MC_HOST,
      port: config.MC_PORT,
      username: this.username,
      version: config.MC_VERSION || false,
      auth: 'offline',
      checkTimeoutInterval: 45000,
      keepAlive: true,
      hideErrors: false
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

      this.safeTimeout(() => {
        if (!this.hasLoggedIn && this.password) {
          console.log(`[Mineflayer:${this.username}] /login buyrug'i yuborilmoqda...`);
          this.safeChat(`/login ${this.password}`);
          this.hasLoggedIn = true;
        }

        this.safeTimeout(() => {
          if (config.MC_SUBSERVER && this.currentServer !== config.MC_SUBSERVER) {
            console.log(`[Mineflayer:${this.username}] /server ${config.MC_SUBSERVER} ga o'tish buyrug'i yuborilmoqda...`);
            this.safeChat(`/server ${config.MC_SUBSERVER}`);
          }
        }, 3000);
      }, 2000);
    });

    bot.on('respawn', () => {
      console.log(`[Mineflayer:${this.username}] Server yoki dunyo almashdi (respawn).`);
      this.currentServer = config.MC_SUBSERVER;
      this.status = 'in_economy';
      this.safeTimeout(() => {
        if (!this.isAfk) {
          console.log(`[Mineflayer:${this.username}] /afk rejimiga o'tilmoqda...`);
          this.safeChat('/afk');
          this.isAfk = true;
          this.status = 'afk_active';
          this.safeStartAfkMovement();
        }
      }, 3500);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.lastMessage = `${username}: ${message}`;
      console.log(`[Mineflayer:${this.username}] [CHAT] <${username}> ${message}`);
    });

    bot.on('messagestr', (message) => {
      const clean = (message || '').trim();
      if (!clean) return;
      this.lastMessage = clean;
      console.log(`[Mineflayer:${this.username}] [MSG] ${clean}`);

      const lower = clean.toLowerCase();

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
        console.log(`[Mineflayer:${this.username}] Bot rasman AFK hududida (afk_active)!`);
      }

      // Economy serverga tushganini aniqlash
      const sub = (config.MC_SUBSERVER || 'economy').toLowerCase();
      if (lower.includes(`sending you to ${sub}`) || lower.includes(`connected to ${sub}`) || lower.includes(`joined ${sub}`) || lower.includes(`[${sub}]`)) {
        this.currentServer = config.MC_SUBSERVER;
        this.status = 'in_economy';
        console.log(`[Mineflayer:${this.username}] ${config.MC_SUBSERVER} serveriga muvaffaqiyatli o'tildi!`);

        this.safeTimeout(() => {
          if (!this.isAfk) {
            console.log(`[Mineflayer:${this.username}] /afk rejimiga o'tilmoqda...`);
            this.safeChat('/afk');
            this.isAfk = true;
            this.status = 'afk_active';
            this.safeStartAfkMovement();
          }
        }, 3000);
      }

      // Ro'yxatdan o'tish so'ralsa
      if (lower.includes('/register') || lower.includes('royxat')) {
        this.safeTimeout(() => {
          if (this.password) {
            console.log(`[Mineflayer:${this.username}] /register buyrug'i yuborilmoqda...`);
            this.safeChat(`/register ${this.password} ${this.password}`);
            this.hasLoggedIn = true;
          }
        }, 1200);
      }
      // Parol so'ralsa
      else if (lower.includes('/login') || lower.includes('parol')) {
        this.safeTimeout(() => {
          if (this.password) {
            this.safeChat(`/login ${this.password}`);
            this.hasLoggedIn = true;
          }
        }, 1200);
      }
    });

    // Xom paketlarni (Map Captcha & Title) kuzatish
    bot._client.on('packet', (data, meta) => {
      const name = meta ? meta.name : '';

      if (['title', 'set_title_text', 'set_title_subtitle', 'set_action_bar_text', 'boss_bar'].includes(name)) {
        console.log(`[Mineflayer:${this.username}] [PACKET:${name}] ${JSON.stringify(data)}`);
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
    if (this.bot) {
      try {
        this.bot.removeAllListeners();
        if (this.bot._client) this.bot._client.removeAllListeners();
        this.bot.quit();
      } catch (_) {}
      this.bot = null;
    }
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

    if (actionPath === '/api/captcha/solve') {
      const code = (payload && payload.code) ? String(payload.code).trim() : '';
      if (!code) return { success: false, message: 'Kod kiritilmagan' };

      const targetName = payload && payload.bot ? String(payload.bot) : null;
      let targetBot = targetName ? this.bots.find(b => b.username.toLowerCase() === targetName.toLowerCase()) : null;
      if (!targetBot) {
        targetBot = this.bots.find(b => b.isCaptchaPending) || this.primaryBot;
      }

      console.log(`[Mineflayer:${targetBot.username}] Veb panel orqali captcha kodi kiritildi: "${code}"`);
      const ok = targetBot.safeChat(code);
      targetBot.isCaptchaPending = false;
      return { success: ok, message: ok ? `Kod (${targetBot.username}) yuborildi: ${code}` : 'Bot faol emas' };
    }

    if (actionPath === '/api/bot/chat') {
      const text = (payload && payload.text) ? String(payload.text).trim() : '';
      if (!text) return { success: false, message: 'Xabar bo\'sh bo\'lishi mumkin emas' };
      const target = payload && payload.bot ? String(payload.bot) : 'all';
      const ok = this.safeChat(text, target);
      return { success: ok, message: ok ? `Xabar yuborildi: ${text}` : 'Bot(lar) faol emas' };
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

    // 3. 4 ta Vote eslatma sikli
    setInterval(() => {
      for (const v of this.tracker.getAllVotes()) {
        if (this.tracker.isTimeToVote(v.id) && !v.alert_sent) {
          console.log(`[VoteTracker] 🗳 DIQQAT: ${v.name} saytida ovoz berish vaqti keldi! (${v.url})`);
          this.tracker.state.votes[String(v.id)].alert_sent = true;
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

module.exports = Minecraft247Bot;
