const fs = require('fs');
const path = require('path');
const { getInstanceDir } = require('./modManager');
const zipStream = require('./zipStream');

function getBackupsDir(root, mcVersion, loader) {
  return path.join(getInstanceDir(root, mcVersion, loader), 'backups');
}

function getSavesDir(root, mcVersion, loader) {
  return path.join(getInstanceDir(root, mcVersion, loader), 'saves');
}

// Бэкапит папку с мирами (saves) в zip перед потенциально рискованной операцией
// (переустановка модов может утащить за собой мир, если несовместимый мод его повредит).
// Если миров ещё нет — просто ничего не делает, возвращает null.
// Пишет потоково (zipStream/yazl) — на больших мирах (сотни МБ regions) не
// раздувает память так, как это делал adm-zip, читавший всё разом
async function backupSaves(root, mcVersion, loader, label = 'auto') {
  const savesDir = getSavesDir(root, mcVersion, loader);
  if (!fs.existsSync(savesDir) || !fs.readdirSync(savesDir).length) return null;

  const backupsDir = getBackupsDir(root, mcVersion, loader);
  fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = path.join(backupsDir, `saves-${label}-${timestamp}.zip`);

  const zip = zipStream.createZip();
  zipStream.addFolder(zip, savesDir, 'saves');
  await zipStream.finalizeZip(zip, zipPath);

  // не даём бэкапам копиться бесконечно, пока лаунчер открыт месяцами — оставляем последние 10
  const backups = fs.readdirSync(backupsDir).filter(f => f.endsWith('.zip')).sort();
  while (backups.length > 10) {
    fs.unlinkSync(path.join(backupsDir, backups.shift()));
  }

  return zipPath;
}

function listBackups(root, mcVersion, loader) {
  const backupsDir = getBackupsDir(root, mcVersion, loader);
  if (!fs.existsSync(backupsDir)) return [];

  return fs.readdirSync(backupsDir)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const filePath = path.join(backupsDir, f);
      const stat = fs.statSync(filePath);
      return { fileName: f, path: filePath, mtime: stat.mtime, sizeBytes: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = { backupSaves, listBackups, getBackupsDir };
