const fs = require('fs');
const path = require('path');
const modManager = require('./modManager');
const resourcePackManager = require('./resourcePackManager');
const { setWantedMods, setWantedResourcePacks } = require('./store');
const { downloadFileWithRetry } = require('./downloader');
const zipStream = require('./zipStream');

// Разворачивает zip сборки (свой экспорт или чужой): читает manifest.json,
// если он есть, восстанавливает список модов/ресурспаков, и копирует
// уже готовые jar/zip файлы на диск — так друг сразу может играть,
// без похода на Modrinth.
// Читает архив потоково (zipStream/yauzl) — большие jar/zip пишутся на диск
// кусками, а не разворачиваются в памяти целиком, как раньше с adm-zip
async function importInstanceFromZip(root, mcVersion, loader, zipPath) {
  const modsDir = modManager.getModsDir(root, mcVersion, loader);
  const rpDir = resourcePackManager.getResourcePacksDir(root, mcVersion, loader);
  fs.mkdirSync(modsDir, { recursive: true });
  fs.mkdirSync(rpDir, { recursive: true });

  let wantedMods = null;
  let wantedResourcePacks = null;
  let modsCopied = 0;
  let resourcePacksCopied = 0;

  await zipStream.iterateZipEntries(zipPath, async (entryName, openStream) => {
    if (entryName === 'manifest.json') {
      try {
        const buffer = await zipStream.readEntryToBuffer(await openStream());
        const manifest = JSON.parse(buffer.toString('utf8'));
        wantedMods = manifest.wantedMods || null;
        wantedResourcePacks = manifest.wantedResourcePacks || null;
      } catch {
        // битый manifest — просто вытащим файлы без списка
      }
      return;
    }

    if (entryName.startsWith('mods/') && entryName.endsWith('.jar')) {
      const dest = path.join(modsDir, path.basename(entryName));
      await zipStream.extractEntryToFile(await openStream(), dest);
      modsCopied++;
      return;
    }

    if (entryName.startsWith('resourcepacks/') && entryName.endsWith('.zip')) {
      const dest = path.join(rpDir, path.basename(entryName));
      await zipStream.extractEntryToFile(await openStream(), dest);
      resourcePacksCopied++;
    }
  });

  if (wantedMods) setWantedMods(mcVersion, loader, wantedMods);
  if (wantedResourcePacks) setWantedResourcePacks(mcVersion, loader, wantedResourcePacks);

  return {
    modsCopied,
    resourcePacksCopied,
    wantedModsRestored: wantedMods ? wantedMods.length : 0,
    wantedResourcePacksRestored: wantedResourcePacks ? wantedResourcePacks.length : 0
  };
}

// Импорт по прямой ссылке: качаем zip во временную папку, дальше как обычный импорт
async function importInstanceFromUrl(root, mcVersion, loader, url) {
  const tmpDir = path.join(root, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `import-${Date.now()}.zip`);

  await downloadFileWithRetry(url, tmpPath);
  try {
    return await importInstanceFromZip(root, mcVersion, loader, tmpPath);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

module.exports = { importInstanceFromZip, importInstanceFromUrl };
