const EventEmitter = require('events');

class AfkManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stallThresholdMs = options.stallThresholdMs || 12 * 60 * 1000; // 12 daqiqa
    this.antiKickIntervalMs = options.antiKickIntervalMs || 4 * 60 * 1000; // 4 daqiqa

    this.lastShardTime = Date.now();
    this.isAfkActive = false;
    this.stallCheckTimer = null;
    this.antiKickTimer = null;
    this.botRef = null;
  }

  setBot(bot) {
    this.botRef = bot;
  }

  onShardReceived(shardsGained, newTotal) {
    this.lastShardTime = Date.now();
    this.emit('shardIncrement', { shardsGained, newTotal, timestamp: this.lastShardTime });
  }

  verifyAfkMessage(message) {
    const clean = String(message || '').toLowerCase();
    // AFK faolligi haqidagi server xabarlari
    if (clean.includes('afk') || clean.includes('hovuz') || clean.includes('pool') || clean.includes('you are now afk')) {
      this.isAfkActive = true;
      this.emit('afkConfirmed', { message });
      return true;
    }
    return false;
  }

  startMonitoring(checkIntervalMs = 60000) {
    this.stopMonitoring();
    this.lastShardTime = Date.now();

    this.stallCheckTimer = setInterval(() => {
      this.checkShardStall();
    }, checkIntervalMs);

    this.antiKickTimer = setInterval(() => {
      this.performGentleAntiKick();
    }, this.antiKickIntervalMs);

    // Avtomatik har 5 daqiqada Shards balansini yangilash
    this.shardCheckTimer = setInterval(() => {
      if (this.isAfkActive) {
        this.emit('requestShardCheck');
      }
    }, 5 * 60 * 1000);

    // AFK boshlangandan 5 soniya o'tib dastlabki balansni yangilash
    this.initialShardTimer = setTimeout(() => {
      if (this.isAfkActive) {
        this.emit('requestShardCheck');
      }
    }, 5000);
  }

  stopMonitoring() {
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer);
      this.stallCheckTimer = null;
    }
    if (this.antiKickTimer) {
      clearInterval(this.antiKickTimer);
      this.antiKickTimer = null;
    }
    if (this.shardCheckTimer) {
      clearInterval(this.shardCheckTimer);
      this.shardCheckTimer = null;
    }
    if (this.initialShardTimer) {
      clearTimeout(this.initialShardTimer);
      this.initialShardTimer = null;
    }
    this.isAfkActive = false;
  }

  checkShardStall() {
    if (!this.isAfkActive) return;

    const elapsed = Date.now() - this.lastShardTime;
    if (elapsed > this.stallThresholdMs) {
      console.warn(`[AfkManager] ⚠️ Shard to'xtab qoldi! ${Math.round(elapsed / 60000)} daqiqadan beri shard kelmadi.`);
      this.emit('shardStallDetected', { elapsedMs: elapsed, lastShardTime: this.lastShardTime });
    }
  }

  performGentleAntiKick() {
    if (!this.botRef || !this.botRef.entity) return;

    try {
      // Sakrash EMAS, faqat burchakni muloyim burish (0.05 rad)
      const currentYaw = this.botRef.entity.yaw || 0;
      const currentPitch = this.botRef.entity.pitch || 0;
      const delta = (Math.random() - 0.5) * 0.1; // -0.05 dan +0.05 gacha

      if (typeof this.botRef.look === 'function') {
        this.botRef.look(currentYaw + delta, currentPitch, true, () => {});
      }
    } catch (err) {
      // Harakat xatosi jim o'tkaziladi
    }
  }

  getStatus() {
    const elapsedSinceShard = Date.now() - this.lastShardTime;
    return {
      isAfkActive: this.isAfkActive,
      lastShardTime: this.lastShardTime,
      elapsedSinceShardSec: Math.floor(elapsedSinceShard / 1000),
      isStalled: this.isAfkActive && (elapsedSinceShard > this.stallThresholdMs)
    };
  }
}

module.exports = AfkManager;
