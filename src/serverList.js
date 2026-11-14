const fs = require('fs');
const path = require('path');
const nbt = require('./nbt');

const DEFAULT_PORT = 25565;
const MAX_SERVERS = 200;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,253}[a-z0-9])?$/i;

function parseAddress(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 260) return null;

  let host = text;
  let port = DEFAULT_PORT;

  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
    if (port < 1 || port > 65535) return null;
    return { host, port, value: port === DEFAULT_PORT ? `[${host}]` : `[${host}]:${port}` };
  }

  const colon = text.lastIndexOf(':');
  if (colon !== -1) {
    if (text.indexOf(':') !== colon) return null;
    host = text.slice(0, colon);
    if (!/^\d{1,5}$/.test(text.slice(colon + 1))) return null;
    port = Number(text.slice(colon + 1));
    if (port < 1 || port > 65535) return null;
  }
  if (!HOST_PATTERN.test(host)) return null;
  return { host, port, value: port === DEFAULT_PORT ? host : `${host}:${port}` };
}

function sanitizeName(input) {
  return typeof input === 'string' ? input.replace(/\s+/g, ' ').trim().slice(0, 64) : '';
}

function serversFile(instanceDir) {
  return path.join(instanceDir, 'servers.dat');
}

function readRoot(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const root = nbt.parse(fs.readFileSync(file));
    return root.type === nbt.TAG.Compound ? root : null;
  } catch {
    return null;
  }
}

function getListEntry(root) {
  const entry = root && nbt.findEntry(root.value, 'servers');
  return entry && entry.type === nbt.TAG.List ? entry : null;
}

function field(compound, name) {
  const entry = nbt.findEntry(compound, name);
  return entry && entry.type === nbt.TAG.String ? entry.value : '';
}

function listServers(instanceDir) {
  const entry = getListEntry(readRoot(serversFile(instanceDir)));
  if (!entry || entry.value.itemType !== nbt.TAG.Compound) return [];
  return entry.value.items.map((item, index) => ({
    index,
    name: field(item, 'name'),
    ip: field(item, 'ip')
  }));
}

function loadForWrite(instanceDir) {
  const file = serversFile(instanceDir);
  const root = readRoot(file);
  const existing = getListEntry(root);
  if (existing && existing.value.itemType === nbt.TAG.Compound) return { file, root, list: existing };
  if (existing && existing.value.items.length === 0) {
    existing.value.itemType = nbt.TAG.Compound;
    return { file, root, list: existing };
  }
  if (root && existing) throw new Error('Не удалось разобрать servers.dat');
  const list = { name: 'servers', type: nbt.TAG.List, value: { itemType: nbt.TAG.Compound, items: [] } };
  const fresh = root || { name: '', type: nbt.TAG.Compound, value: [] };
  fresh.value.push(list);
  return { file, root: fresh, list };
}

function save({ file, root }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}_old`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, nbt.serialize(root));
  fs.renameSync(tmp, file);
}

function setString(compound, name, value) {
  const entry = nbt.findEntry(compound, name);
  if (entry) {
    entry.type = nbt.TAG.String;
    entry.value = value;
  } else {
    compound.push({ name, type: nbt.TAG.String, value });
  }
}

function checkInput(input) {
  const name = sanitizeName(input && input.name);
  const address = parseAddress(input && input.ip);
  if (!name) throw new Error('Введите название сервера');
  if (!address) throw new Error('Неверный адрес сервера. Пример: play.example.com или 1.2.3.4:25566');
  return { name, ip: address.value };
}

function addServer(instanceDir, input) {
  const { name, ip } = checkInput(input);
  const state = loadForWrite(instanceDir);
  if (state.list.value.items.length >= MAX_SERVERS) throw new Error('Слишком много серверов в списке');
  state.list.value.items.push([
    { name: 'name', type: nbt.TAG.String, value: name },
    { name: 'ip', type: nbt.TAG.String, value: ip }
  ]);
  save(state);
  return listServers(instanceDir);
}

function editServer(instanceDir, index, input) {
  const { name, ip } = checkInput(input);
  const state = loadForWrite(instanceDir);
  const item = state.list.value.items[index];
  if (!item) throw new Error('Сервер не найден');
  setString(item, 'name', name);
  setString(item, 'ip', ip);
  save(state);
  return listServers(instanceDir);
}

function removeServer(instanceDir, index) {
  const state = loadForWrite(instanceDir);
  if (!state.list.value.items[index]) throw new Error('Сервер не найден');
  state.list.value.items.splice(index, 1);
  save(state);
  return listServers(instanceDir);
}

module.exports = { parseAddress, listServers, addServer, editServer, removeServer };
