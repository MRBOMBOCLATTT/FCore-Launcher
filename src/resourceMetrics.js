// Метрики ресурсов: пока идёт игра, раз в несколько секунд снимаем ОЗУ и загрузку CPU процесса Java,
// а по окончании сохраняем «запуск» вместе со снимком набора модов. Сравнивая соседние запуски,
// находим момент, когда игра стала тяжелее, и показываем, какие моды добавились/обновились между ними.
//
// Честные ограничения (их же показываем в интерфейсе):
//  • это корреляция, а не профилирование: если между запусками изменилось 5 модов, мы знаем
//    только что «виноват один из 5»;
//  • память меряем как RSS процесса в окне «главное меню после загрузки», а не в мире —
//    так запуски сравнимы между собой, но не показывают пик в конкретной игре;
//  • сравниваем запуски только с одинаковыми настройками памяти и JVM-аргументами.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { scanModsDir } = require('./modIndex');
const modManager = require('./modManager');
const { toLiveSample } = require('./performanceSample');

const FAST_INTERVAL_MS = 5000;
const SLOW_INTERVAL_MS = 15000;
const FAST_PHASE_SAMPLES = 36;            // первые ~3 минуты снимаем чаще — там идёт загрузка
const MAX_STORED_RUNS = 40;
const RUNS_WITH_SAMPLES = 12;             // у старых запусков оставляем только сводку
const MAX_STORED_POINTS = 150;
const FALLBACK_LOADED_MS = 120000;        // если не поймали «игра загружена» по логу

// строки, после которых клиент уже в главном меню (первая найденная побеждает)
const LOADED_PATTERNS = [/Sound engine started/i, /OpenAL initialized/i];

// ---------- сэмплеры процесса ----------

function startLinuxSampler(pid, onSample) {
  const ticksPerSec = 100; // CLK_TCK на практике всегда 100
  let timer = null, stopped = false, n = 0;
  const read = () => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cpuSec = (Number(rest[11]) + Number(rest[12])) / ticksPerSec;
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKb = Number((status.match(/VmRSS:\s+(\d+)\s+kB/) || [])[1]);
      if (Number.isFinite(cpuSec) && Number.isFinite(rssKb)) onSample({ cpuSec, rssMb: rssKb / 1024 });
      return true;
    } catch { return false; } // процесса больше нет
  };
  const tick = () => {
    if (stopped) return;
    if (!read()) return;
    n++;
    timer = setTimeout(tick, n < FAST_PHASE_SAMPLES ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

// Windows: один долгоживущий PowerShell-процесс печатает строку на каждый замер.
// Это дешевле, чем запускать powershell.exe заново каждые 5 секунд.
// Числа печатаем инвариантной культурой — иначе в русской локали будет «12,5» вместо «12.5».
function startWindowsSampler(pid, onSample) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$inv=[Globalization.CultureInfo]::InvariantCulture',
    '$n=0',
    'while($true){',
    `  $p=Get-Process -Id ${Number(pid)}`,
    '  if(-not $p){break}',
    '  [Console]::Out.WriteLine($p.TotalProcessorTime.TotalSeconds.ToString($inv)+" "+$p.WorkingSet64.ToString($inv))',
    '  $n++',
    `  Start-Sleep -Milliseconds $(if($n -lt ${FAST_PHASE_SAMPLES}){${FAST_INTERVAL_MS}}else{${SLOW_INTERVAL_MS}})`,
    '}'
  ].join('\n');

  let child;
  try {
    child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }

  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = line.match(/^([\d.,]+)\s+(\d+)$/);
      if (!m) continue;
      onSample({ cpuSec: Number(m[1].replace(',', '.')), rssMb: Number(m[2]) / 1024 / 1024 });
    }
  });
  child.on('error', () => {});
  return () => { try { child.kill(); } catch {} };
}

function startSampler(pid, onSample) {
  if (process.platform === 'linux') return startLinuxSampler(pid, onSample);
  if (process.platform === 'win32') return startWindowsSampler(pid, onSample);
  return null; // macOS лаунчером не поддерживается
}

// ---------- статистика ----------

