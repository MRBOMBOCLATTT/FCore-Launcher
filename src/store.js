const Store = require('./cachedStore'); // electron-store с кэшем чтения, см. cachedStore.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { offlineUuid, isValidOfflineName } = require('./offlineUuid');
const { sanitizeConfig, sanitizeAccent } = require('./gradientConfig');
const appearanceConfig = require('./appearanceConfig');
const launchSettings = require('./launchSettings');
const buildsState = require('./builds');
const buildFolder = require('./buildFolder');
const buildMeta = require('./buildMeta');
const resourcePackProfiles = require('./resourcePackProfiles');
const modGroupsModel = require('./modGroups');

const CONFIG_NAME = 'pfc-launcher-config';
const configPath = path.join(app.getPath('userData'), `${CONFIG_NAME}.json`);
const configBackupPath = `${configPath}.bak`;

// electron-store с clearInvalidConfig молча сбрасывает ВЕСЬ файл настроек к
// дефолтам, если json побился (вырубили питание во время записи, диск кончился
// и т.п.) — а вместе с ним и списки wantedMods по всем сборкам. После такого
// сброса reinstallMods считает уже стоящие моды "лишними" и стирает их с диска.
// Поэтому перед тем, как отдать файл в electron-store, проверяем его сами и,
// если он битый, поднимаем последнюю резервную копию вместо пустых дефолтов.
function restoreConfigFromBackupIfCorrupted() {
  if (!fs.existsSync(configPath)) return;

  try {
    JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return;
  } catch {
    // не парсится — файл битый, пробуем восстановиться из бэкапа
  }

  try {
    fs.copyFileSync(configPath, `${configPath}.corrupted-${Date.now()}`);
  } catch {}

  if (fs.existsSync(configBackupPath)) {
    try {
      JSON.parse(fs.readFileSync(configBackupPath, 'utf8'));
      fs.copyFileSync(configBackupPath, configPath);
    } catch {}
  }
}

restoreConfigFromBackupIfCorrupted();

const store = new Store({
  name: CONFIG_NAME,
  // на случай, если и резервную копию поднять не вышло — раньше лаунчер вообще
  // отказывался запускаться, теперь просто сбросит к дефолтам
  clearInvalidConfig: true,
  defaults: {
    gameDir: null,
    accounts: [],
    selectedAccountIndex: 0,
    lastVersion: null,
    lastLoader: 'fabric',
    memoryMax: '4G',
    memoryMin: '1G',
    theme: 'blue',
    themeMode: 'dark', // 'dark' | 'light'
    javaPath: null,
    jvmArgs: '',
    gameWidth: 854,
    gameHeight: 480,
    fullscreen: false,
    discordRPC: true,
    afterLaunch: 'minimize', // 'close' | 'minimize' | 'keep'
    debugMode: false,
    gameLogsEnabled: true,
    gpuPreference: 'auto', // 'auto' | 'powersaving' | 'performance'
    favoriteVersions: [],
    // ставить ли CustomSkinLoader в mods/ на fabric/forge-сборках, чтобы видеть
    // скины (свой и чужие) даже на серверах, которые не понимают authlib-injector
    customSkinLoaderEnabled: true,
    themeCustom: '#6aa437',
    appearance: null, // оформление лаунчера (см. appearanceConfig.js)
    appearancePresets: [], // свои пресеты оформления
    gradient: null, // общий градиент лаунчера (см. gradientConfig.js), null = значения по умолчанию
    notificationsEnabled: true,
    notificationSoundVolume: 0.5,
    notificationMode: 'internal',
    language: 'ru', // 'ru' | 'en'
    customNotificationSounds: {},
    minimizeToTray: true,
    quickLaunchVersion: null,
    quickLaunchLoader: null,
    modpackProfiles: [], // { id, name, loader, mods: [{projectId, title, icon}] }
    resourcePackProfiles: [], // { id, name, loader, packs: [{projectId, title, icon}] }
    favoriteScreenshots: [], // список полных путей к избранным скриншотам
    favoriteMods: [], // ключи избранных модов: mod:<id> или file:<имя>
    syntThemeUnlocked: false,
    curseforgeApiKey: '',
    lastSeenVersion: null,
    // instances: { "1.20.1-fabric": { wantedMods: [...], wantedResourcePacks: [...] } }
    // builds: [{ id, name, mcVersion, loader, createdAt }], activeBuildId: id | null
    builds: [],
    activeBuildId: null,
    instances: {},
    gamePresets: [],
    serverPresets: {}
  }
});

