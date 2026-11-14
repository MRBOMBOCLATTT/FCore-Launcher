const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SKIN_BYTES = 200 * 1024;
const ID_RE = /^[0-9a-f]{12}$/;

function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Mojang принимает 64x64 и старый формат 64x32
function isSkinSize(size) {
  return !!size && size.width === 64 && (size.height === 64 || size.height === 32);
}

// Библиотека сохранённых скинов: папка с PNG и index.json рядом
function createSkinLibrary(dir) {
  const indexPath = path.join(dir, 'index.json');

  const readIndex = () => {
    try {
      const list = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      return Array.isArray(list) ? list.filter(e => e && ID_RE.test(e.id)) : [];
    } catch {
      return [];
    }
  };

  const writeIndex = list => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), 'utf-8');
  };

  const fileOf = id => path.join(dir, `${id}.png`);

  return {
    list() {
      return readIndex().filter(e => fs.existsSync(fileOf(e.id)));
    },

    add(filePath, variant = 'classic', name) {
      if (fs.statSync(filePath).size > MAX_SKIN_BYTES) throw new Error('Файл слишком большой для скина');
      const buffer = fs.readFileSync(filePath);
      if (!isSkinSize(readPngSize(buffer))) throw new Error('Скин должен быть PNG размером 64×64 (или 64×32)');

      const id = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
      const list = readIndex();
      const existing = list.find(e => e.id === id);
      if (existing && fs.existsSync(fileOf(id))) return existing;

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fileOf(id), buffer);
      const entry = {
        id,
        name: String(name || path.basename(filePath, path.extname(filePath))).slice(0, 40),
        variant: variant === 'slim' ? 'slim' : 'classic',
        addedAt: Date.now()
      };
      writeIndex([...list.filter(e => e.id !== id), entry]);
      return entry;
    },

    remove(id) {
      if (!ID_RE.test(id)) return false;
      writeIndex(readIndex().filter(e => e.id !== id));
      fs.rmSync(fileOf(id), { force: true });
      return true;
    },

    filePath(id) {
      return ID_RE.test(id) && fs.existsSync(fileOf(id)) ? fileOf(id) : null;
    },

    dataUrl(id) {
      const file = this.filePath(id);
      return file ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : null;
    }
  };
}

// Один слот «что было до последней смены скина» — для кнопки «Отменить смену скина».
// captured: { buffer, variant } (обычный скин) или { reset: true } (был стандартный скин)
function createPreviousSkinSlot(dir) {
  const pngPath = path.join(dir, 'previous.png');
  const metaPath = path.join(dir, 'previous.json');

  return {
    save(captured) {
      this.clear();
      if (!captured) return;
      fs.mkdirSync(dir, { recursive: true });
      if (captured.reset) {
        fs.writeFileSync(metaPath, JSON.stringify({ reset: true }), 'utf-8');
        return;
      }
      fs.writeFileSync(pngPath, captured.buffer);
      fs.writeFileSync(metaPath, JSON.stringify({ variant: captured.variant === 'slim' ? 'slim' : 'classic' }), 'utf-8');
    },

    read() {
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return null; }
      if (meta.reset) return { reset: true };
      if (!fs.existsSync(pngPath)) return null;
      return { buffer: fs.readFileSync(pngPath), variant: meta.variant === 'slim' ? 'slim' : 'classic' };
    },

    exists() {
      return this.read() !== null;
    },

    clear() {
      fs.rmSync(pngPath, { force: true });
      fs.rmSync(metaPath, { force: true });
    }
  };
}

module.exports = { createSkinLibrary, createPreviousSkinSlot, readPngSize, isSkinSize };
