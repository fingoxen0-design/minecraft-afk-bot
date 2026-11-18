const test = require('node:test');
const assert = require('node:assert');
const Minecraft247Bot = require('../bot');

test('Minecraft247Bot - initialization and status', () => {
  const bot = new Minecraft247Bot();
  const status = bot.getSystemStatus();

  assert.strictEqual(status.bot.status, 'stopped');
  assert.strictEqual(status.bot.username, 'Gotto');
  assert.strictEqual(status.bot.host, 'allaysmp.pro');
  assert.strictEqual(status.vote.total_slots, 4);

  // Multi-bot assertions
  assert.ok(Array.isArray(status.bots));
  assert.strictEqual(status.bots.length, 2);
  assert.strictEqual(status.bots[0].username, 'Gotto');
  assert.strictEqual(status.bots[1].username, 'fingoxenPro');
});

test('Minecraft247Bot - web actions routing', () => {
  const bot = new Minecraft247Bot();

  // Test vote recording via web action
  const voteRes = bot.handleWebAction('/api/vote/record', { vote_id: 1 });
  assert.strictEqual(voteRes.success, true);
  assert.strictEqual(bot.tracker.isTimeToVote(1), false);

  // Test chat when bot offline
  const chatRes = bot.handleWebAction('/api/bot/chat', { text: 'Hello' });
  assert.strictEqual(chatRes.success, false);

  // Test set url
  const urlRes = bot.handleWebAction('/api/vote/set_url', { vote_id: 2, url: 'https://test2.com', name: 'Server 2' });
  assert.strictEqual(urlRes.success, true);
  assert.strictEqual(bot.tracker.getVoteUrl(2), 'https://test2.com');
});
