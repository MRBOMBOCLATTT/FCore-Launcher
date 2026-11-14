const fs = require('fs');
const path = require('path');
const curseforge = require('./curseforge');
const modManager = require('./modManager');
const { getInstance, setWantedMods, getCurseforgeApiKey } = require('./store');
const { downloadFileWithRetry } = require('./downloader');
const { getDownloadContext } = require('./downloadTaskContext');
const zipStream = require('./zipStream');

// "forge-47.2.0" -> "forge", "neoforge-21.1.72" -> "neoforge" — CF пишет версию
// загрузчика прямо в id, а нам нужно только его имя
function loaderFromManifestId(id) {
  const name = (id || '').split('-')[0].toLowerCase();
  if (name === 'forge' || name === 'fabric' || name === 'neoforge') return name;
  return null; // quilt лаунчер пока не умеет запускать
}

async function readManifest(zipPath) {
  let manifest = null;
  await zipStream.iterateZipEntries(zipPath, async (entryName, openStream) => {
    if (entryName !== 'manifest.json') return;
    const buffer = await zipStream.readEntryToBuffer(await openStream());
    manifest = JSON.parse(buffer.toString('utf8'));
  });
  if (!manifest) throw new Error('В архиве нет manifest.json — это не модпак CurseForge');
  if (manifest.manifestType !== 'minecraftModpack') throw new Error('manifest.json не похож на модпак CurseForge (неверный manifestType)');
  return manifest;
}

// Импортирует .zip-модпак CurseForge в уже выбранный на вкладке "Играть"
// инстанс (mcVersion/loader) — так же, как импорт .mrpack. Требует ключ
// CurseForge API в настройках, без него узнать ссылки на скачивание нельзя.
async function importCurseforgeModpack(root, mcVersion, loader, zipPath) {
  const taskContext = getDownloadContext();
  const throwIfCancelled = () => {
    if (!taskContext?.signal?.aborted) return;
    const error = new Error('Загрузка отменена');
    error.code = 'DOWNLOAD_CANCELLED';
    throw error;
  };
  throwIfCancelled();
  const apiKey = getCurseforgeApiKey();
  if (!apiKey) throw new Error('Не задан ключ CurseForge API — добавь его в Настройках (бесплатно на console.curseforge.com)');

  const manifest = await readManifest(zipPath);
  throwIfCancelled();
  const primaryLoader = (manifest.minecraft.modLoaders || []).find(m => m.primary) || manifest.minecraft.modLoaders[0];
  const manifestLoader = primaryLoader ? loaderFromManifestId(primaryLoader.id) : null;

  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  fs.mkdirSync(instanceDir, { recursive: true });

  const fileEntries = (manifest.files || []).filter(f => f.projectID && f.fileID);
  const resolved = await curseforge.getFilesBulk(fileEntries.map(f => f.fileID), apiKey);
  throwIfCancelled();
  const modInfos = await curseforge.getModsBulk([...new Set(fileEntries.map(f => f.projectID))], apiKey);
  throwIfCancelled();
  const titleById = new Map(modInfos.map(m => [m.id, m]));

  let filesDownloaded = 0;
  let filesFailed = 0;
  let processedFiles = 0;
  taskContext?.reportTaskProgress?.({
    stage: 'downloading',
    totalFiles: resolved.length,
    completedFiles: 0,
    queuedFiles: resolved.map(file => file.fileName)
  });

  for (let indexInQueue = 0; indexInQueue < resolved.length; indexInQueue++) {
    throwIfCancelled();
    const file = resolved[indexInQueue];
    taskContext?.reportTaskProgress?.({
      stage: 'downloading',
      totalFiles: resolved.length,
      completedFiles: processedFiles,
      currentFile: file.fileName,
      queuedFiles: resolved.slice(indexInQueue + 1).map(item => item.fileName)
    });
    if (!file.url) {
      filesFailed++;
      processedFiles++;
      taskContext?.reportTaskProgress?.({ completedFiles: processedFiles, queuedFiles: resolved.slice(indexInQueue + 1).map(item => item.fileName) });
      continue;
    }
    const dest = path.join(instanceDir, 'mods', file.fileName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await downloadFileWithRetry(file.url, dest);
      filesDownloaded++;
    } catch (err) {
      if (err?.code === 'DOWNLOAD_CANCELLED' || err?.name === 'AbortError') throw err;
      filesFailed++;
    }
    processedFiles++;
    taskContext?.reportTaskProgress?.({ completedFiles: processedFiles, queuedFiles: resolved.slice(indexInQueue + 1).map(item => item.fileName) });
  }

  // overrides/ (обычно так и называется, но манифест иногда указывает своё имя)
  // — конфиги и прочие файлы, которые просто копируются как есть
  const overridesFolder = `${manifest.overrides || 'overrides'}/`;
  let overridesCopied = 0;
  await zipStream.iterateZipEntries(zipPath, async (entryName, openStream) => {
    throwIfCancelled();
    if (!entryName.startsWith(overridesFolder)) return;
    const dest = path.join(instanceDir, entryName.slice(overridesFolder.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await zipStream.extractEntryToFile(await openStream(), dest);
    overridesCopied++;
  });

  // моды знаем по id напрямую (это же CurseForge-модпак), поэтому в отличие
  // от .mrpack не нужно опознавать файлы по хэшу — сразу пишем их как источник curseforge,
  // и дальше "Переустановить"/проверка обновлений будут работать как для обычных CF-модов
  const resolvedByModId = new Map(resolved.map(f => [f.modId, f]));
  const inst = getInstance(mcVersion, loader);
  const existingIds = new Set(inst.wantedMods.map(m => m.projectId));
  const newWantedMods = [];

  for (const file of fileEntries) {
    const modId = String(file.projectID);
    if (existingIds.has(modId) || !resolvedByModId.has(modId)) continue;
    const info = titleById.get(modId);
    newWantedMods.push({ projectId: modId, title: info ? info.title : modId, icon: info ? info.icon : null, source: 'curseforge' });
  }

  if (newWantedMods.length) setWantedMods(mcVersion, loader, [...inst.wantedMods, ...newWantedMods]);

  return {
    mcVersionInPack: manifest.minecraft.version,
    mcVersionMismatch: manifest.minecraft.version !== mcVersion,
    loaderInPack: manifestLoader,
    loaderMismatch: manifestLoader !== null && manifestLoader !== loader,
    filesDownloaded,
    filesFailed,
    overridesCopied,
    modsAdded: newWantedMods.length
  };
}

module.exports = { importCurseforgeModpack };
