const versionSelect = document.getElementById('versionSelect');
const loaderSelect = document.getElementById('loaderSelect');
const playLog = document.getElementById('playLog');
const modsLog = document.getElementById('modsLog');
const rpLog = document.getElementById('rpLog');
const shLog = document.getElementById('shLog');

const MAX_LOG_LINES = 300;
const CONSOLE_LOG_LINES = 3000;

function logLimit(el) {
  return el === playLog ? CONSOLE_LOG_LINES : MAX_LOG_LINES;
}

function stickLog(el) {
  if (el === playLog && window.fcConsole && !window.fcConsole.autoscroll) return;
  el.scrollTop = el.scrollHeight;
}

// иконки модов грузятся с чужих серверов — если не загрузилась, просто прячем.
// Делаем это одним слушателем: инлайновые onerror запрещает CSP
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains('card-preview')) img.classList.add('failed');
  else img.style.display = 'none';
}, true);

// свой confirm() поверх интерфейса — обычный window.confirm() в Electron после
// закрытия иногда не возвращает окну фокус клавиатуры, из-за этого поля ввода
// переставали реагировать на печать. Этот вариант ничего не блокирует нативно.
function customConfirm(message) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirmOverlay');
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    document.getElementById('confirmText').textContent = message;

    const cleanup = result => {
      overlay.classList.remove('active');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = e => { if (e.target === overlay) cleanup(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    overlay.classList.add('active');
    okBtn.focus();
  });
}

// диалог с тремя исходами: 'primary', 'alt' или null (отмена)
function customChoice(message, { primaryLabel, altLabel }) {
  return new Promise(resolve => {
    const overlay = document.getElementById('choiceOverlay');
    const primaryBtn = document.getElementById('choicePrimaryBtn');
    const altBtn = document.getElementById('choiceAltBtn');
    const cancelBtn = document.getElementById('choiceCancelBtn');
    document.getElementById('choiceText').textContent = message;
    primaryBtn.textContent = primaryLabel;
    altBtn.textContent = altLabel;

    const cleanup = result => {
      overlay.classList.remove('active');
      primaryBtn.removeEventListener('click', onPrimary);
      altBtn.removeEventListener('click', onAlt);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      resolve(result);
    };
    const onPrimary = () => cleanup('primary');
    const onAlt = () => cleanup('alt');
    const onCancel = () => cleanup(null);
    const onOverlayClick = e => { if (e.target === overlay) cleanup(null); };

    primaryBtn.addEventListener('click', onPrimary);
    altBtn.addEventListener('click', onAlt);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    overlay.classList.add('active');
    primaryBtn.focus();
  });
}

// то же самое, но пачкой — один reflow на N строк вместо одного на каждую.
// Критично для лога вкладки "Играть": пока Minecraft работает, строк может быть сотни в секунду.
function detectLogLevel(text) {
  if (/\b(FATAL|ERROR|Exception|Caused by)\b/i.test(text)) return 'error';
  if (/\bWARN\b/i.test(text)) return 'warn';
  if (/\b(DEBUG|TRACE)\b/.test(text)) return 'debug';
  return 'info';
}

function logBatch(el, lines) {
  if (!lines.length) return;
  const frag = document.createDocumentFragment();
  const time = new Date().toLocaleTimeString(window.i18n.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  for (const text of lines) {
    const line = document.createElement('div');
    line.className = `log-line ${detectLogLevel(text)}`;
    line.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${escHtml(text)}</span>`;
    frag.appendChild(line);
  }
  el.appendChild(frag);
  stickLog(el);

  while (el.children.length > logLimit(el)) {
    el.removeChild(el.firstElementChild);
  }
}

// Потоковый лог Minecraft может присылать сотни строк в секунду. Не обновляем DOM
// на каждую строку: складываем сообщения в очередь и отрисовываем небольшими пачками.
let playLogQueue = [];
let playLogFlushTimer = null;
function queuePlayLog(lines) {
  if (!Array.isArray(lines)) return;
  playLogQueue.push(...lines.filter(Boolean).map(String));
  if (playLogQueue.length > 800) playLogQueue = playLogQueue.slice(-800);
  if (playLogFlushTimer !== null) return;
  playLogFlushTimer = setTimeout(() => {
    playLogFlushTimer = null;
    const batch = playLogQueue.splice(0, 35);
    if (batch.length) logBatch(playLog, batch);
    if (playLogQueue.length) queuePlayLog([]);
  }, 100);
}

function log(el, text, type = 'info') {
  const time = new Date().toLocaleTimeString(window.i18n.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.insertAdjacentHTML('beforeend', `
    <div class="log-line ${type}">
      <span class="log-time">${time}</span>
      <span class="log-msg">${escHtml(text)}</span>
    </div>
  `);
  stickLog(el);

  // без этого лог на вкладке "Главная" никогда не чистится сам и за долгую
  // сессию просто бесконечно копит DOM-узлы — обрезаем старые строки сверху
  while (el.children.length > logLimit(el)) {
    el.removeChild(el.firstElementChild);
  }
}

function clearLog(el) {
  el.innerHTML = '';
}

// копируем текстовое содержимое лога в буфер обмена — удобно, когда
// присылаешь баг-репорт и не надо руками выделять/копировать
function copyLogToClipboard(el, toastLabel) {
  const text = [...el.querySelectorAll('.log-line')]
    .map(line => line.textContent.trim())
    .join('\n');

  if (!text) {
    showToast('Лог пуст, нечего копировать', 'warn');
    return;
  }

  navigator.clipboard.writeText(text)
    .then(() => showToast(`${toastLabel} скопирован в буфер обмена`, 'success'))
    .catch(() => showToast('Не удалось скопировать лог', 'error'));
}

document.getElementById('copyPlayLogBtn').addEventListener('click', () => copyLogToClipboard(playLog, 'Лог запуска'));

document.getElementById('sharePlayLogBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const text = [...playLog.querySelectorAll('.log-line')].map(line => line.textContent.trim()).join('\n');
  if (!text) {
    showToast('Лог пуст, нечего отправлять', 'warn');
    return;
  }
  btn.disabled = true;
  try {
    const url = await window.api.shareLog(text);
    await navigator.clipboard.writeText(url).catch(() => {});
    showToast(`Ссылка на лог скопирована: ${url}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('copyModsLogBtn').addEventListener('click', () => copyLogToClipboard(modsLog, 'Лог модов'));
document.getElementById('copyRpLogBtn').addEventListener('click', () => copyLogToClipboard(rpLog, 'Лог ресурспаков'));
document.getElementById('copyShLogBtn').addEventListener('click', () => copyLogToClipboard(shLog, 'Лог шейдеров'));

// человекочитаемые скорость/оставшееся время для прогресс-баров скачивания
function formatSpeedEta(speedBps, etaSec) {
  const parts = [];
  if (speedBps) {
    const mbps = speedBps / (1024 * 1024);
    parts.push(mbps >= 1 ? `${mbps.toFixed(1)} МБ/с` : `${(speedBps / 1024).toFixed(0)} КБ/с`);
  }
  if (etaSec !== null && etaSec !== undefined && isFinite(etaSec)) {
    if (etaSec < 60) parts.push(`осталось ~${etaSec}с`);
    else parts.push(`осталось ~${Math.round(etaSec / 60)}мин`);
  }
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// --- всплывающие уведомления в самом лаунчере (не системные, а внутри окна) ---
const TOAST_TITLES = { success: 'Готово', error: 'Ошибка', warn: 'Внимание', info: 'Уведомление' };

const defaultNotificationSoundSources = {
  notification: 'sounds/Notification.mp3',
  warning: 'sounds/Warning.mp3',
  repair: 'sounds/Repair.mp3',
  update: 'sounds/UpdateLauncher.mp3'
};
const notificationSoundLabels = {
  notification: 'Обычное уведомление',
  warning: 'Ошибка / предупреждение',
  repair: 'Завершение Repair',
  update: 'Обновление лаунчера'
};
const notificationSounds = {};
let notificationSoundVolume = 0.5;

function soundFileUrl(filePath) {
  if (!filePath) return '';
  return /^file:\/\//i.test(filePath) ? filePath : `file://${String(filePath).replaceAll('\\', '/')}`;
}

function configureNotificationSounds(settings = {}) {
  notificationSoundVolume = Math.max(0, Math.min(1, Number(settings.notificationSoundVolume ?? 0.5)));
  const custom = settings.customNotificationSounds || {};
  Object.keys(defaultNotificationSoundSources).forEach(name => {
    const source = custom[name] ? soundFileUrl(custom[name]) : defaultNotificationSoundSources[name];
    if (!notificationSounds[name]) notificationSounds[name] = new Audio();
    notificationSounds[name].src = source;
    notificationSounds[name].volume = notificationSoundVolume;
  });
}

function playNotificationSound(name) {
  const sound = notificationSounds[name];
  if (!sound) return;
  try {
    sound.volume = notificationSoundVolume;
    sound.currentTime = 0;
    const playback = sound.play();
    if (playback && typeof playback.catch === 'function') playback.catch(() => {});
  } catch (_) {}
}

function renderNotificationSoundSettings(settings = {}) {
  const volume = Math.round(notificationSoundVolume * 100);
  const slider = document.getElementById('notificationSoundVolume');
  const label = document.getElementById('notificationSoundVolumeLabel');
  if (slider) slider.value = String(volume);
  if (label) label.textContent = `${volume}%`;
  const custom = settings.customNotificationSounds || {};
  const list = document.getElementById('customSoundsList');
  if (!list) return;
  list.innerHTML = Object.keys(defaultNotificationSoundSources).map(name => `
    <div class="row" style="gap:8px;align-items:center">
      <label style="min-width:180px">${notificationSoundLabels[name]}</label>
      <span class="desc" style="flex:1;overflow:hidden;text-overflow:ellipsis">${custom[name] ? 'Свой звук установлен' : 'Стандартный звук'}</span>
      <button data-custom-sound="${name}">${custom[name] ? 'Заменить' : 'Выбрать'}</button>
      ${custom[name] ? `<button data-reset-sound="${name}">Сбросить</button>` : ''}
    </div>`).join('');
  list.querySelectorAll('[data-custom-sound]').forEach(btn => btn.addEventListener('click', async () => {
    const name = btn.dataset.customSound;
    const selected = await window.api.pickNotificationSound(name);
    if (selected) {
      const fresh = await window.api.getSettings();
      configureNotificationSounds(fresh);
      renderNotificationSoundSettings(fresh);
      showToast('Звук заменён', 'success');
    }
  }));
  list.querySelectorAll('[data-reset-sound]').forEach(btn => btn.addEventListener('click', async () => {
    await window.api.resetNotificationSound(btn.dataset.resetSound);
    const fresh = await window.api.getSettings();
    configureNotificationSounds(fresh);
    renderNotificationSoundSettings(fresh);
  }));
}

function showToast(message, type = 'info', title, sound = true) {
  // Обычные уведомления используют Notification.mp3, а ошибки и предупреждения — Warning.mp3.
  if (sound) {
    if (type === 'warn' || type === 'error') playNotificationSound('warning');
    else playNotificationSound('notification');
  }

  const systemTitle = title || TOAST_TITLES[type] || 'FCore Launcher';
  const notificationMode = window.__notificationMode || 'internal';
  if (notificationMode === 'external' && window.api && typeof window.api.showSystemNotification === 'function') {
    window.api.showSystemNotification(systemTitle, String(message ?? ''), type).catch(() => {});
  }
  if (notificationMode === 'external') return;

  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-title ${type}">${escHtml(title || TOAST_TITLES[type] || 'Уведомление')}</div>
    <div class="toast-body">${escHtml(message)}</div>
  `;
  container.appendChild(el);

  requestAnimationFrame(() => el.classList.add('show'));

  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 250);
  }, 3800);
}

function currentSelection() {
  return { mcVersion: versionSelect.value, loader: loaderSelect.value };
}

// --- вкладки ---
function openModSearchForDependency(name) {
  const query = String(name || '').trim();
  if (!query) return;
  switchTab('mods');
  const input = document.getElementById('modSearch');
  if (!input) return;
  input.value = query;
  runModSearch(0);
  showToast(`Ищу зависимость: ${query}`, 'info');
}

// моды, ресурспаки и шейдеры живут в одной вкладке "Контент" как три раздела
const CONTENT_PANES = ['mods', 'resourcepacks', 'shaders'];
let lastContentPane = 'mods';

function showContentPane(pane) {
  if (!CONTENT_PANES.includes(pane)) pane = lastContentPane;
  lastContentPane = pane;
  CONTENT_PANES.forEach(name => {
    document.getElementById(`tab-${name}`).classList.toggle('active', name === pane);
  });
  document.querySelectorAll('.content-seg').forEach(btn => {
    const on = btn.dataset.pane === pane;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

document.querySelectorAll('.content-seg').forEach(btn => {
  btn.addEventListener('click', () => showContentPane(btn.dataset.pane));
});

function switchTab(tabName) {
  // старые имена вкладок (mods/resourcepacks/shaders) открывают "Контент" на нужном разделе
  let pane = null;
  if (CONTENT_PANES.includes(tabName)) {
    pane = tabName;
    tabName = 'content';
  }
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
  if (tabName === 'content') showContentPane(pane);
  if (tabName === 'builds' && window.fcBuilds) window.fcBuilds.refresh();
  if (tabName === 'settings') { renderCrashList(); renderBackupsList(); renderBuildBackupsList(); renderJavaList(); }
  if (tabName === 'changelog') { loadChangelog(); }
  if (tabName === 'activity') { loadGamingActivity(); }
  if (tabName === 'downloads') { loadDownloadManager(); }
  if (tabName === 'screenshots') { loadScreenshots(); }
  if (tabName === 'worlds') { loadWorlds(); }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// --- пасхалка ---
let logoClicks = 0;
let logoClickTimer = null;

document.getElementById('logo').addEventListener('click', () => {
  logoClicks++;
  clearTimeout(logoClickTimer);
  logoClickTimer = setTimeout(() => { logoClicks = 0; }, 1500);

  if (logoClicks >= 5) {
    document.getElementById('secretBtn').style.display = 'block';
    logoClicks = 0;
  }
});

document.getElementById('secretBtn').addEventListener('click', () => {
  window.api.openExternal('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

// --- аккаунт ---

// Ely.by texture URLs are resolved in the main process via /textures/{nickname}.

// рисуем только лицо (без шапки) — 8x8 кусок текстуры, растянутый пиксель в пиксель
// одна и та же текстура рисуется в нескольких местах и при каждой перерисовке списка
// аккаунтов — качаем и декодируем её один раз
const skinImageCache = new Map();

// Mojang иногда отдаёт текстуры по http:// — CSP это блокирует, а https там работает
function toHttps(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : url;
}

function loadSkinImage(url) {
  url = toHttps(url);
  let cached = skinImageCache.get(url);
  if (!cached) {
    cached = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    cached.catch(() => skinImageCache.delete(url));
    skinImageCache.set(url, cached);
  }
  return cached;
}

function drawSkinFace(canvas, skinUrl, fallbackName = '') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const drawFallback = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#514b45';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const initial = String(fallbackName || '?').trim().slice(0, 1).toUpperCase() || '?';
    ctx.fillStyle = '#f1eee9';
    ctx.font = `600 ${Math.max(16, Math.round(canvas.height * 0.48))}px Manrope, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, canvas.width / 2, canvas.height / 2 + 1);
  };

  if (!skinUrl) {
    drawFallback();
    return;
  }

  loadSkinImage(skinUrl).then(img => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    if (img.height >= 64) ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
  }).catch(drawFallback);
}

// полноценный вращаемый 3D-скин (skinview3d/three.js) в настройках — заводим
// вьювер один раз и потом просто подменяем текстуру, а не пересоздаём канвас
let skin3dViewer = null;
function getSkin3dViewer() {
  if (skin3dViewer) return skin3dViewer;
  const canvas = document.getElementById('skin3dPreview');
  if (!canvas || typeof skinview3d === 'undefined') return null;

  skin3dViewer = new skinview3d.SkinViewer({
    canvas,
    width: canvas.width,
    height: canvas.height
  });
  skin3dViewer.autoRotate = true;
  skin3dViewer.autoRotateSpeed = 0.8;
  skin3dViewer.controls.enableZoom = true;
  skin3dViewer.zoom = 0.9;
  skin3dViewer.animation = new skinview3d.IdleAnimation();
  return skin3dViewer;
}

// meta не всегда даёт понять, "тонкая" модель или нет — проще пусть библиотека
// сама разберётся по прозрачности PNG, поэтому variant всегда "auto-detect"
async function load3dSkin(name, skinInfo = null) {
  const viewer = getSkin3dViewer();
  if (!viewer || !name) return;
  try {
    const info = skinInfo || await window.api.getAccountSkinInfo();
    if (info?.skinUrl) await viewer.loadSkin(toHttps(info.skinUrl));
    else viewer.loadSkin(null);
    if (info?.capeUrl) await viewer.loadCape(toHttps(info.capeUrl)).catch(() => viewer.loadCape(null));
    else viewer.loadCape(null);
  } catch {
    viewer.loadSkin(null);
    viewer.loadCape(null);
  }
}

// --- переключатель анимации в 3D-вьювере (стоя/ходьба/бег/элитры) ---
const SKIN3D_ANIMATIONS = {
  idle: () => new skinview3d.IdleAnimation(),
  walk: () => new skinview3d.WalkingAnimation(),
  run: () => new skinview3d.RunningAnimation(),
  fly: () => new skinview3d.FlyingAnimation()
};

function setSkin3dAnimation(kind) {
  const viewer = getSkin3dViewer();
  if (!viewer) return;

  viewer.animation = (SKIN3D_ANIMATIONS[kind] || SKIN3D_ANIMATIONS.idle)();
  // элитры показываем только пока летим — иначе плащ на бегу/ходьбе выглядит странно
  viewer.playerObject.backEquipment = kind === 'fly' ? 'elytra' : 'cape';

  document.querySelectorAll('.skin3d-anim-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.anim === kind);
  });
}

document.querySelectorAll('.skin3d-anim-btn').forEach(btn => {
  btn.addEventListener('click', () => setSkin3dAnimation(btn.dataset.anim));
});

// --- drag & drop локального PNG прямо на модель — превью без загрузки на сайт ---
const skin3dDropCanvas = document.getElementById('skin3dPreview');
const skin3dDropHint = document.getElementById('skin3dDropHint');
let previewingLocalSkin = false;

function loadLocalSkinFile(file) {
  if (!file || !file.type.includes('png')) {
    showToast('Нужен файл в формате PNG', 'warn');
    return;
  }
  const viewer = getSkin3dViewer();
  if (!viewer) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      viewer.loadSkin(img);
      previewingLocalSkin = true;
      skin3dDropHint.textContent = `Превью: ${file.name} (не сохранено)`;
      document.getElementById('skinLookupResetBtn').style.display = 'inline-block';
    };
    img.onerror = () => showToast('Не удалось прочитать файл как изображение', 'error');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

skin3dDropCanvas.addEventListener('dragover', e => {
  e.preventDefault();
  skin3dDropCanvas.classList.add('drag-over');
});
skin3dDropCanvas.addEventListener('dragleave', () => {
  skin3dDropCanvas.classList.remove('drag-over');
});
skin3dDropCanvas.addEventListener('drop', e => {
  e.preventDefault();
  skin3dDropCanvas.classList.remove('drag-over');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  loadLocalSkinFile(file);
});

// --- поиск и просмотр чужого скина по нику ---
document.getElementById('skinLookupBtn').addEventListener('click', async () => {
  const name = document.getElementById('skinLookupInput').value.trim();
  if (!name) return;

  const status = document.getElementById('skinLookupStatus');
  status.textContent = `Ищу скин "${name}"...`;

  const viewer = getSkin3dViewer();
  if (!viewer) return;

  try {
    const info = await window.api.lookupElybySkin(name);
    if (!info?.skinUrl) {
      previewingLocalSkin = false;
      viewer.loadSkin(null);
      viewer.loadCape(null);
      status.textContent = `У "${name}" нет скина на Ely.by (или ник не найден)`;
      return;
    }
    await viewer.loadSkin(toHttps(info.skinUrl));
    if (info.capeUrl) await viewer.loadCape(toHttps(info.capeUrl)).catch(() => viewer.loadCape(null));
    else viewer.loadCape(null);
    status.textContent = `Показан скин игрока "${name}"`;
    previewingLocalSkin = true;
    skin3dDropHint.textContent = 'Перетащи PNG сюда для превью';
    document.getElementById('skinLookupResetBtn').style.display = 'inline-block';
  } catch {
    status.textContent = `Не удалось получить данные скина "${name}"`;
  }
});

document.getElementById('skinLookupInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('skinLookupBtn').click();
});

document.getElementById('skinLookupResetBtn').addEventListener('click', async () => {
  previewingLocalSkin = false;
  skin3dDropHint.textContent = 'Перетащи PNG сюда для превью';
  document.getElementById('skinLookupResetBtn').style.display = 'none';
  document.getElementById('skinLookupStatus').textContent = '';
  document.getElementById('skinLookupInput').value = '';
  const account = await window.api.currentAccount();
  if (account && account.name) load3dSkin(account.name);
});

let accountSkinRequest = 0;

// скин тянется по сети, поэтому не держим на нём остальной интерфейс
async function refreshAccountSkin(account) {
  if (!account?.name) return;
  const request = ++accountSkinRequest;
  let skinInfo = null;
  try { skinInfo = await window.api.getAccountSkinInfo(); } catch {}
  if (request !== accountSkinRequest) return; // за это время аккаунт уже сменили

  drawSkinFace(document.getElementById('skinPreview'), skinInfo?.skinUrl, account.name);
  if (!previewingLocalSkin) load3dSkin(account.name, skinInfo);
}

async function refreshAccount() {
  const account = await window.api.currentAccount();
  document.getElementById('accountName').textContent = account ? account.name : 'Не авторизован';

  updateSkinControls(account);
  refreshAccountSkin(account);
  await renderAccountsList();

  const meteorSection = document.getElementById('meteorClientSection');
  const myUuid = 'c3c3cf5e-427d-4a41-8eb4-0e4832a4f94b'.replace(/-/g, '');
  const accountUuid = (account && account.uuid || '').replace(/-/g, '').toLowerCase();
  meteorSection.style.display = accountUuid === myUuid ? '' : 'none';
}

// показываем нужную кнопку смены скина в зависимости от типа текущего аккаунта:
// у Microsoft есть официальный API для загрузки прямо из лаунчера, у Ely.by —
// только сайт (публичного API на запись у них нет), у офлайн-ника скина как такового нет
function updateSkinControls(account) {
  const typeLabel = document.getElementById('skinAccountTypeLabel');
  const changeBtn = document.getElementById('changeSkinBtn');
  const variantSelect = document.getElementById('skinVariantSelect');
  const elybyBtn = document.getElementById('openElybySkinBtn');

  changeBtn.style.display = 'none';
  variantSelect.style.display = 'none';
  elybyBtn.style.display = 'none';

  if (!account) {
    typeLabel.textContent = 'Сначала войди в аккаунт';
    refreshSkinManager(null);
    return;
  }

  if (account.type === 'microsoft') {
    typeLabel.textContent = 'Microsoft-аккаунт — меняется прямо здесь';
    changeBtn.style.display = 'inline-block';
    variantSelect.style.display = 'inline-block';
  } else if (account.type === 'elyby') {
    typeLabel.textContent = 'Ely.by-аккаунт — загрузка только через сайт (у них нет API для этого)';
    elybyBtn.style.display = 'inline-block';
  } else {
    typeLabel.textContent = 'Офлайн-ник — своего скина нет, показывается случайный Steve/Alex';
  }
  refreshSkinManager(account);
}

