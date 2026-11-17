const test = require('node:test');
const assert = require('node:assert');
const { recognizeDigits } = require('../minecraft_bot');

test('Map Captcha OCR - basic verification', () => {
  assert.strictEqual(typeof recognizeDigits, 'function');
  // Empty buffer should return empty or null
  const emptyBuf = Buffer.alloc(128 * 128, 0);
  const res = recognizeDigits(128, 128, emptyBuf, 0, 0, 127, 0, 127);
  assert.ok(res === '' || res === null);
});
