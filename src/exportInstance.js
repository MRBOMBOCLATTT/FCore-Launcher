const fs = require('fs');
const path = require('path');
const modManager = require('./modManager');
const resourcePackManager = require('./resourcePackManager');
const { getInstance } = require('./store');
const zipStream = require('./zipStream');

// Складывает mods/ и resourcepacks/ инстанса в один zip и кладёт рядом с игрой,
// в exports/. Плюс manifest.json со списком wantedMods/wantedResourcePacks —
// чтобы при импорте у друга сразу восстановился список, а не только файлы.
// Пишет потоково (zipStream/yazl) — файлы не грузятся в память целиком.
// Возвращает путь к готовому файлу
async function exportInstance(root, mcVersion, loader) {
  const modsDir = modManager.getModsDir(root, mcVersion, loader);
  const rpDir = resourcePackManager.getResourcePacksDir(root, mcVersion, loader);
  const inst = getInstance(mcVersion, loader);

  const zip = zipStream.createZip();

  if (fs.existsSync(modsDir)) {
    for (const file of fs.readdirSync(modsDir)) {
      if (file.endsWith('.jar')) zipStream.addFile(zip, path.join(modsDir, file), `mods/${file}`);
    }
  }

  if (fs.existsSync(rpDir)) {
    for (const file of fs.readdirSync(rpDir)) {
      if (file.endsWith('.zip')) zipStream.addFile(zip, path.join(rpDir, file), `resourcepacks/${file}`);
    }
  }

  const manifest = {
    mcVersion,
    loader,
    wantedMods: inst.wantedMods,
    wantedResourcePacks: inst.wantedResourcePacks
  };
  zipStream.addBuffer(zip, Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');

  const exportsDir = path.join(root, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const zipPath = path.join(exportsDir, `${mcVersion}-${loader}-mods.zip`);
  await zipStream.finalizeZip(zip, zipPath);

  return zipPath;
}

module.exports = { exportInstance };