// держим рядом рабочую копию конфига, чтобы было из чего восстанавливаться
// при следующем запуске, если основной файл побьётся
let backupTimer = null;
store.onDidAnyChange(() => {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    try { fs.copyFile(configPath, configBackupPath, () => {}); } catch {}
  }, 250);
});

function instanceKey(mcVersion, loader) {
  return buildsState.folderName(mcVersion, loader);
}

// ---------- сборки ----------
function listBuilds() {
  return store.get('builds') || [];
}

function getActiveBuild() {
  const id = store.get('activeBuildId');
  return listBuilds().find(b => b.id === id) || null;
}

function applyActiveBuild() {
  buildsState.setActive(getActiveBuild());
}

function cleanBuildName(name) {
  const clean = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  if (!clean) throw new Error('Введи название сборки');
  return clean;
}

let folderExists = () => false;

function setFolderChecker(fn) {
  folderExists = typeof fn === 'function' ? fn : () => false;
}

function takenFolders(excludeId) {
  return listBuilds().filter(b => b.id !== excludeId).flatMap(b => [buildFolder.dirOf(b), `build-${b.id}`]);
}

function createBuild({ name, mcVersion, loader }) {
  if (!mcVersion || !loader) throw new Error('Выбери версию и загрузчик');
  const list = listBuilds();
  const cleanName = cleanBuildName(name);
  if (list.some(b => b.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('Сборка с таким названием уже есть');
  }
  const build = {
    id: crypto.randomBytes(5).toString('hex'),
    name: cleanName,
    mcVersion,
    loader,
    createdAt: Date.now()
  };
  build.folder = buildFolder.pickFolder(cleanName, takenFolders(), folderExists);
  list.push(build);
  store.set('builds', list);
  return build;
}

function setBuildFolder(id, folder) {
  const list = listBuilds();
  const build = list.find(b => b.id === id);
  if (!build) throw new Error('Сборка не найдена');
  build.folder = folder;
  store.set('builds', list);
  applyActiveBuild();
  return build;
}

function renameBuild(id, name) {
  const list = listBuilds();
  const build = list.find(b => b.id === id);
  if (!build) throw new Error('Сборка не найдена');
  const cleanName = cleanBuildName(name);
  if (list.some(b => b.id !== id && b.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('Сборка с таким названием уже есть');
  }
  build.name = cleanName;
  store.set('builds', list);
  return build;
}

function setBuildMeta(id, meta) {
  const list = listBuilds();
  const build = list.find(b => b.id === id);
  if (!build) throw new Error('Сборка не найдена');
  const clean = buildMeta.sanitizeMeta(meta);
  if (clean.group) build.group = clean.group;
  else delete build.group;
  if (clean.tags.length) build.tags = clean.tags;
  else delete build.tags;
  store.set('builds', list);
  return build;
}

function removeBuildRecord(id) {
  store.set('builds', listBuilds().filter(b => b.id !== id));
  const instances = store.get('instances') || {};
  delete instances[`build-${id}`];
  store.set('instances', instances);
  if (store.get('activeBuildId') === id) {
    store.set('activeBuildId', null);
    applyActiveBuild();
  }
}

function setActiveBuild(id) {
  if (id && !listBuilds().some(b => b.id === id)) throw new Error('Сборка не найдена');
  store.set('activeBuildId', id || null);
  applyActiveBuild();
  return getActiveBuild();
}

applyActiveBuild();

// на случай старых записей, где список был просто массивом id-шников
function normalizeItem(item) {
  return typeof item === 'string' ? { projectId: item, title: item, icon: null } : item;
}

function getInstance(mcVersion, loader) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  if (!instances[key]) {
    instances[key] = { wantedMods: [], wantedResourcePacks: [], wantedShaders: [], modGroups: [] };
    store.set('instances', instances);
  }
  if (!instances[key].wantedResourcePacks) instances[key].wantedResourcePacks = [];
  if (!instances[key].wantedShaders) instances[key].wantedShaders = [];
  if (!Array.isArray(instances[key].modGroups)) instances[key].modGroups = [];

  instances[key].wantedMods = instances[key].wantedMods.map(normalizeItem);
  instances[key].wantedResourcePacks = instances[key].wantedResourcePacks.map(normalizeItem);
  instances[key].wantedShaders = instances[key].wantedShaders.map(normalizeItem);
  return instances[key];
}

function getLaunchSettings(mcVersion, loader) {
  return launchSettings.sanitize(getInstance(mcVersion, loader).launch);
}

function setLaunchSettings(mcVersion, loader, settings) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  const clean = launchSettings.sanitize(settings);
  instances[key] = { ...getInstance(mcVersion, loader), launch: clean };
  store.set('instances', instances);
  return clean;
}

