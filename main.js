const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session, Tray, Notification, nativeImage, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require("crypto");
const { pathToFileURL } = require('url');
const { modMemberKey, normalizeModFileName } = require('./src/modGroups');

// до ребрендинга данные лежали в «PFC Launcher»: у существующих пользователей остаёмся там,
// иначе после обновления пропадут аккаунты и настройки
const legacyUserData = path.join(app.getPath('appData'), 'PFC Launcher');
if (fs.existsSync(legacyUserData)) app.setPath('userData', legacyUserData);

// electron-updater подключается лениво: сам require занимает ~80 мс, а обновления
// нужны только через пару секунд после старта (или по кнопке «Проверить обновления»)
let autoUpdaterInstance = null;
function getAutoUpdater() {
  if (!autoUpdaterInstance) {
    autoUpdaterInstance = require('electron-updater').autoUpdater;
    autoUpdaterInstance.autoDownload = true;        // качаем сразу в фоне, без диалогов и лишних вопросов
    autoUpdaterInstance.autoInstallOnAppQuit = true; // если скачано, но не установлено сразу — поставит при закрытии
  }
  return autoUpdaterInstance;
}

// меньше — интерфейс начинает ломаться (сайдбар с контентом просто не помещаются)
const MIN_LAUNCHER_WIDTH = 960;
const MIN_LAUNCHER_HEIGHT = 600;

// тот же запас, что и у Microsoft-токенов в msAuth.js — не обновляем токен
// перед каждым запуском вслепую, только когда он реально скоро протухнет
const ELYBY_EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

function isElybyTokenValid(mclcAuth) {
  const meta = mclcAuth?.meta;
  if (!meta?.obtainedAt || typeof meta.expires_in !== 'number') return false;
  const expiresAt = meta.obtainedAt + meta.expires_in * 1000;
  return expiresAt - Date.now() > ELYBY_EXPIRY_SAFETY_MARGIN_MS;
}

const {
  store, migrateAccountsEncryption, getAccountAt, addAccount, getSelectedAccount, saveSelectedAccount, saveAccountAt, getInstance, setWantedMods, getModGroups, createModGroup, renameModGroup, deleteModGroup, assignModsToGroup, removeModsFromGroup, listFavoriteMods, listFavoriteModRecords, toggleFavoriteMod, rememberModFileNames, setModPinned, setWantedResourcePacks, rememberResourcePackFileNames, setResourcePackPinned, setWantedShaders, rememberShaderFileNames,
  listInstances, listResourcePackInstances, instanceKey, listBuilds, getActiveBuild, createBuild, renameBuild, setBuildFolder, setFolderChecker, takenFolders, setBuildMeta, removeBuildRecord, setActiveBuild, toggleFavoriteVersion, listAccounts, selectAccount, removeAccount,
  listModpackProfiles, saveModpackProfile, renameModpackProfile, deleteModpackProfile,
  listResourcePackProfiles, saveResourcePackProfile, renameResourcePackProfile, deleteResourcePackProfile,
  getCommunityBuildUrl, setCommunityBuildUrl,
  getMeteorClientVersion, setMeteorClientVersion,
  getFabricLoaderVersion, setFabricLoaderVersion,
  getNeoforgeVersion, setNeoforgeVersion,
  toggleFavoriteScreenshot, removeFavoriteScreenshot,
  getCustomSkinLoaderEnabled, setCustomSkinLoaderEnabled,
  addPlaytime, getPlaytime, recordLaunch, getLaunchStats, getInstanceBackground, setInstanceBackground,
  getCurseforgeApiKey, setCurseforgeApiKey,
  getLastSeenVersion, setLastSeenVersion,
  getLaunchSettings, setLaunchSettings,
  listGamePresets, saveGamePreset, deleteGamePreset, getServerPreset, saveServerPreset, deleteServerPreset,
  getAppearance, setAppearance, getAppearancePresets, saveAppearancePreset, deleteAppearancePreset,
  getGradient, setGradient, getInstanceAccent, setInstanceAccent, listInstanceAccents
} = require('./src/store');
const PFCGradient = require('./src/gradientConfig');
const { CHANGELOG } = require('./src/changelog');
const auth = require('./src/auth');
const msAuth = require('./src/msAuth');
const versions = require('./src/versions');
const modrinth = require('./src/modrinth');
const curseforge = require('./src/curseforge');
const modManager = require('./src/modManager');
const settingsTransfer = require('./src/settingsTransfer');
const { createSkinLibrary, createPreviousSkinSlot, readPngSize, isSkinSize } = require('./src/skinLibrary');
const { createElybySkinApi } = require('./src/elybySkinApi');
const backupManager = require('./src/backupManager');
const worldManager = require('./src/worldManager');
const buildBackup = require('./src/buildBackup');
const resourcePackManager = require('./src/resourcePackManager');
const resourcePackProfiles = require('./src/resourcePackProfiles');
const shaderManager = require('./src/shaderManager');
const meteorClient = require('./src/meteorClient');
const identifyLocal = require('./src/identifyLocal');
const jarMetadata = require('./src/jarMetadata');
const launcher = require('./src/launcher');
const fabric = require('./src/fabric');
const neoforge = require('./src/neoforge');
const instanceSettings = require('./src/instanceSettings');
const discordRPC = require('./src/discordRPC');
const serverPing = require('./src/serverPing');
const { exportInstance } = require('./src/exportInstance');
const { importInstanceFromZip, importInstanceFromUrl } = require('./src/importInstance');
const { exportMrpack, importMrpack, readMrpackIndex } = require('./src/mrpack');
const { importCurseforgeModpack } = require('./src/curseforgeModpack');
const { listCrashReports, getCrashDir } = require('./src/crashReporter');
const screenshotManager = require('./src/screenshotManager');
const javaManager = require('./src/javaManager');
const modIndex = require('./src/modIndex');
const buildTools = require('./src/buildTools');
const modGraph = require('./src/modGraph');
const crashAnalyzer = require('./src/crashAnalyzer');
const resourceMetrics = require('./src/resourceMetrics');
const storageAnalyzer = require('./src/storageAnalyzer');
const modConflictDetector = require('./src/modConflictDetector');
const { createGamingActivityStore } = require('./src/gamingActivity');
const { DownloadManager } = require('./src/downloadManager');
const { sanitizeQuickPlay } = require('./src/quickPlay');
const { uploadLog } = require('./src/logShare');
const serverList = require('./src/serverList');
const launchSettings = require('./src/launchSettings');
const buildShare = require('./src/buildShare');
const launcherImport = require('./src/launcherImport');
const buildFolder = require('./src/buildFolder');
const { exec } = require('child_process');

// Gaming Activity хранится отдельно от основного конфига: история может расти,
// а её повреждение не должно затрагивать аккаунты и настройки лаунчера.
const gamingActivity = createGamingActivityStore(path.join(app.getPath('userData'), 'gaming-activity.json'));
gamingActivity.recoverInterruptedSessions();
app.on('before-quit', () => {
  try { gamingActivity.touchRunningSessions(); }
  catch (err) { console.warn('[activity] не удалось сохранить сессию перед выходом:', err.message); }
});

let mainWindow;
let downloadManager = null;
let notificationWindows = [];
let tray;
let isQuitting = false;

// Раньше любая необработанная ошибка (например, при записи crash-репорта
// после вылета игры из-за битого мода, когда окно уже закрыто) убивала
// весь процесс лаунчера. Теперь такие ошибки просто логируются и не рушат приложение.
process.on('uncaughtException', (err) => {
  console.error('[main] необработанная ошибка:', err);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:error', { message: err?.message || String(err) });
    }
  } catch {
    // если и это не удалось — просто игнорируем, лишь бы процесс не упал
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] необработанный reject:', reason);
});

// наружу отдаём только обычные веб-ссылки: file:, javascript: и прочие схемы
// из интерфейса открывать нельзя
function isSafeExternalUrl(url) {
  try {
    const { protocol } = new URL(String(url));
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// два лаунчера одновременно портят общий конфиг — второй запуск просто поднимает первое окно
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// Безопасная отправка в окно — не падает, если окно уже закрыто/уничтожено
function sendToWindow(channel, payload) {
  try {
    downloadManager?.reportEvent(channel, payload);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (err) {
    console.error(`[main] не удалось отправить в окно (${channel}):`, err.message);
  }
}

downloadManager = new DownloadManager({
  historyFile: path.join(app.getPath('userData'), 'download-history.json'),
  onUpdate: snapshot => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('downloads:updated', snapshot);
      }
    } catch (err) {
      console.warn('[downloads] не удалось отправить состояние в окно:', err.message);
    }
  }
});

app.on('before-quit', () => {
  try { downloadManager?.flush(); }
  catch (err) { console.warn('[downloads] не удалось сохранить историю перед выходом:', err.message); }
});

