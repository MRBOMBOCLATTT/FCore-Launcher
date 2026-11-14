const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session, Tray, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require("crypto");
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = true;        // качаем сразу в фоне, без диалогов и лишних вопросов
autoUpdater.autoInstallOnAppQuit = true; // если скачано, но не установлено сразу — поставит при закрытии

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
  store, addAccount, getSelectedAccount, saveSelectedAccount, getInstance, setWantedMods, rememberModFileNames, setModPinned, setWantedResourcePacks, rememberResourcePackFileNames, setResourcePackPinned, setWantedShaders, rememberShaderFileNames,
  listInstances, listResourcePackInstances, instanceKey, toggleFavoriteVersion, listAccounts, selectAccount, removeAccount,
  listModpackProfiles, saveModpackProfile, renameModpackProfile, deleteModpackProfile,
  listResourcePackProfiles, saveResourcePackProfile, renameResourcePackProfile, deleteResourcePackProfile,
  getCommunityBuildUrl, setCommunityBuildUrl,
  getMeteorClientVersion, setMeteorClientVersion,
  getFabricLoaderVersion, setFabricLoaderVersion,
  toggleFavoriteScreenshot, removeFavoriteScreenshot,
  getCustomSkinLoaderEnabled, setCustomSkinLoaderEnabled
} = require('./src/store');
const { CHANGELOG } = require('./src/changelog');
const auth = require('./src/auth');
const msAuth = require('./src/msAuth');
const versions = require('./src/versions');
const modrinth = require('./src/modrinth');
const modManager = require('./src/modManager');
const backupManager = require('./src/backupManager');
const worldManager = require('./src/worldManager');
const buildBackup = require('./src/buildBackup');
const resourcePackManager = require('./src/resourcePackManager');
const shaderManager = require('./src/shaderManager');
const meteorClient = require('./src/meteorClient');
const identifyLocal = require('./src/identifyLocal');
const jarMetadata = require('./src/jarMetadata');
const launcher = require('./src/launcher');
const fabric = require('./src/fabric');
const instanceSettings = require('./src/instanceSettings');
const discordRPC = require('./src/discordRPC');
const serverPing = require('./src/serverPing');
const { exportInstance } = require('./src/exportInstance');
const { importInstanceFromZip, importInstanceFromUrl } = require('./src/importInstance');
const { listCrashReports, getCrashDir } = require('./src/crashReporter');
const screenshotManager = require('./src/screenshotManager');
const javaManager = require('./src/javaManager');

let mainWindow;
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

// Безопасная отправка в окно — не падает, если окно уже закрыто/уничтожено
function sendToWindow(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (err) {
    console.error(`[main] не удалось отправить в окно (${channel}):`, err.message);
  }
}

// Оборачиваем ipcMain.handle целиком (а не каждый из 60+ хендлеров по отдельности) —
// так любая ошибка внутри логируется на стороне процесса и уходит в рендерер
// чистым сообщением, а не сырым "Error invoking remote method ...".
const _originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  _originalIpcHandle(channel, async (...args) => {
    try {
      return await listener(...args);
    } catch (err) {
      console.error(`[ipc:${channel}] ошибка:`, err);
      throw new Error(err?.message || 'Неизвестная ошибка');
    }
  });
};

function notify(title, body) {
  try {
    if (!store.get('notificationsEnabled')) return;
    if (!Notification.isSupported()) return;
    new Notification({ title, body, icon: getCurrentIconPath() }).show();
  } catch (err) {
    console.error('[main] ошибка уведомления:', err.message);
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
    title: 'PFC Launcher',
    icon: getCurrentIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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
    notify('PFC Launcher перезапущен', `Интерфейс неожиданно завершился (${details.reason}) и был перезапущен`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[main] окно перестало отвечать');
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(getCurrentIconPath());
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('PFC Launcher');
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
    { label: 'Открыть PFC Launcher', click: () => mainWindow.show() },
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
async function performLaunch(mcVersion, loader) {
  await refreshSelectedAccountTokenIfNeeded();
  const account = getSelectedAccount();

  const authData = account ? account.mclcAuth : {
    access_token: 'offline', name: 'Player', uuid: '00000000-0000-0000-0000-000000000000',
    client_token: 'offline', user_properties: '{}'
  };

  const root = getGameDir();
  const memory = { max: store.get('memoryMax'), min: store.get('memoryMin') };
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

  const result = await launcher.launchGame({
    root,
    mcVersion,
    loader,
    loaderVersion: loader === 'fabric' ? getFabricLoaderVersion(mcVersion, loader) : null,
    logsEnabled: store.get('gameLogsEnabled', true),
    mclcAuth: authData,
    memory,
    javaPathOverride: store.get('javaPath'),
    jvmArgs: store.get('jvmArgs'),
    window: { width: store.get('gameWidth'), height: store.get('gameHeight'), fullscreen: store.get('fullscreen') },
    gpuPreference: store.get('gpuPreference'),
    onEvent: progress => {
      sendToWindow('game:progress', progress);
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
        stopServerPing();
        discordRPC.setMenu();
      }
      if (progress.stage === 'crash') notify('Игра завершилась с ошибкой', `Код ${progress.code}. Отчёт сохранён в crash-reports.`);
    }
  });

  discordRPC.setPlaying(mcVersion, loader, startedAt);
  notify('PFC Launcher', `Minecraft ${mcVersion} запущен`);

  const behavior = store.get('afterLaunch');
  if (behavior === 'close') { isQuitting = true; app.quit(); }
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
  createWindow();
  createTray();
  if (store.get('debugMode')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  await discordRPC.init();
  discordRPC.setMenu();
  ensureTokenRefreshTimer();

  setupAutoUpdater();
  // небольшая задержка, чтобы окно успело отрисоваться до диалогов обновления
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => console.error('[updater] проверка не удалась:', err));
  }, 3000);
});