// ---------- пресеты запуска ----------
function listGamePresets() {
  return store.get('gamePresets') || [];
}

function saveGamePreset(name, settings) {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!cleanName) throw new Error('Введите название пресета');
  const presets = listGamePresets();
  if (presets.length >= 100) throw new Error('Достигнут лимит пресетов');
  const preset = { id: crypto.randomUUID(), name: cleanName, settings: launchSettings.sanitize(settings), createdAt: Date.now() };
  presets.push(preset);
  store.set('gamePresets', presets);
  return presets;
}

function deleteGamePreset(id) {
  const presets = listGamePresets().filter(p => p.id !== id);
  store.set('gamePresets', presets);
  return presets;
}

function serverPresetKey(mcVersion, loader, ip) {
  return `${instanceKey(mcVersion, loader)}|${String(ip || '').trim().toLowerCase()}`;
}

function getServerPreset(mcVersion, loader, ip) {
  const key = serverPresetKey(mcVersion, loader, ip);
  return (store.get('serverPresets') || {})[key] || null;
}

function saveServerPreset(mcVersion, loader, ip, name, settings) {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!cleanName) throw new Error('Введите название пресета');
  const all = store.get('serverPresets') || {};
  const key = serverPresetKey(mcVersion, loader, ip);
  all[key] = { name: cleanName, mcVersion, loader, ip: String(ip || '').trim(), settings: launchSettings.sanitize(settings), updatedAt: Date.now() };
  store.set('serverPresets', all);
  return all[key];
}

function deleteServerPreset(mcVersion, loader, ip) {
  const all = store.get('serverPresets') || {};
  delete all[serverPresetKey(mcVersion, loader, ip)];
  store.set('serverPresets', all);
  return true;
}

function getModGroups(mcVersion, loader) {
  return modGroupsModel.normalizeGroups(getInstance(mcVersion, loader).modGroups);
}

function saveModGroups(mcVersion, loader, modGroups) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), modGroups: modGroupsModel.normalizeGroups(modGroups) };
  store.set('instances', instances);
  return instances[key].modGroups;
}

function createModGroup(mcVersion, loader, name) {
  return saveModGroups(mcVersion, loader, modGroupsModel.createGroup(getModGroups(mcVersion, loader), name));
}

function renameModGroup(mcVersion, loader, id, name) {
  return saveModGroups(mcVersion, loader, modGroupsModel.renameGroup(getModGroups(mcVersion, loader), id, name));
}

function deleteModGroup(mcVersion, loader, id) {
  return saveModGroups(mcVersion, loader, modGroupsModel.deleteGroup(getModGroups(mcVersion, loader), id));
}

function assignModsToGroup(mcVersion, loader, id, memberKeys) {
  return saveModGroups(mcVersion, loader, modGroupsModel.assignMembers(getModGroups(mcVersion, loader), id, memberKeys));
}

function removeModsFromGroup(mcVersion, loader, id, memberKeys) {
  return saveModGroups(mcVersion, loader, modGroupsModel.removeMembers(getModGroups(mcVersion, loader), id, memberKeys));
}

function listFavoriteModRecords() {
  const raw = store.get('favoriteMods') || [];
  const seen = new Set();
  return raw.map(item => typeof item === 'string' ? { key: item } : item)
    .filter(item => item && typeof item.key === 'string' && item.key.trim() && !seen.has(item.key) && seen.add(item.key))
    .map(item => ({
      key: item.key.slice(0, 256),
      source: ['modrinth', 'curseforge'].includes(item.source) ? item.source : null,
      projectId: typeof item.projectId === 'string' ? item.projectId.slice(0, 160) : null,
      title: typeof item.title === 'string' ? item.title.slice(0, 160) : item.key,
      icon: typeof item.icon === 'string' && /^https:\/\//i.test(item.icon) ? item.icon.slice(0, 1200) : null,
      addedAt: Number(item.addedAt) || Date.now()
    }));
}