function describeDownloadTask(channel, args) {
  const payload = args[1] && typeof args[1] === 'object' ? args[1] : {};
  const mcVersion = payload.mcVersion || '';
  const loader = payload.loader || '';
  const build = [mcVersion, loader].filter(Boolean).join(' · ');
  const buildSubtitle = build ? `Сборка: ${build}` : '';
  const definitions = {
    'game:launch': { type: 'minecraft', title: 'Подготовка Minecraft', subtitle: buildSubtitle || 'Проверка и загрузка игровых файлов', cancellable: false, retryable: false },
    'mods:reinstall': { type: 'mods', title: 'Загрузка модов', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'mods:updateOne': { type: 'mods', title: `Обновление мода${payload.title ? `: ${payload.title}` : ''}`, subtitle: buildSubtitle, cancellable: true, retryable: true },
    'mods:addSpecificVersion': { type: 'mods', title: `Установка мода${payload.title ? `: ${payload.title}` : ''}`, subtitle: buildSubtitle, cancellable: true, retryable: true },
    'mods:installMissingDependency': { type: 'mods', title: 'Установка зависимости мода', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'resourcepacks:reinstall': { type: 'resourcepacks', title: 'Загрузка ресурспаков', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'resourcepacks:updateOne': { type: 'resourcepacks', title: `Обновление ресурспака${payload.title ? `: ${payload.title}` : ''}`, subtitle: buildSubtitle, cancellable: true, retryable: true },
    'resourcepacks:addSpecificVersion': { type: 'resourcepacks', title: `Установка ресурспака${payload.title ? `: ${payload.title}` : ''}`, subtitle: buildSubtitle, cancellable: true, retryable: true },
    'shaders:reinstall': { type: 'shaders', title: 'Загрузка шейдеров', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'meteor:install': { type: 'mods', title: 'Установка Meteor Client', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'java:install': { type: 'java', title: 'Установка Java', subtitle: `Java ${String(args[1] || '')} · среда выполнения Minecraft`, cancellable: true, retryable: true },
    'game:verifyAndFix': { type: 'repair', title: 'Проверка и восстановление сборки', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'share:install': { type: 'build', title: `Установка сборки${payload.name ? `: ${payload.name}` : ''}`, subtitle: 'Установка из кода сборки', cancellable: true, retryable: true },
    'community:updateBuild': { type: 'build', title: 'Обновление сборки сообщества', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'builds:importMrpack': { type: 'build', title: 'Импорт модпака Modrinth', subtitle: 'Загрузка файлов модпака и зависимостей', cancellable: true, retryable: false, cancelOnNull: true },
    'mrpack:importFromFile': { type: 'build', title: 'Импорт модпака Modrinth', subtitle: buildSubtitle, cancellable: true, retryable: false, cancelOnNull: true },
    'mrpack:importFromPath': { type: 'build', title: 'Импорт модпака Modrinth', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'instance:importFromUrl': { type: 'build', title: 'Загрузка сборки по ссылке', subtitle: buildSubtitle, cancellable: true, retryable: true },
    'curseforgeModpack:importFromFile': { type: 'build', title: 'Импорт модпака CurseForge', subtitle: 'Загрузка модов и зависимостей', cancellable: true, retryable: false, cancelOnNull: true }
  };
  const definition = definitions[channel];
  return definition ? { ...definition, build } : null;
}

// Оборачиваем ipcMain.handle целиком: ошибки логируются здесь же, а длительные
// операции загрузки автоматически попадают в единый Download Manager.
const _originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  _originalIpcHandle(channel, async (...args) => {
    const taskMeta = describeDownloadTask(channel, args);
    const invoke = (eventArg = args[0]) => listener(eventArg, ...args.slice(1));
    try {
      if (taskMeta && downloadManager) {
        return await downloadManager.run(taskMeta, () => invoke(args[0]), () => invoke(null));
      }
      return await invoke(args[0]);
    } catch (err) {
      console.error(`[ipc:${channel}] ошибка:`, err);
      const forwarded = new Error(err?.message || 'Неизвестная ошибка');
      if (err?.code) forwarded.code = err.code;
      throw forwarded;
    }
  });
};

ipcMain.handle('downloads:list', async () => downloadManager.list());
ipcMain.handle('downloads:cancel', async (e, id) => ({ ok: downloadManager.cancel(id) }));
ipcMain.handle('downloads:retry', async (e, id) => downloadManager.retry(id));
ipcMain.handle('downloads:clearHistory', async () => downloadManager.clearHistory());

function repositionNotificationWindows() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const winWidth = 360;
  const winHeight = 112;
  const gap = 10;

  notificationWindows = notificationWindows.filter((entry) => entry.win && !entry.win.isDestroyed());
  notificationWindows.forEach((entry, index) => {
    const y = area.y + area.height - winHeight - 16 - index * (winHeight + gap);
    entry.win.setPosition(area.x + area.width - winWidth - 16, y, false);
  });
}

function notify(title, body, type = 'info') {
  try {
    if (!store.get('notificationsEnabled') || store.get('notificationMode', 'internal') !== 'external') return;

    let theme = store.get('theme') || 'green';
    let themeCustom = store.get('themeCustom') || '';
    // окно уведомления рисует один цвет, поэтому для градиента берём средний
    if (theme === 'gradient') {
      theme = 'custom';
      themeCustom = PFCGradient.buildCss(getGradient()).accent;
    }

    const data = {
      title,
      body,
      type,
      icon: getCurrentIconPath(),
      theme,
      themeCustom,
      themeMode: store.get('themeMode') || 'dark'
    };

    const win = new BrowserWindow({
      width: 360,
      height: 112,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'notification-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    const entry = { win, timer: null };
    notificationWindows.push(entry);
    repositionNotificationWindows();

    win.loadFile(path.join(__dirname, 'renderer', 'system-notification.html'));
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('notification-data', data);
      win.showInactive();
    });

    entry.timer = setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, 5200);

    win.on('closed', () => {
      if (entry.timer) clearTimeout(entry.timer);
      notificationWindows = notificationWindows.filter((item) => item !== entry);
      repositionNotificationWindows();
    });

    // Не даём уведомлениям бесконечно накапливаться.
    if (notificationWindows.length > 5) {
      const oldest = notificationWindows.shift();
      if (oldest?.timer) clearTimeout(oldest.timer);
      if (oldest?.win && !oldest.win.isDestroyed()) oldest.win.close();
    }
    repositionNotificationWindows();
  } catch (err) {
    console.error('[main] ошибка кастомного уведомления:', err.message);
  }
}
function getGameDir() {
  let dir = store.get('gameDir');
  if (!dir) {
    dir = path.join(app.getPath('appData'), 'PFCLauncher', 'game');
    store.set('gameDir', dir);
  }
  return dir;
}

function getCurrentIconPath() {
  const custom = store.get('customIconPath');
  if (custom && fs.existsSync(custom)) return custom;
  return path.join(__dirname, 'build', 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: Math.max(store.get('launcherWidth', 1280), MIN_LAUNCHER_WIDTH),
    height: Math.max(store.get('launcherHeight', 800), MIN_LAUNCHER_HEIGHT),
    minWidth: MIN_LAUNCHER_WIDTH,
    minHeight: MIN_LAUNCHER_HEIGHT,
    resizable: true,
    title: 'FCore Launcher',
    icon: getCurrentIconPath(),
    frame: false,
    backgroundColor: '#080B18',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // интерфейс не должен уходить на внешние страницы: ссылки открываем в браузере
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  // кастомный тайтлбар: раз системной рамки больше нет, рендерер сам рисует
  // кнопки свернуть/развернуть/закрыть и должен знать, в каком состоянии окно
  mainWindow.on('maximize', () => sendToWindow('window:maximizedChange', true));
  mainWindow.on('unmaximize', () => sendToWindow('window:maximizedChange', false));

  // сравниваем версию, которую пользователь последний раз видел, с текущей —
  // если выросла, после загрузки интерфейса покажем попап "Что нового".
  // Первый запуск (lastSeenVersion ещё пустой) ничего не показываем — это не апдейт
  mainWindow.webContents.once('did-finish-load', () => {
    const currentVersion = app.getVersion();
    const lastSeenVersion = getLastSeenVersion();

    if (lastSeenVersion && lastSeenVersion !== currentVersion) {
      const entry = CHANGELOG.find(c => c.version === currentVersion);
      if (entry) sendToWindow('app:whatsNew', entry);
    }
    setLastSeenVersion(currentVersion);
  });

  // при включённом дебаг-режиме DevTools открываются ниже, в app.whenReady —
  // раньше они открывались всегда, даже без дебаг-режима, и грузили процессор впустую

  // при включённой опции "свернуть в трей" крестик прячет окно, а не закрывает лаунчер —
  // так можно быстро запустить игру из трея, не открывая окно заново
  mainWindow.on('close', event => {
    if (!isQuitting && store.get('minimizeToTray')) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // если рендерер (сама страница интерфейса) вылетел или завис — раньше лаунчер
  // просто оставался пустым чёрным окном, теперь пересоздаём окно с нуля.
  // Игра, если уже запущена, идёт отдельным процессом и это не затрагивает
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[main] рендерер упал:', details.reason);
    if (isQuitting) return;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    } catch {
      // окно уже могло быть в процессе уничтожения — не страшно
    }
    mainWindow = null;
    createWindow();
    notify('FCore Launcher перезапущен', `Интерфейс неожиданно завершился (${details.reason}) и был перезапущен`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[main] окно перестало отвечать');
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(getCurrentIconPath());
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('FCore Launcher');
  refreshTrayMenu();

  tray.on('double-click', () => {
    mainWindow.show();
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  const mcVersion = store.get('quickLaunchVersion') || store.get('lastVersion');
  const loader = store.get('quickLaunchLoader') || store.get('lastLoader');

  const menu = Menu.buildFromTemplate([
    {
      label: mcVersion ? `Играть (${mcVersion} · ${loader})` : 'Играть',
      enabled: !!mcVersion,
      click: () => quickLaunchFromTray(mcVersion, loader)
    },
    { label: 'Открыть FCore Launcher', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// общая логика обновления токена выбранного аккаунта — раньше жила только
// внутри performLaunch и срабатывала лишь перед запуском игры; вынесена сюда,
// чтобы дополнительно гонять её по таймеру в фоне (см. ensureTokenRefreshTimer)
async function refreshSelectedAccountTokenIfNeeded() {
  const account = getSelectedAccount();
  if (!account) return;

  if (account?.mclcAuth?.meta?.type === 'msa' && account.mclcAuth.meta.refresh && !msAuth.isMicrosoftTokenValid(account.mclcAuth)) {
    try {
      account.mclcAuth = await msAuth.refreshMicrosoft(account.mclcAuth.meta.refresh);
      saveSelectedAccount(account);
    } catch (e) {
      console.warn("Не удалось обновить токен Microsoft:", e.message);
    }
  } else if (account?.mclcAuth?.meta?.refresh_token && !isElybyTokenValid(account.mclcAuth)) {
    try {
      const token = await auth.refreshToken(account.mclcAuth.meta.refresh_token);
      account.mclcAuth.access_token = token.access_token;
      account.mclcAuth.meta.refresh_token = token.refresh_token;
      account.mclcAuth.meta.expires_in = token.expires_in;
      account.mclcAuth.meta.obtainedAt = Date.now();
      saveSelectedAccount(account);
    } catch (e) {
      console.warn("Не удалось обновить токен:", e.message);
    }
  }
}

// каждые 5 минут по-тихому проверяем, не пора ли обновить токен Ely.by/Microsoft —
// раньше это происходило только перед запуском игры, и если токен протухал,
// пока лаунчер просто висел открытым (стоял в списке модов, читал чейнджлог и т.п.),
// человек об этом узнавал только в момент нажатия "Играть"
let tokenRefreshTimer = null;
function ensureTokenRefreshTimer() {
  if (tokenRefreshTimer) return;
  tokenRefreshTimer = setInterval(() => {
    refreshSelectedAccountTokenIfNeeded().catch(e => console.warn('[token-refresh]', e.message));
  }, 5 * 60 * 1000);
}

// один и тот же путь запуска что из UI, что из трея без открытия окна
let launchInProgress = false;

function launchCommandContext(root, mcVersion, loader, userEnv) {
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  return {
    cwd: instanceDir,
    env: {
      ...process.env,
      ...userEnv,
      FCORE_MC_VERSION: String(mcVersion),
      FCORE_LOADER: String(loader),
      FCORE_INSTANCE_DIR: instanceDir
    }
  };
}

function runLaunchCommand(command, context, label) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(context.cwd, { recursive: true });
    exec(command, { cwd: context.cwd, env: context.env, timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve();
      const tail = String(stderr || stdout || err.message).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
      reject(new Error(err.killed ? `Команда ${label} не завершилась за 60 секунд` : `Команда ${label} завершилась с ошибкой: ${tail}`));
    });
  });
}

async function countLaunchContent(mcVersion, loader) {
  const dir = modManager.getInstanceDir(getGameDir(), mcVersion, loader);
  const list = sub => { try { return fs.readdirSync(path.join(dir, sub)); } catch { return []; } };
  return {
    mods: list('mods').filter(n => /\.jar$/i.test(n)).length,
    shaders: list('shaderpacks').length > 0
  };
}

async function recommendMemoryFor(mcVersion, loader) {
  const { mods, shaders } = await countLaunchContent(mcVersion, loader);
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  return { ...launchSettings.recommendMemory({ totalMb, mods, shaders }), totalMb, mods, shaders };
}

async function performLaunch(mcVersion, loader, quickPlay) {
  if (launchInProgress) throw new Error('Игра уже запускается');
  launchInProgress = true;
  try {
    return await performLaunchInner(mcVersion, loader, quickPlay);
  } finally {
    launchInProgress = false;
  }
}

async function performLaunchInner(mcVersion, loader, quickPlay) {
  await refreshSelectedAccountTokenIfNeeded();
  const account = getSelectedAccount();
  if (account && !account.mclcAuth) {
    throw new Error('Не удалось расшифровать данные аккаунта (конфиг перенесён с другого компьютера?). Войдите в аккаунт заново.');
  }

  const authData = account ? account.mclcAuth : {
    access_token: 'offline', name: 'Player', uuid: '00000000-0000-0000-0000-000000000000',
    client_token: 'offline', user_properties: '{}'
  };

  const root = getGameDir();
  const launchCfg = getLaunchSettings(mcVersion, loader);
  const recommendation = launchCfg.memoryMode === 'auto' ? await recommendMemoryFor(mcVersion, loader) : null;
  const resolved = launchSettings.resolveLaunch({
    global: {
      memoryMin: store.get('memoryMin'),
      memoryMax: store.get('memoryMax'),
      jvmArgs: store.get('jvmArgs'),
      javaPath: store.get('javaPath')
    },
    settings: launchCfg,
    recommendation
  });
  const memory = resolved.memory;
  const commandContext = launchCommandContext(root, mcVersion, loader, resolved.env);
  if (resolved.preCommand) {
    await runLaunchCommand(resolved.preCommand, commandContext, 'перед запуском');
  }
  const startedAt = Date.now();

  discordRPC.setLaunching(mcVersion, loader);
  store.set('quickLaunchVersion', mcVersion);
  store.set('quickLaunchLoader', loader);
  refreshTrayMenu();

  let serverPingInterval = null;
  const stopServerPing = () => {
    if (serverPingInterval) {
      clearInterval(serverPingInterval);
      serverPingInterval = null;
    }
  };

  const updateServerRPC = async (host, port) => {
    try {
      const info = await serverPing.pingServer(host, port);
      discordRPC.setPlayingServer(mcVersion, loader, startedAt, host, info.online, info.max);
    } catch {
      discordRPC.setPlayingServer(mcVersion, loader, startedAt, host, null, null);
    }
  };

  let result;
  let gamingActivitySessionId = null;
  let gamingActivityHeartbeat = null;
  try {
    result = await launcher.launchGame({
      root,
      mcVersion,
      loader,
      loaderVersion: loader === 'fabric'
        ? getFabricLoaderVersion(mcVersion, loader)
        : loader === 'neoforge'
          ? getNeoforgeVersion(mcVersion, loader)
          : null,
      logsEnabled: store.get('gameLogsEnabled', true),
      mclcAuth: authData,
      memory,
      javaPathOverride: resolved.javaPath,
      jvmArgs: resolved.jvmArgs,
      env: resolved.env,
      window: { width: store.get('gameWidth'), height: store.get('gameHeight'), fullscreen: store.get('fullscreen') },
      gpuPreference: store.get('gpuPreference'),
      quickPlay: sanitizeQuickPlay(quickPlay),
      onEvent: progress => {
        sendToWindow('game:progress', progress);
        if (progress.stage === 'game-started' && !gamingActivitySessionId) {
          try {
            const activeBuild = getActiveBuild();
            const matchedBuild = activeBuild && activeBuild.mcVersion === mcVersion && activeBuild.loader === loader
              ? activeBuild : null;
            gamingActivitySessionId = gamingActivity.recordStart({
              mcVersion, loader,
              buildId: matchedBuild?.id || null,
              buildName: matchedBuild?.name || null
            });
            const activitySessionId = gamingActivitySessionId;
            gamingActivityHeartbeat = setInterval(() => {
              try {
                gamingActivity.touchSession(activitySessionId);
                sendToWindow('gamingActivity:updated');
              } catch (err) { console.warn('[activity] не удалось обновить сессию:', err.message); }
            }, 15000);
            // Снимок модов читается в фоне и не задерживает открытие Minecraft.
            modIndex.scanModsDir(modManager.getModsDir(root, mcVersion, loader), { loader })
              .then(files => {
                const mods = files.filter(file => file.enabled && !file.error).flatMap(file =>
                  (file.mods || []).map(mod => ({
                    id: mod.id || file.fileName,
                    name: mod.name || mod.id || file.fileName,
                    version: mod.version || null
                  }))
                );
                gamingActivity.setSessionMods(activitySessionId, mods);
                sendToWindow('gamingActivity:updated');
              })
              .catch(err => console.warn('[activity] не удалось сохранить список модов:', err.message));
            sendToWindow('gamingActivity:updated');
          } catch (err) {
            console.warn('[activity] не удалось записать начало сессии:', err.message);
          }
        }
        if (progress.stage === 'server-connect') {
          stopServerPing();
          updateServerRPC(progress.host, progress.port);
          serverPingInterval = setInterval(() => updateServerRPC(progress.host, progress.port), 30000);
        }
        if (progress.stage === 'server-disconnect') {
          stopServerPing();
          discordRPC.setPlaying(mcVersion, loader, startedAt);
        }
        if (progress.stage === 'closed') {
          if (gamingActivitySessionId) {
            if (gamingActivityHeartbeat) clearInterval(gamingActivityHeartbeat);
            gamingActivityHeartbeat = null;
            try {
              gamingActivity.finishSession(gamingActivitySessionId, {
                durationMs: progress.playtimeMs || 0,
                exitCode: progress.code
              });
            } catch (err) {
              console.warn('[activity] не удалось завершить сессию:', err.message);
            }
            gamingActivitySessionId = null;
          }
          if (resolved.postCommand) {
            runLaunchCommand(resolved.postCommand, { ...commandContext, env: { ...commandContext.env, FCORE_EXIT_CODE: String(progress.code ?? '') } }, 'после закрытия').catch(err => notify('Команда после закрытия не выполнена', err.message));
          }
          stopServerPing();
          discordRPC.setMenu();
          if (progress.playtimeMs) {
            addPlaytime(mcVersion, loader, progress.playtimeMs);
            sendToWindow('game:playtimeUpdated', { mcVersion, loader, totalMs: getPlaytime(mcVersion, loader) });
          }
          sendToWindow('gamingActivity:updated');
        }
        if (progress.stage === 'crash') notify('Игра завершилась с ошибкой', `Код ${progress.code}. Отчёт сохранён в crash-reports.`);
      }
    });
  } catch (err) {
    // запуск сорвался до старта игры — не оставляем в Discord «Запускается…»
    stopServerPing();
    if (gamingActivityHeartbeat) clearInterval(gamingActivityHeartbeat);
    gamingActivityHeartbeat = null;
    if (gamingActivitySessionId) {
      try {
        gamingActivity.finishSession(gamingActivitySessionId, { durationMs: 0, exitCode: 1 });
        sendToWindow('gamingActivity:updated');
      } catch (activityErr) {
        console.warn('[activity] не удалось закрыть неудачный запуск:', activityErr.message);
      }
      gamingActivitySessionId = null;
    }
    discordRPC.setMenu();
    throw err;
  }

  recordLaunch(mcVersion, loader);
  discordRPC.setPlaying(mcVersion, loader, startedAt);
  notify('FCore Launcher', `Minecraft ${mcVersion} запущен`);

  const behavior = store.get('afterLaunch');
  if (behavior === 'close' && !resolved.postCommand) { isQuitting = true; app.quit(); }
  else if (behavior === 'minimize' && mainWindow) mainWindow.minimize();

  return result;
}

async function quickLaunchFromTray(mcVersion, loader) {
  if (!mcVersion) return;
  try {
    await performLaunch(mcVersion, loader);
  } catch (err) {
    notify('Не удалось запустить игру', err.message);
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  migrateAccountsEncryption();
  createWindow();
  try { syncAllBuildFolders(); } catch (err) { console.error('[builds] синхронизация папок:', err); }
  createTray();
  if (store.get('debugMode')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  ensureTokenRefreshTimer();

  // Автоматическая проверка совместимых обновлений раз в сутки. Отправляем
  // уведомление только о новой версии, которую ещё не показывали пользователю.
  const runAutomaticModCompatibilityCheck = async () => {
    if (store.get('modCompatibilityAutoCheck', true) === false) return;
    const lastCheck = Number(store.get('modCompatibilityLastCheck', 0)) || 0;
    if (Date.now() - lastCheck < 24 * 60 * 60 * 1000) return;
    const builds = listBuilds();
    const seen = store.get('modCompatibilitySeen') || {};
    const freshSeen = { ...seen };
    for (const build of builds) {
      try {
        const report = await checkModCompatibilityForBuild(build.mcVersion, build.loader, `build-${build.id}`);
        const updates = report.results.filter(item => item.status === 'update');
        const key = `build-${build.id}`;
        const newlyAvailable = updates.filter(item => {
          const itemKey = `${key}:${item.source}:${item.projectId}`;
          if (freshSeen[itemKey] === item.latestFileName) return false;
          freshSeen[itemKey] = item.latestFileName;
          return true;
        });
        if (newlyAvailable.length) {
          const names = newlyAvailable.slice(0, 4).map(item => item.title).join(', ');
          const suffix = newlyAvailable.length > 4 ? ` и ещё ${newlyAvailable.length - 4}` : '';
          const message = `${newlyAvailable.length} совместимых обновлений: ${names}${suffix}`;
          notify(`Обновления модов: ${build.name}`, message);
          sendToWindow('mods:compatibilityUpdates', { buildName: build.name, count: newlyAvailable.length, names: newlyAvailable.map(item => item.title) });
        }
      } catch (error) { console.warn('[mod watcher] check failed:', error.message); }
    }
    store.set('modCompatibilitySeen', freshSeen);
    store.set('modCompatibilityLastCheck', Date.now());
  };
  setTimeout(runAutomaticModCompatibilityCheck, 15000);
  setInterval(runAutomaticModCompatibilityCheck, 24 * 60 * 60 * 1000);

  // Discord RPC может подключаться заметное время (или упираться в таймаут, если
  // Discord не запущен) — раньше из-за await тут стояла в очереди и проверка обновлений
  discordRPC.init()
    .then(() => discordRPC.setMenu())
    .catch(err => console.warn('[discord] init:', err?.message || err));
  // небольшая задержка, чтобы окно успело отрисоваться до диалогов обновления
  setTimeout(() => {
    setupAutoUpdater().checkForUpdates().catch(err => console.error('[updater] проверка не удалась:', err));
  }, 3000);
});

// --- Автообновление (GitHub Releases) ---
// Никаких системных dialog.showMessageBox — всё обновление происходит в фоне
// молча, пользователь видит только своё окошко лаунчера, когда апдейт реально
// готов к установке (или маленький тост, если что-то пошло не так).
let autoUpdaterConfigured = false;
function setupAutoUpdater() {
  const autoUpdater = getAutoUpdater();
  if (autoUpdaterConfigured) return autoUpdater;
  autoUpdaterConfigured = true;

  autoUpdater.on('update-available', (info) => {
    sendToWindow('update:status', { state: 'downloading', version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToWindow('update:progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToWindow('update:status', { state: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] ошибка:', err);
    sendToWindow('update:status', { state: 'error', message: err.message });
  });

  return autoUpdater;
}

ipcMain.handle('updater:installNow', () => {
  isQuitting = true;
  getAutoUpdater().quitAndInstall();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  discordRPC.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---

// раньше код показывался в нативном dialog.showMessageBox — его нельзя было
// скопировать одним кликом, и он блокировал процесс до нажатия "ОК", из-за чего
// поллинг стартовал только после закрытия окна. Теперь код летит в рендерер
// (там своя модалка с кнопкой "Скопировать"), а поллинг идёт сразу, и вход
// можно отменить в любой момент.
let elybyCancelToken = null;

ipcMain.handle("auth:elyby-start", async () => {

    const device = await auth.requestDeviceCode();

    sendToWindow('auth:elyby-device-code', {
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        expiresIn: device.expires_in
    });

    shell.openExternal(device.verification_uri);

    elybyCancelToken = { cancelled: false };
    const myToken = elybyCancelToken;

    let token;
    try {
        token = await auth.pollDeviceCode(device, myToken);
    } catch (err) {
        if (err.message === '__cancelled__') {
            sendToWindow('auth:elyby-device-code-done', {});
            return null;
        }
        // модалку тут не закрываем — рендерер сам покажет текст ошибки в ней
        // на пару секунд и закроет её сам (см. catch в chooseElybyBtn)
        throw err;
    }

    const profile =
        await auth.fetchProfile(
            token.access_token
        );
    const mclcAuth = {
        access_token: token.access_token,
        client_token: crypto.randomUUID(),
        uuid: profile.id,
        name: profile.name,
        user_properties: "{}",
        meta: {
            type: "elyby",
            refresh_token: token.refresh_token,
            expires_in: token.expires_in,
            obtainedAt: Date.now()
        }
    };

    const accountProfile = {
        uuid: profile.id,
        name: profile.name,
        type: "elyby"
    };
    addAccount(
        accountProfile,
        mclcAuth
    );

    sendToWindow('auth:elyby-device-code-done', {});
    return accountProfile;
});

ipcMain.handle('auth:elyby-cancel', async () => {
    if (elybyCancelToken) elybyCancelToken.cancelled = true;
});

ipcMain.handle('auth:login', async (event, username) => {
  const result = await auth.loginOffline(username);
  addAccount(result.profile, result.mclcAuth); // Сохраняем в список
  return result.profile;
});

ipcMain.handle("auth:current", async () => {

    const account = getSelectedAccount();

    return account
        ? account.profile
        : { name: "Player" };

});

// --- мультиаккаунты ---

ipcMain.handle('accounts:list', async () => listAccounts());

ipcMain.handle('accounts:select', async (e, index) => {
  const profile = selectAccount(index);
  discordRPC.setMenu();
  return profile;
});

ipcMain.handle('accounts:remove', async (e, index) => removeAccount(index));

ipcMain.handle('auth:microsoft-start', async () => {
  const mclcAuth = await msAuth.loginMicrosoft();
  const profile = { uuid: mclcAuth.uuid, name: mclcAuth.name, type: 'microsoft' };
  addAccount(profile, mclcAuth);
  return profile;
});

// --- данные скина аккаунта ---
// Mojang отдаёт ссылки на текстуры по http://textures.minecraft.net, а CSP интерфейса
// пускает только https — переписываем схему (сервер http и https отдаёт одинаково)
function toHttps(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : url;
}

async function getMicrosoftSkinInfo(account, index) {
  if (!account?.mclcAuth?.access_token) return null;

  let token = account.mclcAuth.access_token;
  if (account.mclcAuth?.meta?.type === 'msa' && account.mclcAuth.meta.refresh && !msAuth.isMicrosoftTokenValid(account.mclcAuth)) {
    try {
      account.mclcAuth = await msAuth.refreshMicrosoft(account.mclcAuth.meta.refresh);
      saveAccountAt(index, account);
      token = account.mclcAuth.access_token;
    } catch (err) {
      console.warn('Не удалось обновить Microsoft-токен для получения скина:', err.message);
    }
  }

  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Minecraft profile API: ${res.status}`);
  const profile = await res.json();
  const skin = Array.isArray(profile.skins) ? profile.skins[0] : null;
  const cape = Array.isArray(profile.capes) ? profile.capes[0] : null;
  return {
    type: 'microsoft',
    name: profile.name || account.profile.name,
    uuid: profile.id || account.profile.uuid,
    skinUrl: toHttps(skin?.url) || null,
    capeUrl: toHttps(cape?.url) || null,
    variant: skin?.variant || null
  };
}

// Resolve Ely.by textures before assigning an image URL. Missing skins are
// represented as empty metadata (204), not as browser-level 404 image requests.
const elybySkinApi = createElybySkinApi({ fetchImpl: (...args) => fetch(...args) });
const getElybyTextureInfo = elybySkinApi.getTextureInfo;

async function fetchAccountSkinInfo(account, index) {
  if (!account?.profile) return null;
  if (account.profile.type === 'microsoft') {
    try { return await getMicrosoftSkinInfo(account, index); }
    catch (err) {
      console.warn('Не удалось получить скин Microsoft:', err.message);
      return { type: 'microsoft', name: account.profile.name, uuid: account.profile.uuid, skinUrl: null, capeUrl: null };
    }
  }
  if (account.profile.type === 'elyby') {
    return getElybyTextureInfo(account.profile.name, account.profile.uuid);
  }
  return { type: 'offline', name: account.profile.name, uuid: account.profile.uuid, skinUrl: null, capeUrl: null };
}

// Запрос в Minecraft Profile API на каждый аккаунт при каждой перерисовке списка
// делал окно аккаунтов медленным, поэтому держим ответы в памяти на пару минут.
const SKIN_INFO_TTL = 2 * 60 * 1000;
const skinInfoCache = new Map();

function getAccountSkinInfo(account, index, force = false) {
  if (!account?.profile) return Promise.resolve(null);
  const key = `${account.profile.type}:${account.profile.uuid || account.profile.name}`;
  const hit = skinInfoCache.get(key);
  if (!force && hit && Date.now() - hit.at < SKIN_INFO_TTL) return hit.promise;

  const promise = fetchAccountSkinInfo(account, index);
  skinInfoCache.set(key, { at: Date.now(), promise });
  promise.then(info => {
    // неудачный ответ не запоминаем, чтобы следующая попытка пошла в сеть
    if (!info || (info.type === 'microsoft' && !info.skinUrl)) skinInfoCache.delete(key);
  }, () => skinInfoCache.delete(key));
  return promise;
}

ipcMain.handle('account:getSkinInfo', async () => {
  const index = store.get('selectedAccountIndex') || 0;
  return getAccountSkinInfo(getSelectedAccount(), index);
});
ipcMain.handle('account:getSkinInfoByIndex', async (e, index) => {
  return getAccountSkinInfo(getAccountAt(index), index);
});
ipcMain.handle('skins:lookupElyby', async (_e, name) => {
  return getElybyTextureInfo(name);
});

// --- смена скина ---
// У Microsoft-аккаунтов есть официальный, задокументированный Mojang API для загрузки скина —
// делаем это прямо в лаунчере. У Ely.by такого публичного API нет (только чтение скинов),
// загрузка возможна только через их сайт, поэтому для Ely.by просто открываем страницу в браузере.

ipcMain.handle('account:pickSkinFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери файл скина (PNG, 64×64)',
    filters: [{ name: 'PNG изображение', extensions: ['png'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

const MC_SERVICES = 'https://api.minecraftservices.com/minecraft/profile';

// текущий Microsoft-аккаунт со свежим токеном — токен мог протухнуть,
// обновляем тем же способом, что и перед запуском игры
async function getMicrosoftAccount() {
  const account = getSelectedAccount();
  if (!account || account.profile.type !== 'microsoft') {
    throw new Error('Эта функция доступна только для аккаунтов Microsoft');
  }
  if (!account.mclcAuth) throw new Error('Не удалось прочитать данные аккаунта — войдите заново');

  if (account.mclcAuth.meta?.type === 'msa' && account.mclcAuth.meta.refresh && !msAuth.isMicrosoftTokenValid(account.mclcAuth)) {
    try {
      account.mclcAuth = await msAuth.refreshMicrosoft(account.mclcAuth.meta.refresh);
      saveSelectedAccount(account);
    } catch (err) {
      console.warn('Не удалось обновить токен Microsoft:', err.message);
    }
  }
  return account;
}

// У api.minecraftservices.com жёсткий лимит запросов. После ответа 429 запоминаем паузу
// и не долбим сервер, пока она не пройдёт
let mojangBlockedUntil = 0;

function rateLimitError() {
  const seconds = Math.max(1, Math.ceil((mojangBlockedUntil - Date.now()) / 1000));
  return new Error(`Mojang временно ограничил количество запросов. Подождите ${seconds} с и повторите.`);
}

async function mojangRequest(account, endpoint, options = {}) {
  if (Date.now() < mojangBlockedUntil) throw rateLimitError();

  const res = await fetch(`${MC_SERVICES}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${account.mclcAuth.access_token}`, ...(options.headers || {}) }
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    mojangBlockedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000;
    throw rateLimitError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mojang отклонил запрос (${res.status}): ${text || res.statusText}`);
  }
  return res;
}

// профиль (плащи и текущий скин) меняется только когда его меняем мы, поэтому держим его
// в памяти и не запрашиваем у Mojang при каждой перерисовке настроек
const PROFILE_CACHE_MS = 5 * 60 * 1000;
let profileCache = null; // { uuid, at, capes, skin: { url, variant } | null, skinStale }

async function loadProfile(account, { freshSkin = false } = {}) {
  const uuid = account.profile.uuid;
  const usable = profileCache && profileCache.uuid === uuid
    && Date.now() - profileCache.at < PROFILE_CACHE_MS
    && !(freshSkin && profileCache.skinStale);
  if (usable) return profileCache;

  const profile = await (await mojangRequest(account, '')).json();
  const active = (profile.skins || []).find(s => s.state === 'ACTIVE');
  profileCache = {
    uuid,
    at: Date.now(),
    skinStale: false,
    capes: (profile.capes || []).map(c => ({ id: c.id, alias: c.alias, url: c.url, active: c.state === 'ACTIVE' })),
    skin: active ? { url: active.url, variant: active.variant === 'SLIM' ? 'slim' : 'classic' } : null
  };
  return profileCache;
}

// после смены скина адрес текстуры у Mojang уже другой — при следующей необходимости перечитаем
function markSkinChanged() {
  if (profileCache) profileCache.skinStale = true;
  skinInfoCache.clear();
  elybySkinApi.clearCache();
}

const skinsDir = path.join(app.getPath('userData'), 'skins');
const skinLibrary = createSkinLibrary(skinsDir);
const previousSkin = createPreviousSkinSlot(skinsDir);

// Запоминаем скин, который стоит сейчас, чтобы его можно было вернуть кнопкой «Отменить смену скина»
async function captureCurrentSkin(account) {
  const { skin } = await loadProfile(account, { freshSkin: true });
  if (!skin) return { reset: true };
  const res = await fetch(skin.url.replace(/^http:/i, 'https:'));
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return isSkinSize(readPngSize(buffer)) ? { buffer, variant: skin.variant } : null;
}

async function postSkin(account, buffer, variant) {
  const form = new FormData();
  form.append('variant', variant === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'skin.png');
  await mojangRequest(account, '/skins', { method: 'POST', body: form });
}

async function uploadMicrosoftSkin(filePath, variant) {
  const account = await getMicrosoftAccount();
  const captured = await captureCurrentSkin(account).catch(() => null);
  await postSkin(account, fs.readFileSync(filePath), variant);
  previousSkin.save(captured);
  markSkinChanged();
}

ipcMain.handle('account:changeSkinMicrosoft', async (e, { filePath, variant }) => {
  await uploadMicrosoftSkin(filePath, variant);
  // удачно загруженный скин запоминаем — к нему можно будет вернуться в один клик
  try { skinLibrary.add(filePath, variant); } catch (err) { console.warn('[skins] библиотека:', err.message); }
  notify('Скин обновлён', 'Новый скин применён к аккаунту Microsoft');
  return { dataUrl: `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}` };
});

ipcMain.handle('account:resetSkin', async () => {
  const account = await getMicrosoftAccount();
  const captured = await captureCurrentSkin(account).catch(() => null);
  await mojangRequest(account, '/skins/active', { method: 'DELETE' });
  previousSkin.save(captured);
  markSkinChanged();
  return true;
});

ipcMain.handle('skins:hasPrevious', async () => previousSkin.exists());

// Возвращает скин, который стоял до последней смены. Текущий при этом становится «предыдущим»,
// поэтому повторное нажатие вернёт всё обратно
ipcMain.handle('skins:undo', async () => {
  const previous = previousSkin.read();
  if (!previous) throw new Error('Нет предыдущего скина для возврата');

  const account = await getMicrosoftAccount();
  const captured = await captureCurrentSkin(account).catch(() => null);
  if (previous.reset) await mojangRequest(account, '/skins/active', { method: 'DELETE' });
  else await postSkin(account, previous.buffer, previous.variant);

  previousSkin.save(captured);
  markSkinChanged();
  return {
    dataUrl: previous.reset ? null : `data:image/png;base64,${previous.buffer.toString('base64')}`,
    variant: previous.variant || 'classic'
  };
});

ipcMain.handle('account:getMicrosoftProfile', async () => {
  const account = await getMicrosoftAccount();
  const { capes } = await loadProfile(account);
  return { capes };
});

ipcMain.handle('account:setCape', async (e, capeId) => {
  const account = await getMicrosoftAccount();
  if (capeId) {
    await mojangRequest(account, '/capes/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capeId: String(capeId) })
    });
  } else {
    await mojangRequest(account, '/capes/active', { method: 'DELETE' });
  }
  // обновляем кэш сами — повторный запрос профиля не нужен
  if (profileCache && profileCache.uuid === account.profile.uuid) {
    profileCache.capes = profileCache.capes.map(c => ({ ...c, active: !!capeId && c.id === String(capeId) }));
  }
  skinInfoCache.clear();
  elybySkinApi.clearCache();
  return true;
});

// --- библиотека сохранённых скинов ---
ipcMain.handle('skins:list', async () => {
  return skinLibrary.list().map(entry => ({ ...entry, dataUrl: skinLibrary.dataUrl(entry.id) }));
});

ipcMain.handle('skins:add', async (e, variant) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Добавить скин в библиотеку (PNG, 64×64)',
    filters: [{ name: 'PNG изображение', extensions: ['png'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return skinLibrary.add(result.filePaths[0], variant);
});

ipcMain.handle('skins:remove', async (e, id) => skinLibrary.remove(id));

ipcMain.handle('skins:apply', async (e, id) => {
  const file = skinLibrary.filePath(id);
  if (!file) throw new Error('Скин не найден в библиотеке');
  const entry = skinLibrary.list().find(item => item.id === id);
  await uploadMicrosoftSkin(file, entry?.variant);
  notify('Скин обновлён', 'Скин из библиотеки применён к аккаунту Microsoft');
  return true;
});

let elybySkinWindow = null;
ipcMain.handle('account:openElybySkinPage', async () => {
  if (elybySkinWindow && !elybySkinWindow.isDestroyed()) {
    elybySkinWindow.focus();
    return;
  }

  elybySkinWindow = new BrowserWindow({
    width: 480,
    height: 720,
    parent: mainWindow,
    // без modal — так можно свободно переключаться между окном лаунчера и
    // окном загрузки скина, а не залипать на одном из них
    title: 'Ely.by — загрузка скина',
    icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')),
    autoHideMenuBar: true,
    webPreferences: {
          preload: path.join(__dirname, 'renderer', 'notification-preload.js'),
          contextIsolation: true,
          nodeIntegration: false
        }
  });

  elybySkinWindow.loadURL('https://ely.by/skins/add');
  elybySkinWindow.on('closed', () => {
    elybySkinWindow = null;
    skinInfoCache.clear();
    elybySkinApi.clearCache();
    // человек мог только что залить новый скин — сразу освежаем превью,
    // не заставляя его ещё и руками тыкать куда-то в лаунчере
    sendToWindow('account:skinPageClosed', {});
  });
});

ipcMain.handle('versions:list', async () => {
  return versions.getReleaseVersions();
});

ipcMain.handle('versions:toggleFavorite', async (e, versionId) => {
  return toggleFavoriteVersion(versionId);
});

ipcMain.handle('mods:search', async (e, { query, mcVersion, loader, offset, sort, category, source }) => {
  if (source === 'curseforge') {
    return curseforge.searchMods(query, mcVersion, loader, getCurseforgeApiKey(), 20, offset || 0, sort || 'popularity');
  }
  return modrinth.searchMods(query, mcVersion, loader, 20, offset || 0, sort || 'relevance', category || '');
});

ipcMain.handle('mods:wanted', async (e, { mcVersion, loader }) => {
  return getInstance(mcVersion, loader).wantedMods;
});

async function checkModCompatibilityForBuild(mcVersion, loader, instanceKeyOverride = null) {
  const instanceRecord = instanceKeyOverride ? ((store.get('instances') || {})[instanceKeyOverride] || {}) : getInstance(mcVersion, loader);
  const wanted = instanceRecord.wantedMods || [];
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, wanted.length) }, async () => {
    while (cursor < wanted.length) {
      const item = wanted[cursor++];
      if (!item || !item.projectId || item.pinned) continue;
      const source = item.source === 'curseforge' ? 'curseforge' : 'modrinth';
      try {
        const latest = source === 'curseforge'
          ? await curseforge.getCompatibleVersion(item.projectId, mcVersion, loader, getCurseforgeApiKey())
          : await modrinth.getCompatibleVersion(item.projectId, mcVersion, loader);
        if (!latest) results.push({ projectId: item.projectId, title: item.title || item.projectId, status: 'incompatible', source });
        else if (item.lastFileName && latest.fileName !== item.lastFileName) results.push({ projectId: item.projectId, title: item.title || item.projectId, status: 'update', currentFileName: item.lastFileName, latestFileName: latest.fileName, versionNumber: latest.versionNumber, source });
        else results.push({ projectId: item.projectId, title: item.title || item.projectId, status: item.lastFileName ? 'current' : 'unknown', latestFileName: latest.fileName, versionNumber: latest.versionNumber, source });
      } catch (error) {
        results.push({ projectId: item.projectId, title: item.title || item.projectId, status: 'error', error: error.message, source });
      }
    }
  });
  await Promise.all(workers);
  return { checked: wanted.length, results };
}

ipcMain.handle('mods:watchCompatibility', async (e, { mcVersion, loader }) => {
  const report = await checkModCompatibilityForBuild(mcVersion, loader);
  store.set('modCompatibilityLastCheck', Date.now());
  const seen = store.get('modCompatibilitySeen') || {};
  for (const item of report.results) {
    if (item.status === 'update') seen[`build-${instanceKey(mcVersion, loader)}:${item.source}:${item.projectId}`] = item.latestFileName;
  }
  store.set('modCompatibilitySeen', seen);
  return report;
});

ipcMain.handle('mods:getAutoCompatibilityCheck', () => store.get('modCompatibilityAutoCheck', true) !== false);
ipcMain.handle('mods:setAutoCompatibilityCheck', (e, enabled) => {
  store.set('modCompatibilityAutoCheck', !!enabled);
  return !!enabled;
});

ipcMain.handle('mods:add', async (e, { mcVersion, loader, projectId, title, icon, source, skipDeps }) => {
  const inst = getInstance(mcVersion, loader);
  const existing = inst.wantedMods.find(m => m.projectId === projectId);
  if (!existing) {
    inst.wantedMods.push({ projectId, title, icon, source: source === 'curseforge' ? 'curseforge' : 'modrinth', ...(skipDeps ? { skipDeps: true } : {}) });
  } else if (skipDeps !== undefined) {
    // повторное добавление с другим выбором: запоминаем его
    existing.skipDeps = !!skipDeps;
  }
  setWantedMods(mcVersion, loader, inst.wantedMods);
  return inst.wantedMods;
});

// список версий мода под лоадер (без фильтра по версии MC) — для ручного выбора,
// как на самой странице мода на Modrinth
ipcMain.handle('mods:listVersions', async (e, { projectId, loader }) => {
  try {
    return { ok: true, versions: await modrinth.listVersions(projectId, loader) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// поставить конкретную выбранную версию мода (а не "последнюю совместимую") —
// закрепляем её, чтобы обычная переустановка не заменила на другую версию
ipcMain.handle('mods:addSpecificVersion', async (e, { mcVersion, loader, projectId, title, icon, versionId, installDeps }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const existing = inst.wantedMods.find(m => m.projectId === projectId);
  const previousFileName = existing ? (existing.pinnedFileName || existing.lastFileName) : null;

  try {
    const version = await modrinth.getVersionById(versionId);
    const result = await modManager.installVersionFile(root, mcVersion, loader, version, previousFileName);

    const entry = {
      projectId, title, icon: icon || (existing ? existing.icon : null),
      pinned: true, pinnedFileName: result.fileName, pinnedVersionId: versionId
    };
    const wantedMods = existing
      ? inst.wantedMods.map(m => m.projectId === projectId ? entry : m)
      : [...inst.wantedMods, entry];
    setWantedMods(mcVersion, loader, wantedMods);

    // зависимости выбранной версии. Закреплённый мод «Переустановить» не проверяет,
    // поэтому зависимости записываем в список сами, иначе их удалит уборка лишних файлов
    const installedDeps = [];
    const failedDeps = [];
    if (installDeps) {
      const root2 = getGameDir();
      for (const depId of version.dependencies) {
        const fresh = getInstance(mcVersion, loader);
        if (fresh.wantedMods.some(m => m.projectId === depId)) continue;
        try {
          const depVersion = await modrinth.getCompatibleVersion(depId, mcVersion, loader);
          const info = await modrinth.getProjectInfo(depId).catch(() => null);
          const depTitle = info ? info.title : depId;
          if (!depVersion) { failedDeps.push({ title: depTitle, reason: `нет сборки под ${mcVersion}` }); continue; }
          const depResult = await modManager.installVersionFile(root2, mcVersion, loader, depVersion);
          fresh.wantedMods.push({ projectId: depId, title: depTitle, icon: info ? info.icon_url : null, source: 'modrinth', asDependency: true, lastFileName: depResult.fileName });
          setWantedMods(mcVersion, loader, fresh.wantedMods);
          installedDeps.push(depTitle);
        } catch (err) {
          failedDeps.push({ title: depId, reason: err.message });
        }
      }
    }

    notify('Мод установлен', `${title}: версия ${version.versionNumber}`);
    return { ok: true, fileName: result.fileName, versionNumber: version.versionNumber, installedDeps, failedDeps };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mods:remove', async (e, { mcVersion, loader, projectId }) => {
  const inst = getInstance(mcVersion, loader);
  const wantedMods = inst.wantedMods.filter(m => m.projectId !== projectId);
  setWantedMods(mcVersion, loader, wantedMods);
  return wantedMods;
});

// закрепить/открепить текущую установленную версию мода, чтобы «Переустановить» её не трогала
ipcMain.handle('mods:setPinned', async (e, { mcVersion, loader, projectId, pinned, fileName }) => {
  return setModPinned(mcVersion, loader, projectId, pinned, fileName);
});

ipcMain.handle('mods:reinstall', async (e, { mcVersion, loader, dryRun }) => {
  const inst = getInstance(mcVersion, loader);
  const root = getGameDir();

  // на всякий случай бэкапим миры перед реальной переустановкой — если несовместимый
  // мод что-то повредит, будет куда откатиться. Сухой прогон миры не трогает, бэкап не нужен
  if (!dryRun && store.get('backupSavesBeforeReinstall', true)) {
    try {
      const backupPath = await backupManager.backupSaves(root, mcVersion, loader, 'before-mods-reinstall');
      if (backupPath) console.log('[backup] сохранил миры перед переустановкой модов:', backupPath);
    } catch (err) {
      console.error('[backup] не удалось забэкапить миры:', err.message);
    }
  }

  // и отдельно — снимок самой сборки (моды + ресурспаки + список), чтобы можно было
  // откатить именно обновление модов одной кнопкой, не трогая миры
  if (!dryRun) {
    try {
      const snapshotPath = await buildBackup.backupBuild(root, mcVersion, loader, 'before-mods-reinstall');
      if (snapshotPath) console.log('[buildBackup] сохранил снимок сборки перед переустановкой:', snapshotPath);
    } catch (err) {
      console.error('[buildBackup] не удалось сохранить снимок сборки:', err.message);
    }
  }

  const report = await modManager.reinstallMods(root, mcVersion, loader, inst.wantedMods, progress => {
    sendToWindow('mods:progress', progress);
  }, !!dryRun);
  if (!dryRun) {
    rememberModFileNames(mcVersion, loader, [...report.installed, ...report.skipped]);
  }
  if (!dryRun && (report.installed.length || report.failed.length)) {
    notify('Установка модов завершена', `Установлено: ${report.installed.length}, ошибок: ${report.failed.length}`);
  }
  return report;
});

// точечное обновление одного мода — не трогает остальные,
// переиспользует ту же логику скачивания, просто со списком из одного элемента
ipcMain.handle('mods:updateOne', async (e, { mcVersion, loader, projectId, title, installDeps }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const report = await modManager.reinstallMods(root, mcVersion, loader, inst.wantedMods, progress => {
    sendToWindow('mods:progress', progress);
  }, false, projectId, installDeps !== false);
  rememberModFileNames(mcVersion, loader, [...report.installed, ...report.skipped]);
  if (report.installed.length) {
    notify('Мод обновлён', title);
  }
  return report;
});

// список версий, для которых уже есть сохранённый список модов (кроме текущей)
// Чтение метаданных установленных JAR-файлов для Build Check
ipcMain.handle('mods:inspectMetadata', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return jarMetadata.inspectModsDir(modManager.getModsDir(root, mcVersion, loader));
});

// проверка совместимости мода с версией/лоадером перед добавлением в список
ipcMain.handle('mods:checkCompatible', async (e, { projectId, mcVersion, loader, source }) => {
  try {
    const version = source === 'curseforge'
      ? await curseforge.getCompatibleVersion(projectId, mcVersion, loader, getCurseforgeApiKey())
      : await modrinth.getCompatibleVersion(projectId, mcVersion, loader);
    return { compatible: !!version };
  } catch (err) {
    return { compatible: false, reason: err.message };
  }
});

ipcMain.handle('mods:getDependencies', async (e, { projectId, mcVersion, loader, source }) => {
  try {
    const inst = getInstance(mcVersion, loader);
    const existingIds = inst.wantedMods.map(m => m.projectId);
    // id модов, которые уже лежат в папке mods (в том числе положенные вручную)
    let installedIds = [];
    try {
      const { graph } = await buildModGraph(mcVersion, loader);
      installedIds = [...graph.enabledProviders.keys()];
    } catch { /* не смогли прочитать jar, просто не фильтруем */ }
    return await modManager.resolveModDependencies(mcVersion, loader, projectId, existingIds, source === 'curseforge' ? 'curseforge' : 'modrinth', installedIds);
  } catch {
    return [];
  }
});

// обязательные зависимости конкретной версии мода (для установки через «Выбор версии»)
ipcMain.handle('mods:getVersionDependencies', async (e, { versionId, mcVersion, loader }) => {
  try {
    const version = await modrinth.getVersionById(versionId);
    const inst = getInstance(mcVersion, loader);
    const wanted = new Set(inst.wantedMods.map(m => m.projectId));
    let installedIds = new Set();
    try {
      const { graph } = await buildModGraph(mcVersion, loader);
      installedIds = new Set([...graph.enabledProviders.keys()].map(id => id.toLowerCase()));
    } catch { /* не фильтруем */ }
    const deps = [];
    for (const depId of version.dependencies) {
      if (wanted.has(depId)) continue;
      const info = await modrinth.getProjectInfo(depId).catch(() => null);
      if (info && info.slug && installedIds.has(String(info.slug).toLowerCase())) continue;
      deps.push({ projectId: depId, title: info ? info.title : depId, source: 'modrinth' });
    }
    return deps;
  } catch {
    return [];
  }
});

// скачать мод, которого не хватает другому моду (кнопка в окне «Зависимости»).
// Записываем его в список модов, иначе «Переустановить» удалила бы файл как лишний
ipcMain.handle('mods:installMissingDependency', async (e, { mcVersion, loader, dependencyId }) => {
  try {
    const root = getGameDir();
    const result = await modManager.installMissingDependency(root, mcVersion, loader, String(dependencyId || ''));
    if (!result.ok) return result;
    const inst = getInstance(mcVersion, loader);
    if (!inst.wantedMods.some(m => m.projectId === result.projectId)) {
      inst.wantedMods.push({ projectId: result.projectId, title: result.title, icon: result.icon, source: 'modrinth', asDependency: true, lastFileName: result.fileName });
      setWantedMods(mcVersion, loader, inst.wantedMods);
    }
    notify('Зависимость установлена', result.title);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- установленные файлы модов: включение/выключение без удаления ---

ipcMain.handle('mods:listInstalled', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return modManager.listInstalledMods(root, mcVersion, loader);
});

ipcMain.handle('mods:setEnabled', async (e, { mcVersion, loader, fileName, enabled }) => {
  const root = getGameDir();
  return modManager.setModEnabled(root, mcVersion, loader, fileName, enabled);
});

ipcMain.handle('mods:setAllEnabled', async (e, { mcVersion, loader, enabled }) => {
  const root = getGameDir();
  return modManager.setAllModsEnabled(root, mcVersion, loader, enabled);
});

// --- группы модов и избранное ---
ipcMain.handle('mods:groups:list', async (e, { mcVersion, loader }) => {
  const scan = await modIndex.scanModsDir(modManager.getModsDir(getGameDir(), mcVersion, loader), { loader });
  const modKeysByFile = {};
  for (const file of scan) {
    modKeysByFile[file.fileName] = modMemberKey(file);
  }
  return { groups: getModGroups(mcVersion, loader), modKeysByFile };
});
ipcMain.handle('mods:groups:create', async (e, { mcVersion, loader, name }) => createModGroup(mcVersion, loader, name));
ipcMain.handle('mods:groups:rename', async (e, { mcVersion, loader, id, name }) => renameModGroup(mcVersion, loader, id, name));
ipcMain.handle('mods:groups:delete', async (e, { mcVersion, loader, id }) => deleteModGroup(mcVersion, loader, id));
ipcMain.handle('mods:groups:assign', async (e, { mcVersion, loader, id, keys }) => assignModsToGroup(mcVersion, loader, id, keys));
ipcMain.handle('mods:groups:remove', async (e, { mcVersion, loader, id, keys }) => removeModsFromGroup(mcVersion, loader, id, keys));
ipcMain.handle('mods:groups:setEnabled', async (e, { mcVersion, loader, id, enabled }) => {
  const group = getModGroups(mcVersion, loader).find(item => item.id === id);
  if (!group) throw new Error('Группа не найдена');
  const scan = await modIndex.scanModsDir(modManager.getModsDir(getGameDir(), mcVersion, loader), { loader });
  const members = new Set(group.members);
  const changed = [];
  for (const file of scan) {
    const key = modMemberKey(file);
    const canonicalFileName = normalizeModFileName(file.fileName);
    if (members.has(key) && file.enabled !== !!enabled) {
      modManager.setModEnabled(getGameDir(), mcVersion, loader, canonicalFileName, !!enabled);
      changed.push(canonicalFileName);
    }
  }
  return { changed, installed: modManager.listInstalledMods(getGameDir(), mcVersion, loader) };
});
ipcMain.handle('mods:favorites:list', async () => listFavoriteMods());
ipcMain.handle('mods:favorites:records', async () => listFavoriteModRecords());
ipcMain.handle('mods:favorites:toggle', async (e, { key, favorite, details }) => toggleFavoriteMod(key, favorite, details));

// установка модов перетаскиванием файлов в окно лаунчера — просто копируем
// .jar/.zip в папку модов текущего инстанса, без привязки к Modrinth
ipcMain.handle('mods:installFromFiles', async (e, { mcVersion, loader, filePaths }) => {
  const root = getGameDir();
  const modsDir = modManager.getModsDir(root, mcVersion, loader);
  fs.mkdirSync(modsDir, { recursive: true });

  const installed = [];
  const skipped = [];

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();

    if (ext !== '.jar' && ext !== '.zip') {
      skipped.push({ fileName, reason: 'не .jar и не .zip' });
      continue;
    }

    try {
      fs.copyFileSync(filePath, path.join(modsDir, fileName));
      installed.push(fileName);
    } catch (err) {
      skipped.push({ fileName, reason: err.message });
    }
  }

  // добавляем скопированные файлы в wantedMods как закреплённые (pinned) —
  // иначе reinstallMods их не знает и удаляет при следующей переустановке/
  // точечном обновлении, т.к. cleanup стирает всё, чего нет в списке
  if (installed.length) {
    const inst = getInstance(mcVersion, loader);
    for (const fileName of installed) {
      const projectId = `local:${fileName}`;
      if (inst.wantedMods.some(m => m.projectId === projectId)) continue;
      inst.wantedMods.push({
        projectId,
        title: fileName.replace(/\.(jar|zip)$/i, ''),
        icon: null,
        pinned: true,
        pinnedFileName: fileName
      });
    }
    setWantedMods(mcVersion, loader, inst.wantedMods);
  }

  if (installed.length) {
    notify('Моды установлены', `Добавлено файлов: ${installed.length}`);
  }

  return { installed, skipped };
});

// --- профили модпаков ---

// ---------- сборки (независимые инстансы с названием) ----------

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else fs.copyFileSync(from, to);
  }
}

function countFiles(dir, test) {
  try { return fs.readdirSync(dir).filter(test).length; } catch { return 0; }
}

function describeBuild(build, activeId) {
  const root = getGameDir();
  const dir = path.join(root, 'instances', buildFolder.dirOf(build));
  const inst = (store.get('instances') || {})[`build-${build.id}`] || {};
  return {
    ...build,
    active: build.id === activeId,
    modsCount: countFiles(path.join(dir, 'mods'), f => f.endsWith('.jar') || f.endsWith('.jar.disabled')),
    packsCount: countFiles(path.join(dir, 'resourcepacks'), () => true),
    shadersCount: countFiles(path.join(dir, 'shaderpacks'), () => true),
    playtimeMs: inst.totalPlaytimeMs || 0,
    lastPlayedAt: inst.lastPlayedAt || 0,
    launchCount: inst.launchCount || 0,
    accent: inst.accent || null,
    hasBackground: Boolean(inst.backgroundPath)
  };
}

function listBuildsInfo() {
  const active = getActiveBuild();
  return listBuilds().map(b => describeBuild(b, active ? active.id : null));
}

ipcMain.handle('builds:list', async () => listBuildsInfo());

ipcMain.handle('builds:create', async (e, { name, mcVersion, loader, activate }) => {
  const build = createBuild({ name, mcVersion, loader });
  fs.mkdirSync(path.join(getGameDir(), 'instances', buildFolder.dirOf(build)), { recursive: true });
  if (activate !== false) setActiveBuild(build.id);
  return { build, builds: listBuildsInfo() };
});

// картинка-фон сборки по её id: у не выбранных сборок тот же файл, что хранится в их записи
ipcMain.handle('builds:getBackground', async (e, id) => {
  const record = (store.get('instances') || {})[`build-${id}`] || {};
  const file = record.backgroundPath;
  if (!file || !fs.existsSync(file)) return null;
  try {
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
});

ipcMain.handle('builds:select', async (e, id) => {
  const build = setActiveBuild(id || null);
  return { build, builds: listBuildsInfo() };
});

setFolderChecker(name => fs.existsSync(path.join(getGameDir(), 'instances', name)));

// папка сборки названа по её имени; если имя поменялось, переименовываем и папку.
// Пока игра запускается или не получается переименовать (файлы заняты), остаётся прежняя папка, повторим позже.
function syncBuildFolder(id) {
  if (launchInProgress) return false;
  const build = listBuilds().find(b => b.id === id);
  if (!build) return false;
  try {
    const wanted = buildFolder.renameToMatch(build, path.join(getGameDir(), 'instances'), takenFolders(id));
    if (wanted) setBuildFolder(id, wanted);
    return true;
  } catch (err) {
    console.error(`[builds] не удалось переименовать папку сборки «${build.name}»:`, err.message);
    return false;
  }
}

function syncAllBuildFolders() {
  for (const build of listBuilds()) syncBuildFolder(build.id);
}

ipcMain.handle('builds:rename', async (e, { id, name }) => {
  renameBuild(id, name);
  syncBuildFolder(id);
  return listBuildsInfo();
});

ipcMain.handle('builds:setMeta', async (e, { id, group, tags }) => {
  setBuildMeta(id, { group, tags });
  return listBuildsInfo();
});

ipcMain.handle('builds:duplicate', async (e, { id, name }) => {
  const source = listBuilds().find(b => b.id === id);
  if (!source) throw new Error('Сборка не найдена');
  const copy = createBuild({ name: name || `${source.name} (копия)`, mcVersion: source.mcVersion, loader: source.loader });
  setBuildMeta(copy.id, { group: source.group, tags: source.tags });
  const root = getGameDir();
  const srcDir = path.join(root, 'instances', buildFolder.dirOf(source));
  const dstDir = path.join(root, 'instances', buildFolder.dirOf(copy));
  if (fs.existsSync(srcDir)) copyDirSync(srcDir, dstDir);
  else fs.mkdirSync(dstDir, { recursive: true });

  const instances = store.get('instances') || {};
  const record = instances[`build-${source.id}`];
  if (record) {
    const clone = JSON.parse(JSON.stringify(record));
    delete clone.totalPlaytimeMs;
    delete clone.lastPlayedAt;
    delete clone.launchCount;
    // у копии должен быть свой файл фона, иначе смена фона у одной сборки меняет обе
    if (clone.backgroundPath && fs.existsSync(clone.backgroundPath)) {
      const ext = path.extname(clone.backgroundPath);
      const copyPath = path.join(path.dirname(clone.backgroundPath), `build-${copy.id}${ext}`);
      try { fs.copyFileSync(clone.backgroundPath, copyPath); clone.backgroundPath = copyPath; } catch { clone.backgroundPath = null; }
    }
    instances[`build-${copy.id}`] = clone;
    store.set('instances', instances);
  }
  return listBuildsInfo();
});

function scanLegacyVersions() {
  return buildTools.scanLegacyVersions(path.join(getGameDir(), 'instances'), new Set(listBuilds().flatMap(b => [buildFolder.dirOf(b), `build-${b.id}`].map(n => n.toLowerCase()))));
}

ipcMain.handle('builds:listLegacy', async () => scanLegacyVersions());

ipcMain.handle('builds:fromLegacy', async (e, { folder, name, worlds }) => {
  const item = scanLegacyVersions().find(v => v.folder === String(folder));
  if (!item) throw new Error('Версия не найдена или в ней нет модов');

  const baseName = String(name || `${item.mcVersion} ${item.loader}`).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 36) || 'Моя сборка';
  let buildName = baseName;
  const taken = new Set(listBuilds().map(b => b.name.toLowerCase()));
  for (let n = 2; taken.has(buildName.toLowerCase()); n++) buildName = `${baseName} ${n}`;

  const root = getGameDir();
  const build = createBuild({ name: buildName, mcVersion: item.mcVersion, loader: item.loader });
  const targetDir = path.join(root, 'instances', buildFolder.dirOf(build));
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    launcherImport.copyInstanceFiles(path.join(root, 'instances', item.folder), targetDir, { worlds: Boolean(worlds) });
  } catch (err) {
    removeBuildRecord(build.id);
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`Не удалось скопировать файлы: ${err.message}`);
  }

  const instances = store.get('instances') || {};
  const record = instances[item.folder];
  if (record) {
    const clone = JSON.parse(JSON.stringify(record));
    delete clone.totalPlaytimeMs;
    delete clone.lastPlayedAt;
    delete clone.launchCount;
    if (clone.backgroundPath && fs.existsSync(clone.backgroundPath)) {
      const copyPath = path.join(path.dirname(clone.backgroundPath), `build-${build.id}${path.extname(clone.backgroundPath)}`);
      try { fs.copyFileSync(clone.backgroundPath, copyPath); clone.backgroundPath = copyPath; } catch { clone.backgroundPath = null; }
    }
    instances[`build-${build.id}`] = clone;
    store.set('instances', instances);
  } else {
    const pinned = launcherImport.pinnedFromTarget(targetDir);
    instances[`build-${build.id}`] = { wantedMods: pinned.mods, wantedResourcePacks: pinned.resourcePacks, wantedShaders: pinned.shaders };
    store.set('instances', instances);
  }

  notify('Сборка создана', `«${build.name}» из версии ${item.mcVersion} ${item.loader}`);
  return { build, builds: listBuildsInfo(), counts: { mods: item.mods, resourcePacks: item.resourcePacks, shaders: item.shaders } };
});

// ---------- инструменты сборок: сравнение, перенос на другую версию, оптимизация ----------

// запускает fn для элементов не более чем limit одновременно — Modrinth не любит залпы запросов
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

function buildDir(id) {
  const build = listBuilds().find(b => b.id === id);
  return path.join(getGameDir(), 'instances', build ? buildFolder.dirOf(build) : `build-${id}`);
}

async function readModInventory(dir, loader) {
  const scanned = await modIndex.scanModsDir(path.join(dir, 'mods'), { loader });
  return scanned
    .filter(entry => entry.enabled !== false)
    .map(entry => {
      const mods = entry.mods || [];
      const mod = mods[0];
      // что мод даёт сам и что обязательно требует от других: нужно, чтобы при переносе не потерять зависимости
      const own = new Set(mods.flatMap(m => [m.id, ...(m.provides || [])]).filter(Boolean));
      const requires = [...new Set(mods.flatMap(m => (m.deps || []).filter(d => d.kind === 'required').map(d => d.id)))]
        .filter(id => !own.has(id));
      return {
        key: mod ? mod.id : entry.fileName,
        name: mod ? (mod.name || mod.id) : entry.fileName,
        version: mod ? mod.version : '',
        fileName: entry.fileName,
        requires,
        provides: [...own].filter(id => !mod || id !== mod.id)
      };
    });
}

function listNames(dir, test) {
  try { return fs.readdirSync(dir).filter(test); } catch { return []; }
}

ipcMain.handle('builds:compare', async (e, { idA, idB }) => {
  const all = listBuilds();
  const a = all.find(b => b.id === idA);
  const b = all.find(item => item.id === idB);
  if (!a || !b) throw new Error('Сборка не найдена');

  const [modsA, modsB] = await Promise.all([
    readModInventory(buildDir(a.id), a.loader),
    readModInventory(buildDir(b.id), b.loader)
  ]);
  const isPack = n => /\.(zip|jar)$/i.test(n);
  return {
    a: { name: a.name, mcVersion: a.mcVersion, loader: a.loader, mods: modsA.length },
    b: { name: b.name, mcVersion: b.mcVersion, loader: b.loader, mods: modsB.length },
    mods: buildTools.compareInventories(modsA, modsB),
    packs: buildTools.compareNames(
      listNames(path.join(buildDir(a.id), 'resourcepacks'), isPack),
      listNames(path.join(buildDir(b.id), 'resourcepacks'), isPack)),
    shaders: buildTools.compareNames(
      listNames(path.join(buildDir(a.id), 'shaderpacks'), isPack),
      listNames(path.join(buildDir(b.id), 'shaderpacks'), isPack))
  };
});

// Переносит выбранные моды из одной сборки в другую. Если версия игры и загрузчик совпадают,
// файлы копируются как есть, вместе с обязательными зависимостями. Иначе в список целевой сборки
// попадают только моды, найденные на Modrinth или CurseForge, а файлы скачает обычная переустановка.
ipcMain.handle('builds:transferMods', async (e, { fromId, toId, keys }) => {
  const all = listBuilds();
  const from = all.find(b => b.id === fromId);
  const to = all.find(b => b.id === toId);
  if (!from || !to) throw new Error('Сборка не найдена');
  if (from.id === to.id) throw new Error('Выбери две разные сборки');
  if (!Array.isArray(keys) || !keys.length) throw new Error('Отметь моды для переноса');

  const [sourceInv, targetInv] = await Promise.all([
    readModInventory(buildDir(from.id), from.loader),
    readModInventory(buildDir(to.id), to.loader)
  ]);
  const plan = buildTools.planModTransfer(keys.map(String), sourceInv, targetInv, modGraph.BUILTIN_IDS);
  const files = [...plan.mods, ...plan.deps];
  if (!files.length) throw new Error('Выбранных модов уже нет в исходной сборке');

  const sameEnv = from.mcVersion === to.mcVersion && from.loader === to.loader;
  const srcMods = path.join(buildDir(from.id), 'mods');
  const dstMods = path.join(buildDir(to.id), 'mods');
  const copied = [];
  const failed = [];

  if (sameEnv) {
    fs.mkdirSync(dstMods, { recursive: true });
    for (const file of files) {
      const dest = path.join(dstMods, file.fileName);
      if (fs.existsSync(dest) || fs.existsSync(`${dest}.disabled`)) continue;
      try {
        fs.copyFileSync(path.join(srcMods, file.fileName), dest);
        copied.push(file.fileName);
      } catch (err) {
        failed.push({ name: file.name, reason: err.message });
      }
    }
  }

  // записи списка нужны переустановке: без них она сочтёт перенесённые файлы лишними и удалит их
  const instances = store.get('instances') || {};
  const sourceRecord = instances[`build-${from.id}`] || {};
  const targetRecord = instances[`build-${to.id}`] || {};
  const transferred = sameEnv ? files.filter(f => copied.includes(f.fileName)) : files;
  const merged = buildTools.mergeWantedMods(targetRecord.wantedMods || [], sourceRecord.wantedMods || [], transferred);
  // закреплённый мод переустановка не скачивает, а в другой версии файла ещё нет: закрепление не переносим
  const addedIds = new Set(merged.added.map(w => w.projectId));
  const wantedMods = sameEnv ? merged.wanted : merged.wanted.map(w => addedIds.has(w.projectId)
    ? { ...w, pinned: false, pinnedFileName: null, lastFileName: undefined }
    : w);
  instances[`build-${to.id}`] = {
    wantedResourcePacks: [], wantedShaders: [],
    ...targetRecord,
    wantedMods
  };
  store.set('instances', instances);

  return {
    sameEnv,
    toName: to.name,
    copied: copied.length,
    addedToList: merged.added.length,
    // файлы без записи в списке: при переустановке они будут удалены
    unlisted: sameEnv ? merged.unlisted.length : 0,
    // в другую версию можно перенести только то, что есть в списке сборки
    notTransferable: sameEnv ? 0 : merged.unlisted.length,
    deps: plan.deps.map(d => d.name),
    missingDeps: plan.missing,
    failed,
    builds: listBuildsInfo()
  };
});

// что из списка сборки найдётся под другую версию игры
async function planMigration(build, targetVersion) {
  const record = (store.get('instances') || {})[`build-${build.id}`] || {};
  const check = (items, lookup) => mapLimit(items || [], 6, async item => {
    const base = { projectId: item.projectId, title: item.title || item.projectId, icon: item.icon || null, source: item.source };
    if (item.source === 'curseforge') return { ...base, status: 'unknown' };
    try {
      const found = await lookup(item.projectId);
      return found ? { ...base, status: 'ok', versionNumber: found.versionNumber } : { ...base, status: 'missing' };
    } catch {
      return { ...base, status: 'unknown' };
    }
  });

  const [mods, packs, shaders] = await Promise.all([
    check(record.wantedMods, id => modrinth.getCompatibleVersion(id, targetVersion, build.loader)),
    check(record.wantedResourcePacks, id => modrinth.getCompatibleResourcePackVersion(id, targetVersion)),
    check(record.wantedShaders, id => modrinth.getCompatibleShaderVersion(id, targetVersion))
  ]);
  return { mods, packs, shaders, record };
}

ipcMain.handle('builds:migratePlan', async (e, { id, targetVersion }) => {
  const build = listBuilds().find(b => b.id === id);
  if (!build) throw new Error('Сборка не найдена');
  if (!targetVersion || targetVersion === build.mcVersion) throw new Error('Выбери другую версию Minecraft');
  const { mods, packs, shaders } = await planMigration(build, targetVersion);
  return {
    mods, packs, shaders,
    summary: {
      mods: buildTools.summarizeMigration(mods),
      packs: buildTools.summarizeMigration(packs),
      shaders: buildTools.summarizeMigration(shaders)
    }
  };
});

// Создаёт копию сборки под новую версию игры. Исходная сборка не меняется.
// Переносятся список модов/ресурспаков/шейдеров (только то, что нашлось под новую версию),
// настройки игры и модов; миры — по желанию. Сами файлы скачиваются дальше обычной переустановкой.
ipcMain.handle('builds:migrate', async (e, { id, targetVersion, name, copyWorlds }) => {
  const source = listBuilds().find(b => b.id === id);
  if (!source) throw new Error('Сборка не найдена');
  if (!targetVersion || targetVersion === source.mcVersion) throw new Error('Выбери другую версию Minecraft');

  const { mods, packs, shaders } = await planMigration(source, targetVersion);
  const keep = list => list.filter(i => i.status === 'ok').map(({ projectId, title, icon, source: src }) =>
    ({ projectId, title, icon, source: src === 'curseforge' ? 'curseforge' : 'modrinth' }));

  const created = createBuild({ name: name || `${source.name} ${targetVersion}`, mcVersion: targetVersion, loader: source.loader });
  const srcDir = buildDir(source.id);
  const dstDir = buildDir(created.id);
  fs.mkdirSync(dstDir, { recursive: true });

  // настройки игры и модов: это то, что жалко настраивать заново
  for (const entry of ['config', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat', ...(copyWorlds ? ['saves'] : [])]) {
    const from = path.join(srcDir, entry);
    if (!fs.existsSync(from)) continue;
    if (fs.statSync(from).isDirectory()) copyDirSync(from, path.join(dstDir, entry));
    else fs.copyFileSync(from, path.join(dstDir, entry));
  }

  // новая сборка становится активной, чтобы списки записались под её ключ
  setActiveBuild(created.id);
  setWantedMods(targetVersion, source.loader, keep(mods));
  setWantedResourcePacks(targetVersion, source.loader, keep(packs));
  setWantedShaders(targetVersion, source.loader, keep(shaders));

  return {
    build: created,
    builds: listBuildsInfo(),
    counts: { mods: keep(mods).length, packs: keep(packs).length, shaders: keep(shaders).length }
  };
});

// ---------- оптимизация выбранной сборки ----------
ipcMain.handle('optimize:plan', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const installed = await readModInventory(modManager.getInstanceDir(root, mcVersion, loader), loader);
  const plan = buildTools.planOptimization(loader, installed.map(m => m.key));
  const wanted = getInstance(mcVersion, loader).wantedMods;

  return mapLimit(plan, 4, async item => {
    const base = { slug: item.slug, title: item.title, why: item.why, state: item.state };
    try {
      const project = await modrinth.getProjectInfo(item.slug);
      const alreadyWanted = wanted.some(w => w.projectId === project.id);
      const state = alreadyWanted && item.state === 'candidate' ? 'installed' : item.state;
      if (state !== 'candidate') return { ...base, state, projectId: project.id, icon: project.icon_url || null };

      const compatible = await modrinth.getCompatibleVersion(project.id, mcVersion, loader);
      return compatible
        ? { ...base, projectId: project.id, icon: project.icon_url || null, versionNumber: compatible.versionNumber }
        : { ...base, state: 'unavailable', projectId: project.id, icon: project.icon_url || null };
    } catch {
      return { ...base, state: 'unavailable' };
    }
  });
});

// добавляет выбранные моды в список; скачивает их дальше обычная переустановка
ipcMain.handle('optimize:apply', async (e, { mcVersion, loader, items }) => {
  const inst = getInstance(mcVersion, loader);
  let added = 0;
  for (const item of items || []) {
    if (!item || !item.projectId || inst.wantedMods.some(m => m.projectId === item.projectId)) continue;
    inst.wantedMods.push({ projectId: item.projectId, title: item.title, icon: item.icon || null, source: 'modrinth' });
    added++;
  }
  setWantedMods(mcVersion, loader, inst.wantedMods);
  return { added, wanted: inst.wantedMods.length };
});

ipcMain.handle('builds:delete', async (e, id) => {
  const build = listBuilds().find(b => b.id === id);
  if (!build) throw new Error('Сборка не найдена');
  const dir = buildDir(id);
  removeBuildRecord(id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {
    throw new Error(`Сборка удалена из списка, но папку удалить не удалось: ${err.message}`);
  }
  return listBuildsInfo();
});

ipcMain.handle('builds:openFolder', async (e, id) => {
  const dir = buildDir(id);
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return true;
});

// создаёт новую сборку из .mrpack: версия, загрузчик и название берутся из манифеста
ipcMain.handle('share:buildCode', async (e, id) => {
  const build = listBuilds().find(b => b.id === id);
  if (!build) throw new Error('Сборка не найдена');
  const record = (store.get('instances') || {})[`build-${build.id}`];
  const manifest = buildShare.createManifest({ name: build.name, mcVersion: build.mcVersion, loader: build.loader, record });
  const total = manifest.m.length + manifest.r.length + manifest.s.length;
  if (!total) throw new Error('В сборке пока нет модов, ресурспаков и шейдеров, делиться нечем');
  return { code: buildShare.encodeBuildCode(manifest), mods: manifest.m.length, resourcePacks: manifest.r.length, shaders: manifest.s.length };
});

ipcMain.handle('share:preview', async (e, code) => {
  const manifest = buildShare.decodeBuildCode(code);
  if (!manifest) return null;
  return {
    name: manifest.name,
    mcVersion: manifest.mcVersion,
    loader: manifest.loader,
    mods: manifest.mods.length,
    resourcePacks: manifest.resourcePacks.length,
    shaders: manifest.shaders.length,
    titles: manifest.mods.filter(m => !m.asDependency).slice(0, 12).map(m => m.title)
  };
});

ipcMain.handle('share:install', async (e, { code, name }) => {
  const manifest = buildShare.decodeBuildCode(code);
  if (!manifest) throw new Error('Не удалось прочитать код сборки');
  const { mcVersion, loader } = manifest;

  const baseName = String(name || manifest.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 36) || 'Сборка по коду';
  let buildName = baseName;
  const taken = new Set(listBuilds().map(b => b.name.toLowerCase()));
  for (let n = 2; taken.has(buildName.toLowerCase()); n++) buildName = `${baseName} ${n}`;

  const build = createBuild({ name: buildName, mcVersion, loader });
  fs.mkdirSync(path.join(getGameDir(), 'instances', buildFolder.dirOf(build)), { recursive: true });
  setActiveBuild(build.id);

  setWantedMods(mcVersion, loader, manifest.mods);
  setWantedResourcePacks(mcVersion, loader, manifest.resourcePacks);
  setWantedShaders(mcVersion, loader, manifest.shaders);

  const root = getGameDir();
  const report = { mods: null, resourcePacks: null, shaders: null };

  report.mods = await modManager.reinstallMods(root, mcVersion, loader, manifest.mods, progress => {
    sendToWindow('mods:progress', progress);
  }, false);
  rememberModFileNames(mcVersion, loader, [...report.mods.installed, ...report.mods.skipped]);

  if (manifest.resourcePacks.length) {
    report.resourcePacks = await resourcePackManager.reinstallResourcePacks(root, mcVersion, loader, manifest.resourcePacks, progress => {
      sendToWindow('resourcepacks:progress', progress);
    }, false);
    rememberResourcePackFileNames(mcVersion, loader, [...report.resourcePacks.installed, ...report.resourcePacks.skipped]);
  }
  if (manifest.shaders.length) {
    report.shaders = await shaderManager.reinstallShaders(root, mcVersion, loader, manifest.shaders, progress => {
      sendToWindow('shaders:progress', progress);
    }, false);
    rememberShaderFileNames(mcVersion, loader, [...report.shaders.installed, ...report.shaders.skipped]);
  }

  const count = r => (r ? { installed: r.installed.length, failed: r.failed.length } : { installed: 0, failed: 0 });
  notify('Сборка установлена', `«${build.name}»: модов ${count(report.mods).installed}, ошибок ${count(report.mods).failed}`);
  return {
    build,
    builds: listBuildsInfo(),
    result: { mods: count(report.mods), resourcePacks: count(report.resourcePacks), shaders: count(report.shaders) }
  };
});

const importCandidates = new Map();

function rememberCandidates(items) {
  return items.map(item => {
    const id = crypto.createHash('sha1').update(`${item.source}|${item.gameDir}|${item.name}`).digest('hex').slice(0, 12);
    importCandidates.set(id, item);
    return {
      id,
      source: item.source,
      sourceLabel: launcherImport.SOURCE_LABELS[item.source] || item.source,
      name: item.name,
      mcVersion: item.mcVersion,
      loader: item.loader,
      mods: item.mods,
      resourcePacks: item.resourcePacks,
      shaders: item.shaders,
      worlds: item.worlds
    };
  });
}

ipcMain.handle('import:scan', async () => {
  importCandidates.clear();
  return rememberCandidates(launcherImport.scanKnown());
});

ipcMain.handle('import:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return rememberCandidates(launcherImport.scanFolder(res.filePaths[0]));
});

ipcMain.handle('import:run', async (e, { id, name, worlds }) => {
  const item = importCandidates.get(id);
  if (!item) throw new Error('Сборка не найдена, обнови список');

  const baseName = String(name || item.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 36) || 'Импорт';
  let buildName = baseName;
  const taken = new Set(listBuilds().map(b => b.name.toLowerCase()));
  for (let n = 2; taken.has(buildName.toLowerCase()); n++) buildName = `${baseName} ${n}`;

  const build = createBuild({ name: buildName, mcVersion: item.mcVersion, loader: item.loader });
  const targetDir = path.join(getGameDir(), 'instances', buildFolder.dirOf(build));
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    launcherImport.copyInstanceFiles(item.gameDir, targetDir, { worlds: Boolean(worlds) });
  } catch (err) {
    removeBuildRecord(build.id);
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`Не удалось скопировать файлы: ${err.message}`);
  }

  setActiveBuild(build.id);
  const pinned = launcherImport.pinnedFromTarget(targetDir);
  setWantedMods(item.mcVersion, item.loader, pinned.mods);
  setWantedResourcePacks(item.mcVersion, item.loader, pinned.resourcePacks);
  setWantedShaders(item.mcVersion, item.loader, pinned.shaders);

  notify('Сборка импортирована', `«${build.name}» из ${launcherImport.SOURCE_LABELS[item.source] || item.source}`);
  return {
    build,
    builds: listBuildsInfo(),
    counts: { mods: pinned.mods.length, resourcePacks: pinned.resourcePacks.length, shaders: pinned.shaders.length }
  };
});

ipcMain.handle('builds:importMrpack', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }]
  });
  if (res.canceled) return null;

  const filePath = res.filePaths[0];
  const index = await readMrpackIndex(filePath);
  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft;
  if (!mcVersion) throw new Error('В сборке не указана версия Minecraft');

  let loader = 'vanilla';
  if (deps['fabric-loader']) loader = 'fabric';
  else if (deps['neoforge']) loader = 'neoforge';
  else if (deps['forge']) loader = 'forge';
  else if (deps['quilt-loader']) loader = 'fabric';

  const baseName = String(index.name || path.basename(filePath, '.mrpack')).slice(0, 36);
  let name = baseName;
  const taken = new Set(listBuilds().map(b => b.name.toLowerCase()));
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${baseName} ${n}`;

  const build = createBuild({ name, mcVersion, loader });
  fs.mkdirSync(path.join(getGameDir(), 'instances', buildFolder.dirOf(build)), { recursive: true });
  setActiveBuild(build.id);
  const result = await importMrpack(getGameDir(), mcVersion, loader, filePath);
  return { build, result, builds: listBuildsInfo() };
});


ipcMain.handle('modpacks:list', async () => listModpackProfiles());

ipcMain.handle('modpacks:save', async (e, { name, loader, mods }) => saveModpackProfile(name, loader, mods));

ipcMain.handle('modpacks:rename', async (e, { id, name }) => renameModpackProfile(id, name));

ipcMain.handle('modpacks:delete', async (e, id) => deleteModpackProfile(id));

ipcMain.handle('modpacks:apply', async (e, { id, mcVersion, loader }) => {
  const profile = listModpackProfiles().find(p => p.id === id);
  if (!profile) throw new Error('Профиль не найден');

  const inst = getInstance(mcVersion, loader);
  for (const mod of profile.mods) {
    if (!inst.wantedMods.some(m => m.projectId === mod.projectId)) inst.wantedMods.push(mod);
  }
  setWantedMods(mcVersion, loader, inst.wantedMods);
  return inst.wantedMods;
});

// --- "официальная" сборка сообщества: ссылка настраивается один раз (в настройках
// или админом), дальше игроки просто жмут "обновить" без ручного ввода url ---

// список других версий-инстансов, из которых можно скопировать настройки (звук/графика/конфиги модов)
ipcMain.handle('instances:listOther', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return instanceSettings.listOtherInstances(root, mcVersion, loader);
});

ipcMain.handle('instances:copySettings', async (e, { from, to }) => {
  const root = getGameDir();
  return instanceSettings.copySettings(root, from, to);
});

ipcMain.handle('community:getBuildUrl', async (e, { mcVersion, loader }) => {
  return getCommunityBuildUrl(mcVersion, loader);
});

ipcMain.handle('community:setBuildUrl', async (e, { mcVersion, loader, url }) => {
  return setCommunityBuildUrl(mcVersion, loader, url);
});

// список версий Fabric Loader под конкретный Minecraft — для селекта в настройках
ipcMain.handle('fabric:listVersions', async (e, mcVersion) => {
  return fabric.getLoaderVersions(mcVersion);
});

ipcMain.handle('fabric:getLoaderVersion', async (e, { mcVersion, loader }) => {
  return getFabricLoaderVersion(mcVersion, loader);
});

ipcMain.handle('fabric:setLoaderVersion', async (e, { mcVersion, loader, version }) => {
  return setFabricLoaderVersion(mcVersion, loader, version);
});

// список версий NeoForge под конкретный Minecraft — для селекта в настройках
ipcMain.handle('neoforge:listVersions', async (e, mcVersion) => {
  return neoforge.getVersions(mcVersion);
});

ipcMain.handle('neoforge:getVersion', async (e, { mcVersion, loader }) => {
  return getNeoforgeVersion(mcVersion, loader);
});

ipcMain.handle('neoforge:setVersion', async (e, { mcVersion, loader, version }) => {
  return setNeoforgeVersion(mcVersion, loader, version);
});

// Качает актуальный zip сборки сообщества (тот же формат, что и обычный экспорт/импорт —
// manifest.json + mods/ + resourcepacks/), заменяет список "нужных" модов на список
// из сборки и сразу докачивает всё, чего не было в самом zip (например, если админ
// сообщества обновил manifest, но забыл положить файл — тут мы всё равно найдём его на Modrinth)
ipcMain.handle('community:updateBuild', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const url = getCommunityBuildUrl(mcVersion, loader);
  if (!url) {
    throw new Error('Ссылка на сборку сообщества не настроена — задай её в настройках');
  }

  // снимок текущего состояния перед заменой — если сборка сообщества окажется
  // хуже локальной, можно откатиться одной кнопкой
  try {
    const snapshotPath = await buildBackup.backupBuild(root, mcVersion, loader, 'before-community-update');
    if (snapshotPath) console.log('[buildBackup] сохранил снимок перед обновлением из сборки сообщества:', snapshotPath);
  } catch (err) {
    console.error('[buildBackup] не удалось сохранить снимок перед обновлением сборки:', err.message);
  }

  const importResult = await importInstanceFromUrl(root, mcVersion, loader, url);

  // после импорта список wantedMods/wantedResourcePacks уже заменён на список сообщества;
  // теперь реальной переустановкой докачиваем то, чего не было в самом zip
  const inst = getInstance(mcVersion, loader);

  const mods = await modManager.reinstallMods(root, mcVersion, loader, inst.wantedMods, progress => {
    sendToWindow('mods:progress', progress);
  }, false);
  rememberModFileNames(mcVersion, loader, [...mods.installed, ...mods.skipped]);

  const resourcepacks = await resourcePackManager.reinstallResourcePacks(root, mcVersion, loader, inst.wantedResourcePacks, progress => {
    sendToWindow('resourcepacks:progress', progress);
  }, false);
  rememberResourcePackFileNames(mcVersion, loader, [...resourcepacks.installed, ...resourcepacks.skipped]);

  notify('Сборка сообщества обновлена', `Модов: ${importResult.wantedModsRestored}, ресурспаков: ${importResult.wantedResourcePacksRestored}`);

  return { importResult, mods, resourcepacks };
});

// Meteor Client не публикуется ни на Modrinth, ни на CurseForge — только через
// GitHub Releases разработчиков, поэтому для него отдельный механизм проверки/установки
ipcMain.handle('meteor:check', async (e, { mcVersion, loader }) => {
  const current = getMeteorClientVersion(mcVersion, loader);
  try {
    return { ok: true, current, ...(await meteorClient.checkForUpdate(current, mcVersion)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('meteor:install', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  try {
    const result = await meteorClient.install(root, mcVersion, loader, progress => {
      sendToWindow('meteor:progress', progress);
    });
    setMeteorClientVersion(mcVersion, loader, result.version);
    notify('Meteor Client обновлён', `Установлена версия ${result.version}`);
    return { ok: true, version: result.version, source: result.source };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// опознать моды, закинутые вручную (не через лаунчер) — проверяем их хэш на
// Modrinth; если совпало, дальше лаунчер сможет следить за их обновлениями сам
ipcMain.handle('mods:identifyLocal', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const { updatedList, results } = await identifyLocal.identifyLocalMods(root, mcVersion, loader, inst.wantedMods);
  setWantedMods(mcVersion, loader, updatedList);
  return results;
});

ipcMain.handle('resourcepacks:identifyLocal', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const { updatedList, results } = await identifyLocal.identifyLocalResourcePacks(root, mcVersion, loader, inst.wantedResourcePacks);
  setWantedResourcePacks(mcVersion, loader, updatedList);
  return results;
});

ipcMain.handle('mods:otherInstances', async (e, { mcVersion, loader }) => {
  const currentKey = instanceKey(mcVersion, loader);
  return listInstances().filter(i => i.key !== currentKey);
});

ipcMain.handle('mods:copyFrom', async (e, { mcVersion, loader, sourceKey }) => {
  const source = listInstances().find(i => i.key === sourceKey);
  if (!source) throw new Error('Список модов для копирования не найден');

  const inst = getInstance(mcVersion, loader);
  let skippedLocal = 0;
  for (const mod of source.wantedMods) {
    // Моды, добавленные перетаскиванием файла, существуют только в папке старой версии
    if (String(mod.projectId).startsWith('local:')) { skippedLocal++; continue; }
    if (inst.wantedMods.some(m => m.projectId === mod.projectId)) continue;
    // Закрепление и имя файла относятся к старой версии игры. Раньше они копировались
    // как есть: закреплённый мод считался уже установленным, и «Переустановить»
    // его под новую версию не скачивала вовсе.
    const { pinned, pinnedFileName, pinnedVersionId, lastFileName, ...clean } = mod;
    inst.wantedMods.push(clean);
  }
  setWantedMods(mcVersion, loader, inst.wantedMods);
  return { wantedMods: inst.wantedMods, skippedLocal };
});

// --- ресурспаки ---

ipcMain.handle('resourcepacks:search', async (e, { query, mcVersion, offset, sort, category }) => {
  return modrinth.searchResourcePacks(query, mcVersion, 20, offset || 0, sort || 'relevance', category || '');
});

ipcMain.handle('resourcepacks:wanted', async (e, { mcVersion, loader }) => {
  return getInstance(mcVersion, loader).wantedResourcePacks;
});

ipcMain.handle('resourcepacks:add', async (e, { mcVersion, loader, projectId, title, icon }) => {
  const inst = getInstance(mcVersion, loader);
  if (!inst.wantedResourcePacks.some(p => p.projectId === projectId)) {
    inst.wantedResourcePacks.push({ projectId, title, icon });
  }
  setWantedResourcePacks(mcVersion, loader, inst.wantedResourcePacks);
  return inst.wantedResourcePacks;
});

ipcMain.handle('resourcepacks:remove', async (e, { mcVersion, loader, projectId }) => {
  const inst = getInstance(mcVersion, loader);
  const wanted = inst.wantedResourcePacks.filter(p => p.projectId !== projectId);
  setWantedResourcePacks(mcVersion, loader, wanted);
  return wanted;
});

// список версий ресурспака (без привязки к лоадеру) — для ручного выбора конкретной версии
ipcMain.handle('resourcepacks:listVersions', async (e, { projectId }) => {
  try {
    return { ok: true, versions: await modrinth.listVersions(projectId, null) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('resourcepacks:addSpecificVersion', async (e, { mcVersion, loader, projectId, title, icon, versionId }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const existing = inst.wantedResourcePacks.find(p => p.projectId === projectId);
  const previousFileName = existing ? (existing.pinnedFileName || existing.lastFileName) : null;

  try {
    const version = await modrinth.getVersionById(versionId);
    const result = await resourcePackManager.installVersionFile(root, mcVersion, loader, version, previousFileName);

    const entry = {
      projectId, title, icon: icon || (existing ? existing.icon : null),
      pinned: true, pinnedFileName: result.fileName, pinnedVersionId: versionId
    };
    const wantedResourcePacks = existing
      ? inst.wantedResourcePacks.map(p => p.projectId === projectId ? entry : p)
      : [...inst.wantedResourcePacks, entry];
    setWantedResourcePacks(mcVersion, loader, wantedResourcePacks);

    notify('Ресурспак установлен', `${title}: версия ${version.versionNumber}`);
    return { ok: true, fileName: result.fileName, versionNumber: version.versionNumber };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// закрепить/открепить текущую установленную версию ресурспака, чтобы «Переустановить» её не трогала
ipcMain.handle('resourcepacks:setPinned', async (e, { mcVersion, loader, projectId, pinned, fileName }) => {
  return setResourcePackPinned(mcVersion, loader, projectId, pinned, fileName);
});

ipcMain.handle('resourcepacks:checkCompatible', async (e, { projectId, mcVersion }) => {
  try {
    const version = await modrinth.getCompatibleResourcePackVersion(projectId, mcVersion);
    return { compatible: !!version };
  } catch (err) {
    return { compatible: false, reason: err.message };
  }
});

// --- установленные файлы ресурспаков: включение/выключение без удаления ---

ipcMain.handle('resourcepacks:listInstalled', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return resourcePackManager.listInstalledResourcePacks(root, mcVersion, loader);
});

ipcMain.handle('resourcepacks:setEnabled', async (e, { mcVersion, loader, fileName, enabled }) => {
  const root = getGameDir();
  return resourcePackManager.setResourcePackEnabled(root, mcVersion, loader, fileName, enabled);
});

ipcMain.handle('resourcepacks:setAllEnabled', async (e, { mcVersion, loader, enabled }) => {
  const root = getGameDir();
  return resourcePackManager.setAllResourcePacksEnabled(root, mcVersion, loader, enabled);
});

// --- шейдеры ---

ipcMain.handle('shaders:search', async (e, { query, mcVersion, offset, sort, category }) => {
  return modrinth.searchShaders(query, mcVersion, 20, offset || 0, sort || 'relevance', category || '');
});

ipcMain.handle('shaders:wanted', async (e, { mcVersion, loader }) => {
  return getInstance(mcVersion, loader).wantedShaders;
});

ipcMain.handle('shaders:add', async (e, { mcVersion, loader, projectId, title, icon }) => {
  const inst = getInstance(mcVersion, loader);
  if (!inst.wantedShaders.some(s => s.projectId === projectId)) {
    inst.wantedShaders.push({ projectId, title, icon });
  }
  setWantedShaders(mcVersion, loader, inst.wantedShaders);
  return inst.wantedShaders;
});

ipcMain.handle('shaders:remove', async (e, { mcVersion, loader, projectId }) => {
  const inst = getInstance(mcVersion, loader);
  const wanted = inst.wantedShaders.filter(s => s.projectId !== projectId);
  setWantedShaders(mcVersion, loader, wanted);
  return wanted;
});

ipcMain.handle('shaders:reinstall', async (e, { mcVersion, loader, dryRun }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const report = await shaderManager.reinstallShaders(root, mcVersion, loader, inst.wantedShaders, progress => {
    sendToWindow('shaders:progress', progress);
  }, !!dryRun);

  if (!dryRun) rememberShaderFileNames(mcVersion, loader, [...report.installed, ...report.skipped]);
  return report;
});

ipcMain.handle('shaders:listInstalled', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return shaderManager.listInstalledShaders(root, mcVersion, loader);
});

ipcMain.handle('shaders:setEnabled', async (e, { mcVersion, loader, fileName, enabled }) => {
  const root = getGameDir();
  return shaderManager.setShaderEnabled(root, mcVersion, loader, fileName, enabled);
});

ipcMain.handle('shaders:setAllEnabled', async (e, { mcVersion, loader, enabled }) => {
  const root = getGameDir();
  return shaderManager.setAllShadersEnabled(root, mcVersion, loader, enabled);
});

ipcMain.handle('shaders:installFromFiles', async (e, { mcVersion, loader, filePaths }) => {
  const root = getGameDir();
  const dir = shaderManager.getShadersDir(root, mcVersion, loader);
  fs.mkdirSync(dir, { recursive: true });

  const installed = [];
  const skipped = [];

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();

    if (ext !== '.zip') {
      skipped.push({ fileName, reason: 'не .zip' });
      continue;
    }

    try {
      fs.copyFileSync(filePath, path.join(dir, fileName));
      installed.push(fileName);
    } catch (err) {
      skipped.push({ fileName, reason: err.message });
    }
  }

  return { installed, skipped };
});

// установка ресурспаков перетаскиванием файлов в окно лаунчера — так же, как mods:installFromFiles.
// сразу заносим файлы в wantedResourcePacks как закреплённые, иначе следующая
// переустановка/точечное обновление их удалит (тот же баг, что чинили у модов)
ipcMain.handle('resourcepacks:installFromFiles', async (e, { mcVersion, loader, filePaths }) => {
  const root = getGameDir();
  const dir = resourcePackManager.getResourcePacksDir(root, mcVersion, loader);
  fs.mkdirSync(dir, { recursive: true });

  const installed = [];
  const skipped = [];

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();

    if (ext !== '.zip') {
      skipped.push({ fileName, reason: 'не .zip' });
      continue;
    }

    try {
      fs.copyFileSync(filePath, path.join(dir, fileName));
      installed.push(fileName);
    } catch (err) {
      skipped.push({ fileName, reason: err.message });
    }
  }

  if (installed.length) {
    const inst = getInstance(mcVersion, loader);
    for (const fileName of installed) {
      const projectId = `local:${fileName}`;
      if (inst.wantedResourcePacks.some(p => p.projectId === projectId)) continue;
      inst.wantedResourcePacks.push({
        projectId,
        title: fileName.replace(/\.zip$/i, ''),
        icon: null,
        pinned: true,
        pinnedFileName: fileName
      });
    }
    setWantedResourcePacks(mcVersion, loader, inst.wantedResourcePacks);
  }

  if (installed.length) {
    notify('Ресурспаки установлены', `Добавлено файлов: ${installed.length}`);
  }

  return { installed, skipped };
});

// список версий, для которых уже есть сохранённый список ресурспаков (кроме текущей)
ipcMain.handle('resourcepacks:otherInstances', async (e, { mcVersion, loader }) => {
  const currentKey = instanceKey(mcVersion, loader);
  return listResourcePackInstances().filter(i => i.key !== currentKey);
});

ipcMain.handle('resourcepacks:copyFrom', async (e, { mcVersion, loader, sourceKey }) => {
  const source = listResourcePackInstances().find(i => i.key === sourceKey);
  if (!source) throw new Error('Список ресурспаков для копирования не найден');

  const inst = getInstance(mcVersion, loader);
  for (const pack of source.wantedResourcePacks) {
    if (!inst.wantedResourcePacks.some(p => p.projectId === pack.projectId)) inst.wantedResourcePacks.push(pack);
  }
  setWantedResourcePacks(mcVersion, loader, inst.wantedResourcePacks);
  return inst.wantedResourcePacks;
});

// --- профили ресурспаков (так же, как профили модпаков) ---

ipcMain.handle('resourcepackProfiles:list', async () => listResourcePackProfiles());

ipcMain.handle('resourcepackProfiles:save', async (e, { name, mcVersion, loader, packs }) => {
  const installedPacks = resourcePackManager.listInstalledResourcePacks(getGameDir(), mcVersion, loader);
  return saveResourcePackProfile(name, loader, packs, installedPacks);
});

ipcMain.handle('resourcepackProfiles:rename', async (e, { id, name }) => renameResourcePackProfile(id, name));

ipcMain.handle('resourcepackProfiles:delete', async (e, id) => deleteResourcePackProfile(id));

ipcMain.handle('resourcepackProfiles:apply', async (e, { id, mcVersion, loader }) => {
  const profile = listResourcePackProfiles().find(p => p.id === id);
  if (!profile) throw new Error('Профиль не найден');

  const currentInstalled = resourcePackManager.listInstalledResourcePacks(getGameDir(), mcVersion, loader);
  const plan = resourcePackProfiles.planProfileApply(profile, getInstance(mcVersion, loader).wantedResourcePacks, currentInstalled);
  setWantedResourcePacks(mcVersion, loader, plan.nextWanted);
  for (const update of plan.enabledUpdates) {
    resourcePackManager.setResourcePackEnabled(getGameDir(), mcVersion, loader, update.fileName, update.enabled);
  }
  return plan.nextWanted;
});

ipcMain.handle('resourcepacks:reinstall', async (e, { mcVersion, loader, dryRun }) => {
  const inst = getInstance(mcVersion, loader);
  const root = getGameDir();

  if (!dryRun) {
    try {
      const snapshotPath = await buildBackup.backupBuild(root, mcVersion, loader, 'before-resourcepacks-reinstall');
      if (snapshotPath) console.log('[buildBackup] сохранил снимок сборки перед переустановкой ресурспаков:', snapshotPath);
    } catch (err) {
      console.error('[buildBackup] не удалось сохранить снимок сборки:', err.message);
    }
  }

  const report = await resourcePackManager.reinstallResourcePacks(root, mcVersion, loader, inst.wantedResourcePacks, progress => {
    sendToWindow('resourcepacks:progress', progress);
  }, !!dryRun);
  if (!dryRun) {
    rememberResourcePackFileNames(mcVersion, loader, [...report.installed, ...report.skipped]);
  }
  if (!dryRun && (report.installed.length || report.failed.length)) {
    notify('Установка ресурспаков завершена', `Установлено: ${report.installed.length}, ошибок: ${report.failed.length}`);
  }
  return report;
});

// точечная установка одного ресурспака сразу после добавления — так же, как mods:updateOne.
// раньше сюда передавался список из ОДНОГО пака вместо полного inst.wantedResourcePacks,
// а reinstallResourcePacks чистит папку по переданному списку — из-за этого при обновлении
// одного пака удалялись все остальные. Теперь передаём полный список + targetProjectId,
// как в mods:updateOne, чтобы остальные паки не проверялись по сети, но и не удалялись
ipcMain.handle('resourcepacks:updateOne', async (e, { mcVersion, loader, projectId, title }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const report = await resourcePackManager.reinstallResourcePacks(root, mcVersion, loader, inst.wantedResourcePacks, progress => {
    sendToWindow('resourcepacks:progress', progress);
  }, false, projectId);
  rememberResourcePackFileNames(mcVersion, loader, [...report.installed, ...report.skipped]);
  if (report.installed.length) {
    notify('Ресурспак обновлён', title);
  }
  return report;
});

ipcMain.handle('game:launch', async (e, { mcVersion, loader, quickPlay }) => {
  return performLaunch(mcVersion, loader, quickPlay);
});

ipcMain.handle('launchSettings:get', async (e, { mcVersion, loader }) => {
  return {
    settings: getLaunchSettings(mcVersion, loader),
    global: {
      memoryMin: store.get('memoryMin'),
      memoryMax: store.get('memoryMax'),
      jvmArgs: store.get('jvmArgs'),
      javaPath: store.get('javaPath')
    },
    recommendation: await recommendMemoryFor(mcVersion, loader)
  };
});

ipcMain.handle('launchSettings:set', async (e, { mcVersion, loader, settings }) => {
  const problems = launchSettings.validate(settings);
  if (problems.length) throw new Error(problems.join('. '));
  return setLaunchSettings(mcVersion, loader, settings);
});

ipcMain.handle('gamePresets:list', async () => listGamePresets());
ipcMain.handle('gamePresets:save', async (e, { name, settings }) => {
  const problems = launchSettings.validate(settings);
  if (problems.length) throw new Error(problems.join('. '));
  return saveGamePreset(name, settings);
});
ipcMain.handle('gamePresets:delete', async (e, id) => deleteGamePreset(id));
ipcMain.handle('serverPresets:get', async (e, { mcVersion, loader, ip }) => {
  const address = serverList.parseAddress(ip);
  return address ? getServerPreset(mcVersion, loader, address.value) : null;
});
ipcMain.handle('serverPresets:save', async (e, { mcVersion, loader, ip, name, settings }) => {
  const address = serverList.parseAddress(ip);
  if (!address) throw new Error('Неверный адрес сервера');
  const problems = launchSettings.validate(settings);
  if (problems.length) throw new Error(problems.join('. '));
  return saveServerPreset(mcVersion, loader, address.value, name, settings);
});
ipcMain.handle('serverPresets:delete', async (e, { mcVersion, loader, ip }) => {
  const address = serverList.parseAddress(ip);
  if (!address) throw new Error('Неверный адрес сервера');
  return deleteServerPreset(mcVersion, loader, address.value);
});

ipcMain.handle('launchSettings:pickJava', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }]
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('logs:share', async (e, text) => {
  if (typeof text !== 'string') throw new Error('Лог пуст');
  return uploadLog(text);
});

ipcMain.handle('settings:get', async () => ({
  gameDir: getGameDir(),
  lastVersion: store.get('lastVersion'),
  lastLoader: store.get('lastLoader'),
  memoryMax: store.get('memoryMax'),
  memoryMin: store.get('memoryMin'),
  theme: store.get('theme'),
  themeMode: store.get('themeMode'),
  javaPath: store.get('javaPath'),
  jvmArgs: store.get('jvmArgs'),
  gameWidth: store.get('gameWidth'),
  gameHeight: store.get('gameHeight'),
  fullscreen: store.get('fullscreen'),
  launcherWidth: store.get('launcherWidth', 1280),
  launcherHeight: store.get('launcherHeight', 800),
  discordRPC: store.get('discordRPC'),
  afterLaunch: store.get('afterLaunch'),
  debugMode: store.get('debugMode'),
  gameLogsEnabled: store.get('gameLogsEnabled', true),
  gpuPreference: store.get('gpuPreference'),
  favoriteVersions: store.get('favoriteVersions'),
  themeCustom: store.get('themeCustom'),
  notificationsEnabled: store.get('notificationsEnabled'),
  notificationSoundVolume: store.get('notificationSoundVolume', 0.5),
  notificationMode: store.get('notificationMode', 'internal'),
  customNotificationSounds: store.get('customNotificationSounds', {}),
  minimizeToTray: store.get('minimizeToTray'),
  customIconPath: store.get('customIconPath') || null,
  backupSavesBeforeReinstall: store.get('backupSavesBeforeReinstall', true),
  onboardingCompleted: store.get('onboardingCompleted', false),
  activeBuild: getActiveBuild(),
  customSkinLoaderEnabled: getCustomSkinLoaderEnabled(),
  syntThemeUnlocked: store.get('syntThemeUnlocked', false),
  language: store.get('language', 'ru'),
  curseforgeApiKey: getCurseforgeApiKey()
}));

ipcMain.handle('settings:setLanguage', async (e, language) => {
  store.set('language', language === 'en' ? 'en' : 'ru');
});

// --- перенос настроек лаунчера между компьютерами ---
ipcMain.handle('settings:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Экспорт настроек лаунчера',
    defaultPath: path.join(app.getPath('documents'), 'fcore-settings.json'),
    filters: [{ name: 'Настройки FCore Launcher', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  const data = settingsTransfer.exportSettings(key => store.get(key), app.getVersion());
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
  return { ok: true, path: result.filePath, count: Object.keys(data.settings).length };
});

ipcMain.handle('settings:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Импорт настроек лаунчера',
    filters: [{ name: 'Настройки FCore Launcher', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };

  const file = result.filePaths[0];
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('Файл слишком большой для файла настроек');

  const { settings, skipped } = settingsTransfer.parseImport(fs.readFileSync(file, 'utf-8'));
  for (const [key, value] of Object.entries(settings)) store.set(key, value);
  return { ok: true, applied: Object.keys(settings).length, skipped };
});

ipcMain.handle('app:relaunch', async () => {
  isQuitting = true;
  app.relaunch();
  app.quit();
});

ipcMain.handle('settings:setCurseforgeApiKey', async (e, key) => {
  return setCurseforgeApiKey(key);
});

ipcMain.handle('settings:setTheme', async (e, theme) => {
  store.set('theme', theme);
});

ipcMain.handle('settings:unlockSyntTheme', async () => {
  store.set('syntThemeUnlocked', true);
  store.set('theme', 'synt');
});

ipcMain.handle('settings:setCustomSkinLoaderEnabled', async (e, enabled) => {
  return setCustomSkinLoaderEnabled(enabled);
});

ipcMain.handle('settings:setOnboardingCompleted', async (e, completed) => {
  store.set('onboardingCompleted', completed);
});

ipcMain.handle('settings:setThemeMode', async (e, mode) => {
  store.set('themeMode', mode);
});

ipcMain.handle('settings:setThemeCustom', async (e, hex) => {
  store.set('themeCustom', hex);
  store.set('theme', 'custom');
});

// ---------- оформление лаунчера ----------
const APPEARANCE_BG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

function removeAppearanceBackgrounds(except) {
  const dir = path.join(app.getPath('userData'), 'backgrounds');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  names.filter(n => n.startsWith('appearance-') && path.join(dir, n) !== except).forEach(n => {
    try { fs.unlinkSync(path.join(dir, n)); } catch {}
  });
}

ipcMain.handle('appearance:get', async () => getAppearance());

ipcMain.handle('appearance:set', async (e, config) => setAppearance(config));

ipcMain.handle('appearance:listPresets', async () => getAppearancePresets());

ipcMain.handle('appearance:savePreset', async (e, preset) => saveAppearancePreset(preset));

ipcMain.handle('appearance:deletePreset', async (e, id) => deleteAppearancePreset(String(id)));

ipcMain.handle('appearance:pickBackground', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const src = res.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!APPEARANCE_BG_EXTS.includes(ext)) return null;
  const dir = path.join(app.getPath('userData'), 'backgrounds');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `appearance-${Date.now()}${ext}`);
  fs.copyFileSync(src, dest);
  removeAppearanceBackgrounds(dest);
  return dest;
});

ipcMain.handle('appearance:clearBackground', async () => {
  removeAppearanceBackgrounds(null);
  return null;
});

const APPEARANCE_FONT_EXTS = ['.woff2', '.woff', '.ttf', '.otf'];
const APPEARANCE_FONT_MAX_BYTES = 15 * 1024 * 1024;

ipcMain.handle('appearance:pickFont', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Файлы шрифтов', extensions: ['woff2', 'woff', 'ttf', 'otf'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const source = res.filePaths[0];
  const ext = path.extname(source).toLowerCase();
  if (!APPEARANCE_FONT_EXTS.includes(ext)) throw new Error('Поддерживаются WOFF2, WOFF, TTF и OTF');
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size <= 0 || stat.size > APPEARANCE_FONT_MAX_BYTES) {
    throw new Error('Файл шрифта пустой или превышает 15 МБ');
  }
  const dir = path.join(app.getPath('userData'), 'custom-fonts');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `fcore-custom-${Date.now()}${ext}`;
  const destination = path.join(dir, fileName);
  fs.copyFileSync(source, destination);
  const familyName = path.basename(source, ext)
    .replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'FCore Custom';
  return { fileName, familyName };
});

ipcMain.handle('appearance:getFontUrl', async (e, fileName) => {
  const safeName = typeof fileName === 'string' && /^[a-z0-9_-]{1,48}\.(?:woff2?|ttf|otf)$/i.test(fileName)
    ? fileName : null;
  if (!safeName) return null;
  const dir = path.join(app.getPath('userData'), 'custom-fonts');
  const target = path.join(dir, safeName);
  if (!target.startsWith(dir + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return pathToFileURL(target).href;
});

// ---------- градиент лаунчера и цвет отдельных сборок ----------
ipcMain.handle('gradient:get', async () => getGradient());

ipcMain.handle('gradient:set', async (e, config) => setGradient(config));

ipcMain.handle('instance:getAccent', async (e, { mcVersion, loader }) => getInstanceAccent(mcVersion, loader));

ipcMain.handle('instance:setAccent', async (e, { mcVersion, loader, accent }) => setInstanceAccent(mcVersion, loader, accent));

ipcMain.handle('instance:listAccents', async () => listInstanceAccents());

ipcMain.handle('settings:setNotifications', async (e, enabled) => {
  store.set('notificationsEnabled', enabled);
});

ipcMain.handle('settings:setNotificationMode', async (e, mode) => {
  const value = ['internal', 'external'].includes(mode) ? mode : 'internal';
  store.set('notificationMode', value);
  return value;
});

ipcMain.handle('settings:setNotificationSoundVolume', async (e, volume) => {
  const value = Math.max(0, Math.min(1, Number(volume) || 0));
  store.set('notificationSoundVolume', value);
  return value;
});

ipcMain.handle('settings:pickNotificationSound', async (e, soundName) => {
  const allowed = ['notification', 'warning', 'repair', 'update'];
  if (!allowed.includes(soundName)) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Аудиофайлы', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const src = res.filePaths[0];
  const ext = path.extname(src) || '.mp3';
  const dest = path.join(app.getPath('userData'), `custom-sound-${soundName}${ext}`);
  fs.copyFileSync(src, dest);
  const sounds = store.get('customNotificationSounds', {});
  sounds[soundName] = dest;
  store.set('customNotificationSounds', sounds);
  return dest;
});

ipcMain.handle('settings:resetNotificationSound', async (e, soundName) => {
  const allowed = ['notification', 'warning', 'repair', 'update'];
  if (!allowed.includes(soundName)) return false;
  const sounds = store.get('customNotificationSounds', {});
  if (sounds[soundName]) { try { fs.unlinkSync(sounds[soundName]); } catch {} }
  delete sounds[soundName];
  store.set('customNotificationSounds', sounds);
  return true;
});

ipcMain.handle('settings:setMinimizeToTray', async (e, enabled) => {
  store.set('minimizeToTray', enabled);
});

// --- своя иконка лаунчера, выбранная из галереи ---

ipcMain.handle('settings:setCustomIcon', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'ico'] }]
  });
  if (res.canceled) return null;

  const src = res.filePaths[0];
  const ext = path.extname(src) || '.png';
  const dest = path.join(app.getPath('userData'), `custom-icon${ext}`);
  fs.copyFileSync(src, dest);
  store.set('customIconPath', dest);

  mainWindow.setIcon(dest);
  if (tray) tray.setImage(dest);

  return dest;
});

ipcMain.handle('settings:resetIcon', async () => {
  store.delete('customIconPath');
  const defaultIcon = path.join(__dirname, 'build', 'icon.png');
  mainWindow.setIcon(defaultIcon);
  if (tray) tray.setImage(defaultIcon);
  return defaultIcon;
});

// имя файла фона берём из ключа инстанса: у сборки это build-<id>, иначе версия-загрузчик.
// Раньше было просто версия-загрузчик, и две сборки на одной версии перезаписывали один файл
function backgroundFileKey(mcVersion, loader) {
  return String(instanceKey(mcVersion, loader)).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// удаляем картинку только если на неё не ссылается другой инстанс
function removeBackgroundFile(file, exceptKey) {
  if (!file || !fs.existsSync(file)) return;
  const instances = store.get('instances') || {};
  const used = Object.entries(instances).some(([k, v]) => k !== exceptKey && v && v.backgroundPath === file);
  if (!used) { try { fs.unlinkSync(file); } catch {} }
}

// сохраняем выбор сразу при переключении в UI, а не только при запуске игры —
// иначе после перезапуска лаунчера выбор всегда слетал на версию по умолчанию
ipcMain.handle('instance:getBackground', async (e, { mcVersion, loader }) => {
  const backgroundPath = getInstanceBackground(mcVersion, loader);
  if (!backgroundPath || !fs.existsSync(backgroundPath)) return null;
  try {
    const ext = path.extname(backgroundPath).toLowerCase();
    const mime = ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'})[ext] || 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(backgroundPath).toString('base64')}`;
  } catch {
    return null;
  }
});

ipcMain.handle('instance:setBackground', async (e, { mcVersion, loader }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });
  if (res.canceled) return null;
  const src = res.filePaths[0];
  const backgroundsDir = path.join(app.getPath('userData'), 'backgrounds');
  fs.mkdirSync(backgroundsDir, { recursive: true });
  const safeKey = backgroundFileKey(mcVersion, loader);
  const ext = path.extname(src).toLowerCase() || '.png';
  const dest = path.join(backgroundsDir, `${safeKey}${ext}`);
  fs.copyFileSync(src, dest);
  // Remove an older extension for the same instance.
  for (const oldExt of ['.png', '.jpg', '.jpeg', '.webp']) {
    const old = path.join(backgroundsDir, `${safeKey}${oldExt}`);
    if (old !== dest && fs.existsSync(old)) { try { fs.unlinkSync(old); } catch {} }
  }
  setInstanceBackground(mcVersion, loader, dest);
  return dest;
});

ipcMain.handle('instance:setBackgroundData', async (e, { mcVersion, loader, dataUrl }) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const mime = match[1];
  const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
  const backgroundsDir = path.join(app.getPath('userData'), 'backgrounds');
  fs.mkdirSync(backgroundsDir, { recursive: true });
  const safeKey = backgroundFileKey(mcVersion, loader);
  const dest = path.join(backgroundsDir, `${safeKey}${ext}`);
  fs.writeFileSync(dest, Buffer.from(match[2], 'base64'));
  for (const oldExt of ['.png', '.jpg', '.jpeg', '.webp']) {
    const old = path.join(backgroundsDir, `${safeKey}${oldExt}`);
    if (old !== dest && fs.existsSync(old)) { try { fs.unlinkSync(old); } catch {} }
  }
  setInstanceBackground(mcVersion, loader, dest);
  return `data:${mime};base64,${match[2]}`;
});

ipcMain.handle('instance:resetBackground', async (e, { mcVersion, loader }) => {
  const old = getInstanceBackground(mcVersion, loader);
  setInstanceBackground(mcVersion, loader, null);
  removeBackgroundFile(old, instanceKey(mcVersion, loader));
  return null;
});

ipcMain.handle('settings:setLastSelection', async (e, { mcVersion, loader }) => {
  store.set('lastVersion', mcVersion);
  store.set('lastLoader', loader);
  refreshTrayMenu();
});

ipcMain.handle('settings:setGameDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled) return getGameDir();
  store.set('gameDir', res.filePaths[0]);
  return res.filePaths[0];
});

ipcMain.handle('settings:setMemory', async (e, { min, max }) => {
  store.set('memoryMin', min);
  store.set('memoryMax', max);
});

// свободное место на диске, где лежит папка с игрой — для плитки на главной
ipcMain.handle('system:getDiskInfo', async () => {
  try {
    const dir = getGameDir();
    const target = fs.existsSync(dir) ? dir : path.parse(dir).root;
    const st = await fs.promises.statfs(target);
    const bsize = Number(st.bsize);
    return { freeBytes: Number(st.bavail) * bsize, totalBytes: Number(st.blocks) * bsize };
  } catch (err) {
    console.warn('[disk] не удалось получить свободное место:', err.message);
    return null;
  }
});

// сборки (версия + загрузчик), с которыми пользователь уже что-то делал, —
// для блока «Недавние сборки» на главной. Сначала самые свежие по запуску.
ipcMain.handle('instances:listRecent', async () => {
  const all = store.get('instances') || {};
  const list = [];
  for (const key of Object.keys(all)) {
    const m = key.match(/^(.*)-(fabric|forge|neoforge|vanilla)$/);
    if (!m) continue;
    const inst = all[key] || {};
    const touched = (inst.launchCount || 0) > 0 || inst.lastPlayedAt || inst.backgroundPath
      || (inst.wantedMods || []).length || (inst.totalPlaytimeMs || 0) > 0;
    if (!touched) continue;
    list.push({
      mcVersion: m[1],
      loader: m[2],
      launchCount: inst.launchCount || 0,
      playtimeMs: inst.totalPlaytimeMs || 0,
      lastPlayedAt: inst.lastPlayedAt || 0,
      hasBackground: Boolean(inst.backgroundPath)
    });
  }
  list.sort((a, b) => (b.lastPlayedAt - a.lastPlayedAt) || (b.launchCount - a.launchCount) || (b.playtimeMs - a.playtimeMs));
  return list;
});

// для автоподбора памяти в настройках — сколько ОЗУ вообще есть в системе
ipcMain.handle('system:getMemoryInfo', async () => ({
  totalBytes: os.totalmem(),
  freeBytes: os.freemem()
}));

ipcMain.handle('settings:setJavaPath', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }]
  });
  if (res.canceled) return store.get('javaPath');
  store.set('javaPath', res.filePaths[0]);
  return res.filePaths[0];
});

