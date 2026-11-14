const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const META = 'https://meta.fabricmc.net/v2/versions/loader';
// без тайм-аута зависший запрос к API вешал весь запуск игры на кнопке
// "Играть" без единой ошибки — теперь через 15с падаем с понятным сообщением
const REQUEST_TIMEOUT_MS = 15000;

async function getLatestStableLoader(mcVersion) {
  const res = await fetch(`${META}/${mcVersion}`, { timeout: REQUEST_TIMEOUT_MS });
  if (!res.ok) throw new Error(`Fabric не поддерживает ${mcVersion} или недоступен API`);
  const list = await res.json();
  if (!list.length) throw new Error(`Для ${mcVersion} нет версий Fabric Loader`);
  const stable = list.find(l => l.loader.stable) || list[0];
  return stable.loader.version;
}

// список всех версий Fabric Loader под конкретный Minecraft — для UI-селекта в настройках
async function getLoaderVersions(mcVersion) {
  const res = await fetch(`${META}/${mcVersion}`, { timeout: REQUEST_TIMEOUT_MS });
  if (!res.ok) throw new Error(`Fabric не поддерживает ${mcVersion} или недоступен API`);
  const list = await res.json();
  return list.map(l => ({ version: l.loader.version, stable: l.loader.stable }));
}

// Скачивает профиль Fabric и кладёт его в <root>/versions/<id>/<id>.json,
// как это делает официальный установщик. minecraft-launcher-core подхватит
// его через поле version.custom и сам смёржит либы с ванильными при запуске
async function installFabric(root, mcVersion, loaderVersion) {
  // профиль Fabric неизменен для пары версий, поэтому при готовом локальном файле
  // сеть не нужна. Раньше два запроса к meta.fabricmc.net шли на каждый запуск,
  // и без доступа к ним игра не стартовала вовсе
  const versionsDir = path.join(root, 'versions');
  const findLocal = version => {
    if (!version) return null;
    const id = `fabric-loader-${version}-${mcVersion}`;
    return fs.existsSync(path.join(versionsDir, id, `${id}.json`)) ? { custom: id, loaderVersion: version } : null;
  };

  const pinned = findLocal(loaderVersion);
  if (pinned) return pinned;

  try {
    if (!loaderVersion) loaderVersion = await getLatestStableLoader(mcVersion);
    const cached = findLocal(loaderVersion);
    if (cached) return cached;

    const profileRes = await fetch(`${META}/${mcVersion}/${loaderVersion}/profile/json`, { timeout: REQUEST_TIMEOUT_MS });
    if (!profileRes.ok) throw new Error('Не удалось скачать профиль Fabric');
    const profile = await profileRes.json();

    const versionId = profile.id; // например fabric-loader-0.15.11-1.20.1
    const versionDir = path.join(versionsDir, versionId);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(profile, null, 2));

    return { custom: versionId, loaderVersion };
  } catch (err) {
    // нет сети: берём любой уже установленный Fabric под эту версию игры
    const suffix = `-${mcVersion}`;
    const local = fs.existsSync(versionsDir)
      ? fs.readdirSync(versionsDir).filter(n => n.startsWith('fabric-loader-') && n.endsWith(suffix)).sort().pop()
      : null;
    if (local) return { custom: local, loaderVersion: local.slice('fabric-loader-'.length, -suffix.length) };
    throw err;
  }
}

module.exports = { getLatestStableLoader, getLoaderVersions, installFabric };
