const fs = require('fs');
const path = require('path');
const launcher = require('./launcher');

function getJavaRootDir(root) {
  return path.join(root, 'java');
}

function getDirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? getDirSize(full) : fs.statSync(full).size;
  }
  return total;
}

// какие мажорные версии Java сейчас реально нужны — по всем существующим
// инстансам (версия+лоадер), а не только по текущей выбранной в интерфейсе
async function listUsedJavaMajors(root) {
  const instancesDir = path.join(root, 'instances');
  const used = new Set();
  if (!fs.existsSync(instancesDir)) return used;

  let buildList = [];
  try { buildList = require('./store').listBuilds(); } catch {}

  for (const name of fs.readdirSync(instancesDir)) {
    let mcVersion = name.split('-')[0];
    const build = buildList.find(b => name === (b.folder || `build-${b.id}`) || name === `build-${b.id}`);
    if (build) mcVersion = build.mcVersion;
    else if (name.startsWith('build-')) mcVersion = '';
    if (!mcVersion) continue;
    try {
      used.add(await launcher.resolveRequiredJavaVersion(mcVersion));
    } catch {
      // не смогли определить — просто не учитываем этот инстанс
    }
  }
  return used;
}

async function listInstalledJava(root) {
  const javaRoot = getJavaRootDir(root);
  if (!fs.existsSync(javaRoot)) return [];

  const used = await listUsedJavaMajors(root);

  return fs.readdirSync(javaRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const major = Number(e.name);
      const dir = path.join(javaRoot, e.name);
      return {
        major,
        sizeBytes: getDirSize(dir),
        ready: !!launcher.findJavaw(dir),
        used: used.has(major)
      };
    })
    .sort((a, b) => a.major - b.major);
}

async function installJava(root, major, onEvent = () => {}) {
  return launcher.downloadJavaMajor(root, major, onEvent);
}

function deleteJava(root, major) {
  const dir = path.join(getJavaRootDir(root), String(major));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { listInstalledJava, installJava, deleteJava, getJavaRootDir };
