const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const fabric = require('./fabric');
const forge = require('./forge');
const neoforge = require('./neoforge');
const modManager = require('./modManager');
const authlibInjector = require('./authlibInjector');
const customSkinLoader = require('./customSkinLoader');
const { getCustomSkinLoaderEnabled } = require('./store');
const { setGpuPreference } = require('./gpuPreference');
const { downloadFileWithRetry, downloadFileMultiPart, ensureFreeSpace } = require('./downloader');
const { extractZipToDir } = require('./zipStream');
const { writeCrashReport } = require('./crashReporter');
const { analyzeCrash } = require('./crashAnalyzer');
const resourceMetrics = require('./resourceMetrics');
const os = require('os');
const javaRuntime = require('./javaRuntime');
const { applyMclcPatches } = require('./mclcPatches');
const { buildQuickPlayArgs } = require('./quickPlay');


// корень игры, известный после первого запуска: по нему читаем кэш требований Java
let knownRoot = null;

// minecraft-launcher-core определяет "современный" (1.13+) Forge/NeoForge по строке
// вида "1.21.1" — смотрит на число между первой и второй точкой. С новой схемой
// версий Minecraft (26.1, 26.3 и дальше) там оказывается "3" вместо "21", ядро
// считает лоадер легаси-Forge'ем и собирает запуск неправильно — игра не стартует.
// Чиним ровно этот случай: на версиях старой схемы ("1.x") поведение не трогаем.
// Всё в try/catch: если после обновления ядра внутренний файл переедет, лаунчер
// просто продолжит работать как раньше, а не упадёт на старте.
function patchModernForgeDetection() {
try {
  const Handler = require('minecraft-launcher-core/components/handler');
  const originalIsModernForge = Handler.prototype.isModernForge;
  Handler.prototype.isModernForge = function (json) {
    if (!json || !json.inheritsFrom) return false;
    if (String(json.inheritsFrom).split('.')[0] !== '1') return true;
    return originalIsModernForge.call(this, json);
  };
} catch (err) {
  console.warn('[launcher] не удалось поправить определение версии в minecraft-launcher-core:', err.message);
}
}

// minecraft-launcher-core подключается лениво: require занимает ~130 мс и нужен только
// в момент запуска игры, а не при старте лаунчера. Патчи применяются один раз при первом запуске
let MclcClient = null;
function loadMclc() {
  if (!MclcClient) {
    MclcClient = require('minecraft-launcher-core').Client;
    applyMclcPatches();
    patchModernForgeDetection();
  }
  return MclcClient;
}

// начиная с 1.13 Minecraft хранит размер окна в options.txt (overrideWidth/overrideHeight)
// и если файл уже существует, --width/--height из аргументов запуска просто игнорируются —
// поэтому размер окна из настроек лаунчера прописываем туда напрямую
function applyWindowOptions(instanceDir, window) {
  const optionsPath = path.join(instanceDir, 'options.txt');
  let lines = [];
  if (fs.existsSync(optionsPath)) {
    lines = fs.readFileSync(optionsPath, 'utf8').split('\n').filter(l => l.trim());
  }

  const values = {
    overrideWidth: window.width,
    overrideHeight: window.height,
    fullscreen: window.fullscreen ? 'true' : 'false'
  };

  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex(l => l.startsWith(`${key}:`));
    const line = `${key}:${value}`;
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }

  fs.writeFileSync(optionsPath, lines.join('\n') + '\n');
}

