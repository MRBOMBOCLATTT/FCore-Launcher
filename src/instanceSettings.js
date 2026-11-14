const fs = require('fs');
const path = require('path');
const { getInstanceDir } = require('./modManager');

// Что считаем "настройками", а не игровым контентом — эти файлы/папки
// копируем между версиями по кнопке "Скопировать настройки". Миры, моды
// и ресурспаки сюда намеренно не входят, у них своя логика переноса.
const SETTINGS_ENTRIES = ['options.txt', 'optionsof.txt', 'servers.dat', 'config'];

// Папка вида instances/1.20.1-fabric — распарсиваем обратно в mcVersion/loader.
// Loader у нас всегда одно слово без дефиса (fabric/forge/vanilla), поэтому
// делим по последнему дефису, а не по первому — так mcVersion с дефисами
// (снапшоты типа 24w14-a, если вдруг) тоже разберутся верно.
function parseInstanceFolder(folderName) {
  if (folderName.startsWith('build-')) return null; // папки сборок не парсятся как версия-загрузчик
  const idx = folderName.lastIndexOf('-');
  if (idx === -1) return null;
  return { mcVersion: folderName.slice(0, idx), loader: folderName.slice(idx + 1) };
}

// Список всех существующих инстансов на диске, кроме текущего (чтобы не предлагать копировать самого в себя)
function listOtherInstances(root, excludeMcVersion, excludeLoader) {
  const instancesDir = path.join(root, 'instances');
  if (!fs.existsSync(instancesDir)) return [];

  let buildFolders = new Set();
  try {
    buildFolders = new Set(require('./store').listBuilds().flatMap(b => [b.folder, `build-${b.id}`].filter(Boolean).map(n => n.toLowerCase())));
  } catch {
    buildFolders = new Set();
  }

  return fs.readdirSync(instancesDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !buildFolders.has(e.name.toLowerCase()))
    .map(e => parseInstanceFolder(e.name))
    .filter(Boolean)
    .filter(inst => !(inst.mcVersion === excludeMcVersion && inst.loader === excludeLoader));
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Копирует options.txt/servers.dat/config и т.п. из одной версии-инстанса в другую.
// Возвращает список того, что реально скопировалось (в источнике могло чего-то не быть).
function copySettings(root, from, to) {
  const fromDir = getInstanceDir(root, from.mcVersion, from.loader);
  const toDir = getInstanceDir(root, to.mcVersion, to.loader);
  fs.mkdirSync(toDir, { recursive: true });

  const copied = [];
  for (const entry of SETTINGS_ENTRIES) {
    const src = path.join(fromDir, entry);
    if (!fs.existsSync(src)) continue;
    copyRecursive(src, path.join(toDir, entry));
    copied.push(entry);
  }
  return copied;
}

module.exports = { listOtherInstances, copySettings };