const median = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function summarize(samples, loadedAtMs, durationMs) {
  if (!samples.length) return null;
  const ref = loadedAtMs ?? FALLBACK_LOADED_MS;
  const inWindow = (a, b) => samples.filter(s => s.t >= a && s.t <= b);

  const peak = Math.max(...samples.map(s => s.rss));
  let menu = inWindow(ref + 5000, ref + 60000).map(s => s.rss);
  const hasMenuWindow = menu.length >= 2;
  if (!hasMenuWindow) menu = [];

  const cpuIn = (a, b) => inWindow(a, b).map(s => s.cpu).filter(v => v != null);
  const loadCpu = mean(cpuIn(0, ref));
  const idleCpu = mean(cpuIn(ref + 10000, ref + 60000));

  return {
    loadMs: loadedAtMs ?? null,
    peakRssMb: round(peak),
    menuRssMb: hasMenuWindow ? round(median(menu)) : null,   // null → запуск слишком короткий для сравнения
    loadCpuCores: round(loadCpu, 2),
    idleCpuCores: round(idleCpu, 2),
    durationMs
  };
}

function downsample(samples, max) {
  if (samples.length <= max) return samples;
  const out = [];
  const bucket = samples.length / max;
  for (let i = 0; i < max; i++) {
    const slice = samples.slice(Math.floor(i * bucket), Math.floor((i + 1) * bucket));
    if (!slice.length) continue;
    const cpus = slice.map(s => s.cpu).filter(v => v != null);
    out.push({
      t: slice[0].t,
      rss: round(Math.max(...slice.map(s => s.rss))),
      cpu: cpus.length ? round(mean(cpus), 2) : null
    });
  }
  return out;
}

// ---------- хранилище ----------

