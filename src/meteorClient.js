const fs = require('fs');
const path = require('path');
const { getModsDir } = require('./modManager');
const { fetchWithTimeout, downloadFileWithRetry } = require('./downloader');

// Meteor Client живёт только на GitHub Releases разработчиков — его нет ни на
// Modrinth, ни на CurseForge, поэтому обычный механизм обновления модов его не видит.
// Официальный GitHub-релиз поддерживает только САМУЮ последнюю версию Minecraft,
// поэтому для старых версий сначала пробуем архив с билдами под конкретные версии.
const RELEASES_API = 'https://api.github.com/repos/MeteorDevelopment/meteor-client/releases/latest';
const ARCHIVE_URL = 'https://maninmyvan.github.io/meteor-archive/';

async function fetchLatestRelease() {
  const res = await fetchWithTimeout(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' }
  }, 15000);
  if (!res.ok) {
    throw new Error(`GitHub вернул ${res.status} — не удалось получить релиз Meteor Client`);
  }
  const data = await res.json();
  const asset = (data.assets || []).find(a => a.name.endsWith('.jar'));
  if (!asset) {
    throw new Error('В последнем релизе Meteor Client не нашёлся .jar файл');
  }
  return {
    version: data.tag_name,
    fileName: asset.name,
    downloadUrl: asset.browser_download_url,
    source: 'official'
  };
}

// таблица архива — простая HTML-табличка (Release | Version | Download),
// парсим её регулярками, без лишних зависимостей вроде cheerio
async function fetchArchiveIndex() {
  const res = await fetchWithTimeout(ARCHIVE_URL, {}, 15000);
  if (!res.ok) {
    throw new Error(`Не удалось открыть архив Meteor Client: ${res.status}`);
  }
  const html = await res.text();

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html))) {
    const rowHtml = trMatch[1];
    if (/<th[^>]*>/i.test(rowHtml)) continue; // строка заголовка

    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(rowHtml))) cells.push(tdMatch[1]);
    if (cells.length < 3) continue;

    const build = cells[0].replace(/<[^>]+>/g, '').trim();
    const mcLabel = cells[1].replace(/<[^>]+>/g, '').trim();
    const hrefMatch = cells[2].match(/href="([^"]+)"/i);
    const fileNameMatch = cells[2].match(/>([^<]*\.jar)</i);

    if (!build || !mcLabel) continue;
    rows.push({
      build,
      mcLabel,
      url: hrefMatch ? hrefMatch[1] : null,
      fileName: fileNameMatch ? fileNameMatch[1] : (hrefMatch ? path.basename(hrefMatch[1]) : null)
    });
  }

  if (!rows.length) {
    throw new Error('Не удалось разобрать таблицу архива Meteor Client — возможно, сайт изменил разметку');
  }
  return rows;
}

// в архиве версия колонки бывает вида "1.20/1.20.1" или "1.16.x" — сверяем аккуратно
function labelMatchesVersion(label, mcVersion) {
  return label.split('/').map(s => s.trim()).some(part => {
    if (!part) return false;
    if (part === mcVersion) return true;
    if (part.toLowerCase().endsWith('.x')) {
      const prefix = part.slice(0, -2);
      return mcVersion === prefix || mcVersion.startsWith(`${prefix}.`);
    }
    return false;
  });
}

function findArchiveBuild(rows, mcVersion) {
  return rows.find(r => r.url && labelMatchesVersion(r.mcLabel, mcVersion)) || null;
}

// главный поиск: сначала архив под конкретную версию MC, потом официальный
// последний релиз (годится только если у игрока и правда самая свежая версия)
async function resolveBuild(mcVersion) {
  try {
    const rows = await fetchArchiveIndex();
    const archiveMatch = findArchiveBuild(rows, mcVersion);
    if (archiveMatch) {
      return { version: archiveMatch.build, fileName: archiveMatch.fileName, downloadUrl: archiveMatch.url, source: 'archive' };
    }
  } catch (err) {
    if (err?.code === 'DOWNLOAD_CANCELLED') throw err;
    console.error('[meteorClient] архив недоступен, пробую официальный релиз:', err.message);
  }
  return fetchLatestRelease();
}

async function checkForUpdate(currentVersion, mcVersion) {
  const build = await resolveBuild(mcVersion);
  return { ...build, hasUpdate: build.version !== currentVersion };
}

async function install(root, mcVersion, loader, onProgress) {
  const build = await resolveBuild(mcVersion);
  const modsDir = getModsDir(root, mcVersion, loader);
  fs.mkdirSync(modsDir, { recursive: true });

  const dest = path.join(modsDir, build.fileName);
  const stagingDest = `${dest}.incoming`;
  await downloadFileWithRetry(build.downloadUrl, stagingDest, {
    onProgress: ({ downloaded, total }) => {
      if (onProgress) onProgress({ downloaded, total, percent: total ? (downloaded / total) * 100 : 0 });
    }
  });

  // Старую версию удаляем только после полной загрузки новой: отмена или сетевой
  // сбой больше не оставят пользователя без установленного Meteor Client.
  for (const fileName of fs.readdirSync(modsDir)) {
    if (!/^meteor-client-.*\.jar(\.disabled)?$/i.test(fileName)) continue;
    const fullPath = path.join(modsDir, fileName);
    try { fs.rmSync(fullPath, { force: true }); } catch {}
  }
  fs.renameSync(stagingDest, dest);

  return { version: build.version, fileName: build.fileName, source: build.source };
}

module.exports = { checkForUpdate, install };
