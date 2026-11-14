window.fcLaunchSettings = (() => {
  const api = window.api;
  const $ = id => document.getElementById(id);
  const section = $('launchSettingsSection');
  if (!section) return {};

  const fields = {
    memoryMode: $('lsMemoryMode'),
    memoryMin: $('lsMemoryMin'),
    memoryMax: $('lsMemoryMax'),
    gcProfile: $('lsGc'),
    jvmArgs: $('lsJvmArgs'),
    javaPath: $('lsJavaPath'),
    env: $('lsEnv'),
    preCommand: $('lsPreCommand'),
    postCommand: $('lsPostCommand')
  };
  const customRow = $('lsCustomRow');
  const reco = $('lsReco');
  const sub = $('launchSettingsSub');
  const scope = $('lsScope');

  let key = '';
  let recommendation = null;
  let globals = null;

  function formatGb(mb) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} ${window.i18n.t('ГБ')}`;
  }

  function syncVisibility() {
    const mode = fields.memoryMode.value;
    customRow.style.display = mode === 'custom' ? '' : 'none';
    reco.style.display = mode === 'auto' && recommendation ? '' : 'none';
  }

  function renderReco() {
    if (!recommendation) {
      reco.textContent = '';
      return;
    }
    const range = recommendation.minMb === recommendation.maxMb
      ? formatGb(recommendation.maxMb)
      : `${formatGb(recommendation.minMb)} – ${formatGb(recommendation.maxMb)}`;
    const reasons = (recommendation.reasons || []).map(r => `<li>${escHtml(r)}</li>`).join('');
    reco.innerHTML = `<div class="ls-reco-title">Лаунчер выделит ${escHtml(range)}</div>${reasons ? `<ul>${reasons}</ul>` : ''}`;
  }

  function fill(settings) {
    fields.memoryMode.value = settings.memoryMode;
    fields.memoryMin.value = settings.memoryMin;
    fields.memoryMax.value = settings.memoryMax;
    fields.gcProfile.checked = !!settings.gcProfile;
    fields.jvmArgs.value = settings.jvmArgs || '';
    fields.javaPath.value = settings.javaPath || '';
    fields.env.value = settings.env || '';
    fields.preCommand.value = settings.preCommand || '';
    fields.postCommand.value = settings.postCommand || '';
    syncVisibility();
  }

  function collect() {
    return {
      memoryMode: fields.memoryMode.value,
      memoryMin: fields.memoryMin.value.trim(),
      memoryMax: fields.memoryMax.value.trim(),
      gcProfile: fields.gcProfile.checked,
      jvmArgs: fields.jvmArgs.value.trim(),
      javaPath: fields.javaPath.value.trim(),
      env: fields.env.value,
      preCommand: fields.preCommand.value.trim(),
      postCommand: fields.postCommand.value.trim()
    };
  }

  function describe(settings) {
    const t = window.i18n.t;
    const parts = [];
    if (settings.memoryMode === 'auto') parts.push(t('память авто'));
    if (settings.memoryMode === 'custom') parts.push(`${t('память')} ${settings.memoryMax}`);
    if (settings.gcProfile) parts.push('GC');
    if (settings.jvmArgs) parts.push('JVM');
    if (settings.javaPath) parts.push('Java');
    if (settings.env) parts.push('env');
    if (settings.preCommand || settings.postCommand) parts.push(t('команды'));
    return parts.length ? parts.join(', ') : t('Память, аргументы, Java и команды');
  }

  async function load() {
    const { mcVersion, loader } = currentSelection();
    if (!mcVersion || !loader) return;
    const active = window.__activeBuild;
    scope.textContent = active
      ? `Действуют только для сборки «${active.name}». Всё, что не задано здесь, берётся из общих настроек.`
      : 'Действуют для версии и загрузчика, выбранных сейчас. Всё, что не задано здесь, берётся из общих настроек.';
    const requested = `${mcVersion}|${loader}|${active ? active.id : ''}`;
    key = requested;
    try {
      const res = await api.getLaunchSettings(mcVersion, loader);
      if (key !== requested) return;
      recommendation = res.recommendation;
      globals = res.global;
      fill(res.settings);
      renderReco();
      sub.textContent = describe(res.settings);
    } catch (err) {
      showToast(String((err && err.message) || err), 'error', 'Настройки запуска');
    }
  }

  const presetSelect = $('gamePresetSelect');
  async function refreshGamePresets() {
    if (!presetSelect) return;
    const selected = presetSelect.value;
    const presets = await api.listGamePresets();
    presetSelect.innerHTML = '<option value="">Выбери пресет</option>' + presets.map(p =>
      `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`
    ).join('');
    if (presets.some(p => p.id === selected)) presetSelect.value = selected;
  }

  $('gamePresetSave').addEventListener('click', async () => {
    const name = await askForText('Название пресета игры:');
    if (!name) return;
    try {
      await api.saveGamePreset(name, collect());
      await refreshGamePresets();
      showToast('Пресет игры сохранён', 'success');
    } catch (err) { showToast(err.message || String(err), 'error'); }
  });

  $('gamePresetApply').addEventListener('click', async () => {
    const preset = (await api.listGamePresets()).find(p => p.id === presetSelect.value);
    if (!preset) return showToast('Сначала выбери пресет', 'warn');
    const { mcVersion, loader } = currentSelection();
    try {
      const saved = await api.setLaunchSettings(mcVersion, loader, preset.settings);
      fill(saved);
      sub.textContent = describe(saved);
      showToast(`Пресет «${preset.name}» применён`, 'success');
    } catch (err) { showToast(err.message || String(err), 'error'); }
  });

  $('gamePresetDelete').addEventListener('click', async () => {
    if (!presetSelect.value) return showToast('Сначала выбери пресет', 'warn');
    const preset = (await api.listGamePresets()).find(p => p.id === presetSelect.value);
    if (!preset || !(await customConfirm(`Удалить пресет «${preset.name}»?`))) return;
    await api.deleteGamePreset(preset.id);
    await refreshGamePresets();
    showToast('Пресет удалён', 'info');
  });

  refreshGamePresets().catch(err => console.error('Game presets:', err));

  fields.memoryMode.addEventListener('change', syncVisibility);

  $('lsPickJava').addEventListener('click', async () => {
    const file = await api.pickLaunchJava();
    if (file) fields.javaPath.value = file;
  });

  $('lsSave').addEventListener('click', async () => {
    const { mcVersion, loader } = currentSelection();
    try {
      const saved = await api.setLaunchSettings(mcVersion, loader, collect());
      fill(saved);
      sub.textContent = describe(saved);
      showToast('Настройки запуска сохранены', 'success');
    } catch (err) {
      const message = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      showToast(message, 'error', 'Не удалось сохранить');
    }
  });

  $('lsReset').addEventListener('click', async () => {
    const { mcVersion, loader } = currentSelection();
    try {
      const saved = await api.setLaunchSettings(mcVersion, loader, {});
      fill(saved);
      sub.textContent = describe(saved);
      showToast('Настройки запуска сброшены', 'info');
    } catch (err) {
      showToast(String((err && err.message) || err), 'error', 'Не удалось сбросить');
    }
  });

  section.addEventListener('toggle', () => {
    if (section.open) load();
  });

  [versionSelect, loaderSelect].forEach(el => el.addEventListener('change', () => {
    setTimeout(load, 0);
  }));

  setTimeout(load, 500);

  return { reload: load };
})();
