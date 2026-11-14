const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// сервер Forge в последнее время стал резать запросы без "браузерного"
// User-Agent (node-fetch по умолчанию его не шлёт) — судя по всему, часть
// их CDN считает такие запросы ботами и отвечает 403/404 вместо файла.
// Заодно на случай, если maven.minecraftforge.net снова поменяет отдачу,
// пробуем ещё и files.minecraftforge.net как запасной хост
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

const PROMOTIONS_URLS = [
  'https://maven.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
];

// без тайм-аута зависший запрос вешал весь запуск игры на кнопке "Играть"
// без единой ошибки — теперь падаем с понятным сообщением вместо бесконечной загрузки
const REQUEST_TIMEOUT_MS = 15000;

async function fetchPromotions() {
  let lastError;
  for (const url of PROMOTIONS_URLS) {
    try {
      const res = await fetch(url, { headers: REQUEST_HEADERS, timeout: REQUEST_TIMEOUT_MS });
      if (!res.ok) {
        lastError = new Error(`${url} -> HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Не удалось получить список версий Forge: ${lastError.message}`);
}

async function getForgeVersion(mcVersion) {
  const data = await fetchPromotions();

  const recommended = data.promos[`${mcVersion}-recommended`];
  const latest = data.promos[`${mcVersion}-latest`];
  const forgeVersion = recommended || latest;
  if (!forgeVersion) throw new Error(`Forge не поддерживает ${mcVersion}`);

  return forgeVersion;
}

// Скачивает installer.jar в кэш лаунчера и возвращает путь до него.
// Дальше этот путь надо передать в client.install() у minecraft-launcher-core
// как version.forge, он сам разберётся с установкой
async function downloadForgeInstaller(cacheDir, mcVersion, forgeVersion) {
  // уже скачанный установщик берём из кэша без запроса к серверу Forge.
  // Если сервер недоступен, запуск идёт на кэшированном установщике
  const cachedDir = path.join(cacheDir, 'forge-installers');
  const findCached = () => {
    if (!fs.existsSync(cachedDir)) return null;
    const prefix = `forge-${mcVersion}-`;
    const names = fs.readdirSync(cachedDir)
      .filter(n => n.startsWith(prefix) && n.endsWith('-installer.jar') && fs.statSync(path.join(cachedDir, n)).size > 0)
      .sort();
    if (!names.length) return null;
    const name = names[names.length - 1];
    return { path: path.join(cachedDir, name), forgeVersion: name.slice(prefix.length, -'-installer.jar'.length) };
  };

  if (!forgeVersion) {
    const cached = findCached();
    if (cached) return cached;
    forgeVersion = await getForgeVersion(mcVersion);
  }

  const fileName = `forge-${mcVersion}-${forgeVersion}-installer.jar`;
  const destDir = path.join(cacheDir, 'forge-installers');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, fileName);

  if (fs.existsSync(dest)) return { path: dest, forgeVersion };

  let lastError;
  for (const host of ['https://maven.minecraftforge.net', 'https://files.minecraftforge.net/maven']) {
    try {
      const res = await fetch(`${host}/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/${fileName}`, { headers: REQUEST_HEADERS, timeout: 30000 });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const buffer = await res.buffer();
      // страница с ошибкой вместо jar потом ломала бы каждый запуск
      if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        lastError = new Error('сервер вернул не jar-файл');
        continue;
      }
      fs.writeFileSync(dest, buffer);
      return { path: dest, forgeVersion };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Не удалось скачать Forge installer: ${lastError.message}`);
}

module.exports = { getForgeVersion, downloadForgeInstaller };
