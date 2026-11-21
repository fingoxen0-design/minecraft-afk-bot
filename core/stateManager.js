const EventEmitter = require('events');

const BOT_STATES = Object.freeze({
  OFFLINE: 'OFFLINE',
  CONNECTING: 'CONNECTING',
  AUTHENTICATING: 'AUTHENTICATING',
  LOBBY: 'LOBBY',
  QUEUE_WAIT: 'QUEUE_WAIT',
  VERIFYING_ECONOMY: 'VERIFYING_ECONOMY',
  ACTIVATING_AFK: 'ACTIVATING_AFK',
  AFK_ACTIVE: 'AFK_ACTIVE',
  RECOVERING: 'RECOVERING',
  COOLDOWN: 'COOLDOWN',
  STOPPED: 'STOPPED'
});

const SERVER_STATES = Object.freeze({
  LOBBY: 'lobby',
  ECONOMY: 'economy',
  PRACTICE: 'practice',
  UNKNOWN: 'unknown'
});

const CONNECTION_STATES = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected'
});

const AFK_STATES = Object.freeze({
  INACTIVE: 'inactive',
  PENDING: 'pending',
  ACTIVE: 'active'
});

// Qonuniy holat o'tishlari xaritasi
const VALID_TRANSITIONS = {
  [BOT_STATES.OFFLINE]: [BOT_STATES.CONNECTING, BOT_STATES.STOPPED],
  [BOT_STATES.CONNECTING]: [BOT_STATES.AUTHENTICATING, BOT_STATES.LOBBY, BOT_STATES.RECOVERING, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.AUTHENTICATING]: [BOT_STATES.LOBBY, BOT_STATES.QUEUE_WAIT, BOT_STATES.VERIFYING_ECONOMY, BOT_STATES.RECOVERING, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.LOBBY]: [BOT_STATES.QUEUE_WAIT, BOT_STATES.VERIFYING_ECONOMY, BOT_STATES.RECOVERING, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.QUEUE_WAIT]: [BOT_STATES.VERIFYING_ECONOMY, BOT_STATES.ACTIVATING_AFK, BOT_STATES.AFK_ACTIVE, BOT_STATES.RECOVERING, BOT_STATES.LOBBY, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.VERIFYING_ECONOMY]: [BOT_STATES.ACTIVATING_AFK, BOT_STATES.AFK_ACTIVE, BOT_STATES.QUEUE_WAIT, BOT_STATES.RECOVERING, BOT_STATES.LOBBY, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.ACTIVATING_AFK]: [BOT_STATES.AFK_ACTIVE, BOT_STATES.VERIFYING_ECONOMY, BOT_STATES.RECOVERING, BOT_STATES.LOBBY, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.AFK_ACTIVE]: [BOT_STATES.ACTIVATING_AFK, BOT_STATES.RECOVERING, BOT_STATES.LOBBY, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.RECOVERING]: [BOT_STATES.COOLDOWN, BOT_STATES.CONNECTING, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.COOLDOWN]: [BOT_STATES.CONNECTING, BOT_STATES.STOPPED, BOT_STATES.OFFLINE],
  [BOT_STATES.STOPPED]: [BOT_STATES.CONNECTING, BOT_STATES.OFFLINE]
};

class StateManager extends EventEmitter {
  constructor(initialBotState = BOT_STATES.OFFLINE) {
    super();
    this.botState = initialBotState;
    this.serverState = SERVER_STATES.UNKNOWN;
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.afkState = AFK_STATES.INACTIVE;
    this.lastStateChange = Date.now();
    this.history = [];
    this.maxHistory = 100;
  }

  canTransitionTo(newState) {
    if (newState === this.botState) return true;
    const allowed = VALID_TRANSITIONS[this.botState] || [];
    return allowed.includes(newState);
  }

  setBotState(newState, reason = '') {
    if (!BOT_STATES[newState]) {
      console.warn(`[StateManager] Noma'lum bot holati: ${newState}`);
      return false;
    }

    if (this.botState === newState) {
      return true;
    }

    if (!this.canTransitionTo(newState)) {
      console.warn(`[StateManager] Qoidabuzar o'tish: ${this.botState} -> ${newState} (${reason || 'sababsiz'})`);
      // Favqulodda to'xtatish yoki tiklanish har doim ruxsat etiladi
      if (newState !== BOT_STATES.STOPPED && newState !== BOT_STATES.RECOVERING && newState !== BOT_STATES.OFFLINE) {
        return false;
      }
    }

    const prevState = this.botState;
    this.botState = newState;
    this.lastStateChange = Date.now();

    this.recordHistory('botState', prevState, newState, reason);
    this.emit('stateChange', { from: prevState, to: newState, reason, timestamp: this.lastStateChange });
    return true;
  }

  setServerState(newServer, reason = '') {
    if (this.serverState === newServer) return true;
    const prev = this.serverState;
    this.serverState = newServer;
    this.recordHistory('serverState', prev, newServer, reason);
    this.emit('serverChange', { from: prev, to: newServer, reason, timestamp: Date.now() });
    return true;
  }

  setConnectionState(newConnection, reason = '') {
    if (this.connectionState === newConnection) return true;
    const prev = this.connectionState;
    this.connectionState = newConnection;
    this.recordHistory('connectionState', prev, newConnection, reason);
    this.emit('connectionChange', { from: prev, to: newConnection, reason, timestamp: Date.now() });
    return true;
  }

  setAfkState(newAfk, reason = '') {
    if (this.afkState === newAfk) return true;
    const prev = this.afkState;
    this.afkState = newAfk;
    this.recordHistory('afkState', prev, newAfk, reason);
    this.emit('afkChange', { from: prev, to: newAfk, reason, timestamp: Date.now() });
    return true;
  }

  recordHistory(type, from, to, reason) {
    this.history.push({
      timestamp: Date.now(),
      type,
      from,
      to,
      reason
    });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  getState() {
    return {
      botState: this.botState,
      serverState: this.serverState,
      connectionState: this.connectionState,
      afkState: this.afkState,
      lastStateChange: this.lastStateChange,
      uptimeInState: Math.floor((Date.now() - this.lastStateChange) / 1000)
    };
  }

  reset() {
    this.botState = BOT_STATES.OFFLINE;
    this.serverState = SERVER_STATES.UNKNOWN;
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.afkState = AFK_STATES.INACTIVE;
    this.lastStateChange = Date.now();
    this.history = [];
  }
}

module.exports = {
  StateManager,
  BOT_STATES,
  SERVER_STATES,
  CONNECTION_STATES,
  AFK_STATES,
  VALID_TRANSITIONS
};
