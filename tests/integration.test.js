const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const Minecraft247Bot = require('../bot');
const { BOT_STATES, SERVER_STATES, CONNECTION_STATES, AFK_STATES } = require('../core/stateManager');

describe('Full Lifecycle Integration - Connect -> Lobby -> Queue -> Economy -> AFK -> Fallback', () => {
  test('Simulated Minecraft Server packet flow through SingleBotInstance', async () => {
    const supervisor = new Minecraft247Bot();
    const instance = supervisor.primaryBot;

    // Mock Mineflayer bot with EventEmitter
    const mockBot = new EventEmitter();
    mockBot.username = 'Gotto';
    mockBot.health = 20;
    mockBot.food = 20;
    mockBot.entity = { yaw: 0, pitch: 0, position: { distanceTo: () => 5 } };
    mockBot.players = { Gotto: {}, Fingoxenpro: {} };
    mockBot._client = new EventEmitter();

    const sentCommands = [];
    mockBot.chat = (msg) => { sentCommands.push(msg); };
    mockBot.quit = () => { mockBot.emit('end', 'quit_called'); };

    // Set mock bot and start valid session
    const sId = instance.sessionManager.startNewSession('integration_test');
    instance.stateManager.setBotState(BOT_STATES.CONNECTING);
    instance.bot = mockBot;
    instance.setupEvents(sId);

    // 1. Spawn event (Serverga ulandi)
    mockBot.emit('spawn');
    assert.equal(instance.stateManager.connectionState, CONNECTION_STATES.CONNECTED);
    assert.equal(instance.stateManager.botState, BOT_STATES.AUTHENTICATING);

    // 2. /login yuborilishi (Mock timer orqali)
    await new Promise(r => setTimeout(r, 2050));
    assert.ok(sentCommands.some(c => c.startsWith('/login')), '/login yuborilishi shart edi');

    // 3. /server economy va 80s navbat
    await new Promise(r => setTimeout(r, 3100));
    assert.ok(sentCommands.includes('/server economy'), '/server economy yuborilishi shart edi');
    assert.equal(instance.isQueueWaiting, true);
    assert.equal(instance.stateManager.botState, BOT_STATES.QUEUE_WAIT);

    // 4. Navbat paytida oddiy chat kick bo'lmasligi uchun bloklanadi
    const blockedRes = instance.safeChat('salom bot navbatda');
    assert.equal(blockedRes, false);

    // 5. Server almashdi (respawn paketi keldi)
    mockBot.emit('respawn');
    assert.equal(instance.isQueueWaiting, false, 'Respawn kelgach navbat qulfi ochilishi kerak');
    assert.equal(instance.stateManager.serverState, SERVER_STATES.ECONOMY);
    assert.equal(instance.stateManager.botState, BOT_STATES.VERIFYING_ECONOMY);

    // 6. AFK faollashuvi
    await new Promise(r => setTimeout(r, 3600));
    assert.ok(sentCommands.includes('/afk'), '/afk yuborilishi shart edi');
    assert.equal(instance.stateManager.botState, BOT_STATES.AFK_ACTIVE);
    assert.equal(instance.isAfk, true);

    // 7. Shard accrual (+10 Shards keldi)
    const prevShards = supervisor.shardTracker.state.total_shards;
    mockBot.emit('messagestr', '+10 Shards berildi');
    assert.equal(supervisor.shardTracker.state.total_shards, prevShards + 10);

    // 8. Egasi TPA so'radi
    mockBot.emit('messagestr', 'Fingoxenpro has requested to teleport to you.');
    assert.ok(sentCommands.includes('/tpaccept'), 'Egasi TPA so\'raganda /tpaccept bajarilishi kerak');

    // 9. Practice / KitPvP falokatiga tushib qolganda toza tiklanish (Quit va Reconnect)
    let reconnectCalled = false;
    instance.reconnect = () => { reconnectCalled = true; };
    mockBot.emit('messagestr', 'Player was killed in Mace FFA arena.');
    assert.equal(reconnectCalled, true, 'Practice aniqlanganda toza qayta ulanish chaqirilishi shart');

    instance.cleanup();
  });
});