function listFavoriteMods() {
  return listFavoriteModRecords().map(item => item.key);
}

function toggleFavoriteMod(key, favorite, details = {}) {
  const clean = String(key || '').trim().slice(0, 256);
  if (!clean) throw new Error('Не удалось определить мод');
  const records = new Map(listFavoriteModRecords().map(item => [item.key, item]));
  const shouldFavorite = favorite === undefined ? !records.has(clean) : !!favorite;
  if (shouldFavorite) {
    const old = records.get(clean) || {};
    records.set(clean, {
      ...old,
      key: clean,
      source: details.source || old.source || null,
      projectId: details.projectId || old.projectId || null,
      title: details.title || old.title || clean,
      icon: details.icon || old.icon || null,
      addedAt: old.addedAt || Date.now()
    });
  } else records.delete(clean);
  const next = [...records.values()].slice(-2000);
  store.set('favoriteMods', next);
  return next.map(item => item.key);
}

function setWantedMods(mcVersion, loader, wantedMods) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), wantedMods };
  store.set('instances', instances);
}

// запоминает, каким файлом на диске сейчас представлен каждый непин-мод —
// используется modManager'ом, чтобы не удалять файл мода, который в этот
// раз не удалось проверить на Modrinth (сеть, рейт-лимит, снятый с публикации проект)
function rememberModFileNames(mcVersion, loader, resolvedMods) {
  const inst = getInstance(mcVersion, loader);
  const byId = new Map(resolvedMods.filter(m => m.fileName).map(m => [m.projectId, m.fileName]));
  const wantedMods = inst.wantedMods.map(m =>
    !m.pinned && byId.has(m.projectId) ? { ...m, lastFileName: byId.get(m.projectId) } : m
  );
  setWantedMods(mcVersion, loader, wantedMods);
}

// закреплённый мод «Переустановить» не трогает вообще — не проверяет и не
// скачивает новую версию, оставляет то, что уже стоит (для случаев, когда
// новая версия мода что-то ломает и нужно нарочно сидеть на старой).
// fileName — снимок текущего файла на диске в момент закрепления, чтобы
// переустановка знала, что его нельзя удалять при уборке лишних файлов
function setModPinned(mcVersion, loader, projectId, pinned, fileName = null) {
  const inst = getInstance(mcVersion, loader);
  const wantedMods = inst.wantedMods.map(m =>
    m.projectId === projectId ? { ...m, pinned, pinnedFileName: pinned ? fileName : null } : m
  );
  setWantedMods(mcVersion, loader, wantedMods);
  return wantedMods;
}

function setWantedResourcePacks(mcVersion, loader, wantedResourcePacks) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), wantedResourcePacks };
  store.set('instances', instances);
}

function setWantedShaders(mcVersion, loader, wantedShaders) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), wantedShaders };
  store.set('instances', instances);
}

// то же самое, что rememberModFileNames, но для шейдеров
function rememberShaderFileNames(mcVersion, loader, resolvedShaders) {
  const inst = getInstance(mcVersion, loader);
  const byId = new Map(resolvedShaders.filter(s => s.fileName).map(s => [s.projectId, s.fileName]));
  const wantedShaders = inst.wantedShaders.map(s =>
    byId.has(s.projectId) ? { ...s, lastFileName: byId.get(s.projectId) } : s
  );
  setWantedShaders(mcVersion, loader, wantedShaders);
}

// то же самое, что rememberModFileNames, но для ресурспаков
function rememberResourcePackFileNames(mcVersion, loader, resolvedPacks) {
  const inst = getInstance(mcVersion, loader);
  const byId = new Map(resolvedPacks.filter(p => p.fileName).map(p => [p.projectId, p.fileName]));
  const wantedResourcePacks = inst.wantedResourcePacks.map(p =>
    !p.pinned && byId.has(p.projectId) ? { ...p, lastFileName: byId.get(p.projectId) } : p
  );
  setWantedResourcePacks(mcVersion, loader, wantedResourcePacks);
}

