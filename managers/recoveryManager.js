const EventEmitter = require('events');

class RecoveryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.initialDelayMs = options.initialDelayMs || 3000;
    this.maxDelayMs = options.maxDelayMs || 60000;
    this.backoffFactor = options.backoffFactor || 2.0;

    this.currentDelayMs = this.initialDelayMs;
    this.retryCount = 0;
    this.isReconnecting = false;
    this.restartLock = false;

    // Economy tasdiqlash taymeri
    this.verificationTimeoutMs = options.verificationTimeoutMs || 90000; // 90 soniya
    this.economyVerificationTimer = null;
    this.isVerifyingEconomy = false;
  }

  getBackoffDelay() {
    const delay = this.currentDelayMs;
    this.currentDelayMs = Math.min(this.maxDelayMs, Math.round(this.currentDelayMs * this.backoffFactor));
    this.retryCount++;
    return delay;
  }

  resetBackoff() {
    this.currentDelayMs = this.initialDelayMs;
    this.retryCount = 0;
    this.isReconnecting = false;
  }

  acquireRestartLock() {
    if (this.restartLock) {
      return false; // Lock allaqachon olingan
    }
    this.restartLock = true;
    return true;
  }

  releaseRestartLock() {
    this.restartLock = false;
  }

  startEconomyVerification(onTimeoutCallback) {
    this.stopEconomyVerification();
    this.isVerifyingEconomy = true;

    this.economyVerificationTimer = setTimeout(() => {
      this.isVerifyingEconomy = false;
      this.economyVerificationTimer = null;
      this.emit('economyVerificationFailed', { timeoutMs: this.verificationTimeoutMs });
      if (typeof onTimeoutCallback === 'function') {
        onTimeoutCallback();
      }
    }, this.verificationTimeoutMs);
  }

  confirmEconomySuccess() {
    if (this.isVerifyingEconomy) {
      this.stopEconomyVerification();
      this.resetBackoff();
      this.emit('economyVerificationSuccess');
      return true;
    }
    return false;
  }

  stopEconomyVerification() {
    if (this.economyVerificationTimer) {
      clearTimeout(this.economyVerificationTimer);
      this.economyVerificationTimer = null;
    }
    this.isVerifyingEconomy = false;
  }

  handlePracticeDetected(botInstance) {
    console.warn('[RecoveryManager] ⚠️ Practice/Hub aniqlandi! Economy serverga qaytish uchun toza qayta ulanish boshlanmoqda.');
    this.emit('practiceRecoveryTriggered');
    if (botInstance && typeof botInstance.reconnect === 'function') {
      botInstance.reconnect(2000, 'practice_detected_fallback');
    }
  }

  getStats() {
    return {
      retryCount: this.retryCount,
      currentDelayMs: this.currentDelayMs,
      isReconnecting: this.isReconnecting,
      restartLock: this.restartLock,
      isVerifyingEconomy: this.isVerifyingEconomy
    };
  }
}

module.exports = RecoveryManager;
