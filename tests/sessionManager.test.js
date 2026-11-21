const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SessionManager = require('../core/sessionManager');

describe('SessionManager - Session ID & Stale Timer Invalidation', () => {
  test('startNewSession increments sessionId and resets timers', () => {
    const sm = new SessionManager();
    const id1 = sm.startNewSession('first_boot');
    assert.equal(id1, 1);
    assert.equal(sm.getCurrentSessionId(), 1);

    const id2 = sm.startNewSession('reconnect');
    assert.equal(id2, 2);
    assert.equal(sm.getCurrentSessionId(), 2);
  });

  test('Valid session timer fires successfully', async () => {
    const sm = new SessionManager();
    const sId = sm.startNewSession('test_run');
    let executed = false;

    await new Promise((resolve) => {
      sm.setTimeout(() => {
        executed = true;
        resolve();
      }, 30, sId);
    });

    assert.equal(executed, true);
  });

  test('Stale timer does NOT fire when session is invalidated before callback', async () => {
    const sm = new SessionManager();
    const oldSessionId = sm.startNewSession('old_session');
    let executed = false;

    // 50ms ga taymer qo'yamiz (masalan, 80s li /afk taymeri)
    sm.setTimeout(() => {
      executed = true;
    }, 50, oldSessionId);

    // 20ms dan keyin internet uzilib, yangi sessiya boshlandi
    await new Promise(r => setTimeout(r, 20));
    sm.startNewSession('reconnect_new_session');

    // 60ms kutamiz (jami 80ms)
    await new Promise(r => setTimeout(r, 60));

    // Eski sessiyaga tegishli callback bajarilmasligi kerak!
    assert.equal(executed, false, 'Eski sessiya taymeri noqonuniy bajarilib ketdi!');
  });

  test('clearAllTimers stops all pending timers', () => {
    const sm = new SessionManager();
    sm.startNewSession('multi_timer');
    sm.setTimeout(() => {}, 1000);
    sm.setTimeout(() => {}, 1000);
    sm.setInterval(() => {}, 1000);

    assert.equal(sm.getSessionStats().activeTimersCount, 3);
    const cleared = sm.clearAllTimers();
    assert.equal(cleared, 3);
    assert.equal(sm.getSessionStats().activeTimersCount, 0);
  });
});
