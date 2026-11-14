// Мини-реализация NBT (Named Binary Tag) — формата, в котором Minecraft хранит level.dat.
// Нужна только для двух вещей: прочитать несколько полей мира (имя, дату захода,
// режим игры) для списка миров и точечно переписать LevelName при переименовании.
// Полноценных npm-пакетов под это не подключаем (as-is с остальным проектом —
// см. комментарий в zipStream.js про самописный zip вместо тяжёлых зависимостей).
//
// Формат тегов: https://minecraft.wiki/w/NBT_format
// Дерево хранится как { name, type, value }, где value для TAG_Compound —
// это МАССИВ { name, type, value } (а не Object), чтобы при обратной записи
// сохранить исходный порядок полей и типы 1-в-1, не трогая остальные данные мира.

const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12
};

class Reader {
  constructor(buf) { this.buf = buf; this.offset = 0; }
  ubyte() { const v = this.buf.readUInt8(this.offset); this.offset += 1; return v; }
  byte() { const v = this.buf.readInt8(this.offset); this.offset += 1; return v; }
  ushort() { const v = this.buf.readUInt16BE(this.offset); this.offset += 2; return v; }
  short() { const v = this.buf.readInt16BE(this.offset); this.offset += 2; return v; }
  int() { const v = this.buf.readInt32BE(this.offset); this.offset += 4; return v; }
  long() { const v = this.buf.readBigInt64BE(this.offset); this.offset += 8; return v; }
  float() { const v = this.buf.readFloatBE(this.offset); this.offset += 4; return v; }
  double() { const v = this.buf.readDoubleBE(this.offset); this.offset += 8; return v; }
  bytes(n) { const v = this.buf.subarray(this.offset, this.offset + n); this.offset += n; return Buffer.from(v); }
  string() { const len = this.ushort(); const s = this.buf.toString('utf8', this.offset, this.offset + len); this.offset += len; return s; }
}

class Writer {
  constructor() { this.chunks = []; }
  ubyte(v) { const b = Buffer.alloc(1); b.writeUInt8(v, 0); this.chunks.push(b); }
  byte(v) { const b = Buffer.alloc(1); b.writeInt8(v, 0); this.chunks.push(b); }
  ushort(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); this.chunks.push(b); }
  short(v) { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); this.chunks.push(b); }
  int(v) { const b = Buffer.alloc(4); b.writeInt32BE(v, 0); this.chunks.push(b); }
  long(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v), 0); this.chunks.push(b); }
  float(v) { const b = Buffer.alloc(4); b.writeFloatBE(v, 0); this.chunks.push(b); }
  double(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v, 0); this.chunks.push(b); }
  bytes(buf) { this.chunks.push(Buffer.from(buf)); }
  string(str) { const s = Buffer.from(String(str), 'utf8'); this.ushort(s.length); this.chunks.push(s); }
  toBuffer() { return Buffer.concat(this.chunks); }
}

function readPayload(type, r) {
  switch (type) {
    case TAG.Byte: return r.byte();
    case TAG.Short: return r.short();
    case TAG.Int: return r.int();
    case TAG.Long: return r.long();
    case TAG.Float: return r.float();
    case TAG.Double: return r.double();
    case TAG.ByteArray: { const len = r.int(); return r.bytes(len); }
    case TAG.String: return r.string();
    case TAG.List: {
      const itemType = r.ubyte();
      const len = r.int();
      const items = [];
      for (let i = 0; i < len; i++) items.push(readPayload(itemType, r));
      return { itemType, items };
    }
    case TAG.Compound: {
      const entries = [];
      while (true) {
        const t = r.ubyte();
        if (t === TAG.End) break;
        const name = r.string();
        entries.push({ name, type: t, value: readPayload(t, r) });
      }
      return entries;
    }
    case TAG.IntArray: { const len = r.int(); const arr = []; for (let i = 0; i < len; i++) arr.push(r.int()); return arr; }
    case TAG.LongArray: { const len = r.int(); const arr = []; for (let i = 0; i < len; i++) arr.push(r.long()); return arr; }
    default: throw new Error(`Неизвестный тип NBT-тега: ${type}`);
  }
}

function writePayload(type, value, w) {
  switch (type) {
    case TAG.Byte: return w.byte(value);
    case TAG.Short: return w.short(value);
    case TAG.Int: return w.int(value);
    case TAG.Long: return w.long(value);
    case TAG.Float: return w.float(value);
    case TAG.Double: return w.double(value);
    case TAG.ByteArray: w.int(value.length); return w.bytes(value);
    case TAG.String: return w.string(value);
    case TAG.List: {
      w.ubyte(value.itemType);
      w.int(value.items.length);
      for (const item of value.items) writePayload(value.itemType, item, w);
      return;
    }
    case TAG.Compound: {
      for (const entry of value) {
        w.ubyte(entry.type);
        w.string(entry.name);
        writePayload(entry.type, entry.value, w);
      }
      w.ubyte(TAG.End);
      return;
    }
    case TAG.IntArray: { w.int(value.length); for (const v of value) w.int(v); return; }
    case TAG.LongArray: { w.int(value.length); for (const v of value) w.long(v); return; }
    default: throw new Error(`Неизвестный тип NBT-тега: ${type}`);
  }
}

// buffer — уже разархивированные (gunzip) байты level.dat
function parse(buffer) {
  const r = new Reader(buffer);
  const type = r.ubyte();
  const name = r.string();
  const value = readPayload(type, r);
  return { name, type, value };
}

function serialize(root) {
  const w = new Writer();
  w.ubyte(root.type);
  w.string(root.name);
  writePayload(root.type, root.value, w);
  return w.toBuffer();
}

// value для TAG.Compound — массив { name, type, value }; ищем по имени поля
function findEntry(compoundValue, name) {
  return compoundValue.find(e => e.name === name);
}

module.exports = { TAG, parse, serialize, findEntry };