ipcMain.handle('settings:clearJavaPath', async () => {
  store.set('javaPath', null);
});

// ручная проверка «подойдёт ли выбранная java» из настроек — до запуска игры,
// а не после мутного краша
ipcMain.handle('settings:checkJava', async (e, mcVersion) => {
  const javaPath = store.get('javaPath');
  if (!javaPath) {
    return { ok: true, message: 'Используется встроенная Java — подбирается автоматически, всё будет ок' };
  }
  return launcher.checkJavaCompatibility(javaPath, mcVersion);
});

// --- управление автоматически скачанными JDK ---

ipcMain.handle('java:list', async () => {
  const root = getGameDir();
  return javaManager.listInstalledJava(root);
});

ipcMain.handle('java:install', async (e, major) => {
  const root = getGameDir();
  await javaManager.installJava(root, major, progress => {
    sendToWindow('java:progress', progress);
  });
  return javaManager.listInstalledJava(root);
});

ipcMain.handle('java:delete', async (e, major) => {
  const root = getGameDir();
  javaManager.deleteJava(root, major);
  return javaManager.listInstalledJava(root);
});

ipcMain.handle('settings:setJvmArgs', async (e, args) => {
  store.set('jvmArgs', args);
});

ipcMain.handle('settings:setWindowSize', async (e, { width, height, fullscreen }) => {
  store.set('gameWidth', width);
  store.set('gameHeight', height);
  store.set('fullscreen', fullscreen);
});

