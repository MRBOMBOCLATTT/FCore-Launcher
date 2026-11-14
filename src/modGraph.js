// Граф зависимостей модов поверх modIndex.js.
// Отвечает на вопросы: «что требует этот мод», «кому он нужен» и «что сломается,
// если его отключить» (с каскадом: сломанный мод тянет за собой тех, кто нужен ему).
//
// Проверка диапазонов версий намеренно «мягкая»: если версию или диапазон не удалось
// разобрать (снапшоты, ${плейсхолдеры}), результат — «неизвестно», а не «несовместимо».
// Ложная тревога хуже, чем пропущенная проверка.

// то, что даёт сам загрузчик/игра, а не какой-то мод в папке mods
const BUILTIN_IDS = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader',
  'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml', 'mclanguage'
]);

// ---------- версии ----------

function parseVer(v) {
  if (typeof v !== 'string') return null;
  const core = v.trim().replace(/^v/i, '').split('+')[0].split('-')[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null; // 24w14a, ${file.jarVersion}, unknown
  return core.split('.').map(Number);
}

function cmp(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Fabric-предикат: >=1.2.3, <2, ~1.2, ^1.2.3, 1.2.x, * ; пробел между токенами = И
function fabricToken(tok, ver) {
  tok = tok.trim();
  if (!tok || tok === '*') return true;
  const m = tok.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
  if (!m) return null;
  const op = m[1] || '=';
  const rhs = m[2];

  if (/[xX*]/.test(rhs)) {
    const prefix = rhs.split('.').filter(p => !/^[xX*]$/.test(p)).map(Number);
    if (prefix.some(Number.isNaN)) return null;
    return prefix.every((p, i) => (ver[i] || 0) === p);
  }

  const r = parseVer(rhs);
  if (!r) return null;
  const c = cmp(ver, r);
  switch (op) {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '~': {
      const upper = r.length >= 2 ? [r[0], r[1] + 1] : [r[0] + 1];
      return c >= 0 && cmp(ver, upper) < 0;
    }
    case '^': {
      const upper = r[0] > 0 ? [r[0] + 1] : [0, (r[1] || 0) + 1];
      return c >= 0 && cmp(ver, upper) < 0;
    }
    default: return null;
  }
}

function fabricRange(range, ver) {
  const tokens = String(range).trim().split(/\s+/);
  let unknown = false;
  for (const t of tokens) {
    const r = fabricToken(t, ver);
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}

// Maven-диапазоны Forge/NeoForge: [1.0,2.0), (,3], [1.2.3], несколько через запятую
function mavenRange(range, ver) {
  const parts = String(range).match(/[\[(][^\])]*[\])]/g);
  if (!parts) return null; // «мягкая» версия без скобок — не берёмся судить
  let unknown = false;
  for (const p of parts) {
    const lowInc = p[0] === '[';
    const highInc = p[p.length - 1] === ']';
    const body = p.slice(1, -1);
    const comma = body.indexOf(',');
    let lo, hi;
    if (comma < 0) { lo = hi = body.trim(); } else {
      lo = body.slice(0, comma).trim();
      hi = body.slice(comma + 1).trim();
    }
    const l = lo ? parseVer(lo) : undefined;
    const h = hi ? parseVer(hi) : undefined;
    if (l === null || h === null) { unknown = true; continue; }
    let ok = true;
    if (l) { const c = cmp(ver, l); ok = ok && (lowInc ? c >= 0 : c > 0); }
    if (h) { const c = cmp(ver, h); ok = ok && (highInc ? c <= 0 : c < 0); }
    if (ok) return true;
  }
  return unknown ? null : false;
}

// true / false / null (не удалось определить)
function satisfies(ranges, version, format) {
  if (!ranges || !ranges.length) return true;
  // «любая версия» подходит, даже если у поставщика версия нестандартная
  if (ranges.some(r => String(r).trim() === '*')) return true;
  const ver = parseVer(version);
  if (!ver) return null;
  let unknown = false;
  for (const r of ranges) {
    const res = format === 'fabric' ? fabricRange(r, ver) : mavenRange(r, ver);
    if (res === true) return true;
    if (res === null) unknown = true;
  }
  return unknown ? null : false;
}

// ---------- построение графа ----------

function jarDisplayName(j) {
  return j?.mods?.[0]?.name || j?.mods?.[0]?.id || j?.fileName || '?';
}

function jarPrimaryId(j) {
  return j?.mods?.[0]?.id || null;
}

// id → версия для всех «имён», которые предоставляет jar
function jarIdVersions(j) {
  const out = new Map();
  for (const m of j.mods || []) {
    out.set(m.id, m.version);
    for (const p of m.provides || []) if (!out.has(p)) out.set(p, m.version);
  }
  for (const n of j.nested || []) if (!out.has(n.id)) out.set(n.id, n.version);
  return out;
}

function buildGraph(scan, { mcVersion } = {}) {
  const jars = scan.filter(j => !j.error && j.mods && j.mods.length);
  const byFile = new Map(jars.map(j => [j.fileName, j]));

  const idVersions = new Map(jars.map(j => [j.fileName, jarIdVersions(j)]));
  const enabledProviders = new Map();  // id -> [fileName]
  const disabledProviders = new Map();
  for (const j of jars) {
    const target = j.enabled ? enabledProviders : disabledProviders;
    for (const id of idVersions.get(j.fileName).keys()) {
      if (!target.has(id)) target.set(id, []);
      target.get(id).push(j.fileName);
    }
  }

  const apiMc = String(mcVersion || '').replace(/^Minecraft\s+/i, '').trim();
  const edges = [];

  for (const j of jars) {
    for (const m of j.mods) {
      for (const d of m.deps || []) {
        const edge = {
          fromFile: j.fileName,
          fromEnabled: j.enabled,
          fromId: m.id,
          id: d.id,
          kind: d.kind,                 // required | optional | breaks | conflicts
          range: d.range || [],
          status: 'ok',                 // ok | missing | version | active (для breaks/conflicts)
          providerFiles: [],            // включённые jar, которые подходят
          presentFiles: [],             // включённые jar с этим id (даже если версия не подходит)
          disabledProviderFiles: [],    // выключенные jar, которые могли бы подойти
          builtin: BUILTIN_IDS.has(d.id)
        };

        if (edge.builtin) {
          if (d.id === 'minecraft' && apiMc && d.kind === 'required') {
            if (satisfies(edge.range, apiMc, j.format) === false) edge.status = 'version';
          }
          edges.push(edge);
          continue;
        }

        const present = (enabledProviders.get(d.id) || []).filter(f => f !== j.fileName);
        // jar может сам содержать зависимость (jar-in-jar) — тогда она считается выполненной
        const selfProvides = idVersions.get(j.fileName).has(d.id) && d.id !== m.id;
        edge.presentFiles = present;

        const fitting = present.filter(f => satisfies(edge.range, idVersions.get(f).get(d.id), j.format) !== false);
        edge.providerFiles = fitting;

        if (d.kind === 'required') {
          if (selfProvides) edge.status = 'ok';
          else if (!present.length) edge.status = 'missing';
          else if (!fitting.length) edge.status = 'version';
          const dis = (disabledProviders.get(d.id) || []).filter(f => f !== j.fileName);
          edge.disabledProviderFiles = dis.filter(f => satisfies(edge.range, idVersions.get(f).get(d.id), j.format) !== false);
        } else if (d.kind === 'breaks' || d.kind === 'conflicts') {
          // «активно» только если конфликтующий мод включён и версия точно подпадает
          const hit = present.filter(f => {
            if (!edge.range.length) return true;
            return satisfies(edge.range, idVersions.get(f).get(d.id), j.format) === true;
          });
          edge.providerFiles = hit;
          edge.status = hit.length ? 'active' : 'ok';
        }
        edges.push(edge);
      }
    }
  }

  return { jars, byFile, idVersions, enabledProviders, disabledProviders, edges, mcVersion: apiMc };
}

// проблемы текущего набора включённых модов
function findProblems(graph) {
  const problems = [];
  for (const e of graph.edges) {
    if (!e.fromEnabled) continue;
    const from = graph.byFile.get(e.fromFile);
    if (e.kind === 'required' && e.status === 'missing') {
      problems.push({
        type: 'missing-dependency', fileName: e.fromFile, name: jarDisplayName(from),
        dependencyId: e.id, range: e.range,
        disabledProviders: e.disabledProviderFiles
      });
    } else if (e.kind === 'required' && e.status === 'version') {
      problems.push({
        type: e.id === 'minecraft' ? 'wrong-minecraft-version' : 'wrong-dependency-version',
        fileName: e.fromFile, name: jarDisplayName(from), dependencyId: e.id, range: e.range,
        presentFiles: e.presentFiles
      });
    } else if ((e.kind === 'breaks' || e.kind === 'conflicts') && e.status === 'active') {
      problems.push({
        type: e.kind === 'breaks' ? 'incompatible' : 'conflict', fileName: e.fromFile, name: jarDisplayName(from),
        dependencyId: e.id, range: e.range, withFiles: e.providerFiles
      });
    }
  }

  // два jar с одним основным id — Fabric/Forge такое не запускают
  const primary = new Map();
  for (const j of graph.jars) {
    if (!j.enabled) continue;
    for (const m of j.mods) {
      if (!primary.has(m.id)) primary.set(m.id, []);
      primary.get(m.id).push(j.fileName);
    }
  }
  for (const [id, files] of primary) {
    const uniq = [...new Set(files)];
    if (uniq.length > 1) problems.push({ type: 'duplicate', modId: id, files: uniq, fileName: uniq[0] });
  }
  return problems;
}

// ---------- запросы к графу ----------

function dependenciesOf(graph, fileName) {
  return graph.edges
    .filter(e => e.fromFile === fileName)
    .map(e => ({
      id: e.id, kind: e.kind, range: e.range, status: e.status, builtin: e.builtin,
      providers: e.providerFiles.map(f => ({ fileName: f, name: jarDisplayName(graph.byFile.get(f)) })),
      disabledProviders: e.disabledProviderFiles.map(f => ({ fileName: f, name: jarDisplayName(graph.byFile.get(f)) }))
    }));
}

function dependentsOf(graph, fileName) {
  const out = [];
  for (const e of graph.edges) {
    if (!e.fromEnabled || e.fromFile === fileName) continue;
    if (e.kind !== 'required' && e.kind !== 'optional') continue;
    if (!e.providerFiles.includes(fileName)) continue;
    out.push({
      fileName: e.fromFile, name: jarDisplayName(graph.byFile.get(e.fromFile)),
      kind: e.kind, viaId: e.id,
      // единственный ли это поставщик — если нет, отключение не сломает зависимого
      onlyProvider: e.providerFiles.length === 1
    });
  }
  return out;
}

// рекурсивное дерево «кто от меня зависит»
function dependentsTree(graph, fileName, { maxDepth = 6 } = {}) {
  const build = (file, depth, path) => {
    const direct = dependentsOf(graph, file).filter(d => d.kind === 'required' && d.onlyProvider);
    return direct
      .filter(d => !path.has(d.fileName))
      .map(d => {
        const nextPath = new Set(path).add(d.fileName);
        return {
          fileName: d.fileName, name: d.name, viaId: d.viaId,
          children: depth < maxDepth ? build(d.fileName, depth + 1, nextPath) : []
        };
      });
  };
  return build(fileName, 1, new Set([fileName]));
}

// Что произойдёт, если отключить набор файлов
function simulateDisable(graph, fileNames, { libraryHints = new Set() } = {}) {
  const removed = new Set(fileNames);
  const broken = new Map(); // fileName -> { depth, id, byFile }

  const requiredEdges = graph.edges.filter(e =>
    e.fromEnabled && e.kind === 'required' && e.status === 'ok' && !e.builtin);
  const alreadyBrokenFiles = new Set(
    graph.edges.filter(e => e.fromEnabled && e.kind === 'required' && e.status !== 'ok' && !e.builtin).map(e => e.fromFile));

  const dead = f => removed.has(f) || broken.has(f);

  for (let depth = 1; depth <= 12; depth++) {
    const newly = [];
    for (const e of requiredEdges) {
      if (dead(e.fromFile)) continue;
      // jar, который сам содержит зависимость, не ломается из-за внешнего поставщика
      if (graph.idVersions.get(e.fromFile)?.has(e.id)) continue;
      const live = e.providerFiles.filter(f => !dead(f));
      if (live.length) continue;
      const byFile = e.providerFiles.find(f => dead(f)) || null;
      newly.push({ fileName: e.fromFile, depth, id: e.id, byFile });
    }
    if (!newly.length) break;
    for (const n of newly) if (!broken.has(n.fileName)) broken.set(n.fileName, n);
  }

  const mk = n => ({
    fileName: n.fileName,
    name: jarDisplayName(graph.byFile.get(n.fileName)),
    depth: n.depth,
    becauseId: n.id,
    becauseFile: n.byFile,
    becauseName: n.byFile ? jarDisplayName(graph.byFile.get(n.byFile)) : n.id
  });
  const brokenList = [...broken.values()].map(mk).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));

  // необязательные связи, которые просто перестанут работать (без краша)
  const softLost = [];
  for (const e of graph.edges) {
    if (!e.fromEnabled || e.kind !== 'optional' || dead(e.fromFile) || !e.providerFiles.length) continue;
    if (e.providerFiles.every(dead)) {
      softLost.push({ fileName: e.fromFile, name: jarDisplayName(graph.byFile.get(e.fromFile)), id: e.id });
    }
  }

  // библиотеки, которые держал только отключаемый набор — можно отключить заодно
  const everyDead = new Set([...removed, ...broken.keys()]);
  const freeable = [];
  const candidateFiles = new Set();
  for (const e of requiredEdges) {
    if (!everyDead.has(e.fromFile)) continue;
    for (const p of e.providerFiles) if (!everyDead.has(p)) candidateFiles.add(p);
  }
  for (const f of candidateFiles) {
    if (!libraryHints.has(f)) continue;
    const stillNeeded = graph.edges.some(e =>
      e.fromEnabled && !everyDead.has(e.fromFile) && (e.kind === 'required' || e.kind === 'optional') && e.providerFiles.includes(f));
    if (!stillNeeded) freeable.push({ fileName: f, name: jarDisplayName(graph.byFile.get(f)) });
  }

  // конфликты, которые отключение снимет
  const resolves = [];
  for (const e of graph.edges) {
    if (!e.fromEnabled || (e.kind !== 'breaks' && e.kind !== 'conflicts') || e.status !== 'active') continue;
    if (dead(e.fromFile) || e.providerFiles.some(dead)) {
      resolves.push({
        fileName: e.fromFile, name: jarDisplayName(graph.byFile.get(e.fromFile)),
        withNames: e.providerFiles.map(f => jarDisplayName(graph.byFile.get(f)))
      });
    }
  }

  return {
    requested: [...removed].map(f => ({ fileName: f, name: jarDisplayName(graph.byFile.get(f)) })),
    direct: brokenList.filter(b => b.depth === 1),
    cascade: brokenList.filter(b => b.depth > 1),
    softLost,
    freeable,
    resolves,
    alreadyBroken: [...alreadyBrokenFiles].filter(f => !everyDead.has(f)),
    // полный список файлов для «отключить вместе с зависимыми»
    withDependents: [...removed, ...brokenList.map(b => b.fileName)]
  };
}