// ищет javaw.exe внутри уже распакованного JDK — папка вида jdk-17.0.13+11
// у Adoptium периодически меняется (выходят новые патчи), поэтому не хардкодим её имя
function findJavaw(javaDir) {
  if (!fs.existsSync(javaDir)) return null;
  const entries = fs.readdirSync(javaDir, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const entry of entries) {
    const candidate = path.join(javaDir, entry.name, 'bin', 'javaw.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`Сервер не ответил за 15с: ${url}`);
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} при запросе ${url}`);
  return res.json();
}

// запасной вариант на случай отсутствия сети или если Mojang изменит формат манифеста
function fallbackJavaVersion(mcVersion) {
  const [major, minor = 0, patch = 0] = mcVersion.split('.').map(Number);
  if (major !== 1) return 21; // смена схемы версионирования в будущем — берём заведомо новую JDK
  if (minor < 17) return 8;
  if (minor < 20 || (minor === 20 && patch < 5)) return 17;
  return 21;
}

// узнаём реальную требуемую версию Java: локальный json версии, кэш, и только потом
// официальный манифест Mojang. Раньше каждый запуск качал манифест (сотни КБ)
// и ждал до 15с при плохой сети, даже если Java уже стояла
let manifestPromise = null;
async function resolveJavaRequirement(mcVersion, root = knownRoot) {
  const cached = javaRuntime.readCachedRequirement(root, mcVersion);
  if (cached) return cached;
  try {
    if (!manifestPromise) manifestPromise = fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const manifest = await manifestPromise;
    const entry = manifest.versions.find(v => v.id === mcVersion);
    if (entry) {
      const versionMeta = await fetchJson(entry.url);
      if (versionMeta.javaVersion && versionMeta.javaVersion.majorVersion) {
        const requirement = { major: versionMeta.javaVersion.majorVersion, component: versionMeta.javaVersion.component || null };
        javaRuntime.saveRequirement(root, mcVersion, requirement);
        return requirement;
      }
    }
  } catch (e) {
    manifestPromise = null; // сеть недоступна: в следующий раз попробуем заново
  }
  return { major: fallbackJavaVersion(mcVersion), component: null };
}

async function resolveRequiredJavaVersion(mcVersion, root = knownRoot) {
  return (await resolveJavaRequirement(mcVersion, root)).major;
}

// динамически получаем ссылку на актуальную сборку нужной мажорной версии JDK
// (вместо зашитой ссылки на конкретный патч, которая рано или поздно устареет)
async function getAdoptiumDownloadUrl(majorVersion) {
  // JRE весит в разы меньше JDK, поэтому пробуем её первой
  for (const imageType of ['jre', 'jdk']) {
    const apiUrl = `https://api.adoptium.net/v3/assets/latest/${majorVersion}/hotspot?vendor=eclipse&os=windows&architecture=x64&image_type=${imageType}`;
    try {
      const assets = await fetchJson(apiUrl);
      if (Array.isArray(assets) && assets.length) return assets[0].binary.package.link;
    } catch (err) {
      if (imageType === 'jdk') throw err;
    }
  }
  throw new Error(`Adoptium не вернул сборку Java ${majorVersion} для Windows x64`);
}

async function downloadJavaMajor(root, javaMajor, onEvent = () => {}, component = null) {
  const javaDir = path.join(root, 'java', String(javaMajor));

  let javawPath = findJavaw(javaDir);
  if (javawPath) return javawPath;

  fs.mkdirSync(javaDir, { recursive: true });

  // сначала рантайм Mojang, как в официальном лаунчере. Если не вышло, качаем Adoptium
  try {
    const mojangJavaw = await javaRuntime.installMojangRuntime({ root, major: javaMajor, component, onEvent });
    if (mojangJavaw) return mojangJavaw;
  } catch (err) {
    if (err?.code === 'DOWNLOAD_CANCELLED') throw err;
    console.warn('[launcher] рантайм Mojang не установился, пробую Adoptium:', err.message);
  }

  const zipPath = path.join(javaDir, 'java.zip');

  onEvent({ stage: 'java-download', javaMajor, downloaded: 0, total: 0 });
  const url = await getAdoptiumDownloadUrl(javaMajor);
  // многопоточная докачка вместо одного соединения — JDK-архив весит
  // десятки-сотни МБ, и на одном потоке скорость часто упирается в задержку
  // соединения, а не в реальную пропускную способность канала
  await downloadFileMultiPart(url, zipPath, {
    onProgress: ({ downloaded, total }) => onEvent({ stage: 'java-download', javaMajor, downloaded, total })
  });

  onEvent({ stage: 'java-extract', javaMajor });
  await extractZipToDir(zipPath, javaDir);
  fs.unlinkSync(zipPath);

  javawPath = findJavaw(javaDir);
  if (!javawPath) throw new Error(`Не удалось найти javaw.exe после установки JDK ${javaMajor}`);
  return javawPath;
}

