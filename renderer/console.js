window.fcConsole = (() => {
  const log = document.getElementById('playLog');
  const bar = document.getElementById('consoleBar');
  const searchInput = document.getElementById('consoleSearch');
  const autoInput = document.getElementById('consoleAuto');
  const expandBtn = document.getElementById('consoleExpand');
  const clearBtn = document.getElementById('consoleClear');
  const status = document.getElementById('consoleStatus');
  const chips = [...bar.querySelectorAll('.console-chip')];

  const state = { autoscroll: true, query: '' };
  const LEVELS = ['error', 'warn', 'info', 'debug'];
  let expanded = false;
  let countTimer = null;

  function levelOf(line) {
    if (line.classList.contains('error')) return 'error';
    if (line.classList.contains('warn')) return 'warn';
    if (line.classList.contains('debug')) return 'debug';
    return 'info';
  }

  function matches(line) {
    if (!state.query) return true;
    return line.textContent.toLowerCase().includes(state.query);
  }

  function applyQuery(line) {
    line.classList.toggle('log-miss', !matches(line));
  }

  function updateCounts() {
    countTimer = null;
    const counts = { error: 0, warn: 0, info: 0, debug: 0 };
    let visible = 0;
    const lines = log.children;
    for (const line of lines) {
      const level = levelOf(line);
      counts[level]++;
      const hiddenLevel = log.classList.contains(`hide-${level}`);
      if (!hiddenLevel && !line.classList.contains('log-miss')) visible++;
    }
    for (const level of LEVELS) {
      const el = bar.querySelector(`[data-count="${level}"]`);
      if (el) el.textContent = counts[level];
    }
    const t = window.i18n.t;
    status.textContent = lines.length && visible !== lines.length
      ? `${t('Показано')} ${visible} ${t('из')} ${lines.length}`
      : '';
  }

  function scheduleCounts() {
    if (countTimer) return;
    countTimer = setTimeout(updateCounts, 250);
  }

  new MutationObserver(records => {
    if (state.query) {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) applyQuery(node);
        }
      }
    }
    scheduleCounts();
  }).observe(log, { childList: true });

  chips.forEach(chip => chip.addEventListener('click', () => {
    const level = chip.dataset.level;
    const on = chip.classList.toggle('is-on');
    log.classList.toggle(`hide-${level}`, !on);
    scheduleCounts();
    if (state.autoscroll) log.scrollTop = log.scrollHeight;
  }));

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim().toLowerCase();
    for (const line of log.children) applyQuery(line);
    scheduleCounts();
    if (state.autoscroll) log.scrollTop = log.scrollHeight;
  });

  autoInput.addEventListener('change', () => {
    state.autoscroll = autoInput.checked;
    if (state.autoscroll) log.scrollTop = log.scrollHeight;
  });

  log.addEventListener('wheel', e => {
    if (e.deltaY < 0 && state.autoscroll) {
      state.autoscroll = false;
      autoInput.checked = false;
    }
  }, { passive: true });

  expandBtn.addEventListener('click', () => {
    expanded = !expanded;
    log.classList.toggle('is-expanded', expanded);
    expandBtn.textContent = window.i18n.t(expanded ? 'Свернуть' : 'Развернуть');
    if (state.autoscroll) log.scrollTop = log.scrollHeight;
  });

  clearBtn.addEventListener('click', () => {
    log.innerHTML = '';
    scheduleCounts();
  });

  return state;
})();