document.getElementById('changeSkinBtn').addEventListener('click', async () => {
  const filePath = await window.api.pickSkinFile();
  if (!filePath) return;

  const variant = document.getElementById('skinVariantSelect').value;
  const btn = document.getElementById('changeSkinBtn');
  btn.disabled = true;
  btn.textContent = 'Загружаю...';

  try {
    const res = await window.api.changeSkinMicrosoft(filePath, variant);
    showToast('Скин обновлён', 'success');
    showAppliedSkin(res.dataUrl);
    renderSkinLibrary();
    refreshUndoButton();
  } catch (err) {
    showToast(ipcMessage(err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Загрузить новый скин (PNG)';
  }
});

// Electron добавляет к ошибкам из главного процесса служебный префикс — пользователю он не нужен
const ipcMessage = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// --- менеджер скинов: плащи и библиотека (только для Microsoft) ---
// Выходим из режима локального превью: снова показываем скин самого аккаунта
function leaveLocalSkinPreview() {
  previewingLocalSkin = false;
  skin3dDropHint.textContent = 'Перетащи PNG сюда для превью';
  document.getElementById('skinLookupResetBtn').style.display = 'none';
}

// Только что применённый скин показываем сразу: серверам Mojang нужно несколько секунд,
// чтобы начать отдавать новую текстуру, и обычное обновление показало бы ещё старый
function showAppliedSkin(dataUrl) {
  leaveLocalSkinPreview();
  const viewer = getSkin3dViewer();
  if (viewer) {
    const img = new Image();
    img.onload = () => viewer.loadSkin(img);
    img.src = dataUrl;
  }
  drawSkinFace(document.getElementById('skinPreview'), dataUrl);
}

async function refreshUndoButton() {
  const btn = document.getElementById('undoSkinBtn');
  try {
    btn.style.display = await window.api.hasPreviousSkin() ? '' : 'none';
  } catch {
    btn.style.display = 'none';
  }
}

async function refreshSkinManager(account) {
  const box = document.getElementById('skinManager');
  const isMicrosoft = account?.type === 'microsoft';
  box.style.display = isMicrosoft ? '' : 'none';
  if (!isMicrosoft) return;
  await Promise.all([renderSkinLibrary(), renderCapes(), refreshUndoButton()]);
}

async function renderSkinLibrary() {
  const box = document.getElementById('skinLibrary');
  let items = [];
  try { items = await window.api.listSkinLibrary(); } catch {}

  if (!items.length) {
    box.innerHTML = '<div class="setting-desc">Пока пусто: загруженные скины появятся здесь.</div>';
    box.onclick = null;
    return;
  }

  box.innerHTML = items.map(s => `
    <div class="skin-lib-item" data-id="${escHtml(s.id)}">
      <canvas class="skin-lib-face" width="40" height="40"></canvas>
      <div class="skin-lib-name" title="${escHtml(s.name)}">${escHtml(s.name)}</div>
      <div class="skin-lib-actions">
        <button class="skin-lib-apply">Применить</button>
        <button class="skin-lib-preview">Показать</button>
        <button class="skin-lib-remove" title="Удалить из библиотеки" aria-label="Удалить из библиотеки">✕</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('.skin-lib-item').forEach(row => {
    const skin = items.find(s => s.id === row.dataset.id);
    if (skin?.dataUrl) drawSkinFace(row.querySelector('canvas'), skin.dataUrl);
  });

  box.onclick = async e => {
    const row = e.target.closest('.skin-lib-item');
    const button = e.target.closest('button');
    if (!row || !button) return;
    const skin = items.find(s => s.id === row.dataset.id);
    if (!skin) return;

    if (button.classList.contains('skin-lib-apply')) {
      button.disabled = true;
      try {
        await window.api.applyLibrarySkin(skin.id);
        showToast(`Скин «${skin.name}» применён`, 'success');
        showAppliedSkin(skin.dataUrl);
        await refreshUndoButton();
      } catch (err) {
        showToast(ipcMessage(err), 'error');
      } finally {
        button.disabled = false;
      }
    } else if (button.classList.contains('skin-lib-preview')) {
      const viewer = getSkin3dViewer();
      if (!viewer) return;
      const img = new Image();
      img.onload = () => {
        viewer.loadSkin(img);
        previewingLocalSkin = true;
        skin3dDropHint.textContent = `Превью: ${skin.name} (не применено)`;
        document.getElementById('skinLookupResetBtn').style.display = 'inline-block';
      };
      img.src = skin.dataUrl;
    } else if (button.classList.contains('skin-lib-remove')) {
      if (!await customConfirm(`Удалить скин «${skin.name}» из библиотеки?`)) return;
      await window.api.removeLibrarySkin(skin.id);
      await renderSkinLibrary();
    }
  };
}

function drawCapeFront(canvas, url) {
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const k = img.width / 64; // у HD-плащей текстура больше стандартной 64x32
    ctx.drawImage(img, k, k, 10 * k, 16 * k, 0, 0, canvas.width, canvas.height);
  };
  img.src = toHttps(url);
}

async function renderCapes() {
  const box = document.getElementById('capeList');
  box.textContent = 'Загружаю...';
  let capes;
  try {
    ({ capes } = await window.api.getMicrosoftProfile());
  } catch (err) {
    box.innerHTML = `<div class="setting-desc">Не удалось получить плащи: ${escHtml(ipcMessage(err))}</div>`;
    box.onclick = null;
    return;
  }

  if (!capes.length) {
    box.innerHTML = '<div class="setting-desc">На этом аккаунте нет плащей.</div>';
    box.onclick = null;
    return;
  }

  box.innerHTML = `<button class="cape-btn ${capes.some(c => c.active) ? '' : 'active'}" data-id="">Без плаща</button>` +
    capes.map(c => `
      <button class="cape-btn ${c.active ? 'active' : ''}" data-id="${escHtml(c.id)}">
        <canvas class="cape-face" width="20" height="32"></canvas><span>${escHtml(c.alias)}</span>
      </button>`).join('');
  box.querySelectorAll('.cape-btn').forEach(btn => {
    const cape = capes.find(c => c.id === btn.dataset.id);
    if (cape) drawCapeFront(btn.querySelector('canvas'), cape.url);
  });

  box.onclick = async e => {
    const btn = e.target.closest('.cape-btn');
    if (!btn) return;
    try {
      await window.api.setCape(btn.dataset.id || null);
      showToast('Плащ изменён', 'success');
      await refreshAccount();
    } catch (err) {
      showToast(ipcMessage(err), 'error');
    }
  };
}

document.getElementById('skinLibraryAddBtn').addEventListener('click', async () => {
  try {
    const entry = await window.api.addSkinToLibrary(document.getElementById('skinVariantSelect').value);
    if (!entry) return;
    showToast(`«${entry.name}» добавлен в библиотеку`, 'success');
    await renderSkinLibrary();
  } catch (err) {
    showToast(ipcMessage(err), 'error');
  }
});

document.getElementById('undoSkinBtn').addEventListener('click', async () => {
  const btn = document.getElementById('undoSkinBtn');
  btn.disabled = true;
  try {
    const res = await window.api.undoSkin();
    showToast('Скин возвращён. Повторное нажатие вернёт его обратно.', 'success');
    if (res.dataUrl) {
      showAppliedSkin(res.dataUrl);
    } else {
      // стоял стандартный скин — показываем актуальное состояние аккаунта
      leaveLocalSkinPreview();
      await refreshAccount();
    }
  } catch (err) {
    showToast(ipcMessage(err), 'error');
  } finally {
    btn.disabled = false;
    await refreshUndoButton();
  }
});

document.getElementById('resetSkinBtn').addEventListener('click', async () => {
  if (!await customConfirm('Сбросить скин до стандартного (Steve или Alex)? Текущий скин лучше сначала сохранить в библиотеку.')) return;
  try {
    await window.api.resetSkin();
    showToast('Скин сброшен', 'success');
    leaveLocalSkinPreview();
    await refreshAccount();
  } catch (err) {
    showToast(ipcMessage(err), 'error');
  }
});

document.getElementById('openElybySkinBtn').addEventListener('click', () => {
  window.api.openElybySkinPage();
});

window.api.onElybySkinPageClosed(async () => {
  showToast('Обновляю превью скина...', 'info');
  await refreshAccount();
});

const ACCOUNT_TYPE_ICON = {
  elyby: 'icons/elyby.png',
  microsoft: 'icons/microsoft.png',
  offline: 'icons/offline.png'
};

const ACCOUNT_TYPE_LABEL = {
  elyby: 'Ely.by',
  microsoft: 'Microsoft',
  offline: 'Офлайн'
};

async function renderAccountsList() {
  const accounts = await window.api.listAccounts();
  const container = document.getElementById('accountsList');

  if (!accounts.length) {
    container.innerHTML = '<div class="accounts-empty">Аккаунтов пока нет. Добавь первый ниже.</div>';
    return;
  }

  container.innerHTML = accounts.map(a => {
    const name = a.profile?.name || 'Без имени';
    const type = a.profile?.type;
    return `
    <div class="account-item ${a.selected ? 'selected' : ''}" data-index="${a.index}" tabindex="0" role="button" aria-pressed="${a.selected ? 'true' : 'false'}">
      <canvas class="acc-skin-face" width="40" height="40" data-name="${escHtml(a.profile?.name || '')}"></canvas>
      <div class="acc-info">
        <span class="acc-name" title="${escHtml(name)}">${escHtml(name)}</span>
        <span class="acc-type">${ACCOUNT_TYPE_ICON[type] ? `<img class="acc-type-icon" src="${ACCOUNT_TYPE_ICON[type]}" alt="">` : ''}${escHtml(ACCOUNT_TYPE_LABEL[type] || '')}</span>
      </div>
      ${a.selected ? '<span class="acc-current">Выбран</span>' : ''}
      <button class="acc-remove" data-index="${a.index}" title="Удалить аккаунт" aria-label="Удалить аккаунт ${escHtml(name)}">Удалить</button>
    </div>`;
  }).join('');

  container.querySelectorAll('.account-item').forEach(row => {
    const choose = async () => {
      await window.api.selectAccount(Number(row.dataset.index));
      await refreshAccount();
    };
    row.addEventListener('click', async e => {
      if (e.target.closest('.acc-remove')) return;
      await choose();
    });
    row.addEventListener('keydown', async e => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); await choose(); }
    });
  });

  container.querySelectorAll('.acc-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const row = btn.closest('.account-item');
      const name = row?.querySelector('.acc-name')?.textContent || 'аккаунт';
      if (!await customConfirm(`Удалить аккаунт «${name}» из лаунчера?`)) return;
      await window.api.removeAccount(Number(btn.dataset.index));
      await refreshAccount();
    });
  });

  // Для Microsoft берём texture URL из Minecraft Profile API, а не из Ely.by.
  // Поэтому Microsoft-аватарки работают даже если игрока нет в Ely.by.
  // Не await: список уже кликабельный, лица дорисуются по мере загрузки.
  container.querySelectorAll('.acc-skin-face').forEach(async canvas => {
    const index = Number(canvas.closest('.account-item')?.dataset.index);
    const name = canvas.dataset.name;
    try {
      const info = await window.api.getAccountSkinInfoByIndex(index);
      drawSkinFace(canvas, info?.skinUrl, name);
      return;
    } catch {}
    drawSkinFace(canvas, null, name);
  });
}

async function askForUsername() {
  return new Promise((resolve) => {
    const modal = document.getElementById('loginModal');
    const input = document.getElementById('usernameInput');
    const btn = document.getElementById('submitUsername');

    modal.style.display = 'flex';
    input.focus(); // Автофокус на поле ввода

    btn.onclick = async () => {
      const val = input.value.trim();
      if (!val) return; // Не закрываем, если ник пустой
      if (!/^[A-Za-z0-9_]{3,16}$/.test(val)) {
        showToast('Ник: 3–16 символов, латинские буквы, цифры и _', 'warn');
        return;
      }

      modal.style.display = 'none';
      resolve(val);
    };
  });
}

// Electron не поддерживает нативный window.prompt() (только alert/confirm) —
// поэтому все места, где раньше стоял prompt(...), молча ничего не показывали
// и возвращали null. Это самодельная замена на нашей модалке.
function askForText(title, defaultValue = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('textPromptModal');
    const titleEl = document.getElementById('textPromptTitle');
    const input = document.getElementById('textPromptInput');
    const okBtn = document.getElementById('textPromptOk');
    const cancelBtn = document.getElementById('textPromptCancel');

    titleEl.textContent = title;
    input.value = defaultValue;
    modal.style.display = 'flex';
    input.focus();
    input.select();

    function cleanup(result) {
      modal.style.display = 'none';
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
      resolve(result);
    }

    okBtn.onclick = () => {
      const val = input.value.trim();
      if (!val) return; // не закрываем, если пусто
      cleanup(val);
    };
    cancelBtn.onclick = () => cleanup(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') okBtn.onclick();
      if (e.key === 'Escape') cancelBtn.onclick();
    };
  });
}

document.getElementById('addAccountBtn').addEventListener('click', async () => {
  document.getElementById('accountsModal').style.display = 'flex';
  await renderAccountsList();
});

document.getElementById('accountRow').addEventListener('click', async () => {
  document.getElementById('accountsModal').style.display = 'flex';
  await renderAccountsList();
});

function closeAccountsModal() {
  document.getElementById('accountsModal').style.display = 'none';
}
document.getElementById('closeAccountChooserBtn').addEventListener('click', closeAccountsModal);
document.getElementById('accountsModal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'accountsModal') closeAccountsModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('accountsModal').style.display === 'flex') closeAccountsModal();
});

// --- окно входа Ely.by (код + кнопка "Копировать" вместо системного диалога) ---
const elybyLoginModal = document.getElementById('elybyLoginModal');
const elybyUserCodeEl = document.getElementById('elybyUserCode');
const elybyVerificationLinkEl = document.getElementById('elybyVerificationLink');
const elybyLoginStatusEl = document.getElementById('elybyLoginStatus');

window.api.onElybyDeviceCode(({ userCode, verificationUri }) => {
  elybyUserCodeEl.textContent = userCode;
  elybyVerificationLinkEl.textContent = verificationUri;
  elybyVerificationLinkEl.href = verificationUri;
  elybyLoginStatusEl.textContent = 'Ожидаю подтверждения на сайте...';
  elybyLoginModal.style.display = 'flex';
});

window.api.onElybyDeviceCodeDone(() => {
  elybyLoginModal.style.display = 'none';
});

document.getElementById('elybyCopyCodeBtn').addEventListener('click', () => {
  const code = elybyUserCodeEl.textContent.trim();
  if (!code) return;
  navigator.clipboard.writeText(code)
    .then(() => showToast('Код скопирован', 'success'))
    .catch(() => showToast('Не удалось скопировать код', 'error'));
});

document.getElementById('elybyCancelLoginBtn').addEventListener('click', async () => {
  elybyLoginStatusEl.textContent = 'Отменяю...';
  await window.api.cancelElybyLogin();
  elybyLoginModal.style.display = 'none';
});

document.getElementById('chooseElybyBtn').addEventListener('click', async () => {
  try {
    log(playLog, "Открытие окна авторизации Ely.by...");
    const profile = await window.api.loginElyby();

    if (profile) {
      log(playLog, `Успешный вход: ${profile.name}`, 'success');
      await refreshAccount();
    }
  } catch (err) {
    console.error(err);
    if (elybyLoginModal.style.display !== 'none') {
      elybyLoginStatusEl.textContent = err.message;
      elybyLoginStatusEl.style.color = '#e07a7a';
      setTimeout(() => {
        elybyLoginModal.style.display = 'none';
        elybyLoginStatusEl.style.color = '';
      }, 2500);
    }
    log(playLog, `Ошибка входа: ${err.message}`, 'error');
    showToast(err.message, 'error');
  }
});

document.getElementById('chooseMicrosoftBtn').addEventListener('click', async () => {
  try {
    log(playLog, "Открытие окна авторизации Microsoft...");
    const profile = await window.api.loginMicrosoft();

    if (profile) {
      log(playLog, `Успешный вход: ${profile.name}`, 'success');
      await refreshAccount();
    }
  } catch (err) {
    console.error(err);
    log(playLog, `Ошибка входа через Microsoft: ${err.message}`, 'error');
  }
});

document.getElementById('chooseOfflineBtn').addEventListener('click', async () => {
  const username = await askForUsername();
  if (!username) return;
  try {
    const profile = await window.api.login(username);
    log(playLog, `Аккаунт добавлен: ${profile.name}`, 'success');
    await refreshAccount();
  } catch (err) {
    log(playLog, `Ошибка добавления аккаунта: ${err.message}`, 'error');
  }
});

// --- версии ---
let favoriteVersions = [];

function sortVersionsWithFavorites(list) {
  const favs = list.filter(v => favoriteVersions.includes(v.id));
  const rest = list.filter(v => !favoriteVersions.includes(v.id));
  return [...favs, ...rest];
}

function renderVersionOptions(list) {
  versionSelect.innerHTML = sortVersionsWithFavorites(list)
    .map(v => `<option value="${escHtml(v.id)}">${favoriteVersions.includes(v.id) ? '★ ' : ''}${escHtml(v.id)}</option>`)
    .join('');
}

function updateFavBtnState() {
  const favBtn = document.getElementById('favVersionBtn');
  favBtn.classList.toggle('active', favoriteVersions.includes(versionSelect.value));
}

let allVersions = [];

async function loadVersions() {
  // без интернета (или если Mojang недоступен) список версий не придёт —
  // раньше из-за этого падал весь запуск интерфейса, и новичок не видел обучение
  try {
    allVersions = await window.api.listVersions();
  } catch (err) {
    allVersions = [];
    console.error('listVersions failed', err);
    showToast('Не удалось загрузить список версий. Проверь интернет и перезапусти лаунчер.', 'error', 'Нет списка версий');
  }

  const settings = await window.api.getSettings();
  window.__notificationMode = settings.notificationMode || 'internal';
  favoriteVersions = settings.favoriteVersions || [];

  renderVersionOptions(allVersions);

  if (settings.lastVersion) versionSelect.value = settings.lastVersion;
  if (settings.lastLoader) loaderSelect.value = settings.lastLoader;
  if (settings.activeBuild) {
    window.__activeBuild = settings.activeBuild;
    versionSelect.value = settings.activeBuild.mcVersion;
    loaderSelect.value = settings.activeBuild.loader;
  }
  updateFavBtnState();
  syncLoaderButtons();

  document.getElementById('gameDirLabel').textContent = settings.gameDir;
  document.getElementById('memMin').value = settings.memoryMin;
  document.getElementById('memMax').value = settings.memoryMax;

  document.getElementById('javaPathLabel').textContent = settings.javaPath || 'по умолчанию (скачается сама)';
  document.getElementById('jvmArgs').value = settings.jvmArgs || '';
  document.getElementById('curseforgeApiKeyInput').value = settings.curseforgeApiKey || '';
  document.getElementById('gameWidth').value = settings.gameWidth;
  document.getElementById('gameHeight').value = settings.gameHeight;
  document.getElementById('fullscreenCheck').checked = !!settings.fullscreen;
  document.getElementById('launcherWidth').value = settings.launcherWidth;
  document.getElementById('launcherHeight').value = settings.launcherHeight;
  document.getElementById('discordRpcCheck').checked = settings.discordRPC !== false;
  document.getElementById('gameLogsCheck').checked = settings.gameLogsEnabled !== false;
  document.getElementById('afterLaunchSelect').value = settings.afterLaunch || 'minimize';
  document.getElementById('debugModeCheck').checked = !!settings.debugMode;
  window.__debug = !!settings.debugMode;
  document.getElementById('gpuPreferenceSelect').value = settings.gpuPreference || 'auto';
  document.getElementById('notificationsCheck').checked = settings.notificationsEnabled !== false;
  const notificationModeSelect = document.getElementById('notificationModeSelect');
  if (notificationModeSelect) notificationModeSelect.value = settings.notificationMode || 'internal';
  configureNotificationSounds(settings);
  renderNotificationSoundSettings(settings);
  document.getElementById('minimizeToTrayCheck').checked = settings.minimizeToTray !== false;
  document.getElementById('backupSavesCheck').checked = settings.backupSavesBeforeReinstall !== false;
  document.getElementById('customSkinLoaderCheck').checked = settings.customSkinLoaderEnabled !== false;
  document.getElementById('customThemeInput').value = settings.themeCustom || '#6aa437';

  if (settings.syntThemeUnlocked) document.getElementById('syntThemeSwatch').style.display = '';

  if (settings.customIconPath) setLogoImage(settings.customIconPath);

  applyTheme(settings.theme || 'green', settings.themeCustom);
  applyThemeMode(settings.themeMode || 'dark');

  return settings;
}

// сохраняем выбор сразу, а не только при запуске — иначе после перезапуска
// лаунчера версия всегда слетала на первую в списке (самую новую)
let selectionChangeTimer = null;
let selectionChangeSerial = 0;
let selectionChangeBusy = false;

async function onSelectionChange() {
  const serial = ++selectionChangeSerial;
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
  await new Promise(resolve => {
    selectionChangeTimer = setTimeout(resolve, 90);
  });
  if (serial !== selectionChangeSerial) return;

  const { mcVersion, loader } = currentSelection();
  await window.api.setLastSelection(mcVersion, loader);
  if (serial !== selectionChangeSerial) return;

  renderCurrentTargetBadge();
  setSelectionLoading(true);
  // Статистика должна обновляться сразу при смене версии, даже без запуска игры.
  await Promise.all([refreshPlaytimeLabel(), refreshLaunchStats()]);
  if (serial !== selectionChangeSerial) return;

  await Promise.all([
    renderWantedList(), renderCopyOptions(), renderResourcePackList(),
    renderModpackOptions(), renderInstalledMods(), renderRpCopyOptions(),
    renderRpProfileOptions(), renderInstalledResourcePacks(), renderShaderList(),
    renderInstalledShaders(), loadCommunityBuildUrl(), renderFabricLoaderSection(),
    renderNeoforgeVersionSection(), renderCopySettingsSection()
  ]);
  if (serial === selectionChangeSerial) setSelectionLoading(false);
}

function setSelectionLoading(isLoading) {
  const ids = ['installedModsList', 'installedRpList', 'installedShList', 'rpWantedList', 'shWantedList'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-loading', isLoading);
    if (isLoading && !el.dataset.hasContent) {
      el.innerHTML = '<div class="list-loading" role="status">Загрузка списка…</div>';
    }
  });
}

function renderCurrentTargetBadge() {
  const { mcVersion, loader } = currentSelection();
  const targets = ['modsCurrentTarget', 'rpCurrentTarget', 'shCurrentTarget'].map(id => document.getElementById(id));
  if (!mcVersion) {
    targets.forEach(el => { el.textContent = 'Версия не выбрана — зайди на вкладку "Главная"'; });
    return;
  }
  const activeBuild = window.__activeBuild;
  const build = activeBuild && activeBuild.mcVersion === mcVersion && activeBuild.loader === loader ? activeBuild : null;
  const prefix = build ? `Сборка <b>${escHtml(build.name)}</b> · ` : 'Сейчас выбрано: ';
  targets.forEach(el => { el.innerHTML = `${prefix}<b>${mcVersion}</b> · <b>${loader}</b>`; });

  // CurseForge для модов имеет смысл только на Forge/NeoForge — на Fabric там почти
  // ничего нет, и большинство модов дублируются с Modrinth без разницы
  const sourceRow = document.getElementById('modSourceRow');
  if (loader === 'forge' || loader === 'neoforge') {
    sourceRow.style.display = 'flex';
  } else {
    sourceRow.style.display = 'none';
    document.getElementById('modSourceSelect').value = 'modrinth';
  }
  updateModSourceHint();
}

function currentModSource() {
  const sourceRow = document.getElementById('modSourceRow');
  if (sourceRow.style.display === 'none') return 'modrinth';
  return document.getElementById('modSourceSelect').value;
}

async function updateModSourceHint() {
  const hint = document.getElementById('modSourceHint');
  if (currentModSource() !== 'curseforge') { hint.textContent = ''; return; }

  const settings = await window.api.getSettings();
  hint.textContent = settings.curseforgeApiKey
    ? ''
    : 'Нужен ключ CurseForge API — добавь его в Настройках (бесплатно на console.curseforge.com)';
}

// форматирует миллисекунды в "12ч 30м" / "45м" — без секунд, они тут не важны
function formatPlaytime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0 && minutes === 0) return null;
  const [h, m] = window.i18n.lang === 'en' ? ['h', 'm'] : ['ч', 'м'];
  if (hours === 0) return `${minutes}${m}`;
  return `${hours}${h} ${minutes}${m}`;
}

let launchStatsRefreshSerial = 0;

async function refreshLaunchStats() {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) return;
  const serial = ++launchStatsRefreshSerial;
  try {
    const stats = await window.api.getLaunchStats(mcVersion, loader);
    const current = currentSelection();
    if (serial !== launchStatsRefreshSerial || current.mcVersion !== mcVersion || current.loader !== loader) return;
    document.getElementById('statsTotalLaunches').textContent = String(stats.totalLaunches || 0);
    document.getElementById('statsInstanceLaunches').textContent = String(stats.instanceLaunches || 0);
    document.getElementById('statsInstancePlaytime').textContent = formatPlaytime(stats.instancePlaytimeMs || 0) || '—';
  } catch (err) {
    console.warn('Не удалось загрузить статистику:', err);
  }
}

async function refreshPlaytimeLabel() {
  const { mcVersion, loader } = currentSelection();
  const el = document.getElementById('playtimeLabel');
  if (!mcVersion) { el.textContent = ''; return; }

  const totalMs = await window.api.getPlaytime(mcVersion, loader);
  const formatted = formatPlaytime(totalMs);
  el.textContent = formatted ? `Наиграно на этой сборке: ${formatted}` : '';
}

window.api.onPlaytimeUpdated(({ mcVersion, loader, totalMs }) => {
  const current = currentSelection();
  if (current.mcVersion !== mcVersion || current.loader !== loader) return;
  document.getElementById('playtimeLabel').textContent = `Наиграно на этой сборке: ${formatPlaytime(totalMs)}`;
  refreshLaunchStats();
});

// --- Gaming Activity ---
let gamingActivityLoadSerial = 0;

function formatActivityDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  const totalMinutes = Math.floor(value / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  if (days) return `${days} д ${restHours} ч`;
  if (hours) return `${hours} ч ${minutes} мин`;
  if (minutes) return `${minutes} мин`;
  return value > 0 ? '<1 мин' : '0 мин';
}

function formatActivityDate(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString(window.i18n.locale, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// --- Download Manager ---
let downloadManagerLoadSerial = 0;

function formatDownloadBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = window.i18n.lang === 'en' ? ['B', 'KB', 'MB', 'GB'] : ['Б', 'КБ', 'МБ', 'ГБ'];
  if (value < 1024) return `${Math.round(value)} ${units[0]}`;
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / Math.pow(1024, power)).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}

function formatDownloadRate(bytesPerSecond) {
  const value = Math.max(0, Number(bytesPerSecond) || 0);
  const suffix = window.i18n.lang === 'en' ? '/s' : '/с';
  return `${formatDownloadBytes(value)}${suffix}`;
}

function formatDownloadEta(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (!value) return '';
  if (value < 60) return `${Math.ceil(value)} ${window.i18n.lang === 'en' ? 's left' : 'с осталось'}`;
  const minutes = Math.floor(value / 60);
  const rest = Math.ceil(value % 60);
  return `${minutes}:${String(rest).padStart(2, '0')} ${window.i18n.lang === 'en' ? 'left' : 'осталось'}`;
}

function getDownloadStatusLabel(status) {
  const labels = {
    running: 'В процессе',
    cancelling: 'Отмена…',
    completed: 'Завершено',
    failed: 'Ошибка',
    cancelled: 'Отменено'
  };
  return labels[status] || 'Подготовка';
}

function renderDownloadTask(task, active) {
  const icons = { minecraft: 'play.svg', mods: 'mods.svg', resourcepacks: 'resourcepacks.svg', shaders: 'shaders.svg', java: 'coffee.svg', repair: 'wrench.svg', build: 'box.svg' };
  const icon = icons[task.type] || 'download.svg';
  const status = getDownloadStatusLabel(task.status);
  const percent = task.status === 'completed' ? 100 : Number.isFinite(Number(task.percent)) ? Math.max(0, Math.min(100, Number(task.percent))) : null;
  const progressWidth = percent == null ? 22 : percent;
  const fileMeta = task.type === 'java' && task.totalBytes > 0
    ? `${formatDownloadBytes(task.downloadedBytes)} / ${formatDownloadBytes(task.totalBytes)}`
    : task.totalFiles > 0 ? `${Number(task.completedFiles || 0)} / ${Number(task.totalFiles)} ${window.i18n.lang === 'en' ? 'files' : 'файлов'}`
      : task.totalBytes > 0 ? `${formatDownloadBytes(task.downloadedBytes)} / ${formatDownloadBytes(task.totalBytes)}` : '';
  const speedMeta = active && Number(task.speedBps) > 0 ? formatDownloadRate(task.speedBps) : '';
  const etaMeta = active && task.etaSeconds ? formatDownloadEta(task.etaSeconds) : '';
  const queuedFiles = Array.isArray(task.queuedFiles) ? task.queuedFiles : [];
  const queueLabel = queuedFiles.length
    ? `${window.i18n.lang === 'en' ? 'Queued' : 'В очереди'}: ${queuedFiles.length}`
    : '';
  const detailParts = [task.stage, task.currentFile ? `${window.i18n.lang === 'en' ? 'File' : 'Файл'}: ${task.currentFile}` : '', queueLabel, task.subtitle, task.build].filter(Boolean);
  const details = detailParts.map(part => window.i18n.t(part)).join(' · ');
  const detailsTooltip = [details, queuedFiles.length ? `${window.i18n.t('Файлы в очереди')}:\n${queuedFiles.join('\n')}` : ''].filter(Boolean).join('\n\n');
  const extra = [fileMeta, speedMeta, etaMeta].filter(Boolean).join(' · ');
  const action = active && task.canCancel
    ? `<button type="button" class="secondary download-action-btn" data-download-action="cancel" data-task-id="${escHtml(task.id)}"><span class="ico" style="--ico-src:url('icons/x.svg')" aria-hidden="true"></span>Отменить</button>`
    : !active && task.canRetry
      ? `<button type="button" class="secondary download-action-btn" data-download-action="retry" data-task-id="${escHtml(task.id)}"><span class="ico" style="--ico-src:url('icons/update.svg')" aria-hidden="true"></span> Повторить</button>`
      : '';
  const date = task.finishedAt || task.createdAt;
  const dateText = date ? new Date(date).toLocaleString(window.i18n.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const progressClass = percent == null ? ' indeterminate' : '';
  return `<article class="download-task-row ${active ? 'is-active' : `is-${escHtml(task.status)}`}" data-task-id="${escHtml(task.id)}">
    <div class="download-task-icon"><span class="ico" style="--ico-src:url('icons/${icon}')" aria-hidden="true"></span></div>
    <div class="download-task-content">
      <div class="download-task-heading"><strong class="download-task-title">${escHtml(task.title || 'Загрузка')}</strong><span class="download-task-status status-${escHtml(task.status)}">${escHtml(status)}</span></div>
      <div class="download-task-subtitle" title="${escHtml(detailsTooltip || dateText)}">${escHtml(details || dateText)}</div>
      <div class="download-task-progress-line"><div class="download-task-track${progressClass}"><i style="width:${progressWidth}%"></i></div><span>${percent == null ? '…' : `${Math.round(percent)}%`}</span></div>
      <div class="download-task-meta">${escHtml(extra || dateText)}${task.error ? `<span class="download-task-error">${escHtml(task.error)}</span>` : ''}</div>
    </div>
    ${action ? `<div class="download-task-actions">${action}</div>` : ''}
  </article>`;
}

function renderDownloadManager(data) {
  if (!data) return;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const active = tasks.filter(task => ['running', 'cancelling'].includes(task.status));
  const history = tasks.filter(task => !['running', 'cancelling'].includes(task.status));
  const setText = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  };

  setText('downloadsActiveCount', Number(data.activeCount ?? active.length));
  setText('downloadsCompletedCount', Number(data.completedCount ?? history.filter(task => task.status === 'completed').length));
  setText('downloadsTotalSpeed', formatDownloadRate(data.totalSpeedBps || 0));
  setText('downloadsActiveLabel', `${active.length} ${window.i18n.lang === 'en' ? 'tasks' : 'задач'}`);
  setText('downloadsHistoryLabel', `${history.length} ${window.i18n.lang === 'en' ? 'tasks' : 'задач'}`);

  const badge = document.getElementById('downloadsBadge');
  if (badge) {
    badge.textContent = active.length > 99 ? '99+' : String(active.length);
    badge.style.display = active.length ? '' : 'none';
  }

  const activeList = document.getElementById('downloadsActiveList');
  if (activeList) activeList.innerHTML = active.length
    ? active.map(task => renderDownloadTask(task, true)).join('')
    : '<div class="download-empty">Сейчас ничего не загружается.</div>';

  const historyList = document.getElementById('downloadsHistoryList');
  if (historyList) historyList.innerHTML = history.length
    ? history.map(task => renderDownloadTask(task, false)).join('')
    : '<div class="download-empty">История пока пустая.</div>';
}

async function loadDownloadManager() {
  const serial = ++downloadManagerLoadSerial;
  const activeList = document.getElementById('downloadsActiveList');
  if (activeList && !activeList.children.length) activeList.innerHTML = '<div class="download-empty">Загружаю список…</div>';
  try {
    const data = await window.api.getDownloadTasks();
    if (serial !== downloadManagerLoadSerial) return;
    renderDownloadManager(data);
  } catch (error) {
    console.warn('[downloads] не удалось загрузить список:', error);
    if (activeList) activeList.innerHTML = `<div class="download-empty">Не удалось загрузить список: ${escHtml(error.message || error)}</div>`;
  }
}

async function handleDownloadAction(event) {
  const button = event.target.closest('[data-download-action]');
  if (!button) return;
  const id = button.dataset.taskId;
  const action = button.dataset.downloadAction;
  button.disabled = true;
  try {
    if (action === 'cancel') {
      const result = await window.api.cancelDownloadTask(id);
      if (!result?.ok) showToast('Эту загрузку нельзя отменить', 'warning');
    } else if (action === 'retry') {
      const result = await window.api.retryDownloadTask(id);
      if (!result?.ok) showToast(result?.error || 'Не удалось повторить загрузку', 'error');
    }
    await loadDownloadManager();
  } catch (error) {
    showToast(error.message || String(error), 'error');
  } finally {
    button.disabled = false;
  }
}

document.getElementById('downloadsActiveList')?.addEventListener('click', handleDownloadAction);
document.getElementById('downloadsHistoryList')?.addEventListener('click', handleDownloadAction);
document.getElementById('refreshDownloadsBtn')?.addEventListener('click', loadDownloadManager);
document.getElementById('clearDownloadsHistoryBtn')?.addEventListener('click', async () => {
  try {
    const data = await window.api.clearDownloadHistory();
    renderDownloadManager(data);
  } catch (error) {
    showToast(error.message || String(error), 'error');
  }
});
window.api.onDownloadsUpdated?.(renderDownloadManager);

function renderGamingActivity(data) {
  if (!data) return;
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };

  setText('activityTotalLaunches', Number(data.totalLaunches || 0).toLocaleString(window.i18n.locale));
  setText('activityTotalPlaytime', formatActivityDuration(data.totalPlaytimeMs || 0));
  setText('activityWeeklyLaunches', Number(data.weeklyLaunches || 0).toLocaleString(window.i18n.locale));
  setText('activityAverageSession', data.weeklyAverageSessionMs ? formatActivityDuration(data.weeklyAverageSessionMs) : '—');

  const chart = document.getElementById('activityChart');
  const days = Array.isArray(data.weekly) ? data.weekly : [];
  const maxPlaytime = Math.max(1, ...days.map(day => Number(day.playtimeMs) || 0));
  if (chart) {
    chart.innerHTML = days.map(day => {
      const date = new Date(day.timestamp);
      const label = date.toLocaleDateString(window.i18n.locale, { weekday: 'short' }).replace(/\.$/, '');
      const playtime = Math.max(0, Number(day.playtimeMs) || 0);
      const launches = Math.max(0, Number(day.launches) || 0);
      const height = playtime > 0 ? Math.max(5, Math.round(playtime / maxPlaytime * 100)) : 2;
      const tooltip = `${date.toLocaleDateString(window.i18n.locale)} · ${formatActivityDuration(playtime)} · запусков: ${launches}`;
      return `<div class="activity-day" title="${escHtml(tooltip)}">
        <span class="activity-day-count">${launches || ''}</span>
        <div class="activity-day-track"><i class="activity-day-bar" style="height:${height}%"></i></div>
        <span class="activity-day-label">${escHtml(label)}</span>
      </div>`;
    }).join('') || '<div class="activity-empty">Пока нет данных за эту неделю.</div>';
  }

  const buildList = document.getElementById('activityBuildList');
  const builds = Array.isArray(data.builds) ? data.builds : [];
  if (buildList) {
    const maxBuildTime = Math.max(1, ...builds.map(build => Number(build.playtimeMs) || 0));
    buildList.innerHTML = builds.length ? builds.map((build, index) => {
      const time = Math.max(0, Number(build.playtimeMs) || 0);
      const launches = Math.max(0, Number(build.launchCount) || 0);
      const width = time > 0 ? Math.max(2, Math.round(time / maxBuildTime * 100)) : 0;
      const detail = `${formatActivityDuration(time)} · запусков: ${launches}`;
      return `<div class="activity-ranked-row" title="${escHtml(detail)}">
        <div class="activity-ranked-main"><span class="activity-rank">${index + 1}</span><span class="activity-ranked-name">${escHtml(build.name || 'Minecraft')}</span></div>
        <span class="activity-ranked-meta">${escHtml(formatActivityDuration(time))}</span>
        <div class="activity-ranked-bar"><i style="width:${width}%"></i></div>
      </div>`;
    }).join('') : '<div class="activity-empty">Здесь появятся сборки, в которых ты играл.</div>';
  }

  const topMods = document.getElementById('activityTopMods');
  const mods = Array.isArray(data.topMods) ? data.topMods : [];
  if (topMods) {
    const maxModUses = Math.max(1, ...mods.map(mod => Number(mod.sessions) || 0));
    topMods.innerHTML = mods.length ? mods.map((mod, index) => {
      const uses = Math.max(0, Number(mod.sessions) || 0);
      const width = Math.max(2, Math.round(uses / maxModUses * 100));
      return `<div class="activity-ranked-row" title="${escHtml(mod.id || '')}">
        <div class="activity-ranked-main"><span class="activity-rank">${index + 1}</span><span class="activity-ranked-name">${escHtml(mod.name || mod.id)}</span></div>
        <span class="activity-ranked-meta">${uses} сесс.</span>
        <div class="activity-ranked-bar"><i style="width:${width}%"></i></div>
      </div>`;
    }).join('') : '<div class="activity-empty">Список модов начнёт собираться после следующих запусков игры.</div>';
  }

  const history = document.getElementById('activityLaunchHistory');
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  setText('activityHistoryCount', `${Number(data.sessionCount ?? sessions.length)} сессий`);
  if (history) {
    const statusLabels = { closed: 'Завершено', crashed: 'Завершилось с ошибкой', interrupted: 'Сессия прервана', running: 'В игре' };
    history.innerHTML = sessions.length ? sessions.slice(0, 40).map(session => {
      const title = session.buildName || `Minecraft ${session.mcVersion} (${session.loader})`;
      const status = session.status || 'closed';
      const duration = formatActivityDuration(session.durationMs || 0);
      return `<div class="activity-history-row">
        <div class="activity-history-primary"><span class="activity-history-title">${escHtml(title)}</span><span class="activity-history-date">${escHtml(formatActivityDate(session.startedAt))} · ${escHtml(session.mcVersion || '')} ${escHtml(session.loader || '')}</span></div>
        <span class="activity-history-duration">${escHtml(duration)}</span>
        <span class="activity-history-status ${status === 'crashed' ? 'crashed' : status === 'interrupted' ? 'interrupted' : ''}">${escHtml(statusLabels[status] || 'Завершено')}</span>
      </div>`;
    }).join('') : '<div class="activity-empty">После следующего запуска Minecraft здесь появится история игровых сессий.</div>';
  }
}

async function loadGamingActivity() {
  const serial = ++gamingActivityLoadSerial;
  const chart = document.getElementById('activityChart');
  if (chart && !chart.children.length) chart.innerHTML = '<div class="activity-empty">Загружаю статистику…</div>';
  try {
    const data = await window.api.getGamingActivity();
    if (serial !== gamingActivityLoadSerial) return;
    renderGamingActivity(data);
  } catch (err) {
    console.warn('[activity] не удалось загрузить статистику:', err);
    if (chart) chart.innerHTML = `<div class="activity-empty">Не удалось загрузить статистику: ${escHtml(err.message || err)}</div>`;
  }
}

document.getElementById('refreshActivityBtn')?.addEventListener('click', loadGamingActivity);
window.api.onGamingActivityUpdated?.(() => {
  if (document.getElementById('tab-activity')?.classList.contains('active')) loadGamingActivity();
});

function setHeroBackgroundImage(bg, src) {
  if (!bg) return;
  const old = bg.querySelector('.hero-bg-image');
  if (old) old.remove();
  if (!src) return;
  const img = document.createElement('img');
  img.className = 'hero-bg-image';
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.src = src;
  bg.appendChild(img);
}

// Заголовок главной: у выбранной сборки — её имя, иначе «Minecraft <версия>»
function updateHeroTitle() {
  const title = document.getElementById('heroBuildTitle');
  const subtitle = document.getElementById('heroBuildSubtitle');
  const version = String(versionSelect?.value || '').replace(/^Minecraft\s+/i, '').trim();
  const loader = loaderSelect?.value || 'fabric';
  const loaderName = loader.charAt(0).toUpperCase() + loader.slice(1);
  const build = window.__activeBuild;
  const named = build && build.mcVersion === version && build.loader === loader;
  if (title) title.textContent = named ? build.name : (version ? `Minecraft ${version}` : 'Minecraft');
  if (subtitle) subtitle.textContent = named ? `Minecraft ${version} · ${loaderName}` : `${loaderName} · FCore Launcher`;
}

let heroBackgroundRequest = 0;

async function updateHeroBackground() {
  const requestId = ++heroBackgroundRequest;
  const hero = document.getElementById('playHero');
  const bg = document.getElementById('playHeroBg');
  const title = document.getElementById('heroBuildTitle');
  const subtitle = document.getElementById('heroBuildSubtitle');
  if (!hero || !bg) return;
  const version = versionSelect?.value || '';
  const loader = loaderSelect?.value || 'fabric';
  // Некоторые старые/импортированные инстансы могут хранить версию уже
  // с префиксом "Minecraft". Не допускаем "Minecraft Minecraft 1.21.8".
  updateHeroTitle();
  try {
    const file = await window.api.getInstanceBackground(version, loader);
    if (requestId !== heroBackgroundRequest) return;
    if (file) {
      // Храним изображение в отдельном img-слое. Так data: URL не зависит от
      // особенностей CSS url() и Windows-путей с пробелами/кириллицей.
      bg.style.backgroundImage = 'none';
      bg.style.backgroundColor = 'transparent';
      setHeroBackgroundImage(bg, file);
      hero.classList.add('has-custom-bg');
    } else {
      bg.style.backgroundImage = '';
      bg.style.backgroundColor = '';
      setHeroBackgroundImage(bg, null);
      hero.classList.remove('has-custom-bg');
    }
  } catch (e) {
    if (requestId === heroBackgroundRequest) console.warn('Не удалось загрузить фон сборки:', e);
  }
}

const backgroundFileInput = document.getElementById('backgroundFileInput');

document.getElementById('changeBackgroundBtn')?.addEventListener('click', () => {
  // Используем обычный <input type=file> в renderer. Это надёжнее системного
  // диалога main process и сразу даёт нам содержимое выбранного изображения.
  backgroundFileInput?.click();
});

backgroundFileInput?.addEventListener('change', async () => {
  const file = backgroundFileInput.files?.[0];
  if (!file) return;
  const version = versionSelect.value;
  const loader = loaderSelect.value;
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    // Уменьшаем огромные изображения перед IPC: фон всё равно отображается
    // внутри окна, поэтому 2560px по длинной стороне достаточно.
    const optimized = await optimizeHeroBackground(dataUrl);
    const saved = await window.api.saveInstanceBackgroundData(version, loader, optimized);
    if (saved) {
      const bg = document.getElementById('playHeroBg');
      const hero = document.getElementById('playHero');
      if (bg && hero) {
        bg.style.backgroundImage = 'none';
        bg.style.backgroundColor = 'transparent';
        setHeroBackgroundImage(bg, saved);
        hero.classList.add('has-custom-bg');
        bg.offsetHeight;
      }
      backgroundFileInput.value = '';
      return;
    }
    showToast('Не удалось сохранить фон', 'error');
  } catch (e) {
    console.error('Ошибка установки фона:', e);
    showToast('Не удалось установить фон', 'error');
  } finally {
    backgroundFileInput.value = '';
  }
});

document.getElementById('resetBackgroundBtn')?.addEventListener('click', async () => {
  const version = versionSelect.value;
  const loader = loaderSelect.value;
  try {
    await window.api.resetInstanceBackground(version, loader);
    const bg = document.getElementById('playHeroBg');
    const hero = document.getElementById('playHero');
    if (bg && hero) {
      bg.style.backgroundImage = '';
      bg.style.backgroundColor = '';
      setHeroBackgroundImage(bg, null);
      hero.classList.remove('has-custom-bg');
    }
    backgroundFileInput.value = '';
    showToast('Фон сброшен');
  } catch (e) {
    console.error('Ошибка сброса фона:', e);
    showToast('Не удалось сбросить фон', 'error');
  }
});

async function optimizeHeroBackground(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 2560;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', .86));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}



[versionSelect, loaderSelect].forEach(el => el.addEventListener('change', onSelectionChange));

versionSelect.addEventListener('change', updateFavBtnState);
versionSelect.addEventListener('change', updateHeroBackground);
loaderSelect.addEventListener('change', updateHeroBackground);

// --- загрузчик модов: строка кнопок вместо выпадающего списка ---
function syncLoaderButtons() {
  document.querySelectorAll('.loader-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.loader === loaderSelect.value);
  });
}

document.querySelectorAll('.loader-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (loaderSelect.value === btn.dataset.loader) return;
    loaderSelect.value = btn.dataset.loader;
    syncLoaderButtons();
    loaderSelect.dispatchEvent(new Event('change'));
  });
});

syncLoaderButtons();

document.getElementById('favVersionBtn').addEventListener('click', async () => {
  const versionId = versionSelect.value;
  favoriteVersions = await window.api.toggleFavoriteVersion(versionId);
  renderVersionOptions(allVersions);
  versionSelect.value = versionId;
  updateFavBtnState();
});

// --- прогресс запуска игры ---
const launchProgressOverlay = document.getElementById('launchProgressOverlay');
const launchProgressPercent = document.getElementById('launchProgressPercent');
const launchProgressBarFill = document.getElementById('launchProgressBarFill');
const launchProgressStatus = document.getElementById('launchProgressStatus');
const launchProgressCount = document.getElementById('launchProgressCount');

function showLaunchProgress() {
  if (!launchProgressOverlay) return;
  launchProgressOverlay.style.display = 'flex';
  launchProgressOverlay.classList.add('active');
  setLaunchProgress(0);
  setLaunchProgressStatus('Подготовка запуска...', 'Подготовка файлов');
}

function setLaunchProgressStatus(status, count = '') {
  if (launchProgressStatus) launchProgressStatus.textContent = status;
  if (launchProgressCount) launchProgressCount.textContent = count;
}

function hideLaunchProgress() {
  if (!launchProgressOverlay) return;
  launchProgressOverlay.classList.remove('active');
  // CSS-анимация завершается отдельно, но overlay не должен оставаться
  // поверх окна из-за старого display:flex !important.
  launchProgressOverlay.style.display = 'none';
  launchProgressOverlay.style.pointerEvents = 'none';
  setLaunchProgress(0);
}

function setLaunchProgress(percent) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  launchProgressPercent.textContent = `${pct}%`;
  launchProgressBarFill.style.width = `${pct}%`;
}

// --- запуск игры ---
const playBtn = document.getElementById('playBtn');
const playBtnLabel = document.getElementById('playBtnLabel');
const PLAY_IDLE_LABEL = playBtnLabel.textContent.trim() || 'Запустить Minecraft';

// плавно меняем текст на кнопке — сначала гасим, потом подставляем новое слово и включаем обратно
function setPlayLabel(text) {
  playBtnLabel.classList.add('swap');
  setTimeout(() => {
    playBtnLabel.textContent = text;
    playBtnLabel.classList.remove('swap');
  }, 150);
}

// --- проверка сборки перед запуском ---

const parseMemoryMb = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim().toUpperCase().replace(',', '.');
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(G|GB|ГБ|M|MB|МБ)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] || 'M';
  return unit.startsWith('G') || unit === 'ГБ' ? amount * 1024 : amount;
};

// Модули Fabric API (fabric-resource-loader-v0 и т.п.) отдельно не скачать — это один мод
function dependencyDownloadId(id) {
  if (id === 'fabric' || id === 'fabric-api-base' || /^fabric-.+-v\d+$/.test(id)) return 'fabric-api';
  return id;
}

function dependencyTitle(id) {
  return dependencyDownloadId(id) === 'fabric-api' ? 'Fabric API' : id;
}

async function collectSystemIssues(mcVersion, loader) {
  const apiMcVersion = String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim();
  const issues = [];

  if (!mcVersion) issues.push({ title: 'Не выбрана версия Minecraft', hint: 'Выберите версию перед запуском.' });
  if (!loader) issues.push({ title: 'Не выбран загрузчик', hint: 'Выберите загрузчик (Vanilla, Fabric, Forge или NeoForge).' });

  try {
    const java = await window.api.checkJava(apiMcVersion);
    if (!java || java.ok === false || java.compatible === false) {
      issues.push({
        title: 'Java может не подойти',
        hint: java?.message || 'Проверьте настройки Java — для этой версии нужна подходящая сборка.'
      });
    }
  } catch (err) {
    issues.push({ title: 'Не удалось проверить Java', hint: err.message || 'Проверьте настройки Java.' });
  }

  try {
    const settings = await window.api.getSettings();
    const minRam = parseMemoryMb(settings?.memoryMin);
    const maxRam = parseMemoryMb(settings?.memoryMax ?? settings?.maxRam ?? settings?.ram);
    if (!maxRam) {
      issues.push({ title: 'Не задан объём оперативной памяти', hint: 'Укажите максимум памяти в настройках.' });
    } else if (maxRam < 2048) {
      issues.push({
        title: `Мало оперативной памяти: ${maxRam} МБ`,
        hint: 'Увеличьте максимум в настройках. Для игры хватит 2 ГБ, для сборок с большим числом модов лучше 4 ГБ и больше.'
      });
    }
    if (minRam && maxRam && minRam > maxRam) {
      issues.push({ title: 'Минимум памяти больше максимума', hint: 'Поправьте значения памяти в настройках.' });
    }
    if (maxRam) {
      const mem = await window.api.getMemoryInfo().catch(() => null);
      const totalMb = mem?.totalBytes ? mem.totalBytes / 1024 / 1024 : 0;
      if (totalMb && maxRam > totalMb * 0.75) {
        issues.push({
          title: `Игре выделено ${maxRam} МБ из ${Math.round(totalMb)} МБ памяти компьютера`,
          hint: 'Системе почти ничего не останется, из-за этого игра и компьютер могут сильно тормозить. Уменьшите максимум примерно до половины от всей памяти.'
        });
      }
    }
  } catch { /* настройки не прочитались — это не повод пугать пользователя */ }

  return issues;
}

// Проблемы модов берём из графа зависимостей — того же, что рисует окно «Зависимости»
async function collectModIssues(mcVersion, loader) {
  const data = await window.api.getModGraph(mcVersion, loader, []);
  const missing = new Map();
  const issues = [];
  const names = list => list.map(n => `«${n}»`).join(', ');

  for (const p of data.problems) {
    if (p.type === 'missing-dependency') {
      const key = dependencyDownloadId(p.dependencyId);
      if (!missing.has(key)) missing.set(key, { type: 'missing', id: key, by: [], disabled: [] });
      const entry = missing.get(key);
      if (!entry.by.includes(p.name)) entry.by.push(p.name);
      for (const f of p.disabledProviders || []) if (!entry.disabled.includes(f)) entry.disabled.push(f);
    } else if (p.type === 'wrong-minecraft-version') {
      issues.push({
        bad: true,
        title: `«${p.name}» не подходит под эту версию игры`,
        hint: `Мод заявлен для другой версии Minecraft. Обновите его во вкладке «Контент» до версии под ${data.mcVersion || 'выбранную'} или удалите.`
      });
    } else if (p.type === 'wrong-dependency-version') {
      const need = p.range?.length ? ` (нужна версия ${p.range.join(' или ')})` : '';
      issues.push({
        title: `«${p.name}» требует другую версию «${dependencyTitle(p.dependencyId)}»${need}`,
        hint: `Обновите «${dependencyTitle(p.dependencyId)}» до подходящей версии. Если не помогает — обновите или удалите «${p.name}».`
      });
    } else if (p.type === 'incompatible' || p.type === 'conflict') {
      issues.push({
        bad: p.type === 'incompatible',
        title: `«${p.name}» ${p.type === 'incompatible' ? 'несовместим с' : 'конфликтует с'} «${dependencyTitle(p.dependencyId)}»`,
        hint: `Оставьте что-то одно: отключите «${p.name}» или «${dependencyTitle(p.dependencyId)}» во вкладке «Контент».`
      });
    } else if (p.type === 'duplicate') {
      issues.push({
        bad: true,
        title: `Мод «${p.modId}» установлен несколько раз`,
        hint: `В нескольких JAR указан один и тот же ID мода: ${p.files.join(', ')}. Проверьте версии и оставьте один актуальный файл.`
      });
    } else if (p.type === 'duplicate-content') {
      issues.push({
        bad: true,
        title: 'Найдены побайтно одинаковые файлы модов',
        hint: `SHA-256 совпадает у файлов: ${p.files.join(', ')}. Это настоящие копии одного JAR, даже если их названия отличаются.`
      });
    }
  }

  for (const m of data.mods) {
    if (!m.error || !m.enabled) continue;
    issues.push({
      title: `Не удалось прочитать ${m.fileName}`,
      hint: `${m.error}. Возможно, файл повреждён или сделан для другого загрузчика — переустановите его или удалите.`
    });
  }

  const missingList = [...missing.values()].map(m => ({
    ...m,
    title: `Не хватает «${dependencyTitle(m.id)}»`,
    hint: m.disabled.length
      ? `Он нужен для ${names(m.by)} и лежит в папке модов выключенным — включите его.`
      : `Он нужен для ${names(m.by)}. Скачайте его кнопкой ниже или найдите во вкладке «Контент».`
  }));

  return [...missingList, ...issues];
}

function showBuildCheckDialog({ mcVersion, loader, system, mods }) {
  return new Promise(resolve => {
    const modal = document.getElementById('buildCheckModal');
    const title = document.getElementById('bcTitle');
    const badge = document.getElementById('bcBadge');
    const body = document.getElementById('bcBody');
    const status = document.getElementById('bcStatus');
    const fixBtn = document.getElementById('bcFixBtn');
    const launchBtn = document.getElementById('bcLaunchBtn');
    const cancelBtn = document.getElementById('bcCancelBtn');
    let busy = false;

    const itemHtml = it => {
      const action = it.type === 'missing'
        ? (it.disabled.length
          ? `<button class="secondary bc-item-btn" data-enable="${escHtml(it.disabled[0])}">Включить</button>`
          : `<button class="secondary bc-item-btn" data-download="${escHtml(it.id)}">Скачать</button>`)
        : '';
      return `<div class="bc-item ${it.bad ? 'is-bad' : ''}">
        <div class="bc-item-head"><div class="bc-item-title">${escHtml(it.title)}</div>${action}</div>
        <div class="bc-item-hint">${escHtml(it.hint)}</div>
      </div>`;
    };

    const group = (label, list) => list.length
      ? `<div><div class="bc-group-title">${label}<b>${list.length}</b></div><div class="bc-list">${list.map(itemHtml).join('')}</div></div>`
      : '';

    const draw = () => {
      const total = system.length + mods.length;
      const downloadable = mods.filter(m => m.type === 'missing' && !m.disabled.length);
      title.textContent = total ? 'Нужно внимание' : 'Всё в порядке';
      badge.textContent = total ? String(total) : '✓';
      badge.classList.toggle('is-ok', !total);
      body.innerHTML = total
        ? group('Моды', mods) + group('Система', system)
        : '<div class="bc-ok">Проблем не найдено — можно запускать.</div>';
      launchBtn.textContent = total ? 'Всё равно запустить' : 'Запустить';
      fixBtn.style.display = downloadable.length ? '' : 'none';
      fixBtn.textContent = downloadable.length > 1 ? `Скачать недостающие (${downloadable.length})` : 'Скачать недостающее';
      [fixBtn, launchBtn, cancelBtn].forEach(b => { b.disabled = busy; });
      body.querySelectorAll('button[data-download]').forEach(b => { b.disabled = busy; b.addEventListener('click', () => download([b.dataset.download])); });
      body.querySelectorAll('button[data-enable]').forEach(b => { b.disabled = busy; b.addEventListener('click', () => enable(b.dataset.enable)); });
    };

    const refresh = async () => {
      try { mods = await collectModIssues(mcVersion, loader); } catch { /* оставим прошлый результат */ }
      draw();
    };

    const download = async ids => {
      busy = true;
      draw();
      let done = 0;
      const failed = [];
      for (const id of ids) {
        status.textContent = `Скачиваю «${dependencyTitle(id)}» (${done + failed.length + 1} из ${ids.length})...`;
        try {
          const res = await window.api.installMissingDependency(mcVersion, loader, id);
          if (res.ok) done++; else failed.push(`«${dependencyTitle(id)}»: ${res.error}`);
        } catch (err) {
          failed.push(`«${dependencyTitle(id)}»: ${err.message}`);
        }
      }
      busy = false;
      status.textContent = failed.length ? failed.join('\n') : '';
      if (done && typeof renderInstalledMods === 'function') renderInstalledMods();
      await refresh();
    };

    const enable = async fileName => {
      busy = true;
      draw();
      try { await window.api.setModEnabled(mcVersion, loader, fileName, true); } catch (err) { status.textContent = err.message; }
      busy = false;
      if (typeof renderInstalledMods === 'function') renderInstalledMods();
      await refresh();
    };

    const finish = result => {
      modal.style.display = 'none';
      document.removeEventListener('keydown', onKey);
      modal.removeEventListener('mousedown', onBackdrop);
      fixBtn.onclick = launchBtn.onclick = cancelBtn.onclick = null;
      status.textContent = '';
      resolve(result);
    };
    const onKey = e => { if (e.key === 'Escape' && !busy) finish(false); };
    const onBackdrop = e => { if (e.target === modal && !busy) finish(false); };

    fixBtn.onclick = () => download(mods.filter(m => m.type === 'missing' && !m.disabled.length).map(m => m.id));
    launchBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    document.addEventListener('keydown', onKey);
    modal.addEventListener('mousedown', onBackdrop);

    draw();
    modal.style.display = 'flex';
    launchBtn.focus();
  });
}

async function runBuildCheck(mcVersion, loader) {
  const [system, mods] = await Promise.all([
    collectSystemIssues(mcVersion, loader),
    collectModIssues(mcVersion, loader).catch(err => [{
      title: 'Не удалось проверить моды',
      hint: err?.message || 'Не получилось прочитать JAR-файлы.'
    }])
  ]);

  if (!system.length && !mods.length) {
    log(playLog, '✓ Проверка сборки пройдена', 'success');
    return true;
  }
  log(playLog, `⚠ Проверка сборки: найдено проблем — ${system.length + mods.length}`, 'error');
  return showBuildCheckDialog({ mcVersion, loader, system, mods });
}

let pendingQuickPlay = null;

playBtn.addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const quickPlay = pendingQuickPlay;
  pendingQuickPlay = null;

  try {
    playBtn.disabled = true; // Блокируем кнопку, чтобы не нажали дважды
    playBtn.classList.add('busy');
    setPlayLabel('Запуск...');
    log(playLog, 'Проверка сборки...');
    const buildCheckPassed = await runBuildCheck(mcVersion, loader);
    if (!buildCheckPassed) {
      setPlayLabel(PLAY_IDLE_LABEL);
      return;
    }
    log(playLog, "Проверка аккаунта...");

    let account = await window.api.currentAccount();

    if (!account || account.name === 'Player') {
      const username = await askForUsername();
      if (!username) {
        playBtn.disabled = false;
        playBtn.classList.remove('busy');
        setPlayLabel(PLAY_IDLE_LABEL);
        return;
      }
      log(playLog, `Авторизация под ником ${username}...`);
      account = await window.api.login(username);
      await refreshAccount();
    }

    log(playLog, `Запуск игры для ${account.name}...`, 'success');
    if (quickPlay) log(playLog, quickPlay.type === 'server' ? `Сразу зайдём на сервер «${quickPlay.label}»` : `Сразу зайдём в мир «${quickPlay.label}»`);
    showLaunchProgress();
    await window.api.launchGame(mcVersion, loader, quickPlay);
    hideLaunchProgress(); // прогресс — это скачивание/установка, а не вся сессия игры; дальше просто идёт лог

    setPlayLabel('Запущено');
    refreshLaunchStats();
    setTimeout(() => setPlayLabel(PLAY_IDLE_LABEL), 2500);

  } catch (err) {
    console.error(err);
    log(playLog, `Ошибка: ${err.message}`, 'error');
    setPlayLabel(PLAY_IDLE_LABEL);
    hideLaunchProgress();
  } finally {
    playBtn.disabled = false; // Разблокируем кнопку в любом случае
    playBtn.classList.remove('busy');
  }
});

window.api.onGameProgress(p => {
  if (p.stage === 'performance-sample') { window.fcDiag.onPerformanceSample(p); return; }
  if (p.stage === 'performance-stopped') { window.fcDiag.onPerformanceStopped(); return; }
  if (p.stage === 'installing-loader') { setLaunchProgressStatus(`Установка ${p.loader}...`, 'Подготовка загрузчика'); log(playLog, `Установка ${p.loader}...`); }
  else if (p.stage === 'java-check') { setLaunchProgressStatus('Проверка Java', 'Проверяем окружение'); log(playLog, 'Проверка версии Java...'); }
  else if (p.stage === 'java-download') { setLaunchProgressStatus('Загрузка Java', 'Подготавливаем Java для запуска');
    if (p.total) {
      setLaunchProgress((p.downloaded / p.total) * 100);
      log(playLog, `Скачивание Java ${p.javaMajor}: ${Math.round(p.downloaded / 1024 / 1024)}/${Math.round(p.total / 1024 / 1024)} МБ`);
    } else {
      log(playLog, `Скачивание Java ${p.javaMajor}...`);
    }
  }
  else if (p.stage === 'java-extract') { setLaunchProgressStatus('Распаковка Java', 'Финальная подготовка'); setLaunchProgress(100); log(playLog, `Распаковка Java ${p.javaMajor}...`); }
  else if (p.stage === 'progress' || p.stage === 'download') { setLaunchProgressStatus('Загрузка файлов Minecraft', p.total ? `${p.task} / ${p.total}` : 'Подготовка ресурсов');
    // Не пишем каждое событие скачивания в DOM: это вызывало сильные лаги.
    if (p.total) setLaunchProgress((p.task / p.total) * 100);
  }
  else if (p.stage === 'log-batch') {
    queuePlayLog(p.data);
    if (window.__debug && p.debug.length) queuePlayLog(p.debug.map(m => `[debug] ${m}`));
  }
  else if (p.stage === 'authlib-log') {
    if (p.lines.length) {
      log(playLog, `authlib-injector: ${p.lines.length} строк в логе, похоже была ошибка`, 'warn');
      log(playLog, `Полный лог: ${p.logPath}`, 'warn');
    } else {
      log(playLog, 'authlib-injector отработал без ошибок', 'success');
    }
  }
  else if (p.stage === 'game-started') { setLaunchProgressStatus('Minecraft запущен', 'Окно игры открыто'); setLaunchProgress(100); hideLaunchProgress(); playNotificationSound('notification'); log(playLog, 'Minecraft запущен.', 'success'); }
  else if (p.stage === 'crash') { log(playLog, `Игра завершилась с ошибкой (код ${p.code}). Отчёт: ${p.crashPath}`, 'error'); hideLaunchProgress(); }
  else if (p.stage === 'closed') { log(playLog, `Игра закрыта (код ${p.code})`, 'warn'); hideLaunchProgress(); }
  else if (p.stage === 'crash-analysis') window.fcDiag.onCrashAnalysis(p);
  else if (p.stage === 'java-warning') { log(playLog, p.message, 'warn'); showToast(p.message, 'warn', 'Проверь версию Java'); }
});

document.getElementById('openGameFolderBtn').addEventListener('click', () => {
  const { mcVersion, loader } = currentSelection();
  window.api.openFolder(mcVersion, loader, 'game');
});

document.getElementById('openModsFolderBtn').addEventListener('click', () => {
  const { mcVersion, loader } = currentSelection();
  window.api.openFolder(mcVersion, loader, 'mods');
});

document.getElementById('openAuthlibLogBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const opened = await window.api.openAuthlibLog(mcVersion, loader);
  if (!opened) log(playLog, 'Лог authlib-injector пока не создан — сначала запусти игру под Ely.by аккаунтом', 'warn');
});

document.getElementById('openScreenshotsBtn').addEventListener('click', () => {
  const { mcVersion, loader } = currentSelection();
  window.api.openFolder(mcVersion, loader, 'screenshots');
});

document.getElementById('openLogsFolderBtn').addEventListener('click', () => {
  const { mcVersion, loader } = currentSelection();
  window.api.openFolder(mcVersion, loader, 'logs');
});

document.getElementById('openRootFolderBtn').addEventListener('click', () => {
  const { mcVersion, loader } = currentSelection();
  window.api.openFolder(mcVersion, loader, 'root');
});

document.getElementById('exportModsBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const btn = document.getElementById('exportModsBtn');
  btn.disabled = true;
  try {
    await window.api.exportInstance(mcVersion, loader);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('importInstanceBtn').addEventListener('click', () => {
  document.getElementById('importModal').style.display = 'flex';
});

document.getElementById('closeImportModalBtn').addEventListener('click', () => {
  document.getElementById('importModal').style.display = 'none';
});

document.getElementById('importFromFileBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  try {
    const result = await window.api.importInstanceFromFile(mcVersion, loader);
    if (!result) return;
    document.getElementById('importModal').style.display = 'none';
    log(playLog, `Импортировано: модов ${result.modsCopied}, ресурспаков ${result.resourcePacksCopied}`, 'success');
    await renderWantedList();
    await renderResourcePackList();
  } catch (err) {
    log(playLog, `Ошибка импорта: ${err.message}`, 'error');
  }
});

document.getElementById('importFromUrlBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const url = document.getElementById('importUrlInput').value.trim();
  if (!url) return;
  try {
    const result = await window.api.importInstanceFromUrl(mcVersion, loader, url);
    document.getElementById('importModal').style.display = 'none';
    log(playLog, `Импортировано по ссылке: модов ${result.modsCopied}, ресурспаков ${result.resourcePacksCopied}`, 'success');
    await renderWantedList();
    await renderResourcePackList();
  } catch (err) {
    log(playLog, `Ошибка импорта по ссылке: ${err.message}`, 'error');
  }
});

document.getElementById('exportMrpackBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  const btn = document.getElementById('exportMrpackBtn');
  btn.disabled = true;
  log(playLog, 'Собираю .mrpack...');
  try {
    const result = await window.api.exportMrpack(mcVersion, loader);
    log(playLog, `Готово: ${result.modsIncluded} модов в архиве${result.modsSkipped ? `, пропущено ${result.modsSkipped}` : ''}`, 'success');
    showToast('.mrpack собран', 'success');
  } catch (err) {
    log(playLog, `Ошибка экспорта .mrpack: ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('importMrpackBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  const btn = document.getElementById('importMrpackBtn');
  btn.disabled = true;
  log(playLog, 'Импорт .mrpack...');
  try {
    const result = await window.api.importMrpackFromFile(mcVersion, loader);
    if (!result) return; // диалог выбора файла закрыли без выбора

    if (result.mcVersionMismatch) {
      log(playLog, `Внимание: модпак собран под ${result.mcVersionInPack}, а выбрана ${mcVersion} — часть модов может не подойти`, 'warn');
    }
    log(playLog, `Импортировано: файлов ${result.filesDownloaded}, опознано на Modrinth ${result.modsIdentified}${result.filesFailed ? `, не скачалось ${result.filesFailed}` : ''}`, 'success');
    showToast('.mrpack импортирован', 'success');
    await renderWantedList();
  } catch (err) {
    log(playLog, `Ошибка импорта .mrpack: ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('importCurseforgeBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  const btn = document.getElementById('importCurseforgeBtn');
  btn.disabled = true;
  log(playLog, 'Импорт модпака CurseForge...');
  try {
    const result = await window.api.importCurseforgeModpack(mcVersion, loader);
    if (!result) return; // диалог выбора файла закрыли без выбора

    if (result.mcVersionMismatch) {
      log(playLog, `Внимание: модпак собран под ${result.mcVersionInPack}, а выбрана ${mcVersion} — часть модов может не подойти`, 'warn');
    }
    if (result.loaderMismatch) {
      log(playLog, `Внимание: модпак собран под ${result.loaderInPack}, а выбран ${loader}`, 'warn');
    }
    log(playLog, `Импортировано: файлов ${result.filesDownloaded}, добавлено в список ${result.modsAdded}${result.filesFailed ? `, не скачалось ${result.filesFailed}` : ''}`, 'success');
    showToast('Модпак CurseForge импортирован', 'success');
    await renderWantedList();
  } catch (err) {
    log(playLog, `Ошибка импорта модпака CurseForge: ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('verifyFilesBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const btn = document.getElementById('verifyFilesBtn');
  btn.disabled = true;
  log(playLog, `Проверка файлов сборки ${mcVersion} (${loader})...`);

  try {
    const report = await window.api.verifyFiles(mcVersion, loader);

    const conflicts = report.conflicts || report.duplicates || report.mods?.conflicts || report.mods?.duplicates;
    if (Array.isArray(conflicts) && conflicts.length) {
      showToast(`Найдено конфликтов модов: ${conflicts.length}`, 'warn', 'Конфликт модов');
    }

    log(playLog, report.core.jarOk ? 'Клиент майна: на месте' : 'Клиент майна: отсутствует, докачается при запуске', report.core.jarOk ? 'success' : 'warn');
    log(playLog, report.core.librariesOk ? 'Библиотеки: на месте' : 'Библиотеки: отсутствуют, докачаются при запуске', report.core.librariesOk ? 'success' : 'warn');
    log(playLog, report.core.assetsOk ? 'Ассеты: на месте' : 'Ассеты: отсутствуют, докачаются при запуске', report.core.assetsOk ? 'success' : 'warn');

    // Если проверка вернула конкретные отсутствующие модовые зависимости,
    // открываем вкладку «Моды» сразу с готовым поиском.
    const missingDependency = report.missingDependency || report.missingDependencies?.[0];
    if (missingDependency) {
      const dependencyName = typeof missingDependency === 'string'
        ? missingDependency
        : (missingDependency.title || missingDependency.name || missingDependency.id);
      if (dependencyName) {
        log(playLog, `Не найдена зависимость: ${dependencyName}. Открываю поиск модов...`, 'warn');
        openModSearchForDependency(dependencyName);
      }
    }

    if (report.mods.installed.length) {
      log(playLog, `Моды не совпадают с сохранённым списком: ${report.mods.installed.length}`, 'warn');
      report.mods.installed.forEach(m => log(playLog, `  ! ${m.title}`, 'warn'));
    } else {
      log(playLog, 'Моды: всё совпадает', 'success');
    }

    if (report.resourcepacks.installed.length) {
      log(playLog, `Ресурспаки не совпадают с сохранённым списком: ${report.resourcepacks.installed.length}`, 'warn');
    } else {
      log(playLog, 'Ресурспаки: всё совпадает', 'success');
    }
  } catch (err) {
    console.error(err);
    log(playLog, `Не удалось проверить файлы: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('verifyAndFixBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const btn = document.getElementById('verifyAndFixBtn');
  const confirmed = await customConfirm('Проверить файлы сборки и автоматически починить найденные проблемы?\n\nБитые файлы клиента будут перекачаны, моды/ресурспаки — переустановлены по сохранённому списку. Перед этим сохранится снимок текущей сборки на случай отката.');
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = 'Проверяю и чиню...';
  log(playLog, `Проверка и починка сборки ${mcVersion} (${loader})...`);

  try {
    const result = await window.api.verifyAndFix(mcVersion, loader);

    log(playLog, result.coreFixed ? 'Битые файлы клиента удалены — перекачаются при следующем запуске' : 'Файлы клиента были в порядке', 'success');
    if (result.corePendingNote) log(playLog, result.corePendingNote, 'info');
    log(playLog, `Модов переустановлено: ${result.mods.installed.length}, ошибок: ${result.mods.failed.length}`, result.mods.failed.length ? 'warn' : 'success');
    log(playLog, `Ресурспаков переустановлено: ${result.resourcepacks.installed.length}, ошибок: ${result.resourcepacks.failed.length}`, result.resourcepacks.failed.length ? 'warn' : 'success');

    showToast('Проверка и починка завершены', 'success', undefined, false);
    playNotificationSound('repair');
    await renderInstalledMods();
  } catch (err) {
    log(playLog, `Не удалось починить сборку: ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Проверить и исправить';
  }
});

// --- сборка сообщества: ссылка + обновление в один клик ---
async function loadCommunityBuildUrl() {
  const { mcVersion, loader } = currentSelection();
  const input = document.getElementById('communityBuildUrlInput');
  if (!mcVersion) { input.value = ''; return; }
  const url = await window.api.getCommunityBuildUrl(mcVersion, loader);
  input.value = url || '';
}

document.getElementById('saveCommunityBuildUrlBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }
  const url = document.getElementById('communityBuildUrlInput').value.trim();
  await window.api.setCommunityBuildUrl(mcVersion, loader, url);
  showToast(url ? 'Ссылка на сборку сообщества сохранена' : 'Ссылка очищена', 'success');
});

document.getElementById('updateCommunityBuildBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  const confirmed = await customConfirm('Обновить сборку до последней версии сообщества?\n\nТекущий список модов и ресурспаков будет заменён списком из сборки сообщества. Перед этим сохранится снимок текущего состояния — при необходимости можно откатиться в настройках.');
  if (!confirmed) return;

  const btn = document.getElementById('updateCommunityBuildBtn');
  btn.disabled = true;
  btn.textContent = 'Обновляю...';
  log(playLog, 'Обновляю сборку до версии сообщества...');

  try {
    const result = await window.api.updateCommunityBuild(mcVersion, loader);
    log(playLog, `Установлено из сборки: модов ${result.importResult.modsCopied}, ресурспаков ${result.importResult.resourcePacksCopied}`, 'success');
    log(playLog, `Докачано дополнительно: модов ${result.mods.installed.length}, ресурспаков ${result.resourcepacks.installed.length}`, 'success');
    if (result.mods.failed.length) result.mods.failed.forEach(f => log(playLog, `Не удалось установить мод ${f.title}: ${f.reason}`, 'warn'));
    showToast('Сборка обновлена до последней версии сообщества', 'success');
    await renderWantedList();
    await renderResourcePackList();
    await renderInstalledMods();
    await renderInstalledResourcePacks();
  } catch (err) {
    log(playLog, `Не удалось обновить сборку: ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Обновить сборку до последней версии сообщества';
  }
});

// --- Meteor Client: качается напрямую с GitHub Releases, не через Modrinth ---
document.getElementById('checkMeteorClientBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const status = document.getElementById('meteorClientStatus');
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  status.textContent = 'Проверяю...';
  const result = await window.api.checkMeteorClient(mcVersion, loader);
  if (!result.ok) {
    status.textContent = `Ошибка: ${result.error}`;
    showToast(result.error, 'error');
    return;
  }
  if (result.hasUpdate) {
    const src = result.source === 'archive' ? 'архив' : 'официальный релиз';
    status.textContent = `Доступна версия ${result.version} (${src}), сейчас: ${result.current || 'не установлена'}`;
  } else {
    status.textContent = `Установлена последняя версия (${result.current})`;
  }
});

document.getElementById('installMeteorClientBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  const btn = document.getElementById('installMeteorClientBtn');
  const row = document.getElementById('meteorClientProgressRow');
  const bar = document.getElementById('meteorClientProgressBar');
  const label = document.getElementById('meteorClientProgressLabel');
  btn.disabled = true;
  row.style.display = 'flex';
  bar.value = 0;
  label.textContent = 'Загрузка...';

  try {
    const result = await window.api.installMeteorClient(mcVersion, loader);
    if (!result.ok) throw new Error(result.error);
    document.getElementById('meteorClientStatus').textContent = `Установлена версия ${result.version}`;
    showToast(`Meteor Client обновлён до ${result.version}${result.source === 'archive' ? ' (архив)' : ''}`, 'success');
    await renderInstalledMods();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    row.style.display = 'none';
  }
});

window.api.onMeteorProgress(({ percent }) => {
  const bar = document.getElementById('meteorClientProgressBar');
  const label = document.getElementById('meteorClientProgressLabel');
  bar.value = Math.round(percent);
  label.textContent = `Загрузка... ${Math.round(percent)}%`;
});

// --- версия Fabric Loader: по умолчанию авто, но можно закрепить конкретную ---
const fabricLoaderVersionsCache = {}; // mcVersion -> список версий, чтобы не дёргать meta.fabricmc.net на каждый чих

function fillFabricLoaderVersionSelect(versions, selected) {
  const select = document.getElementById('fabricLoaderVersionSelect');
  select.innerHTML = '<option value="">Автоматически (последняя стабильная)</option>';
  versions.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.version;
    opt.textContent = v.stable ? `${v.version} (стабильная)` : v.version;
    select.appendChild(opt);
  });
  select.value = selected || '';
}

async function renderFabricLoaderSection(forceRefresh = false) {
  const { mcVersion, loader } = currentSelection();
  const section = document.getElementById('fabricLoaderSection');

  if (!mcVersion || loader !== 'fabric') {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const selected = await window.api.getFabricLoaderVersion(mcVersion, loader);

  if (!forceRefresh && fabricLoaderVersionsCache[mcVersion]) {
    fillFabricLoaderVersionSelect(fabricLoaderVersionsCache[mcVersion], selected);
    return;
  }

  try {
    const versions = await window.api.listFabricLoaderVersions(mcVersion);
    fabricLoaderVersionsCache[mcVersion] = versions;
    fillFabricLoaderVersionSelect(versions, selected);
  } catch (err) {
    fillFabricLoaderVersionSelect([], selected);
    showToast(`Не удалось получить список версий Fabric Loader: ${err.message}`, 'error');
  }
}

// --- версия NeoForge: так же, как с Fabric Loader — по умолчанию авто ---
const neoforgeVersionsCache = {}; // mcVersion -> список версий, чтобы не дёргать maven на каждый чих

function fillNeoforgeVersionSelect(versions, selected) {
  const select = document.getElementById('neoforgeVersionSelect');
  select.innerHTML = '<option value="">Автоматически (последняя стабильная)</option>';
  versions.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.version;
    opt.textContent = v.stable ? `${v.version} (стабильная)` : `${v.version} (бета)`;
    select.appendChild(opt);
  });
  select.value = selected || '';
}

async function renderNeoforgeVersionSection(forceRefresh = false) {
  const { mcVersion, loader } = currentSelection();
  const section = document.getElementById('neoforgeVersionSection');

  if (!mcVersion || loader !== 'neoforge') {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const selected = await window.api.getNeoforgeVersion(mcVersion, loader);

  if (!forceRefresh && neoforgeVersionsCache[mcVersion]) {
    fillNeoforgeVersionSelect(neoforgeVersionsCache[mcVersion], selected);
    return;
  }

  try {
    const versions = await window.api.listNeoforgeVersions(mcVersion);
    neoforgeVersionsCache[mcVersion] = versions;
    fillNeoforgeVersionSelect(versions, selected);
  } catch (err) {
    fillNeoforgeVersionSelect([], selected);
    showToast(`Не удалось получить список версий NeoForge: ${err.message}`, 'error');
  }
}

document.getElementById('refreshNeoforgeVersionsBtn').addEventListener('click', () => renderNeoforgeVersionSection(true));

document.getElementById('saveNeoforgeVersionBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }
  const version = document.getElementById('neoforgeVersionSelect').value;
  await window.api.setNeoforgeVersion(mcVersion, loader, version);
  showToast(version ? `NeoForge закреплён на ${version}` : 'Версия NeoForge снова выбирается автоматически', 'success');
});

// --- копирование настроек (звук/графика/config модов) из другой уже существующей версии ---
async function renderCopySettingsSection() {
  const { mcVersion, loader } = currentSelection();
  const select = document.getElementById('copySettingsSourceSelect');
  select.innerHTML = '<option value="">Выбери версию-источник</option>';

  if (!mcVersion) return;

  const others = await window.api.listOtherInstances(mcVersion, loader);
  others.forEach(inst => {
    const opt = document.createElement('option');
    opt.value = `${inst.mcVersion}|${inst.loader}`;
    opt.textContent = `${inst.mcVersion} (${inst.loader})`;
    select.appendChild(opt);
  });
}

document.getElementById('copySettingsBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const raw = document.getElementById('copySettingsSourceSelect').value;
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }
  if (!raw) { showToast('Выбери версию, откуда копировать', 'warn'); return; }

  const [fromVersion, fromLoader] = raw.split('|');
  const btn = document.getElementById('copySettingsBtn');
  btn.disabled = true;
  try {
    const copied = await window.api.copyInstanceSettings(
      { mcVersion: fromVersion, loader: fromLoader },
      { mcVersion, loader }
    );
    if (!copied.length) showToast('В исходной версии не нашлось файлов настроек', 'warn');
    else showToast(`Скопировано: ${copied.join(', ')}`, 'success');
  } catch (err) {
    showToast(`Не удалось скопировать настройки: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('refreshFabricLoaderVersionsBtn').addEventListener('click', () => renderFabricLoaderSection(true));

document.getElementById('saveFabricLoaderVersionBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }
  const version = document.getElementById('fabricLoaderVersionSelect').value;
  await window.api.setFabricLoaderVersion(mcVersion, loader, version);
  showToast(version ? `Fabric Loader закреплён на ${version}` : 'Версия Fabric Loader снова выбирается автоматически', 'success');
});

// --- моды ---
async function renderWantedList() {
  const { mcVersion, loader } = currentSelection();
  const apiMcVersion = String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim();
  const wanted = await window.api.getWantedMods(apiMcVersion, loader);
  const container = document.getElementById('wantedList');

  document.getElementById('wantedBulkRow').style.display = wanted.length ? 'flex' : 'none';
  const selectAllChk = document.getElementById('wantedSelectAll');
  selectAllChk.checked = false;
  selectAllChk.indeterminate = false;
  document.getElementById('wantedRemoveSelectedBtn').disabled = true;

  if (!wanted.length) {
    container.innerHTML = '<div class="desc">Список пуст — найди мод слева и нажми "Добавить"</div>';
    return;
  }

  // узнаём, каким модам из списка есть обновление — тем же сухим прогоном,
  // что и фоновая проверка при старте, заодно получаем имя файла уже установленных
  // (нужно, чтобы можно было закрепить версию — знать, что именно защищать от переустановки)
  let pendingIds = new Set();
  const installedFileByProjectId = new Map();
  try {
    const dryReport = await window.api.reinstallMods(mcVersion, loader, true);
    pendingIds = new Set(dryReport.installed.map(m => m.projectId));
    dryReport.skipped.forEach(s => { if (s.fileName) installedFileByProjectId.set(s.projectId, s.fileName); });
  } catch {
    // не смогли проверить — просто не покажем бейджи/пин, ничего страшного
  }

  container.innerHTML = wanted.map(mod => {
    const fileName = mod.pinnedFileName || installedFileByProjectId.get(mod.projectId) || '';
    const canPin = !mod.pinned && fileName && !pendingIds.has(mod.projectId);
    let pinBtn = '';
    if (mod.pinned) pinBtn = '<button class="pin-btn" data-pin="0" title="Разрешить переустановке обновлять этот мод"><img class="inline-ico" src="icons/pin.svg" alt="">Открепить</button>';
    else if (canPin) pinBtn = '<button class="pin-btn" data-pin="1" title="Не давать переустановке трогать текущую версию"><img class="inline-ico" src="icons/pin.svg" alt="">Закрепить</button>';

    return `
    <div class="mod-card ${pendingIds.has(mod.projectId) ? 'has-update' : ''} ${mod.pinned ? 'is-pinned' : ''}" data-id="${escHtml(mod.projectId)}" data-title="${escHtml(mod.title)}" data-filename="${escHtml(fileName)}">
      <input type="checkbox" class="wanted-check">
      ${mod.icon ? `<img src="${escHtml(mod.icon)}" loading="lazy">` : ''}
      <div class="title">${escHtml(mod.title)}${mod.pinned ? ' <span class="pin-tag">закреплён</span>' : ''}</div>
      ${!mod.pinned && pendingIds.has(mod.projectId) ? '<button class="update-one-btn"><img class="inline-ico" src="icons/update.svg" alt="">Обновить</button>' : ''}
      ${pinBtn}
      <button class="remove-btn">Убрать</button>
    </div>
  `;
  }).join('');

  container.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      if (!await customConfirm(`Убрать «${card.dataset.title}» из списка?`)) return;
      await window.api.removeMod(mcVersion, loader, card.dataset.id);
      renderWantedList();
    });
  });

  container.querySelectorAll('.wanted-check').forEach(chk => {
    chk.addEventListener('change', updateWantedBulkState);
  });

  container.querySelectorAll('.update-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      btn.disabled = true;
      btn.textContent = 'Обновляю...';
      try {
        await window.api.updateOneMod(mcVersion, loader, card.dataset.id, card.dataset.title);
        showToast(`«${card.dataset.title}» обновлён`, 'success', 'Мод обновлён');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        renderWantedList();
        renderInstalledMods();
      }
    });
  });

  container.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      const shouldPin = btn.dataset.pin === '1';
      try {
        await window.api.setModPinned(mcVersion, loader, card.dataset.id, shouldPin, card.dataset.filename || null);
        showToast(shouldPin ? `«${card.dataset.title}» закреплён — переустановка его не тронет` : `«${card.dataset.title}» откреплён`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        renderWantedList();
      }
    });
  });
}

