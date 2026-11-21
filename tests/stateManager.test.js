const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { StateManager, BOT_STATES, SERVER_STATES, CONNECTION_STATES, AFK_STATES } = require('../core/stateManager');

describe('StateManager - 11 States & Orthogonal Dimensions', () => {
  test('Initial state is OFFLINE and orthogonal states are default', () => {
    const sm = new StateManager();
    const state = sm.getState();
    assert.equal(state.botState, BOT_STATES.OFFLINE);
    assert.equal(state.serverState, SERVER_STATES.UNKNOWN);
    assert.equal(state.connectionState, CONNECTION_STATES.DISCONNECTED);
    assert.equal(state.afkState, AFK_STATES.INACTIVE);
  });

  test('Valid transitions follow normal bot lifecycle', () => {
    const sm = new StateManager();

    assert.equal(sm.setBotState(BOT_STATES.CONNECTING, 'start() called'), true);
    assert.equal(sm.setBotState(BOT_STATES.AUTHENTICATING, 'spawn event'), true);
    assert.equal(sm.setBotState(BOT_STATES.LOBBY, 'logged in'), true);
    assert.equal(sm.setBotState(BOT_STATES.QUEUE_WAIT, '/server economy sent'), true);
    assert.equal(sm.setBotState(BOT_STATES.VERIFYING_ECONOMY, '80s elapsed'), true);
    assert.equal(sm.setBotState(BOT_STATES.ACTIVATING_AFK, 'economy confirmed, /afk sent'), true);
    assert.equal(sm.setBotState(BOT_STATES.AFK_ACTIVE, 'afk pool confirmed'), true);

    const st = sm.getState();
    assert.equal(st.botState, BOT_STATES.AFK_ACTIVE);
  });

  test('Illegal transition is rejected', () => {
    const sm = new StateManager(BOT_STATES.OFFLINE);
    // OFFLINE to AFK_ACTIVE directly is illegal
    const res = sm.setBotState(BOT_STATES.AFK_ACTIVE, 'teleport cheat');
    assert.equal(res, false);
    assert.equal(sm.getState().botState, BOT_STATES.OFFLINE);
  });

  test('Emergency recovery and stop are allowed from any state', () => {
    const sm = new StateManager(BOT_STATES.QUEUE_WAIT);
    assert.equal(sm.setBotState(BOT_STATES.RECOVERING, 'disconnect during queue'), true);
    assert.equal(sm.getState().botState, BOT_STATES.RECOVERING);

    assert.equal(sm.setBotState(BOT_STATES.STOPPED, 'manual stop'), true);
    assert.equal(sm.getState().botState, BOT_STATES.STOPPED);
  });

  test('Orthogonal states update independently and emit events', () => {
    const sm = new StateManager();
    let emittedServer = null;
    let emittedConnection = null;
    let emittedAfk = null;

    sm.on('serverChange', e => { emittedServer = e.to; });
    sm.on('connectionChange', e => { emittedConnection = e.to; });
    sm.on('afkChange', e => { emittedAfk = e.to; });

    sm.setServerState(SERVER_STATES.ECONOMY, 'joined subserver');
    sm.setConnectionState(CONNECTION_STATES.CONNECTED, 'socket ready');
    sm.setAfkState(AFK_STATES.ACTIVE, 'pool verified');

    assert.equal(emittedServer, SERVER_STATES.ECONOMY);
    assert.equal(emittedConnection, CONNECTION_STATES.CONNECTED);
    assert.equal(emittedAfk, AFK_STATES.ACTIVE);

    const st = sm.getState();
    assert.equal(st.serverState, SERVER_STATES.ECONOMY);
    assert.equal(st.connectionState, CONNECTION_STATES.CONNECTED);
    assert.equal(st.afkState, AFK_STATES.ACTIVE);
  });
});
