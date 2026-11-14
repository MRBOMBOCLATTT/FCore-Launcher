const crypto = require('crypto');

const MAX_GROUPS = 50;
const MAX_NAME = 40;
const MAX_MEMBERS = 5000;

function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];
  const seenIds = new Set();
  const names = new Set();
  const out = [];
  for (const raw of groups) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    const name = String(raw.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME);
    if (!id || !name || seenIds.has(id) || names.has(name.toLowerCase())) continue;
    const members = [...new Set((Array.isArray(raw.members) ? raw.members : [])
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim().slice(0, 256)))].slice(0, MAX_MEMBERS);
    out.push({ id, name, members, createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now() });
    seenIds.add(id);
    names.add(name.toLowerCase());
  }
  return out.slice(0, MAX_GROUPS);
}

function cleanName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) throw new Error('Введите название группы');
  return name;
}

function createGroup(groups, name) {
  const current = normalizeGroups(groups);
  const clean = cleanName(name);
  if (current.length >= MAX_GROUPS) throw new Error(`Можно создать не больше ${MAX_GROUPS} групп`);
  if (current.some(g => g.name.toLowerCase() === clean.toLowerCase())) throw new Error('Группа с таким названием уже существует');
  const now = Date.now();
  return [...current, { id: crypto.randomBytes(8).toString('hex'), name: clean, members: [], createdAt: now, updatedAt: now }];
}

function renameGroup(groups, id, name) {
  const current = normalizeGroups(groups);
  const clean = cleanName(name);
  const target = current.find(g => g.id === id);
  if (!target) throw new Error('Группа не найдена');
  if (current.some(g => g.id !== id && g.name.toLowerCase() === clean.toLowerCase())) throw new Error('Группа с таким названием уже существует');
  return current.map(g => g.id === id ? { ...g, name: clean, updatedAt: Date.now() } : g);
}

function deleteGroup(groups, id) {
  return normalizeGroups(groups).filter(g => g.id !== id);
}

function assignMembers(groups, id, memberKeys) {
  const current = normalizeGroups(groups);
  if (!current.some(g => g.id === id)) throw new Error('Группа не найдена');
  const keys = [...new Set((Array.isArray(memberKeys) ? memberKeys : []).filter(k => typeof k === 'string' && k.trim()).map(k => k.trim().slice(0, 256)))];
  if (!keys.length) throw new Error('Выберите хотя бы один мод');
  const keySet = new Set(keys);
  return current.map(g => {
    const members = g.id === id
      ? [...new Set([...g.members, ...keys])]
      : g.members.filter(k => !keySet.has(k));
    return members.length === g.members.length && members.every((k, i) => k === g.members[i])
      ? g : { ...g, members, updatedAt: Date.now() };
  });
}

function removeMembers(groups, id, memberKeys) {
  const keySet = new Set((Array.isArray(memberKeys) ? memberKeys : []).filter(k => typeof k === 'string'));
  return normalizeGroups(groups).map(g => g.id === id
    ? { ...g, members: g.members.filter(k => !keySet.has(k)), updatedAt: Date.now() }
    : g);
}

function normalizeModFileName(fileName) {
  return String(fileName || '').replace(/\.disabled$/i, '');
}

function modMemberKey(file) {
  const mods = Array.isArray(file?.mods) ? file.mods : [];
  const primary = mods.find(mod => mod && typeof mod.id === 'string' && mod.id.trim());
  if (primary) return `mod:${primary.id.toLowerCase()}`;
  return `file:${normalizeModFileName(file?.fileName).toLowerCase()}`;
}

function groupForKey(groups, key) {
  return normalizeGroups(groups).find(g => g.members.includes(key)) || null;
}

module.exports = { MAX_GROUPS, MAX_NAME, normalizeGroups, normalizeModFileName, modMemberKey, createGroup, renameGroup, deleteGroup, assignMembers, removeMembers, groupForKey };