function updateWantedBulkState() {
  const container = document.getElementById('wantedList');
  const checks = container.querySelectorAll('.wanted-check');
  const checked = container.querySelectorAll('.wanted-check:checked');
  document.getElementById('wantedRemoveSelectedBtn').disabled = checked.length === 0;
  const selectAll = document.getElementById('wantedSelectAll');
  selectAll.checked = checks.length > 0 && checked.length === checks.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < checks.length;
}

document.getElementById('wantedSelectAll').addEventListener('change', e => {
  document.querySelectorAll('#wantedList .wanted-check').forEach(chk => { chk.checked = e.target.checked; });
  updateWantedBulkState();
});

document.getElementById('wantedRemoveSelectedBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const cards = [...document.querySelectorAll('#wantedList .mod-card')].filter(c => c.querySelector('.wanted-check').checked);
  if (!cards.length) return;
  if (!await customConfirm(`Убрать выбранные моды (${cards.length}) из списка?`)) return;

  for (const card of cards) {
    await window.api.removeMod(mcVersion, loader, card.dataset.id);
  }
  showToast(`Убрано модов: ${cards.length}`, 'success');
  renderWantedList();
});

const modSearchState = { query: '', offset: 0, totalHits: 0, limit: 20 };
let modSearchToken = 0;

