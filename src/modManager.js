const fs = require('fs');
const path = require('path');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const { getCurseforgeApiKey } = require('./store');
const { isAlreadyDownloaded } = require('./fileCache');
const { downloadFileWithRetry, runWithConcurrency, ensureFreeSpace } = require('./downloader');
const builds = require('./builds');

// источник мода определяет, через чей API проверять версию — модам без
// поля source считаем источником Modrinth (старые записи до появления CurseForge)
function getCompatibleVersion(source, projectId, mcVersion, loader) {
  if (source === 'curseforge') return curseforge.getCompatibleVersion(projectId, mcVersion, loader, getCurseforgeApiKey());
  return modrinth.getCompatibleVersion(projectId, mcVersion, loader);
}

function getProjectTitle(source, projectId) {
  if (source === 'curseforge') return curseforge.getModInfo(projectId, getCurseforgeApiKey()).then(i => i.title);
  return modrinth.getProjectInfo(projectId).then(i => i.title);
}

function getInstanceDir(root, mcVersion, loader) {
  return path.join(root, 'instances', builds.dirName(mcVersion, loader));
}

function getModsDir(root, mcVersion, loader) {
  return path.join(getInstanceDir(root, mcVersion, loader), 'mods');
}

// файлы модов, которые сейчас лежат на диске — включая выключенные (.disabled),
// чтобы можно было массово переключать их без переустановки
function listInstalledMods(root, mcVersion, loader) {
  const modsDir = getModsDir(root, mcVersion, loader);
  if (!fs.existsSync(modsDir)) return [];

  return fs.readdirSync(modsDir)
    .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
    .map(f => ({
      fileName: f.replace(/\.disabled$/, ''),
      enabled: !f.endsWith('.disabled')
    }));
}

function setModEnabled(root, mcVersion, loader, fileName, enabled) {
  const modsDir = getModsDir(root, mcVersion, loader);
  const enabledPath = path.join(modsDir, fileName);
  const disabledPath = `${enabledPath}.disabled`;

  if (enabled && fs.existsSync(disabledPath)) fs.renameSync(disabledPath, enabledPath);
  else if (!enabled && fs.existsSync(enabledPath)) fs.renameSync(enabledPath, disabledPath);

  return listInstalledMods(root, mcVersion, loader);
}

function setAllModsEnabled(root, mcVersion, loader, enabled) {
  for (const mod of listInstalledMods(root, mcVersion, loader)) {
    setModEnabled(root, mcVersion, loader, mod.fileName, enabled);
  }
  return listInstalledMods(root, mcVersion, loader);
}

