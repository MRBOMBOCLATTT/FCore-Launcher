// Индекс установленных модов: читает метаданные из JAR-файлов (Fabric / Forge / NeoForge),
// включая зависимости, provides, вложенные JAR (jar-in-jar), mixin-конфиги и пакеты классов.
// На нём строятся три функции: анализ краша, дерево зависимостей и метрики ресурсов.
//
// Ничего не скачивает и не пишет на диск — только читает central directory и
// несколько служебных файлов внутри архива, поэтому быстро даже на сотне модов.
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const MAX_NESTED_JAR_BYTES = 32 * 1024 * 1024;
const MAX_META_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGES_PER_JAR = 6000;

// ---------- мини-парсер TOML (подмножество, которого хватает для mods.toml) ----------

function splitDotted(key) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (const ch of key) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '.') { parts.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseBasicString(s, start) {
  let out = '';
  let i = start + 1;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i += 2;
    } else out += s[i++];
  }
  return { value: out, end: i + 1 };
}

function parseValue(s, pos = 0) {
  while (s[pos] === ' ' || s[pos] === '\t') pos++;
  const ch = s[pos];
  if (ch === '"') return parseBasicString(s, pos);
  if (ch === "'") {
    const end = s.indexOf("'", pos + 1);
    return { value: s.slice(pos + 1, end < 0 ? s.length : end), end: end < 0 ? s.length : end + 1 };
  }
  if (ch === '[') {
    const arr = [];
    pos++;
    while (pos < s.length) {
      while (/[\s,]/.test(s[pos] || '')) pos++;
      if (s[pos] === ']') { pos++; break; }
      if (pos >= s.length) break;
      const r = parseValue(s, pos);
      arr.push(r.value);
      pos = r.end;
    }
    return { value: arr, end: pos };
  }
  if (ch === '{') {
    // inline table — для наших целей достаточно сырой строки
    let depth = 0, i = pos;
    for (; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) { i++; break; }
    }
    return { value: s.slice(pos, i), end: i };
  }
  const m = s.slice(pos).match(/^[^\s,\]}]+/);
  const raw = m ? m[0] : '';
  let value = raw;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  else if (/^[+-]?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
  return { value, end: pos + raw.length };
}

function bracketsBalanced(text) {
  let depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
  }
  return depth <= 0;
}

function tablePath(root, dotted, isArray) {
  const parts = splitDotted(dotted);
  let node = root;
  parts.forEach((p, idx) => {
    const last = idx === parts.length - 1;
    if (last && isArray) {
      if (!Array.isArray(node[p])) node[p] = [];
      const t = {};
      node[p].push(t);
      node = t;
    } else {
      let next = node[p];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!next || typeof next !== 'object') next = node[p] = {};
      node = next;
    }
  });
  return node;
}

function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // многострочные строки ''' ... ''' / """ ... """ — внутри могут быть # и [
    const ml = raw.match(/^\s*([^=#\[]+?)\s*=\s*('''|""")(.*)$/);
    if (ml) {
      const delim = ml[2];
      let body = ml[3];
      let closed = body.includes(delim);
      if (closed) body = body.slice(0, body.indexOf(delim));
      while (!closed && i + 1 < lines.length) {
        i++;
        const idx = lines[i].indexOf(delim);
        if (idx >= 0) { body += '\n' + lines[i].slice(0, idx); closed = true; }
        else body += '\n' + lines[i];
      }
      cur[splitDotted(ml[1]).pop() || ml[1]] = body.replace(/^\n/, '');
      continue;
    }

    let line = stripComment(raw).trim();
    if (!line) continue;

    let m = line.match(/^\[\[\s*(.+?)\s*\]\]$/);
    if (m) { cur = tablePath(root, m[1], true); continue; }
    m = line.match(/^\[\s*([^\[\]]+?)\s*\]$/);
    if (m) { cur = tablePath(root, m[1], false); continue; }

    const kv = line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9_.\-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, '');
    let rest = kv[2];
    // многострочный массив — дочитываем, пока скобки не сойдутся
    while (rest.trim().startsWith('[') && !bracketsBalanced(rest) && i + 1 < lines.length) {
      i++;
      rest += ' ' + stripComment(lines[i]).trim();
    }
    cur[key] = parseValue(rest, 0).value;
  }
  return root;
}

// ---------- чтение ZIP/JAR ----------

function openZipFile(file) {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (err, zip) => (err ? reject(err) : resolve(zip))));
}

function openZipBuffer(buf) {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => (err ? reject(err) : resolve(zip))));
}

function readEntryBuffer(zip, entry, limit) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > limit) return reject(new Error('entry too large'));
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

// последовательно обходит записи архива; visit может читать содержимое через read()
function walkZip(zip, visit) {
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', async entry => {
      try {
        await visit(entry);
        zip.readEntry();
      } catch (e) { reject(e); }
    });
    zip.readEntry();
  });
}

