const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ShardTracker = require('../shardTracker');

test('ShardTracker - addShards, formatting and state persistence', () => {
  const tmpPath = path.resolve(__dirname, 'test_shard_state.json');
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const tracker = new ShardTracker(tmpPath);
  assert.strictEqual(tracker.state.total_shards, 6100);
  assert.strictEqual(tracker.formatCount(6100), '6.1K');

  tracker.addShards(10, 'afk_pool');
  assert.strictEqual(tracker.state.total_shards, 6110);
  assert.strictEqual(tracker.state.session_shards, 10);

  // Reload from file
  const tracker2 = new ShardTracker(tmpPath);
  assert.strictEqual(tracker2.state.total_shards, 6110);
  assert.strictEqual(tracker2.state.session_shards, 10);

  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
});

test('ShardTracker - parseChat messages', () => {
  const tmpPath = path.resolve(__dirname, 'test_shard_state_2.json');
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const tracker = new ShardTracker(tmpPath);

  // Test +10 shards
  const res1 = tracker.parseChat('§a+10 Shards §7(AFK Reward)');
  assert.ok(res1);
  assert.strictEqual(res1.amount, 10);
  assert.strictEqual(tracker.state.session_shards, 10);

  // Test balance sync
  const res2 = tracker.parseChat('§6Shards: 6,250');
  assert.ok(res2);
  assert.strictEqual(tracker.state.total_shards, 6250);

  // Test AllaySMP actual server message
  const resAllay = tracker.parseChat('AFK • You have: ★6.1K Shard');
  assert.ok(resAllay);
  assert.strictEqual(tracker.state.total_shards, 6100);

  const resAllay2 = tracker.parseChat('AFK • You have: ★755 Shard');
  assert.ok(resAllay2);
  assert.strictEqual(tracker.state.total_shards, 755);

  // Non-shard message should return false
  const res3 = tracker.parseChat('Random chat message');
  assert.strictEqual(res3, false);

  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
});
