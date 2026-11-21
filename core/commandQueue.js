const EventEmitter = require('events');

const PRIORITY = Object.freeze({
  HIGH: 1,
  NORMAL: 2,
  LOW: 3
});

class CommandQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.minIntervalMs = options.minIntervalMs || 1500;
    this.sendFn = options.sendFn || null; // function(cmd) => void

    this.queue = [];
    this.isProcessing = false;
    this.lastSentAt = 0;
    this.processTimer = null;

    // Velocity Proxy Queue Lock (60-80s)
    this.isLocked = false;
    this.lockStartedAt = 0;
    this.lockDurationMs = 0;
  }

  setSendFunction(fn) {
    this.sendFn = fn;
  }

  setLock(locked, durationMs = 80000) {
    this.isLocked = Boolean(locked);
    if (this.isLocked) {
      this.lockStartedAt = Date.now();
      this.lockDurationMs = durationMs;
      this.emit('locked', { durationMs });
    } else {
      this.lockStartedAt = 0;
      this.lockDurationMs = 0;
      this.emit('unlocked');
      if (this.processTimer) {
        clearTimeout(this.processTimer);
        this.processTimer = null;
      }
      this.scheduleProcess(0);
    }
  }

  isQueueLocked() {
    if (!this.isLocked) return false;
    // Agar taymer muddati tugagan bo'lsa, avtomatik unlock qilish
    if (this.lockDurationMs > 0 && (Date.now() - this.lockStartedAt) >= this.lockDurationMs) {
      this.setLock(false);
      return false;
    }
    return true;
  }

  getLockRemainingSec() {
    if (!this.isQueueLocked()) return 0;
    const elapsed = Date.now() - this.lockStartedAt;
    return Math.max(0, Math.ceil((this.lockDurationMs - elapsed) / 1000));
  }

  enqueue(command, options = {}) {
    const raw = String(command || '').trim();
    if (!raw) return false;

    const priority = options.priority || PRIORITY.NORMAL;
    const force = Boolean(options.force || options.bypassQueueLock);
    const sessionId = options.sessionId || 0;

    // Agar navbat qulflangan bo'lsa va force bo'lmasa
    if (this.isQueueLocked() && !force) {
      const rem = this.getLockRemainingSec();
      this.emit('blocked', { command: raw, remainingSec: rem });
      return false;
    }

    const item = {
      command: raw,
      priority,
      force,
      sessionId,
      addedAt: Date.now()
    };

    if (force || priority === PRIORITY.HIGH) {
      // Eng oldinga qo'yish
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
      // Prioritet bo'yicha saralash
      this.queue.sort((a, b) => a.priority - b.priority);
    }

    this.emit('enqueued', item);
    this.scheduleProcess(0);
    return true;
  }

  scheduleProcess(delayMs = 0) {
    if (this.processTimer) return;
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processNext();
    }, delayMs);
  }

  processNext() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - this.lastSentAt;
    if (timeSinceLast < this.minIntervalMs) {
      this.scheduleProcess(this.minIntervalMs - timeSinceLast);
      return;
    }

    // Navbat bloklanganligini tekshirish
    if (this.isQueueLocked()) {
      // Faqat force bo'lgan buyruqni topish
      const forceIndex = this.queue.findIndex(item => item.force);
      if (forceIndex === -1) {
        // Bloklangan davrda buyruqlar kutiladi
        return;
      }
      const [item] = this.queue.splice(forceIndex, 1);
      this.executeItem(item);
      return;
    }

    const item = this.queue.shift();
    this.executeItem(item);
  }

  executeItem(item) {
    this.lastSentAt = Date.now();
    if (this.sendFn) {
      try {
        this.sendFn(item.command, item);
        this.emit('executed', item);
      } catch (err) {
        this.emit('error', { item, error: err.message });
      }
    }

    if (this.queue.length > 0) {
      this.scheduleProcess(this.minIntervalMs);
    }
  }

  clear() {
    const droppedCount = this.queue.length;
    this.queue = [];
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    return droppedCount;
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      isLocked: this.isQueueLocked(),
      lockRemainingSec: this.getLockRemainingSec(),
      lockDurationMs: this.lockDurationMs
    };
  }
}

module.exports = {
  CommandQueue,
  PRIORITY
};