ipcMain.handle('settings:setLauncherSize', async (e, { width, height }) => {
  const clampedWidth = Math.max(width, MIN_LAUNCHER_WIDTH);
  const clampedHeight = Math.max(height, MIN_LAUNCHER_HEIGHT);
  store.set('launcherWidth', clampedWidth);
  store.set('launcherHeight', clampedHeight);
  if (mainWindow) mainWindow.setSize(clampedWidth, clampedHeight);
  return { width: clampedWidth, height: clampedHeight };
});

ipcMain.handle('settings:setDiscordRPC', async (e, enabled) => {
  store.set('discordRPC', enabled);
  if (enabled) {
    await discordRPC.init();
    discordRPC.setMenu();
  } else {
    discordRPC.shutdown();
  }
});

ipcMain.handle('settings:setGameLogsEnabled', async (e, enabled) => {
  store.set('gameLogsEnabled', enabled);
});

ipcMain.handle('settings:setAfterLaunch', async (e, behavior) => {
  store.set('afterLaunch', behavior);
});

ipcMain.handle('settings:setDebugMode', async (e, enabled) => {
  store.set('debugMode', enabled);
  if (enabled) mainWindow.webContents.openDevTools({ mode: 'detach' });
  else mainWindow.webContents.closeDevTools();
});