async function runModSearch(offset = 0) {
  const { mcVersion, loader } = currentSelection();
  // запоминаем выбор до первого await: пока летят запросы, пользователь может
  // переключить версию/загрузчик — тогда ответ уже не наш и рисовать его нельзя
  const key = selectionKey();
  const container = document.getElementById('searchResults');
  container.innerHTML = '<div class="desc">Ищу...</div>';

  modSearchState.query = document.getElementById('modSearch').value;
  modSearchState.offset = offset;
  const source = currentModSource();

  const sort = document.getElementById('modSortSelect').value;
  const category = document.getElementById('modCategorySelect').value;

  // если пользователь успел кликнуть ещё раз/переключить страницу, пока этот запрос летел —
  // старый ответ просто игнорируем, чтобы он не перетёр более свежие результаты
  const myToken = ++modSearchToken;
  let result;
  try {
    result = await window.api.searchMods(modSearchState.query, mcVersion, loader, offset, sort, category, source);
  } catch (err) {
    if (myToken !== modSearchToken) return;
    container.innerHTML = `<div class="desc">Ошибка поиска: ${escHtml(err.message)}</div>`;
    return;
  }
  if (myToken !== modSearchToken) return;

  const { hits, totalHits, limit } = result;
  modSearchState.totalHits = totalHits;
  modSearchState.limit = limit;

  if (!hits.length) {
    container.innerHTML = '<div class="desc">Ничего не найдено</div>';
    renderModSearchPagination();
    return;
  }

  const apiMcVersion = String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim();
  const [wanted, favorites] = await Promise.all([window.api.getWantedMods(apiMcVersion, loader), window.api.listFavoriteMods()]);
  if (!isSelectionCurrent(key)) return;
  favoriteModKeys = new Set(favorites || []);
  const wantedIds = new Set(wanted.map(w => w.projectId));

  container.innerHTML = hits.map(m => `
    <div class="mod-card" data-id="${escHtml(m.id)}" data-title="${escHtml(m.title)}" data-icon="${escHtml(m.icon || '')}" data-source="${source}">
      <img src="${escHtml(m.icon || '')}" loading="lazy">
      <div>
        <div class="title">${escHtml(m.title)}</div>
        <div class="desc">${escHtml(m.description)}</div>
      </div>
      ${wantedIds.has(m.id)
        ? '<span class="added-tag"><img class="inline-ico" src="icons/check.svg" alt="">Добавлен</span>'
        : '<button class="add-btn"><img class="inline-ico" src="icons/plus.svg" alt="">Добавить</button>'}
      <button type="button" class="mod-search-favorite ${favoriteModKeys.has(`project:${source}:${m.id}`) ? 'active' : ''}" aria-pressed="${favoriteModKeys.has(`project:${source}:${m.id}`) ? 'true' : 'false'}" title="${favoriteModKeys.has(`project:${source}:${m.id}`) ? 'Убрать из избранного' : 'В избранное'}">★</button>
      ${source === 'modrinth' ? '<button class="version-pick-btn" title="Выбрать конкретную версию">Версия ▾</button>' : ''}
    </div>
  `).join('');

  container.querySelectorAll('.version-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.mod-card');
      openVersionPicker({
        projectId: card.dataset.id,
        title: card.dataset.title,
        icon: card.dataset.icon,
        loader: currentSelection().loader,
        kind: 'mod'
      });
    });
  });

  container.querySelectorAll('.mod-search-favorite').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      const key = `project:${source}:${card.dataset.id}`;
      const wasFavorite = favoriteModKeys.has(key);
      const next = await window.api.toggleFavoriteMod(key, !wasFavorite, {
        source, projectId: card.dataset.id, title: card.dataset.title, icon: card.dataset.icon || null
      });
      favoriteModKeys = new Set(next);
      btn.classList.toggle('active', !wasFavorite);
      btn.setAttribute('aria-pressed', String(!wasFavorite));
      btn.title = wasFavorite ? 'В избранное' : 'Убрать из избранного';
      if (document.getElementById('modFavoritesDetails')?.open) renderFavoriteMods();
    });
  });

  container.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { mcVersion, loader } = currentSelection();
      const card = btn.closest('.mod-card');
      const modSource = card.dataset.source || 'modrinth';

      const check = await window.api.checkModCompatible(card.dataset.id, mcVersion, loader, modSource);
      if (!check.compatible) {
        const proceed = await customConfirm(`Похоже, "${card.dataset.title}" не имеет сборки под ${mcVersion} (${loader}). Добавить всё равно?`);
        if (!proceed) return;
      }

      // Спрашиваем всегда, когда у мода есть недостающие обязательные зависимости.
      // Выбор: с зависимостями, только мод или отмена. Галочка в настройках только
      // задаёт, нужно ли вообще спрашивать про зависимости
      let installDeps = document.getElementById('modInstallDepsToggle').checked;
      const deps = installDeps ? await window.api.getModDependencies(card.dataset.id, mcVersion, loader, modSource) : [];
      if (deps.length) {
        const list = deps.map(d => d.title).join(', ');
        const choice = await customChoice(
          `«${card.dataset.title}» требует обязательные зависимости: ${list}.\nСкачать их вместе с модом?`,
          { primaryLabel: 'Скачать с зависимостями', altLabel: 'Только мод' }
        );
        if (!choice) return;
        installDeps = choice === 'primary';
      }
      const depsToInstall = installDeps ? deps : [];

      await window.api.addMod(mcVersion, loader, card.dataset.id, card.dataset.title, card.dataset.icon, modSource, !installDeps);
      renderWantedList();
      btn.disabled = true;
      btn.textContent = 'Скачиваю...';
      try {
        // сразу качаем сам мод, а не просто добавляем в список — иначе пользователь
        // не поймёт, почему после "Добавить" в игре ничего не появилось, пока
        // не нажмёшь "Переустановить" отдельно
        const report = await window.api.updateOneMod(mcVersion, loader, card.dataset.id, card.dataset.title, installDeps);
        renderInstalledMods();
        const selfFail = (report?.failed || []).find(m => m.projectId === card.dataset.id);
        if (selfFail) throw new Error(selfFail.reason || 'не удалось скачать');
        const gotDeps = installDeps ? (report?.installed || []).filter(m => m.projectId !== card.dataset.id).length : 0;
        const failedDeps = installDeps ? (report?.failed || []).filter(m => m.projectId !== card.dataset.id) : [];
        const depsNote = depsToInstall.length ? ` (+${gotDeps} завис.)` : (installDeps ? '' : ' (без зависимостей)');
        showToast(`«${card.dataset.title}» добавлен и установлен${depsNote}`, 'success');
        if (failedDeps.length) showToast(`Не скачались зависимости: ${failedDeps.map(f => f.title).join(', ')}`, 'error');
      } catch (err) {
        showToast(`«${card.dataset.title}» добавлен в список, но не скачался: ${err.message}`, 'error');
      } finally {
        btn.outerHTML = '<span class="added-tag"><img class="inline-ico" src="icons/check.svg" alt="">Добавлен</span>';
      }
    });
  });

  renderModSearchPagination();
}

async function renderFavoriteMods() {
  const container = document.getElementById('modFavoritesList');
  if (!container) return;
  const records = await window.api.listFavoriteModRecords();
  favoriteModKeys = new Set(records.map(item => item.key));
  if (!records.length) {
    container.innerHTML = '<div class="desc">Пока ничего не добавлено в избранное. Нажми на звёздочку у мода в поиске или установленных файлах.</div>';
    return;
  }
  container.innerHTML = records.map(item => `
    <div class="mod-favorite-row" data-favorite-record="${escHtml(item.key)}">
      ${item.icon ? `<img src="${escHtml(item.icon)}" alt="" loading="lazy">` : '<span class="mod-favorite-placeholder">★</span>'}
      <div class="mod-favorite-info"><strong>${escHtml(item.title || item.projectId || item.key)}</strong><span class="desc">${item.source === 'curseforge' ? 'CurseForge' : item.source === 'modrinth' ? 'Modrinth' : 'Локальный мод'}${item.projectId ? ` · ${escHtml(item.projectId)}` : ''}</span></div>
      ${item.projectId ? '<button type="button" class="mod-favorite-install">Добавить в сборку</button>' : ''}
      <button type="button" class="mod-favorite-remove" title="Убрать из избранного">×</button>
    </div>`).join('');

  container.querySelectorAll('.mod-favorite-remove').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('[data-favorite-record]');
    const next = await window.api.toggleFavoriteMod(row.dataset.favoriteRecord, false);
    favoriteModKeys = new Set(next);
    renderFavoriteMods();
    if (installedModsCache.length) {
      installedModsCache = installedModsCache.map(m => ({ ...m, favorite: favoriteModKeys.has(m.favoriteKey) }));
      renderInstalledModsFiltered();
    }
    document.querySelectorAll('.mod-search-favorite').forEach(star => {
      const card = star.closest('.mod-card');
      if (!card) return;
      const isFavorite = favoriteModKeys.has(`project:${card.dataset.source}:${card.dataset.id}`);
      star.classList.toggle('active', isFavorite);
      star.setAttribute('aria-pressed', String(isFavorite));
    });
  }));

  container.querySelectorAll('.mod-favorite-install').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('[data-favorite-record]');
    const item = records.find(record => record.key === row.dataset.favoriteRecord);
    if (!item?.projectId) return;
    const { mcVersion, loader } = currentSelection();
    const check = await window.api.checkModCompatible(item.projectId, mcVersion, loader, item.source || 'modrinth');
    if (!check.compatible && !await customConfirm(`Мод «${item.title}» может не поддерживать ${mcVersion} (${loader}). Добавить его всё равно?`)) return;
    const wanted = await window.api.getWantedMods(String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim(), loader);
    if (wanted.some(mod => mod.projectId === item.projectId)) return showToast('Мод уже есть в выбранной сборке', 'info');
    await window.api.addMod(mcVersion, loader, item.projectId, item.title, item.icon, item.source || 'modrinth');
    renderWantedList();
    btn.disabled = true;
    btn.textContent = 'Скачиваю...';
    try {
      const report = await window.api.updateOneMod(mcVersion, loader, item.projectId, item.title, true);
      const failed = (report?.failed || []).find(mod => mod.projectId === item.projectId);
      if (failed) throw new Error(failed.reason || 'Не удалось скачать мод');
      showToast(`«${item.title}» добавлен в сборку`, 'success');
      renderInstalledMods();
    } catch (err) {
      showToast(`Мод добавлен в список, но не скачался: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Добавить в сборку';
    }
  }));
}

document.getElementById('modFavoritesDetails').addEventListener('toggle', e => {
  if (e.currentTarget.open) renderFavoriteMods().catch(err => showToast(err.message, 'error'));
});

function renderModSearchPagination() {
  const bar = document.getElementById('modSearchPagination');
  const { offset, totalHits, limit } = modSearchState;

  if (!totalHits) {
    bar.innerHTML = '';
    return;
  }

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(totalHits / limit));

  bar.innerHTML = `
    <button id="modPagePrev" ${offset <= 0 ? 'disabled' : ''}>&larr; Назад</button>
    <span>Страница ${page} из ${totalPages}</span>
    <button id="modPageNext" ${offset + limit >= totalHits ? 'disabled' : ''}>Вперёд &rarr;</button>
  `;

  const prevBtn = document.getElementById('modPagePrev');
  const nextBtn = document.getElementById('modPageNext');
  if (prevBtn) prevBtn.addEventListener('click', () => runModSearch(Math.max(0, offset - limit)));
  if (nextBtn) nextBtn.addEventListener('click', () => runModSearch(offset + limit));
}

document.getElementById('modSearchBtn').addEventListener('click', () => runModSearch(0));
document.getElementById('modSourceSelect').addEventListener('change', () => {
  updateModSourceHint();
  runModSearch(0);
});
document.getElementById('modSortSelect').addEventListener('change', () => runModSearch(0));
document.getElementById('modCategorySelect').addEventListener('change', () => runModSearch(0));
document.getElementById('modSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') runModSearch(0);
});



document.getElementById('reinstallBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const dryRun = document.getElementById('modsDryRun').checked;
  clearLog(modsLog);
  log(modsLog, dryRun
    ? `Сухой прогон под ${mcVersion} (${loader})...`
    : `Переустановка модов под ${mcVersion} (${loader})...`);

  try {
    const report = await window.api.reinstallMods(mcVersion, loader, dryRun);
    hideModsProgress();
    log(modsLog, dryRun
      ? `Будет скачано: ${report.installed.length}, уже есть: ${report.skipped.length}`
      : `Скачано: ${report.installed.length}, уже было: ${report.skipped.length}`);
    report.installed.forEach(m => log(modsLog, `  + ${m.title}`, 'success'));
    if (report.failed.length) {
      log(modsLog, `Недоступно для этой версии: ${report.failed.length}`);
      report.failed.forEach(f => log(modsLog, `  - ${f.title}: ${f.reason}`));
    }

    if (!dryRun) {
      if (report.installed.length) {
        showToast(`Установлено модов: ${report.installed.length}`, 'success', 'Моды обновлены');
      } else if (!report.failed.length) {
        showToast('Все моды уже актуальны', 'info');
      }
      if (report.failed.length) {
        showToast(`Не удалось установить: ${report.failed.length}`, 'error');
      }
    }
  } catch (err) {
    hideModsProgress();
    log(modsLog, `Ошибка: ${err.message}`, 'error');
    showToast(err.message, 'error');
  }
});

// --- опознание вручную закинутых модов через хэш на Modrinth ---
document.getElementById('identifyLocalModsBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  const btn = document.getElementById('identifyLocalModsBtn');
  btn.disabled = true;
  btn.textContent = 'Проверяю...';
  log(modsLog, 'Ищу вручную закинутые моды на Modrinth по хэшу файла...');

  try {
    const results = await window.api.identifyLocalMods(mcVersion, loader);
    const matched = results.filter(r => r.matched);
    matched.forEach(r => log(modsLog, `  + опознан: ${r.fileName} -> ${r.title}`, 'success'));
    results.filter(r => !r.matched).forEach(r => log(modsLog, `  - ${r.fileName}: ${r.reason}`));

    if (matched.length) {
      showToast(`Опознано модов: ${matched.length} — теперь будут обновляться сами`, 'success');
    } else if (results.length) {
      showToast('Ни один из закинутых модов не нашёлся на Modrinth', 'info');
    } else {
      showToast('Нет вручную закинутых модов для проверки', 'info');
    }
    await renderWantedList();
  } catch (err) {
    log(modsLog, `Ошибка: ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Опознать вручную закинутые моды на Modrinth';
  }
});

function showModsProgress(percent, label) {
  const row = document.getElementById('modsProgressRow');
  const bar = document.getElementById('modsProgressBar');
  const lbl = document.getElementById('modsProgressLabel');
  row.style.display = 'flex';
  bar.value = percent;
  lbl.textContent = label;
}

function hideModsProgress() {
  document.getElementById('modsProgressRow').style.display = 'none';
}

window.api.onModsProgress(p => {
  if (p.stage === 'downloading') {
    log(modsLog, `Скачиваю ${p.title}...`);
    if (p.total) showModsProgress((p.done / p.total) * 100, `Скачиваю моды: ${p.done}/${p.total}`);
  }
  if (p.stage === 'downloaded') {
    log(modsLog, `Установлен: ${p.title}`, 'success');
    showToast(`«${p.title}» установлен`, 'success', 'Мод установлен');
    if (p.total) showModsProgress((p.done / p.total) * 100, `Скачиваю моды: ${p.done}/${p.total}${formatSpeedEta(p.speedBps, p.etaSec)}`);
  }
  if (p.stage === 'retry') log(modsLog, `Обрыв сети, повтор ${p.attempt}/${p.retries}: ${p.title}`, 'warn');
});

// тихая проверка на старте лаунчера — не качаем ничего, просто смотрим,
// не разошлись ли файлы с сохранённым списком (обновилась версия и т.п.).
// Проверяет моды, ресурспаки и шейдеры — каждый в свой бейдж на вкладке.
async function checkModUpdatesOnStart() {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) return;

  const checks = [
    { report: () => getModsDryReport(mcVersion, loader), badgeId: 'modsUpdateBadge', label: 'модов' },
    { report: () => window.api.reinstallResourcePacks(mcVersion, loader, true), badgeId: 'rpUpdateBadge', label: 'ресурспаков' },
    { report: () => window.api.reinstallShaders(mcVersion, loader, true), badgeId: 'shUpdateBadge', label: 'шейдеров' }
  ];

  for (const check of checks) {
    try {
      const report = await check.report();
      const badge = document.getElementById(check.badgeId);

      if (report.installed.length) {
        badge.textContent = report.installed.length;
        badge.style.display = 'inline-block';
        log(playLog, `Найдены обновления ${check.label} (${report.installed.length})`, 'warn');
        showToast(`Доступны обновления ${check.label}: ${report.installed.length}`, 'info', 'Есть что обновить');
      } else {
        badge.style.display = 'none';
      }
    } catch (err) {
      console.warn(`Не удалось проверить обновления (${check.label}):`, err.message);
    }
  }
}

// --- копирование списка модов с другой версии ---
async function renderCopyOptions() {
  const { mcVersion, loader } = currentSelection();
  const others = await window.api.getOtherInstances(mcVersion, loader);
  const row = document.getElementById('copyRow');
  const select = document.getElementById('copySource');

  if (!others.length) {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'flex';
  select.innerHTML = others.map(i => `<option value="${i.key}">${i.key} (${i.wantedMods.length} модов)</option>`).join('');
}

document.getElementById('copyBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const sourceKey = document.getElementById('copySource').value;
  const res = await window.api.copyModsFrom(mcVersion, loader, sourceKey);
  await renderWantedList();
  if (res && res.skippedLocal) {
    showToast(`Не скопировано модов, добавленных файлом: ${res.skippedLocal}. Положи их в папку этой версии вручную`, 'warn');
  }
  showToast('Список скопирован. Нажми «Переустановить», чтобы скачать моды под эту версию', 'info');
});

// --- профили модпаков ---
function formatProfileDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(window.i18n.locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

async function renderModpackOptions() {
  const profiles = await window.api.listModpacks();
  const select = document.getElementById('modpackSelect');

  if (!profiles.length) {
    select.innerHTML = '<option value="">Профилей пока нет</option>';
    return;
  }

  select.innerHTML = profiles.map(p =>
    `<option value="${escHtml(p.id)}" title="Создан: ${formatProfileDate(p.createdAt)}">${escHtml(p.name)} — ${p.loader}, ${p.mods.length} модов</option>`
  ).join('');
}

document.getElementById('applyModpackBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const id = document.getElementById('modpackSelect').value;
  if (!id) return;
  await window.api.applyModpack(id, mcVersion, loader);
  await renderWantedList();
  log(modsLog, 'Профиль модпака применён', 'success');
});

document.getElementById('saveModpackBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const name = await askForText('Название профиля модпаков:');
  if (!name) return;

  const existing = (await window.api.listModpacks()).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (!await customConfirm(`Профиль «${name}» уже существует. Перезаписать его текущим списком модов?`)) return;
    await window.api.deleteModpack(existing.id);
  }

  const apiMcVersion = String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim();
  const wanted = await window.api.getWantedMods(apiMcVersion, loader);
  await window.api.saveModpack(name, loader, wanted);
  await renderModpackOptions();
  log(modsLog, `Профиль "${name}" сохранён`, 'success');
  showToast(`Профиль "${name}" сохранён`, 'success');
});

document.getElementById('renameModpackBtn').addEventListener('click', async () => {
  const select = document.getElementById('modpackSelect');
  const id = select.value;
  if (!id) return;
  const profiles = await window.api.listModpacks();
  const current = profiles.find(p => p.id === id);
  if (!current) return;

  const newName = await askForText('Новое название профиля:', current.name);
  if (!newName || newName === current.name) return;

  await window.api.renameModpack(id, newName);
  await renderModpackOptions();
  select.value = id;
  showToast('Профиль переименован', 'success');
});

document.getElementById('deleteModpackBtn').addEventListener('click', async () => {
  const select = document.getElementById('modpackSelect');
  const id = select.value;
  if (!id) return;
  const profiles = await window.api.listModpacks();
  const current = profiles.find(p => p.id === id);
  if (!await customConfirm(`Удалить профиль «${current ? current.name : ''}»?`)) return;
  await window.api.deleteModpack(id);
  await renderModpackOptions();
  showToast('Профиль удалён', 'success');
});

// --- установленные файлы модов: вкл/выкл без удаления ---
let installedModsCache = [];
let installedModGroups = [];
let favoriteModKeys = new Set();
let modsFavoritesOnly = false;
let modKeysByFile = {};

// общий dry-run переустановки даёт человекочитаемые имена файлов и актуальные
// projectId — это позволяет сохранять группы и избранное при обновлении JAR.
let lastModsDryReport = null; // { mcVersion, loader, report, time }
const MODS_DRY_REPORT_TTL_MS = 5000;

async function getModsDryReport(mcVersion, loader) {
  const cached = lastModsDryReport;
  if (cached && cached.mcVersion === mcVersion && cached.loader === loader && Date.now() - cached.time < MODS_DRY_REPORT_TTL_MS) {
    return cached.report;
  }
  const report = await window.api.reinstallMods(mcVersion, loader, true);
  lastModsDryReport = { mcVersion, loader, report, time: Date.now() };
  return report;
}

function selectionKey() {
  const { mcVersion, loader } = currentSelection();
  return `${mcVersion}\u0000${loader}`;
}

function isSelectionCurrent(key) {
  return key === selectionKey();
}

function refreshModGroupFilter() {
  const filter = document.getElementById('modsGroupFilter');
  const target = document.getElementById('modsGroupTarget');
  const previousFilter = filter?.value || 'all';
  const previousTarget = target?.value || '';
  const groupOptions = installedModGroups.map(g => `<option value="${escHtml(g.id)}">${escHtml(g.name)} (${g.members.length})</option>`).join('');

  if (filter) {
    filter.innerHTML = `<option value="all">Все моды</option><option value="ungrouped">Без группы</option>${groupOptions}`;
    filter.value = [...filter.options].some(o => o.value === previousFilter) ? previousFilter : 'all';
  }
  if (target) {
    target.innerHTML = `<option value="">Не выбрана</option>${groupOptions}`;
    target.value = [...target.options].some(o => o.value === previousTarget) ? previousTarget : '';
  }
  updateModGroupControls();
}

// Целевая группа и фильтр списка разделены: фильтр может показывать все моды,
// пока пользователь выбирает, в какую группу добавить отмеченные файлы.
function selectedModGroup() {
  const id = document.getElementById('modsGroupTarget')?.value;
  return installedModGroups.find(g => g.id === id) || null;
}

function updateModGroupControls() {
  const group = selectedModGroup();
  const selected = selectedInstalledMods();
  const selectedCount = selected.length;
  const selectedInGroup = group ? selected.filter(m => m.groupId === group.id).length : 0;
  const selectedOutsideGroup = selectedCount - selectedInGroup;
  const setDisabled = (id, disabled) => { const el = document.getElementById(id); if (el) el.disabled = !!disabled; };
  setDisabled('modsRenameGroupBtn', !group);
  setDisabled('modsDeleteGroupBtn', !group);
  setDisabled('modsAssignSelectedBtn', !group || !selectedOutsideGroup);
  setDisabled('modsRemoveSelectedBtn', !group || !selectedInGroup);
  setDisabled('modsGroupEnableBtn', !group || !group.members.length);
  setDisabled('modsGroupDisableBtn', !group || !group.members.length);
}

async function renderInstalledMods() {
  const { mcVersion, loader } = currentSelection();
  const apiMcVersion = String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim();
  const key = `${mcVersion}\u0000${loader}`;
  installedModsCache = await window.api.listInstalledMods(mcVersion, loader);
  if (!isSelectionCurrent(key)) return;

  // тянем информацию для групп/избранного параллельно с разрешением названий модов
  const [wanted, groupContext, favorites] = await Promise.all([
    window.api.getWantedMods(apiMcVersion, loader),
    window.api.listModGroups(apiMcVersion, loader),
    window.api.listFavoriteMods()
  ]);
  if (!isSelectionCurrent(key)) return;
  installedModGroups = groupContext?.groups || [];
  modKeysByFile = groupContext?.modKeysByFile || {};
  favoriteModKeys = new Set(favorites || []);

  // пытаемся подтянуть человекочитаемые названия из списка выбранных модов,
  // сопоставляя по имени файла (pinnedFileName для закреплённых, dry-run для остальных)
  const wantedIds = new Set(wanted.filter(w => !w.asDependency).map(w => w.projectId));
  const titleByFile = new Map();
  const favoriteKeyByFile = new Map();
  const dependencyFiles = new Set();
  wanted.forEach(w => {
    const fileName = w.pinnedFileName || w.lastFileName;
    if (fileName) {
      titleByFile.set(fileName, w.title);
      if (w.projectId && !String(w.projectId).startsWith('local:')) favoriteKeyByFile.set(fileName, `project:${w.source || 'modrinth'}:${w.projectId}`);
    }
  });
  try {
    const dryReport = await getModsDryReport(mcVersion, loader);
    if (!isSelectionCurrent(key)) return;
    [...(dryReport.skipped || []), ...(dryReport.installed || [])].forEach(item => {
      if (!item.fileName) return;
      if (item.title) titleByFile.set(item.fileName, item.title);
      if (item.projectId && !String(item.projectId).startsWith('local:')) favoriteKeyByFile.set(item.fileName, `project:${item.source || 'modrinth'}:${item.projectId}`);
      if (!wantedIds.has(item.projectId)) dependencyFiles.add(item.fileName);
    });
  } catch {
    // не смогли сопоставить — просто покажем голые имена файлов
  }

  installedModsCache = installedModsCache.map(mod => {
    const modKey = modKeysByFile[mod.fileName] || `file:${mod.fileName.toLowerCase()}`;
    const group = installedModGroups.find(g => g.members.includes(modKey));
    const favoriteKey = favoriteKeyByFile.get(mod.fileName) || modKey;
    return {
      ...mod,
      title: titleByFile.get(mod.fileName) || '',
      isDependency: dependencyFiles.has(mod.fileName),
      modKey, favoriteKey,
      favorite: favoriteModKeys.has(favoriteKey),
      groupId: group?.id || null
    };
  });

  if (!isSelectionCurrent(key)) return;
  refreshModGroupFilter();
  renderInstalledModsFiltered();
}

function renderInstalledModsFiltered() {
  const container = document.getElementById('installedModsList');
  const query = document.getElementById('installedModsFilter').value.trim().toLowerCase();
  const sortMode = document.getElementById('installedModsSort').value;
  const groupFilter = document.getElementById('modsGroupFilter')?.value || 'all';

  let mods = installedModsCache.slice();
  if (query) mods = mods.filter(m => m.fileName.toLowerCase().includes(query) || m.title.toLowerCase().includes(query));
  if (modsFavoritesOnly) mods = mods.filter(m => m.favorite);
  if (groupFilter === 'ungrouped') mods = mods.filter(m => !m.groupId);
  else if (groupFilter !== 'all') mods = mods.filter(m => m.groupId === groupFilter);

  if (sortMode === 'status') mods.sort((a, b) => (b.enabled - a.enabled) || a.fileName.localeCompare(b.fileName));
  else mods.sort((a, b) => (a.title || a.fileName).localeCompare(b.title || b.fileName));

  const favoritesBtn = document.getElementById('modsFavoritesBtn');
  if (favoritesBtn) favoritesBtn.setAttribute('aria-pressed', modsFavoritesOnly ? 'true' : 'false');
  const selectVisible = document.getElementById('modsGroupSelectVisible');
  if (selectVisible) selectVisible.checked = false;
  if (!installedModsCache.length) {
    container.innerHTML = '<div class="desc">Файлов пока нет — сначала установи моды</div>';
    updateModGroupControls();
    return;
  }
  if (!mods.length) {
    container.innerHTML = `<div class="desc">${modsFavoritesOnly ? 'В избранном пока нет модов' : 'Ничего не найдено по текущему фильтру'}</div>`;
    updateModGroupControls();
    return;
  }

  container.innerHTML = mods.map(m => `
    <div class="installed-mod-row ${m.enabled ? '' : 'disabled'}" data-file="${escHtml(m.fileName)}" data-mod-key="${escHtml(m.modKey)}">
      <label class="mod-group-check" title="Выбрать мод для группы"><input type="checkbox" data-mod-select aria-label="Выбрать мод ${escHtml(m.title || m.fileName)}"></label>
      <button type="button" class="mod-fav-toggle ${m.favorite ? 'active' : ''}" data-favorite-key="${escHtml(m.favoriteKey)}" aria-pressed="${m.favorite ? 'true' : 'false'}" title="${m.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}">★</button>
      <span class="file-name">${m.title ? `${escHtml(m.title)} <span class="desc">(${escHtml(m.fileName)})</span>` : escHtml(m.fileName)}${m.isDependency ? '<span class="dependency-badge" title="Установлен как обязательная зависимость другого мода">зависимость</span>' : ''}${m.groupId ? `<span class="mod-group-badge">${escHtml(installedModGroups.find(g => g.id === m.groupId)?.name || '')}</span>` : ''}</span>
      <button class="mod-toggle ${m.enabled ? 'on' : ''}" title="${m.enabled ? 'Отключить' : 'Включить'} мод"></button>
    </div>
  `).join('');

  container.querySelectorAll('.installed-mod-row').forEach(row => {
    row.querySelector('[data-mod-select]').addEventListener('change', updateModGroupControls);
    row.querySelector('[data-favorite-key]').addEventListener('click', async e => {
      const btn = e.currentTarget;
      const key = btn.dataset.favoriteKey;
      const wasFavorite = favoriteModKeys.has(key);
      const mod = installedModsCache.find(m => m.favoriteKey === key);
      const source = key.startsWith('project:curseforge:') ? 'curseforge' : key.startsWith('project:modrinth:') ? 'modrinth' : null;
      const projectId = source ? key.split(':').slice(2).join(':') : null;
      const next = await window.api.toggleFavoriteMod(key, !wasFavorite, { source, projectId, title: mod?.title || mod?.fileName || key });
      favoriteModKeys = new Set(next);
      installedModsCache = installedModsCache.map(m => ({ ...m, favorite: favoriteModKeys.has(m.favoriteKey) }));
      renderInstalledModsFiltered();
      if (document.getElementById('modFavoritesDetails')?.open) renderFavoriteMods();
    });
    row.querySelector('.mod-toggle').addEventListener('click', async () => {
      const { mcVersion, loader } = currentSelection();
      const isCurrentlyDisabled = row.classList.contains('disabled');
      let updated;
      if (isCurrentlyDisabled) {
        updated = await window.api.setModEnabled(mcVersion, loader, row.dataset.file, true);
      } else {
        const files = await window.fcDiag.askBeforeDisable(row.dataset.file);
        if (!files) return;
        updated = files.length > 1
          ? await window.api.disableManyMods(mcVersion, loader, files)
          : await window.api.setModEnabled(mcVersion, loader, files[0], false);
      }
      const enabledByFile = new Map(updated.map(m => [m.fileName, m.enabled]));
      installedModsCache = installedModsCache.map(m => ({ ...m, enabled: enabledByFile.get(m.fileName) ?? m.enabled }));
      renderInstalledModsFiltered();
    });
  });
  updateModGroupControls();
}

function selectedInstalledMods() {
  return [...document.querySelectorAll('#installedModsList .installed-mod-row')]
    .filter(row => row.querySelector('[data-mod-select]')?.checked)
    .map(row => installedModsCache.find(m => m.fileName === row.dataset.file))
    .filter(Boolean);
}

function selectedModGroupOrToast() {
  const group = selectedModGroup();
  if (!group) showToast('Сначала выбери конкретную группу', 'warn');
  return group;
}

