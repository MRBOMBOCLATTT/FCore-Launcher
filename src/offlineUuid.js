const crypto = require('crypto');

const OFFLINE_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function isValidOfflineName(name) {
  return OFFLINE_NAME_RE.test(String(name || ''));
}

// Так же, как сам Minecraft считает UUID игрока на серверах с online-mode=false:
// UUID.nameUUIDFromBytes("OfflinePlayer:<ник>"), то есть MD5 с битами версии 3.
// Благодаря этому у каждого ника свой постоянный UUID, а мир, инвентарь и права
// на сервере остаются привязаны к игроку.
function offlineUuid(name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { offlineUuid, isValidOfflineName };
