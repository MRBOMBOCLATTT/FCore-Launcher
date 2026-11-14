// Чистая логика для сравнения сборок, подбора оптимизационных модов и переноса на другую версию.
// Здесь нет обращений к диску и сети — это проще тестировать; сам ввод-вывод в main.js.

// ---------- сравнение сборок ----------

// inventory: [{ key, name, version, fileName }], key — id мода (или имя файла, если метаданных нет)
function compareInventories(a, b) {
  const mapA = new Map(a.map(m => [m.key, m]));
  const mapB = new Map(b.map(m => [m.key, m]));
  const byName = (x, y) => x.name.localeCompare(y.name);

  const onlyA = [];
  const onlyB = [];
  const different = [];
  let same = 0;

  for (const [key, left] of mapA) {
    const right = mapB.get(key);
    if (!right) onlyA.push({ key, name: left.name, version: left.version });
    else if ((left.version || '') !== (right.version || '')) {
      different.push({ key, name: left.name, versionA: left.version || '—', versionB: right.version || '—' });
    } else same++;
  }
  for (const [key, right] of mapB) {
    if (!mapA.has(key)) onlyB.push({ key, name: right.name, version: right.version });
  }
  return { onlyA: onlyA.sort(byName), onlyB: onlyB.sort(byName), different: different.sort(byName), same };
}

// простое сравнение списков имён (ресурспаки, шейдеры)
function compareNames(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyA: a.filter(n => !setB.has(n)).sort(),
    onlyB: b.filter(n => !setA.has(n)).sort(),
    same: a.filter(n => setB.has(n)).length
  };
}

// ---------- перенос модов между сборками ----------

// sourceInv и targetInv: [{ key, name, version, fileName, requires: [id], provides: [id] }]
// selectedKeys: моды, которые отметил пользователь. Обязательные зависимости, которых нет
// в целевой сборке, добавляем сами: без них мод не запустится.
// builtin: id, которые даёт игра или загрузчик, их искать в папке модов не нужно.
function planModTransfer(selectedKeys, sourceInv, targetInv, builtin = new Set()) {
  const bySourceKey = new Map(sourceInv.map(m => [m.key, m]));
  const providers = new Map();
  for (const m of sourceInv) {
    for (const id of [m.key, ...(m.provides || [])]) if (!providers.has(id)) providers.set(id, m);
  }
  const have = new Set();
  for (const m of targetInv) {
    for (const id of [m.key, ...(m.provides || [])]) have.add(id);
  }

  const picked = new Map();
  const deps = new Map();
  const missing = new Set();
  const queue = [];

  for (const key of selectedKeys) {
    const mod = bySourceKey.get(key);
    if (mod && !picked.has(key)) {
      picked.set(key, mod);
      queue.push(mod);
    }
  }

  while (queue.length) {
    const mod = queue.shift();
    for (const id of mod.requires || []) {
      if (builtin.has(id) || have.has(id)) continue;
      const provider = providers.get(id);
      if (!provider) {
        missing.add(id);
        continue;
      }
      if (picked.has(provider.key) || deps.has(provider.key)) continue;
      deps.set(provider.key, provider);
      queue.push(provider);
    }
  }

  return {
    mods: [...picked.values()],
    deps: [...deps.values()],
    missing: [...missing].sort()
  };
}

// сохраняет в целевой записи сборки то, что нужно переустановке, чтобы она не удалила перенесённый файл:
// wanted — записи списка модов исходной сборки, files — перенесённые файлы
function mergeWantedMods(targetWanted, sourceWanted, files) {
  const result = [...targetWanted];
  const added = [];
  const unlisted = [];
  for (const { fileName } of files) {
    const entry = sourceWanted.find(w => w.lastFileName === fileName || w.pinnedFileName === fileName);
    if (!entry) {
      unlisted.push(fileName);
      continue;
    }
    if (result.some(w => w.projectId === entry.projectId)) continue;
    const copy = { ...entry };
    if (copy.pinnedFileName) copy.pinnedFileName = fileName;
    result.push(copy);
    added.push(copy);
  }
  return { wanted: result, added, unlisted };
}

// ---------- оптимизация ----------