ipcMain.handle('settings:setGpuPreference', async (e, preference) => {
  store.set('gpuPreference', preference);
});

ipcMain.handle('folders:open', async (e, { mcVersion, loader, which }) => {
  const root = getGameDir();
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);

  const targets = {
    game: instanceDir,
    mods: modManager.getModsDir(root, mcVersion, loader),
    resourcepacks: resourcePackManager.getResourcePacksDir(root, mcVersion, loader),
    screenshots: path.join(instanceDir, 'screenshots'),
    saves: worldManager.getSavesDir(root, mcVersion, loader),
    root, // корневая папка лаунчера (аналог .minecraft), общая для всех сборок
    logs: path.join(instanceDir, 'logs')
  };

  const dir = targets[which] || instanceDir;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

ipcMain.handle('game:openAuthlibLog', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  const logPath = path.join(instanceDir, 'authlib-injector.log');
  if (!fs.existsSync(logPath)) return false;
  shell.openPath(logPath);
  return true;
});

ipcMain.handle('instance:export', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const zipPath = await exportInstance(root, mcVersion, loader);
  shell.showItemInFolder(zipPath);
  return zipPath;
});

ipcMain.handle('instance:importFromFile', async (e, { mcVersion, loader }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Сборка FCore Launcher', extensions: ['zip'] }]
  });
  if (res.canceled) return null;

  const root = getGameDir();
  return await importInstanceFromZip(root, mcVersion, loader, res.filePaths[0]);
});

