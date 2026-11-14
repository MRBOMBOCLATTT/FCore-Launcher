const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { parseLooseJson } = require('./modIndex');

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  });
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (err, zip) => err ? reject(err) : resolve(zip)));
}

async function readJarMetadata(filePath) {
  const result = { fileName: path.basename(filePath), format: null, metadata: null, error: null };
  let zip;
  try {
    zip = await openZip(filePath);
    const entries = [];
    await new Promise((resolve, reject) => {
      zip.readEntry();
      zip.on('entry', entry => { entries.push(entry); zip.readEntry(); });
      zip.on('end', resolve);
      zip.on('error', reject);
    });
    const candidates = [
      ['fabric.mod.json', 'fabric'],
      ['META-INF/mods.toml', 'forge'],
      ['META-INF/neoforge.mods.toml', 'neoforge']
    ];
    for (const [name, format] of candidates) {
      const entry = entries.find(e => e.fileName === name);
      if (!entry) continue;
      zip.close();
      zip = await openZip(filePath);
      const target = await new Promise((resolve, reject) => {
        let found = false;
        zip.readEntry();
        zip.on('entry', e => { if (e.fileName === name) { found = true; resolve(e); } else if (!found) zip.readEntry(); });
        zip.on('error', reject);
      });
      const text = await readEntry(zip, target);
      result.format = format;
      if (format === 'fabric') result.metadata = parseLooseJson(text);
      else result.metadata = { raw: text };
      return result;
    }
    result.error = 'метаданные загрузчика не найдены';
  } catch (e) { result.error = e.message || 'не удалось прочитать JAR'; }
  finally { try { zip?.close(); } catch {} }
  return result;
}

async function inspectModsDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /\.jar$/i.test(f));
  return Promise.all(files.map(f => readJarMetadata(path.join(dir, f))));
}
module.exports = { inspectModsDir };
