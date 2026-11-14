// Авто-починка модов: после падения игры собирает улики (stdout, crash-reports, latest.log,
// hs_err), находит подозрительный мод и предлагает ОБРАТИМОЕ исправление.
//
// Принципы:
//  • Ничего не удаляем. «Починить» = переименовать X.jar → X.jar.disabled (так же, как тумблер
//    в списке модов). Каждое исправление пишется в журнал, его можно откатить одной кнопкой.
//  • Уверенность честная. Стек-трейс показывает, где упало, а не кто виноват — поэтому у
//    эвристики по стеку потолок 0.7, а прямые заявления загрузчика («Mod X requires Y, which
//    is missing») весят больше всего.
//  • Предупреждаем о каскаде: если отключаемый мод нужен другим, они тоже перестанут грузиться.
const fs = require('fs');
const path = require('path');
const modManager = require('./modManager');
const { scanModsDir } = require('./modIndex');
const graphLib = require('./modGraph');
const { diagnoseCrash } = require('./crashReporter');

const JOURNAL_FILE = 'crash-fixes.json';
const MAX_JOURNAL = 50;
const LOG_TAIL_BYTES = 256 * 1024;
const MAX_CONFIDENCE = 0.97;

// ---------- вспомогательное ----------

function safeBase(name) {
  return typeof name === 'string' && name.length > 0 && path.basename(name) === name && !name.includes('\0');
}

