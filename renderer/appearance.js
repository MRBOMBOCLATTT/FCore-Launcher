(() => {
  'use strict';

  const api = window.api;
  const A = window.PFCAppearance;
  if (!api || !A) return;

  const $ = id => document.getElementById(id);
  const body = document.body;

  const COLORS = [
    { key: 'accent', label: 'Акцент', variable: '--accent' },
    { key: 'bg', label: 'Фон', variable: '--bg' },
    { key: 'bg2', label: 'Боковое меню', variable: '--bg-2' },
    { key: 'panel', label: 'Панели', variable: '--panel' },
    { key: 'panel2', label: 'Кнопки и поля', variable: '--panel-2' },
    { key: 'border', label: 'Границы', variable: '--border' },
    { key: 'text', label: 'Текст', variable: '--text' },
    { key: 'textDim', label: 'Приглушённый текст', variable: '--text-dim' }
  ];

  const toast = (msg, type) => {
    if (typeof showToast === 'function') showToast(msg, type);
  };

  let cfg = A.cloneDefault();
  let userPresets = [];
  let saveTimer = null;
  let lastScale = null;
  let customFontUrl = '';

  const styleEl = document.createElement('style');
  styleEl.id = 'fcApStyle';
  document.head.appendChild(styleEl);

  const colorProbe = document.createElement('canvas').getContext('2d');

  function toHex(value, fallback) {
    if (!value) return fallback;
    colorProbe.fillStyle = '#000000';
    colorProbe.fillStyle = value;
    const out = colorProbe.fillStyle;
    return /^#[0-9a-f]{6}$/i.test(out) ? out : fallback;
  }

  function toFileUrl(filePath) {
    if (!filePath) return '';
    const normal = String(filePath).replace(/\\/g, '/');
    return encodeURI(/^[a-z]:/i.test(normal) ? `file:///${normal}` : `file://${normal}`);
  }

  function currentMode() {
    return body.dataset.mode === 'light' ? 'light' : 'dark';
  }

  function themeColors() {
    const had = body.hasAttribute('data-fc-ap');
    if (had) body.removeAttribute('data-fc-ap');
    const cs = getComputedStyle(body);
    const out = {};
    COLORS.forEach(c => { out[c.key] = toHex(cs.getPropertyValue(c.variable).trim(), '#808080'); });
    if (had) body.setAttribute('data-fc-ap', '');
    return out;
  }

  function apply() {
    const custom = !A.isDefault(cfg);
    if (custom) body.setAttribute('data-fc-ap', '');
    else body.removeAttribute('data-fc-ap');
    if (cfg.sidebarStyle === 'compact') body.setAttribute('data-fc-side', 'compact');
    else body.removeAttribute('data-fc-side');
    styleEl.textContent = A.buildCss(cfg, toFileUrl(cfg.bgImage), cfg.panelOpacity < 100 ? themeColors() : null, customFontUrl);
    if (lastScale !== cfg.uiScale && typeof api.setUiScale === 'function') {
      lastScale = cfg.uiScale;
      try { api.setUiScale(cfg.uiScale); } catch { /* масштаб недоступен */ }
    }
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.setAppearance(cfg).catch(e => console.warn('Не удалось сохранить оформление:', e));
    }, 250);
  }

  function update(patch, options = {}) {
    cfg = A.sanitizeConfig({ ...cfg, ...patch });
    apply();
    persist();
    if (!options.skipControls) syncControls();
    renderPresets();
  }

  function setMode(mode) {
    if (typeof applyThemeMode === 'function') applyThemeMode(mode);
    api.setThemeMode(mode).catch(() => {});
  }

  // ---------------------------------------------------------------- пресеты
  function allPresets() {
    return [...A.PRESETS, ...userPresets.map(p => ({ ...p, builtin: false }))];
  }

  function isActivePreset(preset) {
    if (preset.mode && preset.mode !== currentMode()) return false;
    return JSON.stringify(A.withoutImage(cfg)) === JSON.stringify(A.withoutImage(preset.config));
  }

  function previewVars(preset, base) {
    const c = preset.config.colors;
    const pick = key => c[key] || base[key];
    return [
      `--pv-bg:${pick('bg')}`, `--pv-bg2:${pick('bg2')}`, `--pv-panel:${pick('panel')}`,
      `--pv-border:${pick('border')}`, `--pv-text:${pick('text')}`, `--pv-dim:${pick('textDim')}`,
      `--pv-accent:${pick('accent')}`, `--pv-radius:${Math.min(preset.config.radius, 16)}`
    ].join(';');
  }

  function renderPresets() {
    const host = $('apPresets');
    if (!host) return;
    const base = themeColors();
    host.textContent = '';
    allPresets().forEach(preset => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'ap-preset' + (isActivePreset(preset) ? ' active' : '');
      card.dataset.id = preset.id;

      const mini = document.createElement('div');
      mini.className = 'ap-mini';
      mini.setAttribute('style', previewVars(preset, base));
      mini.innerHTML = '<div class="ap-mini-side"><i></i><i></i><i></i></div><div class="ap-mini-main"><div class="ap-mini-card"><div class="ap-mini-line"></div><div class="ap-mini-line dim"></div></div><div class="ap-mini-btn"></div></div>';

      const name = document.createElement('div');
      name.className = 'ap-preset-name';
      name.textContent = preset.name;
      if (!preset.builtin) {
        const tag = document.createElement('span');
        tag.className = 'ap-preset-tag';
        tag.textContent = 'свой';
        name.appendChild(tag);
      }

      card.append(mini, name);
      card.addEventListener('click', () => applyPreset(preset));

      if (!preset.builtin) {
        const del = document.createElement('span');
        del.className = 'ap-preset-del';
        del.title = 'Удалить пресет';
        del.textContent = '×';
        del.addEventListener('click', async e => {
          e.stopPropagation();
          if (typeof customConfirm === 'function' && !(await customConfirm(`Удалить пресет «${preset.name}»?`))) return;
          userPresets = await api.deleteAppearancePreset(preset.id);
          renderPresets();
        });
        card.appendChild(del);
      }
      host.appendChild(card);
    });
  }

  function applyPreset(preset) {
    cfg = A.sanitizeConfig({ ...preset.config, bgImage: cfg.bgImage });
    apply();
    persist();
    if (preset.mode && preset.mode !== currentMode()) setMode(preset.mode);
    syncControls();
    renderPresets();
  }

  async function saveCurrentPreset() {
    const input = $('apPresetName');
    const name = input.value.replace(/\s+/g, ' ').trim();
    if (!name) {
      toast('Введите название пресета', 'warn');
      input.focus();
      return;
    }
    const existing = userPresets.find(p => p.name.toLowerCase() === name.toLowerCase());
    userPresets = await api.saveAppearancePreset({
      id: existing ? existing.id : undefined,
      name,
      mode: currentMode(),
      config: A.withoutImage(cfg)
    });
    input.value = '';
    renderPresets();
    toast(existing ? 'Пресет обновлён' : 'Пресет сохранён', 'success');
  }

  // ---------------------------------------------------------------- цвета
  function buildColorRows() {
    const host = $('apColors');
    if (!host) return;
    host.textContent = '';
    COLORS.forEach(def => {
      const row = document.createElement('div');
      row.className = 'ap-color';
      row.dataset.key = def.key;

      const label = document.createElement('div');
      label.className = 'ap-color-label';
      label.textContent = def.label;

      const hex = document.createElement('span');
      hex.className = 'ap-color-hex';

      const input = document.createElement('input');
      input.type = 'color';
      input.setAttribute('aria-label', def.label);
      input.addEventListener('input', () => {
        update({ colors: { ...cfg.colors, [def.key]: input.value } }, { skipControls: true });
        row.classList.remove('is-auto');
        hex.textContent = input.value;
      });

      const auto = document.createElement('button');
      auto.type = 'button';
      auto.className = 'ap-color-auto';
      auto.textContent = 'Авто';
      auto.title = 'Вернуть цвет из выбранной темы';
      auto.addEventListener('click', () => update({ colors: { ...cfg.colors, [def.key]: null } }));

      row.append(label, hex, input, auto);
      host.appendChild(row);
    });
  }

  function syncColors() {
    const base = themeColors();
    COLORS.forEach(def => {
      const row = document.querySelector(`.ap-color[data-key="${def.key}"]`);
      if (!row) return;
      const value = cfg.colors[def.key];
      const input = row.querySelector('input');
      const shown = value || base[def.key];
      if (document.activeElement !== input) input.value = shown;
      row.querySelector('.ap-color-hex').textContent = value || 'тема';
      row.classList.toggle('is-auto', !value);
    });
  }

  // ---------------------------------------------------------------- прочие контролы
  function bindRange(id, key, format) {
    const input = $(id);
    const out = $(`${id}Out`);
    if (!input) return;
    input.addEventListener('input', () => {
      update({ [key]: Number(input.value) }, { skipControls: true });
      out.textContent = format(cfg[key]);
    });
  }

  function bindSegmented(id, key, onChange) {
    const host = $(id);
    if (!host) return;
    host.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        if (onChange) onChange(btn.dataset.value || btn.dataset.mode);
        else update({ [key]: btn.dataset.value });
      });
    });
  }

  function setRange(id, value, format) {
    const input = $(id);
    if (!input) return;
    input.value = value;
    $(`${id}Out`).textContent = format(value);
  }

  function setSegmented(id, value, attr = 'value') {
    const host = $(id);
    if (!host) return;
    host.querySelectorAll('button').forEach(btn => btn.classList.toggle('active', btn.dataset[attr] === value));
  }

  const pct = v => `${v}%`;
  const px = v => `${v} px`;

  function syncControls() {
    syncColors();
    setRange('apRadius', cfg.radius, px);
    setRange('apScale', cfg.uiScale, pct);
    setRange('apSideWidth', cfg.sidebarWidth, px);
    setRange('apSideOpacity', cfg.sidebarOpacity, pct);
    setRange('apPanelOpacity', cfg.panelOpacity, pct);
    setRange('apBgDim', cfg.bgDim, pct);
    setRange('apBgBlur', cfg.bgBlur, px);
    setSegmented('apMode', currentMode(), 'mode');
    setSegmented('apSidePos', cfg.sidebarPosition);
    setSegmented('apSideStyle', cfg.sidebarStyle);
    $('apSideWidthRow').style.display = cfg.sidebarStyle === 'compact' ? 'none' : '';
    $('apFont').value = cfg.font;
    $('apFontCustom').hidden = cfg.font !== 'custom' || !!cfg.fontCustomFile;
    if (document.activeElement !== $('apFontCustom')) $('apFontCustom').value = cfg.fontCustom;
    $('apFontFileLabel').textContent = cfg.fontCustomFile ? cfg.fontCustomFile : 'Файл не выбран';
    $('apReduceMotion').checked = cfg.reduceMotion;
    const name = cfg.bgImage ? cfg.bgImage.split(/[\\/]/).pop() : '';
    $('apBgLabel').textContent = name || 'Не выбрана';
    $('apBgClear').disabled = !cfg.bgImage;
  }

  async function resetAll() {
    if (typeof customConfirm === 'function' && !(await customConfirm('Сбросить всё оформление к стандартному?'))) return;
    await api.clearAppearanceBackground().catch(() => {});
    cfg = A.cloneDefault();
    customFontUrl = '';
    apply();
    persist();
    syncControls();
    renderPresets();
    toast('Оформление сброшено', 'success');
  }

  function showImport(show) {
    $('apImportBox').hidden = !show;
    $('apImportMsg').textContent = '';
    if (show) {
      $('apImportText').value = '';
      $('apImportText').focus();
    }
  }

  function applyImport() {
    const preset = A.decodeShare($('apImportText').value);
    if (!preset) {
      $('apImportMsg').textContent = 'Не удалось прочитать код';
      return;
    }
    applyPreset(preset);
    $('apPresetName').value = preset.name;
    showImport(false);
    toast(`Применено оформление «${preset.name}». Можно сохранить его как пресет.`, 'success');
  }

  async function copyShare() {
    const code = A.encodeShare({ name: $('apPresetName').value.trim() || 'Моё оформление', mode: currentMode(), config: A.withoutImage(cfg) });
    try {
      await navigator.clipboard.writeText(code);
      toast('Код оформления скопирован', 'success');
    } catch {
      showImport(true);
      $('apImportText').value = code;
      $('apImportMsg').textContent = 'Скопируйте код вручную';
    }
  }

  function init() {
    buildColorRows();

    bindRange('apRadius', 'radius', px);
    bindRange('apScale', 'uiScale', pct);
    bindRange('apSideWidth', 'sidebarWidth', px);
    bindRange('apSideOpacity', 'sidebarOpacity', pct);
    bindRange('apPanelOpacity', 'panelOpacity', pct);
    bindRange('apBgDim', 'bgDim', pct);
    bindRange('apBgBlur', 'bgBlur', px);

    bindSegmented('apSidePos', 'sidebarPosition');
    bindSegmented('apSideStyle', 'sidebarStyle');
    bindSegmented('apMode', null, mode => { setMode(mode); syncControls(); renderPresets(); });

    $('apFont').addEventListener('change', e => update({ font: e.target.value }));
    $('apFontPick').addEventListener('click', async () => {
      const button = $('apFontPick');
      button.disabled = true;
      try {
        const picked = await api.pickAppearanceFont();
        if (!picked) return;
        const url = await api.getAppearanceFontUrl(picked.fileName);
        if (!url) throw new Error('Не удалось открыть выбранный файл шрифта');
        customFontUrl = url;
        update({ font: 'custom', fontCustom: picked.familyName, fontCustomFile: picked.fileName });
        toast(`Шрифт «${picked.familyName}» подключён`, 'success');
      } catch (error) {
        toast(error.message || String(error), 'error');
      } finally {
        button.disabled = false;
      }
    });
    $('apFontCustom').addEventListener('input', e => update({ font: 'custom', fontCustom: e.target.value }, { skipControls: true }));
    $('apReduceMotion').addEventListener('change', e => update({ reduceMotion: e.target.checked }));

    $('apBgPick').addEventListener('click', async () => {
      const picked = await api.pickAppearanceBackground();
      if (picked) update({ bgImage: picked });
    });
    $('apBgClear').addEventListener('click', async () => {
      await api.clearAppearanceBackground();
      update({ bgImage: null });
    });

    $('apPresetSave').addEventListener('click', saveCurrentPreset);
    $('apPresetName').addEventListener('keydown', e => { if (e.key === 'Enter') saveCurrentPreset(); });
    $('apCopyBtn').addEventListener('click', copyShare);
    $('apImportBtn').addEventListener('click', () => showImport($('apImportBox').hidden));
    $('apImportCancel').addEventListener('click', () => showImport(false));
    $('apImportApply').addEventListener('click', applyImport);
    $('apResetBtn').addEventListener('click', resetAll);

    new MutationObserver(() => { apply(); syncControls(); renderPresets(); })
      .observe(body, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });

    document.querySelector('.tab-btn[data-tab="appearance"]')?.addEventListener('click', () => { syncControls(); renderPresets(); });

    Promise.all([api.getAppearance(), api.listAppearancePresets()]).then(async ([saved, presets]) => {
      customFontUrl = saved?.fontCustomFile ? await api.getAppearanceFontUrl(saved.fontCustomFile).catch(() => null) || '' : '';
      if (saved?.fontCustomFile && !customFontUrl) saved.fontCustomFile = null;
      cfg = A.sanitizeConfig(saved);
      userPresets = Array.isArray(presets) ? presets : [];
      apply();
      syncControls();
      renderPresets();
    }).catch(e => console.warn('Не удалось загрузить оформление:', e));

    syncControls();
    renderPresets();
  }

  init();
})();
