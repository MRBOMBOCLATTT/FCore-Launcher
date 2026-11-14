const fetch = require('node-fetch');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

let cached = null;

// копия манифеста на диске: без неё лаунчер при недоступном Mojang
// (нет интернета, блокировка) не мог показать даже список версий
function getCachePath() {
  try {
    const { app } = require('electron');
    return require('path').join(app.getPath('userData'), 'version-manifest-cache.json');
  } catch {
    return null;
  }
}

function readDiskCache() {
  const file = getCachePath();
  if (!file) return null;
  try {
    const data = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    return data && Array.isArray(data.versions) ? data : null;
  } catch {
    return null;
  }
}

function writeDiskCache(manifest) {
  const file = getCachePath();
  if (!file) return;
  try { require('fs').writeFileSync(file, JSON.stringify(manifest)); } catch {}
}

async function fetchManifest() {
  const res = await fetch(MANIFEST_URL, { timeout: 10000 });
  if (!res.ok) throw new Error(`Не удалось получить список версий: ${res.status}`);
  const manifest = await res.json();
  cached = manifest;
  writeDiskCache(manifest);
  return manifest;
}

let refreshing = null;
function refreshManifestInBackground() {
  if (refreshing) return refreshing;
  refreshing = fetchManifest()
    .catch(err => console.warn('[versions] не удалось обновить манифест:', err.message))
    .finally(() => { refreshing = null; });
  return refreshing;
}

// Раньше при каждом старте лаунчер ждал ответа Mojang (до 10 с без интернета/при блокировке),
// и всё это время висела заставка. Теперь, если на диске есть копия манифеста, отдаём её сразу,
// а свежий список подтягиваем в фоне — новые версии появятся при следующем запуске
async function getManifest() {
  if (cached) return cached;

  const fromDisk = readDiskCache();
  if (fromDisk) {
    cached = fromDisk;
    refreshManifestInBackground();
    return cached;
  }
  return fetchManifest();
}

// Возвращает release-версии от 1.7.10 до самой новой, новые первыми
async function getReleaseVersions() {
  const manifest = await getManifest();
  const base = manifest.versions.find(v => v.id === '1.7.10');
  if (!base) throw new Error('В манифесте Mojang не нашлась версия 1.7.10');

  const baseTime = new Date(base.releaseTime).getTime();

  return manifest.versions
    .filter(v => v.type === 'release' && new Date(v.releaseTime).getTime() >= baseTime)
    .map(v => ({ id: v.id, releaseTime: v.releaseTime, url: v.url }));
}

module.exports = { getManifest, getReleaseVersions };
