const test = require('node:test');
const assert = require('node:assert');
const { recognizeDigits } = require('../minecraft_bot');
const { createMapPng, solveMapWithOcr } = require('../captchaSolver');

test('Map Captcha OCR - basic verification', () => {
  assert.strictEqual(typeof recognizeDigits, 'function');
  const emptyBuf = Buffer.alloc(128 * 128, 0);
  const res = recognizeDigits(128, 128, emptyBuf, 0, 0, 127, 0, 127);
  assert.ok(res === '' || res === null);
});

test('Map Captcha PNG Generator - creates valid PNG', () => {
  assert.strictEqual(typeof createMapPng, 'function');
  const buf = Buffer.alloc(128 * 128, 34);
  buf[50 * 128 + 50] = 65;
  const png = createMapPng(128, 128, buf, 2);
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 100);
  // PNG signature
  assert.strictEqual(png[0], 0x89);
  assert.strictEqual(png[1], 0x50);
  assert.strictEqual(png[2], 0x4e);
  assert.strictEqual(png[3], 0x47);
});

test('Map Captcha Solver - handles null gracefully', async () => {
  assert.strictEqual(typeof solveMapWithOcr, 'function');
  const res = await solveMapWithOcr(null);
  assert.strictEqual(res, null);
});
