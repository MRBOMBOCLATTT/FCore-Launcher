const fetch = require('node-fetch');

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MODS_CLASS_ID = 6;

// нумерация загрузчиков в CurseForge API — не совпадает с текстовыми id Modrinth
const LOADER_TYPE = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

// Ключ берём из настроек лаунчера (settings:setCurseforgeApiKey), а не хардкодим
// в коде — иначе ключ уедет в собранный exe и его сможет вытащить кто угодно.
// Ключ бесплатный, получить свой можно на console.curseforge.com
function headers(apiKey) {
  return { 'x-api-key': apiKey, Accept: 'application/json' };
}

function assertApiKey(apiKey) {
  if (!apiKey) throw new Error('Не задан ключ CurseForge API — добавь его в Настройках (бесплатно на console.curseforge.com)');
}

async function searchMods(query, mcVersion, loader, apiKey, limit = 20, offset = 0, sort = 'popularity') {
  assertApiKey(apiKey);

  const sortField = sort === 'downloads' ? 6 : sort === 'newest' ? 11 : 2; // 2 = Popularity
  const params = new URLSearchParams({
    gameId: MINECRAFT_GAME_ID,
    classId: MODS_CLASS_ID,
    searchFilter: query || '',
    gameVersion: mcVersion,
    modLoaderType: LOADER_TYPE[loader] || 0,
    sortField,
    sortOrder: 'desc',
    pageSize: limit,
    index: offset
  });

  const res = await fetch(`${API}/mods/search?${params}`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`CurseForge search error: ${res.status}`);
  const data = await res.json();

  return {
    hits: data.data.map(m => ({
      id: String(m.id),
      slug: m.slug,
      title: m.name,
      description: m.summary,
      icon: m.logo ? m.logo.thumbnailUrl : null,
      downloads: m.downloadCount
    })),
    totalHits: data.pagination.totalCount,
    offset: data.pagination.index,
    limit: data.pagination.pageSize
  };
}

function pickHash(file, algo) {
  const entry = (file.hashes || []).find(h => h.algo === algo);
  return entry ? entry.value : null;
}

// Находит файл мода, совместимый с mcVersion + loader — тот же контракт,
// что у modrinth.getCompatibleVersion, чтобы modManager мог их не различать
async function getCompatibleVersion(modId, mcVersion, loader, apiKey) {
  assertApiKey(apiKey);

  const params = new URLSearchParams({
    gameVersion: mcVersion,
    modLoaderType: LOADER_TYPE[loader] || 0,
    pageSize: 1
  });

  const res = await fetch(`${API}/mods/${modId}/files?${params}`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`CurseForge files error: ${res.status}`);
  const data = await res.json();
  if (!data.data.length) return null;

  const file = data.data[0];
  if (!file.downloadUrl) {
    throw new Error('Автор запретил стороннее скачивание этого мода на CurseForge');
  }

  return {
    versionId: String(file.id),
    versionNumber: file.displayName,
    fileName: file.fileName,
    url: file.downloadUrl,
    sha1: pickHash(file, 1),
    dependencies: (file.dependencies || [])
      .filter(d => d.relationType === 3) // 3 = RequiredDependency
      .map(d => String(d.modId))
  };
}

async function getModInfo(modId, apiKey) {
  assertApiKey(apiKey);
  const res = await fetch(`${API}/mods/${modId}`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`CurseForge mod info error: ${res.status}`);
  const data = await res.json();
  return { id: String(data.data.id), title: data.data.name };
}

// то же самое, но пачкой — для импорта модпака, где нужны названия/иконки
// сразу для десятков модов, не дёргать же API по одному разу на каждый
async function getModsBulk(modIds, apiKey) {
  assertApiKey(apiKey);
  if (!modIds.length) return [];

  const res = await fetch(`${API}/mods`, {
    method: 'POST',
    headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ modIds })
  });
  if (!res.ok) throw new Error(`CurseForge bulk mods error: ${res.status}`);
  const data = await res.json();

  return data.data.map(m => ({
    id: String(m.id),
    title: m.name,
    icon: m.logo ? m.logo.thumbnailUrl : null
  }));
}

// массовое разрешение fileId -> ссылка на скачивание, для импорта модпаков —
// один запрос на весь список файлов вместо одного на каждый мод
async function getFilesBulk(fileIds, apiKey) {
  assertApiKey(apiKey);
  if (!fileIds.length) return [];

  const res = await fetch(`${API}/mods/files`, {
    method: 'POST',
    headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds })
  });
  if (!res.ok) throw new Error(`CurseForge bulk files error: ${res.status}`);
  const data = await res.json();

  return data.data.map(file => ({
    modId: String(file.modId),
    fileId: String(file.id),
    fileName: file.fileName,
    url: file.downloadUrl,
    sha1: pickHash(file, 1)
  }));
}

module.exports = { searchMods, getCompatibleVersion, getModInfo, getModsBulk, getFilesBulk, LOADER_TYPE };