// то же самое, но путь к zip уже известен (перетащили файл на окно) — без диалога выбора
ipcMain.handle('instance:importFromPath', async (e, { mcVersion, loader, filePath }) => {
  const root = getGameDir();
  return await importInstanceFromZip(root, mcVersion, loader, filePath);
});

ipcMain.handle('instance:importFromUrl', async (e, { mcVersion, loader, url }) => {
  const root = getGameDir();
  return importInstanceFromUrl(root, mcVersion, loader, url);
});

ipcMain.handle('instance:getPlaytime', async (e, { mcVersion, loader }) => {
  return getPlaytime(mcVersion, loader);
});

ipcMain.handle('instance:getLaunchStats', async (e, { mcVersion, loader }) => {
  return getLaunchStats(mcVersion, loader);
});

ipcMain.handle('gamingActivity:getOverview', async () => {
  const allInstances = store.get('instances') || {};
  const builds = listBuilds();
  const buildById = new Map(builds.map(build => [build.id, build]));
  const instances = [];
  let totalPlaytimeMs = 0;

  for (const [key, instance] of Object.entries(allInstances)) {
    const stats = instance || {};
    const playtimeMs = Math.max(0, Number(stats.totalPlaytimeMs) || 0);
    totalPlaytimeMs += playtimeMs;
    if (!stats.launchCount && !stats.lastPlayedAt && !playtimeMs) continue;
    const buildMatch = key.match(/^build-(.+)$/);
    if (buildMatch) {
      const build = buildById.get(buildMatch[1]);
      instances.push({
        key: `build:${buildMatch[1]}`, buildId: buildMatch[1],
        name: build?.name || `Удалённая сборка ${buildMatch[1].slice(0, 6)}`,
        mcVersion: build?.mcVersion || null, loader: build?.loader || null,
        launchCount: stats.launchCount || 0, playtimeMs, lastPlayedAt: stats.lastPlayedAt || 0
      });
      continue;
    }
    const versionMatch = key.match(/^(.*)-(fabric|forge|neoforge|vanilla)$/);
    if (!versionMatch) continue;
    const [, version, instanceLoader] = versionMatch;
    instances.push({
      key: `instance:${version}|${instanceLoader}`,
      name: `Minecraft ${version} (${instanceLoader})`,
      mcVersion: version, loader: instanceLoader,
      launchCount: stats.launchCount || 0, playtimeMs, lastPlayedAt: stats.lastPlayedAt || 0
    });
  }

  return gamingActivity.getOverview({
    totalLaunches: store.get('totalLaunches') || 0,
    totalPlaytimeMs, instances
  });
});