// ---------- разбор метаданных загрузчиков ----------

const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Fabric сам читает fabric.mod.json мягко: некоторые моды кладут в строки сырые
// переводы строк и табы, и строгий JSON.parse на них падает. Экранируем такие символы
function parseLooseJson(text) {
  const src = text.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(src);
  } catch (err) {
    let out = '';
    let inString = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inString && ch === '\\') {
        out += ch + (src[++i] || '');
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString && ch < ' ') {
        out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        continue;
      }
      out += ch;
    }
    return JSON.parse(out);
  }
}

function parseFabricJson(text) {
  const j = parseLooseJson(text);
  const deps = [];
  const add = (obj, kind) => {
    for (const [id, range] of Object.entries(obj || {})) {
      deps.push({ id, kind, range: asArray(range).map(String), side: null });
    }
  };
  add(j.depends, 'required');
  add(j.recommends, 'optional');
  add(j.suggests, 'optional');
  add(j.breaks, 'breaks');
  add(j.conflicts, 'conflicts');

  const provides = asArray(j.provides).map(p => (typeof p === 'string' ? p : p?.id)).filter(Boolean);
  const mixins = asArray(j.mixins).map(m => (typeof m === 'string' ? m : m?.config)).filter(Boolean);
  const nestedJars = asArray(j.jars).map(x => x?.file).filter(Boolean);

  return {
    mods: [{
      id: j.id,
      name: j.name || j.id,
      version: j.version ? String(j.version) : 'unknown',
      environment: j.environment || '*',
      provides,
      deps
    }],
    mixins,
    nestedJars
  };
}

function resolveVersion(v, manifestVersion) {
  if (typeof v !== 'string') return 'unknown';
  if (v.includes('${')) return manifestVersion || 'unknown';
  return v;
}

function parseForgeToml(text, manifestVersion) {
  const t = parseToml(text);
  const mods = asArray(t.mods).map(m => ({
    id: m.modId,
    name: m.displayName || m.modId,
    version: resolveVersion(m.version, manifestVersion),
    environment: '*',
    provides: [],
    deps: []
  })).filter(m => m.id);

  const depTables = t.dependencies && typeof t.dependencies === 'object' ? t.dependencies : {};
  for (const [ownerId, list] of Object.entries(depTables)) {
    const owner = mods.find(m => m.id === ownerId) || mods[0];
    if (!owner) continue;
    for (const d of asArray(list)) {
      if (!d || typeof d !== 'object' || !d.modId) continue;
      // Forge: mandatory = true/false; NeoForge 1.20.5+: type = required|optional|incompatible|discouraged
      let kind;
      if (typeof d.type === 'string') {
        kind = d.type === 'required' ? 'required'
          : d.type === 'incompatible' ? 'breaks'
            : d.type === 'discouraged' ? 'conflicts' : 'optional';
      } else kind = d.mandatory === false ? 'optional' : 'required';
      owner.deps.push({
        id: String(d.modId),
        kind,
        range: d.versionRange ? [String(d.versionRange)] : [],
        side: d.side || null
      });
    }
  }
  return { mods, mixins: [], nestedJars: [] };
}

function parseManifestVersion(text) {
  const m = String(text).match(/^Implementation-Version:\s*(.+)$/mi);
  return m ? m[1].trim() : null;
}

// достаём только id/версии из вложенного JAR — нужно, чтобы зависимость от
// fabric-resource-loader-v0 «находилась» внутри fabric-api, а не считалась пропавшей
async function readNestedIds(buf) {
  const found = [];
  let zip;
  try {
    zip = await openZipBuffer(buf);
    let fabric = null, toml = null, manifest = null;
    await walkZip(zip, async entry => {
      const n = entry.fileName;
      if (n === 'fabric.mod.json') fabric = (await readEntryBuffer(zip, entry, MAX_META_BYTES)).toString('utf8');
      else if (n === 'META-INF/neoforge.mods.toml' || n === 'META-INF/mods.toml') {
        if (!toml || n.includes('neoforge')) toml = (await readEntryBuffer(zip, entry, MAX_META_BYTES)).toString('utf8');
      } else if (n === 'META-INF/MANIFEST.MF') manifest = (await readEntryBuffer(zip, entry, MAX_META_BYTES)).toString('utf8');
    });
    if (fabric) {
      const p = parseFabricJson(fabric);
      for (const m of p.mods) {
        if (m.id) found.push({ id: m.id, version: m.version });
        for (const pr of m.provides) found.push({ id: pr, version: m.version });
      }
    } else if (toml) {
      const p = parseForgeToml(toml, manifest ? parseManifestVersion(manifest) : null);
      for (const m of p.mods) found.push({ id: m.id, version: m.version });
    }
  } catch { /* битый вложенный JAR не должен ронять разбор основного */ }
  finally { try { zip?.close(); } catch {} }
  return found;
}

