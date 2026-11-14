// Градиентная тема и цвет отдельных сборок.
//
// Подключается после renderer.js и ничего в нём не подменяет: использует его
// глобальные applyTheme / applyCustomPalette и следит за <body data-theme/data-mode>.
// Порядок слоёв такой:
//   1. базовая тема (то, что выбрано плашкой в настройках — делает renderer.js);
//   2. поверх неё — «своя» раскраска: цвет/градиент выбранной сборки, а если у сборки
//      его нет и выбрана плашка «Градиент» — общий градиент.
(() => {
  'use strict';

  const api = window.api;
  const G = window.PFCGradient;
  if (!api || !G) return;

  const $ = id => document.getElementById(id);
  const body = document.body;
  const versionSelect = $('versionSelect');
  const loaderSelect = $('loaderSelect');

  const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla' };
  const ANIM_LABELS = {
    none: ['Нет', 'Статичный градиент'],
    flow: ['Перелив', 'Градиент плавно перетекает туда-обратно'],
    rotate: ['Вращение', 'Градиент поворачивается по кругу'],
    spectrum: ['Спектр', 'Все цвета плавно меняют оттенок, как радуга'],
    pulse: ['Пульс', 'Мягкое «дыхание» свечения'],
    shimmer: ['Блик', 'По кнопке периодически пробегает блик']
  };
  const TYPE_LABELS = { linear: 'Линейный', radial: 'Радиальный', conic: 'Конический' };
  const TARGET_LABELS = {
    launch: 'Кнопка запуска',
    progress: 'Полосы прогресса',
    controls: 'Кнопки и переключатели',
    banner: 'Баннер (если нет своего фона)',
    background: 'Фон лаунчера'
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // hsl(from …) — «относительный цвет», нужен для режима «Спектр»
  const relativeColor = !!(window.CSS && CSS.supports && CSS.supports('color', 'hsl(from red calc(h + 10) s l)'));

  const toast = (msg, type) => {
    if (typeof showToast === 'function') showToast(msg, type);
    else console.log(msg);
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(text, className, onClick, title) {
    const b = el('button', className, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  const cleanVersion = v => String(v || '').replace(/^Minecraft\s+/i, '').trim();
  const keyOf = (v, l) => `${v}-${l}`; // инстанс без сборки, как instanceKey в src/store.js
  // у выбранной сборки ключ build-<id>, иначе две сборки на одной версии делят один цвет
  const selectionKey = (v, l) => {
    const b = window.__activeBuild;
    return b && b.mcVersion === v && b.loader === l ? `build-${b.id}` : keyOf(v, l);
  };

  // ---------------------------------------------------------------- состояние
  let globalCfg = G.cloneDefault();
  const accents = new Map();              // ключ сборки -> { kind, … } (нет записи = «как везде»)
  const saveTimers = new Map();
  let globalSaveTimer = null;

  function currentSelection() {
    const mcVersion = versionSelect?.value || '';
    const loader = loaderSelect?.value || '';
    return mcVersion && loader ? { mcVersion, loader, key: selectionKey(mcVersion, loader) } : null;
  }

  function currentOverride() {
    const sel = currentSelection();
    return sel ? (accents.get(sel.key) || null) : null;
  }

  // ---------------------------------------------------------------- применение
  const OWN_PROPS = ['--grad', '--grad-anim', '--grad-size', '--grad-shimmer-dur', '--grad-dur', '--grad-bg-veil', '--accent-text'];

  // «Вращение» и «Спектр» крутят --grad-rot / --grad-hue на самом элементе. Но если --grad
  // задан только на <body>, var(--grad-rot) подставляется уже там (значение 0) и потомки
  // наследуют готовую строку — градиент застывал. Поэтому для этих двух режимов
  // объявляем --grad на каждом элементе отдельно: тогда у каждого своя анимируемая копия.
  const perElementStyle = document.createElement('style');
  perElementStyle.id = 'pfc-grad-per-element';
  document.head.appendChild(perElementStyle);

  // элементы, у которых фон = var(--grad) (см. заливку в gradient.css)
  const PAINTED_SELECTORS = [
    '.launch',
    '.meter i',
    '.loader-btn.active',
    '.page button.primary',
    '.page .segmented button.active',
    ':is(#tab-mods, #tab-resourcepacks, #tab-shaders) .mod-toggle.on',
    ':is(#tab-mods, #tab-resourcepacks, #tab-shaders) .mod-card .update-one-btn',
    '.home-banner-bg',
    '.pfc-gprev'
  ].join(', ');

  function clearLayer() {
    perElementStyle.textContent = '';
    OWN_PROPS.forEach(p => body.style.removeProperty(p));
    delete body.dataset.grad;
    delete body.dataset.gradAnim;
    [...body.classList].filter(c => c.startsWith('grad-')).forEach(c => body.classList.remove(c));
  }

  // Возвращаем то, что выставил renderer.js для выбранной плашки темы.
  function restoreBase() {
    if (typeof applyTheme !== 'function') return;
    applyTheme(body.dataset.theme, $('customThemeInput')?.value);
  }

  function paintPalette(hex) {
    if (typeof applyCustomPalette === 'function') applyCustomPalette(hex);
  }

  function setAccentVars(css) {
    body.style.setProperty('--accent', css.accent);
    body.style.setProperty('--accent-hi', css.accentHi);
    body.style.setProperty('--accent-dim', css.accentDim);
    body.style.setProperty('--accent-text', css.accentText);
    paintPalette(css.accent);
  }

  function applyGradientLayer(cfg) {
    const css = G.buildCss(cfg, { relativeColor });
    const animated = !reduceMotion.matches;
    setAccentVars(css);
    body.style.setProperty('--grad', css.image);
    body.style.setProperty('--grad-size', animated ? css.size : '100% 100%');
    body.style.setProperty('--grad-anim', animated ? css.anim : 'none');
    body.style.setProperty('--grad-shimmer-dur', `${css.shimmerDur}s`);
    body.style.setProperty('--grad-dur', `${css.dur}s`);
    body.style.setProperty('--grad-bg-veil', `${css.bgVeil}%`);
    // значение css.image строится только из проверенных hex-цветов и чисел (см. sanitizeConfig).
    // Фон лаунчера крутится через transform/filter и этого не требует, так что объявляем
    // --grad только на тех элементах, которые реально красятся градиентом.
    if (animated && (css.effectiveAnimation === 'rotate' || css.effectiveAnimation === 'spectrum')) {
      perElementStyle.textContent = `body[data-grad="on"] :is(${PAINTED_SELECTORS}) { --grad: ${css.image}; }`;
    }
    body.dataset.grad = 'on';
    body.dataset.gradAnim = animated ? css.effectiveAnimation : 'none';
    G.TARGET_KEYS.forEach(k => body.classList.toggle(`grad-t-${k}`, !!css.config.targets[k]));
    body.classList.toggle('grad-glow', !!css.config.glow);
  }

  function applySolidLayer(color) {
    const css = G.buildCss({ stops: [color, color] });
    setAccentVars(css);
  }

  let applying = false;
  function apply() {
    if (applying || !body.dataset.theme) return; // тему renderer.js ещё не выставил
    applying = true;
    try {
      clearLayer();
      restoreBase();

      const override = currentOverride();
      if (override && override.kind === 'solid') applySolidLayer(override.color);
      else if (override && override.kind === 'gradient') applyGradientLayer(override.gradient);
      else if (body.dataset.theme === 'gradient') applyGradientLayer(globalCfg);

      updateSwatch();
    } finally {
      applying = false;
      observer.takeRecords(); // наши же правки data-theme внутри restoreBase не должны запускать apply повторно
    }
  }

  function updateSwatch() {
    document.documentElement.style.setProperty('--grad-preview', G.buildCss(globalCfg).swatch);
  }

  // свёрнутое окно не должно гонять анимации
  document.addEventListener('visibilitychange', () => {
    body.classList.toggle('anim-paused', document.hidden);
  });

  const observer = new MutationObserver(() => apply());
  observer.observe(body, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
  reduceMotion.addEventListener?.('change', () => { apply(); syncAll(); });

  // ---------------------------------------------------------------- сохранение
  function saveGlobalSoon() {
    clearTimeout(globalSaveTimer);
    globalSaveTimer = setTimeout(() => {
      api.setGradient(globalCfg).catch(e => console.warn('Не удалось сохранить градиент:', e));
    }, 300);
  }

  function setBuildAccent(sel, accent) {
    const clean = G.sanitizeAccent(accent);
    if (clean) accents.set(sel.key, clean); else accents.delete(sel.key);
    clearTimeout(saveTimers.get(sel.key));
    saveTimers.set(sel.key, setTimeout(() => {
      api.setInstanceAccent(sel.mcVersion, sel.loader, clean).catch(e => console.warn('Не удалось сохранить цвет сборки:', e));
    }, 300));
    apply();
    repaintTiles();
    syncAll();
  }

  function setGlobalConfig(cfg) {
    globalCfg = G.sanitizeConfig(cfg);
    // любое изменение в редакторе включает градиентную плашку — иначе человек крутит
    // ползунки и ничего не видит
    if (body.dataset.theme !== 'gradient') $('gradientThemeSwatch')?.click();
    apply();
    saveGlobalSoon();
    syncAll();
  }

  // ---------------------------------------------------------------- палитра из фона сборки
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function paletteFromCurrentBuild() {
    const sel = currentSelection();
    if (!sel) return null;
    const src = await api.getInstanceBackground(sel.mcVersion, sel.loader);
    if (!src) {
      toast('У этой сборки нет своего фона — сначала выбери его в меню «⋯»', 'warn');
      return null;
    }
    try {
      const img = await loadImage(src);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 64, 64);
      const palette = G.extractPalette(ctx.getImageData(0, 0, 64, 64).data, 3);
      if (!palette) toast('На фоне слишком мало ярких цветов', 'warn');
      return palette;
    } catch (e) {
      console.warn('Не удалось разобрать фон сборки:', e);
      toast('Не получилось взять цвета из фона', 'error');
      return null;
    }
  }

  // ---------------------------------------------------------------- редактор градиента
  // get()/set(cfg) — откуда брать и куда класть конфиг (общий или конкретной сборки).
  function createEditor({ get, set, previewText }) {
    const root = el('div', 'gedit');

    // предпросмотр
    const preview = el('div', 'pfc-gprev');
    const previewLabel = el('span', 'pfc-gprev-label', previewText || 'Предпросмотр');
    preview.appendChild(previewLabel);
    root.appendChild(preview);

    // пресеты
    const presetRow = el('div', 'gedit-row');
    presetRow.appendChild(el('div', 'gedit-label', 'Пресеты'));
    const presets = el('div', 'gpresets');
    G.PRESETS.forEach(p => {
      const chip = button('', 'gpreset', () => {
        const cur = get();
        set({ ...cur, stops: p.stops, animation: p.animation, type: p.type || 'linear', angle: p.angle ?? 135 });
      });
      const dot = el('i');
      dot.style.background = `linear-gradient(135deg, ${p.stops.join(', ')})`;
      chip.append(dot, document.createTextNode(p.name));
      presets.appendChild(chip);
    });
    presetRow.appendChild(presets);
    root.appendChild(presetRow);

    // цвета
    const stopsRow = el('div', 'gedit-row');
    stopsRow.appendChild(el('div', 'gedit-label', 'Цвета'));
    const stopsBox = el('div', 'gstops');
    stopsRow.appendChild(stopsBox);
    root.appendChild(stopsRow);
    let stopInputs = [];

    const addBtn = button('+', 'gstop-btn', () => {
      const cur = get();
      if (cur.stops.length >= G.MAX_STOPS) return;
      const last = cur.stops[cur.stops.length - 1];
      set({ ...cur, stops: [...cur.stops, G.color.mix(last, cur.stops[0], 0.5)] });
    }, 'Добавить цвет');
    const delBtn = button('−', 'gstop-btn', () => {
      const cur = get();
      if (cur.stops.length <= G.MIN_STOPS) return;
      set({ ...cur, stops: cur.stops.slice(0, -1) });
    }, 'Убрать последний цвет');

    function rebuildStops(count) {
      stopsBox.replaceChildren();
      stopInputs = [];
      for (let i = 0; i < count; i++) {
        const input = el('input', 'gstop');
        input.type = 'color';
        input.setAttribute('aria-label', `Цвет ${i + 1}`);
        input.addEventListener('input', () => {
          const cur = get();
          const stops = cur.stops.slice();
          stops[i] = input.value;
          set({ ...cur, stops });
        });
        stopInputs.push(input);
        stopsBox.appendChild(input);
      }
      stopsBox.append(addBtn, delBtn);
    }

    // тип + угол
    const shapeRow = el('div', 'gedit-row');
    shapeRow.appendChild(el('div', 'gedit-label', 'Форма'));
    const typeSeg = el('div', 'segmented');
    typeSeg.setAttribute('role', 'group');
    const typeBtns = G.TYPES.map(t => {
      const b = button(TYPE_LABELS[t], '', () => set({ ...get(), type: t }));
      b.dataset.type = t;
      typeSeg.appendChild(b);
      return b;
    });
    const angle = el('input');
    angle.type = 'range'; angle.min = '0'; angle.max = '360'; angle.step = '5';
    angle.setAttribute('aria-label', 'Угол градиента');
    const angleVal = el('span', 'gedit-val');
    angle.addEventListener('input', () => set({ ...get(), angle: Number(angle.value) }));
    shapeRow.append(typeSeg, angle, angleVal);
    root.appendChild(shapeRow);

    // анимация
    const animRow = el('div', 'gedit-row');
    animRow.appendChild(el('div', 'gedit-label', 'Анимация'));
    const animSeg = el('div', 'segmented');
    animSeg.setAttribute('role', 'group');
    const animBtns = G.ANIMATIONS.map(a => {
      const b = button(ANIM_LABELS[a][0], '', () => set({ ...get(), animation: a }), ANIM_LABELS[a][1]);
      b.dataset.anim = a;
      if (a === 'spectrum' && !relativeColor) b.disabled = true;
      animSeg.appendChild(b);
      return b;
    });
    animRow.appendChild(animSeg);
    root.appendChild(animRow);

    const speedRow = el('div', 'gedit-row');
    speedRow.appendChild(el('div', 'gedit-label', 'Скорость'));
    const speed = el('input');
    speed.type = 'range'; speed.min = '1'; speed.max = '10'; speed.step = '1';
    speed.setAttribute('aria-label', 'Скорость анимации');
    const speedVal = el('span', 'gedit-val');
    speed.addEventListener('input', () => set({ ...get(), speed: Number(speed.value) }));
    speedRow.append(speed, speedVal);
    root.appendChild(speedRow);

    // где применять
    const targetsRow = el('div', 'gedit-row');
    targetsRow.appendChild(el('div', 'gedit-label', 'Где красить'));
    const checks = el('div', 'gedit-checks');
    const checkInputs = {};
    G.TARGET_KEYS.forEach(k => {
      const label = el('label', 'gcheck');
      const input = el('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        const cur = get();
        set({ ...cur, targets: { ...cur.targets, [k]: input.checked } });
      });
      checkInputs[k] = input;
      label.append(input, document.createTextNode(TARGET_LABELS[k]));
      checks.appendChild(label);
    });
    const glowLabel = el('label', 'gcheck');
    const glowInput = el('input');
    glowInput.type = 'checkbox';
    glowInput.addEventListener('change', () => set({ ...get(), glow: glowInput.checked }));
    glowLabel.append(glowInput, document.createTextNode('Свечение у кнопки запуска'));
    checks.appendChild(glowLabel);
    targetsRow.appendChild(checks);
    root.appendChild(targetsRow);

    const bgRow = el('div', 'gedit-row');
    bgRow.appendChild(el('div', 'gedit-label', 'Яркость фона'));
    const bgStrength = el('input');
    bgStrength.type = 'range'; bgStrength.min = '10'; bgStrength.max = '100'; bgStrength.step = '5';
    bgStrength.setAttribute('aria-label', 'Насколько градиент заметен на фоне лаунчера');
    const bgStrengthVal = el('span', 'gedit-val');
    bgStrength.addEventListener('input', () => set({ ...get(), bgStrength: Number(bgStrength.value) }));
    bgRow.append(bgStrength, bgStrengthVal);
    root.appendChild(bgRow);

    // инструменты
    const toolsRow = el('div', 'gedit-row');
    toolsRow.appendChild(el('div', 'gedit-label', 'Быстро'));
    const tools = el('div', 'gedit-tools');
    tools.appendChild(button('Случайный', '', () => {
      const cur = get();
      const r = G.randomConfig();
      set({ ...r, targets: cur.targets, glow: cur.glow, bgStrength: cur.bgStrength });
    }, 'Подобрать гармоничный градиент случайным образом'));
    tools.appendChild(button('Цвета из фона сборки', '', async () => {
      const palette = await paletteFromCurrentBuild();
      if (palette) set({ ...get(), stops: palette });
    }, 'Взять основные цвета из фона выбранной сборки'));
    toolsRow.appendChild(tools);
    root.appendChild(toolsRow);

    // код для друзей
    const shareRow = el('div', 'gedit-row');
    shareRow.appendChild(el('div', 'gedit-label', 'Код'));
    const share = el('div', 'gedit-share');
    const shareInput = el('input');
    shareInput.type = 'text';
    shareInput.spellcheck = false;
    shareInput.placeholder = 'Вставь код друга: PFC1:…';
    shareInput.setAttribute('aria-label', 'Код градиента');
    const copyBtn = button('Копировать', '', async () => {
      const code = G.encodeShare(get());
      try { await navigator.clipboard.writeText(code); }
      catch { shareInput.value = code; shareInput.select(); document.execCommand('copy'); }
      toast('Код скопирован — можно отправить другу');
    });
    const importBtn = button('Применить', '', () => {
      try {
        const cfg = G.decodeShare(shareInput.value);
        set(cfg);
        shareInput.blur();
        toast('Градиент применён');
      } catch (e) {
        toast(e.message || 'Не получилось прочитать код', 'error');
      }
    });
    shareInput.addEventListener('keydown', e => { if (e.key === 'Enter') importBtn.click(); });
    share.append(shareInput, copyBtn, importBtn);
    shareRow.appendChild(share);
    root.appendChild(shareRow);

    // ---- синхронизация интерфейса с конфигом
    function sync() {
      const cfg = G.sanitizeConfig(get());
      const css = G.buildCss(cfg, { relativeColor });
      const animated = !reduceMotion.matches;

      preview.style.setProperty('--grad', css.image);
      preview.style.setProperty('--grad-size', animated ? css.size : '100% 100%');
      preview.style.setProperty('--grad-anim', animated ? css.anim : 'none');
      preview.style.setProperty('--grad-shimmer-dur', `${css.shimmerDur}s`);
      preview.style.setProperty('--prev-text', css.accentText);
      preview.dataset.anim = animated ? css.effectiveAnimation : 'none';

      if (stopInputs.length !== cfg.stops.length) rebuildStops(cfg.stops.length);
      stopInputs.forEach((input, i) => { if (input.value !== cfg.stops[i]) input.value = cfg.stops[i]; });
      addBtn.disabled = cfg.stops.length >= G.MAX_STOPS;
      delBtn.disabled = cfg.stops.length <= G.MIN_STOPS;

      typeBtns.forEach(b => b.classList.toggle('active', b.dataset.type === cfg.type));
      angle.value = String(cfg.angle);
      angle.disabled = cfg.type === 'radial';
      angleVal.textContent = cfg.type === 'radial' ? '—' : `${cfg.angle}°`;

      animBtns.forEach(b => b.classList.toggle('active', b.dataset.anim === cfg.animation));
      speed.value = String(cfg.speed);
      speed.disabled = cfg.animation === 'none';
      speedVal.textContent = `${cfg.speed}/10`;

      G.TARGET_KEYS.forEach(k => { checkInputs[k].checked = !!cfg.targets[k]; });
      glowInput.checked = !!cfg.glow;
      bgStrength.value = String(cfg.bgStrength);
      bgStrength.disabled = !cfg.targets.background;
      bgStrengthVal.textContent = `${cfg.bgStrength}%`;

      if (document.activeElement !== shareInput) shareInput.value = G.encodeShare(cfg);
    }

    rebuildStops(get().stops.length);
    sync();
    return { root, sync };
  }

  // ---------------------------------------------------------------- общий градиент (настройки)
  const globalHost = $('gradientEditorHost');
  let globalEditor = null;
  if (globalHost) {
    globalEditor = createEditor({
      get: () => globalCfg,
      set: setGlobalConfig,
      previewText: 'Градиент лаунчера'
    });
    globalHost.appendChild(globalEditor.root);
  }

  // ---------------------------------------------------------------- цвет выбранной сборки (настройки)
  const buildHost = $('buildAccentHost');
  let buildUi = null;

  function buildSelectionLabel() {
    const sel = currentSelection();
    return sel ? `Minecraft ${cleanVersion(sel.mcVersion)} · ${LOADER_NAMES[sel.loader] || sel.loader}` : 'Сборка не выбрана';
  }

  function mountBuildAccent() {
    if (!buildHost) return;
    const root = el('div', 'gedit');

    const head = el('div', 'build-accent-head');
    head.appendChild(el('div', 'gedit-label', 'Сборка'));
    const nameEl = el('div', 'build-accent-name');
    head.appendChild(nameEl);
    root.appendChild(head);

    const modeRow = el('div', 'gedit-row');
    modeRow.appendChild(el('div', 'gedit-label', 'Цвет'));
    const seg = el('div', 'segmented');
    seg.setAttribute('role', 'group');
    const MODES = [['inherit', 'Как везде'], ['solid', 'Свой цвет'], ['gradient', 'Свой градиент']];
    const modeBtns = MODES.map(([mode, label]) => {
      const b = button(label, '', () => switchMode(mode));
      b.dataset.mode = mode;
      seg.appendChild(b);
      return b;
    });
    modeRow.appendChild(seg);
    root.appendChild(modeRow);

    // одиночный цвет
    const solidBox = el('div', 'build-accent-solid');
    solidBox.appendChild(el('div', 'gedit-label', 'Оттенок'));
    const solidInput = el('input', 'gstop');
    solidInput.type = 'color';
    solidInput.setAttribute('aria-label', 'Цвет сборки');
    solidInput.addEventListener('input', () => {
      const sel = currentSelection();
      if (sel) setBuildAccent(sel, { kind: 'solid', color: solidInput.value });
    });
    solidBox.appendChild(solidInput);
    root.appendChild(solidBox);

    // градиент сборки: тот же редактор, но читает/пишет accent этой сборки
    const gradBox = el('div');
    const gradEditor = createEditor({
      get: () => {
        const o = currentOverride();
        return o && o.kind === 'gradient' ? o.gradient : globalCfg;
      },
      set: cfg => {
        const sel = currentSelection();
        if (sel) setBuildAccent(sel, { kind: 'gradient', gradient: cfg });
      },
      previewText: 'Эта сборка'
    });
    gradBox.appendChild(gradEditor.root);
    root.appendChild(gradBox);

    const hint = el('p', 'gedit-hint', 'Цвет запоминается за конкретной версией и загрузчиком и включается автоматически, когда ты выбираешь эту сборку.');
    root.appendChild(hint);

    function switchMode(mode) {
      const sel = currentSelection();
      if (!sel) return;
      const o = currentOverride();
      if (mode === 'inherit') setBuildAccent(sel, null);
      else if (mode === 'solid') {
        setBuildAccent(sel, { kind: 'solid', color: (o && o.kind === 'solid') ? o.color : G.buildCss(globalCfg).accent });
      } else {
        setBuildAccent(sel, { kind: 'gradient', gradient: (o && o.kind === 'gradient') ? o.gradient : globalCfg });
      }
    }

    function sync() {
      const sel = currentSelection();
      const o = currentOverride();
      const mode = o ? o.kind : 'inherit';
      nameEl.textContent = buildSelectionLabel();
      modeBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
        b.disabled = !sel;
      });
      solidBox.style.display = mode === 'solid' ? '' : 'none';
      gradBox.style.display = mode === 'gradient' ? '' : 'none';
      if (mode === 'solid' && solidInput.value !== o.color) solidInput.value = o.color;
      if (mode === 'gradient') gradEditor.sync();
    }

    buildHost.appendChild(root);
    sync();
    return { sync };
  }
  buildUi = mountBuildAccent();

  function syncAll() {
    globalEditor?.sync();
    buildUi?.sync();
  }

  // ---------------------------------------------------------------- плитки «Недавние сборки»
  function paintTile(btn) {
    const a = accents.get(btn.dataset.accentKey);
    if (!a) {
      delete btn.dataset.accent;
      btn.style.removeProperty('--rb-accent');
      return;
    }
    btn.dataset.accent = a.kind;
    btn.style.setProperty('--rb-accent', a.kind === 'solid' ? a.color : G.buildCss(a.gradient).swatch);
  }

  function repaintTiles() {
    document.querySelectorAll('#recentGrid .rb[data-accent-key]').forEach(paintTile);
  }

  // home.js вызывает это при отрисовке каждой плитки
  window.PFCAccent = {
    decorateTile(btn, mcVersion, loader, buildId) {
      btn.dataset.accentKey = buildId ? `build-${buildId}` : keyOf(mcVersion, loader);
      paintTile(btn);
    }
  };

  // ---------------------------------------------------------------- пункт меню «Цвет сборки…»
  $('buildColorBtn')?.addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="settings"]')?.click();
    setTimeout(() => {
      if (!buildHost) return;
      buildHost.scrollIntoView({ behavior: 'smooth', block: 'center' });
      buildHost.classList.add('build-accent-flash');
      setTimeout(() => buildHost.classList.remove('build-accent-flash'), 1200);
    }, 120);
  });

  // ---------------------------------------------------------------- смена выбранной сборки
  let lastKey = null;
  function onSelectionMaybeChanged() {
    const sel = currentSelection();
    const key = sel ? sel.key : null;
    if (key === lastKey) return;
    lastKey = key;
    apply();
    buildUi?.sync();
  }
  versionSelect?.addEventListener('change', onSelectionMaybeChanged);
  loaderSelect?.addEventListener('change', onSelectionMaybeChanged);
  // список версий заполняется программно и 'change' при этом не гарантирован,
  // поэтому дополнительно сверяем выбор раз в пару сотен миллисекунд — это дёшево
  setInterval(() => { if (!document.hidden) onSelectionMaybeChanged(); }, 500);

  // ---------------------------------------------------------------- загрузка сохранённого
  api.getGradient().then(cfg => {
    globalCfg = G.sanitizeConfig(cfg);
    updateSwatch();
    apply();
    syncAll();
  }).catch(e => console.warn('Не удалось загрузить градиент:', e));

  api.listInstanceAccents().then(map => {
    Object.entries(map || {}).forEach(([key, accent]) => {
      const clean = G.sanitizeAccent(accent);
      if (clean) accents.set(key, clean);
    });
    apply();
    repaintTiles();
    syncAll();
  }).catch(e => console.warn('Не удалось загрузить цвета сборок:', e));

  updateSwatch();
  onSelectionMaybeChanged();
})();
