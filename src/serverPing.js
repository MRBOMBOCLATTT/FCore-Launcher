const net = require('net');

function writeVarInt(value) {
  const bytes = [];
  do {
    let temp = value & 0b01111111;
    value >>>= 7;
    if (value !== 0) temp |= 0b10000000;
    bytes.push(temp);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function makePacket(id, ...fields) {
  const body = Buffer.concat([writeVarInt(id), ...fields]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function readVarInt(buffer, offset) {
  let value = 0;
  let position = 0;
  let currentByte;
  do {
    if (offset + position >= buffer.length) return null;
    currentByte = buffer[offset + position];
    value |= (currentByte & 0x7F) << (7 * position);
    position++;
    if (position > 5) throw new Error('VarInt слишком большой');
  } while ((currentByte & 0x80) !== 0);
  return { value, size: position };
}

// Server List Ping — тот же запрос, что шлёт сама игра для показа пинга и
// онлайна в списке серверов. Протокол не проверяет версию клиента для статуса,
// поэтому можно подставить любую свежую и получить ответ независимо от версии сервера
function flattenMotd(description) {
  if (typeof description === 'string') return description;
  if (!description || typeof description !== 'object') return '';
  const own = typeof description.text === 'string' ? description.text : '';
  const extra = Array.isArray(description.extra) ? description.extra.map(flattenMotd).join('') : '';
  return own + extra;
}

function cleanMotd(description) {
  return flattenMotd(description).replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function pingServer(host, port = 25565, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let startedAt = Date.now();
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve(data);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error('Таймаут подключения к серверу')));
    socket.on('error', err => finish(err));

    socket.connect(port, host, () => {
      startedAt = Date.now();
      const handshake = makePacket(
        0x00,
        writeVarInt(763),
        writeString(host),
        Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
        writeVarInt(1)
      );
      const statusRequest = makePacket(0x00);
      socket.write(Buffer.concat([handshake, statusRequest]));
    });

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      const lengthField = readVarInt(buffer, 0);
      if (!lengthField) return;
      if (buffer.length < lengthField.size + lengthField.value) return;

      let offset = lengthField.size;
      const idField = readVarInt(buffer, offset);
      if (!idField) return;
      offset += idField.size;

      if (idField.value !== 0x00) return finish(new Error('Неожиданный ответ сервера'));

      const jsonLenField = readVarInt(buffer, offset);
      if (!jsonLenField) return;
      offset += jsonLenField.size;

      const jsonStr = buffer.slice(offset, offset + jsonLenField.value).toString('utf8');

      try {
        const data = JSON.parse(jsonStr);
        finish(null, {
          online: data.players && typeof data.players.online === 'number' ? data.players.online : null,
          max: data.players && typeof data.players.max === 'number' ? data.players.max : null,
          latencyMs: Date.now() - startedAt,
          motd: cleanMotd(data.description),
          favicon: typeof data.favicon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]{1,90000}$/.test(data.favicon) ? data.favicon : null,
          version: data.version && typeof data.version.name === 'string' ? data.version.name.slice(0, 40) : null
        });
      } catch (err) {
        finish(new Error('Не удалось разобрать ответ сервера'));
      }
    });
  });
}

module.exports = { pingServer, cleanMotd };