const modsGroupFilter = document.getElementById('modsGroupFilter');
modsGroupFilter.addEventListener('change', () => { renderInstalledModsFiltered(); });
document.getElementById('modsCreateGroupBtn').addEventListener('click', async () => {
  const name = await askForText('Название группы модов');
  if (!name) return;
  try {
    const { mcVersion, loader } = currentSelection();
    installedModGroups = await window.api.createModGroup(mcVersion, loader, name);
    refreshModGroupFilter();
    document.getElementById('modsGroupTarget').value = installedModGroups[installedModGroups.length - 1]?.id || '';
    modsGroupFilter.value = 'all';
    renderInstalledModsFiltered();
    showToast('Группа создана', 'success');
  } catch (err) { showToast(err.message, 'error'); }
});
document.getElementById('modsRenameGroupBtn').addEventListener('click', async () => {
  const group = selectedModGroup(); if (!group) return;
  const name = await askForText('Новое название группы', group.name); if (!name) return;
  const { mcVersion, loader } = currentSelection();
  try { installedModGroups = await window.api.renameModGroup(mcVersion, loader, group.id, name); refreshModGroupFilter(); renderInstalledModsFiltered(); showToast('Название группы обновлено', 'success'); }
  catch (err) { showToast(err.message, 'error'); }
});
document.getElementById('modsDeleteGroupBtn').addEventListener('click', async () => {
  const group = selectedModGroup(); if (!group) return;
  if (!await customConfirm(`Удалить группу «${group.name}»? Моды останутся установленными.`)) return;
  const { mcVersion, loader } = currentSelection();
  installedModGroups = await window.api.deleteModGroup(mcVersion, loader, group.id);
  document.getElementById('modsGroupTarget').value = '';
  if (modsGroupFilter.value === group.id) modsGroupFilter.value = 'all';
  refreshModGroupFilter(); renderInstalledModsFiltered();
});
document.getElementById('modsGroupTarget').addEventListener('change', () => {
  // После выбора группы показываем все моды, чтобы можно было добавить в неё
  // файлы, которых в ней ещё нет (иначе фильтр пустой группы скрывает их).
  modsGroupFilter.value = 'all';
  renderInstalledModsFiltered();
});
document.getElementById('modsAssignSelectedBtn').addEventListener('click', async () => {
  const group = selectedModGroup(); if (!group) return showToast('Сначала выбери целевую группу', 'warn');
  const selected = selectedInstalledMods();
  const toAssign = selected.filter(m => m.groupId !== group.id);
  if (!toAssign.length) return showToast('Сначала отметь моды, которые ещё не входят в эту группу', 'warn');
  const { mcVersion, loader } = currentSelection();
  try {
    installedModGroups = await window.api.assignModsToGroup(mcVersion, loader, group.id, toAssign.map(m => m.modKey));
    await renderInstalledMods();
    showToast(`Добавлено модов: ${toAssign.length}`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
});
document.getElementById('modsRemoveSelectedBtn').addEventListener('click', async () => {
  const group = selectedModGroup(); if (!group) return showToast('Сначала выбери целевую группу', 'warn');
  const selected = selectedInstalledMods().filter(m => m.groupId === group.id);
  if (!selected.length) return showToast('Среди выбранных нет модов из этой группы', 'warn');
  const { mcVersion, loader } = currentSelection();
  installedModGroups = await window.api.removeModsFromGroup(mcVersion, loader, group.id, selected.map(m => m.modKey));
  await renderInstalledMods();
  showToast(`Убрано из группы: ${selected.length}`, 'success');
});
document.getElementById('modsGroupSelectVisible').addEventListener('change', e => {
  document.querySelectorAll('#installedModsList [data-mod-select]').forEach(cb => { cb.checked = e.target.checked; });
  updateModGroupControls();
});
document.getElementById('modsGroupEnableBtn').addEventListener('click', async () => {
  const group = selectedModGroup(); if (!group) return;
  const { mcVersion, loader } = currentSelection();
  const result = await window.api.setModGroupEnabled(mcVersion, loader, group.id, true);
  installedModsCache = installedModsCache.map(m => ({ ...m, enabled: result.installed.find(x => x.fileName === m.fileName)?.enabled ?? m.enabled }));
  renderInstalledModsFiltered();
  showToast(`Включено файлов: ${result.changed.length}`, 'success');
});
document.getElementById('modsGroupDisableBtn').addEventListener('click', async () => {
  const group = selectedModGroup(); if (!group) return;
  const { mcVersion, loader } = currentSelection();
  if (!await customConfirm(`Отключить все моды группы «${group.name}»? Это может нарушить работу модов, которые от них зависят. Файлы не будут удалены.`)) return;
  const result = await window.api.setModGroupEnabled(mcVersion, loader, group.id, false);
  installedModsCache = installedModsCache.map(m => ({ ...m, enabled: result.installed.find(x => x.fileName === m.fileName)?.enabled ?? m.enabled }));
  renderInstalledModsFiltered();
  showToast(`Отключено файлов: ${result.changed.length}`, 'success');
});

document.getElementById('modsFavoritesBtn').addEventListener('click', () => {
  modsFavoritesOnly = !modsFavoritesOnly;
  renderInstalledModsFiltered();
});

document.getElementById('modsDepsBtn').addEventListener('click', () => window.fcDiag.showDependencies());
document.getElementById('modsMetricsBtn').addEventListener('click', () => window.fcDiag.showMetrics());
document.getElementById('modsPerformanceBtn').addEventListener('click', () => window.fcDiag.showPerformanceMonitor());
document.getElementById('installedModsFilter').addEventListener('input', renderInstalledModsFiltered);
document.getElementById('installedModsSort').addEventListener('change', renderInstalledModsFiltered);

// --- drag & drop установка модов ---
const modsTab = document.getElementById('tab-mods');
const modsDropOverlay = document.getElementById('modsDropOverlay');
let modsDragCounter = 0;

modsTab.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes('Files')) return;
  modsDragCounter++;
  modsDropOverlay.classList.add('active');
});

modsTab.addEventListener('dragover', e => {
  e.preventDefault();
});

modsTab.addEventListener('dragleave', e => {
  e.preventDefault();
  modsDragCounter = Math.max(0, modsDragCounter - 1);
  if (modsDragCounter === 0) modsDropOverlay.classList.remove('active');
});

modsTab.addEventListener('drop', async e => {
  e.preventDefault();
  modsDragCounter = 0;
  modsDropOverlay.classList.remove('active');

  const files = [...e.dataTransfer.files];
  if (!files.length) return;

  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) {
    showToast('Сначала выбери версию на вкладке "Главная"', 'warn');
    return;
  }

  let filePaths;
  try {
    filePaths = files.map(f => window.api.getPathForFile(f));
  } catch (err) {
    showToast('Не удалось прочитать перетащенные файлы', 'error');
    return;
  }

  let report;
  try {
    report = await window.api.installModsFromFiles(mcVersion, loader, filePaths);
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  if (report.installed.length) {
    showToast(`Установлено файлов: ${report.installed.length}`, 'success', 'Моды установлены');
    log(modsLog, `Установлено вручную: ${report.installed.join(', ')}`, 'success');
  }
  if (report.skipped.length) {
    showToast(`Пропущено файлов: ${report.skipped.length} (не .jar/.zip или ошибка)`, 'warn');
    report.skipped.forEach(s => log(modsLog, `Пропущен ${s.fileName}: ${s.reason}`, 'warn'));
  }

  await renderInstalledMods();
});

document.getElementById('discordBtn').addEventListener('click', () => {
  window.api.openExternal('https://discord.gg/M6A4fgv7XF');
});

document.getElementById('enableAllModsBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  await window.api.setAllModsEnabled(mcVersion, loader, true);
  await renderInstalledMods();
});

document.getElementById('disableAllModsBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  await window.api.setAllModsEnabled(mcVersion, loader, false);
  await renderInstalledMods();
});

// --- drag & drop установки ЦЕЛОЙ сборки (.zip с manifest.json от экспорта или чужой) ---
// отдельная зона на вкладке "Главная" — чтобы не путать с перетаскиванием
// отдельных .jar модов на вкладке "Моды"
const playTab = document.getElementById('tab-play');
const instanceDropOverlay = document.getElementById('instanceDropOverlay');
let instanceDragCounter = 0;

playTab.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes('Files')) return;
  instanceDragCounter++;
  instanceDropOverlay.classList.add('active');
});

playTab.addEventListener('dragover', e => e.preventDefault());

playTab.addEventListener('dragleave', e => {
  e.preventDefault();
  instanceDragCounter = Math.max(0, instanceDragCounter - 1);
  if (instanceDragCounter === 0) instanceDropOverlay.classList.remove('active');
});

playTab.addEventListener('drop', async e => {
  e.preventDefault();
  instanceDragCounter = 0;
  instanceDropOverlay.classList.remove('active');

  const files = [...e.dataTransfer.files];
  if (!files.length) return;

  const zipFile = files.find(f => f.name.toLowerCase().endsWith('.zip'));
  if (!zipFile) {
    showToast('Для установки целой сборки перетащи .zip файл', 'warn');
    return;
  }

  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) {
    showToast('Сначала выбери версию на вкладке "Главная"', 'warn');
    return;
  }

  let filePath;
  try {
    filePath = window.api.getPathForFile(zipFile);
  } catch {
    showToast('Не удалось прочитать перетащенный файл', 'error');
    return;
  }

  log(playLog, `Импортирую сборку из ${zipFile.name}...`, 'info');
  try {
    const result = await window.api.importInstanceFromPath(mcVersion, loader, filePath);
    showToast(`Установлено модов: ${result.modsCopied}, ресурспаков: ${result.resourcePacksCopied}`, 'success', 'Сборка импортирована');
    log(playLog, `Импорт завершён: модов ${result.modsCopied}, ресурспаков ${result.resourcePacksCopied}`, 'success');
    await renderInstalledMods();
  } catch (err) {
    showToast(err.message, 'error');
    log(playLog, `Ошибка импорта сборки: ${err.message}`, 'error');
  }
});

document.getElementById('refreshInstalledModsBtn').addEventListener('click', renderInstalledMods);

// --- ресурспаки ---
async function renderResourcePackList() {
  const { mcVersion, loader } = currentSelection();
  const key = selectionKey();
  const wanted = await window.api.getWantedResourcePacks(mcVersion, loader);
  const container = document.getElementById('rpWantedList');

  document.getElementById('rpWantedBulkRow').style.display = wanted.length ? 'flex' : 'none';
  const selectAllChk = document.getElementById('rpWantedSelectAll');
  selectAllChk.checked = false;
  selectAllChk.indeterminate = false;
  document.getElementById('rpWantedRemoveSelectedBtn').disabled = true;

  if (!wanted.length) {
    container.innerHTML = '<div class="desc">Список пуст — найди ресурспак слева и нажми "Добавить"</div>';
    return;
  }

  // так же, как в renderWantedList: сухим прогоном узнаём, каким пакам есть
  // обновление, и каким файлом на диске сейчас представлен каждый пак
  let pendingIds = new Set();
  const installedFileByProjectId = new Map();
  try {
    const dryReport = await window.api.reinstallResourcePacks(mcVersion, loader, true);
    if (!isSelectionCurrent(key)) return;
    pendingIds = new Set(dryReport.installed.map(p => p.projectId));
    dryReport.skipped.forEach(s => { if (s.fileName) installedFileByProjectId.set(s.projectId, s.fileName); });
  } catch {
    // не смогли проверить — просто не покажем бейджи/пин
  }

  container.innerHTML = wanted.map(pack => {
    const fileName = pack.pinnedFileName || installedFileByProjectId.get(pack.projectId) || '';
    const canPin = !pack.pinned && fileName && !pendingIds.has(pack.projectId);
    let pinBtn = '';
    if (pack.pinned) pinBtn = '<button class="pin-btn" data-pin="0" title="Разрешить переустановке обновлять этот пак"><img class="inline-ico" src="icons/pin.svg" alt="">Открепить</button>';
    else if (canPin) pinBtn = '<button class="pin-btn" data-pin="1" title="Не давать переустановке трогать текущую версию"><img class="inline-ico" src="icons/pin.svg" alt="">Закрепить</button>';

    return `
    <div class="mod-card ${pendingIds.has(pack.projectId) ? 'has-update' : ''} ${pack.pinned ? 'is-pinned' : ''}" data-id="${escHtml(pack.projectId)}" data-title="${escHtml(pack.title)}" data-filename="${escHtml(fileName)}">
      <input type="checkbox" class="rp-wanted-check">
      ${pack.icon ? `<img src="${escHtml(pack.icon)}" loading="lazy">` : ''}
      <div class="title">${escHtml(pack.title)}${pack.pinned ? ' <span class="pin-tag">закреплён</span>' : ''}</div>
      ${!pack.pinned && pendingIds.has(pack.projectId) ? '<button class="update-one-btn"><img class="inline-ico" src="icons/update.svg" alt="">Обновить</button>' : ''}
      ${pinBtn}
      <button class="remove-btn">Убрать</button>
    </div>
  `;
  }).join('');

  container.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      if (!await customConfirm(`Убрать «${card.dataset.title}» из списка?`)) return;
      await window.api.removeResourcePack(mcVersion, loader, card.dataset.id);
      renderResourcePackList();
    });
  });

  container.querySelectorAll('.rp-wanted-check').forEach(chk => {
    chk.addEventListener('change', updateRpWantedBulkState);
  });

  container.querySelectorAll('.update-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      btn.disabled = true;
      btn.textContent = 'Обновляю...';
      try {
        await window.api.updateOneResourcePack(mcVersion, loader, card.dataset.id, card.dataset.title);
        showToast(`«${card.dataset.title}» обновлён`, 'success', 'Ресурспак обновлён');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        renderResourcePackList();
        renderInstalledResourcePacks();
      }
    });
  });

  container.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      const shouldPin = btn.dataset.pin === '1';
      try {
        await window.api.setResourcePackPinned(mcVersion, loader, card.dataset.id, shouldPin, card.dataset.filename || null);
        showToast(shouldPin ? `«${card.dataset.title}» закреплён — переустановка его не тронет` : `«${card.dataset.title}» откреплён`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        renderResourcePackList();
      }
    });
  });
}

function updateRpWantedBulkState() {
  const container = document.getElementById('rpWantedList');
  const checks = container.querySelectorAll('.rp-wanted-check');
  const checked = container.querySelectorAll('.rp-wanted-check:checked');
  document.getElementById('rpWantedRemoveSelectedBtn').disabled = checked.length === 0;
  const selectAll = document.getElementById('rpWantedSelectAll');
  selectAll.checked = checks.length > 0 && checked.length === checks.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < checks.length;
}

document.getElementById('rpWantedSelectAll').addEventListener('change', e => {
  document.querySelectorAll('#rpWantedList .rp-wanted-check').forEach(chk => { chk.checked = e.target.checked; });
  updateRpWantedBulkState();
});

document.getElementById('rpWantedRemoveSelectedBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const cards = [...document.querySelectorAll('#rpWantedList .mod-card')].filter(c => c.querySelector('.rp-wanted-check').checked);
  if (!cards.length) return;
  if (!await customConfirm(`Убрать выбранные ресурспаки (${cards.length}) из списка?`)) return;

  for (const card of cards) {
    await window.api.removeResourcePack(mcVersion, loader, card.dataset.id);
  }
  showToast(`Убрано ресурспаков: ${cards.length}`, 'success');
  renderResourcePackList();
});

// --- копирование списка ресурспаков с другой версии ---
async function renderRpCopyOptions() {
  const { mcVersion, loader } = currentSelection();
  const others = await window.api.getOtherResourcePackInstances(mcVersion, loader);
  const row = document.getElementById('rpCopyRow');
  const select = document.getElementById('rpCopySource');

  if (!others.length) {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'flex';
  select.innerHTML = others.map(i => `<option value="${i.key}">${i.key} (${i.wantedResourcePacks.length} ресурспаков)</option>`).join('');
}

document.getElementById('rpCopyBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const sourceKey = document.getElementById('rpCopySource').value;
  await window.api.copyResourcePacksFrom(mcVersion, loader, sourceKey);
  await renderResourcePackList();
});

// --- профили ресурспаков ---
async function renderRpProfileOptions() {
  const profiles = await window.api.listResourcePackProfiles();
  const select = document.getElementById('rpProfileSelect');

  if (!profiles.length) {
    select.innerHTML = '<option value="">Профилей пока нет</option>';
    return;
  }

  select.innerHTML = profiles.map(p =>
    `<option value="${escHtml(p.id)}" title="Создан: ${formatProfileDate(p.createdAt)}">${escHtml(p.name)} — ${p.loader}, ${p.packs.length} ресурспаков</option>`
  ).join('');
}

document.getElementById('rpApplyProfileBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const id = document.getElementById('rpProfileSelect').value;
  if (!id) return;
  const chosen = (await window.api.listResourcePackProfiles()).find(p => p.id === id);
  const applyHint = Array.isArray(chosen?.installedPacks)
    ? 'Текущий список ресурспаков будет заменён, а установленные ZIP получат сохранённое состояние.'
    : 'Это старый профиль: его список будет добавлен к текущему, состояние локальных ZIP не изменится.';
  if (!await customConfirm(`Применить профиль «${chosen?.name || ''}»? ${applyHint}`)) return;
  await window.api.applyResourcePackProfile(id, mcVersion, loader);
  await renderResourcePackList();
  await renderInstalledResourcePacks();
  log(rpLog, 'Профиль ресурспаков применён', 'success');
  showToast('Профиль применён. Отсутствующие файлы можно загрузить через переустановку.', 'success');
});

document.getElementById('rpSaveProfileBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const name = await askForText('Название профиля ресурспаков:');
  if (!name) return;

  const existing = (await window.api.listResourcePackProfiles()).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (!await customConfirm(`Профиль «${name}» уже существует. Перезаписать его текущим списком ресурспаков?`)) return;
    await window.api.deleteResourcePackProfile(existing.id);
  }

  const wanted = await window.api.getWantedResourcePacks(mcVersion, loader);
  await window.api.saveResourcePackProfile(name, mcVersion, loader, wanted);
  await renderRpProfileOptions();
  log(rpLog, `Профиль "${name}" сохранён`, 'success');
  showToast(`Профиль "${name}" сохранён`, 'success');
});

document.getElementById('rpRenameProfileBtn').addEventListener('click', async () => {
  const select = document.getElementById('rpProfileSelect');
  const id = select.value;
  if (!id) return;
  const profiles = await window.api.listResourcePackProfiles();
  const current = profiles.find(p => p.id === id);
  if (!current) return;

  const newName = await askForText('Новое название профиля:', current.name);
  if (!newName || newName === current.name) return;

  await window.api.renameResourcePackProfile(id, newName);
  await renderRpProfileOptions();
  select.value = id;
  showToast('Профиль переименован', 'success');
});

document.getElementById('rpDeleteProfileBtn').addEventListener('click', async () => {
  const select = document.getElementById('rpProfileSelect');
  const id = select.value;
  if (!id) return;
  const profiles = await window.api.listResourcePackProfiles();
  const current = profiles.find(p => p.id === id);
  if (!await customConfirm(`Удалить профиль «${current ? current.name : ''}»?`)) return;
  await window.api.deleteResourcePackProfile(id);
  await renderRpProfileOptions();
  showToast('Профиль удалён', 'success');
});

// --- установленные файлы ресурспаков: вкл/выкл без удаления ---
let installedRpCache = [];

async function renderInstalledResourcePacks() {
  const { mcVersion, loader } = currentSelection();
  const key = `${mcVersion}\u0000${loader}`;
  installedRpCache = await window.api.listInstalledResourcePacks(mcVersion, loader);
  if (!isSelectionCurrent(key)) return;

  const wanted = await window.api.getWantedResourcePacks(mcVersion, loader);
  const titleByFile = new Map();
  wanted.forEach(w => { if (w.pinnedFileName) titleByFile.set(w.pinnedFileName, w.title); });
  try {
    const dryReport = await window.api.reinstallResourcePacks(mcVersion, loader, true);
    const titleByProjectId = new Map(wanted.map(w => [w.projectId, w.title]));
    dryReport.skipped.forEach(s => {
      if (s.fileName && titleByProjectId.has(s.projectId)) titleByFile.set(s.fileName, titleByProjectId.get(s.projectId));
    });
  } catch {
    // не смогли сопоставить — просто покажем голые имена файлов
  }
  installedRpCache = installedRpCache.map(p => ({ ...p, title: titleByFile.get(p.fileName) || '' }));

  if (!isSelectionCurrent(key)) return;
  renderInstalledResourcePacksFiltered();
}

function renderInstalledResourcePacksFiltered() {
  const container = document.getElementById('installedRpList');
  const query = document.getElementById('installedRpFilter').value.trim().toLowerCase();
  const sortMode = document.getElementById('installedRpSort').value;

  let packs = query
    ? installedRpCache.filter(p => p.fileName.toLowerCase().includes(query) || p.title.toLowerCase().includes(query))
    : installedRpCache.slice();

  if (sortMode === 'status') {
    packs.sort((a, b) => (b.enabled - a.enabled) || a.fileName.localeCompare(b.fileName));
  } else {
    packs.sort((a, b) => (a.title || a.fileName).localeCompare(b.title || b.fileName));
  }

  if (!installedRpCache.length) {
    container.innerHTML = '<div class="desc">Файлов пока нет — сначала установи ресурспаки</div>';
    return;
  }

  if (!packs.length) {
    container.innerHTML = '<div class="desc">Ничего не найдено по фильтру</div>';
    return;
  }

  container.innerHTML = packs.map(p => `
    <div class="installed-mod-row ${p.enabled ? '' : 'disabled'}" data-file="${escHtml(p.fileName)}">
      <span class="file-name">${p.title ? `${escHtml(p.title)} <span class="desc">(${escHtml(p.fileName)})</span>` : escHtml(p.fileName)}</span>
      <button class="mod-toggle ${p.enabled ? 'on' : ''}"></button>
    </div>
  `).join('');

  container.querySelectorAll('.installed-mod-row').forEach(row => {
    row.querySelector('.mod-toggle').addEventListener('click', async () => {
      const { mcVersion, loader } = currentSelection();
      const isCurrentlyDisabled = row.classList.contains('disabled');
      const updated = await window.api.setResourcePackEnabled(mcVersion, loader, row.dataset.file, isCurrentlyDisabled);

      const enabledByFile = new Map(updated.map(p => [p.fileName, p.enabled]));
      installedRpCache = installedRpCache.map(p => ({ ...p, enabled: enabledByFile.get(p.fileName) ?? p.enabled }));
      renderInstalledResourcePacksFiltered();
    });
  });
}

document.getElementById('installedRpFilter').addEventListener('input', renderInstalledResourcePacksFiltered);
document.getElementById('installedRpSort').addEventListener('change', renderInstalledResourcePacksFiltered);

document.getElementById('enableAllRpBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  await window.api.setAllResourcePacksEnabled(mcVersion, loader, true);
  await renderInstalledResourcePacks();
});

document.getElementById('disableAllRpBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  await window.api.setAllResourcePacksEnabled(mcVersion, loader, false);
  await renderInstalledResourcePacks();
});

document.getElementById('refreshInstalledRpBtn').addEventListener('click', renderInstalledResourcePacks);

// --- drag & drop установка ресурспаков ---
const rpTab = document.getElementById('tab-resourcepacks');
const rpDropOverlay = document.getElementById('rpDropOverlay');
let rpDragCounter = 0;

rpTab.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes('Files')) return;
  rpDragCounter++;
  rpDropOverlay.classList.add('active');
});

rpTab.addEventListener('dragover', e => {
  e.preventDefault();
});

rpTab.addEventListener('dragleave', e => {
  e.preventDefault();
  rpDragCounter = Math.max(0, rpDragCounter - 1);
  if (rpDragCounter === 0) rpDropOverlay.classList.remove('active');
});

rpTab.addEventListener('drop', async e => {
  e.preventDefault();
  rpDragCounter = 0;
  rpDropOverlay.classList.remove('active');

  const files = [...e.dataTransfer.files];
  if (!files.length) return;

  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) {
    showToast('Сначала выбери версию на вкладке "Главная"', 'warn');
    return;
  }

  let filePaths;
  try {
    filePaths = files.map(f => window.api.getPathForFile(f));
  } catch (err) {
    showToast('Не удалось прочитать перетащенные файлы', 'error');
    return;
  }

  let report;
  try {
    report = await window.api.installResourcePacksFromFiles(mcVersion, loader, filePaths);
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  if (report.installed.length) {
    showToast(`Установлено файлов: ${report.installed.length}`, 'success', 'Ресурспаки установлены');
    log(rpLog, `Установлено вручную: ${report.installed.join(', ')}`, 'success');
  }
  if (report.skipped.length) {
    showToast(`Пропущено файлов: ${report.skipped.length} (не .zip или ошибка)`, 'warn');
    report.skipped.forEach(s => log(rpLog, `Пропущен ${s.fileName}: ${s.reason}`, 'warn'));
  }

  await renderInstalledResourcePacks();
});

const rpSearchState = { query: '', offset: 0, totalHits: 0, limit: 20 };
let rpSearchToken = 0;

async function runRpSearch(offset = 0) {
  const { mcVersion } = currentSelection();
  const container = document.getElementById('rpSearchResults');
  container.innerHTML = '<div class="desc">Ищу...</div>';

  rpSearchState.query = document.getElementById('rpSearch').value;
  rpSearchState.offset = offset;

  const sort = document.getElementById('rpSortSelect').value;
  const category = document.getElementById('rpCategorySelect').value;

  const myToken = ++rpSearchToken;
  let result;
  try {
    result = await window.api.searchResourcePacks(rpSearchState.query, mcVersion, offset, sort, category);
  } catch (err) {
    if (myToken !== rpSearchToken) return;
    container.innerHTML = `<div class="desc">Ошибка поиска: ${escHtml(err.message)}</div>`;
    return;
  }
  if (myToken !== rpSearchToken) return;

  const { hits, totalHits, limit } = result;
  rpSearchState.totalHits = totalHits;
  rpSearchState.limit = limit;

  if (!hits.length) {
    container.innerHTML = '<div class="desc">Ничего не найдено</div>';
    renderRpSearchPagination();
    return;
  }

  container.innerHTML = hits.map(p => `
    <div class="mod-card" data-id="${escHtml(p.id)}" data-title="${escHtml(p.title)}" data-icon="${escHtml(p.icon || '')}">
      ${p.preview ? `<img class="card-preview" src="${escHtml(p.preview)}" loading="lazy">` : `<div class="card-preview placeholder">${escHtml(String(p.title || '?').charAt(0))}</div>`}
      <div class="card-body">
        <img src="${escHtml(p.icon || '')}" loading="lazy">
        <div>
          <div class="title">${escHtml(p.title)}</div>
          <div class="desc">${escHtml(p.description)}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="add-btn"><img class="inline-ico" src="icons/plus.svg" alt="">Добавить</button>
        <button class="version-pick-btn" title="Выбрать конкретную версию">Версия ▾</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.version-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.mod-card');
      openVersionPicker({
        projectId: card.dataset.id,
        title: card.dataset.title,
        icon: card.dataset.icon,
        loader: null,
        kind: 'resourcepack'
      });
    });
  });

  container.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { mcVersion, loader } = currentSelection();
      const card = btn.closest('.mod-card');
      await window.api.addResourcePack(mcVersion, loader, card.dataset.id, card.dataset.title, card.dataset.icon);
      renderResourcePackList();
      btn.disabled = true;
      btn.textContent = 'Скачиваю...';
      try {
        await window.api.updateOneResourcePack(mcVersion, loader, card.dataset.id, card.dataset.title);
        showToast(`«${card.dataset.title}» добавлен и установлен`, 'success');
      } catch (err) {
        showToast(`«${card.dataset.title}» добавлен в список, но не скачался: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<img class="inline-ico" src="icons/plus.svg" alt="">Добавить';
      }
    });
  });

  renderRpSearchPagination();
}

function renderRpSearchPagination() {
  const bar = document.getElementById('rpSearchPagination');
  const { offset, totalHits, limit } = rpSearchState;

  if (!totalHits) {
    bar.innerHTML = '';
    return;
  }

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(totalHits / limit));

  bar.innerHTML = `
    <button id="rpPagePrev" ${offset <= 0 ? 'disabled' : ''}>&larr; Назад</button>
    <span>Страница ${page} из ${totalPages}</span>
    <button id="rpPageNext" ${offset + limit >= totalHits ? 'disabled' : ''}>Вперёд &rarr;</button>
  `;

  const prevBtn = document.getElementById('rpPagePrev');
  const nextBtn = document.getElementById('rpPageNext');
  if (prevBtn) prevBtn.addEventListener('click', () => runRpSearch(Math.max(0, offset - limit)));
  if (nextBtn) nextBtn.addEventListener('click', () => runRpSearch(offset + limit));
}

document.getElementById('rpSearchBtn').addEventListener('click', () => runRpSearch(0));
document.getElementById('rpSortSelect').addEventListener('change', () => runRpSearch(0));
document.getElementById('rpCategorySelect').addEventListener('change', () => runRpSearch(0));
document.getElementById('rpSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') runRpSearch(0);
});

document.getElementById('rpReinstallBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const dryRun = document.getElementById('rpDryRun').checked;
  clearLog(rpLog);
  log(rpLog, dryRun
    ? `Сухой прогон под ${mcVersion}...`
    : `Переустановка ресурспаков под ${mcVersion}...`);

  try {
    const report = await window.api.reinstallResourcePacks(mcVersion, loader, dryRun);
    hideRpProgress();
    log(rpLog, dryRun
      ? `Будет скачано: ${report.installed.length}, уже есть: ${report.skipped.length}`
      : `Скачано: ${report.installed.length}, уже было: ${report.skipped.length}`);
    report.installed.forEach(p => log(rpLog, `  + ${p.title}`, 'success'));
    if (report.failed.length) {
      log(rpLog, `Недоступно для этой версии: ${report.failed.length}`);
      report.failed.forEach(f => log(rpLog, `  - ${f.title}: ${f.reason}`));
    }

    if (!dryRun) {
      if (report.installed.length) {
        showToast(`Установлено ресурспаков: ${report.installed.length}`, 'success', 'Ресурспаки обновлены');
      } else if (!report.failed.length) {
        showToast('Все ресурспаки уже актуальны', 'info');
      }
      if (report.failed.length) {
        showToast(`Не удалось установить: ${report.failed.length}`, 'error');
      }
    }
  } catch (err) {
    hideRpProgress();
    log(rpLog, `Ошибка: ${err.message}`, 'error');
    showToast(err.message, 'error');
  }
});