// --- экспорт/импорт .mrpack (стандарт Modrinth, отдельно от своего формата выше) ---

ipcMain.handle('mrpack:export', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const result = await exportMrpack(root, mcVersion, loader);
  shell.showItemInFolder(result.mrpackPath);
  return result;
});

ipcMain.handle('mrpack:importFromFile', async (e, { mcVersion, loader }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }]
  });
  if (res.canceled) return null;

  const root = getGameDir();
  return await importMrpack(root, mcVersion, loader, res.filePaths[0]);
});

ipcMain.handle('mrpack:importFromPath', async (e, { mcVersion, loader, filePath }) => {
  const root = getGameDir();
  return await importMrpack(root, mcVersion, loader, filePath);
});

ipcMain.handle('curseforgeModpack:importFromFile', async (e, { mcVersion, loader }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CurseForge modpack', extensions: ['zip'] }]
  });
  if (res.canceled) return null;

  const root = getGameDir();
  return await importCurseforgeModpack(root, mcVersion, loader, res.filePaths[0]);
});

// --- крашлоги ---

ipcMain.handle('crash:list', async () => {
  const root = getGameDir();
  return listCrashReports(root);
});

ipcMain.handle('crash:read', async (e, filePath) => {
  const root = getGameDir();
  // на всякий случай не даём читать произвольный путь с диска — только из папки крашлогов
  const crashDir = getCrashDir(root);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(crashDir))) throw new Error('Недопустимый путь');
  return fs.readFileSync(resolved, 'utf-8');
});

