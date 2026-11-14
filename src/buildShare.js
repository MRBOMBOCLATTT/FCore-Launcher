const zlib = require('zlib');

const CODE_PREFIX = 'FCB1:';
const LOADERS = ['fabric', 'forge', 'neoforge', 'vanilla'];
const MAX_ITEMS = 600;
const MAX_CODE_LENGTH = 200000;
const MAX_JSON_BYTES = 1024 * 1024;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MC_VERSION = /^[0-9A-Za-z._-]{1,32}$/;

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
}

function packItems(list) {
  return (Array.isArray(list) ? list : [])
    .filter(item => item && typeof item === 'object' && PROJECT_ID.test(String(item.projectId || '')))
    .slice(0, MAX_ITEMS)
    .map(item => {
      const out = { p: String(item.projectId), t: cleanText(item.title, 80) || String(item.projectId) };
      if (item.source === 'curseforge') out.c = 1;
      if (item.skipDeps) out.d = 1;
      if (item.asDependency) out.a = 1;
      return out;
    });
}

function unpackItems(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list.slice(0, MAX_ITEMS) : []) {
    if (!item || typeof item !== 'object' || !PROJECT_ID.test(String(item.p || ''))) continue;
    if (seen.has(item.p)) continue;
    seen.add(item.p);
    const entry = {
      projectId: item.p,
      title: cleanText(item.t, 80) || item.p,
      icon: null,
      source: item.c === 1 ? 'curseforge' : 'modrinth'
    };
    if (item.d === 1) entry.skipDeps = true;
    if (item.a === 1) entry.asDependency = true;
    out.push(entry);
  }
  return out;
}

function createManifest({ name, mcVersion, loader, record }) {
  const source = record || {};
  return {
    v: 1,
    n: cleanText(name, 40),
    mc: mcVersion,
    l: loader,
    m: packItems(source.wantedMods),
    r: packItems(source.wantedResourcePacks),
    s: packItems(source.wantedShaders)
  };
}

function encodeBuildCode(manifest) {
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  return CODE_PREFIX + zlib.deflateRawSync(json, { level: 9 }).toString('base64url');
}

function decodeBuildCode(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(CODE_PREFIX) || trimmed.length > MAX_CODE_LENGTH) return null;
  let data;
  try {
    const raw = Buffer.from(trimmed.slice(CODE_PREFIX.length), 'base64url');
    data = JSON.parse(zlib.inflateRawSync(raw, { maxOutputLength: MAX_JSON_BYTES }).toString('utf8'));
  } catch {
    return null;
  }
  if (!data || data.v !== 1 || !LOADERS.includes(data.l) || !MC_VERSION.test(String(data.mc || ''))) return null;
  const manifest = {
    name: cleanText(data.n, 40) || 'Сборка по коду',
    mcVersion: data.mc,
    loader: data.l,
    mods: unpackItems(data.m),
    resourcePacks: unpackItems(data.r),
    shaders: unpackItems(data.s)
  };
  const total = manifest.mods.length + manifest.resourcePacks.length + manifest.shaders.length;
  return total > 0 ? manifest : null;
}

module.exports = { CODE_PREFIX, createManifest, encodeBuildCode, decodeBuildCode };