function storePath(root, mcVersion, loader) {
  const dir = path.join(root, 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${mcVersion}-${loader}.json`.replace(/[^\w.\-]/g, '_'));
}

function readRuns(root, mcVersion, loader) {
  try { return JSON.parse(fs.readFileSync(storePath(root, mcVersion, loader), 'utf8')).runs || []; }
  catch { return []; }
}

function writeRuns(root, mcVersion, loader, runs) {
  const trimmed = runs.slice(-MAX_STORED_RUNS).map((r, i, arr) =>
    i < arr.length - RUNS_WITH_SAMPLES ? { ...r, samples: [] } : r);
  const file = storePath(root, mcVersion, loader);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ runs: trimmed }));
  fs.renameSync(tmp, file);
}

function clearRuns(root, mcVersion, loader) {
  try { fs.unlinkSync(storePath(root, mcVersion, loader)); } catch { /* уже нет */ }
}

// ---------- снимок набора модов ----------

async function snapshotMods(root, mcVersion, loader) {
  const scan = await scanModsDir(modManager.getModsDir(root, mcVersion, loader), { loader });
  const mods = scan.filter(j => j.enabled).map(j => ({
    key: j.mods?.[0]?.id || j.fileName,   // id мода стабилен между версиями файла
    fileName: j.fileName,
    name: j.mods?.[0]?.name || j.fileName,
    version: j.mods?.[0]?.version || null,
    size: j.size
  })).sort((a, b) => a.key.localeCompare(b.key));
  const hash = crypto.createHash('sha1')
    .update(mods.map(m => `${m.key}@${m.version}|${m.size}`).join('\n')).digest('hex').slice(0, 12);
  return { mods, hash };
}

// ---------- сессия записи ----------

// Вызывается из launcher.js сразу после старта процесса игры.
// Не блокирует запуск: снимок модов и сэмплирование идут в фоне.
function startSession({ root, mcVersion, loader, pid, settings = {}, onError = () => {}, onLiveSample = () => {} }) {
  const startedAt = Date.now();
  const samples = [];
  let prevCpuSec = null, prevT = null;
  let loadedAtMs = null;
  let stopSampler = null;
  let snapshot = null;
  let finished = false;

  try { onLiveSample({ status: 'started', startedAt, supported: process.platform === 'linux' || process.platform === 'win32' }); } catch (err) { onError(err); }

  const snapshotPromise = snapshotMods(root, mcVersion, loader)
    .then(s => { snapshot = s; })
    .catch(err => onError(err));

  try {
    stopSampler = startSampler(pid, ({ cpuSec, rssMb }) => {
      const t = Date.now() - startedAt;
      let cpu = null;
      if (prevCpuSec != null && t > prevT) cpu = Math.max(0, (cpuSec - prevCpuSec) / ((t - prevT) / 1000));
      prevCpuSec = cpuSec; prevT = t;
      samples.push({ t, rss: round(rssMb), cpu: cpu == null ? null : round(cpu, 2) });
      try { onLiveSample(toLiveSample({ t, rssMb, cpuCores: cpu, totalCores: os.cpus().length, totalMemMb: os.totalmem() / 1024 / 1024 })); }
      catch (err) { onError(err); }
    });
  } catch (err) { onError(err); }

  return {
    supported: !!stopSampler,

    // строки stdout/логов игры — ловим момент «игра загрузилась»
    noteLogLine(text) {
      if (loadedAtMs != null || typeof text !== 'string') return;
      if (LOADED_PATTERNS.some(re => re.test(text))) loadedAtMs = Date.now() - startedAt;
    },

    async stop(exitCode) {
      if (finished) return null;
      finished = true;
      try { stopSampler?.(); } catch {}
      await snapshotPromise;
      if (!samples.length || !snapshot) return null;

      const endedAt = Date.now();
      const run = {
        id: `run-${startedAt}`,
        startedAt, endedAt, exitCode,
        mcVersion, loader,
        settings: {
          memoryMax: settings.memoryMax ?? null,
          memoryMin: settings.memoryMin ?? null,
          jvmArgs: (settings.jvmArgs || '').trim(),
          java: settings.java || null
        },
        hardware: { cores: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1024 / 1024) },
        mods: snapshot.mods,
        modsHash: snapshot.hash,
        loadDetected: loadedAtMs != null,
        summary: summarize(samples, loadedAtMs, endedAt - startedAt),
        samples: downsample(samples, MAX_STORED_POINTS)
      };
      try {
        const runs = readRuns(root, mcVersion, loader);
        runs.push(run);
        writeRuns(root, mcVersion, loader, runs);
      } catch (err) { onError(err); }
      return run;
    }
  };
}

// ---------- сравнение и поиск «когда стало тяжелее» ----------

function settingsSignature(r) {
  return `${r.settings?.memoryMax}|${r.settings?.memoryMin}|${r.settings?.jvmArgs}|${r.settings?.java}`;
}

function diffMods(prev, next) {
  const a = new Map(prev.mods.map(m => [m.key, m]));
  const b = new Map(next.mods.map(m => [m.key, m]));
  const added = [], removed = [], updated = [];
  for (const [k, m] of b) {
    const old = a.get(k);
    if (!old) added.push({ key: k, name: m.name, version: m.version });
    else if (old.version !== m.version || old.size !== m.size) {
      updated.push({ key: k, name: m.name, from: old.version, to: m.version });
    }
  }
  for (const [k, m] of a) if (!b.has(k)) removed.push({ key: k, name: m.name, version: m.version });
  return { added, removed, updated };
}

const changeCount = d => d.added.length + d.removed.length + d.updated.length;

// Находит запуски, на которых заметно выросли (или упали) ОЗУ / время загрузки / CPU,
// и сопоставляет их с изменением набора модов.
function analyzeRuns(allRuns) {
  const runs = allRuns
    .filter(r => r.summary && r.summary.menuRssMb != null)
    .sort((a, b) => a.startedAt - b.startedAt);

  const result = { runsAnalyzed: runs.length, findings: [], noiseRssMb: 0, impact: [] };
  if (runs.length < 2) return result;

  // шум: насколько ОЗУ гуляет между запусками, когда моды НЕ менялись
  const quiet = [];
  for (let i = 1; i < runs.length; i++) {
    const same = runs[i - 1].modsHash === runs[i].modsHash && settingsSignature(runs[i - 1]) === settingsSignature(runs[i]);
    if (same) quiet.push(Math.abs(runs[i].summary.menuRssMb - runs[i - 1].summary.menuRssMb));
  }
  const noise = quiet.length >= 2 ? median(quiet) : 0;
  result.noiseRssMb = round(noise);

  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1], cur = runs[i];
    const diff = diffMods(prev, cur);
    const n = changeCount(diff);
    if (!n) continue;

    const dRss = cur.summary.menuRssMb - prev.summary.menuRssMb;
    const dLoad = cur.summary.loadMs != null && prev.summary.loadMs != null ? cur.summary.loadMs - prev.summary.loadMs : null;
    const dCpu = cur.summary.idleCpuCores != null && prev.summary.idleCpuCores != null
      ? cur.summary.idleCpuCores - prev.summary.idleCpuCores : null;

    const rssLimit = Math.max(150, prev.summary.menuRssMb * 0.10, noise * 2.5);
    const loadLimit = prev.summary.loadMs != null ? Math.max(4000, prev.summary.loadMs * 0.15) : Infinity;
    const cpuLimit = prev.summary.idleCpuCores != null ? Math.max(0.15, prev.summary.idleCpuCores * 0.3) : Infinity;

    const worse = dRss >= rssLimit || (dLoad != null && dLoad >= loadLimit) || (dCpu != null && dCpu >= cpuLimit);
    const better = dRss <= -rssLimit || (dLoad != null && dLoad <= -loadLimit);
    if (!worse && !better) continue;

    const settingsChanged = settingsSignature(prev) !== settingsSignature(cur);
    let confidence = n === 1 ? 'high' : n <= 3 ? 'medium' : 'low';
    if (settingsChanged) confidence = 'low';

    result.findings.push({
      type: worse ? 'regression' : 'improvement',
      fromRunId: prev.id, toRunId: cur.id,
      at: cur.startedAt,
      changes: diff,
      changeCount: n,
      confidence,
      settingsChanged,
      delta: {
        rssMb: round(dRss),
        loadMs: dLoad == null ? null : round(dLoad),
        idleCpuCores: dCpu == null ? null : round(dCpu, 2)
      },
      before: { rssMb: prev.summary.menuRssMb, loadMs: prev.summary.loadMs },
      after: { rssMb: cur.summary.menuRssMb, loadMs: cur.summary.loadMs }
    });
  }
  result.findings.reverse(); // новые сверху

  // грубая оценка «стоимости» мода по всем запускам с одинаковыми настройками:
  // средняя ОЗУ запусков с модом минус без него. Даёт подсказку, если моды меняли по одному в разные дни.
  const bySig = new Map();
  for (const r of runs) {
    const k = settingsSignature(r);
    if (!bySig.has(k)) bySig.set(k, []);
    bySig.get(k).push(r);
  }
  const group = [...bySig.values()].sort((a, b) => b.length - a.length)[0] || [];
  if (group.length >= 4) {
    const keys = new Set(group.flatMap(r => r.mods.map(m => m.key)));
    const names = new Map(group.flatMap(r => r.mods.map(m => [m.key, m.name])));

    // моды, которые во всех запусках появлялись и исчезали вместе, неразличимы статистически —
    // показываем их одной строкой, а не двумя «независимыми» цифрами
    const bySignature = new Map();
    for (const key of keys) {
      const sig = group.map(r => (r.mods.some(m => m.key === key) ? '1' : '0')).join('');
      if (!bySignature.has(sig)) bySignature.set(sig, []);
      bySignature.get(sig).push(key);
    }

    for (const [sig, members] of bySignature) {
      const withMod = group.filter((r, i) => sig[i] === '1').map(r => r.summary.menuRssMb);
      const without = group.filter((r, i) => sig[i] === '0').map(r => r.summary.menuRssMb);
      if (withMod.length < 2 || without.length < 2) continue;
      const d = mean(withMod) - mean(without);
      if (Math.abs(d) < Math.max(80, noise * 2)) continue;
      result.impact.push({
        key: members[0],
        name: members.map(k => names.get(k)).join(' + '),
        members,
        inseparable: members.length > 1,
        deltaRssMb: round(d),
        runsWith: withMod.length,
        runsWithout: without.length
      });
    }
    result.impact.sort((a, b) => b.deltaRssMb - a.deltaRssMb);
    result.impact = result.impact.slice(0, 8);
  }
  return result;
}

// без семплов — для списка
function listRuns(root, mcVersion, loader) {
  const runs = readRuns(root, mcVersion, loader);
  return {
    runs: runs.map(({ samples, ...rest }) => ({ ...rest, hasSamples: !!(samples && samples.length) })).reverse(),
    analysis: analyzeRuns(runs)
  };
}

function getRun(root, mcVersion, loader, runId) {
  return readRuns(root, mcVersion, loader).find(r => r.id === runId) || null;
}

module.exports = {
  startSession, listRuns, getRun, clearRuns, analyzeRuns, diffMods, summarize, downsample, toLiveSample
};
