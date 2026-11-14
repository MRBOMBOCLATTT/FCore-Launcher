const path = require('path');

const SNAPSHOT_ROOTS = Object.freeze([
  'mods',
  'resourcepacks',
  'shaderpacks',
  'config',
  'defaultconfigs',
  'kubejs',
  'scripts',
  'options.txt',
  'optionsof.txt',
  'optionsshaders.txt',
  'servers.dat'
]);

const SNAPSHOT_DIRS = new Set([
  'mods', 'resourcepacks', 'shaderpacks', 'config', 'defaultconfigs', 'kubejs', 'scripts'
]);
const SNAPSHOT_FILES = new Set([
  'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat'
]);

function sanitizeSnapshotName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 64);
  if (!name) throw new Error('Введите название снимка');
  return name;
}

function slugifySnapshotName(value) {
  return sanitizeSnapshotName(value)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'snapshot';
}

function validateManagedRoots(roots, formatVersion = 1) {
  const fallback = formatVersion >= 2 ? SNAPSHOT_ROOTS : ['mods', 'resourcepacks'];
  const source = Array.isArray(roots) ? roots : fallback;
  const unique = [...new Set(source)];
  if (!unique.length || unique.some(root => !SNAPSHOT_ROOTS.includes(root))) {
    throw new Error('Снимок содержит недопустимый список директорий');
  }
  return unique;
}

// ZIP entry names use POSIX separators regardless of the host OS. Reject
// traversal, drive letters, absolute paths and alternate separators before
// touching the file system.
function resolveSnapshotEntry(stagingRoot, entryName, allowedRoots) {
  if (typeof entryName !== 'string' || !entryName || entryName.includes('\\') || entryName.includes('\0')) {
    throw new Error('Снимок содержит некорректный путь');
  }
  if (entryName.startsWith('/') || /^[a-z]:/i.test(entryName)) {
    throw new Error('Снимок содержит абсолютный путь');
  }

  const parts = entryName.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:\"|?*]/.test(part))) {
    throw new Error('Снимок содержит небезопасный путь');
  }
  const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (parts.some(part => reservedNames.test(part))) throw new Error('Снимок содержит зарезервированное имя файла');
  if (!allowedRoots.includes(parts[0])) {
    throw new Error(`Снимок содержит неизвестную директорию: ${parts[0]}`);
  }

  const target = path.resolve(stagingRoot, ...parts);
  const relative = path.relative(path.resolve(stagingRoot), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Путь снимка выходит за пределы временной папки');
  }
  return target;
}

function formatSnapshotSummary(summary = {}) {
  const ruCount = (value, forms) => {
    const n = Math.abs(Number(value)) % 100;
    const last = n % 10;
    const index = n > 10 && n < 20 ? 2 : last > 1 && last < 5 ? 1 : last === 1 ? 0 : 2;
    return `${value} ${forms[index]}`;
  };
  const parts = [];
  if (summary.mods) parts.push(ruCount(summary.mods, ['мод', 'мода', 'модов']));
  if (summary.resourcePacks) parts.push(ruCount(summary.resourcePacks, ['ресурспак', 'ресурспака', 'ресурспаков']));
  if (summary.shaders) parts.push(ruCount(summary.shaders, ['шейдер', 'шейдера', 'шейдеров']));
  if (summary.configFiles) parts.push(ruCount(summary.configFiles, ['файл конфигурации', 'файла конфигурации', 'файлов конфигурации']));
  if (summary.settingsFiles) parts.push(ruCount(summary.settingsFiles, ['игровая настройка', 'игровые настройки', 'игровых настроек']));
  return parts.length ? parts.join(' · ') : 'Без файлов контента';
}

module.exports = {
  SNAPSHOT_ROOTS,
  SNAPSHOT_DIRS,
  SNAPSHOT_FILES,
  sanitizeSnapshotName,
  slugifySnapshotName,
  validateManagedRoots,
  resolveSnapshotEntry,
  formatSnapshotSummary
};
