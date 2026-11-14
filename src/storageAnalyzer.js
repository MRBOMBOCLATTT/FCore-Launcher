const fs = require('fs');
const path = require('path');

const MAX_DEPTH = 32;
const MAX_FILES = 250000;
const TOP_FILES = 20;
const YIELD_EVERY = 1200;

const sleepTick = () => new Promise(resolve => setImmediate(resolve));

async function scanDirectory(dir, { maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  const result = {
    path: dir,
    sizeBytes: 0,
    fileCount: 0,
    dirCount: 0,
    childFolders: new Map(),
    largestFiles: [],
    warnings: [],
    truncated: false
  };
  let visited = 0;
  const stack = [{ dir, depth: 0, relative: '' }];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch (err) {
      result.warnings.push({ path: current.relative || '.', reason: err.code || err.message });
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      const rel = current.relative ? path.join(current.relative, entry.name) : entry.name;

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        result.dirCount++;
        if (current.depth < maxDepth) stack.push({ dir: fullPath, depth: current.depth + 1, relative: rel });
        else result.truncated = true;
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = await fs.promises.stat(fullPath);
        result.sizeBytes += stat.size;
        result.fileCount++;
        const firstSegment = current.relative ? current.relative.split(path.sep)[0] : '[файлы]';
        const child = result.childFolders.get(firstSegment) || { name: firstSegment, sizeBytes: 0, fileCount: 0 };
        child.sizeBytes += stat.size;
        child.fileCount++;
        result.childFolders.set(firstSegment, child);
        result.largestFiles.push({ name: entry.name, relativePath: rel, sizeBytes: stat.size });
        if (result.largestFiles.length > TOP_FILES * 3) {
          result.largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
          result.largestFiles.length = TOP_FILES;
        }
      } catch (err) {
        result.warnings.push({ path: rel, reason: err.code || err.message });
      }

      visited++;
      if (visited >= maxFiles) {
        result.truncated = true;
        stack.length = 0;
        break;
      }
      if (visited % YIELD_EVERY === 0) await sleepTick();
    }
  }

  result.largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
  result.largestFiles = result.largestFiles.slice(0, TOP_FILES);
  result.childFolders = [...result.childFolders.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
  return result;
}

function displayNameForDirectory(name) {
  const labels = {
    instances: 'Сборки', assets: 'Ресурсы Minecraft', libraries: 'Библиотеки', versions: 'Версии Minecraft',
    mods: 'Моды', resourcepacks: 'Ресурспаки', shaderpacks: 'Шейдеры', saves: 'Миры', screenshots: 'Скриншоты',
    logs: 'Логи', 'crash-reports': 'Отчёты о вылетах', backups: 'Резервные копии', cache: 'Кэш', downloads: 'Загрузки',
    'server-resource-packs': 'Серверные ресурспаки', config: 'Конфигурации'
  };
  return labels[name] || name;
}

async function analyzeStorage(root, builds = []) {
  const categories = [];
  const buildRows = [];
  const largestFiles = [];
  const warnings = [];
  let totalBytes = 0;
  let totalFiles = 0;

  let rootEntries = [];
  try { rootEntries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (err) { throw new Error(`Не удалось прочитать папку игры: ${err.message}`); }

  const instancesPath = path.join(root, 'instances');
  const instanceFolders = rootEntries.find(e => e.name === 'instances' && e.isDirectory())
    ? await fs.promises.readdir(instancesPath, { withFileTypes: true }).catch(() => [])
    : [];
  const buildByFolder = new Map(builds.map(b => [String(b.folder || `build-${b.id}`).toLowerCase(), b]));
  let instancesTotal = 0, instancesFiles = 0;

  for (const entry of instanceFolders) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const folder = entry.name;
    const scanned = await scanDirectory(path.join(instancesPath, folder));
    const build = buildByFolder.get(folder.toLowerCase());
    instancesTotal += scanned.sizeBytes;
    instancesFiles += scanned.fileCount;
    totalBytes += scanned.sizeBytes;
    totalFiles += scanned.fileCount;
    largestFiles.push(...scanned.largestFiles.map(f => ({ ...f, build: build?.name || folder, path: path.join('instances', folder, f.relativePath) })));
    warnings.push(...scanned.warnings.map(w => ({ ...w, path: path.join('instances', folder, w.path) })));
    buildRows.push({
      id: build?.id || null,
      name: build?.name || folder,
      folder,
      mcVersion: build?.mcVersion || null,
      loader: build?.loader || null,
      sizeBytes: scanned.sizeBytes,
      fileCount: scanned.fileCount,
      truncated: scanned.truncated,
      categories: scanned.childFolders.map(c => ({ ...c, label: displayNameForDirectory(c.name) }))
    });
  }
  if (instanceFolders.length || rootEntries.some(e => e.name === 'instances')) {
    categories.push({ name: 'Сборки', key: 'instances', sizeBytes: instancesTotal, fileCount: instancesFiles });
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'instances') continue;
    const scanned = await scanDirectory(path.join(root, entry.name));
    totalBytes += scanned.sizeBytes;
    totalFiles += scanned.fileCount;
    categories.push({ name: displayNameForDirectory(entry.name), key: entry.name, sizeBytes: scanned.sizeBytes, fileCount: scanned.fileCount, truncated: scanned.truncated });
    largestFiles.push(...scanned.largestFiles.map(f => ({ ...f, path: path.join(entry.name, f.relativePath) })));
    warnings.push(...scanned.warnings.map(w => ({ ...w, path: path.join(entry.name, w.path) })));
  }

  // Отдельные файлы в корне .minecraft тоже учитываются.
  const rootFiles = rootEntries.filter(e => e.isFile());
  let rootFileBytes = 0;
  for (const entry of rootFiles) {
    try {
      const stat = await fs.promises.stat(path.join(root, entry.name));
      rootFileBytes += stat.size;
      totalFiles++;
      totalBytes += stat.size;
      largestFiles.push({ name: entry.name, path: entry.name, sizeBytes: stat.size });
    } catch (err) { warnings.push({ path: entry.name, reason: err.code || err.message }); }
  }
  if (rootFileBytes) categories.push({ name: 'Файлы в корне', key: '[root]', sizeBytes: rootFileBytes, fileCount: rootFiles.length });

  categories.sort((a, b) => b.sizeBytes - a.sizeBytes);
  buildRows.sort((a, b) => b.sizeBytes - a.sizeBytes);
  largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    rootName: path.basename(path.resolve(root)),
    totalBytes,
    totalFiles,
    categories,
    builds: buildRows,
    largestFiles: largestFiles.slice(0, 20),
    warnings: warnings.slice(0, 30),
    generatedAt: Date.now()
  };
}

module.exports = { scanDirectory, analyzeStorage, displayNameForDirectory };
