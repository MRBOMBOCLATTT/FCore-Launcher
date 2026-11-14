const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchWithTimeout, downloadFileWithRetry, runWithConcurrency } = require('./downloader');

// Java из каталога Mojang. Это тот же рантайм, который скачивает официальный лаунчер:
// небольшой JRE, раздаётся с серверов Mojang отдельными файлами. Adoptium JDK весит
// в разы больше и в ряде регионов качается медленно или обрывается.
const RUNTIME_INDEX_URL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const PLATFORM = process.arch === 'ia32' ? 'windows-x86' : process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64';

const COMPONENT_BY_MAJOR = { 8: 'jre-legacy', 16: 'java-runtime-alpha', 17: 'java-runtime-gamma', 21: 'java-runtime-delta', 25: 'java-runtime-epsilon' };

function componentForMajor(major) {
  return COMPONENT_BY_MAJOR[major] || null;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch { /* кэш не критичен */ }
}

// Требуемая Java для версии MC. Порядок: локальный json версии, кэш, сеть.
// Требование к версии не меняется, поэтому после первого запуска сеть не нужна.
function readCachedRequirement(root, mcVersion) {
  if (!root) return null;
  const local = readJson(path.join(root, 'versions', mcVersion, `${mcVersion}.json`));
  if (local && local.javaVersion && local.javaVersion.majorVersion) {
    return { major: local.javaVersion.majorVersion, component: local.javaVersion.component || null };
  }
  const cache = readJson(path.join(root, 'cache', 'java-requirements.json')) || {};
  return cache[mcVersion] || null;
}

function saveRequirement(root, mcVersion, requirement) {
  if (!root) return;
  const file = path.join(root, 'cache', 'java-requirements.json');
  const cache = readJson(file) || {};
  cache[mcVersion] = requirement;
  writeJson(file, cache);
}

async function getJson(url) {
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`HTTP ${res.status} при запросе ${url}`);
  return res.json();
}

function sha1OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', c => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

// Ставит рантайм Mojang в <root>/java/<major>/mojang-runtime и возвращает путь к javaw.exe.
// Качаем в отдельную папку cache и переносим целиком в конце, поэтому недокачанный
// рантайм никогда не примет за готовый. Уже скачанные файлы при повторе пропускаются.
async function installMojangRuntime({ root, major, component, onEvent = () => {} }) {
  if (process.platform !== 'win32') return null;
  component = component || componentForMajor(major);
  if (!component) return null;

  const index = await getJson(RUNTIME_INDEX_URL);
  const entry = index[PLATFORM] && index[PLATFORM][component] && index[PLATFORM][component][0];
  if (!entry) return null;

  const manifest = await getJson(entry.manifest.url);
  const files = Object.entries(manifest.files || {}).filter(([, f]) => f.type === 'file' && f.downloads && f.downloads.raw);
  const dirs = Object.entries(manifest.files || {}).filter(([, f]) => f.type === 'directory');

  const partialDir = path.join(root, 'cache', 'java-partial', component);
  fs.mkdirSync(partialDir, { recursive: true });
  for (const [rel] of dirs) fs.mkdirSync(path.join(partialDir, rel), { recursive: true });

  const total = files.reduce((sum, [, f]) => sum + (f.downloads.raw.size || 0), 0);
  let downloaded = 0;
  let doneFiles = 0;
  const queuedFiles = files.map(([rel]) => path.basename(rel));
  onEvent({ stage: 'java-download', javaMajor: major, downloaded: 0, total, totalFiles: files.length, doneFiles, queuedFiles });

  await runWithConcurrency(files, async ([rel, f]) => {
    const dest = path.join(partialDir, rel);
    const raw = f.downloads.raw;
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    let ok = false;
    try {
      ok = fs.existsSync(dest) && fs.statSync(dest).size === raw.size && (await sha1OfFile(dest)) === raw.sha1;
    } catch { ok = false; }

    for (let attempt = 0; !ok && attempt < 2; attempt++) {
      await downloadFileWithRetry(raw.url, dest, { retries: 4 });
      ok = (await sha1OfFile(dest)) === raw.sha1;
      if (!ok) fs.rmSync(dest, { force: true });
    }
    if (!ok) throw new Error(`Контрольная сумма не совпала: ${rel}`);

    downloaded += raw.size || 0;
    doneFiles++;
    onEvent({ stage: 'java-download', javaMajor: major, downloaded, total, totalFiles: files.length, doneFiles, queuedFiles: queuedFiles.slice(doneFiles) });
  }, 10);

  if (!fs.existsSync(path.join(partialDir, 'bin', 'javaw.exe'))) {
    throw new Error('В рантайме Mojang нет bin/javaw.exe');
  }

  onEvent({ stage: 'java-extract', javaMajor: major });
  const targetDir = path.join(root, 'java', String(major), 'mojang-runtime');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(partialDir, targetDir);
  return path.join(targetDir, 'bin', 'javaw.exe');
}

module.exports = { installMojangRuntime, componentForMajor, readCachedRequirement, saveRequirement };
