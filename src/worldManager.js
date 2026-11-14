const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getInstanceDir } = require('./modManager');
const { getBackupsDir } = require('./backupManager');
const nbt = require('./nbt');
const zipStream = require('./zipStream');

function getSavesDir(root, mcVersion, loader) {
  return path.join(getInstanceDir(root, mcVersion, loader), 'saves');
}

const GAME_MODES = ['Выживание', 'Творческий', 'Приключение', 'Наблюдатель'];
const DIFFICULTIES = ['Мирный', 'Лёгкий', 'Нормальный', 'Сложный'];

// Считает суммарный размер папки на диске — на мире с сотнями region-файлов
// это может быть не самая дешёвая операция, но миры обычно единицы штук,
// так что оправданно делать это синхронно при каждом открытии вкладки
function folderSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += folderSize(p);
    else total += stat.size;
  }
  return total;
}

// Читает level.dat и достаёт то немногое, что нужно для карточки мира.
// Возвращает null, если файла нет или он не разобрался (повреждён/нестандартный) —
// в таком случае UI просто покажет мир по имени папки, без деталей
function readLevelDat(worldDir) {
  const levelDatPath = path.join(worldDir, 'level.dat');
  if (!fs.existsSync(levelDatPath)) return null;

  try {
    const raw = zlib.gunzipSync(fs.readFileSync(levelDatPath));
    const root = nbt.parse(raw);
    const dataEntry = nbt.findEntry(root.value, 'Data');
    if (!dataEntry) return null;
    const data = dataEntry.value;

    const get = name => {
      const entry = nbt.findEntry(data, name);
      return entry ? entry.value : undefined;
    };

    const levelName = get('LevelName');
    const lastPlayed = get('LastPlayed'); // BigInt, мс с эпохи
    const gameType = get('GameType');
    const difficulty = get('Difficulty');
    const hardcore = get('hardcore');
    const versionEntry = nbt.findEntry(data, 'Version');
    const versionName = versionEntry ? (nbt.findEntry(versionEntry.value, 'Name') || {}).value : undefined;

    return {
      levelName: typeof levelName === 'string' ? levelName : null,
      lastPlayed: typeof lastPlayed === 'bigint' ? Number(lastPlayed) : null,
      gameMode: typeof gameType === 'number' ? (GAME_MODES[gameType] || null) : null,
      difficulty: typeof difficulty === 'number' ? (DIFFICULTIES[difficulty] || null) : null,
      hardcore: hardcore === 1,
      versionName: typeof versionName === 'string' ? versionName : null
    };
  } catch (err) {
    console.error('[worldManager] не смог разобрать level.dat:', worldDir, err.message);
    return null;
  }
}

function listWorlds(root, mcVersion, loader) {
  const savesDir = getSavesDir(root, mcVersion, loader);
  if (!fs.existsSync(savesDir)) return [];

  const worlds = [];
  for (const folderName of fs.readdirSync(savesDir)) {
    const worldDir = path.join(savesDir, folderName);
    if (!fs.statSync(worldDir).isDirectory()) continue;
    if (!fs.existsSync(path.join(worldDir, 'level.dat'))) continue; // не мир — мусорная папка

    const stat = fs.statSync(worldDir);
    const levelInfo = readLevelDat(worldDir);
    const iconPath = path.join(worldDir, 'icon.png');

    let sizeBytes = 0;
    try { sizeBytes = folderSize(worldDir); } catch { /* права доступа и т.п. — не критично */ }

    worlds.push({
      folderName,
      displayName: (levelInfo && levelInfo.levelName) || folderName,
      iconPath: fs.existsSync(iconPath) ? iconPath : null,
      sizeBytes,
      lastPlayed: (levelInfo && levelInfo.lastPlayed) || stat.mtimeMs,
      gameMode: levelInfo ? levelInfo.gameMode : null,
      difficulty: levelInfo ? levelInfo.difficulty : null,
      hardcore: levelInfo ? levelInfo.hardcore : false,
      versionName: levelInfo ? levelInfo.versionName : null,
      readable: !!levelInfo
    });
  }

  return worlds.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

function assertSafeFolderName(name) {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error('Некорректное имя папки мира');
  }
}

// Переименовывает мир — правит LevelName внутри level.dat, а не имя папки:
// именно это поле Minecraft показывает в списке миров, папку трогать не нужно
// (и безопаснее — не рискуем поймать конфликт путей или файл, занятый игрой)
function renameWorld(root, mcVersion, loader, folderName, newName) {
  assertSafeFolderName(folderName);
  const trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('Название мира не может быть пустым');

  const worldDir = path.join(getSavesDir(root, mcVersion, loader), folderName);
  const levelDatPath = path.join(worldDir, 'level.dat');
  if (!fs.existsSync(levelDatPath)) throw new Error('level.dat не найден — это точно папка мира?');

  const raw = zlib.gunzipSync(fs.readFileSync(levelDatPath));
  const root_ = nbt.parse(raw);
  const dataEntry = nbt.findEntry(root_.value, 'Data');
  if (!dataEntry) throw new Error('Не удалось разобрать level.dat этого мира');

  const levelNameEntry = nbt.findEntry(dataEntry.value, 'LevelName');
  if (!levelNameEntry) throw new Error('В level.dat нет поля LevelName');
  levelNameEntry.value = trimmed;

  const serialized = nbt.serialize(root_);
  const gzipped = zlib.gzipSync(serialized);

  // на всякий случай не затираем оригинал напрямую — пишем во временный файл и меняем местами
  const tmpPath = `${levelDatPath}.tmp`;
  fs.writeFileSync(tmpPath, gzipped);
  fs.renameSync(tmpPath, levelDatPath);

  return trimmed;
}

// Перед необратимым удалением подстраховываемся отдельным zip-архивом именно
// этого мира в ту же папку backups, где лежат общие бэкапы saves — так его
// легко найти и вернуть через "Папка бэкапов", если удалили не то
async function deleteWorld(root, mcVersion, loader, folderName) {
  assertSafeFolderName(folderName);
  const worldDir = path.join(getSavesDir(root, mcVersion, loader), folderName);
  if (!fs.existsSync(worldDir)) throw new Error('Мир уже удалён');

  const backupsDir = getBackupsDir(root, mcVersion, loader);
  fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = path.join(backupsDir, `world-${folderName}-deleted-${timestamp}.zip`);

  const zip = zipStream.createZip();
  zipStream.addFolder(zip, worldDir, folderName);
  await zipStream.finalizeZip(zip, zipPath);

  fs.rmSync(worldDir, { recursive: true, force: true });
  return zipPath;
}

module.exports = { getSavesDir, listWorlds, renameWorld, deleteWorld };