// закрепить/открепить текущую установленную версию ресурспака — так же, как setModPinned
function setResourcePackPinned(mcVersion, loader, projectId, pinned, fileName = null) {
  const inst = getInstance(mcVersion, loader);
  const wantedResourcePacks = inst.wantedResourcePacks.map(p =>
    p.projectId === projectId ? { ...p, pinned, pinnedFileName: pinned ? fileName : null } : p
  );
  setWantedResourcePacks(mcVersion, loader, wantedResourcePacks);
  return wantedResourcePacks;
}

// суммарное время игры в конкретном инстансе — копится при каждом закрытии игры
function addPlaytime(mcVersion, loader, ms) {
  if (!ms || ms < 0) return;
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  const inst = getInstance(mcVersion, loader);
  instances[key] = { ...inst, totalPlaytimeMs: (inst.totalPlaytimeMs || 0) + ms };
  store.set('instances', instances);
}

function getPlaytime(mcVersion, loader) {
  return getInstance(mcVersion, loader).totalPlaytimeMs || 0;
}

// статистика запусков: общая и по выбранной версии/загрузчику
function recordLaunch(mcVersion, loader) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  const inst = getInstance(mcVersion, loader);
  instances[key] = {
    ...inst,
    launchCount: (inst.launchCount || 0) + 1,
    lastPlayedAt: Date.now()
  };
  store.set('instances', instances);
  store.set('totalLaunches', (store.get('totalLaunches') || 0) + 1);
  return instances[key].launchCount;
}

function getLaunchStats(mcVersion, loader) {
  const inst = getInstance(mcVersion, loader);
  return {
    totalLaunches: store.get('totalLaunches') || 0,
    instanceLaunches: inst.launchCount || 0,
    instancePlaytimeMs: inst.totalPlaytimeMs || 0
  };
}

function getInstanceBackground(mcVersion, loader) {
  return getInstance(mcVersion, loader).backgroundPath || null;
}

function setInstanceBackground(mcVersion, loader, backgroundPath) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), backgroundPath: backgroundPath || null };
  store.set('instances', instances);
  return instances[key].backgroundPath;
}

// ---------- градиент и цвет сборки ----------
function getGradient() {
  return sanitizeConfig(store.get('gradient'));
}

function setGradient(config) {
  const clean = sanitizeConfig(config);
  store.set('gradient', clean);
  return clean;
}

// ---------- оформление ----------
function getAppearance() {
  return appearanceConfig.sanitizeConfig(store.get('appearance'));
}

function setAppearance(config) {
  const clean = appearanceConfig.sanitizeConfig(config);
  store.set('appearance', clean);
  return clean;
}

function getAppearancePresets() {
  const list = store.get('appearancePresets');
  return (Array.isArray(list) ? list : []).map(appearanceConfig.sanitizePreset).filter(p => p && p.id);
}

function saveAppearancePreset(preset) {
  const clean = appearanceConfig.sanitizePreset(preset);
  if (!clean) return getAppearancePresets();
  const list = getAppearancePresets();
  const id = clean.id || `u${Date.now().toString(36)}`;
  const next = { ...clean, id };
  const index = list.findIndex(p => p.id === id);
  if (index >= 0) list[index] = next;
  else list.push(next);
  store.set('appearancePresets', list.slice(-40));
  return getAppearancePresets();
}

function deleteAppearancePreset(id) {
  store.set('appearancePresets', getAppearancePresets().filter(p => p.id !== id));
  return getAppearancePresets();
}

// null = у сборки нет своего цвета, берётся общий
function getInstanceAccent(mcVersion, loader) {
  return sanitizeAccent(getInstance(mcVersion, loader).accent);
}

function setInstanceAccent(mcVersion, loader, accent) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  const clean = sanitizeAccent(accent);
  instances[key] = { ...getInstance(mcVersion, loader), accent: clean };
  store.set('instances', instances);
  return clean;
}

// Все сборки со своим цветом одним запросом — нужно для плиток «Недавние сборки»
function listInstanceAccents() {
  const instances = store.get('instances') || {};
  const out = {};
  for (const [key, inst] of Object.entries(instances)) {
    const clean = sanitizeAccent(inst && inst.accent);
    if (clean) out[key] = clean;
  }
  return out;
}

function getCurseforgeApiKey() {
  return store.get('curseforgeApiKey') || '';
}

function setCurseforgeApiKey(key) {
  store.set('curseforgeApiKey', (key || '').trim());
  return getCurseforgeApiKey();
}

function getLastSeenVersion() {
  return store.get('lastSeenVersion');
}