async function ensureJava(root, mcVersion, onEvent = () => {}) {
  onEvent({ stage: 'java-check' });
  const requirement = await resolveJavaRequirement(mcVersion, root);
  return downloadJavaMajor(root, requirement.major, onEvent, requirement.component);
}

// Запускает java -version и вытаскивает мажорную версию (учитывая старую схему
// нумерации вида "1.8.0_351", где реальная версия — это 8, а не 1)
// Асинхронно: раньше был spawnSync, и пока поднималась JVM (сотни мс, на Windows — больше),
// главный процесс стоял и интерфейс не получал ни прогресс, ни клики
function detectJavaMajorVersion(javaPath) {
  return new Promise(resolve => {
    try {
      execFile(javaPath, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        const output = `${stderr || ''}${stdout || ''}`;
        const match = output.match(/version "(\d+)(?:\.(\d+))?/);
        if (!match) return resolve(null);
        const first = parseInt(match[1], 10);
        const second = match[2] ? parseInt(match[2], 10) : null;
        resolve(first === 1 && second !== null ? second : first);
      });
    } catch {
      resolve(null);
    }
  });
}

// Проверка совместимости конкретного java-пути с конкретной версией Minecraft —
// требуемую версию узнаём тем же способом, что и при авто-установке (манифест Mojang),
// так что диагностика не разъезжается с реальной логикой скачивания.
// Используется и перед запуском (когда путь выбран вручную), и как отдельная
// кнопка «Проверить Java» в настройках
async function checkJavaCompatibility(javaPath, mcVersion) {
  const required = await resolveRequiredJavaVersion(mcVersion);

  if (!javaPath || !fs.existsSync(javaPath)) {
    return { ok: false, detected: null, required, message: 'Файл не найден по указанному пути' };
  }

  const detected = await detectJavaMajorVersion(javaPath);
  if (detected === null) {
    return { ok: null, detected: null, required, message: 'Не удалось определить версию (java -version не ответил)' };
  }

  if (detected < required) {
    return {
      ok: false,
      detected,
      required,
      message: `Обнаружена Java ${detected}, а для Minecraft ${mcVersion} обычно нужна Java ${required}+. Игра может не запуститься или упасть при загрузке.`
    };
  }

  return { ok: true, detected, required, message: `Java ${detected} подходит для Minecraft ${mcVersion}` };
}

// minecraft-launcher-core кэширует сгенерированный ForgeWrapper'ом version.json
// в <root>/forge/<версия MC>/version.json — без оглядки на то, Forge это или NeoForge.
// Из-за этого, поиграв на Forge 1.21.1, NeoForge на той же версии стартовал бы по
// чужому кэшу (и наоборот). Перед запуском сверяем, чей там json, и чужой сносим —
// ядро просто сгенерирует новый из нужного установщика.
function resetAlienForgeWrapperCache(root, mcVersion, loader) {
  const cachePath = path.join(root, 'forge', mcVersion, 'version.json');
  if (!fs.existsSync(cachePath)) return;

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const cachedIsNeoforge = /neoforge/i.test(cached.id || '');
    if (cachedIsNeoforge !== (loader === 'neoforge')) fs.rmSync(cachePath, { force: true });
  } catch {
    // битый/нечитаемый кэш — сносим, пусть ядро соберёт заново
    try { fs.rmSync(cachePath, { force: true }); } catch { /* уже удалён или занят — не повод падать */ }
  }
}

