const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ChatManager = require('../managers/chatManager');

describe('ChatManager - Formatting, Ranks, Deduplication, TPA & Owner Auth', () => {
  test('stripColors removes Minecraft color and style codes', () => {
    const cm = new ChatManager();
    const raw = '§a[§6OWNER§a] §eFingoxenpro §f» §b!afk';
    assert.equal(cm.stripColors(raw), '[OWNER] Fingoxenpro » !afk');
  });

  test('stripRanks isolates pure player username', () => {
    const cm = new ChatManager();
    assert.equal(cm.stripRanks('[OWNER] Fingoxenpro »'), 'Fingoxenpro');
    assert.equal(cm.stripRanks('[VIP+] Bunyod:'), 'Bunyod');
    assert.equal(cm.stripRanks('<ADMIN> Player'), 'Player');
  });

  test('Parses private message [MSG] and triggers owner command', () => {
    const cm = new ChatManager({
      botUsername: 'Gotto',
      owners: ['fingoxenpro']
    });

    let detectedCmd = null;
    cm.on('ownerCommand', (e) => { detectedCmd = e; });

    const raw = '[MSG] Fingoxenpro » Gotto: !afk';
    const res = cm.parseMessage(raw);

    assert.equal(res.type, 'whisper');
    assert.equal(res.sender.toLowerCase(), 'fingoxenpro');
    assert.equal(res.isOwner, true);
    assert.equal(detectedCmd.command, 'afk');
  });

  test('Parses public chat and authenticates owner vs non-owner', () => {
    const cm = new ChatManager({
      botUsername: 'Gotto',
      owners: ['fingoxenpro']
    });

    let cmdCount = 0;
    cm.on('ownerCommand', () => { cmdCount++; });

    // Begona o'yinchi buyruq bersa
    cm.parseMessage('[VIP] Stranger: !afk');
    assert.equal(cmdCount, 0, 'Begona o\'yinchi buyrug\'i qabul qilinmasligi kerak');

    // Egasi buyruq bersa
    cm.parseMessage('[OWNER] Fingoxenpro » !afk');
    assert.equal(cmdCount, 1, 'Egasi buyrug\'i bajarilishi kerak');
  });

  test('Ignores self-messages from bot itself', () => {
    const cm = new ChatManager({
      botUsername: 'Gotto',
      owners: ['gotto', 'fingoxenpro']
    });

    let messageFired = false;
    cm.on('message', () => { messageFired = true; });

    const res = cm.parseMessage('Gotto: Salom hammaga');
    assert.equal(res.isSelf, true);
    assert.equal(messageFired, false, 'Botning o\'z xabari message event chaqirmasligi kerak');
  });

  test('Suppresses duplicate messages within dedup window', () => {
    const cm = new ChatManager({ dedupWindowMs: 500 });
    const raw = 'Fingoxenpro: !afk';

    const first = cm.parseMessage(raw);
    assert.equal(first.isDuplicate, undefined);

    const second = cm.parseMessage(raw);
    assert.equal(second.isDuplicate, true, 'Bir xil xabar 500ms ichida deduplikatsiya qilinishi shart');
  });

  test('TPA request detection checks owner authorization', () => {
    const cm = new ChatManager({
      botUsername: 'Gotto',
      owners: ['fingoxenpro']
    });

    let tpaEvent = null;
    cm.on('tpaRequest', (e) => { tpaEvent = e; });

    cm.parseMessage('Fingoxenpro has requested to teleport to you.');
    assert.equal(tpaEvent.sender, 'Fingoxenpro');
    assert.equal(tpaEvent.isOwner, true);

    cm.parseMessage('Griefer123 has requested to teleport to you.');
    assert.equal(tpaEvent.sender, 'Griefer123');
    assert.equal(tpaEvent.isOwner, false);
  });

  test('Practice/KitPvP message detection', () => {
    const cm = new ChatManager();
    let practiceDetected = false;
    cm.on('practiceSignal', () => { practiceDetected = true; });

    cm.parseMessage('Player1 was killed by Player2 in Mace FFA arena.');
    assert.equal(practiceDetected, true);
  });
});