function setLastSeenVersion(version) {
  store.set('lastSeenVersion', version);
}

// список всех версий+лоадеров, для которых уже есть сохранённый список модов
function buildLabel(key) {
  const m = key.match(/^build-(.+)$/);
  if (!m) return null;
  const build = listBuilds().find(b => b.id === m[1]);
  return build ? `${build.name} (${build.mcVersion} ${build.loader})` : null;
}

function listInstances() {
  const instances = store.get('instances');
  return Object.keys(instances)
    .filter(key => (instances[key].wantedMods || []).length)
    .map(key => ({ key, label: buildLabel(key), wantedMods: instances[key].wantedMods.map(normalizeItem) }));
}

// то же самое, но для ресурспаков — нужно отдельно, т.к. набор версий с модами
// и версий с ресурспаками не обязательно совпадает
function listResourcePackInstances() {
  const instances = store.get('instances');
  return Object.keys(instances)
    .filter(key => (instances[key].wantedResourcePacks || []).length)
    .map(key => ({ key, label: buildLabel(key), wantedResourcePacks: instances[key].wantedResourcePacks.map(normalizeItem) }));
}

// ссылка на .zip с "официальной" сборкой сообщества для конкретной версии+лоадера —
// её задаёт админ PFC один раз, а игроки потом просто жмут "обновить" без ручного ввода url
function getCommunityBuildUrl(mcVersion, loader) {
  return getInstance(mcVersion, loader).communityBuildUrl || null;
}

function setCommunityBuildUrl(mcVersion, loader, url) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), communityBuildUrl: url || null };
  store.set('instances', instances);
  return instances[key].communityBuildUrl;
}

// какая версия Meteor Client сейчас стоит в этом инстансе — чтобы не качать
// заново то, что уже актуально
function getMeteorClientVersion(mcVersion, loader) {
  return getInstance(mcVersion, loader).meteorClientVersion || null;
}

function setMeteorClientVersion(mcVersion, loader, version) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), meteorClientVersion: version || null };
  store.set('instances', instances);
  return instances[key].meteorClientVersion;
}

// null означает "автоматически" — installFabric сам возьмёт последнюю стабильную
function getFabricLoaderVersion(mcVersion, loader) {
  return getInstance(mcVersion, loader).fabricLoaderVersion || null;
}

function setFabricLoaderVersion(mcVersion, loader, version) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), fabricLoaderVersion: version || null };
  store.set('instances', instances);
  return instances[key].fabricLoaderVersion;
}

// версия NeoForge закрепляется отдельно от Fabric Loader: ключ инстанса и так
// содержит загрузчик ("1.21.1-neoforge"), но отдельное поле не даёт им путаться
function getNeoforgeVersion(mcVersion, loader) {
  return getInstance(mcVersion, loader).neoforgeVersion || null;
}

function setNeoforgeVersion(mcVersion, loader, version) {
  const key = instanceKey(mcVersion, loader);
  const instances = store.get('instances');
  instances[key] = { ...getInstance(mcVersion, loader), neoforgeVersion: version || null };
  store.set('instances', instances);
  return instances[key].neoforgeVersion;
}

// Токены аккаунтов (access/refresh) шифруем средствами ОС (DPAPI на Windows, Keychain на macOS),
// чтобы они не лежали в конфиге открытым текстом. Если шифрование недоступно
// (например, Linux без keyring) — остаётся как раньше, без потери входа.
function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function sealAuth(mclcAuth) {
  if (!mclcAuth || mclcAuth.__enc || !canEncrypt()) return mclcAuth;
  try {
    return { __enc: safeStorage.encryptString(JSON.stringify(mclcAuth)).toString('base64') };
  } catch {
    return mclcAuth;
  }
}

function openAuth(mclcAuth) {
  if (!mclcAuth || !mclcAuth.__enc) return mclcAuth;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(mclcAuth.__enc, 'base64')));
  } catch {
    // конфиг перенесли на другой компьютер или сменился пользователь ОС — нужен повторный вход
    return null;
  }
}

