const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// NeoForge отдаёт всё со своего maven'а. Список версий берём из maven-metadata.xml,
// а если он вдруг не отдался — из их же JSON-API (тот же список, другой формат).
const MAVEN = 'https://maven.neoforged.net/releases';
const METADATA_URL = `${MAVEN}/net/neoforged/neoforge/maven-metadata.xml`;
const VERSIONS_API_URL = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';

// как и в forge.js: без "браузерного" User-Agent часть CDN отвечает 403
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

// без тайм-аута зависший запрос вешает весь запуск игры на кнопке "Играть"
// без единой ошибки — лучше через 15с упасть с понятным сообщением
const REQUEST_TIMEOUT_MS = 15000;

// Версия NeoForge не содержит версию Minecraft целиком, в неё зашиты только
// её части, поэтому под каждую версию игры подходит свой префикс:
//   старая схема: 1.21.1 -> 21.1.*, 1.21 -> 21.0.*
//   новая схема:  26.3   -> 26.3.0.*, 26.1.2 -> 26.1.2.*
// Так оно работает и для будущих версий, без ручного списка соответствий.
function versionPrefix(mcVersion) {
  const parts = String(mcVersion || '').trim().split('.');

  if (parts.length < 2 || parts.some(p => !/^\d+$/.test(p))) {
    throw new Error(`Не понимаю версию Minecraft "${mcVersion}" — NeoForge для неё подобрать не могу`);
  }

  if (parts[0] === '1') {
    const major = Number(parts[1]);
    const minor = Number(parts[2] || 0);
    // на 1.20.1 и старее NeoForge жил под другим артефактом (net.neoforged:forge)
    // и с другим установщиком — лаунчер его не запускает, там нужен обычный Forge
    if (major < 20 || (major === 20 && minor < 2)) {
      throw new Error(`NeoForge не поддерживает ${mcVersion} — для этой версии выбери Forge`);
    }
    return `${major}.${minor}.`;
  }

  return `${parts[0]}.${parts[1]}.${parts[2] || 0}.`;
}

// бета/альфа-сборки в списке оставляем (иногда только они и есть под свежую
// версию игры), но помечаем — по умолчанию лаунчер берёт стабильную
function isStable(version) {
  return !/-(beta|alpha|rc|pre)/i.test(version);
}

// "21.1.9" старше "21.1.10", если сравнивать строками, поэтому сравниваем
// посегментно числами
function compareVersions(a, b) {
  const nums = v => v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const left = nums(a);
  const right = nums(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  // релиз считаем новее одноимённой беты
  return (isStable(a) ? 1 : 0) - (isStable(b) ? 1 : 0);
}

async function fetchAllVersions() {
  let lastError;

  try {
    const res = await fetch(METADATA_URL, { headers: REQUEST_HEADERS, timeout: REQUEST_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1].trim());
    if (versions.length) return versions;
    lastError = new Error('пустой maven-metadata.xml');
  } catch (err) {
    lastError = err;
  }

  try {
    const res = await fetch(VERSIONS_API_URL, { headers: REQUEST_HEADERS, timeout: REQUEST_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.versions) && data.versions.length) return data.versions;
    lastError = new Error('API вернул пустой список версий');
  } catch (err) {
    lastError = err;
  }

  throw new Error(`Не удалось получить список версий NeoForge: ${lastError.message}`);
}

// список версий NeoForge под конкретный Minecraft — для UI-селекта в настройках,
// новые сверху
async function getVersions(mcVersion) {
  const prefix = versionPrefix(mcVersion);
  const all = await fetchAllVersions();

  return all
    .filter(v => v.startsWith(prefix))
    .sort((a, b) => compareVersions(b, a))
    .map(v => ({ version: v, stable: isStable(v) }));
}

async function getLatestVersion(mcVersion) {
  const versions = await getVersions(mcVersion);
  if (!versions.length) throw new Error(`NeoForge не поддерживает ${mcVersion}`);

  const stable = versions.find(v => v.stable);
  return (stable || versions[0]).version;
}

// Скачивает installer.jar в кэш лаунчера и возвращает путь до него.
// Дальше этот путь уходит в client.install() у minecraft-launcher-core как
// version.forge — ядро прогоняет его через ForgeWrapper, который умеет и NeoForge
async function downloadNeoForgeInstaller(cacheDir, mcVersion, neoforgeVersion) {
  if (!neoforgeVersion) {
    // без закреплённой версии берём самый новый уже скачанный установщик и не ходим в сеть
    const cachedDir = path.join(cacheDir, 'neoforge-installers');
    if (fs.existsSync(cachedDir)) {
      const prefix = versionPrefix(mcVersion);
      const cached = fs.readdirSync(cachedDir)
        .filter(n => n.startsWith(`neoforge-${prefix}`) && n.endsWith('-installer.jar') && fs.statSync(path.join(cachedDir, n)).size > 0)
        .map(n => n.slice('neoforge-'.length, -'-installer.jar'.length))
        .filter(v => isStable(v))
        .sort(compareVersions)
        .pop();
      if (cached) return { path: path.join(cachedDir, `neoforge-${cached}-installer.jar`), neoforgeVersion: cached };
    }
    neoforgeVersion = await getLatestVersion(mcVersion);
  }

  const fileName = `neoforge-${neoforgeVersion}-installer.jar`;
  const destDir = path.join(cacheDir, 'neoforge-installers');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, fileName);

  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { path: dest, neoforgeVersion };

  let res;
  try {
    res = await fetch(`${MAVEN}/net/neoforged/neoforge/${neoforgeVersion}/${fileName}`, {
      headers: REQUEST_HEADERS,
      timeout: 60000
    });
  } catch (err) {
    throw new Error(`Не удалось скачать установщик NeoForge: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`Не удалось скачать установщик NeoForge ${neoforgeVersion}: HTTP ${res.status}`);
  }

  const buffer = await res.buffer();
  // если maven ответил страницей с ошибкой вместо файла, в кэше останется мусор,
  // который потом будет молча ломать каждый запуск — проверяем сигнатуру zip/jar
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(`Сервер NeoForge вернул не jar-файл для версии ${neoforgeVersion} — попробуй другую версию`);
  }

  fs.writeFileSync(dest, buffer);
  return { path: dest, neoforgeVersion };
}

module.exports = { getVersions, getLatestVersion, downloadNeoForgeInstaller, versionPrefix };
