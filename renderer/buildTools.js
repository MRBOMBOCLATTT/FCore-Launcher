// Инструменты сборок: сравнение двух сборок, перенос на другую версию Minecraft и оптимизация.
// Грузится после builds.js; использует глобальные escHtml, showToast, switchTab, showContentPane, currentSelection.
window.fcBuildTools = (() => {
  const api = window.api;
  const t = window.i18n.t;
  const ipcMessage = err => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla' };
  const MAX_ROWS = 150;

  // окно в том же стиле, что «Что нового» и проверка сборки
  function openDialog({ eyebrow, title }) {
    const root = document.createElement('div');
    root.className = 'text-prompt-modal whatsnew-overlay';
    root.style.display = 'flex';
    root.innerHTML = `
      <div class="whatsnew-box bc-box" role="dialog" aria-modal="true">
        <div class="whatsnew-glow" aria-hidden="true"></div>
        <div class="whatsnew-head">
          <div class="whatsnew-eyebrow">${escHtml(eyebrow)}</div>
          <div class="whatsnew-title-row"><h3>${escHtml(title)}</h3><span class="whatsnew-version" data-role="badge" style="display:none"></span></div>
        </div>
        <div class="whatsnew-body" data-role="body"></div>
        <div class="bc-status" data-role="status"></div>
        <div class="bc-foot" data-role="foot"></div>
      </div>`;
    document.body.appendChild(root);

    const part = name => root.querySelector(`[data-role="${name}"]`);
    const dialog = {
      root,
      body: part('body'),
      status: part('status'),
      setBadge(text) {
        const el = part('badge');
        el.textContent = text;
        el.style.display = text ? '' : 'none';
      },
      setButtons(buttons) {
        const foot = part('foot');
        foot.innerHTML = '';
        for (const spec of buttons) {
          const btn = document.createElement('button');
          btn.className = spec.primary ? 'primary' : 'secondary';
          btn.textContent = spec.label;
          btn.disabled = !!spec.disabled;
          btn.addEventListener('click', spec.onClick);
          foot.appendChild(btn);
        }
      },
      close() {
        root.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = e => { if (e.key === 'Escape') dialog.close(); };
    document.addEventListener('keydown', onKey);
    root.addEventListener('mousedown', e => { if (e.target === root) dialog.close(); });
    return dialog;
  }

  const rows = (list, render) => {
    const shown = list.slice(0, MAX_ROWS).map(render).join('');
    const more = list.length > MAX_ROWS ? `<div class="setting-desc">${escHtml(t(`и ещё ${list.length - MAX_ROWS}`))}</div>` : '';
    return shown + more;
  };

  const group = (label, list, render) => list.length
    ? `<div><div class="bc-group-title">${escHtml(label)}<b>${list.length}</b></div><div class="bc-list">${rows(list, render)}</div></div>`
    : '';

  const item = (title, hint, bad) => `
    <div class="bc-item ${bad ? 'is-bad' : ''}">
      <div class="bc-item-head"><div class="bc-item-title">${escHtml(title)}</div></div>
      ${hint ? `<div class="bc-item-hint">${escHtml(hint)}</div>` : ''}
    </div>`;

  const buildLabel = b => `${b.name} · ${b.mcVersion} · ${LOADER_NAMES[b.loader] || b.loader}`;

  // ---------- сравнение ----------
  function openCompare(build, builds) {
    const others = builds.filter(b => b.id !== build.id);
    if (!others.length) {
      showToast('Для сравнения нужна ещё одна сборка', 'info');
      return;
    }
    const dlg = openDialog({ eyebrow: 'Сравнение сборок', title: build.name });
    dlg.body.innerHTML = `
      <div class="setting-desc">Сравнить с:</div>
      <select id="btCompareWith">${others.map(b => `<option value="${escHtml(b.id)}">${escHtml(buildLabel(b))}</option>`).join('')}</select>
      <div id="btCompareResult" class="bt-result"></div>`;

    const select = dlg.body.querySelector('#btCompareWith');
    const result = dlg.body.querySelector('#btCompareResult');
    const otherBuild = () => others.find(b => b.id === select.value);

    // отмеченные для переноса моды: A это открытая сборка, B это выбранная для сравнения
    const selected = { A: new Set(), B: new Set() };
    let current = null;
    let busy = false;

    const sideList = side => current ? (side === 'A' ? current.mods.onlyA : current.mods.onlyB) : [];

    function renderButtons() {
      const other = otherBuild();
      const buttons = [{ label: 'Закрыть', onClick: dlg.close, disabled: busy }];
      if (current && other) {
        const countA = selected.A.size;
        const countB = selected.B.size;
        buttons.push(
          { label: countB ? t(`Перенести в «${build.name}» (${countB})`) : t(`Перенести в «${build.name}»`), disabled: busy || !countB, onClick: () => transfer('B') },
          { label: countA ? t(`Перенести в «${other.name}» (${countA})`) : t(`Перенести в «${other.name}»`), disabled: busy || !countA, onClick: () => transfer('A') }
        );
      }
      dlg.setButtons(buttons);
    }

    const pickItem = (m, side) => `
      <label class="bc-item bt-opt">
        <div class="bc-item-head"><div class="bc-item-title"><input type="checkbox" data-side="${side}" data-key="${escHtml(m.key)}" ${selected[side].has(m.key) ? 'checked' : ''}> ${escHtml(m.name)}</div></div>
        ${m.version ? `<div class="bc-item-hint">${escHtml(m.version)}</div>` : ''}
      </label>`;

    const pickGroup = (label, list, side) => list.length
      ? `<div><div class="bc-group-title"><span>${escHtml(label)}<b>${list.length}</b></span><button type="button" class="build-link-btn bt-all" data-all="${side}">${escHtml(t('Выбрать все'))}</button></div><div class="bc-list">${rows(list, m => pickItem(m, side))}</div></div>`
      : '';

    function syncChecks() {
      result.querySelectorAll('input[data-side]').forEach(el => {
        el.checked = selected[el.dataset.side].has(el.dataset.key);
      });
    }

    result.addEventListener('change', e => {
      const el = e.target.closest('input[data-side]');
      if (!el) return;
      const set = selected[el.dataset.side];
      if (el.checked) set.add(el.dataset.key);
      else set.delete(el.dataset.key);
      renderButtons();
    });

    result.addEventListener('click', e => {
      const btn = e.target.closest('[data-all]');
      if (!btn) return;
      e.preventDefault();
      const side = btn.dataset.all;
      const keys = sideList(side).map(m => m.key);
      const set = selected[side];
      if (keys.every(key => set.has(key))) keys.forEach(key => set.delete(key));
      else keys.forEach(key => set.add(key));
      syncChecks();
      renderButtons();
    });

    async function run() {
      current = null;
      selected.A.clear();
      selected.B.clear();
      renderButtons();
      result.innerHTML = `<div class="setting-desc">${escHtml(t('Загрузка...'))}</div>`;
      dlg.setBadge('');
      try {
        const res = await api.compareBuilds(build.id, select.value);
        current = res;
        const diff = res.mods;
        const total = diff.onlyA.length + diff.onlyB.length + diff.different.length;
        dlg.setBadge(total ? String(total) : '✓');

        const other = otherBuild();
        const sameEnv = other && other.mcVersion === build.mcVersion && other.loader === build.loader;

        const parts = [];
        parts.push(`<div class="setting-desc">${escHtml(t(`Модов: ${res.a.mods} и ${res.b.mods}, одинаковых: ${diff.same}`))}</div>`);
        if (diff.onlyA.length || diff.onlyB.length) {
          parts.push(`<div class="setting-desc">${escHtml(t(sameEnv
            ? 'Отметьте моды и перенесите их в другую сборку. Обязательные зависимости перенесутся вместе с ними.'
            : 'У сборок разная версия игры или загрузчик. Файлы не копируются: моды из списка сборки добавятся в целевую сборку, а подходящие версии скачает переустановка.'))}</div>`);
        }
        parts.push(pickGroup(t(`Только в «${res.a.name}»`), diff.onlyA, 'A'));
        parts.push(pickGroup(t(`Только в «${res.b.name}»`), diff.onlyB, 'B'));
        parts.push(group(t('Разные версии'), diff.different, m => item(m.name, `${m.versionA} → ${m.versionB}`, true)));
        for (const [label, data] of [['Ресурспаки', res.packs], ['Шейдеры', res.shaders]]) {
          const count = data.onlyA.length + data.onlyB.length;
          if (!count) continue;
          parts.push(group(t(`${label}: только в «${res.a.name}»`), data.onlyA, n => item(n)));
          parts.push(group(t(`${label}: только в «${res.b.name}»`), data.onlyB, n => item(n)));
        }
        if (!total && !res.packs.onlyA.length && !res.packs.onlyB.length && !res.shaders.onlyA.length && !res.shaders.onlyB.length) {
          parts.push(`<div class="bc-ok">${escHtml(t('Сборки одинаковые: отличий не найдено.'))}</div>`);
        }
        result.innerHTML = parts.join('');
      } catch (err) {
        result.innerHTML = `<div class="setting-desc">${escHtml(ipcMessage(err))}</div>`;
      }
      renderButtons();
    }

    // side 'A': моды только в открытой сборке, переносим в выбранную; side 'B': наоборот
    async function transfer(side) {
      const other = otherBuild();
      const fromId = side === 'A' ? build.id : other.id;
      const toId = side === 'A' ? other.id : build.id;
      const keys = [...selected[side]];
      if (!keys.length) return;

      busy = true;
      renderButtons();
      dlg.status.textContent = t('Переношу моды...');
      try {
        const res = await api.transferBuildMods(fromId, toId, keys);
        dlg.status.textContent = '';
        if (window.fcBuilds) window.fcBuilds.refresh();

        const notes = [];
        if (res.sameEnv) notes.push(t(`Скопировано модов: ${res.copied}`));
        else notes.push(t(`Добавлено в список «${res.toName}»: ${res.addedToList}`));
        if (res.deps.length) notes.push(t(`с зависимостями: ${res.deps.join(', ')}`));
        if (res.missingDeps.length) notes.push(t(`не найдены зависимости: ${res.missingDeps.join(', ')}`));
        if (res.failed.length) notes.push(t(`не скопировались: ${res.failed.map(f => f.name).join(', ')}`));
        if (res.unlisted) notes.push(t(`Файлы, положенные вручную (${res.unlisted}), пропадут при переустановке: их нет в списке модов`));
        if (res.notTransferable) notes.push(t(`Не перенесено модов, добавленных файлом: ${res.notTransferable}`));
        const warn = res.failed.length || res.missingDeps.length || res.unlisted || res.notTransferable;
        showToast(notes.join('. '), warn ? 'warn' : 'success');

        const targetIsActive = window.__activeBuild && window.__activeBuild.id === toId;
        if (!res.sameEnv && res.addedToList) {
          if (targetIsActive) {
            dlg.close();
            startReinstall({ mods: res.addedToList, packs: 0, shaders: 0 });
            return;
          }
          showToast(t(`Выберите сборку «${res.toName}» и нажмите «Переустановить» на вкладке модов, чтобы скачать моды`), 'info');
        } else if (targetIsActive) {
          for (const refresh of ['renderWantedList', 'renderInstalledMods']) {
            try { if (typeof window[refresh] === 'function') window[refresh](); } catch { /* список обновится при следующем открытии */ }
          }
        }
        busy = false;
        await run();
      } catch (err) {
        dlg.status.textContent = ipcMessage(err);
        busy = false;
        renderButtons();
      }
    }

    select.addEventListener('change', run);
    renderButtons();
    run();
  }

  // ---------- перенос на другую версию ----------
  async function openMigrate(build) {
    let versions = [];
    try { versions = (await api.listVersions()).map(v => v.id); } catch { /* список не загрузился */ }
    versions = versions.filter(id => id !== build.mcVersion);
    if (!versions.length) {
      showToast('Не удалось получить список версий Minecraft', 'error');
      return;
    }

    const dlg = openDialog({ eyebrow: 'Перенос на другую версию', title: build.name });
    dlg.body.innerHTML = `
      <div class="setting-desc">${escHtml(t(`Сейчас: ${build.mcVersion}. Исходная сборка не изменится: лаунчер создаст новую копию под выбранную версию и подберёт для неё версии модов.`))}</div>
      <div class="bt-row">
        <select id="btMigrateVersion">${versions.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('')}</select>
        <input id="btMigrateName" type="text" maxlength="40" aria-label="Название новой сборки">
      </div>
      <label class="bt-check"><input id="btMigrateWorlds" type="checkbox"> <span>Скопировать миры (займёт место, миры будут обновлены до новой версии)</span></label>
      <div id="btMigrateResult" class="bt-result"></div>`;

    const versionSel = dlg.body.querySelector('#btMigrateVersion');
    const nameInput = dlg.body.querySelector('#btMigrateName');
    const worlds = dlg.body.querySelector('#btMigrateWorlds');
    const result = dlg.body.querySelector('#btMigrateResult');
    let planned = null;
    let busy = false;

    const syncName = () => { nameInput.value = `${build.name} ${versionSel.value}`.slice(0, 40); };
    syncName();

    function renderButtons() {
      dlg.setButtons([
        { label: 'Отмена', onClick: dlg.close, disabled: busy },
        { label: 'Проверить моды', onClick: check, disabled: busy },
        { label: 'Создать сборку', primary: true, onClick: create, disabled: busy || !planned }
      ]);
    }

    async function check() {
      busy = true; planned = null; renderButtons();
      result.innerHTML = `<div class="setting-desc">${escHtml(t('Проверяю, какие моды есть под эту версию...'))}</div>`;
      try {
        const plan = await api.planBuildMigration(build.id, versionSel.value);
        planned = plan;
        const missing = [...plan.mods, ...plan.packs, ...plan.shaders].filter(i => i.status === 'missing');
        const unknown = [...plan.mods, ...plan.packs, ...plan.shaders].filter(i => i.status === 'unknown');
        const s = plan.summary;
        dlg.setBadge(missing.length ? String(missing.length) : '✓');
        result.innerHTML = [
          `<div class="setting-desc">${escHtml(t(`Найдено под ${versionSel.value}: модов ${s.mods.ok} из ${s.mods.total}, ресурспаков ${s.packs.ok} из ${s.packs.total}, шейдеров ${s.shaders.ok} из ${s.shaders.total}`))}</div>`,
          group(t('Нет версии под выбранную игру'), missing, i => item(i.title, 'Не перенесётся: на Modrinth нет подходящей версии', true)),
          group(t('Не удалось проверить'), unknown, i => item(i.title, 'Источник CurseForge или нет ответа сервера: добавьте вручную, если нужно')),
          `<div class="setting-desc">${escHtml(t('Моды, которые вы клали в папку файлами вручную, не переносятся: их версий лаунчер не знает.'))}</div>`
        ].join('');
      } catch (err) {
        result.innerHTML = `<div class="setting-desc">${escHtml(ipcMessage(err))}</div>`;
      } finally {
        busy = false; renderButtons();
      }
    }

    async function create() {
      busy = true; renderButtons();
      dlg.status.textContent = t('Создаю сборку...');
      try {
        const res = await api.migrateBuild({
          id: build.id,
          targetVersion: versionSel.value,
          name: nameInput.value.trim(),
          copyWorlds: worlds.checked
        });
        window.fcBuilds.adopt(res);
        dlg.close();
        showToast(t(`Сборка «${res.build.name}» создана: модов ${res.counts.mods}, ресурспаков ${res.counts.packs}, шейдеров ${res.counts.shaders}. Скачиваю моды...`), 'success');
        startReinstall(res.counts);
      } catch (err) {
        dlg.status.textContent = ipcMessage(err);
        busy = false; renderButtons();
      }
    }

    versionSel.addEventListener('change', () => { planned = null; syncName(); result.innerHTML = ''; dlg.setBadge(''); renderButtons(); });
    renderButtons();
  }

  // после создания сборки качаем моды обычной переустановкой — со всем её прогрессом и подтверждениями
  function startReinstall(counts) {
    switchTab('content');
    showContentPane('mods');
    setTimeout(() => {
      if (counts.mods > 0) document.getElementById('reinstallBtn').click();
      if (counts.packs > 0 || counts.shaders > 0) {
        showToast('Ресурспаки и шейдеры скачайте на их вкладках кнопкой «Переустановить»', 'info');
      }
    }, 700);
  }

  // ---------- оптимизация ----------
  async function openOptimize() {
    const { mcVersion, loader } = currentSelection();
    if (!mcVersion) {
      showToast('Сначала выберите версию на вкладке «Главная»', 'warn');
      return;
    }
    if (!['fabric', 'forge', 'neoforge'].includes(loader)) {
      showToast('Оптимизационные моды есть для Fabric, Forge и NeoForge. Выберите один из этих загрузчиков', 'info');
      return;
    }

    const dlg = openDialog({ eyebrow: 'Оптимизация сборки', title: `${mcVersion} · ${LOADER_NAMES[loader]}` });
    dlg.body.innerHTML = `<div class="setting-desc">${escHtml(t('Проверяю, какие моды подойдут...'))}</div>`;
    dlg.setButtons([{ label: 'Закрыть', onClick: dlg.close }]);

    let plan;
    try {
      plan = await api.planOptimization(mcVersion, loader);
    } catch (err) {
      dlg.body.innerHTML = `<div class="setting-desc">${escHtml(ipcMessage(err))}</div>`;
      return;
    }

    const STATE_TEXT = {
      installed: 'Уже есть в сборке',
      conflict: 'Не нужен: уже стоит другой мод отрисовки (Sodium, Embeddium, Rubidium или OptiFine)',
      unavailable: `Нет версии под ${mcVersion}`
    };
    const candidates = plan.filter(i => i.state === 'candidate');
    dlg.setBadge(candidates.length ? String(candidates.length) : '✓');

    dlg.body.innerHTML = `
      <div class="setting-desc">${escHtml(t('Проверенные моды, которые повышают FPS и снижают потребление памяти. Выберите, что добавить: до скачивания лаунчер сохранит снимок сборки, откатиться можно в настройках.'))}</div>
      <div class="bc-list">
        ${plan.map((p, i) => `
          <label class="bc-item bt-opt ${p.state === 'candidate' ? '' : 'is-off'}">
            <div class="bc-item-head">
              <div class="bc-item-title"><input type="checkbox" data-i="${i}" ${p.state === 'candidate' ? 'checked' : 'disabled'}> ${escHtml(p.title)}${p.versionNumber ? ` <span class="desc">${escHtml(p.versionNumber)}</span>` : ''}</div>
            </div>
            <div class="bc-item-hint">${escHtml(p.state === 'candidate' ? p.why : STATE_TEXT[p.state])}</div>
          </label>`).join('')}
      </div>`;

    const selected = () => [...dlg.body.querySelectorAll('input[data-i]:checked')].map(el => plan[Number(el.dataset.i)]);
    function renderButtons() {
      const count = selected().length;
      dlg.setButtons([
        { label: 'Отмена', onClick: dlg.close },
        { label: count ? `Добавить и скачать (${count})` : 'Нечего добавлять', primary: true, disabled: !count, onClick: apply }
      ]);
    }
    dlg.body.addEventListener('change', renderButtons);
    renderButtons();

    async function apply() {
      const items = selected().map(({ projectId, title, icon }) => ({ projectId, title, icon }));
      try {
        const res = await api.applyOptimization(mcVersion, loader, items);
        dlg.close();
        showToast(t(`Добавлено модов: ${res.added}. Скачиваю...`), 'success');
        startReinstall({ mods: res.added, packs: 0, shaders: 0 });
      } catch (err) {
        dlg.status.textContent = ipcMessage(err);
      }
    }
  }

  document.getElementById('buildOptimizeBtn').addEventListener('click', openOptimize);

  return { openCompare, openMigrate, openOptimize };
})();
