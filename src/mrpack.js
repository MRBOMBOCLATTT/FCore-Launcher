const fs = require('fs');
const path = require('path');
const modrinth = require('./modrinth');
const modManager = require('./modManager');
const { getInstance, setWantedMods, getFabricLoaderVersion, getNeoforgeVersion } = require('./store');
const { downloadFileWithRetry } = require('./downloader');
const { getDownloadContext } = require('./downloadTaskContext');
const zipStream = require('./zipStream');

// .mrpack — открытый формат Modrinth (его же понимают Prism, MultiMC и сам
// сайт Modrinth), в отличие от нашего собственного zip-формата в exportInstance.js.
// Экспорт собирает список файлов по уже выбранным модам инстанса — для
// закреплённых версий берём последнюю совместимую, т.к. .mrpack не хранит id
// пиновки, только ссылку на конкретный файл.
async function exportMrpack(root, mcVersion, loader) {
  const inst = getInstance(mcVersion, loader);
  const files = [];
  let skipped = 0;

  for (const mod of inst.wantedMods) {
    const version = await modrinth.getCompatibleVersion(mod.projectId, mcVersion, loader);
    if (!version) { skipped++; continue; }

    files.push({
      path: `mods/${version.fileName}`,
      hashes: { sha1: version.sha1 || '' },
      downloads: [version.url],
      fileSize: 0,
      env: { client: 'required', server: 'required' }
    });
  }

  const dependencies = { minecraft: mcVersion };
  if (loader === 'fabric') dependencies['fabric-loader'] = getFabricLoaderVersion(mcVersion, loader) || 'recommended';
  else if (loader === 'forge') dependencies['forge'] = 'recommended'; // точную версию форджа лаунчер не хранит
  else if (loader === 'neoforge') dependencies['neoforge'] = getNeoforgeVersion(mcVersion, loader) || 'recommended';

  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0.0',
    name: `${mcVersion}-${loader}`,
    files,
    dependencies
  };

  const zip = zipStream.createZip();
  zipStream.addBuffer(zip, Buffer.from(JSON.stringify(index, null, 2)), 'modrinth.index.json');

  const exportsDir = path.join(root, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const mrpackPath = path.join(exportsDir, `${mcVersion}-${loader}.mrpack`);
  await zipStream.finalizeZip(zip, mrpackPath);

  return { mrpackPath, modsIncluded: files.length, modsSkipped: skipped };
}

// достаём только modrinth.index.json, не трогая остальные записи архива —
// нужно первым проходом, чтобы узнать пути инстанса до скачивания файлов
async function readMrpackIndex(mrpackPath) {
  let index = null;
  await zipStream.iterateZipEntries(mrpackPath, async (entryName, openStream) => {
    if (entryName !== 'modrinth.index.json') return;
    const buffer = await zipStream.readEntryToBuffer(await openStream());
    index = JSON.parse(buffer.toString('utf8'));
  });
  if (!index) throw new Error('В архиве нет modrinth.index.json — это не .mrpack');
  return index;
}

// Импортирует .mrpack в уже выбранный на вкладке "Играть" инстанс (mcVersion/loader).
// Если версия Minecraft в манифесте не совпадает с выбранной — не блокируем,
// просто предупреждаем в результате, как и остальные операции с модами в лаунчере.
async function importMrpack(root, mcVersion, loader, mrpackPath) {
  const taskContext = getDownloadContext();
  const throwIfCancelled = () => {
    if (!taskContext?.signal?.aborted) return;
    const error = new Error('Загрузка отменена');
    error.code = 'DOWNLOAD_CANCELLED';
    throw error;
  };
  throwIfCancelled();
  const index = await readMrpackIndex(mrpackPath);
  throwIfCancelled();
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  fs.mkdirSync(instanceDir, { recursive: true });

  let filesDownloaded = 0;
  let filesFailed = 0;
  let overridesCopied = 0;
  const files = index.files || [];
  let processedFiles = 0;
  taskContext?.reportTaskProgress?.({
    stage: 'downloading',
    totalFiles: files.length,
    completedFiles: 0,
    queuedFiles: files.map(file => path.basename(file.path))
  });

  for (let indexInQueue = 0; indexInQueue < files.length; indexInQueue++) {
    throwIfCancelled();
    const file = files[indexInQueue];
    const fileName = path.basename(file.path);
    taskContext?.reportTaskProgress?.({
      stage: 'downloading',
      totalFiles: files.length,
      completedFiles: processedFiles,
      currentFile: fileName,
      queuedFiles: files.slice(indexInQueue + 1).map(item => path.basename(item.path))
    });
    const url = file.downloads && file.downloads[0];
    if (!url) {
      filesFailed++;
      processedFiles++;
      taskContext?.reportTaskProgress?.({ completedFiles: processedFiles, queuedFiles: files.slice(indexInQueue + 1).map(item => path.basename(item.path)) });
      continue;
    }

    const dest = path.join(instanceDir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await downloadFileWithRetry(url, dest);
      filesDownloaded++;
    } catch (err) {
      if (err?.code === 'DOWNLOAD_CANCELLED' || err?.name === 'AbortError') throw err;
      filesFailed++;
    }
    processedFiles++;
    taskContext?.reportTaskProgress?.({ completedFiles: processedFiles, queuedFiles: files.slice(indexInQueue + 1).map(item => path.basename(item.path)) });
  }

  // overrides/ — конфиги и прочие файлы, которые просто копируются как есть
  throwIfCancelled();
  await zipStream.iterateZipEntries(mrpackPath, async (entryName, openStream) => {
    throwIfCancelled();
    if (!entryName.startsWith('overrides/')) return;
    const dest = path.join(instanceDir, entryName.slice('overrides/'.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await zipStream.extractEntryToFile(await openStream(), dest);
    overridesCopied++;
  });

  // опознаём скачанные моды по хэшу на Modrinth, чтобы лаунчер потом сам
  // следил за их обновлениями — так же, как identifyLocal.js для вручную закинутых
  const wantedMods = [];
  for (const file of (index.files || [])) {
    throwIfCancelled();
    if (!file.path.startsWith('mods/') || !file.hashes || !file.hashes.sha1) continue;
    try {
      const identified = await modrinth.identifyByHash(file.hashes.sha1);
      if (identified) {
        wantedMods.push({ projectId: identified.projectId, title: identified.projectId, icon: null });
      }
    } catch {
      // не опозналось — мод всё равно на диске, просто лаунчер не будет его апдейтить
    }
  }
  if (wantedMods.length) setWantedMods(mcVersion, loader, wantedMods);

  return {
    mcVersionInPack: index.dependencies ? index.dependencies.minecraft : null,
    mcVersionMismatch: !!(index.dependencies && index.dependencies.minecraft && index.dependencies.minecraft !== mcVersion),
    filesDownloaded,
    filesFailed,
    overridesCopied,
    modsIdentified: wantedMods.length
  };
}

module.exports = { exportMrpack, importMrpack, readMrpackIndex };
