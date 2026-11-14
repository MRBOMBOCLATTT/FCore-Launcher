const fetch = require('node-fetch');

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'awskull/pfc-launcher (contact: github issues)' };

// Простой кэш поисковых запросов на несколько минут — при листании страниц
// туда-обратно не дёргаем Modrinth заново на каждый клик
const SEARCH_CACHE_TTL = 3 * 60 * 1000;
const searchCache = new Map();

async function cachedFetchJson(url, errorLabel = 'Modrinth request error') {
  const cached = searchCache.get(url);
  if (cached && Date.now() - cached.time < SEARCH_CACHE_TTL) {
    return cached.data;
  }

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${errorLabel}: ${res.status}`);
  const data = await res.json();

  searchCache.set(url, { time: Date.now(), data });
  // не даём кэшу расти бесконечно, пока лаунчер открыт часами
  if (searchCache.size > 200) {
    const oldestKey = searchCache.keys().next().value;
    searchCache.delete(oldestKey);
  }

  return data;
}

async function searchMods(query, mcVersion, loader, limit = 20, offset = 0, sort = 'relevance', category = '') {
  const facetGroups = [
    ['project_type:mod'],
    [`versions:${mcVersion}`],
    [`categories:${loader}`]
  ];
  if (category) facetGroups.push([`categories:${category}`]);

  const facets = JSON.stringify(facetGroups);
  const url = `${API}/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(facets)}&limit=${limit}&offset=${offset}&index=${encodeURIComponent(sort)}`;
  const data = await cachedFetchJson(url, 'Modrinth search error');

  return {
    hits: data.hits.map(h => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url,
      downloads: h.downloads
    })),
    totalHits: data.total_hits,
    offset: data.offset,
    limit: data.limit
  };
}

// Находит файл мода, совместимый с mcVersion + loader.
// Возвращает null, если для этой версии мода не существует
async function getCompatibleVersion(projectId, mcVersion, loader) {
  const url = `${API}/project/${projectId}/version?loaders=${JSON.stringify([loader])}&game_versions=${JSON.stringify([mcVersion])}`;
  const versions = await cachedFetchJson(url, 'Modrinth version error');
  if (!versions.length) return null;

  const best = versions[0];
  const primaryFile = best.files.find(f => f.primary) || best.files[0];

  return {
    versionId: best.id,
    versionNumber: best.version_number,
    fileName: primaryFile.filename,
    url: primaryFile.url,
    sha1: primaryFile.hashes ? primaryFile.hashes.sha1 : null,
    dependencies: (best.dependencies || [])
      .filter(d => d.dependency_type === 'required' && d.project_id)
      .map(d => d.project_id)
  };
}

// полный список версий мода под нужный лоадер (без фильтра по версии MC) —
// то же самое, что видно на странице мода на самом Modrinth, для ручного выбора
async function listVersions(projectId, loader = null) {
  const url = loader
    ? `${API}/project/${projectId}/version?loaders=${JSON.stringify([loader])}`
    : `${API}/project/${projectId}/version`;
  const versions = await cachedFetchJson(url, 'Modrinth version list error');

  return versions.map(v => {
    const primaryFile = v.files.find(f => f.primary) || v.files[0];
    return {
      versionId: v.id,
      versionNumber: v.version_number,
      name: v.name,
      gameVersions: v.game_versions,
      datePublished: v.date_published,
      fileName: primaryFile ? primaryFile.filename : null,
      url: primaryFile ? primaryFile.url : null,
      sha1: primaryFile && primaryFile.hashes ? primaryFile.hashes.sha1 : null
    };
  });
}

async function getVersionById(versionId) {
  const v = await cachedFetchJson(`${API}/version/${versionId}`, 'Modrinth version error');
  const primaryFile = v.files.find(f => f.primary) || v.files[0];
  return {
    versionId: v.id,
    versionNumber: v.version_number,
    fileName: primaryFile.filename,
    url: primaryFile.url,
    sha1: primaryFile.hashes ? primaryFile.hashes.sha1 : null,
    dependencies: (v.dependencies || [])
      .filter(d => d.dependency_type === 'required' && d.project_id)
      .map(d => d.project_id)
  };
}

async function getProjectInfo(projectId) {
  return cachedFetchJson(`${API}/project/${projectId}`, 'Modrinth project error');
}

// узнаём, что за файл, просто по его SHA1 — так можно опознать моды/ресурспаки,
// которые кто-то закинул в папку руками, а не поставил через сам лаунчер.
// Если такого хэша на Modrinth нет — вернётся null (значит, мода там просто нет)
async function identifyByHash(sha1) {
  const res = await fetch(`${API}/version_file/${sha1}?algorithm=sha1`, { headers: HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Modrinth hash lookup error: ${res.status}`);
  const version = await res.json();
  return { projectId: version.project_id, versionNumber: version.version_number };
}

