const path = require('path');
const modrinth = require('./modrinth');
const { sha1File } = require('./fileCache');
const { getModsDir } = require('./modManager');
const { getResourcePacksDir } = require('./resourcePackManager');

// Общая логика для модов и ресурспаков: находим "local:*" закреплённые записи
// (это те, что попали в лаунчер через drag-and-drop, а не через поиск по Modrinth),
// считаем хэш файла и спрашиваем Modrinth "а это, случаем, не твой файл?".
// Если совпало — превращаем запись в обычную, привязанную к projectId, и дальше
// она уже участвует в обычных проверках обновлений наравне с остальными.
async function identifyLocalEntries(wantedList, dir) {
  const results = [];
  const updatedList = [...wantedList];

  for (let i = 0; i < updatedList.length; i++) {
    const entry = updatedList[i];
    if (!entry.pinned || !entry.projectId || !entry.projectId.startsWith('local:')) continue;

    const fileName = entry.pinnedFileName;
    const filePath = path.join(dir, fileName);

    let sha1;
    try {
      sha1 = sha1File(filePath);
    } catch (err) {
      results.push({ fileName, matched: false, reason: 'файл не найден на диске' });
      continue;
    }

    let match;
    try {
      match = await modrinth.identifyByHash(sha1);
    } catch (err) {
      results.push({ fileName, matched: false, reason: err.message });
      continue;
    }

    if (!match) {
      results.push({ fileName, matched: false, reason: 'не найден на Modrinth' });
      continue;
    }

    let title = fileName;
    try {
      const info = await modrinth.getProjectInfo(match.projectId);
      title = info.title || fileName;
    } catch {
      // не подтянулось название — не критично, просто оставим имя файла
    }

    updatedList[i] = {
      projectId: match.projectId,
      title,
      icon: entry.icon || null,
      pinned: false,
      pinnedFileName: null,
      lastFileName: fileName
    };

    results.push({ fileName, matched: true, projectId: match.projectId, title });
  }

  return { updatedList, results };
}

async function identifyLocalMods(root, mcVersion, loader, wantedMods) {
  const dir = getModsDir(root, mcVersion, loader);
  return identifyLocalEntries(wantedMods, dir);
}

async function identifyLocalResourcePacks(root, mcVersion, loader, wantedResourcePacks) {
  const dir = getResourcePacksDir(root, mcVersion, loader);
  return identifyLocalEntries(wantedResourcePacks, dir);
}

module.exports = { identifyLocalMods, identifyLocalResourcePacks };
