const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const modManager = require('./modManager');
const { getInstance, setWantedMods, setWantedResourcePacks, setWantedShaders, getLaunchSettings, setLaunchSettings } = require('./store');
const launchSettingsModule = require('./launchSettings');
const zipStream = require('./zipStream');
const {
  SNAPSHOT_ROOTS,
  SNAPSHOT_DIRS,
  SNAPSHOT_FILES,
  sanitizeSnapshotName,
  slugifySnapshotName,
  validateManagedRoots,
  resolveSnapshotEntry,
  formatSnapshotSummary
} = require('./buildSnapshotUtils');

const MAX_BUILD_SNAPSHOTS = 30;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function getBuildBackupsDir(root, mcVersion, loader) {
  return path.join(modManager.getInstanceDir(root, mcVersion, loader), 'build-backups');
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getSnapshotPath(root, mcVersion, loader, backupPath) {
  const backupsDir = getBuildBackupsDir(root, mcVersion, loader);
  const resolved = path.resolve(String(backupPath || ''));
  if (!isInside(backupsDir, resolved) || path.dirname(resolved) !== path.resolve(backupsDir)) {
    throw new Error('Недопустимый путь к снимку сборки');
  }
  if (path.extname(resolved).toLowerCase() !== '.zip') throw new Error('Ожидается ZIP-снимок сборки');
  if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink() || !fs.statSync(resolved).isFile()) {
    throw new Error('Снимок сборки не найден — возможно, уже удалён');
  }
  return resolved;
}

function addDirectoryFilesToZip(zip, diskDir, zipRoot, rootName, summary) {
  if (!fs.existsSync(diskDir)) return;
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute, path.join(relative, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (rootName === 'mods' && !(lower.endsWith('.jar') || lower.endsWith('.jar.disabled'))) continue;
      if ((rootName === 'resourcepacks' || rootName === 'shaderpacks') && !(lower.endsWith('.zip') || lower.endsWith('.zip.disabled'))) continue;

      const relativePath = relative ? path.join(relative, entry.name) : entry.name;
      const zipPath = `${zipRoot}/${relativePath.split(path.sep).join('/')}`;
      zipStream.addFile(zip, absolute, zipPath);
      const stat = fs.statSync(absolute);
      summary.files++;
      summary.bytes += stat.size;
      if (rootName === 'mods') summary.mods++;
      else if (rootName === 'resourcepacks') summary.resourcePacks++;
      else if (rootName === 'shaderpacks') summary.shaders++;
      else summary.configFiles++;
    }
  };
  visit(diskDir);
}

function snapshotLabelForReason(label) {
  const labels = {
    manual: 'Ручной снимок',
    'before-update': 'Перед обновлением',
    'before-mods-reinstall': 'Перед переустановкой модов',
    'before-community-update': 'Перед обновлением сборки сообщества',
    'before-resourcepacks-reinstall': 'Перед переустановкой ресурспаков',
    'before-rollback': 'Перед восстановлением',
    'before-autofix': 'Перед автоматическим исправлением',
    'before-restore': 'Перед восстановлением снимка'
  };
  return labels[label] || `Автоматический снимок · ${String(label || 'unknown').slice(0, 40)}`;
}

function collectSnapshotContent(instanceDir) {
  const zip = zipStream.createZip();
  const summary = {
    files: 0,
    bytes: 0,
    mods: 0,
    resourcePacks: 0,
    shaders: 0,
    configFiles: 0,
    settingsFiles: 0
  };
  const existingRoots = [];

  for (const rootName of SNAPSHOT_ROOTS) {
    const diskPath = path.join(instanceDir, rootName);
    if (!fs.existsSync(diskPath)) continue;
    const stat = fs.lstatSync(diskPath);
    if (stat.isSymbolicLink()) continue;
    if (SNAPSHOT_DIRS.has(rootName)) {
      if (!stat.isDirectory()) continue;
      existingRoots.push(rootName);
      addDirectoryFilesToZip(zip, diskPath, rootName, rootName, summary);
    } else if (stat.isFile()) {
      existingRoots.push(rootName);
      zipStream.addFile(zip, diskPath, rootName);
      summary.files++;
      summary.bytes += stat.size;
      summary.settingsFiles++;
    }
  }
  return { zip, summary, existingRoots };
}

