// Диагностика модов: авто-починка после краша, дерево зависимостей, метрики ресурсов.
// Грузится после renderer.js и пользуется его глобальными функциями (currentSelection, showToast и т.д.)
window.fcDiag = (() => {
  const api = window.api;
  const esc = v => escHtml(v);
  const LEVELS = { high: 'высокая', medium: 'средняя', low: 'низкая' };
  const KIND_LABELS = { required: 'обязательно', optional: 'необязательно', breaks: 'несовместим', conflicts: 'конфликт' };

  let activeModal = null;
  let onCloseCb = null;
  let performanceMonitorBox = null;
  const performanceState = { running: false, supported: true, latest: null, samples: [] };

  function closeModal() {
    if (!activeModal) return;
    activeModal.remove();
    activeModal = null;
    const cb = onCloseCb;
    onCloseCb = null;
    if (cb) cb();
  }

  function openModal(html, wide, onClose) {
    closeModal();
    onCloseCb = onClose || null;
    const overlay = document.createElement('div');
    overlay.className = 'text-prompt-modal diag-overlay';
    overlay.innerHTML = `<div class="text-prompt-box diag-box ${wide ? 'wide' : ''}">${html}</div>`;
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    activeModal = overlay;
    const box = overlay.firstElementChild;
    box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
    return box;
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activeModal) closeModal();
  });

  const names = list => list.map(x => `«${esc(x.name || x)}»`).join(', ');

  function libraryFiles() {
    return (typeof installedModsCache !== 'undefined' ? installedModsCache : [])
      .filter(m => m.isDependency).map(m => m.fileName);
  }

  // ---------- авто-починка ----------

  function onCrashAnalysis(p) {
    const a = p.analysis;
    if (!a) return;
    // если причина не в модах и мы ничего не нашли — не дёргаем окном
    if (!a.suspects.length && !a.environment.length && !a.missing.length) return;
    showCrashFix(a);
  }

  async function showCrashFix(a) {
    const { mcVersion, loader } = a;
    const top = a.suspects.slice(0, 3);
    const box = openModal(`
      <div class="diag-head"><h3>Игра вылетела</h3><button class="diag-x" data-close>×</button></div>
      <p class="diag-summary">${esc(a.summary)}</p>
      ${top.map(suspectHtml).join('')}
      ${a.missing.length ? `<div class="diag-section"><h4>Не хватает зависимостей</h4>${a.missing.map(missingHtml).join('')}</div>` : ''}
      ${a.environment.length ? `<div class="diag-section"><h4>Что ещё могло повлиять</h4>${a.environment.map(e => `<div class="diag-note">${esc(e.message)}</div>`).join('')}</div>` : ''}
      ${a.recommended.length ? recommendedHtml(a) : ''}
      <div id="diagFixes"></div>
      <div class="text-prompt-actions">
        <button class="secondary" data-close>Закрыть</button>
        ${a.recommended.length ? '<button id="diagApplyFix" class="primary">Починить</button>' : ''}
      </div>`);

    box.querySelectorAll('[data-find-dep]').forEach(b => b.addEventListener('click', () => {
      closeModal();
      openModSearchForDependency(b.dataset.findDep);
    }));
    box.querySelectorAll('[data-enable-file]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      await api.setModEnabled(mcVersion, loader, b.dataset.enableFile, true);
      b.textContent = 'Включён';
      renderInstalledMods();
    }));

    box.querySelector('#diagApplyFix')?.addEventListener('click', async e => {
      const files = [...box.querySelectorAll('.diag-pick:checked')].map(c => c.value);
      if (!files.length) return showToast('Ничего не выбрано', 'warn');
      e.target.disabled = true;
      try {
        const res = await api.applyCrashFix(mcVersion, loader, files, a.summary);
        renderInstalledMods();
        showFixResult(box, res.entry);
      } catch (err) {
        e.target.disabled = false;
        showToast(err.message, 'error');
      }
    });

    renderFixHistory(box.querySelector('#diagFixes'), mcVersion, loader);
  }

  function suspectHtml(s) {
    const breaks = s.ifDisabled?.breaks || [];
    return `
      <div class="diag-card">
        <div class="diag-card-head">
          <span class="diag-title">${esc(s.name)}${s.version ? ` <span class="desc">${esc(s.version)}</span>` : ''}</span>
          <span class="diag-badge ${s.level}">уверенность: ${LEVELS[s.level] || s.level}</span>
        </div>
        <ul class="diag-reasons">${s.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        ${breaks.length ? `<div class="diag-note">Если отключить, без него не заработают: ${names(breaks)}</div>` : ''}
      </div>`;
  }

  function missingHtml(m) {
    const by = names(m.requiredBy);
    const off = m.disabledProviders.map(p => `
      <button class="diag-small" data-enable-file="${esc(p.fileName)}">Включить «${esc(p.name)}»</button>`).join('');
    return `
      <div class="diag-row">
        <span>«${esc(m.dependencyId)}» нужен для ${by}</span>
        <span>${off}<button class="diag-small" data-find-dep="${esc(m.dependencyId)}">Найти</button></span>
      </div>`;
  }

  function recommendedHtml(a) {
    return `
      <div class="diag-section">
        <h4>Отключить (можно отменить)</h4>
        ${a.recommendedNames.map(r => `
          <label class="diag-check"><input type="checkbox" class="diag-pick" value="${esc(r.fileName)}" checked>
            <span>${esc(r.name)} <span class="desc">${esc(r.fileName)}</span></span></label>`).join('')}
      </div>`;
  }

  function showFixResult(box, entry) {
    const { mcVersion, loader } = entry;
    box.innerHTML = `
      <div class="diag-head"><h3>Готово</h3><button class="diag-x" data-close>×</button></div>
      <p class="diag-summary">${entry.disabled.length
        ? `Отключено модов: ${entry.disabled.length}. Файлы переименованы в .disabled, ничего не удалено.`
        : 'Эти файлы уже были отключены.'}</p>
      ${entry.disabled.map(f => `<div class="diag-note">${esc(f)}</div>`).join('')}
      <div class="text-prompt-actions">
        ${entry.disabled.length ? '<button id="diagUndo" class="secondary">Отменить</button>' : ''}
        <button class="primary" data-close>Закрыть</button>
      </div>`;
    box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
    box.querySelector('#diagUndo')?.addEventListener('click', async () => {
      await api.undoCrashFix(mcVersion, loader, entry.id);
      renderInstalledMods();
      showToast('Моды включены обратно', 'success');
      closeModal();
    });
  }

  async function renderFixHistory(el, mcVersion, loader) {
    const fixes = (await api.listCrashFixes(mcVersion, loader)).filter(f => !f.undone && f.disabled.length).slice(0, 3);
    if (!fixes.length) return;
    el.innerHTML = `<div class="diag-section"><h4>Прошлые исправления</h4>${fixes.map(f => `
      <div class="diag-row">
        <span>${new Date(f.at).toLocaleString(window.i18n.locale)} · отключено: ${f.disabled.length}</span>
        <button class="diag-small" data-undo="${esc(f.id)}">Вернуть</button>
      </div>`).join('')}</div>`;
    el.querySelectorAll('[data-undo]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      await api.undoCrashFix(mcVersion, loader, b.dataset.undo);
      b.textContent = 'Возвращено';
      renderInstalledMods();
    }));
  }

  // разбор уже сохранённого отчёта из настроек
  async function analyzeReport(filePath) {
    try {
      showCrashFix(await api.analyzeCrashReport(filePath));
    } catch (err) {
      showToast(err.message, 'error', 'Не удалось разобрать краш');
    }
  }

  // ---------- дерево зависимостей ----------

  function problemText(p) {
    switch (p.type) {
      case 'missing-dependency': return `«${p.name}» требует «${p.dependencyId}», которого нет`;
      case 'wrong-minecraft-version': return `«${p.name}» заявлен для другой версии Minecraft`;
      case 'wrong-dependency-version': return `«${p.name}» нужна другая версия «${p.dependencyId}»`;
      case 'incompatible': return `«${p.name}» несовместим с «${p.dependencyId}»`;
      case 'conflict': return `«${p.name}» конфликтует с «${p.dependencyId}»`;
      case 'duplicate': return `Несколько JAR объявляют один ID мода «${p.modId}»: ${p.files.join(', ')}`;
      case 'duplicate-content': return `Побайтно одинаковые JAR-файлы: ${p.files.join(', ')}`;
      default: return p.type;
    }
  }

  // дерево «кто сломается следом»: ребёнок — тот, кому не хватает родителя
  function cascadeTreeHtml(sim, rootFile) {
    const broken = [...sim.direct, ...sim.cascade];
    if (!broken.length) return '';
    const seen = new Set([rootFile]);
    const build = parent => broken
      .filter(b => (b.becauseFile || rootFile) === parent && !seen.has(b.fileName))
      .map(b => {
        seen.add(b.fileName);
        return `<li><span class="diag-bad">${esc(b.name)}</span>${build(b.fileName)}</li>`;
      });
    const items = build(rootFile);
    return items.length ? `<ul class="diag-tree">${items.join('')}</ul>` : '';
  }

  // Раскладка по слоям: слева библиотеки (ничего не требуют), правее — те, кто на них опирается.
  const NODE_W = 170, NODE_H = 28, GAP_X = 70, GAP_Y = 10, PAD = 12;

  function layoutTree(mods) {
    const byFile = new Map(mods.map(m => [m.fileName, m]));
    const edges = [];
    for (const m of mods) {
      for (const r of m.requires) {
        if (r.builtin || (r.kind !== 'required' && r.kind !== 'optional')) continue;
        for (const pr of r.providers) {
          if (byFile.has(pr.fileName) && pr.fileName !== m.fileName) {
            edges.push({ from: pr.fileName, to: m.fileName, optional: r.kind === 'optional' });
          }
        }
      }
    }
    const linked = new Set(edges.flatMap(e => [e.from, e.to]));
    const parents = new Map();
    for (const e of edges) {
      if (!parents.has(e.to)) parents.set(e.to, []);
      parents.get(e.to).push(e.from);
    }

    const layer = new Map();
    const depth = (f, stack = new Set()) => {
      if (layer.has(f)) return layer.get(f);
      if (stack.has(f)) return 0; // цикл — не уходим в бесконечность
      stack.add(f);
      const ps = parents.get(f) || [];
      const d = ps.length ? 1 + Math.max(...ps.map(x => depth(x, stack))) : 0;
      stack.delete(f);
      layer.set(f, d);
      return d;
    };
    linked.forEach(f => depth(f));

    const columns = [];
    const nameOf = f => byFile.get(f).name.toLowerCase();
    [...linked].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).forEach(f => {
      const d = layer.get(f);
      (columns[d] = columns[d] || []).push(f);
    });
    // чтобы линии пересекались меньше, ставим мод рядом со средней позицией его родителей
    const row = new Map();
    columns.forEach((col, ci) => {
      if (ci > 0) {
        const avg = f => {
          const ps = (parents.get(f) || []).filter(x => row.has(x));
          return ps.length ? ps.reduce((sum, x) => sum + row.get(x), 0) / ps.length : 0;
        };
        col.sort((a, b) => avg(a) - avg(b));
      }
      col.forEach((f, i) => row.set(f, i));
    });

    return { columns, edges, isolated: mods.filter(m => !linked.has(m.fileName)), byFile };
  }

  function treeSvg(tree, { problemFiles, matches }) {
    const pos = new Map();
    tree.columns.forEach((col, ci) => col.forEach((f, ri) => {
      pos.set(f, { x: PAD + ci * (NODE_W + GAP_X), y: PAD + ri * (NODE_H + GAP_Y) });
    }));
    const width = PAD * 2 + tree.columns.length * NODE_W + (tree.columns.length - 1) * GAP_X;
    const height = PAD * 2 + Math.max(...tree.columns.map(c => c.length)) * (NODE_H + GAP_Y);

    const lines = tree.edges.map(e => {
      const a = pos.get(e.from), b = pos.get(e.to);
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      return `<path class="tree-edge ${e.optional ? 'opt' : ''}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"
        d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}"/>`;
    }).join('');

    const nodes = [...pos].map(([f, { x, y }]) => {
      const m = tree.byFile.get(f);
      const label = m.name.length > 23 ? m.name.slice(0, 22) + '…' : m.name;
      const cls = [
        'tree-node',
        m.enabled ? '' : 'off',
        problemFiles.has(f) ? 'problem' : '',
        matches(m) ? '' : 'dim'
      ].join(' ');
      return `<g class="${cls}" data-file="${esc(f)}" transform="translate(${x},${y})">
        <title>${esc(m.name)}${m.version ? ' ' + esc(m.version) : ''}</title>
        <rect width="${NODE_W}" height="${NODE_H}" rx="7"/>
        <text x="10" y="${NODE_H / 2 + 4}">${esc(label)}</text></g>`;
    }).join('');

    return { width, height, html: `<svg class="diag-treesvg" width="100%" height="100%"><g class="tree-vp">${lines}${nodes}</g></svg>` };
  }

  async function showDependencies() {
    const { mcVersion, loader } = currentSelection();
    const box = openModal(`
      <div class="diag-head"><h3>Расширенная проверка модов</h3><button class="diag-x" data-close>×</button></div>
      <div id="depBody" class="desc">Проверяю зависимости, конфликты, версии и побайтные дубликаты...</div>`, true);
    const body = box.querySelector('#depBody');

    let data;
    const load = async () => {
      data = await api.getModGraph(mcVersion, loader, libraryFiles());
    };
    try {
      await load();
    } catch (err) {
      body.textContent = `Не получилось прочитать моды: ${err.message}`;
      return;
    }
    if (!data.mods.length) {
      body.textContent = 'В папке mods пока нет файлов.';
      return;
    }

    let selected = null;
    let filter = '';
    let view = null; // {x, y, k} — положение и масштаб схемы, переживает перерисовку
    let dragged = false;

    const matchesFilter = m => !filter || m.name.toLowerCase().includes(filter) || m.fileName.toLowerCase().includes(filter);

    // не хватает модов: объединяем по id, чтобы один мод не предлагался по числу зависимых
    const missingDeps = () => {
      const map = new Map();
      for (const p of data.problems) {
        if (p.type !== 'missing-dependency') continue;
        if (!map.has(p.dependencyId)) map.set(p.dependencyId, { id: p.dependencyId, by: [], disabled: p.disabledProviders || [] });
        map.get(p.dependencyId).by.push(p.name);
      }
      return [...map.values()];
    };

    const missingDepsHtml = () => {
      const list = missingDeps();
      if (!list.length) return '';
      return `<div class="diag-section problems" id="missingDeps"><h4>Не хватает модов (${list.length})</h4>
        ${list.map(m => `
          <div class="diag-row">
            <span>«${esc(m.id)}» нужен для ${names([...new Set(m.by)])}</span>
            <span>${m.disabled.length ? `<button class="diag-small" data-enable-dep="${esc(m.disabled[0])}">Включить</button>` : ''}<button class="diag-small" data-download-dep="${esc(m.id)}">Скачать</button></span>
          </div>`).join('')}
        ${list.length > 1 ? '<div class="diag-row"><span></span><span><button class="diag-small" id="downloadAllDeps">Скачать все</button></span></div>' : ''}
        <div id="missingDepsStatus" class="desc"></div></div>`;
    };

    const downloadDeps = async ids => {
      const status = body.querySelector('#missingDepsStatus');
      body.querySelectorAll('[data-download-dep], #downloadAllDeps').forEach(b => { b.disabled = true; });
      let done = 0;
      const failed = [];
      for (const id of ids) {
        if (status) status.textContent = `Скачиваю «${id}» (${done + 1} из ${ids.length})...`;
        const res = await api.installMissingDependency(mcVersion, loader, id);
        if (res.ok) {
          done++;
        } else {
          failed.push({ id, res });
        }
      }
      if (done) showToast(`Скачано зависимостей: ${done}`, 'success');
      for (const f of failed) {
        showToast(`«${f.id}»: ${f.res.error}`, 'error');
      }
      try { await load(); } catch { /* оставим старые данные */ }
      if (typeof renderInstalledMods === 'function') renderInstalledMods();
      draw();
      // точного совпадения на Modrinth нет: открываем поиск по названию
      if (failed.length === 1 && failed[0].res.notFound) {
        closeModal();
        openModSearchForDependency(failed[0].id);
      }
    };

    const draw = () => {
      const problemFiles = new Set(data.problems.map(p => p.fileName));
      const tree = layoutTree(data.mods);
      const drawn = tree.columns.length ? treeSvg(tree, { problemFiles, matches: matchesFilter }) : null;
      const matches = matchesFilter;
      body.className = '';
      body.innerHTML = `
        ${missingDepsHtml()}
        ${data.problems.length ? `<div class="diag-section problems"><h4>Проблемы в сборке (${data.problems.length})</h4>
          ${data.problems.slice(0, 6).map(p => `<div class="diag-note warn">${esc(problemText(p))}</div>`).join('')}
          ${data.problems.length > 6 ? `<div class="desc">и ещё ${data.problems.length - 6}</div>` : ''}</div>` : ''}
        <div class="diag-toolbar">
          <input id="depFilter" type="text" placeholder="Поиск мода..." value="${esc(filter)}">
          <span class="desc">Слева основа, правее те, кто на неё опирается. Пунктир — необязательная связь.</span>
        </div>
        ${drawn ? `<div class="diag-treewrap" id="treeWrap">${drawn.html}
          <div class="tree-tools"><button data-z="in" title="Приблизить">+</button><button data-z="out" title="Отдалить">−</button><button data-z="fit" title="Показать всё">⤢</button></div>
          <div class="tree-hint">Колесо — масштаб, перетаскивание — сдвиг</div></div>` : '<div class="desc">Моды не связаны друг с другом зависимостями.</div>'}
        ${tree.isolated.length ? `<div class="diag-section"><h4>Без связей (${tree.isolated.length})</h4>
          <div class="diag-chips">${tree.isolated.map(m => `
            <span class="diag-chip ${m.enabled ? '' : 'off'} ${matches(m) ? '' : 'dim'} ${problemFiles.has(m.fileName) ? 'problem' : ''}" data-file="${esc(m.fileName)}">${esc(m.name)}</span>`).join('')}</div></div>` : ''}
        <div class="diag-col detail" id="depDetail"><div class="desc">Нажми на мод в дереве: подсветится всё, что от него зависит и на чём он держится, и покажется, что будет при отключении.</div></div>`;

      body.querySelectorAll('[data-download-dep]').forEach(b => b.addEventListener('click', () => downloadDeps([b.dataset.downloadDep])));
      const allBtn = body.querySelector('#downloadAllDeps');
      if (allBtn) allBtn.addEventListener('click', () => downloadDeps(missingDeps().map(m => m.id)));
      body.querySelectorAll('[data-enable-dep]').forEach(b => b.addEventListener('click', async () => {
        await api.setModEnabled(mcVersion, loader, b.dataset.enableDep, true);
        try { await load(); } catch { /* оставим */ }
        if (typeof renderInstalledMods === 'function') renderInstalledMods();
        draw();
      }));

      const filterInput = body.querySelector('#depFilter');
      filterInput.addEventListener('input', () => {
        filter = filterInput.value.trim().toLowerCase();
        draw();
        const again = body.querySelector('#depFilter');
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      });
      if (drawn) setupPanZoom(body.querySelector('#treeWrap'), drawn.width, drawn.height);
      body.querySelectorAll('[data-file]').forEach(el => el.addEventListener('click', () => {
        if (dragged) return; // это было перетаскивание схемы, а не клик
        selected = el.dataset.file;
        paint(tree, null);
        showDetail();
      }));
      paint(tree, null);
      if (selected) showDetail();
    };

    const setupPanZoom = (wrap, w, h) => {
      const vp = wrap.querySelector('.tree-vp');
      const apply = () => vp.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
      const clamp = k => Math.min(2.5, Math.max(0.1, k));
      const fit = () => {
        const r = wrap.getBoundingClientRect();
        const k = r.width ? clamp(Math.min(1, (r.width - 20) / w, (r.height - 20) / h)) : 1;
        view = { k, x: Math.max(10, (r.width - w * k) / 2), y: Math.max(10, (r.height - h * k) / 2) };
        apply();
      };
      const zoomAt = (mx, my, factor) => {
        const k = clamp(view.k * factor);
        view.x = mx - (mx - view.x) * (k / view.k);
        view.y = my - (my - view.y) * (k / view.k);
        view.k = k;
        apply();
      };
      view ? apply() : fit();

      wrap.addEventListener('wheel', e => {
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      }, { passive: false });

      wrap.addEventListener('mousedown', e => {
        if (e.button !== 0 || e.target.closest('.tree-tools')) return;
        dragged = false;
        let lastX = e.clientX, lastY = e.clientY, moved = 0;
        wrap.classList.add('grabbing');
        const move = ev => {
          moved += Math.abs(ev.clientX - lastX) + Math.abs(ev.clientY - lastY);
          if (moved > 5) dragged = true;
          view.x += ev.clientX - lastX;
          view.y += ev.clientY - lastY;
          lastX = ev.clientX; lastY = ev.clientY;
          apply();
        };
        const up = () => {
          wrap.classList.remove('grabbing');
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          setTimeout(() => { dragged = false; }, 0);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });

      wrap.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => {
        const r = wrap.getBoundingClientRect();
        if (b.dataset.z === 'fit') fit();
        else zoomAt(r.width / 2, r.height / 2, b.dataset.z === 'in' ? 1.25 : 0.8);
      }));
    };

    // подсветка: основа выбранного мода (синим) и всё, что рухнет без него (красным)
    const paint = (tree, sim) => {
      const nodes = body.querySelectorAll('[data-file]');
      const edges = body.querySelectorAll('.tree-edge');
      nodes.forEach(n => n.classList.remove('sel', 'base', 'brk'));
      edges.forEach(e => e.classList.remove('hot-base', 'hot-brk'));
      if (!selected) return;

      const base = new Set();
      const up = f => tree.edges.filter(e => e.to === f).forEach(e => {
        if (!base.has(e.from)) { base.add(e.from); up(e.from); }
      });
      up(selected);
      const broken = new Set(sim ? [...sim.direct, ...sim.cascade].map(b => b.fileName) : []);

      nodes.forEach(n => {
        const f = n.dataset.file;
        if (f === selected) n.classList.add('sel');
        else if (broken.has(f)) n.classList.add('brk');
        else if (base.has(f)) n.classList.add('base');
      });
      edges.forEach(e => {
        const { from, to } = e.dataset;
        if ((base.has(from) || from === selected) && (base.has(to) || to === selected)) e.classList.add('hot-base');
        else if ((broken.has(from) || from === selected) && broken.has(to)) e.classList.add('hot-brk');
      });
      body.classList.toggle('has-sel', true);
    };

    const showDetail = async () => {
      const mod = data.mods.find(m => m.fileName === selected);
      const el = body.querySelector('#depDetail');
      if (!mod || !el) return;

      const reqs = mod.requires.filter(r => !(r.builtin && r.status === 'ok'));
      const needs = reqs.map(r => {
        const state = r.status === 'ok'
          ? `<span class="diag-good">${r.providers.map(p => esc(p.name)).join(', ') || 'есть'}</span>`
          : r.status === 'version'
            ? '<span class="diag-bad">не та версия</span>'
            : r.status === 'missing'
              ? `<span class="diag-bad">нет${r.disabledProviders.length ? ' (отключён: ' + r.disabledProviders.map(p => esc(p.name)).join(', ') + ')' : ''}</span>`
              : `<span class="desc">${esc(r.status)}</span>`;
        return `<div class="diag-row"><span>${esc(r.id)} <span class="desc">${KIND_LABELS[r.kind] || r.kind}</span></span>${state}</div>`;
      }).join('');

      const usedBy = mod.requiredBy.map(d => `
        <div class="diag-row"><span>${esc(d.name)}</span>
          <span class="desc">${d.kind === 'optional' ? 'необязательно' : d.onlyProvider ? 'нужен ему' : 'есть замена'}</span></div>`).join('');

      el.innerHTML = `
        <h4 class="diag-modname">${esc(mod.name)} ${mod.version ? `<span class="desc">${esc(mod.version)}</span>` : ''}</h4>
        <div class="desc">${esc(mod.fileName)}</div>
        ${mod.error ? `<div class="diag-note warn">Файл не удалось прочитать: ${esc(mod.error)}</div>` : ''}
        <h5>Требует</h5>${needs || '<div class="desc">Ничего, кроме игры и загрузчика</div>'}
        <h5>Нужен для</h5>${usedBy || '<div class="desc">Другие моды его не используют</div>'}
        <h5>${mod.enabled ? 'Если отключить' : 'Если включить'}</h5>
        <div id="depSim" class="desc">Считаю...</div>
        <div class="text-prompt-actions" id="depActions"></div>`;

      if (mod.enabled) await showDisableSim(mod, el);
      else await showEnableSim(mod, el);
    };

    const refresh = async () => {
      await load();
      renderInstalledMods();
      draw();
    };

    const showDisableSim = async (mod, el) => {
      const sim = await api.simulateDisableMods(mcVersion, loader, [mod.fileName], libraryFiles());
      if (selected !== mod.fileName) return;
      const broken = sim.direct.length + sim.cascade.length;
      paint(layoutTree(data.mods), sim);
      const parts = [];
      if (broken) parts.push(`<div class="diag-note warn">Перестанут запускаться (${broken}):</div>${cascadeTreeHtml(sim, mod.fileName)}`);
      if (sim.softLost.length) parts.push(`<div class="diag-note">Потеряют необязательные функции: ${names(sim.softLost)}</div>`);
      if (sim.freeable.length) parts.push(`<div class="diag-note">Библиотеки, которые больше никому не нужны: ${names(sim.freeable)}</div>`);
      if (sim.resolves.length) parts.push(`<div class="diag-note good">Уберёт конфликт с: ${names(sim.resolves.map(r => ({ name: r.name })))}</div>`);
      el.querySelector('#depSim').outerHTML = parts.length ? parts.join('') : '<div class="diag-note good">Ничего не сломается.</div>';

      const actions = el.querySelector('#depActions');
      actions.innerHTML = `
        ${broken ? `<button id="depWith" class="secondary">Отключить с зависимыми (${sim.withDependents.length})</button>` : ''}
        <button id="depOnly" class="primary">Отключить${broken ? ' только его' : ''}</button>`;
      actions.querySelector('#depOnly').addEventListener('click', async () => {
        await api.setModEnabled(mcVersion, loader, mod.fileName, false);
        await refresh();
      });
      actions.querySelector('#depWith')?.addEventListener('click', async () => {
        await api.disableManyMods(mcVersion, loader, sim.withDependents);
        await refresh();
      });
    };

    const showEnableSim = async (mod, el) => {
      const sim = await api.simulateEnableMod(mcVersion, loader, mod.fileName);
      if (selected !== mod.fileName || !sim) return;
      const parts = [];
      for (const n of sim.needs) {
        const off = n.disabledProviders.length ? ` — отключён «${esc(n.disabledProviders[0].name)}», включи и его` : '';
        parts.push(`<div class="diag-note warn">Нужен «${esc(n.id)}»${off}</div>`);
      }
      for (const c of sim.conflicts) parts.push(`<div class="diag-note warn">Конфликтует с ${names(c.withNames.map(n => ({ name: n })))}</div>`);
      if (sim.fixes.length) parts.push(`<div class="diag-note good">Починит: ${names(sim.fixes)}</div>`);
      el.querySelector('#depSim').outerHTML = parts.length ? parts.join('') : '<div class="diag-note good">Можно включать, проблем не видно.</div>';

      const actions = el.querySelector('#depActions');
      actions.innerHTML = '<button id="depOn" class="primary">Включить</button>';
      actions.querySelector('#depOn').addEventListener('click', async () => {
        await api.setModEnabled(mcVersion, loader, mod.fileName, true);
        await refresh();
      });
    };

    draw();
  }

  // спрашиваем перед выключением мода в списке: что от него зависит.
  // Возвращает список файлов для отключения или null, если пользователь передумал.
  async function askBeforeDisable(fileName) {
    const { mcVersion, loader } = currentSelection();
    let sim;
    try {
      sim = await api.simulateDisableMods(mcVersion, loader, [fileName], libraryFiles());
    } catch {
      return [fileName]; // не смогли посчитать — не мешаем
    }
    const broken = sim.direct.length + sim.cascade.length;
    if (!broken) return [fileName];

    return new Promise(resolve => {
      let answer = null;
      // любое закрытие без выбора (крестик, Escape, клик мимо) считаем отменой
      const box = openModal(`
        <div class="diag-head"><h3>Другие моды зависят от этого</h3><button class="diag-x" data-close>×</button></div>
        <p class="diag-summary">Если отключить «${esc(sim.requested[0].name)}», перестанут запускаться (${broken}):</p>
        ${cascadeTreeHtml(sim, fileName)}
        <div class="text-prompt-actions">
          <button data-close class="secondary">Отмена</button>
          <button id="askOnly" class="secondary">Только его</button>
          <button id="askAll" class="primary">С зависимыми (${sim.withDependents.length})</button>
        </div>`, false, () => resolve(answer));
      box.querySelector('#askOnly').addEventListener('click', () => { answer = [fileName]; closeModal(); });
      box.querySelector('#askAll').addEventListener('click', () => { answer = sim.withDependents; closeModal(); });
    });
  }

  // ---------- метрики ресурсов ----------

  const fmtSec = ms => ms == null ? '—' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} с`;
  const fmtMb = v => v == null ? '—' : `${Math.round(v)} МБ`;
  const signed = (v, unit) => `${v > 0 ? '+' : ''}${Math.round(v)} ${unit}`;

  let chartSeq = 0;

  // график с заливкой, осями и подсказкой при наведении; рисуем в переданный контейнер
  function renderChart(el, points, { width = 720, height = 190, xFmt = x => x, yFmt = v => Math.round(v), marker = null, dots = false } = {}) {
    if (points.length < 2) { el.innerHTML = '<div class="desc">Мало данных для графика.</div>'; return; }
    const pad = { l: 50, r: 16, t: 14, b: 26 };
    const x0 = points[0].x, x1 = points[points.length - 1].x;
    const maxY = Math.max(...points.map(p => p.y)) * 1.12 || 1;
    const sx = x => pad.l + (x1 === x0 ? 0 : (x - x0) / (x1 - x0)) * (width - pad.l - pad.r);
    const sy = y => height - pad.b - (y / maxY) * (height - pad.t - pad.b);
    const gid = `chartfill${++chartSeq}`;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const area = `${line} L${sx(x1).toFixed(1)},${sy(0)} L${sx(x0).toFixed(1)},${sy(0)} Z`;

    const yTicks = [0, 1, 2, 3, 4].map(i => {
      const v = maxY * i / 4, y = sy(v);
      return `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" class="diag-grid"/>
        <text x="${pad.l - 8}" y="${y + 3}" class="diag-axis" text-anchor="end">${yFmt(v)}</text>`;
    }).join('');
    const xTicks = [0, 1, 2, 3, 4].map(i => {
      const v = x0 + (x1 - x0) * i / 4;
      return `<text x="${sx(v)}" y="${height - 7}" class="diag-axis" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${xFmt(v)}</text>`;
    }).join('');
    const mark = marker && marker.x >= x0 && marker.x <= x1
      ? `<line x1="${sx(marker.x)}" x2="${sx(marker.x)}" y1="${pad.t}" y2="${height - pad.b}" class="chart-marker"/>
         <text x="${sx(marker.x) + 5}" y="${pad.t + 9}" class="diag-axis">${esc(marker.label)}</text>` : '';
    const pts = dots ? points.map(p => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4.5" class="diag-pt ${p.cls || ''}"/>`).join('') : '';

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="diag-chart">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:var(--accent-hi);stop-opacity:.4"/><stop offset="100%" style="stop-color:var(--accent-hi);stop-opacity:0"/>
      </linearGradient></defs>
      ${yTicks}${xTicks}${mark}
      <path d="${area}" fill="url(#${gid})"/><path d="${line}" class="chart-line"/>${pts}
      <g class="chart-hover" style="display:none"><line y1="${pad.t}" y2="${height - pad.b}" class="chart-cursor"/><circle r="5" class="chart-dot"/>
        <rect rx="5" class="chart-tipbg"/><text class="chart-tip"/></g></svg>`;

    const svg = el.querySelector('svg'), hover = svg.querySelector('.chart-hover');
    const tip = hover.querySelector('.chart-tip'), bg = hover.querySelector('.chart-tipbg');
    svg.addEventListener('mouseleave', () => { hover.style.display = 'none'; });
    svg.addEventListener('mousemove', e => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const vx = (e.clientX - r.left) / r.width * width;
      const target = x0 + (vx - pad.l) / (width - pad.l - pad.r) * (x1 - x0);
      let best = points[0];
      for (const p of points) if (Math.abs(p.x - target) < Math.abs(best.x - target)) best = p;
      const cx = sx(best.x), cy = sy(best.y);
      hover.style.display = '';
      hover.querySelector('.chart-cursor').setAttribute('x1', cx);
      hover.querySelector('.chart-cursor').setAttribute('x2', cx);
      hover.querySelector('.chart-dot').setAttribute('cx', cx);
      hover.querySelector('.chart-dot').setAttribute('cy', cy);
      tip.textContent = best.label || `${xFmt(best.x)} · ${yFmt(best.y)} МБ`;
      const tw = tip.textContent.length * 6.2 + 14;
      const tx = cx + 10 + tw > width ? cx - 10 - tw : cx + 10;
      bg.setAttribute('x', tx); bg.setAttribute('y', Math.max(2, cy - 28)); bg.setAttribute('width', tw); bg.setAttribute('height', 20);
      tip.setAttribute('x', tx + 7); tip.setAttribute('y', Math.max(2, cy - 28) + 14);
    });
  }

  function changesText(c) {
    const out = [];
    if (c.added.length) out.push(`добавлено: ${c.added.map(m => m.name).join(', ')}`);
    if (c.removed.length) out.push(`убрано: ${c.removed.map(m => m.name).join(', ')}`);
    if (c.updated.length) out.push(`обновлено: ${c.updated.map(m => m.name).join(', ')}`);
    return out.join('; ');
  }

  function deltaHtml(cur, prev, unit, fmt = v => Math.round(v)) {
    if (cur == null || prev == null) return '';
    const d = cur - prev;
    if (!d || Math.abs(d) < 0.005) return '<span class="met-delta">без изменений</span>';
    return `<span class="met-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))} ${unit}</span>`;
  }

  function statCard(label, value, delta) {
    return `<div class="met-card"><div class="met-label">${label}</div><div class="met-value">${value}</div>${delta || '<span class="met-delta"></span>'}</div>`;
  }

  async function showMetrics() {
    const { mcVersion, loader } = currentSelection();
    const box = openModal(`
      <div class="diag-head"><h3>Метрики ресурсов</h3><button class="diag-x" data-close>×</button></div>
      <div id="metBody" class="desc">Загружаю...</div>`, true);
    const body = box.querySelector('#metBody');
    let shownRun = null;

    const showRun = async runId => {
      shownRun = runId;
      body.querySelectorAll('[data-run]').forEach(r => r.classList.toggle('active', r.dataset.run === runId));
      const el = body.querySelector('#metChart');
      const run = await api.getMetricRun(mcVersion, loader, runId);
      if (!el) return;
      body.querySelector('#metChartTitle').textContent = run ? `Запуск от ${new Date(run.startedAt).toLocaleString(window.i18n.locale)}` : '';
      if (!run || !run.samples?.length) { el.innerHTML = '<div class="desc">Для этого запуска нет замеров.</div>'; return; }
      renderChart(el, run.samples.map(s => ({ x: s.t, y: s.rss })), {
        xFmt: t => `${Math.round(t / 1000)} с`,
        marker: run.summary?.loadMs != null ? { x: run.summary.loadMs, label: 'игра загрузилась' } : null
      });
    };

    const draw = async () => {
      const { runs, analysis } = await api.listMetricRuns(mcVersion, loader);
      body.className = '';
      if (!runs.length) {
        body.innerHTML = `<div class="met-empty"><div class="met-empty-ico">📊</div>
          <div class="diag-title">Данных пока нет</div>
          <div class="desc">Запусти игру: лаунчер сам запишет потребление ОЗУ и процессора. Когда набор модов изменится между запусками, здесь появится, что стало тяжелее.</div></div>`;
        return;
      }
      const latest = runs[0], prev = runs[1];
      const ls = latest.summary || {}, ps = prev?.summary || {};
      const maxRam = Math.max(...runs.map(r => r.summary?.peakRssMb || 0)) || 1;
      const history = runs.slice().reverse().filter(r => r.summary?.menuRssMb != null);
      const when = r => new Date(r.startedAt).toLocaleString(window.i18n.locale);

      body.innerHTML = `
        <div class="met-sub">${esc(mcVersion)} · ${esc(loader)} · запусков: ${runs.length}${latest.exitCode ? ' · последний завершился с ошибкой' : ''}</div>
        <div class="met-cards">
          ${statCard('ОЗУ в меню', fmtMb(ls.menuRssMb), deltaHtml(ls.menuRssMb, ps.menuRssMb, 'МБ'))}
          ${statCard('Пик ОЗУ', fmtMb(ls.peakRssMb), deltaHtml(ls.peakRssMb, ps.peakRssMb, 'МБ'))}
          ${statCard('Загрузка', fmtSec(ls.loadMs), deltaHtml(ls.loadMs, ps.loadMs, 'с', v => (v / 1000).toFixed(1)))}
          ${statCard('CPU в простое', ls.idleCpuCores != null ? ls.idleCpuCores.toFixed(2) + ' яд.' : '—', deltaHtml(ls.idleCpuCores, ps.idleCpuCores, 'яд.', v => v.toFixed(2)))}
        </div>
        <div class="met-note-top">Карточки — последний запуск${prev ? ', стрелки — разница с предыдущим' : ''}.</div>

        <div class="diag-section"><h4 id="metChartTitle">Потребление ОЗУ</h4><div id="metChart" class="met-chart"></div></div>

        ${history.length > 1 ? `<div class="diag-section"><h4>ОЗУ в главном меню по запускам</h4><div id="metHistory" class="met-chart"></div>
          <div class="desc">Точки с жёлтой рамкой — запуски, где менялся набор модов.</div></div>` : `
          <div class="met-hint">Это только первый запуск. Запусти игру ещё раз, изменив моды (добавь или убери), и лаунчер покажет, как это повлияло.</div>`}

        ${findingsHtml(analysis, runs)}
        ${impactHtml(analysis)}

        <div class="diag-section"><h4>Все запуски</h4>
          <div class="met-runs">
            ${runs.slice(0, 20).map(r => `
              <div class="met-run ${r.exitCode ? 'bad' : ''} ${r.id === shownRun ? 'active' : ''}" data-run="${esc(r.id)}">
                <div class="met-run-top"><span>${when(r)}</span><span class="desc">${r.mods.length} модов · загрузка ${fmtSec(r.summary?.loadMs)} · CPU ${r.summary?.idleCpuCores != null ? r.summary.idleCpuCores.toFixed(2) : '—'}</span></div>
                <div class="met-bar"><i style="width:${Math.max(3, (r.summary?.peakRssMb || 0) / maxRam * 100)}%"></i><b style="width:${Math.max(2, (r.summary?.menuRssMb || 0) / maxRam * 100)}%"></b></div>
                <div class="met-run-bot"><span>меню ${fmtMb(r.summary?.menuRssMb)}</span><span class="desc">пик ${fmtMb(r.summary?.peakRssMb)}</span></div>
              </div>`).join('')}
          </div>
        </div>
        <div class="text-prompt-actions"><button id="metClear" class="secondary">Очистить историю</button></div>`;

      if (history.length > 1) {
        renderChart(body.querySelector('#metHistory'), history.map((r, i) => ({
          x: i, y: r.summary.menuRssMb, label: `${when(r)} · ${fmtMb(r.summary.menuRssMb)}`,
          cls: i && r.modsHash !== history[i - 1].modsHash ? 'changed' : ''
        })), { height: 170, dots: true, xFmt: i => `#${Math.round(i) + 1}` });
      }
      body.querySelectorAll('[data-run]').forEach(row => row.addEventListener('click', () => showRun(row.dataset.run)));
      body.querySelector('#metClear').addEventListener('click', async () => {
        if (!await customConfirm('Удалить всю историю метрик для этой версии?')) return;
        await api.clearMetrics(mcVersion, loader);
        shownRun = null;
        draw();
      });
      showRun(shownRun && runs.some(r => r.id === shownRun) ? shownRun : latest.id);
    };

    try {
      await draw();
    } catch (err) {
      body.textContent = `Не получилось загрузить метрики: ${err.message}`;
    }
  }

  function findingsHtml(analysis, runs) {
    if (!analysis.findings.length) {
      return analysis.runsAnalyzed < 2
        ? ''
        : '<div class="diag-section"><h4>Что менялось</h4><div class="desc">Заметных скачков потребления между запусками не найдено.</div></div>';
    }
    const when = f => new Date(f.at).toLocaleString(window.i18n.locale);
    return `<div class="diag-section"><h4>Что менялось</h4>${analysis.findings.slice(0, 6).map(f => `
      <div class="diag-card ${f.type}">
        <div class="diag-card-head">
          <span class="diag-title">${f.type === 'regression' ? 'Стало тяжелее' : 'Стало легче'} · ${when(f)}</span>
          <span class="diag-badge ${f.confidence}">уверенность: ${LEVELS[f.confidence]}</span>
        </div>
        <div>ОЗУ в меню: ${fmtMb(f.before.rssMb)} → ${fmtMb(f.after.rssMb)} (${signed(f.delta.rssMb, 'МБ')})${f.delta.loadMs != null ? `, загрузка ${signed(f.delta.loadMs / 1000, 'с')}` : ''}</div>
        <div class="diag-note">${esc(changesText(f.changes))}</div>
        ${f.settingsChanged ? '<div class="diag-note warn">Одновременно менялись настройки памяти или JVM, поэтому причина неточная.</div>' : ''}
        ${f.changeCount > 1 ? `<div class="desc">Менялось модов: ${f.changeCount}, так что виноват может быть любой из них.</div>` : ''}
      </div>`).join('')}</div>`;
  }

  function impactHtml(analysis) {
    if (!analysis.impact.length) return '';
    return `<div class="diag-section"><h4>Примерная «цена» модов по ОЗУ</h4>
      <div class="desc">Среднее по запускам с модом и без него при одинаковых настройках.</div>
      ${analysis.impact.map(i => `
        <div class="diag-row"><span>${esc(i.name)}${i.inseparable ? ' <span class="desc">(всегда менялись вместе)</span>' : ''}</span>
          <span class="${i.deltaRssMb > 0 ? 'diag-bad' : 'diag-good'}">${signed(i.deltaRssMb, 'МБ')}</span></div>`).join('')}</div>`;
  }

  function drawPerformanceMonitor() {
    if (!performanceMonitorBox || !performanceMonitorBox.isConnected) return;
    const body = performanceMonitorBox.querySelector('#perfMonitorBody');
    if (!body) return;
    const sample = performanceState.latest;
    const status = !performanceState.supported
      ? 'Измерение производительности недоступно на этой системе'
      : performanceState.running
        ? 'Minecraft работает · данные обновляются автоматически'
        : sample ? 'Последняя сессия завершена' : 'Ожидаю запуск Minecraft';
    if (!sample) {
      body.innerHTML = `<div class="perf-live-status"><span class="perf-status-dot ${performanceState.running ? 'active' : ''}"></span>${esc(status)}</div>
        <div class="met-empty"><div class="diag-title">Нет текущих замеров</div><div class="desc">Запусти Minecraft, и здесь появятся загрузка процессора и использование оперативной памяти. Данные снимаются примерно раз в 5 секунд в начале запуска, затем раз в 15 секунд.</div></div>`;
      return;
    }
    const cpu = sample.cpuPercent == null ? '—' : `${sample.cpuPercent.toFixed(1)}%`;
    const ram = `${Math.round(sample.rssMb).toLocaleString(window.i18n.locale)} МБ`;
    const total = sample.totalMemMb ? `${(sample.totalMemMb / 1024).toFixed(1)} ГБ` : '—';
    const elapsed = `${Math.floor((sample.t || 0) / 60000)} мин ${Math.floor(((sample.t || 0) % 60000) / 1000)} с`;
    const rows = performanceState.samples.slice(-80);
    body.innerHTML = `
      <div class="perf-live-status"><span class="perf-status-dot ${performanceState.running ? 'active' : ''}"></span>${esc(status)}</div>
      <div class="met-cards perf-live-cards">
        ${statCard('CPU процесса', cpu, '<span class="met-delta">от общей мощности процессора</span>')}
        ${statCard('ОЗУ процесса', ram, `<span class="met-delta">из ${total} системной памяти</span>`)}
        ${statCard('Время с запуска', elapsed, '<span class="met-delta"></span>')}
      </div>
      <div class="diag-section"><h4>Использование ОЗУ во время игры</h4><div id="perfLiveChart" class="met-chart"></div></div>
      <div class="desc">CPU — доля от общей вычислительной мощности системы. GPU и FPS без отдельного источника телеметрии здесь не отображаются.</div>`;
    const chart = body.querySelector('#perfLiveChart');
    if (rows.length > 1) {
      renderChart(chart, rows.map(r => ({ x: r.t, y: r.rssMb })), {
        xFmt: t => `${Math.round(t / 60000)} мин`,
        yFmt: v => `${Math.round(v)} МБ`,
        height: 190
      });
    } else {
      chart.innerHTML = '<div class="desc">Нужно ещё несколько замеров, чтобы построить график.</div>';
    }
  }

  function onPerformanceSample(data) {
    if (!data) return;
    if (data.status === 'started') {
      performanceState.running = true;
      performanceState.supported = data.supported !== false;
      performanceState.latest = null;
      performanceState.samples = [];
    } else if (Number.isFinite(data.rssMb)) {
      performanceState.running = true;
      performanceState.latest = data;
      performanceState.samples.push(data);
      if (performanceState.samples.length > 180) performanceState.samples.splice(0, performanceState.samples.length - 180);
    }
    drawPerformanceMonitor();
  }

  function onPerformanceStopped() {
    performanceState.running = false;
    drawPerformanceMonitor();
  }

  function showPerformanceMonitor() {
    const box = openModal(`
      <div class="diag-head"><h3>Производительность Minecraft</h3><button class="diag-x" data-close>×</button></div>
      <div id="perfMonitorBody"></div>`, true, () => { performanceMonitorBox = null; });
    performanceMonitorBox = box;
    drawPerformanceMonitor();
  }

  return { onCrashAnalysis, analyzeReport, showDependencies, showMetrics, showPerformanceMonitor, onPerformanceSample, onPerformanceStopped, askBeforeDisable };
})();
