// Главная страница: блоки, которым нужны данные, а не только вёрстка.
// Подключается после renderer.js и ничего в нём не подменяет: существующие
// обработчики (запуск, версии, загрузчики, фон) работают как раньше, а этот
// файл только читает состояние и рисует новые виджеты.
(() => {
  'use strict';

  const api = window.api;
  if (!api) return;

  const $ = id => document.getElementById(id);
  const versionSelect = $('versionSelect');
  const loaderSelect = $('loaderSelect');
  if (!versionSelect || !loaderSelect) return;

  const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla' };
  const REPO_URL = 'https://github.com/MRBOMBOCLATTT/PFC-Launcher';
  const RECENT_LIMIT = 4;

  const cleanVersion = v => String(v || '').replace(/^Minecraft\s+/i, '').trim();
  const selection = () => ({ mcVersion: versionSelect.value, loader: loaderSelect.value });
  const keyOf = (v, l) => `${v}|${l}`;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name, className = 'ico') {
    const node = el('span', className);
    node.style.setProperty('--ico-src', `url('icons/${name}.svg')`);
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  const modsText = n => `${n} ${plural(n, 'мод', 'мода', 'модов')}`;

  function formatGb(bytesOrGb, isBytes) {
    const gb = isBytes ? bytesOrGb / (1024 ** 3) : bytesOrGb;
    return (Math.round(gb * 10) / 10).toString().replace('.', ',');
  }

  function setTileState(tile, state) {
    if (!tile) return;
    tile.classList.remove('is-ok', 'is-warn', 'is-busy');
    if (state) tile.classList.add(`is-${state}`);
  }

  // ---------- меню-поповеры (⋯ у сборки и стрелка у кнопки запуска) ----------
  const popovers = [];

  function closePopovers(except) {
    popovers.forEach(p => {
      if (p === except) return;
      p.menu.hidden = true;
      p.button.setAttribute('aria-expanded', 'false');
    });
  }

  document.querySelectorAll('.pop-wrap').forEach(wrap => {
    const button = wrap.querySelector(':scope > button');
    const menu = wrap.querySelector('.pop');
    if (!button || !menu) return;
    const entry = { button, menu };
    popovers.push(entry);

    button.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      closePopovers(entry);
      menu.hidden = !willOpen;
      button.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) menu.querySelector('.pop-item')?.focus();
    });

    menu.addEventListener('click', e => {
      const item = e.target.closest('.pop-item');
      if (!item) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      const proxyId = item.dataset.proxy;
      if (proxyId) $(proxyId)?.click();
    });

    menu.addEventListener('keydown', e => {
      const items = [...menu.querySelectorAll('.pop-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    });
  });

  document.addEventListener('click', () => closePopovers());
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = popovers.find(p => !p.menu.hidden);
    if (!open) return;
    closePopovers();
    open.button.focus();
  });

  // ---------- боковое меню и заголовок ----------
  api.getAppVersion?.().then(v => {
    const label = $('sidebarVersion');
    if (label && v) label.textContent = `v${v}`;
  }).catch(() => {});

  $('titlebarSettingsBtn')?.addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="settings"]')?.click();
  });

  // ---------- плитки состояния ----------
  async function refreshJava() {
    const { mcVersion } = selection();
    const label = $('javaLabel');
    const value = $('javaValue');
    const tile = $('tileJava');
    if (!mcVersion || !value) return;

    const parts = cleanVersion(mcVersion).split('.').map(n => parseInt(n, 10));
    let major = null;
    if (parts[0] === 1 && Number.isFinite(parts[1])) {
      const minor = parts[1];
      const patch = parts[2] || 0;
      if (minor > 20 || (minor === 20 && patch >= 5)) major = 21;
      else if (minor >= 18) major = 17;
      else if (minor === 17) major = 16;
      else major = 8;
    }
    label.textContent = major ? `Java ${major}` : 'Java';

    const requested = mcVersion;
    try {
      const res = await api.checkJava(cleanVersion(mcVersion));
      if (requested !== selection().mcVersion) return;
      const ok = res && res.ok !== false && res.compatible !== false;
      value.textContent = ok ? 'Готово' : 'Нужна проверка';
      tile.title = res?.message || '';
      setTileState(tile, ok ? 'ok' : 'warn');
    } catch (err) {
      value.textContent = 'Не удалось проверить';
      tile.title = err?.message || '';
      setTileState(tile, 'warn');
    }
  }

  function parseMemoryMb(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const m = String(value ?? '').trim().toUpperCase().replace(',', '.')
      .match(/^(\d+(?:\.\d+)?)\s*(G|GB|ГБ|M|MB|МБ)?$/);
    if (!m) return 0;
    const amount = Number(m[1]);
    const unit = m[2] || 'M';
    return unit.startsWith('G') || unit === 'ГБ' ? amount * 1024 : amount;
  }

  async function refreshRam() {
    const value = $('ramValue');
    const bar = $('ramBar');
    const tile = $('tileRam');
    try {
      const [settings, info] = await Promise.all([api.getSettings(), api.getMemoryInfo()]);
      const maxMb = parseMemoryMb(settings?.memoryMax);
      const totalMb = (info?.totalBytes || 0) / (1024 * 1024);
      if (!maxMb || !totalMb) { value.textContent = '—'; bar.style.width = '0'; return; }
      value.textContent = `${formatGb(maxMb / 1024)} из ${formatGb(totalMb / 1024)} ГБ`;
      bar.style.width = `${Math.min(100, Math.round((maxMb / totalMb) * 100))}%`;
      const low = maxMb < 2048;
      const tooMuch = maxMb > totalMb;
      tile.title = tooMuch ? 'Выделено больше, чем есть в системе' : low ? 'Для комфортной игры рекомендуется не менее 2 ГБ' : '';
      setTileState(tile, low || tooMuch ? 'warn' : null);
    } catch (err) {
      value.textContent = '—';
    }
  }

  async function refreshDisk() {
    const value = $('diskValue');
    const bar = $('diskBar');
    try {
      const info = await api.getDiskInfo();
      if (!info || !info.totalBytes) { value.textContent = 'Недоступно'; bar.style.width = '0'; return; }
      value.textContent = `${formatGb(info.freeBytes, true)} ГБ свободно`;
      bar.style.width = `${Math.max(2, Math.round((1 - info.freeBytes / info.totalBytes) * 100))}%`;
    } catch (err) {
      value.textContent = 'Недоступно';
    }
  }

  // проверка сборки запускается вручную: она читает файлы и сверяет моды,
  // поэтому не стоит гонять её при каждом переключении версии
  let checkSerial = 0;

  function setCheck(state, text, title = '') {
    const tile = $('tileCheck');
    $('checkValue').textContent = text;
    tile.title = title || 'Проверить файлы выбранной сборки';
    setTileState(tile, state);
  }

  function resetCheck() {
    checkSerial++;
    setCheck(null, 'Не проверялась');
  }

  async function runCheck() {
    const { mcVersion, loader } = selection();
    if (!mcVersion) return;
    const serial = ++checkSerial;
    setCheck('busy', 'Проверяю…');
    try {
      const report = await api.verifyFiles(mcVersion, loader);
      if (serial !== checkSerial) return;
      const diff = (report.mods?.installed?.length || 0) + (report.resourcepacks?.installed?.length || 0);
      if (diff > 0) {
        setCheck('warn', `Расхождений: ${diff}`, 'Моды или ресурспаки не совпадают с сохранённым списком. Нажмите «Проверить и исправить».');
      } else if (!report.core?.jarOk) {
        setCheck(null, 'Докачается при запуске', 'Файлы игры будут загружены при первом запуске');
      } else {
        setCheck('ok', 'Нет проблем');
      }
    } catch (err) {
      if (serial !== checkSerial) return;
      setCheck('warn', 'Не удалось проверить', err?.message || '');
    }
  }

  $('tileCheck')?.addEventListener('click', runCheck);

  // ---------- карточка выбранной сборки ----------
  let modCountSerial = 0;

  async function countMods(mcVersion, loader) {
    if (loader === 'vanilla') return 0;
    const list = await api.listInstalledMods(mcVersion, loader);
    return (Array.isArray(list) ? list : [])
      .filter(m => m.enabled && !String(m.fileName).startsWith('_pfc-')).length;
  }

  async function refreshModChip() {
    const { mcVersion, loader } = selection();
    const chip = $('modCountChip');
    if (!mcVersion || !chip) return;
    if (loader === 'vanilla') { chip.textContent = 'Без модов'; return; }
    const serial = ++modCountSerial;
    try {
      const n = await countMods(mcVersion, loader);
      if (serial !== modCountSerial) return;
      chip.textContent = modsText(n);
    } catch (err) {
      if (serial === modCountSerial) chip.textContent = 'Моды: —';
    }
  }

  // обложка берёт то же изображение, что и баннер (фон сборки), —
  // так не нужен второй запрос и она всегда совпадает с баннером
  function syncThumb() {
    const thumb = $('buildThumb');
    const bg = $('playHeroBg');
    if (!thumb || !bg) return;
    const src = bg.querySelector('.hero-bg-image')?.src;
    const existing = thumb.querySelector('img');
    if (!src) {
      existing?.remove();
      thumb.classList.remove('has-image');
      return;
    }
    if (existing) { if (existing.src !== src) existing.src = src; return; }
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    img.src = src;
    thumb.appendChild(img);
    thumb.classList.add('has-image');
  }

  const bgNode = $('playHeroBg');
  if (bgNode) new MutationObserver(syncThumb).observe(bgNode, { childList: true });

  // ---------- недавние сборки ----------
  // Плитки — настоящие сборки (вкладка «Сборки»). Если ни одна не выбрана, первой стоит текущая
  // пара «версия + загрузчик» (режим без сборки), чтобы выбранное всегда было видно.
  const state = { builds: [], favorites: [] };
  const bgCache = new Map();
  const countCache = new Map();

  async function loadRecent() {
    try {
      const [list, settings] = await Promise.all([api.listBuilds(), api.getSettings()]);
      state.builds = Array.isArray(list) ? list : [];
      state.favorites = settings?.favoriteVersions || [];
    } catch (err) {
      state.builds = [];
    }
    bgCache.clear();
    renderRecent();
  }

  // вкладка «Сборки» сообщает об изменениях списка (создание, выбор, переименование, удаление)
  window.addEventListener('fc-builds-changed', e => {
    state.builds = Array.isArray(e.detail) ? e.detail : [];
    renderRecent();
  });

  function recentEntries() {
    const entries = state.builds.slice().sort((a, b) =>
      (Number(b.active) - Number(a.active))
      || ((b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
      || String(a.name).localeCompare(String(b.name)));
    const { mcVersion, loader } = selection();
    if (mcVersion && !entries.some(e => e.active)) {
      entries.unshift({ id: null, noBuild: true, active: true, name: `Minecraft ${cleanVersion(mcVersion)}`, mcVersion, loader });
    }
    return entries;
  }

  async function selectEntry(entry) {
    if (entry.noBuild || entry.active) return;
    const has = [...versionSelect.options].some(o => o.value === entry.mcVersion);
    if (!has) {
      if (typeof showToast === 'function') showToast(`Версия ${cleanVersion(entry.mcVersion)} сейчас недоступна в списке`, 'warn');
      return;
    }
    try {
      await window.fcBuilds.select(entry.id);
    } catch (err) {
      if (typeof showToast === 'function') showToast(String(err?.message || err), 'error');
    }
  }

  function tileFor(entry) {
    const { mcVersion, loader } = entry;
    const key = entry.id ? `build:${entry.id}` : keyOf(mcVersion, loader);
    const btn = el('button', 'rb' + (entry.active ? ' is-selected' : ''));
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(!!entry.active));
    btn.addEventListener('click', () => selectEntry(entry));

    // цветная полоска: у сборки по её id, у «без сборки» по версии и загрузчику
    window.PFCAccent?.decorateTile(btn, mcVersion, loader, entry.noBuild ? null : entry.id);

    const thumb = el('div', 'rb-thumb loader-' + loader);
    thumb.appendChild(icon('box', 'ico rb-ph'));
    btn.appendChild(thumb);

    const row = el('div', 'rb-row');
    row.appendChild(el('span', 'rb-name', entry.name));
    if (state.favorites.includes(mcVersion)) {
      const star = icon('star', 'ico rb-star');
      star.title = 'Любимая версия';
      row.appendChild(star);
    }
    btn.appendChild(row);
    btn.title = entry.noBuild ? 'Без сборки' : entry.name;

    const loaderName = LOADER_NAMES[loader] || loader;
    btn.appendChild(el('div', 'rb-meta', entry.noBuild ? `${loaderName} · без сборки` : `${cleanVersion(mcVersion)} · ${loaderName}`));

    const modsLine = el('div', 'rb-meta rb-mods', '');
    if (loader === 'vanilla') {
      modsLine.textContent = 'Без модов';
    } else if (!entry.noBuild) {
      modsLine.textContent = modsText(entry.modsCount || 0);
    } else if (countCache.has(key)) {
      modsLine.textContent = modsText(countCache.get(key));
    } else {
      countMods(mcVersion, loader).then(n => {
        countCache.set(key, n);
        modsLine.textContent = modsText(n);
      }).catch(() => {});
    }
    btn.appendChild(modsLine);

    const apply = src => {
      if (!src || thumb.querySelector('img')) return;
      const img = el('img');
      img.alt = '';
      img.draggable = false;
      img.src = src;
      thumb.appendChild(img);
      thumb.classList.add('has-image');
    };
    const loadBackground = entry.noBuild
      ? () => api.getInstanceBackground(mcVersion, loader)
      : (entry.hasBackground ? () => api.getBuildBackground(entry.id) : null);
    if (loadBackground) {
      if (bgCache.has(key)) apply(bgCache.get(key));
      else loadBackground().then(src => { bgCache.set(key, src); apply(src); }).catch(() => {});
    }
    return btn;
  }

  function renderRecent() {
    const grid = $('recentGrid');
    if (!grid) return;
    grid.replaceChildren();
    recentEntries().slice(0, RECENT_LIMIT).forEach(entry => grid.appendChild(tileFor(entry)));

    const create = el('button', 'rb rb-new');
    create.type = 'button';
    create.appendChild(icon('plus', 'ico rb-new-ico'));
    const text = el('span', 'rb-new-text');
    text.append('Создать', document.createElement('br'), 'новую сборку');
    create.appendChild(text);
    create.addEventListener('click', () => window.fcBuilds?.create());
    grid.appendChild(create);
  }

  // «Все сборки» ведёт на вкладку со всеми сборками
  $('recentAllBtn')?.addEventListener('click', () => switchTab('builds'));

  // ---------- новости (история версий лаунчера) ----------
  function formatNewsDate(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso || '';
    return d.toLocaleDateString(window.i18n.locale, { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\s?г\.$/, '');
  }

  async function loadNews() {
    const list = $('newsList');
    if (!list) return;
    try {
      const changelog = await api.getChangelog();
      list.replaceChildren();
      (Array.isArray(changelog) ? changelog : []).slice(0, 2).forEach(entry => {
        const items = [...(entry.added || []), ...(entry.fixed || []), ...(entry.changes || [])].slice(0, 3);
        const card = el('article', 'news-item');
        const head = el('div', 'news-head');
        head.appendChild(el('span', 'news-version', `v${entry.version}`));
        head.appendChild(el('span', 'news-date', formatNewsDate(entry.date)));
        card.appendChild(head);
        const ul = el('ul', 'news-bullets');
        items.forEach(text => ul.appendChild(el('li', null, text)));
        card.appendChild(ul);
        list.appendChild(card);
      });
    } catch (err) {
      list.replaceChildren(el('div', 'news-empty', 'Не удалось загрузить список изменений'));
    }
  }

  $('newsAllBtn')?.addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="changelog"]')?.click();
  });

  $('openSiteBtn')?.addEventListener('click', () => api.openExternal(REPO_URL));

  // ---------- быстрые действия ----------
  $('qaMods')?.addEventListener('click', () => switchTab('mods'));

  $('qaFolder')?.addEventListener('click', () => {
    const { mcVersion, loader } = selection();
    api.openFolder(mcVersion, loader, 'root');
  });

  $('qaFix')?.addEventListener('click', () => $('verifyAndFixBtn')?.click());

  $('qaLoader')?.addEventListener('click', () => {
    const { loader } = selection();
    const section = loader === 'fabric' ? $('fabricLoaderSection')
      : loader === 'neoforge' ? $('neoforgeVersionSection') : null;
    const visible = section && getComputedStyle(section).display !== 'none';
    if (visible) {
      section.open = true;
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      section.querySelector('select')?.focus({ preventScroll: true });
    } else {
      const active = document.querySelector('.loader-btn.active') || document.querySelector('.loader-btn');
      active?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      active?.focus({ preventScroll: true });
    }
  });

  // ---------- «Сейчас в игре» ----------
  const now = { running: null, timer: null, pending: null };

  function formatSession(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'меньше минуты';
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} ч ${m} мин` : `${m} мин`;
  }

  function renderNow() {
    const box = $('nowPlaying');
    if (!box) return;
    const r = now.running;
    box.classList.toggle('is-live', Boolean(r));
    if (!r) {
      $('nowTitle').textContent = 'Вы не в игре';
      $('nowSub').textContent = 'Запустите Minecraft, чтобы увидеть информацию';
      return;
    }
    $('nowTitle').textContent = `Minecraft ${cleanVersion(r.mcVersion)}`;
    $('nowSub').textContent = `${LOADER_NAMES[r.loader] || r.loader} · в игре ${formatSession(Date.now() - r.startedAt)}`;
  }

  function stopNow() {
    now.running = null;
    clearInterval(now.timer);
    now.timer = null;
    renderNow();
  }

  // запоминаем выбор в момент нажатия «Запустить», пока пользователь не успел его сменить
  $('playBtn')?.addEventListener('click', () => { now.pending = selection(); }, true);

  api.onGameProgress?.(p => {
    if (!p) return;
    if (p.stage === 'game-started') {
      const sel = now.pending || selection();
      now.running = { ...sel, startedAt: Date.now() };
      clearInterval(now.timer);
      now.timer = setInterval(renderNow, 30000);
      renderNow();
    } else if (p.stage === 'closed' || p.stage === 'crash') {
      stopNow();
      refreshDisk();
      loadRecent();
    }
  });

  // ---------- реакция на смену выбора и возврат на главную ----------
  function onSelectionChanged() {
    resetCheck();
    refreshModChip();
    refreshJava();
    renderRecent();
  }

  versionSelect.addEventListener('change', onSelectionChanged);
  loaderSelect.addEventListener('change', onSelectionChanged);

  document.querySelector('.tab-btn[data-tab="play"]')?.addEventListener('click', () => {
    refreshRam();
    refreshDisk();
    loadRecent();
  });

  // renderer.js заполняет список версий асинхронно — ждём, пока выбор появится
  let waited = 0;
  const waitForSelection = setInterval(() => {
    waited += 150;
    if (versionSelect.value || waited > 8000) {
      clearInterval(waitForSelection);
      refreshModChip();
      refreshJava();
      loadRecent();
      syncThumb();
    }
  }, 150);

  refreshRam();
  refreshDisk();
  loadNews();
  renderNow();
})();
