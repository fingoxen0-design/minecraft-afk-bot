const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const VoteTracker = require('../voteTracker');

const testStateFile = path.resolve(__dirname, 'test_vote_state.json');

function cleanup() {
  if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile);
  const tmp = `${testStateFile}.tmp`;
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
}

test('VoteTracker - parseTimeFromUrlOrText', () => {
  const tracker = new VoteTracker(testStateFile);
  assert.strictEqual(tracker.parseTimeFromUrlOrText('https://minecraft-mp.com/server/350645/vote/?error=2&time=1794836617'), 1794836617);
  assert.strictEqual(tracker.parseTimeFromUrlOrText('1794836617'), 1794836617);
  assert.strictEqual(tracker.parseTimeFromUrlOrText('invalid'), null);
  cleanup();
});

test('VoteTracker - recordVote & cooldown', () => {
  cleanup();
  const tracker = new VoteTracker(testStateFile);
  assert.strictEqual(tracker.isTimeToVote(1), true);

  tracker.recordVote(1, null, 15.0);
  assert.strictEqual(tracker.isTimeToVote(1), false);
  const rem = tracker.getRemainingSeconds(1);
  assert.ok(rem > 14 * 3600 && rem <= 15 * 3600);
  assert.ok(tracker.formatRemainingTime(1).includes('soat'));

  cleanup();
});

test('VoteTracker - 4 independent slots', () => {
  cleanup();
  const tracker = new VoteTracker(testStateFile);

  tracker.setVoteUrl(1, 'https://v1.com', 'Site 1');
  tracker.setVoteUrl(2, 'https://v2.com', 'Site 2');
  tracker.setVoteUrl(3, 'https://v3.com', 'Site 3');
  tracker.setVoteUrl(4, 'https://v4.com', 'Site 4');

  assert.strictEqual(tracker.getVoteUrl(1), 'https://v1.com');
  assert.strictEqual(tracker.getVoteUrl(2), 'https://v2.com');
  assert.strictEqual(tracker.getVoteUrl(3), 'https://v3.com');
  assert.strictEqual(tracker.getVoteUrl(4), 'https://v4.com');

  tracker.recordVote(2, null, 10.0);
  assert.strictEqual(tracker.isTimeToVote(1), true);
  assert.strictEqual(tracker.isTimeToVote(2), false);
  assert.strictEqual(tracker.isTimeToVote(3), true);
  assert.strictEqual(tracker.isTimeToVote(4), true);

  const summary = tracker.getSummary();
  assert.strictEqual(summary.total_slots, 4);
  assert.strictEqual(summary.ready_count, 3);
  cleanup();
});