function readTail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(bytes, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function newestMatching(dir, re, notBefore, notAfter = Infinity) {
  try {
    return fs.readdirSync(dir)
      .filter(f => re.test(f))
      .map(f => ({ f, p: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter(x => x.t >= notBefore && x.t <= notAfter)
      .sort((a, b) => b.t - a.t)[0] || null;
  } catch { return null; }
}

// ---------- сбор улик ----------

// endedAt задаём при разборе СТАРОГО отчёта: файлы новее него относятся к другим запускам
function gatherSources({ instanceDir, startedAt, endedAt, recentLines }) {
  const notBefore = (startedAt || 0) - 15000;
  const notAfter = endedAt ? endedAt + 60000 : Infinity;
  const sources = [];

  const report = newestMatching(path.join(instanceDir, 'crash-reports'), /^crash-.*\.txt$/i, notBefore, notAfter);
  if (report) sources.push({ kind: 'crash-report', file: report.p, text: readHead(report.p, 512 * 1024) });

  const hs = newestMatching(instanceDir, /^hs_err_pid\d+\.log$/i, notBefore, notAfter);
  if (hs) sources.push({ kind: 'hs-err', file: hs.p, text: readHead(hs.p, 96 * 1024) });

  // latest.log перезаписывается каждым запуском — для старого отчёта он уже не тот
  const latest = path.join(instanceDir, 'logs', 'latest.log');
  try {
    if (fs.existsSync(latest) && fs.statSync(latest).mtimeMs <= notAfter) {
      sources.push({ kind: 'latest-log', file: latest, text: readTail(latest, LOG_TAIL_BYTES) });
    }
  } catch { /* лог мог пропасть */ }

  if (recentLines && recentLines.length) sources.push({ kind: 'stdout', file: null, text: recentLines.join('\n') });
  return sources;
}

// пакет класса → jar. Нужен, чтобы по строке стека «at me.foo.bar.Baz.run» найти мод.
function buildPackageIndex(graph) {
  const idx = new Map(); // "me.foo.bar" -> Set(fileName)
  for (const j of graph.jars) {
    if (!j.enabled) continue;
    for (const dir of j.packages || []) {
      const dots = dir.replace(/\//g, '.');
      if (!idx.has(dots)) idx.set(dots, new Set());
      idx.get(dots).add(j.fileName);
    }
  }
  return idx;
}

function classToJar(fqn, pkgIndex) {
  const cls = fqn.replace(/\//g, '.');
  const lastDot = cls.lastIndexOf('.');
  if (lastDot < 0) return null;
  let pkg = cls.slice(0, lastDot);
  while (pkg.includes('.')) {
    const hit = pkgIndex.get(pkg);
    if (hit) return hit.size === 1 ? [...hit][0] : null; // пакет делят несколько jar — не гадаем
    pkg = pkg.slice(0, pkg.lastIndexOf('.'));
  }
  return null;
}

// классы игры, загрузчиков и библиотек — не «мод», даже если стек идёт через них
const NON_MOD_PREFIX = [
  'java.', 'javax.', 'jdk.', 'sun.', 'com.sun.', 'net.minecraft.', 'com.mojang.', 'net.minecraftforge.',
  'net.neoforged.', 'cpw.mods.', 'org.spongepowered.', 'net.fabricmc.loader.', 'net.fabricmc.api.',
  'org.lwjgl.', 'io.netty.', 'it.unimi.', 'com.google.', 'org.apache.', 'org.objectweb.', 'org.slf4j.',
  'org.quiltmc.loader.', 'org.joml.', 'com.electronwill.', 'oshi.', 'org.openjdk.'
];

// ---------- детекторы ----------
// Каждый добавляет улики вида { modId | fileName, weight, reason, evidence, extra }

function detectLoaderMessages(text, push) {
  let m;

  // Fabric: «Mod 'Iris' (iris) 1.6.11 requires version 0.5.8 or later of sodium, which is missing!»
  const fabMissing = /Mod '([^']+)' \(([^)]+)\)\s+\S+\s+requires\s+(.+?),\s+which is missing/g;
  while ((m = fabMissing.exec(text))) {
    const dep = (m[3].match(/(?:of|mod)\s+(?:'[^']*'\s*\()?([\w\-.]+)\)?\s*$/) || [])[1] || m[3];
    push({ modId: m[2], weight: 0.9, kind: 'missing-dependency', missingId: dep,
      reason: `требует «${dep}», которого нет в папке mods`, evidence: m[0] });
  }

  // Fabric: версия зависимости не подходит
  const fabWrong = /Mod '([^']+)' \(([^)]+)\)\s+\S+\s+requires\s+(.+?),\s+but only the wrong version is present:\s*([^\s!]+)/g;
  while ((m = fabWrong.exec(text))) {
    const dep = (m[3].match(/of\s+(?:'[^']*'\s*\()?([\w\-.]+)\)?\s*$/) || [])[1] || m[3];
    push({ modId: m[2], weight: 0.88, kind: 'wrong-dependency-version', missingId: dep,
      reason: `нужна другая версия «${dep}» (сейчас ${m[4]})`, evidence: m[0] });
  }

  // Fabric: несовместимость / конфликт двух модов
  const fabConflict = /Mod '([^']+)' \(([^)]+)\)\s+\S+\s+(?:is incompatible with|conflicts with|breaks)\s+(?:any version of |version [^\s]+ of )?(?:mod )?(?:'[^']*'\s*\()?([\w\-.]+)\)?/g;
  while ((m = fabConflict.exec(text))) {
    push({ modId: m[2], weight: 0.8, kind: 'incompatible', withId: m[3],
      reason: `несовместим с модом «${m[3]}»`, evidence: m[0] });
  }

  // Forge/NeoForge: «Mod ID: 'curios', Requested by: 'jei', Expected range: '[5.0,)', Actual version: '[MISSING]'»
  const forgeDep = /Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'/g;
  while ((m = forgeDep.exec(text))) {
    const missing = /MISSING/i.test(m[4]);
    push({ modId: m[2], weight: 0.9, kind: missing ? 'missing-dependency' : 'wrong-dependency-version', missingId: m[1],
      reason: missing ? `требует «${m[1]}», которого нет` : `нужна «${m[1]}» ${m[3]}, а стоит ${m[4]}`, evidence: m[0] });
  }

  // Forge: «-- Mod loading issue for: jei --»
  const issue = /Mod loading issue for:\s*([\w\-.]+)/g;
  while ((m = issue.exec(text))) {
    push({ modId: m[1], weight: 0.9, kind: 'load-failure', reason: 'загрузчик сообщил об ошибке при загрузке этого мода', evidence: m[0] });
  }

  // FML: «ModLoadingException: Name (id) has failed to load correctly»
  const fml = /ModLoadingException:\s*(.+?)\s+\(([\w\-.]+)\)\s+has failed to load/g;
  while ((m = fml.exec(text))) {
    push({ modId: m[2], weight: 0.9, kind: 'load-failure', reason: 'мод не смог загрузиться', evidence: m[0] });
  }

  // Forge: «Mod File: /…/mods/foo.jar» внутри блока ошибки загрузки
  const fileRe = /Mod [Ff]ile:\s*(.+?\.jar)\b/g;
  while ((m = fileRe.exec(text))) {
    push({ fileName: path.basename(m[1].replace(/\\/g, '/')), weight: 0.8, kind: 'load-failure',
      reason: 'загрузчик указал этот файл как источник ошибки', evidence: m[0] });
  }

  // Forge: блок «Suspected Mods:» из crash-report
  const sus = text.match(/Suspected Mods:\s*\n((?:[ \t]+.*\n?)+)/);
  if (sus) {
    for (const line of sus[1].split('\n')) {
      const mm = line.match(/\(([\w\-.]+)\)/);
      if (mm) push({ modId: mm[1], weight: 0.72, kind: 'suspected', reason: 'указан в «Suspected Mods» отчёта о падении', evidence: line.trim() });
    }
  }
}

function detectMixin(text, push, configToJar) {
  let m;
  const apply = /Mixin apply for mod ([\w\-.]+) failed ([\w\-.]+\.json)/g;
  while ((m = apply.exec(text))) {
    push({ modId: m[1], weight: 0.9, kind: 'mixin', reason: `не применился mixin «${m[2]}»`, evidence: m[0] });
  }

  const fromMod = /from mod ['"]?([\w\-.]+)/g;
  while ((m = fromMod.exec(text))) {
    push({ modId: m[1], weight: 0.75, kind: 'mixin', reason: 'ошибка внедрения (mixin) из этого мода', evidence: m[0] });
  }

  // строки про mixin-конфиг + слова об ошибке → jar по имени конфига
  for (const line of text.split('\n')) {
    if (!/mixin/i.test(line) || !/(failed|error|exception|InvalidInjection|MixinApply|InjectionError|MixinTransformer)/i.test(line)) continue;
    const cfg = line.match(/([\w\-.]+\.mixins?\.json|[\w\-.]*mixins?[\w\-.]*\.json)/i);
    if (!cfg) continue;
    const file = configToJar.get(cfg[1]);
    if (file) push({ fileName: file, weight: 0.7, kind: 'mixin', reason: `ошибка в mixin-конфиге «${cfg[1]}»`, evidence: line.trim().slice(0, 220) });
  }
}

// Разбор стека: берём блоки «исключение + at …», считаем, какой мод встречается ближе к вершине
function detectStack(text, push, pkgIndex) {
  const lines = text.split('\n');
  const score = new Map();   // fileName -> { score, sample }
  let block = null;
  const flush = () => {
    if (!block) return;
    let seen = 0;
    for (const fqn of block.frames) {
      if (NON_MOD_PREFIX.some(p => fqn.startsWith(p))) continue;
      const file = classToJar(fqn, pkgIndex);
      if (!file) continue;
      const w = (1 / (1 + seen)) * block.mult;
      const cur = score.get(file) || { score: 0, sample: fqn, blockHead: block.head };
      cur.score += w;
      score.set(file, cur);
      seen++;
      if (seen >= 4) break;
    }
    block = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    const frame = line.match(/^at\s+([\w$.\/]+)\.[\w$<>]+\(/);
    if (frame && block) { block.frames.push(frame[1]); continue; }
    // новая «шапка» исключения — закрываем прошлый блок
    const head = line.match(/^(?:Caused by:\s*)?([\w$.]+(?:Exception|Error|Throwable)):?\s*(.*)$/);
    if (head) {
      flush();
      const isRoot = /^Caused by:/.test(line);
      const sevError = /NoSuchMethod|NoSuchField|AbstractMethod|IncompatibleClassChange|NoClassDefFound|ClassNotFound|LinkageError/.test(head[1]);
      block = { frames: [], mult: (isRoot ? 1.5 : 1) * (sevError ? 1.3 : 1), head: head[1] };
    }
  }
  flush();

  for (const [file, v] of score) {
    // потолок 0.7: стек показывает место падения, но не гарантирует виновника
    const weight = Math.min(0.7, 0.25 + 0.22 * v.score);
    push({ fileName: file, weight, kind: 'stack', reason: `его код есть в стеке ошибки (${v.sample})`, evidence: `${v.blockHead} … ${v.sample}` });
  }
}

function detectJavaVersion(text, push, pkgIndex) {
  const m = text.match(/UnsupportedClassVersionError:\s*([\w$./]+)[^\n]*?class file version (\d+)(?:\.\d+)?/i);
  if (!m) return null;
  const need = Number(m[2]) - 44;
  const file = classToJar(m[1], pkgIndex);
  if (file) push({ fileName: file, weight: 0.85, kind: 'java-version', reason: `собран под Java ${need}, а запущено на более старой`, evidence: m[0].slice(0, 220) });
  return { kind: 'java-version', message: `Мод собран под Java ${need} или новее. Выбери Java ${need}+ в настройках лаунчера — или другую версию мода.` };
}

function detectEnvironment({ code, text, sources }) {
  const env = [];
  const diag = diagnoseCrash({ code, recentLines: text.split('\n').slice(-400) });
  if (diag) env.push({ kind: 'diagnosis', message: diag });

  const hs = sources.find(s => s.kind === 'hs-err');
  if (hs) {
    const frame = hs.text.match(/# Problematic frame:\s*\n#\s*\w\s+\[([^\]+]+)/);
    const lib = frame ? frame[1].trim() : null;
    if (lib) {
      if (/nvoglv|nvwgf|nvd3d|atio|amdxx|aticfx|ig\d+icd|igd\d|iris|opengl32/i.test(lib)) {
        env.push({ kind: 'gpu', message: `JVM упала внутри графической библиотеки ${lib}. Обычно помогает обновление драйвера видеокарты или другой выбор GPU в настройках.` });
      } else if (/jvm\.dll|libjvm/i.test(lib)) {
        env.push({ kind: 'jvm', message: `Падение внутри JVM (${lib}). Попробуй другую сборку Java или убери нестандартные JVM-аргументы.` });
      } else {
        env.push({ kind: 'native', message: `Падение в нативной библиотеке ${lib} — это не ошибка мода на Java, а сбой драйвера или нативного кода.` });
      }
    }
    if (/insufficient memory for the Java Runtime/i.test(hs.text)) {
      env.push({ kind: 'memory', message: 'Системе не хватило памяти под JVM: выдели игре меньше ОЗУ или закрой другие программы.' });
    }
  }
  return env;
}

// ---------- основной анализ ----------

function confidenceLabel(c) {
  return c >= 0.8 ? 'high' : c >= 0.55 ? 'medium' : 'low';
}

async function analyzeCrash({ root, mcVersion, loader, code, recentLines = [], startedAt = 0, endedAt = 0 }) {
  const instanceDir = modManager.getInstanceDir(root, mcVersion, loader);
  const modsDir = modManager.getModsDir(root, mcVersion, loader);

  const sources = gatherSources({ instanceDir, startedAt, endedAt, recentLines });
  const text = sources.map(s => s.text).join('\n');

  const scan = await scanModsDir(modsDir, { loader });
  const graph = graphLib.buildGraph(scan, { mcVersion });
  const enabledJars = graph.jars.filter(j => j.enabled);

  const result = {
    mcVersion, loader, code,
    analyzedAt: Date.now(),
    sources: sources.map(s => ({ kind: s.kind, file: s.file })),
    modsScanned: enabledJars.length,
    suspects: [],
    environment: [],
    missing: [],
    recommended: [],
    summary: null
  };

  // индексы для сопоставления
  const idToFile = id => (graph.enabledProviders.get(id) || [])[0] || null;
  const pkgIndex = buildPackageIndex(graph);
  const configToJar = new Map();
  for (const j of enabledJars) for (const c of j.mixinConfigs || []) if (!configToJar.has(c)) configToJar.set(c, j.fileName);

  const evidence = []; // сырые улики
  const push = e => evidence.push(e);

  detectLoaderMessages(text, push);
  detectMixin(text, push, configToJar);
  detectStack(text, push, pkgIndex);
  const javaEnv = detectJavaVersion(text, push, pkgIndex);

  // статические проблемы набора модов — «и без лога понятно, что так не взлетит»
  const problems = graphLib.findProblems(graph);
  const logAll = text;
  for (const p of problems) {
    if (p.type === 'duplicate') {
      // подозреваем более старые копии, оставляем самую новую
      const files = p.files.slice().sort((a, b) => {
        const va = graph.byFile.get(a).mods[0]?.version || '', vb = graph.byFile.get(b).mods[0]?.version || '';
        const pa = graphLib.parseVer(va), pb = graphLib.parseVer(vb);
        if (pa && pb) { for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } }
        return graph.byFile.get(a).mtimeMs - graph.byFile.get(b).mtimeMs;
      });
      const mentioned = new RegExp(`duplicate[^\\n]*${p.modId}|${p.modId}[^\\n]*duplicate`, 'i').test(logAll);
      for (const f of files.slice(0, -1)) {
        push({ fileName: f, weight: mentioned ? 0.85 : 0.6, kind: 'duplicate', staticOnly: !mentioned,
          reason: `дубликат мода «${p.modId}» (${files.length} копии), это более старая`, evidence: `одинаковый mod id: ${p.modId}` });
      }
      continue;
    }
    const w = p.type === 'wrong-minecraft-version' ? 0.6 : p.type === 'incompatible' || p.type === 'conflict' ? 0.5 : 0.55;
    const reason = {
      'missing-dependency': `требует «${p.dependencyId}», которого нет в папке mods`,
      'wrong-minecraft-version': `заявлена совместимость с другой версией Minecraft (${(p.range || []).join(' | ')})`,
      'wrong-dependency-version': `нужна другая версия «${p.dependencyId}» (${(p.range || []).join(' | ')})`,
      'incompatible': `заявляет несовместимость с «${p.dependencyId}»`,
      'conflict': `конфликтует с «${p.dependencyId}»`
    }[p.type];
    push({ fileName: p.fileName, weight: w, kind: p.type, missingId: p.dependencyId, reason, evidence: 'метаданные мода (до запуска)', staticOnly: true });
  }

  // сводим улики по jar.
  // Улики из лога независимы друг от друга — комбинируем как 1 - Π(1 - w).
  // Статические признаки («по метаданным так не взлетит») коррелированы: это одна и та же
  // причина, поэтому берём максимум, а не произведение. И если в логе есть конкретная ошибка,
  // статике верим меньше: при реально нарушенной зависимости загрузчик остановился бы раньше.
  const byFile = new Map();
  let anyLogEvidence = false;
  for (const e of evidence) {
    const file = e.fileName && graph.byFile.has(e.fileName) ? e.fileName : (e.modId ? idToFile(e.modId) : null);
    if (!file) continue;
    const jar = graph.byFile.get(file);
    if (!jar || !jar.enabled) continue;
    if (!e.staticOnly) anyLogEvidence = true;
    let s = byFile.get(file);
    if (!s) {
      s = {
        fileName: file, modId: jar.mods[0]?.id || null, name: graphLib.jarDisplayName(jar),
        version: jar.mods[0]?.version || null, logRemain: 1, staticMax: 0,
        reasons: [], evidence: [], kinds: new Set(), missing: new Set()
      };
      byFile.set(file, s);
    }
    if (e.staticOnly) s.staticMax = Math.max(s.staticMax, e.weight);
    else s.logRemain *= (1 - Math.min(e.weight, 0.95));
    s.kinds.add(e.kind);
    if (!s.reasons.includes(e.reason)) s.reasons.push(e.reason);
    if (e.evidence && s.evidence.length < 4 && !s.evidence.includes(e.evidence)) s.evidence.push(e.evidence);
    if (e.missingId) s.missing.add(e.missingId);
  }
  const staticCap = anyLogEvidence ? 0.4 : 0.6;
  for (const s of byFile.values()) s.remain = s.logRemain * (1 - Math.min(s.staticMax, staticCap));

  const libraryHints = new Set();
  const suspects = [...byFile.values()]
    .map(s => ({
      fileName: s.fileName, modId: s.modId, name: s.name, version: s.version,
      confidence: Math.min(MAX_CONFIDENCE, +(1 - s.remain).toFixed(2)),
      reasons: s.reasons, evidence: s.evidence, kinds: [...s.kinds],
      missingDependencies: [...s.missing]
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);

  for (const s of suspects) {
    s.level = confidenceLabel(s.confidence);
    const sim = graphLib.simulateDisable(graph, [s.fileName], { libraryHints });
    s.ifDisabled = {
      breaks: [...sim.direct, ...sim.cascade].map(b => ({ fileName: b.fileName, name: b.name, because: b.becauseName })),
      withDependents: sim.withDependents,
      softLost: sim.softLost.map(x => ({ fileName: x.fileName, name: x.name, id: x.id }))
    };
  }

  // недостающие зависимости — отдельно, чтобы предложить «поставить», а не только «выключить»
  const missingMap = new Map();
  for (const s of suspects) {
    for (const dep of s.missingDependencies) {
      if (graph.enabledProviders.has(dep) || graphLib.BUILTIN_IDS.has(dep)) continue;
      if (!missingMap.has(dep)) missingMap.set(dep, { dependencyId: dep, requiredBy: [], disabledProviders: [] });
      missingMap.get(dep).requiredBy.push({ fileName: s.fileName, name: s.name });
      const dis = graph.disabledProviders.get(dep) || [];
      for (const f of dis) {
        const entry = missingMap.get(dep);
        if (!entry.disabledProviders.some(x => x.fileName === f)) {
          entry.disabledProviders.push({ fileName: f, name: graphLib.jarDisplayName(graph.byFile.get(f)) });
        }
      }
    }
  }
  result.missing = [...missingMap.values()];

  result.suspects = suspects;
  result.environment = detectEnvironment({ code, text, sources });
  if (javaEnv) result.environment.unshift(javaEnv);

  // что рекомендуем отключить: уверенные подозреваемые (до 3) + то, что без них не запустится
  const confident = suspects.filter(s => s.confidence >= 0.6).slice(0, 3);
  const rec = new Set();
  for (const s of confident) for (const f of s.ifDisabled.withDependents) rec.add(f);
  result.recommended = [...rec];
  result.recommendedNames = result.recommended.map(f => ({ fileName: f, name: graphLib.jarDisplayName(graph.byFile.get(f)) }));

  if (suspects.length) {
    const top = suspects[0];
    result.summary = top.confidence >= 0.8
      ? `Скорее всего, игру уронил мод «${top.name}»: ${top.reasons[0]}.`
      : top.confidence >= 0.55
        ? `Подозрение падает на мод «${top.name}»: ${top.reasons[0]}. Уверенность средняя.`
        : `Точную причину определить не удалось. Самый подозрительный мод — «${top.name}» (${top.reasons[0]}), но уверенность низкая.`;
  } else if (result.environment.length) {
    result.summary = 'Похоже, причина не в конкретном моде.';
  } else {
    result.summary = 'Причину определить не удалось: в логах нет понятных следов.';
  }
  return result;
}

// ---------- применение и откат ----------

function readJournal(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, JOURNAL_FILE), 'utf8')); } catch { return []; }
}

function writeJournal(root, list) {
  fs.writeFileSync(path.join(root, JOURNAL_FILE), JSON.stringify(list.slice(-MAX_JOURNAL), null, 2));
}

// Отключает файлы и записывает в журнал только то, что реально изменилось
function applyFix(root, { mcVersion, loader, fileNames, reason }) {
  const wanted = [...new Set(fileNames || [])].filter(safeBase);
  const modsDir = modManager.getModsDir(root, mcVersion, loader);
  const changed = [];
  for (const f of wanted) {
    if (fs.existsSync(path.join(modsDir, f))) {
      modManager.setModEnabled(root, mcVersion, loader, f, false);
      changed.push(f);
    }
  }
  const entry = { id: `fix-${Date.now()}`, at: Date.now(), mcVersion, loader, disabled: changed, reason: reason || null, undone: false };
  if (changed.length) {
    const journal = readJournal(root);
    journal.push(entry);
    writeJournal(root, journal);
  }
  return entry;
}

function undoFix(root, fixId) {
  const journal = readJournal(root);
  const entry = journal.find(e => e.id === fixId);
  if (!entry) return { ok: false, error: 'Запись не найдена' };
  if (entry.undone) return { ok: true, restored: [], already: true };
  const restored = [];
  for (const f of entry.disabled) {
    if (!safeBase(f)) continue;
    const modsDir = modManager.getModsDir(root, entry.mcVersion, entry.loader);
    if (fs.existsSync(path.join(modsDir, `${f}.disabled`))) {
      modManager.setModEnabled(root, entry.mcVersion, entry.loader, f, true);
      restored.push(f);
    }
  }
  entry.undone = true;
  writeJournal(root, journal);
  return { ok: true, restored };
}

function listFixes(root, { mcVersion, loader } = {}) {
  return readJournal(root)
    .filter(e => (!mcVersion || e.mcVersion === mcVersion) && (!loader || e.loader === loader))
    .reverse();
}

module.exports = { analyzeCrash, applyFix, undoFix, listFixes, safeBase };
