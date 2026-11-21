const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const AfkManager = require('../managers/afkManager');

describe('AfkManager - Shard Stall & Gentle Anti-Kick', () => {
  test('verifyAfkMessage detects afk pool confirmation', () => {
    const am = new AfkManager();
    assert.equal(am.isAfkActive, false);

    const verified = am.verifyAfkMessage('Siz AFK hovuziga kirdingiz');
    assert.equal(verified, true);
    assert.equal(am.isAfkActive, true);
  });

  test('Shard increment updates lastShardTime', () => {
    const am = new AfkManager();
    let emitted = false;
    am.on('shardIncrement', () => { emitted = true; });

    am.onShardReceived(10, 6110);
    assert.equal(emitted, true);
    assert.ok(Date.now() - am.lastShardTime < 100);
  });

  test('checkShardStall triggers warning when threshold exceeded', () => {
    const am = new AfkManager({ stallThresholdMs: 1000 });
    am.isAfkActive = true;
    am.lastShardTime = Date.now() - 2000; // 2 soniya oldin kelgan

    let stallEvent = null;
    am.on('shardStallDetected', (e) => { stallEvent = e; });

    am.checkShardStall();
    assert.ok(stallEvent);
    assert.ok(stallEvent.elapsedMs >= 2000);
  });

  test('Gentle anti-kick runs look() safely without throwing', () => {
    const am = new AfkManager();
    let looked = false;
    const mockBot = {
      entity: { yaw: 1.5, pitch: 0.2 },
      look: (y, p, force, cb) => {
        looked = true;
        if (typeof cb === 'function') cb();
      }
    };

    am.setBot(mockBot);
    am.performGentleAntiKick();
    assert.equal(looked, true);
  });
});
