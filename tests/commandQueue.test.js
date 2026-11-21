const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CommandQueue, PRIORITY } = require('../core/commandQueue');

describe('CommandQueue - Priorities & Velocity Queue Lock', () => {
  test('FIFO execution with minIntervalMs spacing', async () => {
    const executed = [];
    const queue = new CommandQueue({
      minIntervalMs: 20,
      sendFn: (cmd) => executed.push(cmd)
    });

    queue.enqueue('msg 1');
    queue.enqueue('msg 2');

    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(executed, ['msg 1', 'msg 2']);
  });

  test('Priority HIGH jumps ahead of NORMAL', async () => {
    const executed = [];
    const queue = new CommandQueue({
      minIntervalMs: 25,
      sendFn: (cmd) => executed.push(cmd)
    });

    queue.enqueue('normal 1', { priority: PRIORITY.NORMAL });
    queue.enqueue('normal 2', { priority: PRIORITY.NORMAL });
    queue.enqueue('high priority', { priority: PRIORITY.HIGH });

    await new Promise(r => setTimeout(r, 90));

    // 'high priority' unshift qilinganligi sababli oldin bajariladi
    assert.equal(executed[0], 'high priority');
  });

  test('Queue lock blocks normal commands and allows force commands', async () => {
    const executed = [];
    const blocked = [];
    const queue = new CommandQueue({
      minIntervalMs: 15,
      sendFn: (cmd) => executed.push(cmd)
    });

    queue.on('blocked', (data) => blocked.push(data.command));

    // 80s navbatni qulflash
    queue.setLock(true, 80000);
    assert.equal(queue.isQueueLocked(), true);

    // Oddiy xabar - bloklanishi kerak
    const res1 = queue.enqueue('hello during queue', { force: false });
    assert.equal(res1, false);
    assert.equal(blocked.includes('hello during queue'), true);

    // Majburiy xabar (masalan: ichki tizim signali) - o'tishi kerak
    const res2 = queue.enqueue('/login bunyod', { force: true });
    assert.equal(res2, true);

    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(executed, ['/login bunyod']);

    // Navbat ochilganda oddiy xabarlar o'tadi
    queue.setLock(false);
    assert.equal(queue.isQueueLocked(), false);

    queue.enqueue('hello after queue');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(executed.includes('hello after queue'), true);
  });
});