const NESTED_JAR_RE = /^META-INF\/(jars|jarjar)\/[^/]+\.jar$/i;
const MIXIN_CONFIG_RE = /^[^/]*mixins?[^/]*\.json$/i; // только корень архива

async function readJar(filePath, { loader } = {}) {
  const fileName = path.basename(filePath).replace(/\.disabled$/i, '');
  const enabled = !/\.disabled$/i.test(filePath);
  const rec = {
    fileName,
    diskName: path.basename(filePath),
    enabled,
    format: null,
    mods: [],
    nested: [],
    mixinConfigs: [],
    packages: [],
    size: 0,
    mtimeMs: 0,
    error: null
  };

  try {
    const st = fs.statSync(filePath);
    rec.size = st.size;
    rec.mtimeMs = Math.round(st.mtimeMs);
  } catch { /* файл мог исчезнуть между readdir и stat */ }

  let zip;
  try {
    zip = await openZipFile(filePath);
    const texts = {};
    const nestedBufs = [];
    const packages = new Set();

    await walkZip(zip, async entry => {
      const n = entry.fileName;
      if (n.endsWith('/')) return;

      if (n === 'fabric.mod.json' || n === 'META-INF/mods.toml' || n === 'META-INF/neoforge.mods.toml' || n === 'META-INF/MANIFEST.MF') {
        texts[n] = (await readEntryBuffer(zip, entry, MAX_META_BYTES)).toString('utf8');
      } else if (NESTED_JAR_RE.test(n)) {
        if (entry.uncompressedSize <= MAX_NESTED_JAR_BYTES) {
          nestedBufs.push(await readEntryBuffer(zip, entry, MAX_NESTED_JAR_BYTES));
        }
      } else if (MIXIN_CONFIG_RE.test(n)) {
        rec.mixinConfigs.push(n);
      } else if (n.endsWith('.class') && !n.startsWith('META-INF/') && packages.size < MAX_PACKAGES_PER_JAR) {
        const i = n.lastIndexOf('/');
        if (i > 0) packages.add(n.slice(0, i));
      }
    });

    const hasFabric = 'fabric.mod.json' in texts;
    const hasNeo = 'META-INF/neoforge.mods.toml' in texts;
    const hasForge = 'META-INF/mods.toml' in texts;
    const manifestVersion = texts['META-INF/MANIFEST.MF'] ? parseManifestVersion(texts['META-INF/MANIFEST.MF']) : null;

    // jar может быть мультилоадерным — выбираем формат под выбранный загрузчик
    let pick = null;
    if (loader === 'fabric' && hasFabric) pick = 'fabric';
    else if (loader === 'neoforge' && hasNeo) pick = 'neoforge';
    else if (loader === 'forge' && hasForge) pick = 'forge';
    else pick = hasFabric ? 'fabric' : hasNeo ? 'neoforge' : hasForge ? 'forge' : null;

    if (!pick) {
      rec.error = 'метаданные загрузчика не найдены';
    } else {
      const parsed = pick === 'fabric'
        ? parseFabricJson(texts['fabric.mod.json'])
        : parseForgeToml(texts[pick === 'neoforge' ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml'], manifestVersion);
      rec.format = pick;
      rec.mods = parsed.mods;
      if (pick === 'fabric' && parsed.mixins.length) {
        rec.mixinConfigs = [...new Set([...rec.mixinConfigs, ...parsed.mixins])];
      }
      if (!rec.mods.length) rec.error = 'в метаданных нет ни одного мода';
    }

    for (const buf of nestedBufs) {
      for (const n of await readNestedIds(buf)) rec.nested.push(n);
    }
    rec.packages = [...packages];
  } catch (e) {
    rec.error = e.message || 'не удалось прочитать JAR';
  } finally {
    try { zip?.close(); } catch {}
  }
  return rec;
}

// ---------- кэш и массовое чтение ----------

const cache = new Map(); // path|size|mtime|loader -> запись

async function readJarCached(filePath, loader) {
  let key = null;
  try {
    const st = fs.statSync(filePath);
    key = `${filePath}|${st.size}|${Math.round(st.mtimeMs)}|${loader || ''}`;
  } catch { /* упадёт ниже в readJar */ }
  if (key && cache.has(key)) return cache.get(key);
  const rec = await readJar(filePath, { loader });
  if (key && !rec.error) cache.set(key, rec);
  return rec;
}

async function mapPool(items, worker, size) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  }));
  return out;
}

// все .jar и .jar.disabled в папке модов
async function scanModsDir(modsDir, { loader } = {}) {
  if (!fs.existsSync(modsDir)) return [];
  const files = fs.readdirSync(modsDir).filter(f => /\.jar(\.disabled)?$/i.test(f));
  return mapPool(files, f => readJarCached(path.join(modsDir, f), loader), 6);
}

module.exports = { scanModsDir, readJar, parseToml, parseFabricJson, parseForgeToml, parseLooseJson };