function pruneOldSnapshots(backupsDir) {
  const files = fs.readdirSync(backupsDir)
    .filter(file => file.toLowerCase().endsWith('.zip'))
    .map(file => ({ file, mtime: fs.statSync(path.join(backupsDir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const item of files.slice(MAX_BUILD_SNAPSHOTS)) {
    try { fs.unlinkSync(path.join(backupsDir, item.file)); }
    catch (err) { console.warn('[buildSnapshot] не удалось удалить старый снимок:', err.message); }
  }
}

async function createBuildSnapshot(root, mcVersion, loader, options = {}) {
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  const displayName = sanitizeSnapshotName(options.name || snapshotLabelForReason(options.reason || 'manual'));
  const createdAt = Date.now();
  const backupsDir = getBuildBackupsDir(root, mcVersion, loader);
  fs.mkdirSync(backupsDir, { recursive: true });

  const { zip, summary, existingRoots } = collectSnapshotContent(instanceDir);
  const inst = getInstance(mcVersion, loader);
  const launch = getLaunchSettings(mcVersion, loader);

  const hasMetadata = (inst.wantedMods?.length || 0) + (inst.wantedResourcePacks?.length || 0) + (inst.wantedShaders?.length || 0) > 0;
  const portableLaunch = { ...launch, javaPath: '' };
  const defaultPortableLaunch = { ...launchSettingsModule.DEFAULTS, javaPath: '' };
  const hasCustomLaunchSettings = JSON.stringify(portableLaunch) !== JSON.stringify(defaultPortableLaunch);
  if (!summary.files && !hasMetadata && !hasCustomLaunchSettings) {
    try { zip.outputStream.destroy(); } catch {}
    return null;
  }

  const manifest = {
    format: 'fcore-build-snapshot',
    formatVersion: 2,
    id: crypto.randomUUID(),
    name: displayName,
    createdAt,
    mcVersion,
    loader,
    managedRoots: SNAPSHOT_ROOTS,
    includedRoots: existingRoots,
    summary,
    wantedMods: inst.wantedMods || [],
    wantedResourcePacks: inst.wantedResourcePacks || [],
    wantedShaders: inst.wantedShaders || [],
    // Java path is intentionally excluded: it may point to a machine-specific JRE.
    launchSettings: { ...launch, javaPath: '' }
  };
  zipStream.addBuffer(zip, Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');

  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  const fileName = `snapshot-${stamp}-${slugifySnapshotName(displayName)}.zip`;
  const zipPath = path.join(backupsDir, fileName);
  try {
    await zipStream.finalizeZip(zip, zipPath);
  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch {}
    throw err;
  }

  pruneOldSnapshots(backupsDir);
  return zipPath;
}

// Existing automatic call sites use backupBuild(). Keep this API and label
// convention intact while writing the new v2 archive format.
async function backupBuild(root, mcVersion, loader, label = 'before-update') {
  return createBuildSnapshot(root, mcVersion, loader, {
    reason: label,
    name: snapshotLabelForReason(label)
  });
}

async function readSnapshotManifest(snapshotPath) {
  let manifest = null;
  await zipStream.iterateZipEntries(snapshotPath, async (entryName, openStream) => {
    if (entryName !== 'manifest.json') return;
    const buffer = await zipStream.readEntryToBuffer(await openStream(), MAX_MANIFEST_BYTES);
    if (buffer.length > MAX_MANIFEST_BYTES) throw new Error('Манифест снимка слишком большой');
    try { manifest = JSON.parse(buffer.toString('utf8')); }
    catch { throw new Error('Не удалось прочитать описание снимка'); }
  });
  if (!manifest || typeof manifest !== 'object') throw new Error('В архиве нет manifest.json');
  return manifest;
}

async function listBuildBackups(root, mcVersion, loader) {
  const backupsDir = getBuildBackupsDir(root, mcVersion, loader);
  if (!fs.existsSync(backupsDir)) return [];

  const files = fs.readdirSync(backupsDir)
    .filter(file => file.toLowerCase().endsWith('.zip'))
    .map(file => {
      const filePath = path.join(backupsDir, file);
      const stat = fs.statSync(filePath);
      return { fileName: file, path: filePath, mtime: stat.mtimeMs, sizeBytes: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const result = [];
  for (const item of files) {
    try {
      const manifest = await readSnapshotManifest(item.path);
      const formatVersion = Number(manifest.formatVersion) || 1;
      const summary = manifest.summary || {
        mods: (manifest.wantedMods || []).length,
        resourcePacks: (manifest.wantedResourcePacks || []).length,
        shaders: (manifest.wantedShaders || []).length,
        configFiles: 0,
        settingsFiles: 0
      };
      result.push({
        ...item,
        name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : item.fileName.replace(/\.zip$/i, ''),
        formatVersion,
        summary,
        summaryText: formatSnapshotSummary(summary),
        createdAt: Number(manifest.createdAt) || item.mtime,
        isRestorable: true
      });
    } catch (err) {
      result.push({
        ...item,
        name: item.fileName.replace(/\.zip$/i, ''),
        formatVersion: 0,
        summary: {},
        summaryText: 'Не удалось прочитать снимок',
        isRestorable: false,
        error: err.message
      });
    }
  }
  return result;
}

async function deleteBuildBackup(root, mcVersion, loader, backupPath) {
  const resolved = getSnapshotPath(root, mcVersion, loader, backupPath);
  fs.unlinkSync(resolved);
  return true;
}

function getEntryKind(rootName) {
  if (SNAPSHOT_DIRS.has(rootName)) return 'directory';
  if (SNAPSHOT_FILES.has(rootName)) return 'file';
  throw new Error(`Недопустимая категория снимка: ${rootName}`);
}

function removePath(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (err) { if (fs.existsSync(target)) throw err; }
}

async function restoreBuildSnapshot(root, mcVersion, loader, backupPath, options = {}) {
  const resolved = getSnapshotPath(root, mcVersion, loader, backupPath);
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  const manifest = await readSnapshotManifest(resolved);
  const formatVersion = Number(manifest.formatVersion) || 1;
  if (formatVersion > 2) throw new Error(`Версия формата снимка ${formatVersion} пока не поддерживается`);

  if (manifest.mcVersion && manifest.mcVersion !== mcVersion) throw new Error('Этот снимок создан для другой версии Minecraft');
  if (manifest.loader && manifest.loader !== loader) throw new Error('Этот снимок создан для другого загрузчика');

  const managedRoots = validateManagedRoots(manifest.managedRoots, formatVersion);
  if (formatVersion >= 2 && SNAPSHOT_ROOTS.some(rootName => !managedRoots.includes(rootName))) {
    throw new Error('Снимок неполный: в нём отсутствуют категории состояния сборки');
  }
  if (formatVersion >= 2 && manifest.format !== 'fcore-build-snapshot') {
    throw new Error('Неизвестный формат снимка сборки');
  }
  if (formatVersion <= 1) {
    // v1 archives only contained mods, resource packs and their wanted lists.
    if (!managedRoots.includes('mods') || !managedRoots.includes('resourcepacks')) {
      throw new Error('Старый снимок имеет некорректный формат');
    }
  }

  // Keep a complete safety snapshot before touching the live instance.
  if (options.createSafetySnapshot !== false) {
    await createBuildSnapshot(root, mcVersion, loader, { name: 'Перед восстановлением снимка' });
  }

  fs.mkdirSync(instanceDir, { recursive: true });
  const tempRoot = path.join(instanceDir, `.snapshot-restore-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const stagedRoot = path.join(tempRoot, 'staged');
  const previousRoot = path.join(tempRoot, 'previous');
  fs.mkdirSync(stagedRoot, { recursive: true });
  fs.mkdirSync(previousRoot, { recursive: true });
  const includedRoots = Array.isArray(manifest.includedRoots) ? manifest.includedRoots : [];
  for (const rootName of includedRoots) {
    if (!managedRoots.includes(rootName) || !SNAPSHOT_DIRS.has(rootName)) continue;
    fs.mkdirSync(path.join(stagedRoot, rootName), { recursive: true });
  }

  const counts = { modsRestored: 0, packsRestored: 0, shadersRestored: 0, configFilesRestored: 0, settingsFilesRestored: 0 };
  const applied = [];
  const originalInstance = JSON.parse(JSON.stringify(getInstance(mcVersion, loader)));
  const originalLaunchSettings = getLaunchSettings(mcVersion, loader);
  let keepRecoveryFiles = false;

  try {
    await zipStream.iterateZipEntries(resolved, async (entryName, openStream) => {
      if (entryName === 'manifest.json') return;
      const destination = resolveSnapshotEntry(stagedRoot, entryName, managedRoots);
      const parts = entryName.split('/');
      const rootName = parts[0];
      const rootKind = getEntryKind(rootName);
      if ((parts.length === 1 && rootKind === 'directory') || (parts.length !== 1 && rootKind === 'file')) {
        throw new Error(`Снимок содержит некорректный путь для категории: ${rootName}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await zipStream.extractEntryToFile(await openStream(), destination);

      if (rootName === 'mods') counts.modsRestored++;
      else if (rootName === 'resourcepacks') counts.packsRestored++;
      else if (rootName === 'shaderpacks') counts.shadersRestored++;
      else if (SNAPSHOT_FILES.has(rootName)) counts.settingsFilesRestored++;
      else counts.configFilesRestored++;
    });

    // Replace each managed root only after the full archive has been staged.
    // If any rename fails, restore all roots already moved into the safety area.
    for (const rootName of managedRoots) {
      const livePath = path.join(instanceDir, rootName);
      const stagedPath = path.join(stagedRoot, rootName);
      const previousPath = path.join(previousRoot, rootName);
      const hadPrevious = fs.existsSync(livePath);
      if (hadPrevious) fs.renameSync(livePath, previousPath);
      const record = { rootName, livePath, stagedPath, previousPath, hadPrevious, placedNew: false };
      applied.push(record);
      if (fs.existsSync(stagedPath)) {
        fs.renameSync(stagedPath, livePath);
        record.placedNew = true;
      }
    }

    if (Array.isArray(manifest.wantedMods)) setWantedMods(mcVersion, loader, manifest.wantedMods);
    if (Array.isArray(manifest.wantedResourcePacks)) setWantedResourcePacks(mcVersion, loader, manifest.wantedResourcePacks);
    if (Array.isArray(manifest.wantedShaders)) setWantedShaders(mcVersion, loader, manifest.wantedShaders);
    if (manifest.launchSettings && formatVersion >= 2) setLaunchSettings(mcVersion, loader, { ...manifest.launchSettings, javaPath: '' });
  } catch (err) {
    for (const record of applied.reverse()) {
      try {
        if (record.placedNew) removePath(record.livePath);
        if (record.hadPrevious && fs.existsSync(record.previousPath)) fs.renameSync(record.previousPath, record.livePath);
      } catch (restoreErr) {
        keepRecoveryFiles = true;
        console.error(`[buildSnapshot] не удалось вернуть ${record.rootName}:`, restoreErr.message);
      }
    }
    // Roll back launcher-side build metadata too if one of the store writes failed.
    try { setWantedMods(mcVersion, loader, originalInstance.wantedMods || []); } catch (restoreErr) { console.error('[buildSnapshot] store rollback (mods):', restoreErr.message); }
    try { setWantedResourcePacks(mcVersion, loader, originalInstance.wantedResourcePacks || []); } catch (restoreErr) { console.error('[buildSnapshot] store rollback (resource packs):', restoreErr.message); }
    try { setWantedShaders(mcVersion, loader, originalInstance.wantedShaders || []); } catch (restoreErr) { console.error('[buildSnapshot] store rollback (shaders):', restoreErr.message); }
    try { setLaunchSettings(mcVersion, loader, originalLaunchSettings); } catch (restoreErr) { console.error('[buildSnapshot] store rollback (launch settings):', restoreErr.message); }
    if (keepRecoveryFiles) {
      err.message += `\nВременная папка с резервными файлами сохранена: ${tempRoot}`;
    }
    throw err;
  } finally {
    if (!keepRecoveryFiles) {
      try { removePath(tempRoot); }
      catch (cleanupErr) { console.warn('[buildSnapshot] не удалось очистить временную папку:', cleanupErr.message); }
    }
  }

  return {
    ...counts,
    totalFilesRestored: Object.values(counts).reduce((sum, count) => sum + count, 0),
    formatVersion,
    name: manifest.name || path.basename(resolved)
  };
}

// Compatibility alias for older main-process call sites.
async function rollbackBuild(root, mcVersion, loader, backupPath) {
  return restoreBuildSnapshot(root, mcVersion, loader, backupPath);
}

module.exports = {
  MAX_BUILD_SNAPSHOTS,
  getBuildBackupsDir,
  createBuildSnapshot,
  backupBuild,
  listBuildBackups,
  deleteBuildBackup,
  readSnapshotManifest,
  restoreBuildSnapshot,
  rollbackBuild
};
