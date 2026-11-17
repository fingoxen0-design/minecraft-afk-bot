/**
 * Minecraft 24/7 Headless AFK Bot - Asosiy Node.js Dasturi
 * Render bulut serverida PC o'chiq bo'lsa ham 24/7 AFK turish uchun ishlab chiqilgan.
 * 100% Sof JavaScript (Node.js). Zero Python. Zero Telegram.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');

const config = require('./config');
const VoteTracker = require('./voteTracker');
const { WebServer } = require('./webServer');

process.on('uncaughtException', (err) => {
  if (err && (err.name === 'PartialReadError' || (err.message && (err.message.includes('PartialReadError') || err.message.includes('Missing characters'))))) {
    return;
  }
  console.error('[UncaughtException]', err ? err.message : err);
});

class Minecraft247Bot {
  constructor() {
    this.bot = null;
    this.status = 'stopped'; // stopped, connecting, logged_in, in_economy, afk_active, reconnecting, kicked
    this.currentServer = 'hub';
    this.isAfk = false;
    this.health = null;
    this.food = null;
    this.startedAt = null;
    this.lastMessage = '';
    this.manualStopped = false;
    this.reconnectTimer = null;
    this.antiKickInterval = null;
    this.pendingTimers = [];

    // Captcha & Safety State
    this.hasLoggedIn = false;
    this.isCaptchaPending = false;
    this.lastSubmittedCaptcha = null;
    this.lastSubmittedCaptchaTime = 0;
    this.lastSolvedMapHash = null;
    this.lastSolvedMapTime = 0;
    this.lastMapProcessTime = 0;

    // 4x Vote Tracker
    this.tracker = new VoteTracker();

    // Veb Server
    this.webServer = new WebServer(
      config.PORT,
      config.HOST,
      () => this.getSystemStatus(),
      (path, payload) => this.handleWebAction(path, payload)
    );
  }

  getSystemStatus() {
    const uptimeSec = this.startedAt && this.status !== 'stopped'
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;

    return {
      bot: {
        status: this.status,
        is_afk: this.isAfk,
        server: this.currentServer,
        health: this.health,
        food: this.food,
        uptime_seconds: uptimeSec,
        uptime_text: `${hours}s ${mins}d ${secs}sek`,
        last_message: this.lastMessage,
        username: config.MC_USERNAME,
        host: config.MC_HOST,
        subserver: config.MC_SUBSERVER,
        manual_stopped: this.manualStopped
      },
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

  handleWebAction(actionPath, payload) {
    if (actionPath === '/api/bot/start') {
      this.manualStopped = false;
      this.startBot();
      return { success: true, message: 'Bot ishga tushirildi' };
    }

    if (actionPath === '/api/bot/stop') {
      this.manualStopped = true;
      this.stopBot();
      return { success: true, message: 'Bot to\'xtatildi' };
    }

    if (actionPath === '/api/bot/chat') {
      const text = (payload && payload.text) ? String(payload.text).trim() : '';
      if (!text) return { success: false, message: 'Xabar bo\'sh bo\'lishi mumkin emas' };
      const ok = this.safeChat(text);
      return { success: ok, message: ok ? `Xabar yuborildi: ${text}` : 'Bot faol emas' };
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
      console.log(`[Mineflayer] [CHAT_OUT] ${message}`);
      return true;
    } catch (err) {
      console.error(`[Mineflayer] Chat yuborishda xatolik: ${err.message}`);
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

  // Map Captcha Pikselli OCR Tahlili
  handleMapCaptcha(data) {
    try {
      if (!data || !data.data) return;
      const cols = data.columns || 0;
      const rows = data.rows || 0;
      const buf = data.data;
      const len = buf ? buf.length : 0;
      if (!buf || len === 0 || cols === 0 || rows === 0) return;

      const mapHash = crypto.createHash('md5').update(buf).digest('hex');
      const now = Date.now();

      // Takroriy paketlarni va tez-tez yuborishni cheklash (kamida 6 soniya tanaffus)
      if ((this.lastSolvedMapHash === mapHash && (now - this.lastSolvedMapTime < 60000)) || (now - this.lastMapProcessTime < 6000)) {
        return;
      }
      this.lastMapProcessTime = now;
      this.isCaptchaPending = true;

      // Eng ko'p uchragan rangni fon (background) deb olamiz
      const freq = {};
      for (let i = 0; i < len; i++) {
        const c = buf[i];
        freq[c] = (freq[c] || 0) + 1;
      }
      console.log(`[Mineflayer] [MAP_COLORS] ${JSON.stringify(freq)}`);
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

      if (fgCount > 25 && maxX >= minX && maxY >= minY) {
        // Map ASCII rasmini konsolga chiqarish
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
        console.log(`[Mineflayer] [MAP_ASCII] bbox=[${minX},${minY} -> ${maxX},${maxY}], fg=${fgCount}\n${asciiLines.join('\n')}`);

        // Raqamlar OCR
        const { recognizeDigits } = require('./minecraft_bot');
        if (typeof recognizeDigits === 'function') {
          const code = recognizeDigits(cols, rows, buf, bg, minX, maxX, minY, maxY);
          if (code && code.length >= 1) {
            this.lastSolvedMapHash = mapHash;
            this.lastSolvedMapTime = Date.now();
            console.log(`[Mineflayer] [MAP_SOLVER] Xarita captcha kodi aniqlandi: "${code}"`);

            this.safeTimeout(() => {
              if (Date.now() - this.lastSubmittedCaptchaTime > 5000) {
                this.lastSubmittedCaptchaTime = Date.now();
                this.lastSubmittedCaptcha = code;
                console.log(`[Mineflayer] Captcha kodi yuborilmoqda: "${code}"`);
                this.safeChat(code);
              }
            }, 1000);
          }
        }
      }
    } catch (err) {
      console.error(`[Mineflayer] Map Captcha tahlilida xato: ${err.message}`);
    }
  }

  startBot() {
    if (this.manualStopped) {
      console.log('[Supervisor] Bot qo\'lda to\'xtatilgan (manual_stopped). Start bosilmaguncha kutiladi.');
      return;
    }

    if (this.bot) {
      this.cleanupBot();
    }

    this.status = 'connecting';
    this.startedAt = Date.now();
    console.log(`[Mineflayer] Minecraft serverga ulanish: ${config.MC_HOST}:${config.MC_PORT} (Nik: ${config.MC_USERNAME})`);

    const botOptions = {
      host: config.MC_HOST,
      port: config.MC_PORT,
      username: config.MC_USERNAME,
      version: config.MC_VERSION || false,
      auth: 'offline',
      checkTimeoutInterval: 45000,
      keepAlive: true,
      hideErrors: false
    };

    try {
      this.bot = mineflayer.createBot(botOptions);
      this.setupBotEvents();
    } catch (err) {
      console.error(`[Mineflayer] Bot yaratishda xato: ${err.message}`);
      this.scheduleReconnect(30000);
    }
  }

  setupBotEvents() {
    const bot = this.bot;

    bot.once('spawn', () => {
      console.log(`[Mineflayer] Muvaffaqiyatli serverga ulandi! (Server: ${this.currentServer})`);
      this.status = 'logged_in';

      // Login yuborish
      this.safeTimeout(() => {
        if (!this.hasLoggedIn && config.MC_PASSWORD) {
          console.log('[Mineflayer] /login buyrug\'i yuborilmoqda...');
          this.safeChat(`/login ${config.MC_PASSWORD}`);
          this.hasLoggedIn = true;
        }

        // Subserverga o'tish (/server economy)
        this.safeTimeout(() => {
          if (config.MC_SUBSERVER && this.currentServer !== config.MC_SUBSERVER) {
            console.log(`[Mineflayer] /server ${config.MC_SUBSERVER} ga o'tish buyrug'i yuborilmoqda...`);
            this.safeChat(`/server ${config.MC_SUBSERVER}`);
          }
        }, 3000);
      }, 2000);
    });

    bot.on('respawn', () => {
      console.log(`[Mineflayer] Server yoki dunyo almashdi (respawn).`);
      this.currentServer = config.MC_SUBSERVER;
      this.status = 'in_economy';
      this.safeTimeout(() => {
        if (!this.isAfk) {
          console.log('[Mineflayer] /afk rejimiga o\'tilmoqda...');
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
      console.log(`[Mineflayer] [CHAT] <${username}> ${message}`);
    });

    bot.on('messagestr', (message) => {
      const clean = (message || '').trim();
      if (!clean) return;
      this.lastMessage = clean;
      console.log(`[Mineflayer] [MSG] ${clean}`);

      const lower = clean.toLowerCase();

      // Economy serverga tushganini aniqlash (allaysmp umumiy so'zini tekshirmaymiz!)
      const sub = (config.MC_SUBSERVER || 'economy').toLowerCase();
      if (lower.includes(`sending you to ${sub}`) || lower.includes(`connected to ${sub}`) || lower.includes(`joined ${sub}`) || lower.includes(`[${sub}]`)) {
        this.currentServer = config.MC_SUBSERVER;
        this.status = 'in_economy';
        console.log(`[Mineflayer] ${config.MC_SUBSERVER} serveriga muvaffaqiyatli o'tildi!`);

        this.safeTimeout(() => {
          if (!this.isAfk) {
            console.log('[Mineflayer] /afk rejimiga o\'tilmoqda...');
            this.safeChat('/afk');
            this.isAfk = true;
            this.status = 'afk_active';
            this.safeStartAfkMovement();
          }
        }, 3000);
      }

      // Parol so'ralsa
      if (lower.includes('/login') || lower.includes('parol')) {
        this.safeTimeout(() => {
          if (config.MC_PASSWORD) {
            this.safeChat(`/login ${config.MC_PASSWORD}`);
          }
        }, 1200);
      }
    });

    // Xom paketlarni (Map Captcha & Kick) kuzatish
    bot._client.on('packet', (data, meta) => {
      const name = meta ? meta.name : '';

      if (['title', 'set_title_text', 'set_title_subtitle', 'set_action_bar_text', 'boss_bar'].includes(name)) {
        console.log(`[Mineflayer] [PACKET:${name}] ${JSON.stringify(data)}`);
      }

      // Map Captcha
      if (name === 'map' && data) {
        this.handleMapCaptcha(data);
      }

      // Set slot (Map berilsa hotbarga olish)
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
      console.log(`[Mineflayer] 🚨 KICK: Serverdan chiqarildi! (${rText})`);
      this.status = 'kicked';
      this.cleanupBot();

      // 24/7 Auto-Reconnect: Kick bo'lganda 45 soniyadan keyin avtomatik qayta ulanish!
      this.scheduleReconnect(45000);
    });

    bot.on('end', (reason) => {
      console.log(`[Mineflayer] Aloqa uzildi (${reason || 'end'}).`);
      this.status = 'disconnected';
      this.cleanupBot();
      this.scheduleReconnect(15000);
    });

    bot.on('error', (err) => {
      console.error(`[Mineflayer] Xatolik: ${err.message}`);
      this.status = 'error';
      this.cleanupBot();
      this.scheduleReconnect(20000);
    });
  }

  cleanupBot() {
    this.clearAllTimers();
    this.isAfk = false;
    this.hasLoggedIn = false;
    this.isCaptchaPending = false;
    if (this.bot) {
      try {
        this.bot.removeAllListeners();
        this.bot.end();
      } catch (_) {}
      this.bot = null;
    }
  }

  scheduleReconnect(delayMs = 20000) {
    if (this.manualStopped) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }

    this.status = 'reconnecting';
    console.log(`[Supervisor] ${delayMs / 1000} soniyadan so'ng avtomatik qayta ulaniladi (24/7 rejim)...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualStopped) {
        this.startBot();
      }
    }, delayMs);
  }

  stopBot() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupBot();
    this.status = 'stopped';
    console.log('[Mineflayer] Bot to\'xtatildi.');
  }

  start() {
    console.log('='.repeat(60));
    console.log('🚀 MINECRAFT 24/7 HEADLESS AFK BOT (NODE.JS)');
    console.log(`• Minecraft Server: ${config.MC_HOST}:${config.MC_PORT}`);
    console.log(`• Subserver: ${config.MC_SUBSERVER}`);
    console.log(`• Nik: ${config.MC_USERNAME}`);
    console.log(`• Veb Dashboard Porti: ${config.PORT}`);
    console.log('='.repeat(60));

    // 1. Veb Serverni ishga tushirish
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

    // 4. Avtomatik botni start qilish (24/7 Headless)
    if (config.AUTO_AFK_ON_BOOT) {
      this.startBot();
    }
  }

  stop() {
    console.log('[System] Tizim to\'xtatilmoqda...');
    this.manualStopped = true;
    this.stopBot();
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