async function searchResourcePacks(query, mcVersion, limit = 20, offset = 0, sort = 'relevance', category = '') {
  const facetGroups = [
    ['project_type:resourcepack'],
    [`versions:${mcVersion}`]
  ];
  if (category) facetGroups.push([`categories:${category}`]);

  const facets = JSON.stringify(facetGroups);
  const url = `${API}/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(facets)}&limit=${limit}&offset=${offset}&index=${encodeURIComponent(sort)}`;
  const data = await cachedFetchJson(url, 'Modrinth search error');

  return {
    hits: data.hits.map(h => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url,
      preview: h.featured_gallery || (h.gallery && h.gallery[0]) || '',
      downloads: h.downloads
    })),
    totalHits: data.total_hits,
    offset: data.offset,
    limit: data.limit
  };
}

// ресурспаки не привязаны к лоадеру, только к версии MC
async function getCompatibleResourcePackVersion(projectId, mcVersion) {
  const url = `${API}/project/${projectId}/version?game_versions=${JSON.stringify([mcVersion])}`;
  const versions = await cachedFetchJson(url, 'Modrinth version error');
  if (!versions.length) return null;

  const best = versions[0];
  const primaryFile = best.files.find(f => f.primary) || best.files[0];

  return {
    versionId: best.id,
    versionNumber: best.version_number,
    fileName: primaryFile.filename,
    url: primaryFile.url,
    sha1: primaryFile.hashes ? primaryFile.hashes.sha1 : null
  };
}

async function searchShaders(query, mcVersion, limit = 20, offset = 0, sort = 'relevance', category = '') {
  const facetGroups = [
    ['project_type:shader'],
    [`versions:${mcVersion}`]
  ];
  if (category) facetGroups.push([`categories:${category}`]);

  const facets = JSON.stringify(facetGroups);
  const url = `${API}/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(facets)}&limit=${limit}&offset=${offset}&index=${encodeURIComponent(sort)}`;
  const data = await cachedFetchJson(url, 'Modrinth search error');

  return {
    hits: data.hits.map(h => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url,
      preview: h.featured_gallery || (h.gallery && h.gallery[0]) || '',
      downloads: h.downloads
    })),
    totalHits: data.total_hits,
    offset: data.offset,
    limit: data.limit
  };
}

// шейдеры зависят от загрузчика шейдеров (Iris/Optifine), а не от Fabric/Forge,
// поэтому фильтруем только по версии Minecraft, как и ресурспаки
async function getCompatibleShaderVersion(projectId, mcVersion) {
  const url = `${API}/project/${projectId}/version?game_versions=${JSON.stringify([mcVersion])}`;
  const versions = await cachedFetchJson(url, 'Modrinth version error');
  if (!versions.length) return null;

  const best = versions[0];
  const primaryFile = best.files.find(f => f.primary) || best.files[0];

  return {
    versionId: best.id,
    versionNumber: best.version_number,
    fileName: primaryFile.filename,
    url: primaryFile.url,
    sha1: primaryFile.hashes ? primaryFile.hashes.sha1 : null
  };
}

module.exports = {
  searchMods,
  getCompatibleVersion,
  getProjectInfo,
  identifyByHash,
  listVersions,
  getVersionById,
  searchResourcePacks,
  getCompatibleResourcePackVersion,
  searchShaders,
  getCompatibleShaderVersion
};
