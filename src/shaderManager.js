const fs = require('fs');
const path = require('path');
const modrinth = require('./modrinth');
const modManager = require('./modManager');
const { isAlreadyDownloaded } = require('./fileCache');
const { downloadFileWithRetry, runWithConcurrency, ensureFreeSpace } = require('./downloader');

function getShadersDir(root, mcVersion, loader) {
  return path.join(modManager.getInstanceDir(root, mcVersion, loader), 'shaderpacks');
}

function listInstalledShaders(root, mcVersion, loader) {
  const dir = getShadersDir(root, mcVersion, loader);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip') || f.endsWith('.zip.disabled'))
    .map(f => ({
      fileName: f.replace(/\.disabled$/, ''),
      enabled: !f.endsWith('.disabled')
    }));
}

function setShaderEnabled(root, mcVersion, loader, fileName, enabled) {
  const dir = getShadersDir(root, mcVersion, loader);
  const enabledPath = path.join(dir, fileName);
  const disabledPath = `${enabledPath}.disabled`;

  if (enabled && fs.existsSync(disabledPath)) fs.renameSync(disabledPath, enabledPath);
  else if (!enabled && fs.existsSync(enabledPath)) fs.renameSync(enabledPath, disabledPath);

  return listInstalledShaders(root, mcVersion, loader);
}

function setAllShadersEnabled(root, mcVersion, loader, enabled) {
  for (const pack of listInstalledShaders(root, mcVersion, loader)) {
    setShaderEnabled(root, mcVersion, loader, pack.fileName, enabled);
  }
  return listInstalledShaders(root, mcVersion, loader);
}

async function reinstallShaders(root, mcVersion, loader, wanted, onProgress = () => {}, dryRun = false) {
  const dir = getShadersDir(root, mcVersion, loader);
  fs.mkdirSync(dir, { recursive: true });

  const wantedFiles = [];
  const failed = [];

  const pinned = wanted.filter(p => p.pinned && p.pinnedFileName);
  wanted = wanted.filter(p => !p.pinned);

  const lastKnownFileName = new Map(
    wanted.filter(p => p.lastFileName).map(p => [p.projectId, p.lastFileName])
  );

  await runWithConcurrency(wanted, async pack => {
    onProgress({ stage: 'checking', projectId: pack.projectId, title: pack.title });

    let version;
    try {
      version = await modrinth.getCompatibleShaderVersion(pack.projectId, mcVersion);
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

  if (dryRun) {
    const willSkip = wantedFiles.filter(f => isAlreadyDownloaded(path.join(dir, f.fileName), f.sha1));
    const willDownload = wantedFiles.filter(f => !willSkip.includes(f));
    return { installed: willDownload, skipped: willSkip, failed, dryRun: true };
  }

  const wantedFileNames = new Set(wantedFiles.map(f => f.fileName));
  for (const p of pinned) wantedFileNames.add(p.pinnedFileName);
  for (const f of failed) {
    const known = lastKnownFileName.get(f.projectId);
    if (known) wantedFileNames.add(known);
  }

  for (const file of fs.readdirSync(dir)) {
    const baseName = file.replace(/\.disabled$/, '');
    if ((file.endsWith('.zip') || file.endsWith('.zip.disabled')) && !wantedFileNames.has(baseName)) {
      fs.unlinkSync(path.join(dir, file));
    }
  }

  const installed = [];
  const skipped = [];
  const toDownload = [];

  for (const file of wantedFiles) {
    const dest = path.join(dir, file.fileName);
    const disabledDest = `${dest}.disabled`;

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
    await ensureFreeSpace(dir, 150 * 1024 * 1024, 'шейдеров');
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

  return { installed, skipped, failed };
}

module.exports = {
  getShadersDir,
  reinstallShaders,
  listInstalledShaders,
  setShaderEnabled,
  setAllShadersEnabled
};