// --- опознание вручную закинутых ресурспаков через хэш на Modrinth ---
document.getElementById('identifyLocalResourcePacksBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) { showToast('Сначала выбери версию', 'warn'); return; }

  const btn = document.getElementById('identifyLocalResourcePacksBtn');
  btn.disabled = true;
  btn.textContent = 'Проверяю...';
  log(rpLog, 'Ищу вручную закинутые ресурспаки на Modrinth по хэшу файла...');

  try {
    const results = await window.api.identifyLocalResourcePacks(mcVersion, loader);
    const matched = results.filter(r => r.matched);
    matched.forEach(r => log(rpLog, `  + опознан: ${r.fileName} -> ${r.title}`, 'success'));
    results.filter(r => !r.matched).forEach(r => log(rpLog, `  - ${r.fileName}: ${r.reason}`));

    if (matched.length) {
      showToast(`Опознано ресурспаков: ${matched.length} — теперь будут обновляться сами`, 'success');
    } else if (results.length) {
      showToast('Ни один из закинутых ресурспаков не нашёлся на Modrinth', 'info');
    } else {
      showToast('Нет вручную закинутых ресурспаков для проверки', 'info');
    }
    await renderResourcePackList();
  } catch (err) {
    log(rpLog, `Ошибка: ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Опознать вручную закинутые ресурспаки на Modrinth';
  }
});

function showRpProgress(percent, label) {
  const row = document.getElementById('rpProgressRow');
  const bar = document.getElementById('rpProgressBar');
  const lbl = document.getElementById('rpProgressLabel');
  row.style.display = 'flex';
  bar.value = percent;
  lbl.textContent = label;
}

function hideRpProgress() {
  document.getElementById('rpProgressRow').style.display = 'none';
}

window.api.onResourcePacksProgress(p => {
  if (p.stage === 'downloading') {
    log(rpLog, `Скачиваю ${p.title}...`);
    if (p.total) showRpProgress((p.done / p.total) * 100, `Скачиваю ресурспаки: ${p.done}/${p.total}`);
  }
  if (p.stage === 'downloaded') {
    log(rpLog, `Установлен: ${p.title}`, 'success');
    showToast(`«${p.title}» установлен`, 'success', 'Ресурспак установлен');
    if (p.total) showRpProgress((p.done / p.total) * 100, `Скачиваю ресурспаки: ${p.done}/${p.total}${formatSpeedEta(p.speedBps, p.etaSec)}`);
  }
  if (p.stage === 'retry') log(rpLog, `Обрыв сети, повтор ${p.attempt}/${p.retries}: ${p.title}`, 'warn');
});

// --- шейдеры ---
async function renderShaderList() {
  const { mcVersion, loader } = currentSelection();
  const wanted = await window.api.getWantedShaders(mcVersion, loader);
  const container = document.getElementById('shWantedList');

  if (!wanted.length) {
    container.innerHTML = '<div class="desc">Список пуст — найди шейдер слева и нажми "Добавить"</div>';
    return;
  }

  container.innerHTML = wanted.map(shader => `
    <div class="mod-card" data-id="${escHtml(shader.projectId)}" data-title="${escHtml(shader.title)}">
      ${shader.icon ? `<img src="${escHtml(shader.icon)}" loading="lazy">` : ''}
      <div class="title">${escHtml(shader.title)}</div>
      <button class="remove-btn">Убрать</button>
    </div>
  `).join('');

  container.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.mod-card');
      if (!await customConfirm(`Убрать «${card.dataset.title}» из списка?`)) return;
      await window.api.removeShader(mcVersion, loader, card.dataset.id);
      renderShaderList();
    });
  });
}

const shSearchState = { query: '', offset: 0, totalHits: 0, limit: 20 };
let shSearchToken = 0;

async function runShSearch(offset = 0) {
  const { mcVersion } = currentSelection();
  const container = document.getElementById('shSearchResults');
  container.innerHTML = '<div class="desc">Ищу...</div>';

  shSearchState.query = document.getElementById('shSearch').value;
  shSearchState.offset = offset;

  const sort = document.getElementById('shSortSelect').value;
  const category = document.getElementById('shCategorySelect').value;

  const myToken = ++shSearchToken;
  let result;
  try {
    result = await window.api.searchShaders(shSearchState.query, mcVersion, offset, sort, category);
  } catch (err) {
    if (myToken !== shSearchToken) return;
    container.innerHTML = `<div class="desc">Ошибка поиска: ${escHtml(err.message)}</div>`;
    return;
  }
  if (myToken !== shSearchToken) return;

  const { hits, totalHits, limit } = result;
  shSearchState.totalHits = totalHits;
  shSearchState.limit = limit;

  if (!hits.length) {
    container.innerHTML = '<div class="desc">Ничего не найдено</div>';
    renderShSearchPagination();
    return;
  }

  container.innerHTML = hits.map(s => `
    <div class="mod-card" data-id="${escHtml(s.id)}" data-title="${escHtml(s.title)}" data-icon="${escHtml(s.icon || '')}">
      ${s.preview ? `<img class="card-preview" src="${escHtml(s.preview)}" loading="lazy">` : `<div class="card-preview placeholder">${escHtml(String(s.title || '?').charAt(0))}</div>`}
      <div class="card-body">
        <img src="${escHtml(s.icon || '')}" loading="lazy">
        <div>
          <div class="title">${escHtml(s.title)}</div>
          <div class="desc">${escHtml(s.description)}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="add-btn"><img class="inline-ico" src="icons/plus.svg" alt="">Добавить</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { mcVersion, loader } = currentSelection();
      const card = btn.closest('.mod-card');
      await window.api.addShader(mcVersion, loader, card.dataset.id, card.dataset.title, card.dataset.icon);
      renderShaderList();
      btn.disabled = true;
      btn.textContent = 'Скачиваю...';
      try {
        await window.api.reinstallShaders(mcVersion, loader, false);
        showToast(`«${card.dataset.title}» добавлен и установлен`, 'success');
      } catch (err) {
        showToast(`«${card.dataset.title}» добавлен в список, но не скачался: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<img class="inline-ico" src="icons/plus.svg" alt="">Добавить';
        await renderInstalledShaders();
      }
    });
  });

  renderShSearchPagination();
}

function renderShSearchPagination() {
  const bar = document.getElementById('shSearchPagination');
  const { offset, totalHits, limit } = shSearchState;

  if (!totalHits) {
    bar.innerHTML = '';
    return;
  }

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(totalHits / limit));

  bar.innerHTML = `
    <button id="shPagePrev" ${offset <= 0 ? 'disabled' : ''}>&larr; Назад</button>
    <span>Страница ${page} из ${totalPages}</span>
    <button id="shPageNext" ${offset + limit >= totalHits ? 'disabled' : ''}>Вперёд &rarr;</button>
  `;

  const prevBtn = document.getElementById('shPagePrev');
  const nextBtn = document.getElementById('shPageNext');
  if (prevBtn) prevBtn.addEventListener('click', () => runShSearch(Math.max(0, offset - limit)));
  if (nextBtn) nextBtn.addEventListener('click', () => runShSearch(offset + limit));
}

document.getElementById('shSearchBtn').addEventListener('click', () => runShSearch(0));
document.getElementById('shSortSelect').addEventListener('change', () => runShSearch(0));
document.getElementById('shCategorySelect').addEventListener('change', () => runShSearch(0));
document.getElementById('shSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') runShSearch(0);
});

document.getElementById('shReinstallBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const dryRun = document.getElementById('shDryRun').checked;
  clearLog(shLog);
  log(shLog, dryRun
    ? `Сухой прогон под ${mcVersion}...`
    : `Переустановка шейдеров под ${mcVersion}...`);

  try {
    const report = await window.api.reinstallShaders(mcVersion, loader, dryRun);
    hideShProgress();
    log(shLog, dryRun
      ? `Будет скачано: ${report.installed.length}, уже есть: ${report.skipped.length}`
      : `Скачано: ${report.installed.length}, уже было: ${report.skipped.length}`);
    report.installed.forEach(s => log(shLog, `  + ${s.title}`, 'success'));
    if (report.failed.length) {
      log(shLog, `Недоступно для этой версии: ${report.failed.length}`);
      report.failed.forEach(f => log(shLog, `  - ${f.title}: ${f.reason}`));
    }

    if (!dryRun) {
      if (report.installed.length) {
        showToast(`Установлено шейдеров: ${report.installed.length}`, 'success', 'Шейдеры обновлены');
      } else if (!report.failed.length) {
        showToast('Все шейдеры уже актуальны', 'info');
      }
      if (report.failed.length) {
        showToast(`Не удалось установить: ${report.failed.length}`, 'error');
      }
      await renderInstalledShaders();
    }
  } catch (err) {
    hideShProgress();
    log(shLog, `Ошибка: ${err.message}`, 'error');
    showToast(err.message, 'error');
  }
});

function showShProgress(percent, label) {
  const row = document.getElementById('shProgressRow');
  const bar = document.getElementById('shProgressBar');
  const lbl = document.getElementById('shProgressLabel');
  row.style.display = 'flex';
  bar.value = percent;
  lbl.textContent = label;
}

function hideShProgress() {
  document.getElementById('shProgressRow').style.display = 'none';
}

window.api.onShadersProgress(p => {
  if (p.stage === 'downloading') {
    log(shLog, `Скачиваю ${p.title}...`);
    if (p.total) showShProgress((p.done / p.total) * 100, `Скачиваю шейдеры: ${p.done}/${p.total}`);
  }
  if (p.stage === 'downloaded') {
    log(shLog, `Установлен: ${p.title}`, 'success');
    showToast(`«${p.title}» установлен`, 'success', 'Шейдер установлен');
    if (p.total) showShProgress((p.done / p.total) * 100, `Скачиваю шейдеры: ${p.done}/${p.total}${formatSpeedEta(p.speedBps, p.etaSec)}`);
  }
  if (p.stage === 'retry') log(shLog, `Обрыв сети, повтор ${p.attempt}/${p.retries}: ${p.title}`, 'warn');
});

// --- установленные файлы шейдеров: вкл/выкл без удаления ---
let installedShCache = [];

async function renderInstalledShaders() {
  const { mcVersion, loader } = currentSelection();
  const key = `${mcVersion}\u0000${loader}`;
  installedShCache = await window.api.listInstalledShaders(mcVersion, loader);
  if (!isSelectionCurrent(key)) return;

  const wanted = await window.api.getWantedShaders(mcVersion, loader);
  const titleByFile = new Map();
  try {
    const dryReport = await window.api.reinstallShaders(mcVersion, loader, true);
    if (!isSelectionCurrent(key)) return;
    const titleByProjectId = new Map(wanted.map(w => [w.projectId, w.title]));
    dryReport.skipped.forEach(s => {
      if (s.fileName && titleByProjectId.has(s.projectId)) titleByFile.set(s.fileName, titleByProjectId.get(s.projectId));
    });
  } catch {
    // не смогли сопоставить — просто покажем голые имена файлов
  }
  installedShCache = installedShCache.map(s => ({ ...s, title: titleByFile.get(s.fileName) || '' }));

  if (!isSelectionCurrent(key)) return;
  renderInstalledShadersFiltered();
}

function renderInstalledShadersFiltered() {
  const container = document.getElementById('installedShList');
  const query = document.getElementById('installedShFilter').value.trim().toLowerCase();
  const sortMode = document.getElementById('installedShSort').value;

  let shaders = query
    ? installedShCache.filter(s => s.fileName.toLowerCase().includes(query) || s.title.toLowerCase().includes(query))
    : installedShCache.slice();

  if (sortMode === 'status') {
    shaders.sort((a, b) => (b.enabled - a.enabled) || a.fileName.localeCompare(b.fileName));
  } else {
    shaders.sort((a, b) => (a.title || a.fileName).localeCompare(b.title || b.fileName));
  }

  if (!installedShCache.length) {
    container.innerHTML = '<div class="desc">Файлов пока нет — сначала установи шейдеры</div>';
    return;
  }

  if (!shaders.length) {
    container.innerHTML = '<div class="desc">Ничего не найдено по фильтру</div>';
    return;
  }

  container.innerHTML = shaders.map(s => `
    <div class="installed-mod-row ${s.enabled ? '' : 'disabled'}" data-file="${escHtml(s.fileName)}">
      <span class="file-name">${s.title ? `${escHtml(s.title)} <span class="desc">(${escHtml(s.fileName)})</span>` : escHtml(s.fileName)}</span>
      <button class="mod-toggle ${s.enabled ? 'on' : ''}"></button>
    </div>
  `).join('');

  container.querySelectorAll('.installed-mod-row').forEach(row => {
    row.querySelector('.mod-toggle').addEventListener('click', async () => {
      const { mcVersion, loader } = currentSelection();
      const isCurrentlyDisabled = row.classList.contains('disabled');
      const updated = await window.api.setShaderEnabled(mcVersion, loader, row.dataset.file, isCurrentlyDisabled);

      const enabledByFile = new Map(updated.map(s => [s.fileName, s.enabled]));
      installedShCache = installedShCache.map(s => ({ ...s, enabled: enabledByFile.get(s.fileName) ?? s.enabled }));
      renderInstalledShadersFiltered();
    });
  });
}

document.getElementById('installedShFilter').addEventListener('input', renderInstalledShadersFiltered);
document.getElementById('installedShSort').addEventListener('change', renderInstalledShadersFiltered);

document.getElementById('enableAllShBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  await window.api.setAllShadersEnabled(mcVersion, loader, true);
  await renderInstalledShaders();
});

document.getElementById('disableAllShBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  await window.api.setAllShadersEnabled(mcVersion, loader, false);
  await renderInstalledShaders();
});

document.getElementById('refreshInstalledShBtn').addEventListener('click', renderInstalledShaders);

// --- drag & drop установка шейдеров ---
const shTab = document.getElementById('tab-shaders');
const shDropOverlay = document.getElementById('shDropOverlay');
let shDragCounter = 0;

shTab.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes('Files')) return;
  shDragCounter++;
  shDropOverlay.classList.add('active');
});

shTab.addEventListener('dragover', e => {
  e.preventDefault();
});

shTab.addEventListener('dragleave', e => {
  e.preventDefault();
  shDragCounter = Math.max(0, shDragCounter - 1);
  if (shDragCounter === 0) shDropOverlay.classList.remove('active');
});

shTab.addEventListener('drop', async e => {
  e.preventDefault();
  shDragCounter = 0;
  shDropOverlay.classList.remove('active');

  const files = [...e.dataTransfer.files];
  if (!files.length) return;

  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) {
    showToast('Сначала выбери версию на вкладке "Главная"', 'warn');
    return;
  }

  let filePaths;
  try {
    filePaths = files.map(f => window.api.getPathForFile(f));
  } catch (err) {
    showToast('Не удалось прочитать перетащенные файлы', 'error');
    return;
  }

  let report;
  try {
    report = await window.api.installShadersFromFiles(mcVersion, loader, filePaths);
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  if (report.installed.length) {
    showToast(`Установлено файлов: ${report.installed.length}`, 'success', 'Шейдеры установлены');
    log(shLog, `Установлено вручную: ${report.installed.join(', ')}`, 'success');
  }
  if (report.skipped.length) {
    showToast(`Пропущено файлов: ${report.skipped.length} (не .zip или ошибка)`, 'warn');
    report.skipped.forEach(s => log(shLog, `Пропущен ${s.fileName}: ${s.reason}`, 'warn'));
  }

  await renderInstalledShaders();
});

// --- настройки ---
document.getElementById('changeDirBtn').addEventListener('click', async () => {
  const dir = await window.api.setGameDir();
  document.getElementById('gameDirLabel').textContent = dir;
});

document.getElementById('saveMemBtn').addEventListener('click', async () => {
  const min = document.getElementById('memMin').value;
  const max = document.getElementById('memMax').value;
  await window.api.setMemory(min, max);
  showToast('Настройки памяти сохранены', 'success');
});

document.getElementById('memPreset').addEventListener('change', e => {
  if (!e.target.value) return;
  const [min, max] = e.target.value.split(',');
  document.getElementById('memMin').value = min;
  document.getElementById('memMax').value = max;
});

async function updateMemoryRecommendation() {
  const recommendation = document.getElementById('memRecommendation');
  if (!recommendation) return;
  try {
    const { totalBytes } = await window.api.getMemoryInfo();
    const totalGb = totalBytes / (1024 * 1024 * 1024);
    let maxGb = Math.floor(totalGb * 0.5);
    maxGb = Math.max(2, Math.min(maxGb, 16));
    const minGb = Math.max(1, Math.round(maxGb / 4));
    recommendation.textContent = `Рекомендуется: ${minGb}G / ${maxGb}G`;
    recommendation.title = `Обнаружено ${totalGb.toFixed(1)} ГБ ОЗУ`;
  } catch {
    recommendation.textContent = '';
  }
}

async function applyAutoMemory() {
  const { totalBytes } = await window.api.getMemoryInfo();
  const totalGb = totalBytes / (1024 * 1024 * 1024);
  let maxGb = Math.floor(totalGb * 0.5);
  maxGb = Math.max(2, Math.min(maxGb, 16));
  const minGb = Math.max(1, Math.round(maxGb / 4));
  document.getElementById('memPreset').value = '';
  document.getElementById('memMin').value = `${minGb}G`;
  document.getElementById('memMax').value = `${maxGb}G`;
  showToast(`Подобрано ${minGb}G / ${maxGb}G`, 'info');
}

document.getElementById('memAutoBtn').addEventListener('click', applyAutoMemory);
updateMemoryRecommendation();

document.getElementById('setJavaPathBtn').addEventListener('click', async () => {
  const path = await window.api.setJavaPath();
  document.getElementById('javaPathLabel').textContent = path || 'по умолчанию (скачается сама)';
});

document.getElementById('clearJavaPathBtn').addEventListener('click', async () => {
  await window.api.clearJavaPath();
  document.getElementById('javaPathLabel').textContent = 'по умолчанию (скачается сама)';
});

document.getElementById('checkJavaBtn').addEventListener('click', async () => {
  const { mcVersion } = currentSelection();
  const apiMcVersion = String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim();
  const btn = document.getElementById('checkJavaBtn');
  const row = document.getElementById('javaCheckResultRow');
  const label = document.getElementById('javaCheckResultLabel');

  btn.disabled = true;
  btn.textContent = 'Проверяю...';
  try {
    const result = await window.api.checkJava(apiMcVersion);
    row.style.display = 'flex';
    label.textContent = result.message;
    label.style.color = result.ok === false ? '#e07356' : result.ok === true ? 'var(--accent-hi)' : 'var(--text-dim)';
  } catch (err) {
    row.style.display = 'flex';
    label.textContent = `Не удалось проверить: ${err.message}`;
    label.style.color = '#e07356';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Проверить совместимость';
  }
});

function validateJvmArgs(raw) {
  const value = raw.trim();
  if (!value) return { ok: true };

  const quoteCount = (value.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    return { ok: false, reason: 'незакрытая кавычка' };
  }

  const tokens = value.match(/"[^"]*"|\S+/g) || [];
  const badToken = tokens.find(t => !t.startsWith('-'));
  if (badToken) {
    return { ok: false, reason: `аргумент "${badToken}" не похож на флаг JVM (должен начинаться с "-")` };
  }

  return { ok: true };
}

document.getElementById('saveJvmArgsBtn').addEventListener('click', async () => {
  const value = document.getElementById('jvmArgs').value;
  const check = validateJvmArgs(value);

  if (!check.ok) {
    const proceed = await customConfirm(`Похоже, в аргументах ошибка: ${check.reason}.\nСохранить как есть?`);
    if (!proceed) return;
  }

  await window.api.setJvmArgs(value);
  showToast('Аргументы JVM сохранены', 'success');
});

document.getElementById('saveCurseforgeApiKeyBtn').addEventListener('click', async () => {
  const value = document.getElementById('curseforgeApiKeyInput').value;
  await window.api.setCurseforgeApiKey(value);
  showToast('Ключ CurseForge сохранён', 'success');
});

document.getElementById('openCurseforgeConsoleBtn').addEventListener('click', () => {
  window.api.openExternal('https://console.curseforge.com/');
});

document.getElementById('saveWindowBtn').addEventListener('click', async () => {
  const width = Number(document.getElementById('gameWidth').value) || 854;
  const height = Number(document.getElementById('gameHeight').value) || 480;
  const fullscreen = document.getElementById('fullscreenCheck').checked;
  await window.api.setWindowSize(width, height, fullscreen);
});

document.getElementById('saveLauncherSizeBtn').addEventListener('click', async () => {
  const width = Number(document.getElementById('launcherWidth').value) || 1280;
  const height = Number(document.getElementById('launcherHeight').value) || 800;
  const applied = await window.api.setLauncherSize(width, height);
  document.getElementById('launcherWidth').value = applied.width;
  document.getElementById('launcherHeight').value = applied.height;
});

document.getElementById('discordRpcCheck').addEventListener('change', async e => {
  await window.api.setDiscordRPC(e.target.checked);
});

document.getElementById('gameLogsCheck').addEventListener('change', async e => {
  await window.api.setGameLogsEnabled(e.target.checked);
});

document.getElementById('customSkinLoaderCheck').addEventListener('change', async e => {
  await window.api.setCustomSkinLoaderEnabled(e.target.checked);
  showToast(
    e.target.checked ? 'CustomSkinLoader будет ставиться на Fabric/Forge-сборки' : 'CustomSkinLoader отключён',
    'info'
  );
});

document.getElementById('afterLaunchSelect').addEventListener('change', async e => {
  await window.api.setAfterLaunch(e.target.value);
});

document.getElementById('debugModeCheck').addEventListener('change', async e => {
  window.__debug = e.target.checked;
  await window.api.setDebugMode(e.target.checked);
});

document.getElementById('gpuPreferenceSelect').addEventListener('change', async e => {
  await window.api.setGpuPreference(e.target.value);
});

document.getElementById('notificationsCheck').addEventListener('change', async e => {
  await window.api.setNotifications(e.target.checked);
});

document.getElementById('notificationModeSelect').addEventListener('change', async e => {
  window.__notificationMode = e.target.value;
  await window.api.setNotificationMode(e.target.value);
});

document.getElementById('notificationSoundVolume').addEventListener('input', async e => {
  notificationSoundVolume = Number(e.target.value) / 100;
  document.getElementById('notificationSoundVolumeLabel').textContent = `${e.target.value}%`;
  Object.values(notificationSounds).forEach(sound => { sound.volume = notificationSoundVolume; });
  await window.api.setNotificationSoundVolume(notificationSoundVolume);
});

document.getElementById('testNotificationSoundBtn').addEventListener('click', () => playNotificationSound('notification'));

document.getElementById('minimizeToTrayCheck').addEventListener('change', async e => {
  await window.api.setMinimizeToTray(e.target.checked);
});

document.getElementById('backupSavesCheck').addEventListener('change', async e => {
  await window.api.setBackupSaves(e.target.checked);
});

document.getElementById('makeBackupNowBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const btn = document.getElementById('makeBackupNowBtn');
  btn.disabled = true;
  btn.textContent = 'Архивирую...';
  try {
    await window.api.makeBackupNow(mcVersion, loader);
    showToast('Резервная копия миров создана', 'success');
    await renderBackupsList();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сделать бэкап сейчас';
  }
});

document.getElementById('openBackupsFolderBtn').addEventListener('click', () => {
  const { mcVersion, loader } = currentSelection();
  window.api.openBackupsFolder(mcVersion, loader);
});

async function renderBackupsList() {
  const { mcVersion, loader } = currentSelection();
  const container = document.getElementById('backupsList');
  const backups = await window.api.listBackups(mcVersion, loader);

  if (!backups.length) {
    container.innerHTML = '<div class="desc">Бэкапов пока нет</div>';
    return;
  }

  container.innerHTML = backups.map(b => {
    const date = new Date(b.mtime).toLocaleString(window.i18n.locale);
    const sizeMb = (b.sizeBytes / (1024 * 1024)).toFixed(1);
    return `<div class="mod-card"><div class="title">${escHtml(b.fileName)}</div><div class="desc">${date} · ${sizeMb} МБ</div></div>`;
  }).join('');
}

document.getElementById('refreshBackupsListBtn').addEventListener('click', renderBackupsList);

// --- Build Snapshots 2.0: named snapshots, full build state, restore and delete ---
document.getElementById('makeBuildBackupNowBtn').addEventListener('click', async () => {
  const { mcVersion, loader } = currentSelection();
  const en = window.i18n.lang === 'en';
  const suggestedName = `${en ? 'Snapshot' : 'Снимок'} ${new Date().toLocaleDateString(window.i18n.locale)}`;
  const name = await askForText(en ? 'Build snapshot name' : 'Название снимка сборки', suggestedName);
  if (!name) return;

  const btn = document.getElementById('makeBuildBackupNowBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = en ? 'Saving snapshot...' : 'Сохраняю снимок...';
  try {
    await window.api.makeBuildBackupNow(mcVersion, loader, name);
    showToast(en ? `Snapshot "${name}" created` : `Снимок «${name}» создан`, 'success');
    await renderBuildBackupsList();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText || 'Создать снимок';
  }
});

document.getElementById('openBuildBackupsFolderBtn').addEventListener('click', () => {
  const { mcVersion, loader } = currentSelection();
  window.api.openBuildBackupsFolder(mcVersion, loader);
});

function formatBuildSnapshotSummary(summary = {}) {
  const en = window.i18n.lang === 'en';
  const ruCount = (value, forms) => {
    const n = Math.abs(Number(value)) % 100;
    const last = n % 10;
    const index = n > 10 && n < 20 ? 2 : last > 1 && last < 5 ? 1 : last === 1 ? 0 : 2;
    return `${value} ${forms[index]}`;
  };
  const parts = [];
  if (summary.mods) parts.push(en ? `${summary.mods} ${summary.mods === 1 ? 'mod' : 'mods'}` : ruCount(summary.mods, ['мод', 'мода', 'модов']));
  if (summary.resourcePacks) parts.push(en ? `${summary.resourcePacks} ${summary.resourcePacks === 1 ? 'resource pack' : 'resource packs'}` : ruCount(summary.resourcePacks, ['ресурспак', 'ресурспака', 'ресурспаков']));
  if (summary.shaders) parts.push(en ? `${summary.shaders} ${summary.shaders === 1 ? 'shader pack' : 'shader packs'}` : ruCount(summary.shaders, ['шейдер', 'шейдера', 'шейдеров']));
  if (summary.configFiles) parts.push(en ? `${summary.configFiles} ${summary.configFiles === 1 ? 'config file' : 'config files'}` : ruCount(summary.configFiles, ['файл конфигурации', 'файла конфигурации', 'файлов конфигурации']));
  if (summary.settingsFiles) parts.push(en ? `${summary.settingsFiles} ${summary.settingsFiles === 1 ? 'game setting' : 'game settings'}` : ruCount(summary.settingsFiles, ['игровая настройка', 'игровые настройки', 'игровых настроек']));
  return parts.length ? parts.join(' · ') : (en ? 'Build lists and metadata' : 'Списки контента и метаданные сборки');
}

async function renderBuildBackupsList() {
  const { mcVersion, loader } = currentSelection();
  const container = document.getElementById('buildBackupsList');
  const backups = await window.api.listBuildBackups(mcVersion, loader);

  if (!backups.length) {
    container.innerHTML = window.i18n.lang === 'en'
      ? '<div class="desc">No snapshots yet. Create one manually or wait for an automatic snapshot before an update.</div>'
      : '<div class="desc">Снимков пока нет. Создай первый вручную или дождись автоматического снимка перед обновлением.</div>';
    return;
  }

  container.innerHTML = backups.map(b => {
    const date = new Date(b.createdAt || b.mtime).toLocaleString(window.i18n.locale);
    const sizeMb = (b.sizeBytes / (1024 * 1024)).toFixed(1);
    const versionLabel = window.i18n.lang === 'en'
      ? (b.formatVersion >= 2 ? 'Full snapshot' : b.formatVersion === 1 ? 'Legacy · mods and resource packs' : 'Damaged archive')
      : (b.formatVersion >= 2 ? 'Полный снимок' : b.formatVersion === 1 ? 'Старый формат · моды и ресурспаки' : 'Повреждённый архив');
    const canRestore = b.isRestorable === true;
    return `
      <div class="mod-card build-snapshot-card" data-path="${escHtml(b.path)}" data-format="${b.formatVersion}">
        <div class="build-snapshot-main">
          <div class="title">${escHtml(b.name)}</div>
          <div class="desc">${date} · ${sizeMb} МБ · ${versionLabel}</div>
          <div class="build-snapshot-summary">${escHtml(formatBuildSnapshotSummary(b.summary))}</div>
        </div>
        <div class="build-snapshot-actions">
          <button class="build-restore-btn primary" ${canRestore ? '' : 'disabled'}>${canRestore ? (window.i18n.lang === 'en' ? 'Restore' : 'Восстановить') : (window.i18n.lang === 'en' ? 'Unavailable' : 'Недоступен')}</button>
          <button class="build-delete-btn" title="${window.i18n.lang === 'en' ? 'Delete snapshot' : 'Удалить снимок'}">${window.i18n.lang === 'en' ? 'Delete' : 'Удалить'}</button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.build-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const card = btn.closest('.build-snapshot-card');
      const backupPath = card.dataset.path;
      const snapshotName = card.querySelector('.title')?.textContent || 'снимок';
      const en = window.i18n.lang === 'en';
      const isLegacy = Number(card.dataset.format) <= 1;
      const confirmed = await customConfirm(en
        ? (isLegacy
          ? `Restore legacy snapshot \"${snapshotName}\"?\n\nOnly mods and resource packs will be replaced. Shaders, configs, game settings and worlds will stay as they are. FCore will save the current build before restoring.`
          : `Restore snapshot \"${snapshotName}\"?\n\nCurrent mods, resource packs, shaders, configs and in-game settings will be replaced. Worlds and the shared .minecraft files are not touched. FCore will automatically save the current state before restoring.`)
        : (isLegacy
          ? `Восстановить старый снимок «${snapshotName}»?\n\nБудут заменены только моды и ресурспаки. Шейдеры, конфиги, игровые настройки и миры останутся как есть. Перед восстановлением FCore сохранит текущее состояние сборки.`
          : `Восстановить снимок «${snapshotName}»?\n\nТекущие моды, ресурспаки, шейдеры, конфиги и игровые настройки будут заменены данными снимка. Миры и папка .minecraft не затрагиваются. Перед восстановлением FCore автоматически создаст снимок текущего состояния.`)
      );
      if (!confirmed) return;

      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = en ? 'Restoring...' : 'Восстанавливаю...';
      try {
        const { mcVersion, loader } = currentSelection();
        const result = await window.api.rollbackBuild(mcVersion, loader, backupPath);
        const counts = en
          ? `Mods: ${result.modsRestored}, resource packs: ${result.packsRestored}, shaders: ${result.shadersRestored}, config files: ${result.configFilesRestored}, settings: ${result.settingsFilesRestored}`
          : `модов: ${result.modsRestored}, ресурспаков: ${result.packsRestored}, шейдеров: ${result.shadersRestored}, конфигов: ${result.configFilesRestored}, настроек: ${result.settingsFilesRestored}`;
        showToast(counts, 'success', en ? 'Snapshot restored' : 'Снимок восстановлен');
        await renderBuildBackupsList();
        await renderInstalledMods();
        await renderInstalledResourcePacks();
        await renderInstalledShaders();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  container.querySelectorAll('.build-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.build-snapshot-card');
      const backupPath = card.dataset.path;
      const snapshotName = card.querySelector('.title')?.textContent || 'снимок';
      const en = window.i18n.lang === 'en';
      if (!await customConfirm(en ? `Delete snapshot "${snapshotName}"? This cannot be undone.` : `Удалить снимок «${snapshotName}»? Это действие нельзя отменить.`)) return;
      btn.disabled = true;
      try {
        const { mcVersion, loader } = currentSelection();
        await window.api.deleteBuildBackup(mcVersion, loader, backupPath);
        showToast(en ? 'Snapshot deleted' : 'Снимок удалён', 'success');
        await renderBuildBackupsList();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

document.getElementById('refreshBuildBackupsListBtn').addEventListener('click', renderBuildBackupsList);

document.getElementById('openCrashFolderBtn').addEventListener('click', () => {
  window.api.openCrashFolder();
});

// --- крашлоги прямо в интерфейсе ---
async function renderCrashList() {
  const container = document.getElementById('crashReportsList');
  const reports = await window.api.listCrashReports();

  if (!reports.length) {
    container.innerHTML = '<div class="desc">Крашей пока не было</div>';
    return;
  }

  container.innerHTML = reports.slice(0, 15).map(r => `
    <div class="mod-card crash-card" data-path="${escHtml(r.path)}">
      <div style="flex:1;min-width:0">
        <div class="title">${escHtml(r.fileName)}</div>
        <pre class="desc crash-preview log" style="display:none;margin-top:6px;max-height:160px"></pre>
      </div>
      <button class="crash-analyze-btn">Разобрать</button>
      <button class="crash-view-btn">Показать</button>
      <button class="crash-copy-btn">Копировать</button>
    </div>
  `).join('');

  container.querySelectorAll('.crash-analyze-btn').forEach(btn => {
    btn.addEventListener('click', () => window.fcDiag.analyzeReport(btn.closest('.crash-card').dataset.path));
  });

  container.querySelectorAll('.crash-view-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.crash-card');
      const preview = card.querySelector('.crash-preview');
      if (preview.style.display === 'none') {
        if (!preview.dataset.loaded) {
          preview.textContent = await window.api.readCrashReport(card.dataset.path);
          preview.dataset.loaded = '1';
        }
        preview.style.display = 'block';
        btn.textContent = 'Скрыть';
      } else {
        preview.style.display = 'none';
        btn.textContent = 'Показать';
      }
    });
  });

  container.querySelectorAll('.crash-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.crash-card');
      const content = await window.api.readCrashReport(card.dataset.path);
      await navigator.clipboard.writeText(content);
      showToast('Крашлог скопирован в буфер обмена', 'success');
    });
  });
}

async function renderJavaList() {
  const container = document.getElementById('javaInstalledList');
  const list = await window.api.listJava();

  if (!list.length) {
    container.innerHTML = '<div class="desc">Java пока не скачивалась — установится сама при первом запуске</div>';
    return;
  }

  container.innerHTML = list.map(j => `
    <div class="mod-card java-card" data-major="${j.major}">
      <div style="flex:1;min-width:0">
        <div class="title">Java ${j.major}${j.used ? ' <span class="desc">(используется)</span>' : ''}</div>
        <div class="desc">${(j.sizeBytes / 1024 / 1024).toFixed(0)} МБ${j.ready ? '' : ' — не удалось найти javaw.exe'}</div>
      </div>
      <button class="java-delete-btn">Удалить</button>
    </div>
  `).join('');

  container.querySelectorAll('.java-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.java-card');
      const major = card.dataset.major;
      if (!await customConfirm(`Удалить скачанную Java ${major}? Если она понадобится снова, лаунчер скачает её заново.`)) return;
      await window.api.deleteJava(Number(major));
      renderJavaList();
    });
  });
}

document.querySelectorAll('.java-install-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const major = Number(btn.dataset.major);
    document.querySelectorAll('.java-install-btn').forEach(b => b.disabled = true);
    const row = document.getElementById('javaInstallProgressRow');
    const bar = document.getElementById('javaInstallProgressBar');
    const label = document.getElementById('javaInstallProgressLabel');
    row.style.display = 'flex';
    bar.value = 0;
    label.textContent = `Скачивание Java ${major}...`;

    try {
      await window.api.installJava(major);
      showToast(`Java ${major} установлена`, 'success');
    } catch (err) {
      showToast(`Не удалось установить Java ${major}: ${err.message}`, 'error');
    } finally {
      row.style.display = 'none';
      document.querySelectorAll('.java-install-btn').forEach(b => b.disabled = false);
      renderJavaList();
    }
  });
});

window.api.onJavaProgress(({ stage, javaMajor, downloaded, total }) => {
  const row = document.getElementById('javaInstallProgressRow');
  const bar = document.getElementById('javaInstallProgressBar');
  const label = document.getElementById('javaInstallProgressLabel');
  row.style.display = 'flex';

  if (stage === 'java-download') {
    label.textContent = `Скачивание Java ${javaMajor}...`;
    bar.value = total ? Math.round((downloaded / total) * 100) : 0;
  } else if (stage === 'java-extract') {
    label.textContent = `Распаковка Java ${javaMajor}...`;
    bar.value = 100;
  }
});

document.getElementById('refreshCrashListBtn').addEventListener('click', renderCrashList);

// --- Storage Analyzer: read-only анализ пространства .minecraft ---
function storageFormatSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} ТБ`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} ГБ`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${value} Б`;
}

function renderStorageReport(report) {
  const container = document.getElementById('storageReport');
  const maxCategory = Math.max(1, ...(report.categories || []).map(c => c.sizeBytes || 0));
  const categories = (report.categories || []).filter(c => c.sizeBytes > 0);
  const builds = report.builds || [];
  const biggest = report.largestFiles || [];
  container.innerHTML = `
    <div class="storage-summary">
      <div class="storage-total"><span class="desc">Всего занято</span><strong>${storageFormatSize(report.totalBytes)}</strong><span class="desc">${Number(report.totalFiles || 0).toLocaleString(window.i18n.locale)} файлов</span></div>
      <div class="storage-scan-meta">Папка: ${escHtml(report.rootName)} · ${new Date(report.generatedAt).toLocaleString(window.i18n.locale)}</div>
    </div>
    <div class="storage-columns">
      <section class="storage-subpanel">
        <h3>По категориям</h3>
        ${categories.length ? categories.map(c => `
          <div class="storage-category">
            <div class="storage-category-head"><span>${escHtml(c.name)}</span><strong>${storageFormatSize(c.sizeBytes)}</strong></div>
            <div class="storage-track"><i style="width:${Math.max(0, Math.min(100, c.sizeBytes / maxCategory * 100)).toFixed(1)}%"></i></div>
            <div class="desc">${Number(c.fileCount || 0).toLocaleString(window.i18n.locale)} файлов${c.truncated ? ' · достигнут лимит анализа' : ''}</div>
          </div>`).join('') : '<div class="desc">Файлы не найдены.</div>'}
      </section>
      <section class="storage-subpanel">
        <h3>Сборки</h3>
        ${builds.length ? builds.slice(0, 12).map(b => `
          <details class="storage-build">
            <summary><span>${escHtml(b.name)}</span><strong>${storageFormatSize(b.sizeBytes)}</strong></summary>
            <div class="storage-build-meta">${escHtml([b.mcVersion, b.loader].filter(Boolean).join(' · ') || b.folder)} · ${Number(b.fileCount || 0).toLocaleString(window.i18n.locale)} файлов</div>
            ${(b.categories || []).map(c => `<div class="storage-build-part"><span>${escHtml(c.label || c.name)}</span><span>${storageFormatSize(c.sizeBytes)}</span></div>`).join('')}
            ${b.truncated ? '<div class="desc">Анализ этой папки достиг лимита файлов.</div>' : ''}
          </details>`).join('') : '<div class="desc">Папки сборок не найдены.</div>'}
      </section>
    </div>
    <section class="storage-subpanel storage-largest">
      <h3>Самые большие файлы</h3>
      ${biggest.length ? biggest.slice(0, 15).map(f => `<div class="storage-file"><span title="${escHtml(f.path)}">${escHtml(f.path)}</span><strong>${storageFormatSize(f.sizeBytes)}</strong></div>`).join('') : '<div class="desc">Файлы не найдены.</div>'}
    </section>
    ${(report.warnings || []).length ? `<div class="storage-warning">Не удалось прочитать некоторые элементы: ${report.warnings.length}. Это может немного занизить итоговый размер.</div>` : ''}
  `;
}

const storageAnalyzeBtn = document.getElementById('storageAnalyzeBtn');
storageAnalyzeBtn?.addEventListener('click', async () => {
  const container = document.getElementById('storageReport');
  storageAnalyzeBtn.disabled = true;
  storageAnalyzeBtn.innerHTML = `<span class="ico" style="--ico-src:url('icons/update.svg')" aria-hidden="true"></span>Анализирую...`;
  container.innerHTML = '<div class="desc">Сканирую папки игры. На больших дисках это может занять некоторое время.</div>';
  try {
    const report = await window.api.analyzeStorage();
    renderStorageReport(report);
  } catch (err) {
    container.innerHTML = `<div class="storage-warning">Не удалось выполнить анализ: ${escHtml(err.message || err)}</div>`;
  } finally {
    storageAnalyzeBtn.disabled = false;
    storageAnalyzeBtn.innerHTML = `<span class="ico" style="--ico-src:url('icons/hard-drive.svg')" aria-hidden="true"></span>Анализировать`;
  }
});


// --- своя иконка лаунчера ---
function setLogoImage(filePath) {
  document.getElementById('logoImg').src = `file://${filePath.replace(/\\/g, '/')}`;
}

document.getElementById('setCustomIconBtn').addEventListener('click', async () => {
  const dest = await window.api.setCustomIcon();
  if (dest) setLogoImage(dest);
});

document.getElementById('resetIconBtn').addEventListener('click', async () => {
  const defaultIcon = await window.api.resetIcon();
  setLogoImage(defaultIcon);
});

// --- тема оформления ---
function lightenHex(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (n >> 16) + amount);
  const g = Math.min(255, ((n >> 8) & 0xff) + amount);
  const b = Math.min(255, (n & 0xff) + amount);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function mixHex(baseHex, hex, t) {
  const b = parseInt(baseHex.replace('#', ''), 16);
  const c = parseInt(hex.replace('#', ''), 16);
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const cr = (c >> 16) & 0xff, cg = (c >> 8) & 0xff, cb = c & 0xff;
  const r = Math.round(br + (cr - br) * t);
  const g = Math.round(bg + (cg - bg) * t);
  const bl = Math.round(bb + (cb - bb) * t);
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
}

function applyCustomPalette(hex) {
  const mode = document.body.dataset.mode === 'light' ? 'light' : 'dark';
  // Нейтральная база + лёгкая примесь выбранного цвета. Так кастомная тема
  // больше не получает старый зелёно-оливковый фон и одинаково работает
  // в тёмном и светлом режиме.
  const base = mode === 'light'
    ? { bg: '#f3f5fa', bg2: '#ebeff7', panel: '#fbfcff', panel2: '#e8ecf5', border: '#d5dbe8', borderHi: '#bdc6d8' }
    : { bg: '#080b12', bg2: '#0d111b', panel: '#121722', panel2: '#181e2c', border: '#252c3b', borderHi: '#343d50' };

  document.body.style.setProperty('--bg', mixHex(base.bg, hex, mode === 'light' ? 0.07 : 0.09));
  document.body.style.setProperty('--bg-2', mixHex(base.bg2, hex, mode === 'light' ? 0.09 : 0.10));
  document.body.style.setProperty('--panel', mixHex(base.panel, hex, mode === 'light' ? 0.06 : 0.11));
  document.body.style.setProperty('--panel-2', mixHex(base.panel2, hex, mode === 'light' ? 0.09 : 0.14));
  document.body.style.setProperty('--border', mixHex(base.border, hex, 0.16));
  document.body.style.setProperty('--border-hi', mixHex(base.borderHi, hex, 0.20));
  document.body.style.setProperty('--accent-dim', mixHex('#000000', hex, 0.55));
}