// Сначала разбираемся, что вообще нужно (сам список + зависимости),
// а качаем и удаляем только в конце — так при повторном запуске
// не трогаем файлы, которые уже стоят нужной версии.
// dryRun: true — только проверить, что всё найдётся на Modrinth, ничего не менять на диске
// targetProjectId: если задан — по сети проверяем только этот мод (и его зависимости),
// остальные из wantedMods просто защищаем от удаления по последнему известному файлу,
// без обращений к Modrinth. Нужно для точечного обновления одного мода
async function reinstallMods(root, mcVersion, loader, wantedMods, onProgress = () => {}, dryRun = false, targetProjectId = null, installDeps = true) {
  const modsDir = getModsDir(root, mcVersion, loader);
  fs.mkdirSync(modsDir, { recursive: true });

  const wantedFiles = [];
  const failed = [];
  const seen = new Set();
  const pinned = wantedMods.filter(m => m.pinned && m.pinnedFileName);

  // моды, которые уже стоят в списке сами по себе (добавлены вручную или как
  // чья-то зависимость раньше) — их не нужно повторно тащить как "зависимость"
  // другого мода, они и так проверятся/скачаются по своей собственной записи
  const alreadyWantedIds = new Set(wantedMods.map(m => m.projectId));

  const toCheck = targetProjectId
    ? wantedMods.filter(m => !m.pinned && m.projectId === targetProjectId)
    : wantedMods.filter(m => !m.pinned);
  const untouched = targetProjectId
    ? wantedMods.filter(m => !m.pinned && m.projectId !== targetProjectId)
    : [];

  // снимок «последнего известного файла» для каждого мода — обновляется при
  // каждой успешной проверке ниже и используется, если Modrinth не ответит
  // прямо сейчас, чтобы не удалить рабочий файл только из-за сбоя запроса
  const lastKnownFileName = new Map(
    wantedMods.filter(m => !m.pinned && m.lastFileName).map(m => [m.projectId, m.lastFileName])
  );

  // Зависимости мода узнаются только после его проверки, поэтому вся очередь
  // сразу параллельно не разгоняется — обрабатываем волнами: сначала параллельно
  // проверяем текущую пачку модов (concurrency 6), собираем найденные зависимости,
  // резолвим их тайтлы тоже параллельно, и это становится следующей волной.
  let wave = toCheck.map(m => ({ projectId: m.projectId, title: m.title, source: m.source || 'modrinth', skipDeps: m.skipDeps === true }));
  // моды, у которых пользователь выбрал «только мод без зависимостей»
  const skipDepsIds = new Set(wantedMods.filter(m => m.skipDeps === true).map(m => m.projectId));

  while (wave.length) {
    const nextWaveIds = new Map(); // projectId -> source, дедуп зависимостей внутри волны

    await runWithConcurrency(wave, async ({ projectId, title, source, skipDeps }) => {
      if (seen.has(projectId)) return;
      seen.add(projectId);

      onProgress({ stage: 'checking', projectId, title });

      let version;
      try {
        version = await getCompatibleVersion(source, projectId, mcVersion, loader);
      } catch (err) {
        failed.push({ projectId, title, reason: err.message });
        return;
      }

      if (!version) {
        failed.push({ projectId, title, reason: `Нет сборки под ${mcVersion} (${loader})` });
        return;
      }

      wantedFiles.push({ projectId, title, source, ...version });

      if (installDeps && !skipDeps && !skipDepsIds.has(projectId)) {
        for (const depId of version.dependencies) {
          if (!seen.has(depId) && !alreadyWantedIds.has(depId)) nextWaveIds.set(depId, source);
        }
      }
    }, 6);

    const depEntries = [...nextWaveIds.entries()];
    wave = await runWithConcurrency(depEntries, async ([depId, source]) => {
      let depTitle = depId;
      try {
        depTitle = await getProjectTitle(source, depId);
      } catch {
        // если инфа не подтянулась, просто покажем id вместо названия
      }
      return { projectId: depId, title: depTitle, source };
    }, 6);
  }

  const pinnedSkipped = pinned.map(m => ({ projectId: m.projectId, title: m.title, fileName: m.pinnedFileName, pinned: true }));

  if (dryRun) {
    const willSkip = wantedFiles.filter(f =>
      isAlreadyDownloaded(path.join(modsDir, f.fileName), f.sha1) ||
      isAlreadyDownloaded(path.join(modsDir, `${f.fileName}.disabled`), f.sha1)
    );
    const willDownload = wantedFiles.filter(f => !willSkip.includes(f));
    return { installed: willDownload, skipped: [...willSkip, ...pinnedSkipped], failed, dryRun: true };
  }

  // убираем то, чего больше нет в списке (или устаревшую версию с другим именем файла) —
  // выключенные (.disabled) не трогаем, это осознанный выбор пользователя;
  // закреплённые моды тоже не трогаем, даже если их версия не совпадает с последней на Modrinth
  const wantedFileNames = new Set(wantedFiles.map(f => f.fileName));
  for (const m of pinned) wantedFileNames.add(m.pinnedFileName);

  // если проверить мод не удалось (сеть легла, Modrinth ответил ошибкой,
  // рейт-лимит, проект сняли с публикации) — оставляем уже стоящий файл в
  // покое, иначе пользователь вместо обновления просто теряет мод
  for (const f of failed) {
    const known = lastKnownFileName.get(f.projectId);
    if (known) wantedFileNames.add(known);
  }

  // моды, которые в этот раз не проверяли (точечное обновление другого мода) —
  // просто оставляем их файл как есть, не трогаем и не удаляем
  const untouchedSkipped = [];
  for (const m of untouched) {
    if (m.lastFileName) {
      wantedFileNames.add(m.lastFileName);
      untouchedSkipped.push({ projectId: m.projectId, title: m.title, fileName: m.lastFileName });
    }
  }

  // Точечная установка одного мода не должна чистить папку: раньше она удаляла всё,
  // чего нет в списке, включая зависимости других модов (например Fabric API)
  // и файлы, положенные вручную. После этого другие моды падали при запуске.
  // Тут убираем только старый файл самого мода, если имя файла сменилось.
  if (targetProjectId) {
    const target = wantedMods.find(m => m.projectId === targetProjectId);
    const newFile = wantedFiles.find(f => f.projectId === targetProjectId);
    const oldName = target && !target.pinned ? target.lastFileName : null;
    if (oldName && newFile && oldName !== newFile.fileName) {
      for (const suffix of ['', '.disabled']) {
        const old = path.join(modsDir, oldName + suffix);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }
  } else {
    for (const file of fs.readdirSync(modsDir)) {
      if (file.startsWith('_')) continue; // служебные файлы лаунчера (например CustomSkinLoader), их сюда не пускаем
      const baseName = file.replace(/\.disabled$/, '');
      if ((file.endsWith('.jar') || file.endsWith('.jar.disabled')) && !wantedFileNames.has(baseName)) {
        fs.unlinkSync(path.join(modsDir, file));
      }
    }
  }

  const installed = [];
  const skipped = [...pinnedSkipped];
  const toDownload = [];

  for (const file of wantedFiles) {
    const dest = path.join(modsDir, file.fileName);
    const disabledDest = `${dest}.disabled`;

    // мод выключен пользователем (переименован в .disabled) — не трогаем,
    // иначе переустановка молча включала бы то, что специально выключили
    if (isAlreadyDownloaded(disabledDest, file.sha1)) {
      skipped.push({ projectId: file.projectId, title: file.title, fileName: file.fileName, disabled: true });
      continue;
    }

    if (isAlreadyDownloaded(dest, file.sha1)) {
      skipped.push({ projectId: file.projectId, title: file.title, fileName: file.fileName });
      continue;
    }

    toDownload.push({ file, dest });
  }

  if (toDownload.length) {
    onProgress({ stage: 'start', total: toDownload.length, queue: toDownload.map(({ file }) => ({ title: file.title, fileName: file.fileName })) });
    await ensureFreeSpace(modsDir, 150 * 1024 * 1024, 'модов');
  }

  let doneCount = 0;
  let bytesDone = 0;
  const startedAt = Date.now();

  // качаем сразу несколько модов параллельно, а не по одному —
  // заметно ускоряет установку/переустановку сборки
  await runWithConcurrency(toDownload, async ({ file, dest }) => {
    onProgress({ stage: 'downloading', projectId: file.projectId, title: file.title, fileName: file.fileName, done: doneCount, total: toDownload.length });
    const { bytes } = await downloadFileWithRetry(file.url, dest, {
      onRetry: r => onProgress({ stage: 'retry', title: file.title, ...r })
    });
    doneCount++;
    bytesDone += bytes;
    const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const speedBps = bytesDone / elapsedSec;
    const remaining = toDownload.length - doneCount;
    const etaSec = doneCount > 0 ? Math.round((elapsedSec / doneCount) * remaining) : null;
    installed.push({ projectId: file.projectId, title: file.title, fileName: file.fileName, versionNumber: file.versionNumber });
    onProgress({ stage: 'downloaded', projectId: file.projectId, title: file.title, fileName: file.fileName, done: doneCount, total: toDownload.length, speedBps, etaSec });
  }, 6);

  return { installed, skipped: [...skipped, ...untouchedSkipped], failed };
}

// Ставит конкретную версию мода, выбранную вручную (как на самом Modrinth,
// а не просто "последнюю совместимую"). Если раньше стоял другой файл этого
// же мода — сносим его, чтобы не плодить дубликаты.
async function installVersionFile(root, mcVersion, loader, version, previousFileName = null) {
  const modsDir = getModsDir(root, mcVersion, loader);
  fs.mkdirSync(modsDir, { recursive: true });

  if (previousFileName && previousFileName !== version.fileName) {
    for (const suffix of ['', '.disabled']) {
      const p = path.join(modsDir, previousFileName + suffix);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  const dest = path.join(modsDir, version.fileName);
  if (!isAlreadyDownloaded(dest, version.sha1)) {
    await ensureFreeSpace(modsDir, 150 * 1024 * 1024, 'модов');
    await downloadFileWithRetry(version.url, dest);
  }

  return { fileName: version.fileName };
}

// Разворачивает дерево зависимостей одного мода без скачивания — используется
// перед добавлением, чтобы показать пользователю, что ещё установится вместе с модом.
// Полноценное разрешение (с скачиванием) всё равно происходит в reinstallMods —
// это просто более лёгкий предпросмотр для одного конкретного мода.
async function resolveModDependencies(mcVersion, loader, projectId, existingProjectIds = [], source = 'modrinth', installedModIds = []) {
  const installed = new Set(installedModIds.map(id => String(id).toLowerCase()));
  const seen = new Set([projectId, ...existingProjectIds]);
  const deps = [];
  let wave = [projectId];

  while (wave.length) {
    const nextWaveIds = new Set();

    for (const id of wave) {
      let version;
      try {
        version = await getCompatibleVersion(source, id, mcVersion, loader);
      } catch {
        continue;
      }
      if (!version) continue;

      for (const depId of version.dependencies) {
        if (!seen.has(depId)) nextWaveIds.add(depId);
      }
    }

    seen.forEach(id => nextWaveIds.delete(id));
    if (!nextWaveIds.size) break;

    for (const depId of nextWaveIds) {
      seen.add(depId);
      let title = depId;
      let slug = null;
      try {
        if (source === 'curseforge') {
          title = await getProjectTitle(source, depId);
        } else {
          const info = await modrinth.getProjectInfo(depId);
          title = info.title;
          slug = info.slug;
        }
      } catch {
        // не подтянулось название — покажем id
      }
      // зависимость уже лежит в папке mods (поставлена вручную), второй раз не предлагаем
      if (slug && installed.has(String(slug).toLowerCase())) continue;
      deps.push({ projectId: depId, title, source });
    }

    wave = [...nextWaveIds];
  }

  return deps;
}

// Скачивает мод, которого не хватает другому моду. dependencyId это id мода из метаданных
// jar (например fabric-api), на Modrinth он чаще всего совпадает со slug проекта.
// Если прямого совпадения нет, ищем по названию и берём только точное совпадение.
async function installMissingDependency(root, mcVersion, loader, dependencyId) {
  let project = null;
  try {
    const info = await modrinth.getProjectInfo(dependencyId);
    if (info && info.project_type === 'mod') project = { id: info.id, title: info.title, icon: info.icon_url || null };
  } catch { /* не slug, ищем поиском ниже */ }

  if (!project) {
    const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const found = await modrinth.searchMods(dependencyId, mcVersion, loader, 10);
    const hit = found.hits.find(h => norm(h.slug) === norm(dependencyId) || norm(h.title) === norm(dependencyId));
    if (hit) project = { id: hit.id, title: hit.title, icon: hit.icon || null };
  }
  if (!project) return { ok: false, notFound: true, error: `Мод «${dependencyId}» не найден на Modrinth по точному совпадению` };

  const version = await modrinth.getCompatibleVersion(project.id, mcVersion, loader);
  if (!version) return { ok: false, error: `У «${project.title}» нет сборки под ${mcVersion} (${loader})`, title: project.title };

  const result = await installVersionFile(root, mcVersion, loader, version);
  return { ok: true, projectId: project.id, title: project.title, icon: project.icon, fileName: result.fileName, versionNumber: version.versionNumber };
}

module.exports = { installMissingDependency, getInstanceDir, getModsDir, reinstallMods, listInstalledMods, setModEnabled, setAllModsEnabled, resolveModDependencies, installVersionFile };
