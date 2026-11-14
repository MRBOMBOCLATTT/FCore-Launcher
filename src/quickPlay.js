const { parseAddress } = require('./serverList');

function supportsQuickPlay(mcVersion) {
  const m = /^(\d+)\.(\d+)/.exec(String(mcVersion || ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || minor >= 20;
}

function sanitizeQuickPlay(input) {
  if (!input || typeof input !== 'object') return null;
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  if (input.type === 'world') {
    if (!value || value.length > 255 || /[\\/\0]/.test(value) || value === '.' || value === '..') return null;
    return { type: 'world', value };
  }
  if (input.type === 'server') {
    const address = parseAddress(value);
    return address ? { type: 'server', value: address.value, host: address.host, port: address.port } : null;
  }
  return null;
}

function buildQuickPlayArgs(quickPlay, mcVersion) {
  const clean = sanitizeQuickPlay(quickPlay);
  if (!clean) return [];
  if (clean.type === 'server') {
    if (supportsQuickPlay(mcVersion)) return ['--quickPlayMultiplayer', `${clean.host.includes(':') ? `[${clean.host}]` : clean.host}:${clean.port}`];
    return ['--server', clean.host, '--port', String(clean.port)];
  }
  if (!supportsQuickPlay(mcVersion)) {
    throw new Error('Быстрый вход в мир работает с Minecraft 1.20 и новее');
  }
  return ['--quickPlaySingleplayer', clean.value];
}

module.exports = { supportsQuickPlay, sanitizeQuickPlay, buildQuickPlayArgs };
