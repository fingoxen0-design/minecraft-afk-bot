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

  // Bot assertions
  assert.ok(Array.isArray(status.bots));
  assert.strictEqual(status.bots.length, 1);
  assert.strictEqual(status.bots[0].username, 'Gotto');
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

test('Minecraft247Bot - clean text extraction from NBT/Compound', () => {
  const extractCleanText = Minecraft247Bot.extractCleanText;
  assert.ok(typeof extractCleanText === 'function');

  const compound1 = {
    text: {
      type: 'compound',
      value: {
        color: { type: 'string', value: 'red' },
        text: { type: 'string', value: 'You are already logged in!' }
      }
    }
  };
  assert.strictEqual(extractCleanText(compound1), 'You are already logged in!');

  const emptyCompound = { text: { type: 'string', value: '' } };
  assert.strictEqual(extractCleanText(emptyCompound), '');

  const formattedStr = '§aWELCOME§r to §6AllaySMP!';
  assert.strictEqual(extractCleanText(formattedStr), 'WELCOME to AllaySMP!');
});

test('Minecraft247Bot - normalizeCommand cleans legacy telegram /cmd, /say and adds leading slash', () => {
  const normalize = Minecraft247Bot.normalizeCommand;
  assert.ok(typeof normalize === 'function');

  // Telegram /cmd leftovers
  assert.strictEqual(normalize('/cmd tpaccept'), '/tpaccept');
  assert.strictEqual(normalize('/cmd home 1'), '/home 1');
  assert.strictEqual(normalize('/CMD /home 1'), '/home 1');
  assert.strictEqual(normalize('/cmd'), '');

  // Telegram /say leftovers
  assert.strictEqual(normalize('/say salom do\'stlar'), 'salom do\'stlar');

  // Known commands missing leading slash
  assert.strictEqual(normalize('home 1'), '/home 1');
  assert.strictEqual(normalize('tpaccept'), '/tpaccept');
  assert.strictEqual(normalize('afk'), '/afk');
  assert.strictEqual(normalize('tpa Fingoxenpro'), '/tpa Fingoxenpro');
  assert.strictEqual(normalize('spawn'), '/spawn');
  assert.strictEqual(normalize('balance'), '/balance');

  // Normal chat or already slashed commands
  assert.strictEqual(normalize('/home 1'), '/home 1');
  assert.strictEqual(normalize('/tpahere Fingoxenpro'), '/tpahere Fingoxenpro');
  assert.strictEqual(normalize(''), '');
});
