const fs = require('fs');
const path = require('path');
const modrinth = require('./modrinth');
const modManager = require('./modManager');
const { isAlreadyDownloaded } = require('./fileCache');
const { downloadFileWithRetry, runWithConcurrency, ensureFreeSpace } = require('./downloader');

function getResourcePacksDir(root, mcVersion, loader) {
  return path.join(modManager.getInstanceDir(root, mcVersion, loader), 'resourcepacks');
}

// файлы ресурспаков, которые сейчас лежат на диске — включая выключенные (.disabled),
// так же, как listInstalledMods в modManager
function listInstalledResourcePacks(root, mcVersion, loader) {
  const dir = getResourcePacksDir(root, mcVersion, loader);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip') || f.endsWith('.zip.disabled'))
    .map(f => ({
      fileName: f.replace(/\.disabled$/, ''),
      enabled: !f.endsWith('.disabled')
    }));
}

function setResourcePackEnabled(root, mcVersion, loader, fileName, enabled) {
  const dir = getResourcePacksDir(root, mcVersion, loader);
  const enabledPath = path.join(dir, fileName);
  const disabledPath = `${enabledPath}.disabled`;

  if (enabled && fs.existsSync(disabledPath)) fs.renameSync(disabledPath, enabledPath);
  else if (!enabled && fs.existsSync(enabledPath)) fs.renameSync(enabledPath, disabledPath);

  return listInstalledResourcePacks(root, mcVersion, loader);
}

function setAllResourcePacksEnabled(root, mcVersion, loader, enabled) {
  for (const pack of listInstalledResourcePacks(root, mcVersion, loader)) {
    setResourcePackEnabled(root, mcVersion, loader, pack.fileName, enabled);
  }
  return listInstalledResourcePacks(root, mcVersion, loader);
}

