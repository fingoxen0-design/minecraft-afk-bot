const zlib = require('zlib');
const crypto = require('crypto');

// CRC32 hisoblash
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) >>> 0;
}

// PNG Chunk yasash
function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const buf = Buffer.alloc(8 + data.length + 4);
  buf.writeUInt32BE(data.length, 0);
  typeBuf.copy(buf, 4);
  data.copy(buf, 8);
  buf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return buf;
}

// 128x128 Minecraft Map paketini toza yuqori sifatli 256x256 PNG ga aylantirish
function createMapPng(cols, rows, buf, scale = 2) {
  if (!buf || cols <= 0 || rows <= 0) return null;

  // Ranglar chastotasini tahlil qilish
  const freq = {};
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    freq[c] = (freq[c] || 0) + 1;
  }

  // Fon (eng ko'p uchragan rang)
  let bg = 34;
  let maxCount = 0;
  for (const c in freq) {
    if (freq[c] > maxCount) {
      maxCount = freq[c];
      bg = Number(c);
    }
  }

  // Ikkinchi eng ko'p rang (odatda matnning asosiy qora tanasi)
  let coreCol = null;
  let secondMax = 0;
  for (const c in freq) {
    const num = Number(c);
    if (num !== bg && freq[c] > secondMax) {
      secondMax = freq[c];
      coreCol = num;
    }
  }

  const outW = cols * scale;
  const outH = rows * scale;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(outW, 0);
  ihdrData.writeUInt32BE(outH, 4);
  ihdrData[8] = 8;  // 8 bits
  ihdrData[9] = 2;  // RGB
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const ihdr = makePngChunk('IHDR', ihdrData);

  const raw = Buffer.alloc(outH * (1 + outW * 3));
  let offset = 0;

  for (let y = 0; y < outH; y++) {
    raw[offset++] = 0; // Filter None
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < outW; x++) {
      const srcX = Math.floor(x / scale);
      const c = buf[srcY * cols + srcX];
      const isCore = (c === coreCol);
      const isFg = (c !== bg);

      let r = 255, g = 255, b = 255;
      if (isCore) {
        r = 0; g = 0; b = 0; // Asosiy harf tanasi: Qora
      } else if (isFg) {
        r = 70; g = 70; b = 70; // Harf qirrasi / noiselar: To'q kulrang
      }

      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const idat = makePngChunk('IDAT', zlib.deflateSync(raw));
  const iend = makePngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// O'yin xaritasini OCR API orqali aniqlash
async function solveMapWithOcr(pngBuffer) {
  if (!pngBuffer) return null;
  try {
    const base64 = 'data:image/png;base64,' + pngBuffer.toString('base64');
    const body = new URLSearchParams();
    body.append('apikey', 'helloworld');
    body.append('base64Image', base64);
    body.append('OCREngine', '2');
    body.append('scale', 'true');

    const res = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      body: body,
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) return null;
    const json = await res.json();
    if (!json.ParsedResults || json.ParsedResults.length === 0) return null;

    const rawText = json.ParsedResults[0].ParsedText || '';
    // Faqat harf va raqamlarni tozalab olish (3-5 ta belgi)
    const clean = rawText.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length >= 3 && clean.length <= 6) {
      return clean;
    }
    return null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  createMapPng,
  solveMapWithOcr
};