// Что потребуется и что случится, если включить выключенный мод
function simulateEnable(graph, fileName) {
  const jar = graph.byFile.get(fileName);
  if (!jar) return null;
  const needs = [];
  const conflicts = [];
  for (const e of graph.edges.filter(x => x.fromFile === fileName)) {
    if (e.builtin && e.status === 'ok') continue;
    if (e.kind === 'required' && e.status !== 'ok') {
      needs.push({
        id: e.id, status: e.status, range: e.range,
        disabledProviders: e.disabledProviderFiles.map(f => ({ fileName: f, name: jarDisplayName(graph.byFile.get(f)) }))
      });
    } else if ((e.kind === 'breaks' || e.kind === 'conflicts') && e.status === 'active') {
      conflicts.push({ id: e.id, withNames: e.providerFiles.map(f => jarDisplayName(graph.byFile.get(f))) });
    }
  }
  // уже включённые моды, которые сломаны отсутствием именно этого
  const ids = graph.idVersions.get(fileName);
  const fixes = graph.edges
    .filter(e => e.fromEnabled && e.kind === 'required' && e.status === 'missing' && ids.has(e.id))
    .map(e => ({ fileName: e.fromFile, name: jarDisplayName(graph.byFile.get(e.fromFile)), id: e.id }));
  return { fileName, name: jarDisplayName(jar), needs, conflicts, fixes };
}

// компактное представление для интерфейса
function toUi(graph, scan, { libraryHints = new Set() } = {}) {
  const mods = scan
    .map(j => {
      const base = {
        fileName: j.fileName,
        enabled: j.enabled,
        error: j.error || null,
        format: j.format,
        isLibraryHint: libraryHints.has(j.fileName)
      };
      if (j.error || !j.mods.length) return { ...base, name: j.fileName, id: null, version: null, requires: [], requiredBy: [] };
      return {
        ...base,
        name: jarDisplayName(j),
        id: jarPrimaryId(j),
        version: j.mods[0].version,
        requires: dependenciesOf(graph, j.fileName),
        requiredBy: j.enabled ? dependentsOf(graph, j.fileName) : []
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { mods, problems: findProblems(graph), mcVersion: graph.mcVersion };
}

module.exports = {
  BUILTIN_IDS, satisfies, parseVer, buildGraph, findProblems,
  dependenciesOf, dependentsOf, dependentsTree,
  simulateDisable, simulateEnable, toUi, jarDisplayName
};
