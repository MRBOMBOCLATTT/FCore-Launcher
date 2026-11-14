const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createSkinLibrary, createPreviousSkinSlot, readPngSize, isSkinSize } = require('../src/skinLibrary');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, shade = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, shade)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skins-'));
const write = (dir, name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; };

test('readPngSize и проверка размера скина', () => {
  assert.deepEqual(readPngSize(png(64, 64)), { width: 64, height: 64 });
  assert.equal(isSkinSize(readPngSize(png(64, 64))), true);
  assert.equal(isSkinSize(readPngSize(png(64, 32))), true);
  assert.equal(isSkinSize(readPngSize(png(128, 128))), false);
  assert.equal(readPngSize(Buffer.from('не png, просто текст достаточной длины')), null);
});

test('библиотека: добавление, список, удаление', () => {
  const work = tmp();
  const lib = createSkinLibrary(path.join(work, 'lib'));
  const entry = lib.add(write(work, 'my skin.png', png(64, 64, 10)), 'slim');
  assert.equal(entry.name, 'my skin');
  assert.equal(entry.variant, 'slim');
  assert.equal(lib.list().length, 1);
  assert.match(lib.dataUrl(entry.id), /^data:image\/png;base64,/);
  assert.equal(lib.remove(entry.id), true);
  assert.equal(lib.list().length, 0);
  assert.equal(lib.filePath(entry.id), null);
});

test('библиотека: тот же файл не дублируется', () => {
  const work = tmp();
  const lib = createSkinLibrary(path.join(work, 'lib'));
  const file = write(work, 'a.png', png(64, 64, 5));
  const first = lib.add(file);
  const second = lib.add(file);
  assert.equal(first.id, second.id);
  assert.equal(lib.list().length, 1);
});

test('библиотека: чужие размеры, не-PNG и опасные id отклоняются', () => {
  const work = tmp();
  const lib = createSkinLibrary(path.join(work, 'lib'));
  assert.throws(() => lib.add(write(work, 'big.png', png(128, 128))), /64×64/);
  assert.throws(() => lib.add(write(work, 'fake.png', Buffer.alloc(40, 1))), /64×64/);
  assert.equal(lib.remove('../../etc/passwd'), false);
  assert.equal(lib.filePath('../x'), null);
});

test('слот предыдущего скина: сохранение, чтение, очистка', () => {
  const slot = createPreviousSkinSlot(path.join(tmp(), 'slot'));
  assert.equal(slot.exists(), false);

  const buffer = png(64, 64, 7);
  slot.save({ buffer, variant: 'slim' });
  const back = slot.read();
  assert.equal(back.variant, 'slim');
  assert.ok(back.buffer.equals(buffer));

  slot.clear();
  assert.equal(slot.exists(), false);
});

test('слот предыдущего скина: стандартный скин хранится как reset, а новая запись заменяет старую', () => {
  const slot = createPreviousSkinSlot(path.join(tmp(), 'slot'));
  slot.save({ buffer: png(64, 64, 1), variant: 'classic' });
  slot.save({ reset: true });
  assert.deepEqual(slot.read(), { reset: true });
  slot.save(null);
  assert.equal(slot.exists(), false);
});