function applyTheme(theme, customHex) {
  document.body.dataset.theme = theme;
  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });

  if (theme === 'custom') {
    const hex = customHex || '#4b58ff';
    document.body.style.setProperty('--accent', hex);
    document.body.style.setProperty('--accent-hi', lightenHex(hex, 40));
    document.getElementById('customThemeSwatch').style.background = hex;
    applyCustomPalette(hex);
  } else {
    document.body.style.removeProperty('--accent');
    document.body.style.removeProperty('--accent-hi');
    document.body.style.removeProperty('--accent-dim');
    document.body.style.removeProperty('--bg');
    document.body.style.removeProperty('--bg-2');
    document.body.style.removeProperty('--panel');
    document.body.style.removeProperty('--panel-2');
    document.body.style.removeProperty('--border');
    document.body.style.removeProperty('--border-hi');
  }
}

document.querySelectorAll('.theme-swatch').forEach(btn => {
  if (btn.dataset.theme === 'custom') return;
  btn.addEventListener('click', async () => {
    applyTheme(btn.dataset.theme);
    await window.api.setTheme(btn.dataset.theme);
  });
});

document.getElementById('customThemeInput').addEventListener('input', e => {
  applyTheme('custom', e.target.value);
});

document.getElementById('customThemeInput').addEventListener('change', async e => {
  await window.api.setThemeCustom(e.target.value);
});

// --- светлая/тёмная тема ---
function applyThemeMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll('.mode-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  if (document.body.dataset.theme === 'custom') {
    applyCustomPalette(document.getElementById('customThemeInput').value);
  }
}

document.querySelectorAll('.mode-swatch').forEach(btn => {
  btn.addEventListener('click', async () => {
    applyThemeMode(btn.dataset.mode);
    await window.api.setThemeMode(btn.dataset.mode);
  });
});

// --- история обновлений ---
// общий рендер списка изменений одной записи — используется и на вкладке
// "История", и в попапе "Что нового" после обновления
function changelogEntryListHtml(entry) {
  if (entry.added || entry.fixed) {
    let html = '';
    if (entry.added && entry.added.length) {
      html += `<div class="changelog-section-title">Новое</div><ul>${entry.added.map(c => `<li>${c}</li>`).join('')}</ul>`;
    }
    if (entry.fixed && entry.fixed.length) {
      html += `<div class="changelog-section-title">Исправления</div><ul>${entry.fixed.map(c => `<li>${c}</li>`).join('')}</ul>`;
    }
    return html;
  }
  // старый плоский формат, до деления на "Новое"/"Исправления"
  return `<ul>${(entry.changes || []).map(c => `<li>${c}</li>`).join('')}</ul>`;
}

// --- история обновлений ---
let changelogCache = [];
const changelogFilter = { query: '', kind: 'all' };

function changelogEntryParts(entry) {
  if (entry.added || entry.fixed) {
    return { added: entry.added || [], fixed: entry.fixed || [], other: [] };
  }
  // старый плоский формат, до деления на "Новое"/"Исправления"
  return { added: [], fixed: [], other: entry.changes || [] };
}

function renderChangelog() {
  const container = document.getElementById('changelogList');
  const counter = document.getElementById('changelogCount');
  const query = changelogFilter.query.trim().toLowerCase();
  const kind = changelogFilter.kind;
  const match = text => !query || String(text).toLowerCase().includes(query);

  const blocks = [];
  let shown = 0;

  changelogCache.forEach((entry, index) => {
    const parts = changelogEntryParts(entry);
    const added = kind === 'fixed' ? [] : parts.added.filter(match);
    const fixed = kind === 'added' ? [] : parts.fixed.filter(match);
    const other = kind === 'all' ? parts.other.filter(match) : [];
    const total = added.length + fixed.length + other.length;
    if (!total) return;
    shown += total;

    const section = (title, items, cls) => items.length
      ? `<div class="changelog-section ${cls}"><div class="changelog-section-title">${title}<span class="changelog-count">${items.length}</span></div><ul>${items.map(c => `<li>${c}</li>`).join('')}</ul></div>`
      : '';

    const isLatest = index === 0;
    const open = isLatest || query || kind !== 'all';
    blocks.push(`
      <details class="changelog-entry ${isLatest ? 'latest' : ''}" ${open ? 'open' : ''}>
        <summary>
          <span class="version">v${escHtml(entry.version)}</span>
          ${isLatest ? '<span class="chip chip-accent">Последняя</span>' : ''}
          <span class="changelog-summary-meta">${total} ${total === 1 ? 'изменение' : 'изменений'}</span>
          <span class="date">${escHtml(entry.date)}</span>
        </summary>
        <div class="changelog-body">
          ${section('Новое', added, 'is-added')}
          ${section('Исправления', fixed, 'is-fixed')}
          ${section('Изменения', other, 'is-other')}
        </div>
      </details>`);
  });

  counter.textContent = changelogCache.length
    ? `Версий: ${changelogCache.length}${query || kind !== 'all' ? `, найдено изменений: ${shown}` : ''}`
    : '';

  container.innerHTML = blocks.length
    ? blocks.join('')
    : `<div class="empty-state">${changelogCache.length ? 'Ничего не найдено. Измени запрос или фильтр.' : 'Истории пока нет.'}</div>`;
}

async function loadChangelog() {
  changelogCache = await window.api.getChangelog();
  renderChangelog();
}

(function initChangelogTab() {
  document.getElementById('changelogSearch').addEventListener('input', (e) => {
    changelogFilter.query = e.target.value;
    renderChangelog();
  });
  document.getElementById('changelogFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn) return;
    changelogFilter.kind = btn.dataset.kind;
    document.querySelectorAll('#changelogFilter button').forEach(b => b.classList.toggle('active', b === btn));
    renderChangelog();
  });
})();

// --- навигация по разделам настроек ---
(function initSettingsNav() {
  const nav = document.querySelector('.settings-nav');
  const label = document.getElementById('appVersionLabel');
  const header = document.getElementById('appVersionHeader');
  if (!nav) return;

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-target]');
    if (!btn) return;
    document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // подсветка раздела, который сейчас на экране
  const buttons = [...nav.querySelectorAll('button[data-target]')];
  const sections = buttons.map(b => document.getElementById(b.dataset.target)).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      buttons.forEach(b => b.classList.toggle('active', b.dataset.target === entry.target.id));
    });
  }, { rootMargin: '-10% 0px -75% 0px' });
  sections.forEach(sec => observer.observe(sec));

  // номер версии из раздела обновлений дублируется в заголовке страницы
  if (label && header) {
    const sync = () => { header.textContent = label.textContent; };
    new MutationObserver(sync).observe(label, { childList: true, characterData: true, subtree: true });
    sync();
  }
})();

window.api.onWhatsNew(entry => {
  const modal = document.getElementById('whatsNewModal');
  document.getElementById('whatsNewVersion').textContent = `v${entry.version}`;
  document.getElementById('whatsNewBody').innerHTML = whatsNewHtml(entry);
  modal.style.display = 'flex';
  document.getElementById('closeWhatsNewBtn').focus();
});

function whatsNewHtml(entry) {
  const parts = changelogEntryParts(entry);
  const section = (title, items, kind) => items.length
    ? `<div class="wn-section ${kind}"><div class="wn-section-title">${title}</div><ul class="wn-list">${items.map(c => `<li>${c}</li>`).join('')}</ul></div>`
    : '';
  return section('Новое', parts.added, 'is-added')
    + section('Исправления', parts.fixed, 'is-fixed')
    + section('Изменения', parts.other, 'is-added');
}

function closeWhatsNew() {
  document.getElementById('whatsNewModal').style.display = 'none';
}

document.getElementById('closeWhatsNewBtn').addEventListener('click', closeWhatsNew);
document.getElementById('whatsNewModal').addEventListener('mousedown', e => {
  if (e.target.id === 'whatsNewModal') closeWhatsNew();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('whatsNewModal').style.display !== 'none') closeWhatsNew();
});

