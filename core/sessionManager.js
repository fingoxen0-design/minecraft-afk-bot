const EventEmitter = require('events');

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.currentSessionId = 0;
    this.sessionStartedAt = 0;
    this.sessionReason = 'init';
    this.timers = new Map(); // timerId -> { type, handle, sessionId }
    this.nextTimerId = 1;
    this.sessionHistory = [];
    this.maxHistory = 50;
  }

  startNewSession(reason = 'new_connection') {
    // 1. Eski sessiyaga tegishli barcha taymerlarni tozalash
    this.clearAllTimers();

    // 2. Yangi sessiya ID
    this.currentSessionId += 1;
    this.sessionStartedAt = Date.now();
    this.sessionReason = reason;

    const sessionInfo = {
      sessionId: this.currentSessionId,
      startedAt: this.sessionStartedAt,
      reason
    };

    this.sessionHistory.push(sessionInfo);
    if (this.sessionHistory.length > this.maxHistory) {
      this.sessionHistory.shift();
    }

    this.emit('sessionStart', sessionInfo);
    return this.currentSessionId;
  }

  getCurrentSessionId() {
    return this.currentSessionId;
  }

  isSessionValid(sessionId) {
    return Boolean(sessionId && sessionId === this.currentSessionId);
  }

  setTimeout(callback, delayMs, boundSessionId = this.currentSessionId) {
    const timerId = this.nextTimerId++;
    const targetSessionId = boundSessionId;

    const handle = setTimeout(() => {
      this.timers.delete(timerId);
      // Agar callback bajarilayotgan paytda sessiya eskirgan bo'lsa, uni BAJARMASLIK
      if (!this.isSessionValid(targetSessionId)) {
        return;
      }
      try {
        callback();
      } catch (err) {
        console.error(`[SessionManager] Taymer xatoligi (Session ${targetSessionId}):`, err);
      }
    }, delayMs);

    this.timers.set(timerId, { type: 'timeout', handle, sessionId: targetSessionId });
    return timerId;
  }

  setInterval(callback, intervalMs, boundSessionId = this.currentSessionId) {
    const timerId = this.nextTimerId++;
    const targetSessionId = boundSessionId;

    const handle = setInterval(() => {
      // Agar sessiya o'zgargan bo'lsa intervalni to'xtatish
      if (!this.isSessionValid(targetSessionId)) {
        this.clearInterval(timerId);
        return;
      }
      try {
        callback();
      } catch (err) {
        console.error(`[SessionManager] Interval xatoligi (Session ${targetSessionId}):`, err);
      }
    }, intervalMs);

    this.timers.set(timerId, { type: 'interval', handle, sessionId: targetSessionId });
    return timerId;
  }

  clearTimeout(timerId) {
    if (!this.timers.has(timerId)) return false;
    const item = this.timers.get(timerId);
    clearTimeout(item.handle);
    this.timers.delete(timerId);
    return true;
  }

  clearInterval(timerId) {
    if (!this.timers.has(timerId)) return false;
    const item = this.timers.get(timerId);
    clearInterval(item.handle);
    this.timers.delete(timerId);
    return true;
  }

  clearTimersForSession(sessionId) {
    let count = 0;
    for (const [timerId, item] of this.timers.entries()) {
      if (item.sessionId === sessionId) {
        if (item.type === 'timeout') clearTimeout(item.handle);
        if (item.type === 'interval') clearInterval(item.handle);
        this.timers.delete(timerId);
        count++;
      }
    }
    return count;
  }

  clearAllTimers() {
    let count = 0;
    for (const [timerId, item] of this.timers.entries()) {
      if (item.type === 'timeout') clearTimeout(item.handle);
      if (item.type === 'interval') clearInterval(item.handle);
      count++;
    }
    this.timers.clear();
    return count;
  }

  getSessionStats() {
    return {
      currentSessionId: this.currentSessionId,
      sessionStartedAt: this.sessionStartedAt,
      sessionUptimeSec: this.sessionStartedAt ? Math.floor((Date.now() - this.sessionStartedAt) / 1000) : 0,
      sessionReason: this.sessionReason,
      activeTimersCount: this.timers.size,
      sessionHistory: [...this.sessionHistory]
    };
  }
}

module.exports = SessionManager;