// --- Автообновление (GitHub Releases) ---
// Никаких системных dialog.showMessageBox — всё обновление происходит в фоне
// молча, пользователь видит только своё окошко лаунчера, когда апдейт реально
// готов к установке (или маленький тост, если что-то пошло не так).
function setupAutoUpdater() {
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
}

ipcMain.handle('updater:installNow', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

app.on('before-quit', () => { isQuitting = true; });

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

ipcMain.handle('account:changeSkinMicrosoft', async (e, { filePath, variant }) => {
  const account = getSelectedAccount();
  if (!account || account.profile.type !== 'microsoft') {
    throw new Error('Смена скина доступна только для аккаунтов Microsoft');
  }

  // токен мог протухнуть — обновляем тем же способом, что и перед запуском игры
  if (account.mclcAuth?.meta?.type === 'msa' && account.mclcAuth.meta.refresh && !msAuth.isMicrosoftTokenValid(account.mclcAuth)) {
    try {
      account.mclcAuth = await msAuth.refreshMicrosoft(account.mclcAuth.meta.refresh);
      saveSelectedAccount(account);
    } catch (err) {
      console.warn('Не удалось обновить токен Microsoft перед сменой скина:', err.message);
    }
  }

  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('variant', variant === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'skin.png');

  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.mclcAuth.access_token}` },
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mojang отклонил запрос (${res.status}): ${text || res.statusText}`);
  }

  notify('Скин обновлён', 'Новый скин применён к аккаунту Microsoft');
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
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  elybySkinWindow.loadURL('https://ely.by/skins/add');
  elybySkinWindow.on('closed', () => {
    elybySkinWindow = null;
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

ipcMain.handle('mods:search', async (e, { query, mcVersion, loader, offset, sort, category }) => {
  return modrinth.searchMods(query, mcVersion, loader, 20, offset || 0, sort || 'relevance', category || '');
});

ipcMain.handle('mods:wanted', async (e, { mcVersion, loader }) => {
  return getInstance(mcVersion, loader).wantedMods;
});

ipcMain.handle('mods:add', async (e, { mcVersion, loader, projectId, title, icon }) => {
  const inst = getInstance(mcVersion, loader);
  if (!inst.wantedMods.some(m => m.projectId === projectId)) {
    inst.wantedMods.push({ projectId, title, icon });
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
ipcMain.handle('mods:addSpecificVersion', async (e, { mcVersion, loader, projectId, title, icon, versionId }) => {
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

    notify('Мод установлен', `${title}: версия ${version.versionNumber}`);
    return { ok: true, fileName: result.fileName, versionNumber: version.versionNumber };
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
ipcMain.handle('mods:updateOne', async (e, { mcVersion, loader, projectId, title }) => {
  const root = getGameDir();
  const inst = getInstance(mcVersion, loader);
  const report = await modManager.reinstallMods(root, mcVersion, loader, inst.wantedMods, progress => {
    sendToWindow('mods:progress', progress);
  }, false, projectId);
  rememberModFileNames(mcVersion, loader, [...report.installed, ...report.skipped]);
  if (report.installed.length) {
    notify('Мод обновлён', title);
  }
  return report;
});

// список версий, для которых уже есть сохранённый список модов (кроме текущей)
// проверка совместимости мода с версией/лоадером перед добавлением в список
ipcMain.handle('mods:checkCompatible', async (e, { projectId, mcVersion, loader }) => {
  try {
    const version = await modrinth.getCompatibleVersion(projectId, mcVersion, loader);
    return { compatible: !!version };
  } catch (err) {
    return { compatible: false, reason: err.message };
  }
});

ipcMain.handle('mods:getDependencies', async (e, { projectId, mcVersion, loader }) => {
  try {
    return await modManager.resolveModDependencies(mcVersion, loader, projectId);
  } catch {
    return [];
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
ipcMain.handle('mods:inspectMetadata', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const { getModsDir } = require('./src/modManager');
  return jarMetadata.inspectModsDir(getModsDir(root, mcVersion, loader));
});

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
  for (const mod of source.wantedMods) {
    if (!inst.wantedMods.some(m => m.projectId === mod.projectId)) inst.wantedMods.push(mod);
  }
  setWantedMods(mcVersion, loader, inst.wantedMods);
  return inst.wantedMods;
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

ipcMain.handle('resourcepackProfiles:save', async (e, { name, loader, packs }) => saveResourcePackProfile(name, loader, packs));

ipcMain.handle('resourcepackProfiles:rename', async (e, { id, name }) => renameResourcePackProfile(id, name));

ipcMain.handle('resourcepackProfiles:delete', async (e, id) => deleteResourcePackProfile(id));

ipcMain.handle('resourcepackProfiles:apply', async (e, { id, mcVersion, loader }) => {
  const profiles = listResourcePackProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) throw new Error('Профиль не найден');

  const inst = getInstance(mcVersion, loader);
  for (const pack of profile.packs) {
    if (!inst.wantedResourcePacks.some(p => p.projectId === pack.projectId)) inst.wantedResourcePacks.push(pack);
  }
  setWantedResourcePacks(mcVersion, loader, inst.wantedResourcePacks);
  return inst.wantedResourcePacks;
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

ipcMain.handle('game:launch', async (e, { mcVersion, loader }) => {
  return performLaunch(mcVersion, loader);
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
  minimizeToTray: store.get('minimizeToTray'),
  customIconPath: store.get('customIconPath') || null,
  backupSavesBeforeReinstall: store.get('backupSavesBeforeReinstall', true),
  onboardingCompleted: store.get('onboardingCompleted', false),
  customSkinLoaderEnabled: getCustomSkinLoaderEnabled(),
  syntThemeUnlocked: store.get('syntThemeUnlocked', false)
}));

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

ipcMain.handle('settings:setNotifications', async (e, enabled) => {
  store.set('notificationsEnabled', enabled);
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

// сохраняем выбор сразу при переключении в UI, а не только при запуске игры —
// иначе после перезапуска лаунчера выбор всегда слетал на версию по умолчанию
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
    filters: [{ name: 'Сборка PFC Launcher', extensions: ['zip'] }]
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
  const shots = screenshotManager.listScreenshots(root)
    .map(s => ({ ...s, favorite: favorites.includes(s.filePath) }));

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

// --- снимки сборки (моды+ресурспаки+список) для отката после неудачного обновления ---

ipcMain.handle('buildBackups:list', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  return buildBackup.listBuildBackups(root, mcVersion, loader);
});

ipcMain.handle('buildBackups:openFolder', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  shell.openPath(buildBackup.getBuildBackupsDir(root, mcVersion, loader));
});

ipcMain.handle('buildBackups:makeNow', async (e, { mcVersion, loader }) => {
  const root = getGameDir();
  const snapshotPath = await buildBackup.backupBuild(root, mcVersion, loader, 'manual');
  if (!snapshotPath) throw new Error('Папка модов и ресурспаков пуста — нечего сохранять');
  return snapshotPath;
});

ipcMain.handle('buildBackups:rollback', async (e, { mcVersion, loader, backupPath }) => {
  const root = getGameDir();
  // на всякий случай бэкапим текущее состояние перед откатом — если откатили не туда,
  // можно откатиться обратно
  try {
    await buildBackup.backupBuild(root, mcVersion, loader, 'before-rollback');
  } catch (err) {
    console.error('[buildBackup] не удалось сохранить снимок перед откатом:', err.message);
  }
  const result = await buildBackup.rollbackBuild(root, mcVersion, loader, backupPath);
  notify('Сборка откачена', `Восстановлено модов: ${result.modsRestored}, ресурспаков: ${result.packsRestored}`);
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
  shell.openExternal(url);
});

ipcMain.handle('app:getVersion', async () => app.getVersion());

ipcMain.handle('app:checkForUpdates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});