// --- Mod Compatibility Watcher ---
window.api.onModCompatibilityUpdates(({ buildName, count, names }) => {
  const preview = (names || []).slice(0, 3).join(', ');
  showToast(`Для «${buildName}» доступны обновления модов: ${preview}${count > 3 ? ` и ещё ${count - 3}` : ''}`, 'info');
});
(function initModCompatibilityWatcher() {
  const button = document.getElementById('modCompatibilityCheckBtn');
  if (!button) return;
  const status = document.getElementById('modCompatibilityStatus');
  const results = document.getElementById('modCompatibilityResults');
  const autoCheck = document.getElementById('modCompatibilityAutoCheck');
  window.api.getModCompatibilityAutoCheck().then(enabled => { autoCheck.checked = enabled; }).catch(() => {});
  autoCheck.addEventListener('change', async () => {
    autoCheck.disabled = true;
    try { await window.api.setModCompatibilityAutoCheck(autoCheck.checked); }
    catch (error) { autoCheck.checked = !autoCheck.checked; showToast(error.message || String(error), 'error'); }
    finally { autoCheck.disabled = false; }
  });
  button.addEventListener('click', async () => {
    const { mcVersion, loader } = currentSelection();
    if (!mcVersion || !loader) { showToast('Сначала выбери сборку', 'warn'); return; }
    button.disabled = true;
    button.textContent = 'Проверяю…';
    status.textContent = `Проверяю совместимые версии для Minecraft ${mcVersion} (${loader})…`;
    results.innerHTML = '';
    try {
      const report = await window.api.watchModCompatibility(mcVersion, loader);
      const updates = report.results.filter(item => item.status === 'update');
      const incompatible = report.results.filter(item => item.status === 'incompatible');
      const errors = report.results.filter(item => item.status === 'error');
      status.textContent = `Проверено: ${report.checked}. Обновлений: ${updates.length}. Нет совместимой версии: ${incompatible.length}. Ошибок: ${errors.length}.`;
      if (!report.results.length) {
        results.innerHTML = '<div class="empty-state">В этой сборке пока нет отслеживаемых модов.</div>';
      } else {
        results.innerHTML = report.results.map(item => {
          const title = escHtml(item.title);
          if (item.status === 'update') return `<div class="mod-compat-item"><div><strong>${title}</strong><small>${escHtml(item.currentFileName || 'Текущая версия')} → ${escHtml(item.versionNumber || item.latestFileName || 'Новая версия')}</small></div><button type="button" class="primary mod-compat-update" data-project-id="${escHtml(item.projectId)}" data-title="${title}">Обновить</button></div>`;
          if (item.status === 'incompatible') return `<div class="mod-compat-item"><div><strong>${title}</strong><small>Нет совместимой версии под текущую сборку</small></div><span class="badge">Несовместим</span></div>`;
          if (item.status === 'error') return `<div class="mod-compat-item"><div><strong>${title}</strong><small>${escHtml(item.error || 'Ошибка проверки')}</small></div><span class="badge">Ошибка</span></div>`;
          return `<div class="mod-compat-item"><div><strong>${title}</strong><small>${item.status === 'unknown' ? 'Совместимая версия найдена; установленная версия не зафиксирована' : `Актуальная версия: ${escHtml(item.versionNumber || item.latestFileName || 'совместима')}`}</small></div><span class="badge">Актуально</span></div>`;
        }).join('');
      }
      if (updates.length) showToast(`Найдены обновления для ${updates.length} модов`, 'info');
      else showToast('Проверка совместимости завершена', 'success');
    } catch (error) {
      status.textContent = `Не удалось проверить обновления: ${error.message}`;
      showToast(error.message || String(error), 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Проверить обновления';
    }
  });
  results.addEventListener('click', async e => {
    const updateButton = e.target.closest('.mod-compat-update');
    if (!updateButton) return;
    const { mcVersion, loader } = currentSelection();
    const projectId = updateButton.dataset.projectId;
    const title = updateButton.dataset.title;
    updateButton.disabled = true;
    updateButton.textContent = 'Обновляю…';
    try {
      const result = await window.api.updateOneMod(mcVersion, loader, projectId, title, true);
      if (result && result.failed && result.failed.length) throw new Error(result.failed.map(item => item.reason || item.title).join('; '));
      if (result && result.ok === false) throw new Error(result.error || 'Не удалось обновить мод');
      showToast(`Мод «${title}» обновлён`, 'success');
      button.click();
    } catch (error) {
      updateButton.disabled = false;
      updateButton.textContent = 'Обновить';
      showToast(error.message || String(error), 'error');
    }
  });
})();

// --- общие помощники для вкладок «Миры» и «Скриншоты» ---
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function toFileUrl(filePath) {
  return `file://${filePath.replace(/\\/g, '/')}`;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ${window.i18n.t('ГБ')}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${window.i18n.t('МБ')}`;
}

// --- галерея скриншотов ---
let screenshotsCache = [];
let screenshotsVisible = [];
let viewerIndex = -1;
const screenshotsFilter = { query: '', instance: '', sort: 'new', favOnly: false };
let screenshotSelectMode = false;
const selectedScreenshotPaths = new Set();
let shotZoom = 1;
let shotPanX = 0;
let shotPanY = 0;
let shotDragState = null;

async function loadScreenshots() {
  screenshotsCache = await window.api.listScreenshots();
  const existingPaths = new Set(screenshotsCache.map(s => s.filePath));
  for (const filePath of selectedScreenshotPaths) if (!existingPaths.has(filePath)) selectedScreenshotPaths.delete(filePath);
  fillScreenshotInstances();
  renderScreenshots();
}

function fillScreenshotInstances() {
  const select = document.getElementById('screenshotsInstance');
  const instances = [...new Set(screenshotsCache.map(s => s.instance))].sort();
  if (screenshotsFilter.instance && !instances.includes(screenshotsFilter.instance)) screenshotsFilter.instance = '';
  select.innerHTML = '<option value="">Все сборки</option>' +
    instances.map(name => `<option value="${escHtml(name)}">${escHtml(name)}</option>`).join('');
  select.value = screenshotsFilter.instance;
}

function applyScreenshotFilters() {
  const query = screenshotsFilter.query.trim().toLowerCase();
  const list = screenshotsCache.filter(s =>
    (!query || s.fileName.toLowerCase().includes(query)) &&
    (!screenshotsFilter.instance || s.instance === screenshotsFilter.instance) &&
    (!screenshotsFilter.favOnly || s.favorite)
  );
  list.sort((a, b) => screenshotsFilter.sort === 'old' ? a.mtime - b.mtime : b.mtime - a.mtime);
  return list;
}

function renderScreenshots() {
  const grid = document.getElementById('screenshotsGrid');
  const empty = document.getElementById('screenshotsEmpty');
  const counter = document.getElementById('screenshotsCount');

  screenshotsVisible = applyScreenshotFilters();
  const favCount = screenshotsCache.filter(s => s.favorite).length;
  counter.textContent = screenshotsCache.length
    ? `Всего: ${screenshotsCache.length}, избранных: ${favCount}, показано: ${screenshotsVisible.length}`
    : '';
  document.getElementById('screenshotsSelectModeBtn').innerHTML = `<span class="ico" style="--ico-src:url('${screenshotSelectMode ? 'icons/x.svg' : 'icons/check.svg'}')" aria-hidden="true"></span>${screenshotSelectMode ? 'Отменить выбор' : 'Выбрать'}`;
  document.getElementById('screenshotsSelectAllBtn').style.display = screenshotSelectMode ? '' : 'none';
  const bulkDeleteButton = document.getElementById('screenshotsDeleteSelectedBtn');
  bulkDeleteButton.style.display = screenshotSelectMode ? '' : 'none';
  bulkDeleteButton.innerHTML = `<span class="ico" style="--ico-src:url('icons/trash.svg')" aria-hidden="true"></span>Удалить выбранные (${selectedScreenshotPaths.size})`;
  bulkDeleteButton.disabled = selectedScreenshotPaths.size === 0;

  if (!screenshotsVisible.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = screenshotsCache.length
      ? 'Ничего не найдено. Измени поиск или фильтры.'
      : 'Скриншотов пока нет. Нажми F2 в игре, и они появятся здесь.';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = screenshotsVisible.map((s, i) => `
    <div class="shot-card ${s.favorite ? 'favorite' : ''} ${selectedScreenshotPaths.has(s.filePath) ? 'selected' : ''}" data-index="${i}">
      ${screenshotSelectMode ? `<label class="shot-select"><input type="checkbox" class="shot-select-check" ${selectedScreenshotPaths.has(s.filePath) ? 'checked' : ''} aria-label="Выбрать ${escHtml(s.fileName)}"></label>` : ''}
      <img class="shot-img" src="${toFileUrl(s.filePath)}" loading="lazy" alt="">
      <div class="shot-actions">
        <button class="shot-btn shot-fav ${s.favorite ? 'on' : ''}" title="${s.favorite ? 'Убрать из избранного' : 'В избранное'}"><span class="mask-ico" style="--ico-src:url('icons/star.svg')"></span></button>
        <button class="shot-btn shot-del" title="Удалить"><span class="mask-ico" style="--ico-src:url('icons/x.svg')"></span></button>
      </div>
      <div class="shot-meta">
        <div class="shot-name" title="${escHtml(s.fileName)}">${escHtml(s.fileName)}</div>
        <div class="shot-sub">${escHtml(s.instance)} · ${new Date(s.mtime).toLocaleDateString(window.i18n.locale)}</div>
      </div>
    </div>
  `).join('');
}

async function toggleShotFavorite(shot) {
  await window.api.toggleFavoriteScreenshot(shot.filePath);
  await loadScreenshots();
}

async function deleteShot(shot) {
  if (!await customConfirm(`Удалить ${shot.fileName}?`)) return false;
  await window.api.deleteScreenshot(shot.filePath);
  await loadScreenshots();
  return true;
}

// просмотр на весь экран
function openShotViewer(index) {
  if (index < 0 || index >= screenshotsVisible.length) return;
  viewerIndex = index;
  const shot = screenshotsVisible[index];
  shotZoom = 1;
  shotPanX = 0;
  shotPanY = 0;
  shotDragState = null;
  const viewerImg = document.getElementById('shotViewerImg');
  viewerImg.classList.remove('is-zoomed', 'is-panning');
  viewerImg.src = toFileUrl(shot.filePath);
  viewerImg.style.transform = 'translate(-50%, -50%) scale(1)';
  document.getElementById('shotZoomValue').textContent = '100%';
  document.getElementById('shotViewerName').textContent = `${shot.fileName} (${index + 1} из ${screenshotsVisible.length})`;
  document.getElementById('shotViewerFav').textContent = shot.favorite ? 'Убрать из избранного' : 'В избранное';
  document.getElementById('shotViewerPrev').style.visibility = index > 0 ? 'visible' : 'hidden';
  document.getElementById('shotViewerNext').style.visibility = index < screenshotsVisible.length - 1 ? 'visible' : 'hidden';
  document.getElementById('shotViewer').style.display = 'flex';
}

function closeShotViewer() {
  document.getElementById('shotViewer').style.display = 'none';
  document.getElementById('shotViewerImg').removeAttribute('src');
  shotZoom = 1;
  shotPanX = 0;
  shotPanY = 0;
  shotDragState = null;
  const img = document.getElementById('shotViewerImg');
  img.classList.remove('is-zoomed', 'is-panning');
  img.style.transform = 'translate(-50%, -50%) scale(1)';
  document.getElementById('shotZoomValue').textContent = '100%';
  viewerIndex = -1;
}

(function initScreenshotsTab() {
  const grid = document.getElementById('screenshotsGrid');

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.shot-card');
    if (!card) return;
    const shot = screenshotsVisible[Number(card.dataset.index)];
    if (!shot) return;

    if (e.target.closest('.shot-select')) return;
    if (screenshotSelectMode) { const check = card.querySelector('.shot-select-check'); if (check) { check.checked = !check.checked; check.dispatchEvent(new Event('change', { bubbles: true })); } return; }
    if (e.target.closest('.shot-fav')) { await toggleShotFavorite(shot); return; }
    if (e.target.closest('.shot-del')) { await deleteShot(shot); return; }
    openShotViewer(Number(card.dataset.index));
  });
  grid.addEventListener('change', e => {
    if (!e.target.matches('.shot-select-check')) return;
    const card = e.target.closest('.shot-card');
    const shot = card && screenshotsVisible[Number(card.dataset.index)];
    if (!shot) return;
    if (e.target.checked) selectedScreenshotPaths.add(shot.filePath); else selectedScreenshotPaths.delete(shot.filePath);
    card.classList.toggle('selected', e.target.checked);
    const count = selectedScreenshotPaths.size;
    const bulk = document.getElementById('screenshotsDeleteSelectedBtn');
    bulk.innerHTML = `<span class="ico" style="--ico-src:url('icons/trash.svg')" aria-hidden="true"></span>Удалить выбранные (${count})`; bulk.disabled = count === 0;
  });

  document.getElementById('screenshotsSelectModeBtn').addEventListener('click', () => {
    screenshotSelectMode = !screenshotSelectMode;
    if (!screenshotSelectMode) selectedScreenshotPaths.clear();
    renderScreenshots();
  });
  document.getElementById('screenshotsSelectAllBtn').addEventListener('click', () => {
    const allVisibleSelected = screenshotsVisible.every(s => selectedScreenshotPaths.has(s.filePath));
    screenshotsVisible.forEach(s => allVisibleSelected ? selectedScreenshotPaths.delete(s.filePath) : selectedScreenshotPaths.add(s.filePath));
    renderScreenshots();
  });
  document.getElementById('screenshotsDeleteSelectedBtn').addEventListener('click', async () => {
    const paths = [...selectedScreenshotPaths];
    if (!paths.length) return;
    if (!await customConfirm(`Удалить выбранные скриншоты (${paths.length})?`)) return;
    let deleted = 0;
    for (const filePath of paths) {
      try { await window.api.deleteScreenshot(filePath); deleted++; } catch (err) { console.error('Screenshot delete failed', err); }
    }
    selectedScreenshotPaths.clear();
    await loadScreenshots();
    showToast(`Удалено скриншотов: ${deleted}`, deleted === paths.length ? 'success' : 'warn');
  });

  document.getElementById('screenshotsSearch').addEventListener('input', (e) => {
    screenshotsFilter.query = e.target.value;
    renderScreenshots();
  });
  document.getElementById('screenshotsInstance').addEventListener('change', (e) => {
    screenshotsFilter.instance = e.target.value;
    renderScreenshots();
  });
  document.getElementById('screenshotsSort').addEventListener('change', (e) => {
    screenshotsFilter.sort = e.target.value;
    renderScreenshots();
  });
  const favBtn = document.getElementById('screenshotsFavOnly');
  favBtn.addEventListener('click', () => {
    screenshotsFilter.favOnly = !screenshotsFilter.favOnly;
    favBtn.classList.toggle('active', screenshotsFilter.favOnly);
    favBtn.setAttribute('aria-pressed', String(screenshotsFilter.favOnly));
    renderScreenshots();
  });
  document.getElementById('refreshScreenshotsBtn').addEventListener('click', loadScreenshots);

  // просмотрщик
  const viewer = document.getElementById('shotViewer');
  document.getElementById('shotViewerClose').addEventListener('click', closeShotViewer);
  const viewerImg = document.getElementById('shotViewerImg');
  const clampShotPan = () => {
    const frame = viewer.getBoundingClientRect();
    const maxX = Math.max(0, (viewerImg.offsetWidth * shotZoom - frame.width) / 2);
    const maxY = Math.max(0, (viewerImg.offsetHeight * shotZoom - frame.height) / 2);
    shotPanX = Math.max(-maxX, Math.min(maxX, shotPanX));
    shotPanY = Math.max(-maxY, Math.min(maxY, shotPanY));
  };
  const renderShotTransform = () => {
    clampShotPan();
    viewerImg.style.transform = `translate(calc(-50% + ${shotPanX}px), calc(-50% + ${shotPanY}px)) scale(${shotZoom})`;
    viewerImg.classList.toggle('is-zoomed', shotZoom > 1);
    document.getElementById('shotZoomValue').textContent = `${Math.round(shotZoom * 100)}%`;
  };
  const applyShotZoom = value => {
    shotZoom = Math.max(1, Math.min(4, Math.round(value * 10) / 10));
    if (shotZoom === 1) { shotPanX = 0; shotPanY = 0; }
    renderShotTransform();
  };
  document.getElementById('shotZoomIn').addEventListener('click', () => applyShotZoom(shotZoom + 0.25));
  document.getElementById('shotZoomOut').addEventListener('click', () => applyShotZoom(shotZoom - 0.25));
  document.getElementById('shotZoomReset').addEventListener('click', () => applyShotZoom(1));

  // Drag the enlarged screenshot with a mouse, pen or touch pointer.
  viewerImg.addEventListener('load', renderShotTransform);
  viewerImg.addEventListener('pointerdown', e => {
    if (shotZoom <= 1 || e.button !== 0) return;
    e.preventDefault();
    shotDragState = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: shotPanX, panY: shotPanY };
    viewerImg.setPointerCapture(e.pointerId);
    viewerImg.classList.add('is-panning');
  });
  viewerImg.addEventListener('pointermove', e => {
    if (!shotDragState || shotDragState.id !== e.pointerId) return;
    shotPanX = shotDragState.panX + e.clientX - shotDragState.x;
    shotPanY = shotDragState.panY + e.clientY - shotDragState.y;
    renderShotTransform();
  });
  const stopShotDrag = e => {
    if (!shotDragState || (e && shotDragState.id !== e.pointerId)) return;
    shotDragState = null;
    viewerImg.classList.remove('is-panning');
  };
  viewerImg.addEventListener('pointerup', stopShotDrag);
  viewerImg.addEventListener('pointercancel', stopShotDrag);
  viewerImg.addEventListener('lostpointercapture', stopShotDrag);
  viewer.addEventListener('wheel', e => {
    if (e.target.closest('.shot-zoom-controls')) return;
    e.preventDefault();
    applyShotZoom(shotZoom + (e.deltaY < 0 ? 0.15 : -0.15));
  }, { passive: false });
  viewerImg.addEventListener('dblclick', e => {
    e.preventDefault();
    applyShotZoom(shotZoom > 1 ? 1 : 2);
  });
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeShotViewer(); });
  document.getElementById('shotViewerPrev').addEventListener('click', () => openShotViewer(viewerIndex - 1));
  document.getElementById('shotViewerNext').addEventListener('click', () => openShotViewer(viewerIndex + 1));
  document.getElementById('shotViewerOpen').addEventListener('click', () => {
    const shot = screenshotsVisible[viewerIndex];
    if (shot) window.api.openScreenshot(shot.filePath);
  });
  document.getElementById('shotViewerFolder').addEventListener('click', () => {
    const shot = screenshotsVisible[viewerIndex];
    if (shot) window.api.openScreenshotFolder(shot.filePath);
  });
  document.getElementById('shotViewerFav').addEventListener('click', async () => {
    const shot = screenshotsVisible[viewerIndex];
    if (!shot) return;
    const fileName = shot.filePath;
    await toggleShotFavorite(shot);
    const next = screenshotsVisible.findIndex(s => s.filePath === fileName);
    if (next >= 0) openShotViewer(next); else closeShotViewer();
  });
  document.getElementById('shotViewerDelete').addEventListener('click', async () => {
    const shot = screenshotsVisible[viewerIndex];
    if (!shot) return;
    const index = viewerIndex;
    if (await deleteShot(shot)) {
      if (screenshotsVisible.length) openShotViewer(Math.min(index, screenshotsVisible.length - 1));
      else closeShotViewer();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (viewerIndex < 0) return;
    if (e.key === 'Escape') closeShotViewer();
    else if (e.key === 'ArrowLeft') openShotViewer(viewerIndex - 1);
    else if (e.key === 'ArrowRight') openShotViewer(viewerIndex + 1);
    else if (e.key === '+' || e.key === '=') applyShotZoom(shotZoom + 0.25);
    else if (e.key === '-') applyShotZoom(shotZoom - 0.25);
    else if (e.key === '0') applyShotZoom(1);
  });
})();

// --- серверы (servers.dat) ---

let serversCache = [];
let serversPingRun = 0;

async function loadServers() {
  const { mcVersion, loader } = currentSelection();
  if (!mcVersion) {
    serversCache = [];
    renderServers();
    return;
  }
  try {
    serversCache = await window.api.listServers(mcVersion, loader);
    serversCache = await Promise.all(serversCache.map(async server => ({
      ...server,
      preset: await window.api.getServerPreset(mcVersion, loader, server.ip).catch(() => null)
    })));
  } catch (err) {
    serversCache = [];
    showToast(`Не удалось прочитать список серверов: ${err.message}`, 'error');
  }
  renderServers();
}

function renderServers() {
  const list = document.getElementById('serversList');
  const empty = document.getElementById('serversEmpty');
  const run = ++serversPingRun;
  empty.style.display = serversCache.length ? 'none' : 'block';
  list.innerHTML = serversCache.map((s, i) => `
    <div class="srv-card" data-index="${i}">
      <div class="srv-avatar" aria-hidden="true"><span class="srv-avatar-fallback">${escHtml((s.name || s.ip || '?').slice(0, 1).toUpperCase())}</span></div>
      <span class="srv-dot" aria-hidden="true"></span>
      <div class="srv-main">
        <div class="srv-name">${escHtml(s.name || s.ip)}</div>
        <div class="srv-ip">${escHtml(s.ip)}</div>
        <div class="srv-motd"></div>
        <div class="srv-preset-status">${s.preset ? `Пресет: ${escHtml(s.preset.name)}` : 'Пресет запуска не задан'}</div>
      </div>
      <div class="srv-stat">Проверяю...</div>
      <div class="srv-actions">
        <button class="srv-play-btn primary" title="Запустить игру и сразу зайти на этот сервер">Играть</button>
        <button class="srv-preset-save-btn">${s.preset ? 'Обновить пресет' : 'Сохранить пресет'}</button>
        ${s.preset ? '<button class="srv-preset-apply-btn">Применить</button><button class="srv-preset-delete-btn">Удалить пресет</button>' : ''}
        <button class="srv-edit-btn">Изменить</button>
        <button class="srv-delete-btn">Удалить сервер</button>
      </div>
    </div>`).join('');

  serversCache.forEach((s, i) => {
    const card = list.querySelector(`.srv-card[data-index="${i}"]`);
    window.api.pingServer(s.ip).then(info => {
      if (run !== serversPingRun) return;
      card.classList.add('online');
      const avatar = card.querySelector('.srv-avatar');
      if (info.favicon && avatar) avatar.innerHTML = `<img src="${info.favicon}" alt="" draggable="false"><span class="srv-avatar-fallback">${escHtml((s.name || s.ip || '?').slice(0, 1).toUpperCase())}</span>`;
      const players = info.online !== null ? `${info.online} / ${info.max}` : 'онлайн';
      card.querySelector('.srv-stat').textContent = `${players} · ${info.latencyMs} мс`;
      card.querySelector('.srv-motd').textContent = info.motd || '';
    }).catch(() => {
      if (run !== serversPingRun) return;
      card.classList.add('offline');
      card.querySelector('.srv-stat').textContent = 'Не отвечает';
    });
  });
}

async function askServerFields(current) {
  const name = await askForText('Название сервера:', current ? current.name : '');
  if (name === null) return null;
  const ip = await askForText('Адрес сервера (например, play.example.com или 1.2.3.4:25566):', current ? current.ip : '');
  if (ip === null) return null;
  return { name: name.trim(), ip: ip.trim() };
}

(function initServers() {
  document.getElementById('addServerBtn').addEventListener('click', async () => {
    const { mcVersion, loader } = currentSelection();
    if (!mcVersion) {
      showToast('Сначала выбери версию на вкладке «Главная»', 'warn');
      return;
    }
    const fields = await askServerFields(null);
    if (!fields) return;
    try {
      serversCache = await window.api.addServer(mcVersion, loader, fields.name, fields.ip);
      renderServers();
      showToast('Сервер добавлен', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('serversList').addEventListener('click', async e => {
    const card = e.target.closest('.srv-card');
    const btn = e.target.closest('button');
    if (!card || !btn) return;
    const index = Number(card.dataset.index);
    const server = serversCache[index];
    if (!server) return;
    const { mcVersion, loader } = currentSelection();

    if (btn.classList.contains('srv-preset-save-btn')) {
      const name = await askForText('Название пресета для сервера:', server.preset?.name || `${server.name || server.ip} — запуск`);
      if (!name) return;
      try {
        const current = await window.api.getLaunchSettings(mcVersion, loader);
        await window.api.saveServerPreset(mcVersion, loader, server.ip, name, current.settings);
        await loadServers();
        showToast('Пресет сервера сохранён', 'success');
      } catch (err) { showToast(err.message || String(err), 'error'); }
      return;
    }

    if (btn.classList.contains('srv-preset-apply-btn')) {
      if (!server.preset) return;
      try {
        const saved = await window.api.setLaunchSettings(mcVersion, loader, server.preset.settings);
        if (window.fcLaunchSettings?.reload) await window.fcLaunchSettings.reload();
        showToast(`Пресет «${server.preset.name}» применён`, 'success');
      } catch (err) { showToast(err.message || String(err), 'error'); }
      return;
    }

    if (btn.classList.contains('srv-preset-delete-btn')) {
      if (!(await customConfirm(`Удалить пресет для «${server.name || server.ip}»?`))) return;
      await window.api.deleteServerPreset(mcVersion, loader, server.ip);
      await loadServers();
      showToast('Пресет сервера удалён', 'info');
      return;
    }

    if (btn.classList.contains('srv-play-btn')) {
      if (playBtn.disabled) {
        showToast('Игра уже запускается', 'warn');
        return;
      }
      if (server.preset) {
        try {
          await window.api.setLaunchSettings(mcVersion, loader, server.preset.settings);
        } catch (err) {
          showToast(`Не удалось применить пресет сервера: ${err.message || err}`, 'error');
          return;
        }
      }
      pendingQuickPlay = { type: 'server', value: server.ip, label: server.name || server.ip };
      switchTab('play');
      playBtn.click();
      return;
    }

    try {
      if (btn.classList.contains('srv-edit-btn')) {
        const fields = await askServerFields(server);
        if (!fields) return;
        serversCache = await window.api.editServer(mcVersion, loader, index, fields.name, fields.ip);
        renderServers();
        return;
      }
      if (btn.classList.contains('srv-delete-btn')) {
        if (!(await customConfirm(`Удалить сервер «${server.name || server.ip}» из списка?`))) return;
        serversCache = await window.api.removeServer(mcVersion, loader, index);
        renderServers();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
})();

// --- миры (saves) ---
let worldsCache = [];
let worldsVisible = [];
const worldsFilter = { query: '', sort: 'played' };

const GAME_MODE_ICONS = { 'Творческий': '🛠️', 'Выживание': '⚔️', 'Приключение': '🧭', 'Наблюдатель': '👁️' };

async function loadWorlds() {
  const { mcVersion, loader } = currentSelection();
  const list = document.getElementById('worldsList');
  document.getElementById('worldsEmpty').style.display = 'none';
  list.innerHTML = '<div class="desc">Загружаю...</div>';
  const badge = document.getElementById('worldsCurrentTarget');
  badge.innerHTML = mcVersion
    ? `Сейчас выбрано: <b>${escHtml(mcVersion)}</b> · <b>${escHtml(loader)}</b>`
    : 'Версия не выбрана. Зайди на вкладку «Главная»';
  loadServers();
  try {
    worldsCache = await window.api.listWorlds(mcVersion, loader);
    renderWorlds();
  } catch (err) {
    list.innerHTML = `<div class="desc">Не удалось прочитать миры: ${escHtml(err.message)}</div>`;
  }
}

function renderWorlds() {
  const list = document.getElementById('worldsList');
  const empty = document.getElementById('worldsEmpty');
  const summary = document.getElementById('worldsSummary');

  const query = worldsFilter.query.trim().toLowerCase();
  worldsVisible = worldsCache.filter(w => !query ||
    w.displayName.toLowerCase().includes(query) || w.folderName.toLowerCase().includes(query));
  worldsVisible.sort((a, b) => {
    if (worldsFilter.sort === 'name') return a.displayName.localeCompare(b.displayName, 'ru');
    if (worldsFilter.sort === 'size') return b.sizeBytes - a.sizeBytes;
    return b.lastPlayed - a.lastPlayed;
  });

  const totalBytes = worldsCache.reduce((sum, w) => sum + (w.sizeBytes || 0), 0);
  summary.textContent = worldsCache.length
    ? `Миров: ${worldsCache.length}, занимают ${formatSize(totalBytes)}${query ? `, найдено: ${worldsVisible.length}` : ''}`
    : '';

  if (!worldsVisible.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = worldsCache.length
      ? 'Ничего не найдено. Измени запрос.'
      : 'Миров пока нет. Создай мир в игре, и он появится здесь.';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = worldsVisible.map((w, i) => {
    const preview = w.iconPath
      ? `<img class="world-icon" src="${toFileUrl(w.iconPath)}" loading="lazy" alt="">`
      : `<div class="world-icon placeholder">${escHtml((w.displayName || '?').trim().charAt(0).toUpperCase() || '?')}</div>`;

    const chips = [
      w.gameMode ? `${GAME_MODE_ICONS[w.gameMode] || ''} ${escHtml(w.gameMode)}${w.hardcore ? ' (хардкор)' : ''}` : null,
      w.difficulty ? escHtml(w.difficulty) : null,
      w.versionName ? escHtml(w.versionName) : null
    ].filter(Boolean).map(text => `<span class="chip">${text}</span>`).join('');

    return `
      <div class="world-card" data-index="${i}">
        <div class="world-preview">${preview}</div>
        <div class="world-body">
          <div class="world-title" title="${escHtml(w.folderName)}">${escHtml(w.displayName)}</div>
          <div class="world-chips">${chips}</div>
          <div class="world-stats">
            <span>${new Date(w.lastPlayed).toLocaleString(window.i18n.locale, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span>${formatSize(w.sizeBytes)}</span>
          </div>
        </div>
        <div class="world-actions">
          <button class="world-play-btn primary" title="Запустить игру и сразу зайти в этот мир"><span class="ico" style="--ico-src:url('icons/play-fill.svg')" aria-hidden="true"></span>Играть</button>
          <button class="world-rename-btn" title="Переименовать"><span class="ico" style="--ico-src:url('icons/pen.svg')" aria-hidden="true"></span>Переименовать</button>
          <button class="world-folder-btn" title="Открыть папку мира"><span class="ico" style="--ico-src:url('icons/folder.svg')" aria-hidden="true"></span>Папка</button>
          <button class="world-delete-btn" title="Удалить мир"><span class="ico" style="--ico-src:url('icons/trash.svg')" aria-hidden="true"></span>Удалить</button>
        </div>
      </div>`;
  }).join('');
}

(function initWorldsTab() {
  const list = document.getElementById('worldsList');

  list.addEventListener('click', async (e) => {
    const card = e.target.closest('.world-card');
    const btn = e.target.closest('button');
    if (!card || !btn) return;
    const world = worldsVisible[Number(card.dataset.index)];
    if (!world) return;
    const { mcVersion, loader } = currentSelection();

    if (btn.classList.contains('world-play-btn')) {
      if (playBtn.disabled) {
        showToast('Игра уже запускается', 'warn');
        return;
      }
      pendingQuickPlay = { type: 'world', value: world.folderName, label: world.displayName };
      switchTab('play');
      playBtn.click();
      return;
    }

    if (btn.classList.contains('world-folder-btn')) {
      window.api.openWorldFolder(mcVersion, loader, world.folderName);
      return;
    }

    if (btn.classList.contains('world-rename-btn')) {
      const newName = await askForText('Новое название мира:', world.displayName);
      if (newName === null || !newName.trim() || newName.trim() === world.displayName) return;
      try {
        await window.api.renameWorld(mcVersion, loader, world.folderName, newName.trim());
        showToast('Мир переименован', 'success');
        await loadWorlds();
      } catch (err) {
        showToast(err.message, 'error');
      }
      return;
    }

    if (btn.classList.contains('world-delete-btn')) {
      const confirmed = await customConfirm(`Удалить мир «${world.displayName}»?\n\nПеред удалением лаунчер сохранит его zip-копию в папку бэкапов. Если что, оттуда можно будет вернуть.`);
      if (!confirmed) return;

      btn.disabled = true;
      btn.textContent = 'Удаляю...';
      try {
        await window.api.deleteWorld(mcVersion, loader, world.folderName);
        showToast('Мир удалён, копия сохранена в бэкапах', 'success');
        await loadWorlds();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Удалить';
      }
    }
  });

  document.getElementById('worldsSearch').addEventListener('input', (e) => {
    worldsFilter.query = e.target.value;
    renderWorlds();
  });
  document.getElementById('worldsSort').addEventListener('change', (e) => {
    worldsFilter.sort = e.target.value;
    renderWorlds();
  });
  document.getElementById('refreshWorldsBtn').addEventListener('click', loadWorlds);
  document.getElementById('openSavesFolderBtn').addEventListener('click', () => {
    const { mcVersion, loader } = currentSelection();
    window.api.openFolder(mcVersion, loader, 'saves');
  });
})();

// --- автообновление лаунчера ---
async function loadAppVersion() {
  const label = document.getElementById('appVersionLabel');
  if (!label) return;
  const version = await window.api.getAppVersion();
  label.textContent = `v${version}`;
}

// --- язык интерфейса ---
const languageSelect = document.getElementById('languageSelect');
languageSelect.value = window.i18n.lang;
languageSelect.addEventListener('change', async () => {
  window.i18n.setLanguage(languageSelect.value);
  try { await window.api.setLanguage(languageSelect.value); } catch { /* язык всё равно сохранён локально */ }
  location.reload();
});

// после импорта настроек (или очистки данных окна) язык в конфиге мог разойтись с локальным
window.api.getSettings().then(settings => {
  if (settings.language && settings.language !== window.i18n.lang) {
    window.i18n.setLanguage(settings.language);
    location.reload();
  }
}).catch(() => {});

// --- перенос настроек лаунчера ---
document.getElementById('exportSettingsBtn').addEventListener('click', async () => {
  try {
    const res = await window.api.exportSettings();
    if (res.ok) showToast(`Настройки сохранены (${res.count} шт.)`, 'success');
  } catch (err) {
    showToast(`Не удалось сохранить настройки: ${ipcMessage(err)}`, 'error');
  }
});

document.getElementById('importSettingsBtn').addEventListener('click', async () => {
  try {
    const res = await window.api.importSettings();
    if (!res.ok) return;
    const skipped = res.skipped.length
      ? ` Пропущено: ${res.skipped.map(s => `${s.key} (${s.reason})`).join(', ')}.`
      : '';
    if (await customConfirm(`Импортировано настроек: ${res.applied}.${skipped} Перезапустить лаунчер, чтобы применить?`)) {
      await window.api.relaunchApp();
    }
  } catch (err) {
    showToast(`Не удалось импортировать настройки: ${ipcMessage(err)}`, 'error');
  }
});

document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('checkUpdatesBtn');
  btn.disabled = true;
  btn.textContent = 'Проверка...';
  const result = await window.api.checkForUpdates();
  btn.disabled = false;
  btn.textContent = 'Проверить обновления';
  if (!result.ok) {
    showToast(`Не удалось проверить обновления: ${result.error}`, 'error');
  }
  // Если обновление есть — оно само скачается в фоне, без окон и вопросов,
  // а по готовности вылезет своя модалка (см. showUpdateReadyModal).
});

window.api.onUpdateProgress(({ percent }) => {
  const row = document.getElementById('updateProgressRow');
  const bar = document.getElementById('updateProgressBar');
  const label = document.getElementById('updateProgressLabel');
  row.style.display = 'flex';
  bar.value = Math.round(percent);
  label.textContent = `Загрузка обновления... ${Math.round(percent)}%`;

  const widget = document.getElementById('updateMiniWidget');
  const fill = document.getElementById('updateMiniFill');
  const percentEl = document.getElementById('updateMiniPercent');
  widget.style.display = 'block';
  fill.style.width = `${Math.round(percent)}%`;
  percentEl.textContent = `${Math.round(percent)}%`;
});

window.api.onUpdateStatus(({ state, message, version }) => {
  const row = document.getElementById('updateProgressRow');
  const label = document.getElementById('updateProgressLabel');
  const widget = document.getElementById('updateMiniWidget');
  const miniLabel = document.getElementById('updateMiniLabel');

  if (state === 'downloading') {
    playNotificationSound('update');
    row.style.display = 'flex';
    label.textContent = 'Загрузка обновления...';
    widget.style.display = 'block';
    miniLabel.textContent = 'Загрузка обновления...';
  } else if (state === 'downloaded') {
    label.textContent = 'Обновление скачано, готово к установке';
    widget.style.display = 'none';
    showUpdateReadyModal(version);
  } else if (state === 'error') {
    label.textContent = `Ошибка обновления: ${message}`;
    widget.style.display = 'none';
  }
});

// обновление скачалось само в фоне, без единого системного окна — теперь
// просто спрашиваем внутри своего интерфейса, ставить сейчас или потом
function showUpdateReadyModal(version) {
  const modal = document.getElementById('updateReadyModal');
  const text = document.getElementById('updateReadyText');
  const installBtn = document.getElementById('updateReadyInstall');
  const laterBtn = document.getElementById('updateReadyLater');

  text.textContent = version
    ? `Версия ${version} уже скачана. Перезапустить лаунчер и поставить её сейчас?`
    : 'Новая версия уже скачана. Перезапустить лаунчер и поставить её сейчас?';
  modal.style.display = 'flex';

  installBtn.onclick = () => window.api.installUpdateNow();
  laterBtn.onclick = () => {
    modal.style.display = 'none';
    showToast('Обновление установится при следующем закрытии лаунчера', 'info');
  };
}

// выбор конкретной версии мода/ресурспака вручную — как на самом Modrinth,
// а не просто "последняя совместимая"
async function openVersionPicker({ projectId, title, icon, loader, kind }) {
  const modal = document.getElementById('versionPickerModal');
  const list = document.getElementById('versionPickerList');
  const titleEl = document.getElementById('versionPickerTitle');
  const cancelBtn = document.getElementById('versionPickerCancel');

  titleEl.textContent = `Выбор версии: ${title}`;
  list.innerHTML = '<div class="desc">Загружаю список версий...</div>';
  modal.style.display = 'flex';
  cancelBtn.onclick = () => { modal.style.display = 'none'; };

  const result = kind === 'mod'
    ? await window.api.listModVersions(projectId, loader)
    : await window.api.listResourcePackVersions(projectId);

  if (!result.ok) {
    list.innerHTML = `<div class="desc">Не удалось загрузить версии: ${escHtml(result.error)}</div>`;
    return;
  }
  if (!result.versions.length) {
    list.innerHTML = '<div class="desc">Версий не найдено</div>';
    return;
  }

  list.innerHTML = result.versions.map(v => `
    <div class="version-row" data-version-id="${escHtml(v.versionId)}">
      <div>
        <div class="version-row-number">${escHtml(v.versionNumber)}${v.name ? ` — ${escHtml(v.name)}` : ''}</div>
        <div class="version-row-meta">${escHtml((v.gameVersions || []).join(', '))} · ${v.datePublished ? new Date(v.datePublished).toLocaleDateString() : ''}</div>
      </div>
      <button class="version-row-install">Установить</button>
    </div>
  `).join('');

  list.querySelectorAll('.version-row-install').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.version-row');
      const versionId = row.dataset.versionId;
      const { mcVersion, loader: currentLoader } = currentSelection();
      btn.disabled = true;
      btn.textContent = 'Ставлю...';

      try {
        let installDeps = false;
        if (kind === 'mod') {
          const deps = await window.api.getModVersionDependencies(versionId, mcVersion, currentLoader);
          if (deps.length) {
            const choice = await customChoice(
              `Эта версия «${title}» требует обязательные зависимости: ${deps.map(d => d.title).join(', ')}.\nСкачать их вместе с модом?`,
              { primaryLabel: 'Скачать с зависимостями', altLabel: 'Только мод' }
            );
            if (!choice) {
              btn.disabled = false;
              btn.textContent = 'Установить';
              return;
            }
            installDeps = choice === 'primary';
          }
        }
        const res = kind === 'mod'
          ? await window.api.addModSpecificVersion(mcVersion, currentLoader, projectId, title, icon, versionId, installDeps)
          : await window.api.addResourcePackSpecificVersion(mcVersion, currentLoader, projectId, title, icon, versionId);

        if (!res.ok) throw new Error(res.error);

        const depsNote = res.installedDeps && res.installedDeps.length ? ` (+${res.installedDeps.length} завис.)` : '';
        showToast(`«${title}» установлен (версия ${res.versionNumber})${depsNote}`, 'success');
        if (res.failedDeps && res.failedDeps.length) showToast(`Не скачались зависимости: ${res.failedDeps.map(f => f.title).join(', ')}`, 'error');
        modal.style.display = 'none';
        if (kind === 'mod') {
          await renderWantedList();
          await renderInstalledMods();
        } else {
          await renderResourcePackList();
          await renderInstalledResourcePacks();
        }
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Установить';
      }
    });
  });
}

// фоновая ошибка где-то в главном процессе — раньше такое молча роняло весь лаунчер,
// теперь просто показываем тост, приложение продолжает работать
window.api.onAppError(({ message }) => {
  showToast(message, 'error', 'Внутренняя ошибка');
});

// --- онбординг-тур ---
const tourSteps = [
  {
    tab: 'play',
    target: 'nav',
    title: 'Добро пожаловать!',
    text: 'Слева разделы лаунчера: Главная, Сборки, Контент (моды, ресурспаки, шейдеры), Миры, Скриншоты, Настройки и История. Пройдёмся по главному.'
  },
  {
    tab: 'play',
    target: '.build-controls',
    title: 'Версия игры',
    text: 'Здесь выбираешь версию Minecraft и загрузчик модов (Fabric, Forge, NeoForge или Vanilla). Выбор используется во всех разделах контента.'
  },
  {
    tab: 'play',
    target: '#playBtn',
    title: 'Запуск игры',
    text: 'Когда версия выбрана, жми сюда. Лаунчер сам скачает всё необходимое перед первым запуском.'
  },
  {
    tab: 'builds',
    target: '#buildCreateBtn',
    title: 'Сборки',
    text: 'Сборка это отдельная копия игры со своими модами, ресурспаками, шейдерами, мирами и настройками. Создай сборку для выживания, другую для PvP, и они не перемешаются. Можно импортировать .mrpack.'
  },
  {
    tab: 'play',
    target: '.account-box',
    title: 'Аккаунты',
    text: 'Тут управляешь аккаунтами. Можно добавить несколько (Ely.by, Microsoft, офлайн-ник) и переключаться между ними.'
  },
  {
    tab: 'mods',
    target: '#contentSwitch',
    title: 'Контент в одном месте',
    text: 'Моды, ресурспаки и шейдеры теперь на одной вкладке. Переключай разделы кнопками сверху, значок показывает, где есть обновления.'
  },
  {
    tab: 'mods',
    target: '#modSearch',
    title: 'Поиск модов',
    text: 'Ищи моды на Modrinth и жми "Добавить". Они попадут в список выбранных справа.'
  },
  {
    tab: 'mods',
    target: '#reinstallBtn',
    title: 'Установка модов',
    text: 'Когда список выбранных модов готов, жми "Переустановить моды под версию", чтобы всё скачать.'
  },
  {
    tab: 'mods',
    target: '#installedModsFilter',
    title: 'Установленные файлы',
    text: 'Тут уже скачанные файлы модов. Их можно включать и выключать без удаления, фильтровать и сортировать. Ещё сюда можно перетащить .jar или .zip файл.'
  },
  {
    tab: 'settings',
    target: '#tab-settings .settings-group',
    title: 'Настройки',
    text: 'Здесь Java, память, тема оформления, аргументы JVM и размер окна лаунчера. Это обучение всегда можно открыть заново отсюда, в самом низу.'
  }
];

let tourIndex = 0;

function renderTourStep() {
  const step = tourSteps[tourIndex];
  switchTab(step.tab);

  document.getElementById('tourStepCounter').textContent = `Шаг ${tourIndex + 1} из ${tourSteps.length}`;
  document.getElementById('tourTitle').textContent = step.title;
  document.getElementById('tourText').textContent = step.text;
  document.getElementById('tourBackBtn').style.visibility = tourIndex === 0 ? 'hidden' : 'visible';
  document.getElementById('tourNextBtn').textContent = tourIndex === tourSteps.length - 1 ? 'Готово' : 'Далее';

  // ждём кадр, чтобы вкладка успела отрисоваться, прежде чем мерить позицию элемента
  requestAnimationFrame(() => positionTourStep(step));
}

function positionTourStep(step) {
  const target = document.querySelector(step.target);
  const highlight = document.getElementById('tourHighlight');
  const tooltip = document.getElementById('tourTooltip');

  if (!target) {
    highlight.style.display = 'none';
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
    return;
  }

  // подтягиваем элемент в видимую часть окна — иначе на маленьком окне
  // подсказка может посчитаться от элемента, который сейчас ниже экрана
  target.scrollIntoView({ block: 'center', inline: 'nearest' });

  const rect = target.getBoundingClientRect();
  const pad = 6;

  highlight.style.display = 'block';
  highlight.style.top = `${rect.top - pad}px`;
  highlight.style.left = `${rect.left - pad}px`;
  highlight.style.width = `${rect.width + pad * 2}px`;
  highlight.style.height = `${rect.height + pad * 2}px`;

  const tooltipWidth = 280;
  const tooltipHeight = tooltip.offsetHeight || 160;
  let left = rect.left;
  let top = rect.bottom + 16;

  if (left + tooltipWidth > window.innerWidth - 16) left = window.innerWidth - tooltipWidth - 16;
  if (left < 16) left = 16;

  if (top + tooltipHeight > window.innerHeight - 16) top = rect.top - tooltipHeight - 16;

  // жёсткая граница: подсказка обязана целиком помещаться в окно,
  // даже если элемент огромный или окно совсем маленькое
  top = Math.min(top, window.innerHeight - tooltipHeight - 16);
  top = Math.max(top, 16);

  tooltip.style.transform = 'none';
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function startTour() {
  if (window.__tourRunning) return;
  window.__tourRunning = true;
  tourIndex = 0;
  document.getElementById('tourOverlay').classList.add('active');
  renderTourStep();
}

async function endTour() {
  document.getElementById('tourOverlay').classList.remove('active');
  window.__tourRunning = false;
  try {
    await window.api.setOnboardingCompleted(true);
  } catch (err) {
    console.error('setOnboardingCompleted failed', err);
  }
  switchTab('play');
}

document.getElementById('tourNextBtn').addEventListener('click', () => {
  if (tourIndex === tourSteps.length - 1) {
    endTour();
    return;
  }
  tourIndex++;
  renderTourStep();
});

document.getElementById('tourBackBtn').addEventListener('click', () => {
  if (tourIndex === 0) return;
  tourIndex--;
  renderTourStep();
});

document.getElementById('tourSkipBtn').addEventListener('click', endTour);
document.getElementById('replayTourBtn').addEventListener('click', startTour);

window.addEventListener('resize', () => {
  if (document.getElementById('tourOverlay').classList.contains('active')) {
    positionTourStep(tourSteps[tourIndex]);
  }
});

// --- init ---
// Каждый шаг запуска изолирован: ошибка в одном (например, нет интернета или битый
// список) больше не обрывает остальные и не мешает показать обучение новичку.
(async () => {
  const splash = document.getElementById('splash');
  const step = (label, fn) => Promise.resolve()
    .then(fn)
    .catch(err => { console.error(`[init] ${label}:`, err); return undefined; });

  let needsTour = false;
  let splashHidden = false;
  const hideSplash = () => {
    if (splashHidden) return;
    splashHidden = true;
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 400);
  };

  try {
    // нужно ли обучение, определяем отдельно от остального запуска
    needsTour = await window.api.getSettings().then(s => !s.onboardingCompleted).catch(() => false);

    // аккаунт и список версий не зависят друг от друга — грузим параллельно
    await Promise.all([
      step('account', refreshAccount),
      step('versions', loadVersions)
    ]);
    await step('badge', renderCurrentTargetBadge);
    await step('hero', updateHeroBackground);

    // Основной экран готов — убираем заставку, а тяжёлые разделы (моды, ресурспаки,
    // Fabric/NeoForge с запросами в сеть) дозаполняются уже под видимым интерфейсом
    hideSplash();
    await Promise.all([
      step('playtime', refreshPlaytimeLabel),
      step('wanted', renderWantedList),
      step('copyOptions', renderCopyOptions),
      step('rpList', renderResourcePackList),
      step('modpacks', renderModpackOptions),
      step('installedMods', renderInstalledMods),
      step('rpCopy', renderRpCopyOptions),
      step('rpProfiles', renderRpProfileOptions),
      step('installedRp', renderInstalledResourcePacks),
      step('communityBuild', loadCommunityBuildUrl),
      step('fabric', renderFabricLoaderSection),
      step('neoforge', renderNeoforgeVersionSection),
      step('copySettings', renderCopySettingsSection)
    ]);
    step('modUpdates', checkModUpdatesOnStart);
    step('appVersion', loadAppVersion);
    step('changelog', loadChangelog);
  } finally {
    hideSplash();
    if (needsTour) setTimeout(startTour, 700);
  }
})();

// --- секретный диалог с котом Синтом ---

const catState = { typing: false, skip: false, advance: null, typeTimer: null, mouthTimer: null, nameRevealed: false };

let catAudioCtx = null;
let catAudioBuffer = null;
let catAudioReady = false;
let catUserAudioBuffer = null;
let catUserAudioReady = false;

function randomIp() {
  const seg = () => Math.floor(Math.random() * 255) + 1;
  return `${seg()}.${seg()}.${seg()}.${seg()}`;
}

function catLoadSound(url, onDecoded) {
  const onBuffer = arrayBuffer => {
    catAudioCtx.decodeAudioData(arrayBuffer, onDecoded, err => console.error('cat audio decode failed', url, err));
  };
  fetch(url)
    .then(res => res.arrayBuffer())
    .then(onBuffer)
    .catch(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => onBuffer(xhr.response);
      xhr.onerror = () => console.error('cat audio load failed', url);
      xhr.send();
    });
}

function catInitAudio() {
  if (catAudioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  catAudioCtx = new Ctx();
  catAudioCtx.resume().catch(() => {});

  catLoadSound('cat/meow.mp3', decoded => {
    catAudioBuffer = decoded;
    catAudioReady = true;
  });

  catLoadSound('cat/user_talk.mp3', decoded => {
    catUserAudioBuffer = decoded;
    catUserAudioReady = true;
  });
}

function catPlayBlip(buffer, volume, rateFrom, rateSpan) {
  const play = () => {
    const src = catAudioCtx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rateFrom + Math.random() * rateSpan;
    const gain = catAudioCtx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(catAudioCtx.destination);
    src.start(0, 0, Math.min(0.12, buffer.duration));
  };

  if (catAudioCtx.state === 'suspended') {
    catAudioCtx.resume().then(play).catch(err => console.error('cat audio resume failed', err));
  } else {
    play();
  }
}

function catBlip() {
  if (!catAudioReady) return;
  catPlayBlip(catAudioBuffer, 0.85, 0.8, 0.55);
}

function catUserBlip() {
  if (!catUserAudioReady) return;
  catPlayBlip(catUserAudioBuffer, 0.7, 0.85, 0.4);
}

function catStartTalkVideo() {
  const video = document.getElementById('catTalkVideo');
  video.currentTime = 0;
  video.play().catch(err => console.error('cat video play failed', err));
}

function catShowIdle() {
  clearTimeout(catState.mouthTimer);
  const idle = document.getElementById('catIdleImg');
  const video = document.getElementById('catTalkVideo');
  video.pause();
  video.classList.add('cat-visual-hidden');
  idle.classList.remove('cat-visual-hidden');
}

function catMouthFlick() {
  const idle = document.getElementById('catIdleImg');
  const video = document.getElementById('catTalkVideo');
  video.classList.remove('cat-visual-hidden');
  idle.classList.add('cat-visual-hidden');
  clearTimeout(catState.mouthTimer);
  catState.mouthTimer = setTimeout(() => {
    video.classList.add('cat-visual-hidden');
    idle.classList.remove('cat-visual-hidden');
  }, 140);
}

function catBounce() {
  const stage = document.querySelector('.cat-stage');
  stage.classList.remove('cat-bounce-pulse');
  void stage.offsetWidth;
  stage.classList.add('cat-bounce-pulse');
}

function catTalkTick() {
  catBlip();
  catMouthFlick();
  catBounce();
}

function catUserTick() {
  catUserBlip();
}

function catTypeChunks(chunks, speaker, onDone) {
  const textEl = document.getElementById('catText');
  const hint = document.getElementById('catContinueHint');
  hint.classList.remove('show');
  textEl.textContent = '';

  const chars = [];
  chunks.forEach(chunk => {
    for (const ch of chunk.t) chars.push({ ch, u: !!chunk.u });
  });

  let i = 0;
  catState.typing = true;
  catState.skip = false;
  clearTimeout(catState.typeTimer);

  if (speaker === 'cat') catStartTalkVideo(); else catShowIdle();

  function render() {
    let html = '';
    let curU = null;
    let buf = '';
    for (let k = 0; k < i; k++) {
      const c = chars[k];
      if (c.u !== curU) {
        html += curU ? `<u>${buf}</u>` : buf;
        buf = '';
        curU = c.u;
      }
      buf += c.ch;
    }
    html += curU ? `<u>${buf}</u>` : buf;
    textEl.innerHTML = html;
  }

  function finish() {
    catState.typing = false;
    clearTimeout(catState.typeTimer);
    catShowIdle();
    i = chars.length;
    render();
    onDone && onDone();
  }

  function step() {
    if (catState.skip) { finish(); return; }
    i++;
    render();
    const c = chars[i - 1];
    if (c.ch.trim()) {
      if (speaker === 'cat') catTalkTick(); else catUserTick();
    }
    if (i >= chars.length) { finish(); return; }
    catState.typeTimer = setTimeout(step, 45);
  }

  step();
}

function catShow(who, textOrChunks, next) {
  const speaker = document.getElementById('catSpeaker');
  const choices = document.getElementById('catChoices');
  choices.innerHTML = '';
  speaker.textContent = who === 'cat' ? (catState.nameRevealed ? 'Синт' : '???') : 'Ты';

  const chunks = (Array.isArray(textOrChunks) ? textOrChunks : [{ t: textOrChunks }])
    .map(chunk => ({ ...chunk, t: window.i18n.t(chunk.t) }));

  catState.advance = next;
  catTypeChunks(chunks, who, () => {
    if (catState.advance) document.getElementById('catContinueHint').classList.add('show');
  });
}

function catShowChoices(options, handler) {
  catState.advance = null;
  document.getElementById('catContinueHint').classList.remove('show');
  const choices = document.getElementById('catChoices');
  choices.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.textContent = opt;
    btn.onclick = e => {
      e.stopPropagation();
      choices.innerHTML = '';
      handler(opt);
    };
    choices.appendChild(btn);
  });
}

function catAdvance() {
  if (catState.typing) {
    catState.skip = true;
    return;
  }
  if (catState.advance) {
    const fn = catState.advance;
    catState.advance = null;
    document.getElementById('catContinueHint').classList.remove('show');
    fn();
  }
}

document.getElementById('catTextbox').addEventListener('click', catAdvance);

function catOpenOverlay() {
  const overlay = document.getElementById('catOverlay');
  catState.nameRevealed = false;
  document.getElementById('catText').textContent = '';
  document.getElementById('catSpeaker').textContent = '';
  document.getElementById('catChoices').innerHTML = '';
  document.getElementById('catContinueHint').classList.remove('show');
  document.getElementById('catMysteryBtnWrap').style.display = 'none';
  catShowIdle();
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('active'));
}

function catCloseOverlay() {
  const overlay = document.getElementById('catOverlay');
  overlay.classList.remove('active');
  catShowIdle();
  setTimeout(() => { overlay.style.display = 'none'; }, 500);
}

function catNodeGreet() {
  catShow('cat', 'Здарова чебзик, как ты?', () => {
    catShowChoices(['Норм', 'Хорошо', 'Иди нахуй'], choice => {
      if (choice === 'Иди нахуй') catNodeRude();
      else catNodeNice(choice);
    });
  });
}

function catNodeNice(choice) {
  const line = choice === 'Норм'
    ? 'У меня вот всё хорошо, но у меня один вопрос, как ты сюда попал?'
    : 'Ооо, это отлично, у меня тоже всё хорошо, но у меня один вопрос, как ты сюда попал?';
  catShow('cat', line, () => {
    catShow('user', 'Та я нажал на какую-то кнопку и меня перекинуло сюда, к тебе', () => {
      catShow('cat', 'А, ну да, я забыл, что создал новую кнопку, чтобы люди могли найти меня :P', catNodePlace);
    });
  });
}

function catNodeRude() {
  const ip = randomIp();
  catShow('cat', `Вот это нихуя себе заявочка, вот так вот мы заговорили, слушай меня сюда, я знаю кто ты и где ты живешь (${ip}), и у меня вопрос, какого хуя ты тут делаешь?`, () => {
    catShow('user', 'Чил мабой, это джока. Я нажал на какую-то кнопку и меня перекинуло сюда, к тебе', () => {
      catShow('cat', 'А, ой, прости, не знал. Я забыл, что создал новую кнопку, чтобы люди могли найти меня :P', catNodePlace);
    });
  });
}

function catNodePlace() {
  catShow('user', 'А что это за место? Тут вообще, что-нибудь есть?', () => {
    catShow('cat', 'Это моё тайное место, я тут поселился, чтобы встречать новеньких, но я затупил в коде и создал только кнопку, на которую если нажать, то попадешь ко мне, сюда. Например, как ты сейчас. Тут пока-что ничего нет, но скоро, я добавлю кучу крутых штук, которые понравятся тебе и другим пользователем :3', () => {
      document.getElementById('catMysteryBtnWrap').style.display = 'block';
      catShow('user', 'Скромненькое местечко. Стоп, а что это за кнопка?', () => {
        catShow('cat', 'Ааэээ, лучше тебе на неё не нажимать. Я пока её не доработал и она сломана. Так что, мдэээ', () => {
          catShow('user', 'Ну ладно.', () => {
            catShowChoices(['Нажать на кнопку', 'Не нажимать на кнопку'], choice => {
              catNodeButtonChoice(choice === 'Нажать на кнопку');
            });
          });
        });
      });
    });
  });
}

function catNodeButtonChoice(pressed) {
  document.getElementById('catMysteryBtnWrap').style.display = 'none';
  const line = pressed
    ? 'Ты реально думал, что что-то произойдет? Я же сказал, что она сломана'
    : 'Спасибо, что не нажал на кнопку, а то бы она ещё больше бы сломалась.';
  catShow('cat', line, catNodeFarewell);
}

function catNodeFarewell() {
  catShow('user', 'Ну, я думаю мне пора. Пока ааэээ...', () => {
    catState.nameRevealed = true;
    catShow('cat', [{ t: 'Меня зовут ' }, { t: 'Синт', u: true }, { t: '!' }], () => {
      catShow('user', 'А, пока Синт! :)', catFinish);
    });
  });
}

async function catFinish() {
  await window.api.unlockSyntTheme();
  document.getElementById('syntThemeSwatch').style.display = '';
  applyTheme('synt');
  catCloseOverlay();
}

document.getElementById('findCatBtn').addEventListener('click', () => {
  catInitAudio();
  catOpenOverlay();
  catNodeGreet();
});

document.getElementById('catMysteryBtn').addEventListener('click', e => {
  e.stopPropagation();
  const btn = document.getElementById('catMysteryBtn');
  btn.style.transform = 'scale(.85)';
  setTimeout(() => { btn.style.transform = ''; }, 120);
});

// ---- кастомный тайтлбар (окно теперь frame:false) ----
(function initTitlebar() {
  const minBtn = document.getElementById('winMinBtn');
  const maxBtn = document.getElementById('winMaxBtn');
  const closeBtn = document.getElementById('winCloseBtn');
  const maxIcon = document.getElementById('winMaxIcon');
  if (!minBtn || !maxBtn || !closeBtn || !window.api) return;

  const setMaxIcon = isMax => {
    maxBtn.title = isMax ? 'Восстановить' : 'Развернуть';
    maxIcon.src = isMax ? 'icons/minimize.svg' : 'icons/maximize.svg';
  };

  minBtn.addEventListener('click', () => window.api.minimizeWindow());
  maxBtn.addEventListener('click', async () => {
    const isMax = await window.api.maximizeToggleWindow();
    setMaxIcon(isMax);
  });
  closeBtn.addEventListener('click', () => window.api.closeWindow());

  window.api.isWindowMaximized().then(setMaxIcon).catch(() => {});
  if (window.api.onWindowMaximizedChange) window.api.onWindowMaximizedChange(setMaxIcon);

  document.getElementById('titlebar')?.addEventListener('dblclick', async () => {
    const isMax = await window.api.maximizeToggleWindow();
    setMaxIcon(isMax);
  });
})();


// --- глобальный поиск Ctrl+K ---
(() => {
  const modal = document.getElementById('globalSearchModal');
  const input = document.getElementById('globalSearchInput');
  const results = document.getElementById('globalSearchResults');
  if (!modal || !input || !results) return;
  const entries = [
    { title: 'Главная', subtitle: 'Выбор сборки и запуск', action: () => switchTab('play') },
    { title: 'Сборки', subtitle: 'Создание и выбор сборок', action: () => switchTab('builds') },
    { title: 'Моды', subtitle: 'Поиск и установка модов', action: () => switchTab('mods') },
    { title: 'Ресурспаки', subtitle: 'Поиск ресурспаков', action: () => switchTab('resourcepacks') },
    { title: 'Шейдеры', subtitle: 'Поиск шейдеров', action: () => switchTab('shaders') },
    { title: 'Миры', subtitle: 'Управление мирами', action: () => switchTab('worlds') },
    { title: 'Скриншоты', subtitle: 'Галерея скриншотов', action: () => switchTab('screenshots') },
    { title: 'Активность', subtitle: 'Игровая статистика, сборки и история запусков', action: () => switchTab('activity') },
    { title: 'Оформление', subtitle: 'Цвета, пресеты, шрифты и фон', action: () => switchTab('appearance') },
    { title: 'Настройки', subtitle: 'Настройки лаунчера', action: () => switchTab('settings') },
    { title: 'История', subtitle: 'История изменений', action: () => switchTab('changelog') },
    { title: 'Проверить файлы', subtitle: 'Проверка текущей сборки', action: () => { switchTab('play'); document.getElementById('verifyFilesBtn')?.click(); } }
  ];
  let selected = 0;
  function close() { modal.style.display = 'none'; }
  function open() { modal.style.display = 'flex'; input.value = ''; selected = 0; render(); input.focus(); }
  function render() {
    const q = input.value.trim().toLowerCase();
    const filtered = entries.filter(e => `${e.title} ${e.subtitle}`.toLowerCase().includes(q));
    if (!filtered.length) { results.innerHTML = '<div class="global-search-empty">Ничего не найдено</div>'; return; }
    selected = Math.min(selected, filtered.length - 1);
    results.innerHTML = filtered.map((e, i) => `<button class="global-search-result ${i === selected ? 'selected' : ''}" data-index="${i}"><strong>${escHtml(e.title)}</strong><span>${escHtml(e.subtitle)}</span></button>`).join('');
    results.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => { filtered[i].action(); close(); }));
  }
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', e => {
    const filtered = entries.filter(x => `${x.title} ${x.subtitle}`.toLowerCase().includes(input.value.trim().toLowerCase()));
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, Math.max(0, filtered.length - 1)); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); render(); }
    if (e.key === 'Enter' && filtered[selected]) { filtered[selected].action(); close(); }
  });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); } });
})();