const COMMON = [
  { slug: 'ferrite-core', modId: 'ferritecore', title: 'FerriteCore', why: 'Заметно меньше потребление оперативной памяти' },
  { slug: 'modernfix', modId: 'modernfix', title: 'ModernFix', why: 'Быстрее загрузка игры и меньше памяти' },
  { slug: 'entityculling', modId: 'entityculling', title: 'Entity Culling', why: 'Не рисует мобов и блоки, которых не видно' },
  { slug: 'immediatelyfast', modId: 'immediatelyfast', title: 'ImmediatelyFast', why: 'Быстрее отрисовка интерфейса и текста' },
  { slug: 'dynamic-fps', modId: 'dynamic_fps', title: 'Dynamic FPS', why: 'Снижает нагрузку, когда окно свёрнуто или не в фокусе' },
  { slug: 'memoryleakfix', modId: 'memoryleakfix', title: 'MemoryLeakFix', why: 'Исправляет утечки памяти в самой игре' }
];

const RENDERER = {
  fabric: { slug: 'sodium', modId: 'sodium', title: 'Sodium', why: 'Главный прирост FPS: современный движок отрисовки' },
  forge: { slug: 'embeddium', modId: 'embeddium', title: 'Embeddium', why: 'Главный прирост FPS: порт Sodium для Forge' },
  neoforge: { slug: 'embeddium', modId: 'embeddium', title: 'Embeddium', why: 'Главный прирост FPS: порт Sodium для NeoForge' }
};

const LOGIC = {
  fabric: { slug: 'lithium', modId: 'lithium', title: 'Lithium', why: 'Оптимизирует игровую логику: тики, мобы, физику' }
};

// моды, которые заменяют друг друга: если стоит любой, остальные из группы не предлагаем
const RENDER_GROUP = ['sodium', 'embeddium', 'rubidium', 'optifine'];

function optimizationSet(loader) {
  if (!['fabric', 'forge', 'neoforge'].includes(loader)) return [];
  const set = [];
  if (RENDERER[loader]) set.push({ ...RENDERER[loader], group: 'render' });
  if (LOGIC[loader]) set.push(LOGIC[loader]);
  return [...set, ...COMMON];
}

// installedIds — id модов, которые уже лежат в сборке (включённые)
// state: 'installed' — уже есть, 'conflict' — стоит замена рендерера, 'candidate' — можно добавить
function planOptimization(loader, installedIds) {
  const ids = new Set(installedIds);
  const hasRenderer = RENDER_GROUP.some(id => ids.has(id));
  return optimizationSet(loader).map(item => {
    let state = 'candidate';
    if (ids.has(item.modId)) state = 'installed';
    else if (item.group === 'render' && hasRenderer) state = 'conflict';
    return { ...item, state };
  });
}

// ---------- перенос на другую версию ----------

// статусы: 'ok' — есть версия под новую игру, 'missing' — на Modrinth нет, 'unknown' — источник не проверяем
function summarizeMigration(items) {
  const count = status => items.filter(i => i.status === status).length;
  return { ok: count('ok'), missing: count('missing'), unknown: count('unknown'), total: items.length };
}

// сравнение версий Minecraft вида 1.21.4 / 1.20 (для выбора «более новых» версий)
function compareMcVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// версии без сборки: папки <версия>-<загрузчик> в instances, в которых что-то лежит
const LEGACY_FOLDER_RE = /^(.+)-(fabric|forge|neoforge|quilt|vanilla)$/;

function scanLegacyVersions(instancesRoot, exclude = new Set()) {
  const fs = require('fs');
  const path = require('path');
  const count = (dir, test) => {
    try { return fs.readdirSync(dir).filter(test).length; } catch { return 0; }
  };
  const isPack = name => /\.(zip|jar)(\.disabled)?$/i.test(name);
  let names = [];
  try { names = fs.readdirSync(instancesRoot); } catch { return []; }
  return names.map(folder => {
    const match = LEGACY_FOLDER_RE.exec(folder);
    if (!match || exclude.has(folder.toLowerCase())) return null;
    const dir = path.join(instancesRoot, folder);
    try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
    const mods = count(path.join(dir, 'mods'), isPack);
    const resourcePacks = count(path.join(dir, 'resourcepacks'), isPack);
    const shaders = count(path.join(dir, 'shaderpacks'), isPack);
    if (!mods && !resourcePacks && !shaders) return null;
    return { folder, mcVersion: match[1], loader: match[2], mods, resourcePacks, shaders, hasWorlds: fs.existsSync(path.join(dir, 'saves')) };
  }).filter(Boolean).sort((a, b) => b.mods - a.mods);
}

module.exports = {
  scanLegacyVersions,
  compareInventories, compareNames,
  planModTransfer, mergeWantedMods,
  optimizationSet, planOptimization,
  summarizeMigration, compareMcVersions
};
