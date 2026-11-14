// Вкладка "Сборки": именованные независимые инстансы.
// Грузится после renderer.js и использует его глобальные функции и элементы
// (versionSelect, loaderSelect, switchTab, showToast, customConfirm, askForText, escHtml).
window.fcBuilds = (() => {
  const api = window.api;
  const grid = document.getElementById('buildsGrid');
  const createBtn = document.getElementById('buildCreateBtn');
  const importBtn = document.getElementById('buildImportMrpackBtn');
  const chip = document.getElementById('contentBuildChip');

  const LOADERS = [
    ['fabric', 'Fabric'],
    ['forge', 'Forge'],
    ['neoforge', 'NeoForge'],
    ['vanilla', 'Vanilla']
  ];
  const loaderName = id => (LOADERS.find(l => l[0] === id) || [id, id])[1];

  const meta = window.PFCBuildMeta;
  const searchInput = document.getElementById('buildsSearch');
  const groupsBar = document.getElementById('buildsGroups');
  const filterBox = document.getElementById('buildsFilter');

  let builds = [];
  let groupFilter = null;
  let query = '';
  let applying = false;
  window.__activeBuild = null;

  function formatPlaytime(ms) {
    if (!ms) return 'ещё не запускалась';
    const minutes = Math.round(ms / 60000);
    const t = window.i18n.t;
    if (minutes < 60) return t(`играли ${Math.max(1, minutes)} мин`);
    return t(`играли ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`);
  }

  function formatLastPlayed(ts) {
    if (!ts) return '';
    return `${window.i18n.t(', последний запуск')} ${new Date(ts).toLocaleDateString(window.i18n.locale)}`;
  }

  function updateChips() {
    const active = window.__activeBuild;
    chip.innerHTML = active
      ? `Сборка: <b>${escHtml(active.name)}</b>`
      : 'Без сборки: файлы лежат в папке версии и загрузчика';
    if (typeof renderCurrentTargetBadge === 'function') renderCurrentTargetBadge();
    if (typeof updateHeroTitle === 'function') updateHeroTitle();
  }

  function cardHtml(b) {
    const accent = b.accent && /^#[0-9a-f]{3,8}$/i.test(b.accent) ? ` style="--build-accent:${b.accent}"` : '';
    return `
      <article class="build-card${b.active ? ' is-active' : ''}" data-id="${escHtml(b.id)}"${accent}>
        <div class="build-card-head">
          <h3 class="build-card-name">${escHtml(b.name)}</h3>
          ${b.active ? '<span class="build-card-badge">Выбрана</span>' : ''}
        </div>
        <div class="build-card-tags">
          <span class="chip chip-accent">${escHtml(b.mcVersion)}</span>
          <span class="chip">${escHtml(loaderName(b.loader))}</span>
          ${(b.tags || []).map(tag => `<span class="chip chip-tag">#${escHtml(tag)}</span>`).join('')}
        </div>
        <div class="build-card-stats">
          <div class="build-stat"><b>${b.modsCount}</b><span>модов</span></div>
          <div class="build-stat"><b>${b.packsCount}</b><span>ресурспаков</span></div>
          <div class="build-stat"><b>${b.shadersCount}</b><span>шейдеров</span></div>
        </div>
        <div class="build-card-meta">${formatPlaytime(b.playtimeMs)}${formatLastPlayed(b.lastPlayedAt)}</div>
        <div class="build-card-foot">
          <button class="${b.active ? 'secondary' : 'primary'} build-main-btn" data-action="select">${b.active ? 'Играть' : 'Выбрать'}</button>
          <button class="build-icon-btn" data-action="rename" title="Переименовать" aria-label="Переименовать"><span class="ico" style="--ico-src:url('icons/pen.svg')"></span></button>
          <button class="build-icon-btn" data-action="duplicate" title="Дублировать" aria-label="Дублировать"><span class="ico" style="--ico-src:url('icons/plus.svg')"></span></button>
          <button class="build-icon-btn" data-action="folder" title="Открыть папку" aria-label="Открыть папку"><span class="ico" style="--ico-src:url('icons/folder.svg')"></span></button>
          <button class="build-icon-btn danger" data-action="delete" title="Удалить" aria-label="Удалить"><span class="ico" style="--ico-src:url('icons/x.svg')"></span></button>
        </div>
        <div class="build-card-tools">
          <button class="build-link-btn" data-action="migrate">Перенести на версию…</button>
          <button class="build-link-btn" data-action="compare">Сравнить…</button>
          <button class="build-link-btn" data-action="share">Поделиться…</button>
          <button class="build-link-btn" data-action="meta">Группа и теги…</button>
        </div>
      </article>`;
  }

  function defaultCardHtml(noneActive) {
    return `
      <article class="build-card${noneActive ? ' is-active' : ''}" data-id="">
        <div class="build-card-head">
          <h3 class="build-card-name">Без сборки</h3>
          ${noneActive ? '<span class="build-card-badge">Выбрана</span>' : ''}
        </div>
        <div class="build-card-meta">Стандартный режим. Файлы лежат в папке версии и загрузчика, которые выбраны на вкладке «Главная».</div>
        <div class="build-card-foot">
          <button class="${noneActive ? 'secondary' : 'primary'} build-main-btn" data-action="select-none"${noneActive ? ' disabled' : ''}>${noneActive ? 'Выбрано' : 'Выбрать'}</button>
        </div>
        <div class="build-card-tools">
          <button class="build-link-btn" data-action="from-version">Перенести версию с модами в сборку…</button>
        </div>
      </article>`;
  }

  function renderFilter() {
    const groups = meta.listGroups(builds);
    filterBox.style.display = builds.length ? '' : 'none';
    if (groupFilter !== null && groupFilter !== '' && !groups.some(g => g.toLowerCase() === groupFilter.toLowerCase())) groupFilter = null;
    if (groupFilter === '' && !groups.length) groupFilter = null;
    const looseCount = builds.filter(b => !b.group).length;
    const chipHtml = (value, label, count) => {
      const on = groupFilter === value || (value !== null && groupFilter !== null && value !== '' && groupFilter.toLowerCase() === value.toLowerCase());
      return `<button type="button" class="builds-group-chip${on ? ' is-on' : ''}" data-group="${value === null ? '__all' : escHtml(value)}">${escHtml(label)} <b>${count}</b></button>`;
    };
    groupsBar.innerHTML = groups.length
      ? [chipHtml(null, window.i18n.t('Все'), builds.length),
        ...groups.map(g => chipHtml(g, g, builds.filter(b => (b.group || '').toLowerCase() === g.toLowerCase()).length)),
        looseCount ? chipHtml('', window.i18n.t('Без группы'), looseCount) : ''].join('')
      : '';
  }

  function renderCards() {
    const filtering = groupFilter !== null || query;
    const shown = meta.filterBuilds(builds, { group: groupFilter, query });
    const defaultCard = filtering ? '' : defaultCardHtml(!(builds.find(b => b.active)));
    if (!builds.length) return defaultCard + '<div class="builds-empty">Сборок пока нет.<br>Создай первую или импортируй .mrpack: версия и загрузчик возьмутся из файла.</div>';
    if (!shown.length) return defaultCard + '<div class="builds-empty">Ничего не найдено.</div>';
    const sectioned = groupFilter === null && meta.listGroups(shown).length > 0;
    if (!sectioned) return defaultCard + shown.map(cardHtml).join('');
    const sections = meta.groupBuilds(shown).map(section => {
      const title = section.name || window.i18n.t('Без группы');
      return `<h3 class="builds-section-title">${escHtml(title)}</h3>${section.builds.map(cardHtml).join('')}`;
    });
    return defaultCard + sections.join('');
  }

  function render() {
    const active = builds.find(b => b.active) || null;
    window.__activeBuild = active;
    renderFilter();
    grid.innerHTML = renderCards();
    updateChips();
    window.dispatchEvent(new CustomEvent('fc-builds-changed', { detail: builds }));
  }

  groupsBar.addEventListener('click', e => {
    const btn = e.target.closest('button[data-group]');
    if (!btn) return;
    groupFilter = btn.dataset.group === '__all' ? null : btn.dataset.group;
    render();
  });

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    render();
  });

  function openMetaModal(build) {
    const overlay = document.createElement('div');
    overlay.className = 'text-prompt-modal';
    const groups = meta.listGroups(builds);
    overlay.innerHTML = `
      <div class="text-prompt-box build-create-box" role="dialog" aria-modal="true">
        <h3>Группа и теги</h3>
        <label class="build-field">Группа
          <input type="text" id="buildGroupInput" maxlength="${meta.MAX_GROUP}" list="buildGroupList" placeholder="Например, Друзья" autocomplete="off" value="${escHtml(build.group || '')}">
          <datalist id="buildGroupList">${groups.map(g => `<option value="${escHtml(g)}"></option>`).join('')}</datalist>
        </label>
        <label class="build-field">Теги через запятую
          <input type="text" id="buildTagsInput" placeholder="hardcore, сервер, шейдеры" autocomplete="off" value="${escHtml((build.tags || []).join(', '))}">
        </label>
        <div class="build-create-actions">
          <button type="button" class="secondary" data-act="cancel">Отмена</button>
          <button type="button" class="primary" data-act="ok">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const groupInput = overlay.querySelector('#buildGroupInput');
    const tagsInput = overlay.querySelector('#buildTagsInput');
    const close = () => overlay.remove();
    const submit = async () => {
      try {
        builds = await api.setBuildMeta(build.id, groupInput.value, tagsInput.value);
        render();
        close();
      } catch (err) {
        showToast(cleanIpcError(err), 'error', 'Не удалось сохранить');
      }
    };
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
    overlay.querySelector('[data-act="ok"]').addEventListener('click', submit);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    [groupInput, tagsInput].forEach(input => input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
    groupInput.focus();
  }

  async function refresh() {
    try {
      builds = await api.listBuilds();
    } catch (err) {
      builds = [];
      console.error('builds:list', err);
    }
    render();
  }

  // применяет выбор сборки к селекторам на главной: дальше всё работает как обычно
  function applySelection(build) {
    applying = true;
    try {
      if (build) {
        versionSelect.value = build.mcVersion;
        loaderSelect.value = build.loader;
        if (typeof syncLoaderButtons === 'function') syncLoaderButtons();
      }
      versionSelect.dispatchEvent(new Event('change'));
    } finally {
      applying = false;
    }
  }

  async function selectBuild(id) {
    const res = await api.selectBuild(id || null);
    builds = res.builds;
    render();
    applySelection(res.build);
    return res.build;
  }

  // ручная смена версии или загрузчика на главной выводит из сборки
  [versionSelect, loaderSelect].forEach(el => el.addEventListener('change', () => {
    const active = window.__activeBuild;
    if (applying || !active) return;
    const { mcVersion, loader } = currentSelection();
    if (active.mcVersion === mcVersion && active.loader === loader) return;
    window.__activeBuild = null;
    api.selectBuild(null).then(res => { builds = res.builds; render(); }).catch(() => {});
    updateChips();
  }));

  // ---- создание ----
  function openCreateModal() {
    const overlay = document.createElement('div');
    overlay.className = 'text-prompt-modal';
    const sel = currentSelection();
    let loader = sel.loader || 'fabric';
    const versionOptions = [...versionSelect.options].map(o =>
      `<option value="${escHtml(o.value)}"${o.value === sel.mcVersion ? ' selected' : ''}>${escHtml(o.textContent)}</option>`).join('');

    overlay.innerHTML = `
      <div class="text-prompt-box build-create-box" role="dialog" aria-modal="true">
        <h3>Новая сборка</h3>
        <label class="build-field">Название
          <input type="text" id="buildNameInput" maxlength="40" placeholder="Например, Выживание" autocomplete="off">
        </label>
        <label class="build-field">Версия Minecraft
          <select id="buildVersionInput">${versionOptions}</select>
        </label>
        <div class="build-field">Загрузчик
          <div class="build-loader-row" id="buildLoaderRow">
            ${LOADERS.map(([id, label]) => `<button type="button" data-loader="${id}" class="${id === loader ? 'active' : ''}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="build-create-actions">
          <button type="button" class="secondary" data-act="cancel">Отмена</button>
          <button type="button" class="primary" data-act="ok">Создать</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('#buildNameInput');
    const versionInput = overlay.querySelector('#buildVersionInput');
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    nameInput.focus();

    overlay.querySelector('#buildLoaderRow').addEventListener('click', e => {
      const btn = e.target.closest('button[data-loader]');
      if (!btn) return;
      loader = btn.dataset.loader;
      overlay.querySelectorAll('#buildLoaderRow button').forEach(b => b.classList.toggle('active', b === btn));
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);

    const submit = async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const okBtn = overlay.querySelector('[data-act="ok"]');
      okBtn.disabled = true;
      try {
        const res = await api.createBuild({ name, mcVersion: versionInput.value, loader, activate: true });
        builds = res.builds;
        render();
        applySelection(res.build);
        close();
        showToast(`Сборка «${res.build.name}» создана и выбрана`, 'success');
      } catch (err) {
        okBtn.disabled = false;
        showToast(cleanIpcError(err), 'error', 'Не удалось создать сборку');
      }
    };
    overlay.querySelector('[data-act="ok"]').addEventListener('click', submit);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  }

  function cleanIpcError(err) {
    return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  // ---- действия на карточках ----
  grid.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const card = btn.closest('.build-card');
    const id = card ? card.dataset.id : '';
    const build = builds.find(b => b.id === id);
    const action = btn.dataset.action;

    try {
      if (action === 'from-version') {
        await openFromVersionModal();
      } else if (action === 'select-none') {
        await selectBuild(null);
        showToast('Режим без сборки', 'info');
      } else if (action === 'select' && build) {
        if (build.active) {
          switchTab('play');
          setTimeout(() => document.getElementById('playBtn')?.click(), 200);
        } else {
          await selectBuild(build.id);
          showToast(`Выбрана сборка «${build.name}»`, 'success');
        }
      } else if (action === 'rename' && build) {
        const name = await askForText('Новое название сборки', build.name);
        if (!name || name === build.name) return;
        builds = await api.renameBuild(build.id, name);
        render();
      } else if (action === 'duplicate' && build) {
        const name = await askForText('Название копии', `${build.name} (копия)`);
        if (!name) return;
        showToast('Копирую файлы сборки...', 'info');
        builds = await api.duplicateBuild(build.id, name);
        render();
        showToast(`Копия «${name}» готова`, 'success');
      } else if (action === 'migrate' && build) {
        window.fcBuildTools.openMigrate(build);
      } else if (action === 'compare' && build) {
        window.fcBuildTools.openCompare(build, builds);
      } else if (action === 'meta' && build) {
        openMetaModal(build);
      } else if (action === 'share' && build) {
        await openShareModal(build);
      } else if (action === 'folder' && build) {
        await api.openBuildFolder(build.id);
      } else if (action === 'delete' && build) {
        const ok = await customConfirm(`Удалить сборку «${build.name}»?\nМоды, миры и настройки этой сборки сотрутся с диска. Отменить это нельзя.`);
        if (!ok) return;
        const wasActive = build.active;
        builds = await api.deleteBuild(build.id);
        render();
        if (wasActive) applySelection(null);
        showToast(`Сборка «${build.name}» удалена`, 'info');
      }
    } catch (err) {
      showToast(cleanIpcError(err), 'error', 'Ошибка сборки');
    }
  });

  async function openShareModal(build) {
    const info = await api.getBuildShareCode(build.id);
    const overlay = document.createElement('div');
    overlay.className = 'text-prompt-modal';
    overlay.innerHTML = `
      <div class="text-prompt-box build-create-box" role="dialog" aria-modal="true">
        <h3>Поделиться сборкой</h3>
        <p class="tool-desc">Код содержит список контента (модов: ${info.mods}, ресурспаков: ${info.resourcePacks}, шейдеров: ${info.shaders}). Миры, настройки и личные данные в него не попадают. Друг вставит код через «Импорт по коду», и лаунчер скачает всё сам.</p>
        <textarea class="build-code-field" readonly rows="5" spellcheck="false">${escHtml(info.code)}</textarea>
        <div class="build-create-actions">
          <button type="button" class="secondary" data-act="close">Закрыть</button>
          <button type="button" class="primary" data-act="copy">Скопировать код</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const field = overlay.querySelector('textarea');
    field.addEventListener('focus', () => field.select());
    overlay.querySelector('[data-act="close"]').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(info.code);
      } catch {
        field.select();
        document.execCommand('copy');
      }
      showToast('Код скопирован', 'success');
    });
  }

  async function openFromVersionModal() {
    let versions = [];
    try {
      versions = await api.listLegacyVersions();
    } catch (err) {
      showToast(cleanIpcError(err), 'error');
      return;
    }
    if (!versions.length) {
      showToast('Не нашёл версий с модами, ресурспаками или шейдерами вне сборок', 'info');
      return;
    }
    const current = currentSelection();
    const label = v => `${v.mcVersion} · ${loaderName(v.loader)} (${window.i18n.t('модов')}: ${v.mods}, ${window.i18n.t('ресурспаков')}: ${v.resourcePacks}, ${window.i18n.t('шейдеров')}: ${v.shaders})`;
    const overlay = document.createElement('div');
    overlay.className = 'text-prompt-modal';
    overlay.innerHTML = `
      <div class="text-prompt-box build-create-box" role="dialog" aria-modal="true">
        <h3>Перенести версию в сборку</h3>
        <label class="build-field">Версия
          <select id="buildFromVersion">${versions.map(v => `<option value="${escHtml(v.folder)}">${escHtml(label(v))}</option>`).join('')}</select>
        </label>
        <label class="build-field">Название сборки
          <input type="text" id="buildFromName" maxlength="36" autocomplete="off">
        </label>
        <label class="check" id="buildFromWorldsRow" style="display:none"><input type="checkbox" id="buildFromWorlds"> Скопировать и миры</label>
        <div class="setting-desc">Файлы копируются, исходная версия остаётся как есть.</div>
        <div class="build-create-actions">
          <button type="button" class="secondary" data-act="cancel">Отмена</button>
          <button type="button" class="primary" data-act="ok">Создать сборку</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const select = overlay.querySelector('#buildFromVersion');
    const nameInput = overlay.querySelector('#buildFromName');
    const worldsRow = overlay.querySelector('#buildFromWorldsRow');
    const worlds = overlay.querySelector('#buildFromWorlds');
    const okBtn = overlay.querySelector('[data-act="ok"]');
    const chosen = () => versions.find(v => v.folder === select.value);
    const suggest = () => {
      const v = chosen();
      nameInput.value = `${v.mcVersion} ${loaderName(v.loader)}`;
      worldsRow.style.display = v.hasWorlds ? '' : 'none';
      if (!v.hasWorlds) worlds.checked = false;
    };
    const preferred = versions.find(v => v.mcVersion === current.mcVersion && v.loader === current.loader);
    if (preferred) select.value = preferred.folder;
    suggest();

    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay && !okBtn.dataset.busy) close(); });
    select.addEventListener('change', suggest);
    nameInput.focus();
    nameInput.select();

    okBtn.addEventListener('click', async () => {
      okBtn.disabled = true;
      okBtn.dataset.busy = '1';
      okBtn.textContent = 'Копирую...';
      try {
        const res = await api.buildFromVersion(select.value, nameInput.value.trim(), worlds.checked);
        builds = res.builds;
        render();
        close();
        showToast(`Сборка «${res.build.name}» создана. Модов: ${res.counts.mods}`, 'success');
      } catch (err) {
        delete okBtn.dataset.busy;
        okBtn.disabled = false;
        okBtn.textContent = 'Создать сборку';
        showToast(cleanIpcError(err), 'error', 'Не получилось');
      }
    });
  }

  function openImportCodeModal() {
    const overlay = document.createElement('div');
    overlay.className = 'text-prompt-modal';
    overlay.innerHTML = `
      <div class="text-prompt-box build-create-box" role="dialog" aria-modal="true">
        <h3>Импорт по коду</h3>
        <label class="build-field">Код сборки
          <textarea class="build-code-field" id="buildCodeInput" rows="4" placeholder="FCB1:..." spellcheck="false"></textarea>
        </label>
        <div class="build-code-preview" id="buildCodePreview" style="display:none"></div>
        <label class="build-field" id="buildCodeNameRow" style="display:none">Название
          <input type="text" id="buildCodeName" maxlength="36" autocomplete="off">
        </label>
        <div class="build-create-actions">
          <button type="button" class="secondary" data-act="cancel">Отмена</button>
          <button type="button" class="primary" data-act="ok" disabled>Установить</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const codeInput = overlay.querySelector('#buildCodeInput');
    const preview = overlay.querySelector('#buildCodePreview');
    const nameRow = overlay.querySelector('#buildCodeNameRow');
    const nameInput = overlay.querySelector('#buildCodeName');
    const okBtn = overlay.querySelector('[data-act="ok"]');
    let parsed = null;
    let timer = null;

    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay && !okBtn.dataset.busy) close(); });

    async function check() {
      const code = codeInput.value.trim();
      parsed = null;
      okBtn.disabled = true;
      if (!code) {
        preview.style.display = 'none';
        nameRow.style.display = 'none';
        return;
      }
      const info = await api.previewBuildCode(code);
      if (codeInput.value.trim() !== code) return;
      preview.style.display = '';
      if (!info) {
        preview.textContent = 'Код не распознан. Проверь, что скопирован целиком.';
        nameRow.style.display = 'none';
        return;
      }
      parsed = info;
      const titles = info.titles.length ? `<div class="build-code-titles">${info.titles.map(escHtml).join(', ')}${info.mods > info.titles.length ? '…' : ''}</div>` : '';
      preview.innerHTML = `<b>${escHtml(info.name)}</b><div>Minecraft ${escHtml(info.mcVersion)}, ${escHtml(loaderName(info.loader))}</div><div>Модов: ${info.mods}, ресурспаков: ${info.resourcePacks}, шейдеров: ${info.shaders}</div>${titles}`;
      nameRow.style.display = '';
      if (!nameInput.value) nameInput.value = info.name;
      okBtn.disabled = false;
    }

    codeInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => check().catch(() => {}), 250);
    });
    codeInput.focus();

    okBtn.addEventListener('click', async () => {
      if (!parsed) return;
      okBtn.disabled = true;
      okBtn.dataset.busy = '1';
      okBtn.textContent = 'Устанавливаю...';
      showToast('Скачиваю моды сборки, это может занять время', 'info');
      try {
        const res = await api.installBuildCode(codeInput.value.trim(), nameInput.value.trim());
        builds = res.builds;
        render();
        applySelection(res.build);
        close();
        const failed = res.result.mods.failed + res.result.resourcePacks.failed + res.result.shaders.failed;
        const ready = failed
          ? `Сборка «${res.build.name}» готова. Модов: ${res.result.mods.installed}, не установилось: ${failed}`
          : `Сборка «${res.build.name}» готова. Модов: ${res.result.mods.installed}`;
        showToast(ready, failed ? 'warn' : 'success');
      } catch (err) {
        delete okBtn.dataset.busy;
        okBtn.disabled = false;
        okBtn.textContent = 'Установить';
        showToast(cleanIpcError(err), 'error', 'Импорт не удался');
      }
    });
  }

  function openLauncherImportModal() {
    const overlay = document.createElement('div');
    overlay.className = 'text-prompt-modal';
    overlay.innerHTML = `
      <div class="text-prompt-box build-create-box import-box" role="dialog" aria-modal="true">
        <h3>Импорт из лаунчера</h3>
        <p class="tool-desc">Лаунчер найдёт сборки Prism, MultiMC, CurseForge и официального лаунчера. Файлы копируются, оригинал не меняется.</p>
        <div class="import-list" id="importList"><div class="import-empty">Ищу сборки...</div></div>
        <div class="tool-form">
          <button type="button" class="secondary" id="importPickFolder">Выбрать папку…</button>
        </div>
        <label class="build-field" id="importNameRow" style="display:none">Название
          <input type="text" id="importName" maxlength="36" autocomplete="off">
        </label>
        <label class="check" id="importWorldsRow" style="display:none">
          <input type="checkbox" id="importWorlds">
          Копировать миры
        </label>
        <div class="build-create-actions">
          <button type="button" class="secondary" data-act="cancel">Отмена</button>
          <button type="button" class="primary" data-act="ok" disabled>Импортировать</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const list = overlay.querySelector('#importList');
    const nameRow = overlay.querySelector('#importNameRow');
    const nameInput = overlay.querySelector('#importName');
    const worldsRow = overlay.querySelector('#importWorldsRow');
    const worldsInput = overlay.querySelector('#importWorlds');
    const okBtn = overlay.querySelector('[data-act="ok"]');
    let items = [];
    let selected = null;

    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay && !okBtn.dataset.busy) close(); });

    function renderList() {
      if (!items.length) {
        list.innerHTML = '<div class="import-empty">Подходящих сборок не нашлось. Можно указать папку вручную.</div>';
        return;
      }
      list.innerHTML = items.map(item => `
        <button type="button" class="import-item${selected && selected.id === item.id ? ' is-on' : ''}" data-id="${escHtml(item.id)}">
          <span class="import-item-name">${escHtml(item.name)}</span>
          <span class="import-item-src">${escHtml(item.sourceLabel)}</span>
          <span class="import-item-meta">${escHtml(item.mcVersion)}, ${escHtml(loaderName(item.loader))} · модов: ${item.mods}, миров: ${item.worlds}</span>
        </button>`).join('');
    }

    function select(item) {
      selected = item;
      renderList();
      nameInput.value = item.name;
      nameRow.style.display = '';
      worldsRow.style.display = item.worlds ? '' : 'none';
      worldsInput.checked = false;
      okBtn.disabled = false;
    }

    list.addEventListener('click', e => {
      const btn = e.target.closest('button[data-id]');
      if (!btn) return;
      const item = items.find(i => i.id === btn.dataset.id);
      if (item) select(item);
    });

    const merge = found => {
      const known = new Set(items.map(i => i.id));
      items = [...items, ...found.filter(i => !known.has(i.id))];
      renderList();
      if (found.length && !selected) select(found[0]);
    };

    api.scanLauncherImports().then(merge).catch(err => {
      list.innerHTML = '';
      showToast(cleanIpcError(err), 'error', 'Поиск не удался');
    });

    overlay.querySelector('#importPickFolder').addEventListener('click', async () => {
      try {
        const found = await api.pickLauncherImportFolder();
        if (found === null) return;
        if (!found.length) showToast('В этой папке нет сборок, которые можно импортировать', 'warn');
        merge(found);
      } catch (err) {
        showToast(cleanIpcError(err), 'error', 'Не удалось прочитать папку');
      }
    });

    okBtn.addEventListener('click', async () => {
      if (!selected) return;
      okBtn.disabled = true;
      okBtn.dataset.busy = '1';
      okBtn.textContent = 'Копирую...';
      try {
        const res = await api.runLauncherImport(selected.id, nameInput.value.trim(), worldsInput.checked);
        builds = res.builds;
        render();
        applySelection(res.build);
        close();
        showToast(`Сборка «${res.build.name}» импортирована. Модов: ${res.counts.mods}`, 'success');
      } catch (err) {
        delete okBtn.dataset.busy;
        okBtn.disabled = false;
        okBtn.textContent = 'Импортировать';
        showToast(cleanIpcError(err), 'error', 'Импорт не удался');
      }
    });
  }

  document.getElementById('buildImportLauncherBtn').addEventListener('click', openLauncherImportModal);

  createBtn.addEventListener('click', openCreateModal);
  document.getElementById('buildImportCodeBtn').addEventListener('click', openImportCodeModal);

  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    const label = importBtn.textContent;
    importBtn.textContent = 'Импорт...';
    try {
      const res = await api.importBuildFromMrpack();
      if (!res) return;
      builds = res.builds;
      render();
      applySelection(res.build);
      const r = res.result || {};
      const failed = r.filesFailed ? `, не скачалось: ${r.filesFailed}` : '';
      showToast(`Сборка «${res.build.name}» создана. Скачано файлов: ${r.filesDownloaded || 0}${failed}`, r.filesFailed ? 'warn' : 'success');
    } catch (err) {
      showToast(cleanIpcError(err), 'error', 'Импорт не удался');
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = label;
    }
  });

  // общий бейдж обновлений на вкладке "Контент" = сумма по трём разделам
  const contentBadge = document.getElementById('contentUpdateBadge');
  const sourceBadges = ['modsUpdateBadge', 'rpUpdateBadge', 'shUpdateBadge'].map(id => document.getElementById(id));
  function syncContentBadge() {
    const total = sourceBadges.reduce((sum, el) => {
      if (!el || el.style.display === 'none') return sum;
      return sum + (parseInt(el.textContent, 10) || 0);
    }, 0);
    contentBadge.textContent = String(total);
    contentBadge.style.display = total > 0 ? '' : 'none';
  }
  const badgeObserver = new MutationObserver(syncContentBadge);
  sourceBadges.forEach(el => el && badgeObserver.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style'] }));
  syncContentBadge();

  // принимает ответ создания/переноса сборки: обновляет список и выбирает новую сборку
  function adopt(res) {
    builds = res.builds;
    render();
    applySelection(res.build);
  }

  refresh();
  return { refresh, adopt, select: selectBuild, create: openCreateModal };
})();
