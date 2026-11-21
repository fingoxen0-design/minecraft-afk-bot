const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const RecoveryManager = require('../managers/recoveryManager');

describe('RecoveryManager - Exponential Backoff & Fallback Safety', () => {
  test('Exponential backoff increments correctly up to maxDelayMs', () => {
    const rm = new RecoveryManager({
      initialDelayMs: 2000,
      backoffFactor: 2.0,
      maxDelayMs: 10000
    });

    assert.equal(rm.getBackoffDelay(), 2000);
    assert.equal(rm.getBackoffDelay(), 4000);
    assert.equal(rm.getBackoffDelay(), 8000);
    assert.equal(rm.getBackoffDelay(), 10000); // capped at max
    assert.equal(rm.getBackoffDelay(), 10000);

    rm.resetBackoff();
    assert.equal(rm.getBackoffDelay(), 2000);
  });

  test('Restart lock prevents concurrent restart executions', () => {
    const rm = new RecoveryManager();

    assert.equal(rm.acquireRestartLock(), true);
    assert.equal(rm.acquireRestartLock(), false, 'Ikkinchi marta lock berilmasligi kerak');

    rm.releaseRestartLock();
    assert.equal(rm.acquireRestartLock(), true);
  });

  test('Economy verification timeout triggers failure event', async () => {
    const rm = new RecoveryManager({ verificationTimeoutMs: 50 });
    let failedEvent = false;

    await new Promise((resolve) => {
      rm.on('economyVerificationFailed', () => {
        failedEvent = true;
        resolve();
      });
      rm.startEconomyVerification();
    });

    assert.equal(failedEvent, true);
  });

  test('Economy verification success cancels timeout', async () => {
    const rm = new RecoveryManager({ verificationTimeoutMs: 100 });
    let failedEvent = false;
    let successEvent = false;

    rm.on('economyVerificationFailed', () => { failedEvent = true; });
    rm.on('economyVerificationSuccess', () => { successEvent = true; });

    rm.startEconomyVerification();
    rm.confirmEconomySuccess();

    await new Promise(r => setTimeout(r, 120));

    assert.equal(successEvent, true);
    assert.equal(failedEvent, false, 'Muvaffaqiyatli tasdiqlangach fail event chaqirilmasligi kerak');
  });
});