const sealAccount = account => (account ? { ...account, mclcAuth: sealAuth(account.mclcAuth) } : account);
const openAccount = account => (account ? { ...account, mclcAuth: openAuth(account.mclcAuth) } : account);

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// у офлайн-аккаунтов старых версий UUID был нулевой у всех — выдаём каждому ник-зависимый
function migrateOfflineUuids() {
  const accounts = store.get('accounts') || [];
  let changed = false;
  const next = accounts.map(account => {
    if (account?.profile?.type !== 'offline' || account.profile.uuid !== ZERO_UUID) return account;
    if (!isValidOfflineName(account.profile.name)) return account;
    const uuid = offlineUuid(account.profile.name);
    const auth = openAuth(account.mclcAuth);
    changed = true;
    return sealAccount({
      ...account,
      profile: { ...account.profile, uuid },
      mclcAuth: auth ? { ...auth, uuid } : auth
    });
  });
  if (changed) store.set('accounts', next);
}

// один раз зашифровываем аккаунты, сохранённые старыми версиями открытым текстом
function migrateAccountsEncryption() {
  migrateOfflineUuids();
  if (!canEncrypt()) return;
  const accounts = store.get('accounts') || [];
  if (!accounts.some(a => a && a.mclcAuth && !a.mclcAuth.__enc)) return;
  store.set('accounts', accounts.map(sealAccount));
}

function getAccountAt(index) {
  const accounts = store.get('accounts') || [];
  return openAccount(accounts[index]);
}

function addAccount(profile, mclcAuth){
    const accounts = store.get("accounts") || [];
    let index = accounts.findIndex(
        a => a?.profile?.uuid === profile.uuid
    );
    const entry = sealAccount({ profile, mclcAuth });
    if(index === -1){
        accounts.push(entry);
        index = accounts.length - 1;
    } else {
        // повторный вход в уже добавленный аккаунт — обновляем токены,
        // иначе останутся старые (просроченные), и вход «не сработает»
        accounts[index] = entry;
    }
    store.set("accounts", accounts);
    store.set(
        "selectedAccountIndex",
        index
    );
}

function getSelectedAccount() {
  const accounts = store.get('accounts') || [];
  const index = store.get('selectedAccountIndex') || 0;
  return openAccount(accounts[index]);
}

function listAccounts() {
  const accounts = store.get('accounts') || [];
  const selectedIndex = store.get('selectedAccountIndex') || 0;
  return accounts.map((a, i) => ({ index: i, profile: a.profile, selected: i === selectedIndex }));
}

function selectAccount(index) {
  const accounts = store.get('accounts') || [];
  if (!accounts[index]) throw new Error('Аккаунт не найден');
  store.set('selectedAccountIndex', index);
  return accounts[index].profile;
}

function removeAccount(index) {
  const accounts = store.get('accounts') || [];
  if (!accounts[index]) throw new Error('Аккаунт не найден');
  accounts.splice(index, 1);
  store.set('accounts', accounts);

  const selectedIndex = store.get('selectedAccountIndex') || 0;
  if (selectedIndex >= accounts.length) store.set('selectedAccountIndex', Math.max(0, accounts.length - 1));
  return listAccounts();
}

function toggleFavoriteScreenshot(filePath) {
  const favorites = store.get('favoriteScreenshots') || [];
  const next = favorites.includes(filePath)
    ? favorites.filter(p => p !== filePath)
    : [...favorites, filePath];
  store.set('favoriteScreenshots', next);
  return next;
}

function removeFavoriteScreenshot(filePath) {
  const favorites = (store.get('favoriteScreenshots') || []).filter(p => p !== filePath);
  store.set('favoriteScreenshots', favorites);
  return favorites;
}

function getCustomSkinLoaderEnabled() {
  return store.get('customSkinLoaderEnabled');
}

function setCustomSkinLoaderEnabled(enabled) {
  store.set('customSkinLoaderEnabled', !!enabled);
  return !!enabled;
}

function toggleFavoriteVersion(versionId) {
  const favorites = store.get('favoriteVersions') || [];
  const next = favorites.includes(versionId)
    ? favorites.filter(id => id !== versionId)
    : [...favorites, versionId];
  store.set('favoriteVersions', next);
  return next;
}

function saveAccountAt(index, account) {
  const accounts = store.get('accounts') || [];
  if (!accounts[index]) return;
  accounts[index] = sealAccount(account);
  store.set('accounts', accounts);
}

function saveSelectedAccount(account){
    const accounts = store.get("accounts");

    const index = store.get("selectedAccountIndex");

    accounts[index] = sealAccount(account);

    store.set(
        "accounts",
        accounts
    );

}

