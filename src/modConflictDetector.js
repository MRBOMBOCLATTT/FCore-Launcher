const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hashCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashCached(filePath, stat) {
  const key = `${filePath}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  if (hashCache.has(key)) return hashCache.get(key);
  const hash = await hashFile(filePath);
  hashCache.set(key, hash);
  if (hashCache.size > MAX_CACHE_ENTRIES) hashCache.delete(hashCache.keys().next().value);
  return hash;
}

async function findExactDuplicateFiles(modsDir) {
  let entries;
  try { entries = await fs.promises.readdir(modsDir, { withFileTypes: true }); }
  catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const sizeGroups = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !/\.jar(?:\.disabled)?$/i.test(entry.name)) continue;
    const fullPath = path.join(modsDir, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      const group = sizeGroups.get(stat.size) || [];
      group.push({ fullPath, diskName: entry.name, fileName: entry.name.replace(/\.disabled$/i, ''), enabled: !/\.disabled$/i.test(entry.name), sizeBytes: stat.size, stat });
      sizeGroups.set(stat.size, group);
    } catch { /* файл мог исчезнуть во время анализа */ }
  }

  const candidates = [...sizeGroups.values()].filter(group => group.length > 1).flat();
  const hashed = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const item = candidates[next++];
      try { hashed.push({ ...item, hash: await hashCached(item.fullPath, item.stat) }); }
      catch { /* нечитаемый файл не объявляем дубликатом */ }
    }
  }));

  const byHash = new Map();
  for (const file of hashed) {
    const group = byHash.get(file.hash) || [];
    group.push({ diskName: file.diskName, fileName: file.fileName, enabled: file.enabled, sizeBytes: file.sizeBytes });
    byHash.set(file.hash, group);
  }

  return [...byHash.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([hash, files]) => ({
      hash,
      sizeBytes: files[0].sizeBytes,
      enabledCount: files.filter(f => f.enabled).length,
      disabledCount: files.filter(f => !f.enabled).length,
      files: files.sort((a, b) => a.diskName.localeCompare(b.diskName))
    }))
    .sort((a, b) => b.enabledCount - a.enabledCount || b.sizeBytes - a.sizeBytes);
}

module.exports = { findExactDuplicateFiles, hashFile };