// dryRun: true — только проверить, ничего не менять на диске
// targetProjectId: если задан — по сети проверяем только этот пак, остальные из
// wanted просто защищаем от удаления по последнему известному файлу, без обращений
// к Modrinth. Нужно для точечного обновления одного ресурспака (resourcepacks:updateOne),
// иначе полная чистка папки по неполному списку удаляет все остальные паки
async function reinstallResourcePacks(root, mcVersion, loader, wanted, onProgress = () => {}, dryRun = false, targetProjectId = null) {
  const dir = getResourcePacksDir(root, mcVersion, loader);
  fs.mkdirSync(dir, { recursive: true });

  const wantedFiles = [];
  const failed = [];
  const pinned = wanted.filter(p => p.pinned && p.pinnedFileName);

  const toCheck = targetProjectId
    ? wanted.filter(p => !p.pinned && p.projectId === targetProjectId)
    : wanted.filter(p => !p.pinned);
  const untouched = targetProjectId
    ? wanted.filter(p => !p.pinned && p.projectId !== targetProjectId)
    : [];

  // снимок «последнего известного файла» для каждого ресурспака — если Modrinth
  // не ответит на проверку прямо сейчас, не даём чистке удалить рабочий файл
  const lastKnownFileName = new Map(
    wanted.filter(p => !p.pinned && p.lastFileName).map(p => [p.projectId, p.lastFileName])
  );

  // проверяем версии сразу пачками по 6, а не по одной — на большом списке
  // ресурспаков раньше это было самой долгой частью переустановки
  await runWithConcurrency(toCheck, async pack => {
    onProgress({ stage: 'checking', projectId: pack.projectId, title: pack.title });

    let version;
    try {
      version = await modrinth.getCompatibleResourcePackVersion(pack.projectId, mcVersion);
    } catch (err) {
      failed.push({ projectId: pack.projectId, title: pack.title, reason: err.message });
      return;
    }

    if (!version) {
      failed.push({ projectId: pack.projectId, title: pack.title, reason: `Нет сборки под ${mcVersion}` });
      return;
    }

    wantedFiles.push({ projectId: pack.projectId, title: pack.title, ...version });
  }, 6);

  const pinnedSkipped = pinned.map(p => ({ projectId: p.projectId, title: p.title, fileName: p.pinnedFileName, pinned: true }));

  if (dryRun) {
    const willSkip = wantedFiles.filter(f => isAlreadyDownloaded(path.join(dir, f.fileName), f.sha1));
    const willDownload = wantedFiles.filter(f => !willSkip.includes(f));
    return { installed: willDownload, skipped: [...willSkip, ...pinnedSkipped], failed, dryRun: true };
  }

  const wantedFileNames = new Set(wantedFiles.map(f => f.fileName));
  for (const p of pinned) wantedFileNames.add(p.pinnedFileName);

  // так же, как в modManager: если проверить пак не удалось, не трогаем то, что уже стоит
  for (const f of failed) {
    const known = lastKnownFileName.get(f.projectId);
    if (known) wantedFileNames.add(known);
  }

  // паки, которые в этот раз не проверяли (точечное обновление другого пака) —
  // просто оставляем их файл как есть, не трогаем и не удаляем
  const untouchedSkipped = [];
  for (const p of untouched) {
    if (p.lastFileName) {
      wantedFileNames.add(p.lastFileName);
      untouchedSkipped.push({ projectId: p.projectId, title: p.title, fileName: p.lastFileName });
    }
  }

  for (const file of fs.readdirSync(dir)) {
    const baseName = file.replace(/\.disabled$/, '');
    if ((file.endsWith('.zip') || file.endsWith('.zip.disabled')) && !wantedFileNames.has(baseName)) {
      fs.unlinkSync(path.join(dir, file));
    }
  }

  const installed = [];
  const skipped = [...pinnedSkipped];
  const toDownload = [];

  for (const file of wantedFiles) {
    const dest = path.join(dir, file.fileName);
    const disabledDest = `${dest}.disabled`;

    // пак выключен пользователем (переименован в .disabled) — не трогаем
    if (isAlreadyDownloaded(disabledDest, file.sha1)) {
      skipped.push({ projectId: file.projectId, title: file.title, fileName: file.fileName, disabled: true });
      continue;
    }

    if (isAlreadyDownloaded(dest, file.sha1)) {
      skipped.push({ projectId: file.projectId, title: file.title, fileName: file.fileName });
      continue;
    }

    toDownload.push({ file, dest });
  }

  if (toDownload.length) {
    onProgress({ stage: 'start', total: toDownload.length, queue: toDownload.map(({ file }) => ({ title: file.title, fileName: file.fileName })) });
    await ensureFreeSpace(dir, 150 * 1024 * 1024, 'ресурспаков');
  }

  let doneCount = 0;
  let bytesDone = 0;
  const startedAt = Date.now();

  await runWithConcurrency(toDownload, async ({ file, dest }) => {
    onProgress({ stage: 'downloading', projectId: file.projectId, title: file.title, fileName: file.fileName, done: doneCount, total: toDownload.length });
    const { bytes } = await downloadFileWithRetry(file.url, dest, {
      onRetry: r => onProgress({ stage: 'retry', title: file.title, ...r })
    });
    doneCount++;
    bytesDone += bytes;
    const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const speedBps = bytesDone / elapsedSec;
    const remaining = toDownload.length - doneCount;
    const etaSec = doneCount > 0 ? Math.round((elapsedSec / doneCount) * remaining) : null;
    installed.push({ projectId: file.projectId, title: file.title, fileName: file.fileName });
    onProgress({ stage: 'downloaded', projectId: file.projectId, title: file.title, fileName: file.fileName, done: doneCount, total: toDownload.length, speedBps, etaSec });
  }, 6);

  return { installed, skipped: [...skipped, ...untouchedSkipped], failed };
}

// Ставит конкретную версию ресурспака, выбранную вручную — так же, как
// installVersionFile в modManager, только для папки resourcepacks
async function installVersionFile(root, mcVersion, loader, version, previousFileName = null) {
  const dir = getResourcePacksDir(root, mcVersion, loader);
  fs.mkdirSync(dir, { recursive: true });

  if (previousFileName && previousFileName !== version.fileName) {
    for (const suffix of ['', '.disabled']) {
      const p = path.join(dir, previousFileName + suffix);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  const dest = path.join(dir, version.fileName);
  if (!isAlreadyDownloaded(dest, version.sha1)) {
    await ensureFreeSpace(dir, 150 * 1024 * 1024, 'ресурспаков');
    await downloadFileWithRetry(version.url, dest);
  }

  return { fileName: version.fileName };
}

module.exports = {
  getResourcePacksDir,
  reinstallResourcePacks,
  listInstalledResourcePacks,
  setResourcePackEnabled,
  installVersionFile,
  setAllResourcePacksEnabled
};