function listModpackProfiles() {
  return store.get('modpackProfiles') || [];
}

function saveModpackProfile(name, loader, mods) {
  const profiles = store.get('modpackProfiles') || [];
  const id = crypto.randomUUID();
  profiles.push({ id, name, loader, mods, createdAt: Date.now() });
  store.set('modpackProfiles', profiles);
  return profiles;
}

function renameModpackProfile(id, newName) {
  const profiles = store.get('modpackProfiles') || [];
  const profile = profiles.find(p => p.id === id);
  if (!profile) throw new Error('Профиль не найден');
  profile.name = newName;
  store.set('modpackProfiles', profiles);
  return profiles;
}

function deleteModpackProfile(id) {
  const profiles = (store.get('modpackProfiles') || []).filter(p => p.id !== id);
  store.set('modpackProfiles', profiles);
  return profiles;
}

function listResourcePackProfiles() {
  return store.get('resourcePackProfiles') || [];
}

function saveResourcePackProfile(name, loader, packs, installedPacks = null) {
  const profiles = store.get('resourcePackProfiles') || [];
  const profile = resourcePackProfiles.createProfileRecord({
    id: crypto.randomUUID(), name, loader, packs, installedPacks, createdAt: Date.now()
  });
  profiles.push(profile);
  store.set('resourcePackProfiles', profiles);
  return profiles;
}

function renameResourcePackProfile(id, newName) {
  const profiles = store.get('resourcePackProfiles') || [];
  const profile = profiles.find(p => p.id === id);
  if (!profile) throw new Error('Профиль не найден');
  profile.name = newName;
  store.set('resourcePackProfiles', profiles);
  return profiles;
}

function deleteResourcePackProfile(id) {
  const profiles = (store.get('resourcePackProfiles') || []).filter(p => p.id !== id);
  store.set('resourcePackProfiles', profiles);
  return profiles;
}

module.exports = {
  store,
  migrateAccountsEncryption,
  getAccountAt,
  addAccount, 
  getSelectedAccount,
  listAccounts,
  selectAccount,
  removeAccount,
  instanceKey,
  listBuilds,
  getActiveBuild,
  createBuild,
  renameBuild,
  setBuildMeta,
  removeBuildRecord,
  setBuildFolder,
  setFolderChecker,
  takenFolders,
  setActiveBuild,
  getInstance,
  setWantedMods,
  getModGroups, createModGroup, renameModGroup, deleteModGroup, assignModsToGroup, removeModsFromGroup,
  listFavoriteMods, listFavoriteModRecords, toggleFavoriteMod,
  rememberModFileNames,
  setModPinned,
  setWantedResourcePacks,
  rememberResourcePackFileNames,
  setResourcePackPinned,
  setWantedShaders,
  rememberShaderFileNames,
  listInstances,
  listResourcePackInstances,
  saveSelectedAccount,
  saveAccountAt,
  toggleFavoriteVersion,
  listModpackProfiles,
  saveModpackProfile,
  renameModpackProfile,
  deleteModpackProfile,
  listResourcePackProfiles,
  saveResourcePackProfile,
  renameResourcePackProfile,
  deleteResourcePackProfile,
  getCommunityBuildUrl,
  setCommunityBuildUrl,
  getMeteorClientVersion,
  setMeteorClientVersion,
  getFabricLoaderVersion,
  setFabricLoaderVersion,
  getNeoforgeVersion,
  setNeoforgeVersion,
  toggleFavoriteScreenshot,
  removeFavoriteScreenshot,
  getCustomSkinLoaderEnabled,
  setCustomSkinLoaderEnabled,
  addPlaytime,
  getPlaytime,
  recordLaunch,
  getLaunchStats,
  getCurseforgeApiKey,
  getInstanceBackground,
  setInstanceBackground,
  getLaunchSettings,
  setLaunchSettings,
  listGamePresets,
  saveGamePreset,
  deleteGamePreset,
  getServerPreset,
  saveServerPreset,
  deleteServerPreset,
  getAppearance,
  setAppearance,
  getAppearancePresets,
  saveAppearancePreset,
  deleteAppearancePreset,
  getGradient,
  setGradient,
  getInstanceAccent,
  setInstanceAccent,
  listInstanceAccents,
  setCurseforgeApiKey,
  getLastSeenVersion,
  setLastSeenVersion,
};