ipcMain.handle('crash:openFolder', async () => {
  const root = getGameDir();
  shell.openPath(getCrashDir(root));
});

// --- авто-починка модов ---

// Анализ уже сохранённого отчёта лаунчера (кнопка «Разобрать» в списке крашей).
// Версию и загрузчик берём из заголовка файла, который пишет crashReporter.
ipcMain.handle('crash:analyzeReport', async (e, filePath) => {
  const root = getGameDir();
  const crashDir = path.resolve(getCrashDir(root));
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved.startsWith(crashDir + path.sep)) throw new Error('Недопустимый путь');

  const text = fs.readFileSync(resolved, 'utf-8');
  const ver = text.match(/^Версия:\s*(.+?)\s*\(([^)]+)\)\s*$/m);
  if (!ver) throw new Error('Не удалось определить версию игры из отчёта');
  const code = Number((text.match(/^Код завершения:\s*(-?\d+)/m) || [])[1]);
  const marker = '--- последние строки лога ---';
  const tail = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length).split('\n') : [];
  const endedAt = fs.statSync(resolved).mtimeMs;

  return crashAnalyzer.analyzeCrash({
    root, mcVersion: ver[1], loader: ver[2], code: Number.isFinite(code) ? code : undefined,
    recentLines: tail, startedAt: endedAt - 30 * 60 * 1000, endedAt
  });
});

// Применить исправление: отключаем файлы (X.jar → X.jar.disabled), пишем в журнал для отката
ipcMain.handle('crash:applyFix', async (e, { mcVersion, loader, fileNames, reason }) => {
  const root = getGameDir();
  const entry = crashAnalyzer.applyFix(root, { mcVersion, loader, fileNames, reason });
  return { entry, installed: modManager.listInstalledMods(root, mcVersion, loader) };
});

ipcMain.handle('crash:undoFix', async (e, { fixId, mcVersion, loader }) => {
  const root = getGameDir();
  const res = crashAnalyzer.undoFix(root, fixId);
  return { ...res, installed: modManager.listInstalledMods(root, mcVersion, loader) };
});

ipcMain.handle('crash:listFixes', async (e, { mcVersion, loader }) => {
  return crashAnalyzer.listFixes(getGameDir(), { mcVersion, loader });
});

// --- дерево зависимостей модов ---

async function buildModGraph(mcVersion, loader) {
  const root = getGameDir();
  const scan = await modIndex.scanModsDir(modManager.getModsDir(root, mcVersion, loader), { loader });
  return { scan, graph: modGraph.buildGraph(scan, { mcVersion }) };
}

// Полная модель для окна «Зависимости»: моды, их связи в обе стороны, текущие проблемы.
// libraryFiles — имена файлов, помеченных в UI как «зависимость»: их предлагаем отключить заодно,
// если после отключения мода они больше никому не нужны.
ipcMain.handle('mods:graph', async (e, { mcVersion, loader, libraryFiles }) => {
  const { scan, graph } = await buildModGraph(mcVersion, loader);
  const ui = modGraph.toUi(graph, scan, { libraryHints: new Set(Array.isArray(libraryFiles) ? libraryFiles : []) });
  const duplicateFiles = await modConflictDetector.findExactDuplicateFiles(modManager.getModsDir(getGameDir(), mcVersion, loader));
  ui.duplicateFiles = duplicateFiles;
  for (const group of duplicateFiles.filter(item => item.enabledCount > 1)) {
    ui.problems.push({ type: 'duplicate-content', files: group.files.filter(f => f.enabled).map(f => f.diskName), sizeBytes: group.sizeBytes });
  }
  return ui;
});

ipcMain.handle('mods:simulateDisable', async (e, { mcVersion, loader, fileNames, libraryFiles }) => {
  const names = (Array.isArray(fileNames) ? fileNames : []).filter(crashAnalyzer.safeBase);
  const { graph } = await buildModGraph(mcVersion, loader);
  return modGraph.simulateDisable(graph, names, { libraryHints: new Set(Array.isArray(libraryFiles) ? libraryFiles : []) });
});

ipcMain.handle('mods:simulateEnable', async (e, { mcVersion, loader, fileName }) => {
  if (!crashAnalyzer.safeBase(fileName)) return null;
  const { graph } = await buildModGraph(mcVersion, loader);
  return modGraph.simulateEnable(graph, fileName);
});

// отключение нескольких модов разом («вместе с зависимыми») — возвращает свежий список файлов
ipcMain.handle('mods:disableMany', async (e, { mcVersion, loader, fileNames }) => {
  const root = getGameDir();
  for (const f of (Array.isArray(fileNames) ? fileNames : []).filter(crashAnalyzer.safeBase)) {
    modManager.setModEnabled(root, mcVersion, loader, f, false);
  }
  return modManager.listInstalledMods(root, mcVersion, loader);
});

// --- метрики ресурсов ---

ipcMain.handle('metrics:list', async (e, { mcVersion, loader }) => {
  return resourceMetrics.listRuns(getGameDir(), mcVersion, loader);
});

ipcMain.handle('metrics:get', async (e, { mcVersion, loader, runId }) => {
  return resourceMetrics.getRun(getGameDir(), mcVersion, loader, runId);
});

ipcMain.handle('metrics:clear', async (e, { mcVersion, loader }) => {
  resourceMetrics.clearRuns(getGameDir(), mcVersion, loader);
  return true;
});

// --- анализ занимаемого места ---
ipcMain.handle('storage:analyze', async () => storageAnalyzer.analyzeStorage(getGameDir(), listBuilds()));

// --- галерея скриншотов ---

function resolveScreenshotPath(root, filePath) {
  const instancesRoot = screenshotManager.getInstancesRoot(root);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(instancesRoot))) throw new Error('Недопустимый путь');
  return resolved;
}

ipcMain.handle('screenshots:list', async () => {
  const root = getGameDir();
  const favorites = store.get('favoriteScreenshots') || [];
  const buildNames = Object.fromEntries(listBuilds().flatMap(b => [[`build-${b.id}`, `${b.name} (${b.mcVersion} ${b.loader})`], [buildFolder.dirOf(b), `${b.name} (${b.mcVersion} ${b.loader})`]]));
  const shots = screenshotManager.listScreenshots(root)
    .map(s => ({ ...s, instance: buildNames[s.instance] || s.instance, favorite: favorites.includes(s.filePath) }));

  shots.sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return b.mtime - a.mtime;
  });

  return shots;
});

ipcMain.handle('screenshots:toggleFavorite', async (e, filePath) => {
  const root = getGameDir();
  resolveScreenshotPath(root, filePath);
  return toggleFavoriteScreenshot(filePath);
});

ipcMain.handle('screenshots:delete', async (e, filePath) => {
  const root = getGameDir();
  const resolved = resolveScreenshotPath(root, filePath);
  screenshotManager.deleteScreenshot(resolved);
  removeFavoriteScreenshot(filePath);
});

ipcMain.handle('screenshots:openFile', async (e, filePath) => {
  const root = getGameDir();
  const resolved = resolveScreenshotPath(root, filePath);
  shell.openPath(resolved);
});

ipcMain.handle('screenshots:openFolder', async (e, filePath) => {
  const root = getGameDir();
  const resolved = resolveScreenshotPath(root, filePath);
  shell.showItemInFolder(resolved);
});

// --- бэкапы миров ---

ipcMain.handle('backups:list', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return backupManager.listBackups(root, mcVersion, loader);
});

ipcMain.handle('backups:openFolder', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  shell.openPath(backupManager.getBackupsDir(root, mcVersion, loader));
});

ipcMain.handle('backups:makeNow', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const backupPath = await backupManager.backupSaves(root, mcVersion, loader, 'manual');
  if (!backupPath) throw new Error('Папка с мирами пуста или ещё не создана — нечего бэкапить');
  return backupPath;
});

ipcMain.handle('settings:setBackupSaves', async (e, enabled) => {
  store.set('backupSavesBeforeReinstall', !!enabled);
});

// --- миры (saves): список, папка, переименование, удаление ---

ipcMain.handle('worlds:list', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return worldManager.listWorlds(root, mcVersion, loader);
});

ipcMain.handle('servers:list', async (e, { mcVersion, loader }) => {
  return serverList.listServers(modManager.getInstanceDir(getGameDir(), mcVersion, loader));
});

ipcMain.handle('servers:add', async (e, { mcVersion, loader, name, ip }) => {
  return serverList.addServer(modManager.getInstanceDir(getGameDir(), mcVersion, loader), { name, ip });
});

ipcMain.handle('servers:edit', async (e, { mcVersion, loader, index, name, ip }) => {
  return serverList.editServer(modManager.getInstanceDir(getGameDir(), mcVersion, loader), Number(index), { name, ip });
});

ipcMain.handle('servers:remove', async (e, { mcVersion, loader, index }) => {
  return serverList.removeServer(modManager.getInstanceDir(getGameDir(), mcVersion, loader), Number(index));
});

ipcMain.handle('servers:ping', async (e, ip) => {
  const address = serverList.parseAddress(ip);
  if (!address) throw new Error('Неверный адрес сервера');
  return serverPing.pingServer(address.host, address.port, 4000);
});

ipcMain.handle('worlds:openFolder', async (e, { mcVersion, loader, folderName }) => {
  const root = getGameDir();
  const worldDir = path.join(worldManager.getSavesDir(root, mcVersion, loader), folderName);
  shell.openPath(worldDir);
});

ipcMain.handle('worlds:rename', async (e, { mcVersion, loader, folderName, newName }) => {
  const root = getGameDir();
  return worldManager.renameWorld(root, mcVersion, loader, folderName, newName);
});

ipcMain.handle('worlds:delete', async (e, { mcVersion, loader, folderName }) => {
  const root = getGameDir();
  const backupPath = await worldManager.deleteWorld(root, mcVersion, loader, folderName);
  return { backupPath };
});

// --- Build Snapshots 2.0: full build state snapshots and safe restoration ---

ipcMain.handle('buildBackups:list', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return buildBackup.listBuildBackups(root, mcVersion, loader);
});

ipcMain.handle('buildBackups:openFolder', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  shell.openPath(buildBackup.getBuildBackupsDir(root, mcVersion, loader));
});

ipcMain.handle('buildBackups:makeNow', async (e, { mcVersion, loader, name }) => {
  const root = getGameDir();
  const snapshotPath = await buildBackup.createBuildSnapshot(root, mcVersion, loader, { name });
  if (!snapshotPath) throw new Error('В этой сборке пока нечего сохранять');
  return snapshotPath;
});

ipcMain.handle('buildBackups:delete', async (e, { mcVersion, loader, backupPath }) => {
  const root = getGameDir();
  return buildBackup.deleteBuildBackup(root, mcVersion, loader, backupPath);
});

ipcMain.handle('buildBackups:rollback', async (e, { mcVersion, loader, backupPath }) => {
  const root = getGameDir();
  const result = await buildBackup.restoreBuildSnapshot(root, mcVersion, loader, backupPath);
  notify('Снимок восстановлен', `Моды: ${result.modsRestored}, ресурспаки: ${result.packsRestored}, шейдеры: ${result.shadersRestored}`);
  return result;
});

// проверка целостности сборки: core-файлы майна + сверка модов/ресурспаков
// по хэшам, без скачивания (dryRun) — просто отчёт, что не так
ipcMain.handle('game:verify', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);

  const core = launcher.verifyCoreFiles(root, mcVersion);
  const mods = await modManager.reinstallMods(root, mcVersion, loader, inst.wantedMods, () => {}, true);
  const resourcepacks = await resourcePackManager.reinstallResourcePacks(root, mcVersion, loader, inst.wantedResourcePacks, () => {}, true);

  return { core, mods, resourcepacks };
});

// то же самое, но сразу чинит найденные проблемы:
// - битые/неполные core-файлы (клиент/версия) — удаляем папку версии, чтобы
//   майнкрафт-лаунчер-core гарантированно перекачал её с нуля при следующем запуске
//   (библиотеки и ассеты mclc и так проверяет по хэшам при каждом запуске сам,
//   поэтому их отдельно трогать не нужно)
// - моды/ресурспаки, которые не совпадают с сохранённым списком — просто
//   по-настоящему переустанавливаем (не dry-run), переиспользуя обычный путь установки
ipcMain.handle('game:verifyAndFix', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);

  const core = launcher.verifyCoreFiles(root, mcVersion);
  let coreFixed = false;

  if (!core.jarOk || !core.jsonOk) {
    const versionDir = path.join(root, 'versions', mcVersion);
    try {
      if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true });
      coreFixed = true;
    } catch (err) {
      console.error('[verifyAndFix] не удалось удалить битую папку версии:', err.message);
    }
  }

  // снимок перед автопочинкой — если чинили не то, можно откатиться
  try {
    await buildBackup.backupBuild(root, mcVersion, loader, 'before-autofix');
  } catch (err) {
    console.error('[buildBackup] не удалось сохранить снимок перед автопочинкой:', err.message);
  }

  const mods = await modManager.reinstallMods(root, mcVersion, loader, inst.wantedMods, progress => {
    sendToWindow('mods:progress', progress);
  }, false);
  rememberModFileNames(mcVersion, loader, [...mods.installed, ...mods.skipped]);

  const resourcepacks = await resourcePackManager.reinstallResourcePacks(root, mcVersion, loader, inst.wantedResourcePacks, progress => {
    sendToWindow('resourcepacks:progress', progress);
  }, false);
  rememberResourcePackFileNames(mcVersion, loader, [...resourcepacks.installed, ...resourcepacks.skipped]);

  notify('Проверка и починка завершены', `Переустановлено модов: ${mods.installed.length}, ресурспаков: ${resourcepacks.installed.length}`);

  return {
    coreFixed,
    corePendingNote: !core.librariesOk || !core.assetsOk
      ? 'Библиотеки/ассеты докачаются автоматически при следующем запуске игры'
      : null,
    mods,
    resourcepacks
  };
});

ipcMain.handle('app:changelog', async () => CHANGELOG);

ipcMain.handle('misc:openExternal', async (e, url) => {
  if (!isSafeExternalUrl(url)) return false;
  await shell.openExternal(String(url));
  return true;
});

ipcMain.handle('app:getVersion', async () => app.getVersion());

// кастомный тайтлбар
ipcMain.handle('notifications:show', (_event, data = {}) => {
  notify(String(data.title || 'FCore Launcher'), String(data.body || ''), data.type);
  return true;
});

ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximizeToggle', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window:isMaximized', () => (mainWindow ? mainWindow.isMaximized() : false));

ipcMain.handle('app:checkForUpdates', async () => {
  try {
    const result = await setupAutoUpdater().checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});