// выделение больше 70% оперативки валит игру на слабых ПК (JVM не может занять память
// или система уходит в своп). Урезаем max, а min не даём выше max
function parseMb(value) {
  const m = String(value || '').trim().match(/^(\d+)\s*([mMgG])?/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return /g/i.test(m[2] || '') ? n * 1024 : n;
}

function clampMemory(memory) {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const limitMb = Math.max(1024, Math.floor(totalMb * 0.7));
  const maxMb = parseMb(memory.max);
  const minMb = parseMb(memory.min);
  const result = { ...memory };
  if (maxMb && maxMb > limitMb) result.max = `${limitMb}M`;
  const effMax = parseMb(result.max);
  if (minMb && effMax && minMb > effMax) result.min = `${effMax}M`;
  return result;
}

async function launchGame({ root, mcVersion, loader, loaderVersion, logsEnabled = true, mclcAuth, memory, javaPathOverride, jvmArgs, window, gpuPreference, quickPlay, env, onEvent = () => {} }) {
  if (!mclcAuth || !mclcAuth.access_token) {
    throw new Error("Нет авторизации Ely.by — сначала войдите в аккаунт.");
  }

  const quickPlayArgs = buildQuickPlayArgs(quickPlay, mcVersion);

  knownRoot = root;
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  fs.mkdirSync(instanceDir, { recursive: true });

  // не пытаемся угадать точный объём докачки (Minecraft сам пропустит то, что уже стоит) —
  // просто подстраховываемся от совсем пустого диска
  await ensureFreeSpace(root, 500 * 1024 * 1024, 'Minecraft');

  const version = { number: mcVersion, type: 'release' };
  let forgeInstallerPath = null;

  if (loader === 'fabric') {
    onEvent({ stage: 'installing-loader', loader: 'fabric' });
    const fabricInfo = await fabric.installFabric(root, mcVersion, loaderVersion);
    version.custom = fabricInfo.custom;
  } else if (loader === 'forge') {
    onEvent({ stage: 'installing-loader', loader: 'forge' });
    const cacheDir = path.join(root, 'cache');
    const installer = await forge.downloadForgeInstaller(cacheDir, mcVersion);
    forgeInstallerPath = installer.path;
    resetAlienForgeWrapperCache(root, mcVersion, loader);
  } else if (loader === 'neoforge') {
    // NeoForge ставится тем же путём, что и современный Forge: качаем официальный
    // installer.jar и отдаём его ядру — ForgeWrapper внутри mclc сам прогонит установку
    onEvent({ stage: 'installing-loader', loader: 'neoforge' });
    const cacheDir = path.join(root, 'cache');
    const installer = await neoforge.downloadNeoForgeInstaller(cacheDir, mcVersion, loaderVersion);
    forgeInstallerPath = installer.path;
    resetAlienForgeWrapperCache(root, mcVersion, loader);
  }

  let javaPath = javaPathOverride;
  if (!javaPath || !fs.existsSync(javaPath)) {
    onEvent({ stage: 'installing-loader', loader: 'java' });
    javaPath = await ensureJava(root, mcVersion, onEvent);
  } else {
    // Java выбрана вручную — авто-скачанная всегда правильной версии, а вот
    // здесь могли выбрать что-то несовместимое. Не блокируем запуск, просто предупреждаем
    try {
      const check = await checkJavaCompatibility(javaPath, mcVersion);
      if (check.ok === false) {
        onEvent({ stage: 'java-warning', message: check.message });
      }
    } catch (err) {
      console.error('[launcher] не удалось проверить версию Java:', err.message);
    }
  }

  if (gpuPreference && gpuPreference !== 'auto') await setGpuPreference(javaPath, gpuPreference);

  // на ванильном лоадере модов нет и быть не может — CSL актуален только на модовых сборках
  if (loader !== 'vanilla') {
    const modsDir = modManager.getModsDir(root, mcVersion, loader);
    try {
      if (getCustomSkinLoaderEnabled()) {
        customSkinLoader.ensureCustomSkinLoader(modsDir);
      } else {
        customSkinLoader.removeCustomSkinLoader(modsDir);
      }
    } catch (err) {
      console.error('[launcher] не удалось подготовить CustomSkinLoader:', err.message);
    }
  }

  const customArgs = [];
  const isElyby = mclcAuth?.meta?.type === 'elyby';

  if (isElyby) {
    onEvent({ stage: 'installing-loader', loader: 'authlib-injector' });
    const injectorPath = await authlibInjector.ensureAuthlibInjector(root);
    customArgs.push(`-javaagent:${injectorPath}=ely.by`);
  }

  const Client = loadMclc();
  const client = new Client();
  const opts = {
    authorization: mclcAuth,
    root,
    version,
    memory: clampMemory(memory || { max: '4G', min: '1G' }),
    // maxSockets: по умолчанию mclc качает в 2 соединения. 24 перегружало слабые каналы
    // и давало обрывы, из-за них часть файлов не докачивалась и игра падала. 12 надёжнее
    overrides: { gameDirectory: instanceDir, cwd: instanceDir, maxSockets: 12 },
    javaPath,
    window: window || { width: 854, height: 480, fullscreen: false }
  };

  if (forgeInstallerPath) opts.forge = forgeInstallerPath;

  applyWindowOptions(instanceDir, opts.window);

  if (jvmArgs && jvmArgs.trim()) customArgs.push(...jvmArgs.trim().split(/\s+/));
  if (customArgs.length) opts.customArgs = customArgs;

  if (quickPlayArgs.length) opts.customLaunchArgs = quickPlayArgs;
  if (env && Object.keys(env).length) opts.fcoreEnv = env;

  const authlibLines = [];
  const recentLines = []; // последние строки лога — на случай крашрепорта
  const launchBeganAt = Date.now();
  let metricsSession = null; // запись ОЗУ/CPU процесса игры, создаётся после старта Java
  const RECENT_LIMIT = 400; // с запасом: анализатору краша нужен и стек-трейс, и сообщения загрузчика
  const pushRecent = line => {
    recentLines.push(line);
    if (recentLines.length > RECENT_LIMIT) recentLines.shift();
  };

  // Пока игра работает, client.on('data'/'debug') сыплет десятками строк в секунду —
  // если слать каждую отдельным IPC-сообщением, лаунчер лагает вместе с игрой.
  // Поэтому копим строки и сбрасываем пачкой раз в LOG_FLUSH_MS.
  const LOG_FLUSH_MS = 150;
  let dataBuffer = [];
  let debugBuffer = [];
  let flushTimer = null;

  function flushLogs() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dataBuffer.length && !debugBuffer.length) return;
    onEvent({ stage: 'log-batch', data: dataBuffer, debug: debugBuffer });
    dataBuffer = [];
    debugBuffer = [];
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
  }

  client.on('debug', e => {
    pushRecent(e);
    if (!logsEnabled) return;
    debugBuffer.push(e);
    scheduleFlush();
  });
  const connectRegex = /Connecting to ([^,]+), (\d+)/i;

  // время реального запуска игры — первая строка stdout самого процесса,
  // а не начала client.launch() (туда входит ещё скачивание/установка лоадера и Java)
  let gameStartedAt = null;
  let gameStartedNotified = false;
  const notifyGameStarted = () => {
    if (gameStartedNotified) return;
    gameStartedNotified = true;
    gameStartedAt = Date.now();
    onEvent({ stage: 'game-started' });
  };

  // В некоторых версиях minecraft-launcher-core окно Minecraft уже
  // появляется до первой строки stdout. Поэтому используем событие spawn,
  // если оно поддерживается, и оставляем stdout как запасной вариант.
  client.on('spawn', notifyGameStarted);

  client.on('data', e => {
    if (!gameStartedAt) notifyGameStarted();
    pushRecent(e);
    metricsSession?.noteLogLine(e);
    if (isElyby && e.toLowerCase().includes('authlib-injector')) authlibLines.push(e.trim());

    const connectMatch = e.match(connectRegex);
    if (connectMatch) onEvent({ stage: 'server-connect', host: connectMatch[1], port: Number(connectMatch[2]) });
    if (e.includes('Starting integrated minecraft server')) onEvent({ stage: 'singleplayer-start' });
    if (e.includes('Stopping worker threads')) onEvent({ stage: 'server-disconnect' });

    if (!logsEnabled) return;
    dataBuffer.push(e);
    scheduleFlush();
  });
  client.on('progress', e => onEvent({ stage: 'progress', ...e }));
  client.on('download-status', e => onEvent({ stage: 'download', ...e }));
  client.on('close', code => {
    try {
      flushLogs(); // чтобы последние строки лога не потерялись перед 'closed'/'crash'

      if (isElyby) {
        const logPath = path.join(instanceDir, 'authlib-injector.log');
        fs.writeFileSync(logPath, authlibLines.join('\n'));
        onEvent({ stage: 'authlib-log', lines: authlibLines, logPath });
      }

      // код 0 — нормальный выход; всё остальное считаем крашем и пишем отчёт
      // (частая причина — битый/несовместимый мод, который валит игру при загрузке)
      if (code !== 0 && code !== null) {
        const crashPath = writeCrashReport(root, { mcVersion, loader, code, recentLines });
        onEvent({ stage: 'crash', code, crashPath });

        // Авто-починка: разбор идёт в фоне и приходит отдельным событием, чтобы не задерживать
        // 'closed'. Любая ошибка анализа не должна ломать обработку закрытия игры.
        analyzeCrash({ root, mcVersion, loader, code, recentLines: recentLines.slice(), startedAt: launchBeganAt })
          .then(analysis => onEvent({ stage: 'crash-analysis', code, crashPath, analysis }))
          .catch(err => console.error('[launcher] не удалось проанализировать краш:', err.message));
      }

      // Метрики: сохраняем запуск (в том числе упавший — его цифры тоже полезны для сравнения)
      if (metricsSession) {
        const session = metricsSession;
        metricsSession = null;
        session.stop(code)
          .then(run => { if (run) onEvent({ stage: 'metrics-saved', runId: run.id, summary: run.summary }); })
          .catch(err => console.error('[launcher] не удалось сохранить метрики:', err.message));
      }
      onEvent({ stage: 'performance-stopped' });

      const playtimeMs = gameStartedAt ? Date.now() - gameStartedAt : 0;
      onEvent({ stage: 'closed', code, playtimeMs });
    } catch (err) {
      // что бы тут ни пошло не так (например, не удалось записать файл лога),
      // лаунчер не должен из-за этого падать целиком
      console.error('[launcher] ошибка при обработке закрытия игры:', err.message);
    }
  });

  // Не блокируем IPC-вызов на всё время жизни Minecraft.
  // client.launch() завершается только после закрытия игры, из-за чего
  // экран загрузки и кнопка запуска оставались активными часами.
  // Передаём запуск Minecraft отдельному процессу и сразу сообщаем UI,
  // что окно лаунчера больше не должно оставаться заблокированным.
  // Не ждём завершения Promise: minecraft-launcher-core может держать его
  // открытым до закрытия самой игры.
  let launchPromise;
  try {
    launchPromise = client.launch(opts);
  } catch (err) {
    console.error('[launcher] синхронная ошибка запуска Minecraft:', err);
    onEvent({ stage: 'crash', code: null, crashPath: '', message: err.message });
    throw err;
  }

  // spawn/data не гарантированно приходят во всех версиях ядра. Поэтому
  // считаем запуск переданным сразу после успешного вызова client.launch().
  notifyGameStarted();
  Promise.resolve(launchPromise).then(proc => {
    // minecraft-launcher-core возвращает дочерний процесс Java — берём его PID для метрик.
    // Если ядро обновится и перестанет его отдавать, метрики тихо отключатся, игра запустится как обычно.
    if (!proc || !proc.pid || metricsSession) return;
    try {
      metricsSession = resourceMetrics.startSession({
        root, mcVersion, loader, pid: proc.pid,
        settings: { memoryMax: opts.memory?.max, memoryMin: opts.memory?.min, jvmArgs, java: javaPath },
        onError: err => console.error('[metrics]', err?.message || err),
        onLiveSample: sample => onEvent({ stage: 'performance-sample', ...sample })
      });
    } catch (err) {
      console.error('[launcher] метрики недоступны:', err.message);
    }
  }).catch(err => {
    console.error('[launcher] ошибка запуска Minecraft:', err);
    onEvent({ stage: 'crash', code: null, crashPath: '', message: err.message });
  });
  return { instanceDir, launched: true };
}

// быстрая проверка "на глаз" — сама minecraft-launcher-core умеет докачивать
// недостающее при запуске, но пользователю полезно видеть, чего не хватает,
// не запуская игру
function verifyCoreFiles(root, mcVersion) {
  const versionJar = path.join(root, 'versions', mcVersion, `${mcVersion}.jar`);
  const versionJson = path.join(root, 'versions', mcVersion, `${mcVersion}.json`);
  const librariesDir = path.join(root, 'libraries');
  const assetsDir = path.join(root, 'assets');

  return {
    jarOk: fs.existsSync(versionJar),
    jsonOk: fs.existsSync(versionJson),
    librariesOk: fs.existsSync(librariesDir) && fs.readdirSync(librariesDir).length > 0,
    assetsOk: fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).length > 0
  };
}

module.exports = { launchGame, verifyCoreFiles, checkJavaCompatibility, resolveRequiredJavaVersion, resolveJavaRequirement, downloadJavaMajor, findJavaw };