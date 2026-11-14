const fs = require('fs');
const os = require('os');
const path = require('path');

const COPY_ENTRIES = [
  'mods',
  'resourcepacks',
  'shaderpacks',
  'config',
  'options.txt',
  'optionsof.txt',
  'optionsshaders.txt',
  'servers.dat'
];

const SOURCE_LABELS = {
  prism: 'Prism Launcher',
  multimc: 'MultiMC',
  curseforge: 'CurseForge',
  official: 'Minecraft Launcher'
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function countEntries(dir, test) {
  return listDir(dir).filter(e => test(e.name)).length;
}

function parseIni(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.startsWith('[') || line.startsWith('#')) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function loaderFromComponents(components) {
  const byUid = new Map((components || []).map(c => [c.uid, c.version]));
  const mc = byUid.get('net.minecraft') || null;
  let loader = 'vanilla';
  if (byUid.has('net.fabricmc.fabric-loader') || byUid.has('org.quiltmc.quilt-loader')) loader = 'fabric';
  else if (byUid.has('net.neoforged')) loader = 'neoforge';
  else if (byUid.has('net.minecraftforge')) loader = 'forge';
  return { mcVersion: mc, loader };
}

function loaderFromVersionId(id) {
  const text = String(id || '').toLowerCase();
  if (text.includes('fabric-loader') || text.includes('quilt-loader')) return 'fabric';
  if (text.includes('neoforge')) return 'neoforge';
  if (text.includes('forge')) return 'forge';
  return 'vanilla';
}

function loaderFromCurseName(name) {
  const text = String(name || '').toLowerCase();
  if (text.startsWith('fabric') || text.startsWith('quilt')) return 'fabric';
  if (text.startsWith('neoforge')) return 'neoforge';
  if (text.startsWith('forge')) return 'forge';
  return 'vanilla';
}

function describeGameDir(gameDir) {
  return {
    mods: countEntries(path.join(gameDir, 'mods'), n => /\.jar(\.disabled)?$/i.test(n)),
    resourcePacks: countEntries(path.join(gameDir, 'resourcepacks'), () => true),
    shaders: countEntries(path.join(gameDir, 'shaderpacks'), () => true),
    worlds: countEntries(path.join(gameDir, 'saves'), () => true)
  };
}

function readMmcInstance(dir, source) {
  const pack = readJson(path.join(dir, 'mmc-pack.json'));
  if (!pack || !Array.isArray(pack.components)) return null;
  const { mcVersion, loader } = loaderFromComponents(pack.components);
  if (!mcVersion) return null;
  const gameDir = ['minecraft', '.minecraft'].map(n => path.join(dir, n)).find(isDir);
  if (!gameDir) return null;
  let name = path.basename(dir);
  try {
    const cfg = parseIni(fs.readFileSync(path.join(dir, 'instance.cfg'), 'utf8'));
    if (cfg.name) name = cfg.name;
  } catch {
    name = path.basename(dir);
  }
  return { source, name, gameDir, mcVersion, loader, ...describeGameDir(gameDir) };
}

function readCurseInstance(dir) {
  const info = readJson(path.join(dir, 'minecraftinstance.json'));
  if (!info || !info.gameVersion) return null;
  return {
    source: 'curseforge',
    name: String(info.name || path.basename(dir)),
    gameDir: dir,
    mcVersion: String(info.gameVersion),
    loader: loaderFromCurseName(info.baseModLoader && info.baseModLoader.name),
    ...describeGameDir(dir)
  };
}

function scanMmcRoot(root, source) {
  return listDir(root)
    .filter(e => e.isDirectory())
    .map(e => readMmcInstance(path.join(root, e.name), source))
    .filter(Boolean);
}

function scanCurseRoot(root) {
  return listDir(root)
    .filter(e => e.isDirectory())
    .map(e => readCurseInstance(path.join(root, e.name)))
    .filter(Boolean);
}

function resolveMcVersion(root, versionId) {
  const json = readJson(path.join(root, 'versions', versionId, `${versionId}.json`));
  if (json && json.inheritsFrom) return String(json.inheritsFrom);
  if (/^\d+\.\d+(\.\d+)?$/.test(versionId)) return versionId;
  if (json && json.id && /^\d+\.\d+(\.\d+)?$/.test(String(json.id))) return String(json.id);
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(versionId);
  return match ? match[1] : null;
}

function scanOfficial(root) {
  const profiles = readJson(path.join(root, 'launcher_profiles.json'));
  if (!profiles || typeof profiles.profiles !== 'object') return [];
  const result = [];
  for (const [id, profile] of Object.entries(profiles.profiles)) {
    const versionId = profile && profile.lastVersionId;
    if (!versionId || /^latest-/.test(versionId)) continue;
    const mcVersion = resolveMcVersion(root, String(versionId));
    if (!mcVersion) continue;
    const gameDir = profile.gameDir && isDir(profile.gameDir) ? profile.gameDir : root;
    result.push({
      source: 'official',
      name: String(profile.name || id),
      gameDir,
      mcVersion,
      loader: loaderFromVersionId(versionId),
      ...describeGameDir(gameDir)
    });
  }
  return result;
}

function defaultRoots(platform = process.platform, env = process.env, home = os.homedir()) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots = { prism: [], multimc: [], curseforge: [], official: [] };
  if (platform === 'win32') {
    roots.prism.push(path.join(appData, 'PrismLauncher', 'instances'));
    roots.multimc.push(path.join(appData, 'MultiMC', 'instances'));
    roots.curseforge.push(path.join(home, 'curseforge', 'minecraft', 'Instances'));
    roots.official.push(path.join(appData, '.minecraft'));
  } else if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    roots.prism.push(path.join(support, 'PrismLauncher', 'instances'));
    roots.multimc.push(path.join(support, 'MultiMC', 'instances'));
    roots.curseforge.push(path.join(home, 'Documents', 'curseforge', 'minecraft', 'Instances'));
    roots.official.push(path.join(support, 'minecraft'));
  } else {
    roots.prism.push(
      path.join(home, '.local', 'share', 'PrismLauncher', 'instances'),
      path.join(home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances')
    );
    roots.multimc.push(path.join(home, '.local', 'share', 'multimc', 'instances'));
    roots.curseforge.push(path.join(home, 'Documents', 'curseforge', 'minecraft', 'Instances'));
    roots.official.push(path.join(home, '.minecraft'));
  }
  return roots;
}

function scanKnown(roots = defaultRoots()) {
  const found = [];
  for (const root of roots.prism) found.push(...scanMmcRoot(root, 'prism'));
  for (const root of roots.multimc) found.push(...scanMmcRoot(root, 'multimc'));
  for (const root of roots.curseforge) found.push(...scanCurseRoot(root));
  for (const root of roots.official) found.push(...scanOfficial(root));
  return found;
}

function scanFolder(folder) {
  if (!folder || !isDir(folder)) return [];
  const direct = readMmcInstance(folder, 'prism') || readCurseInstance(folder);
  if (direct) return [direct];
  if (fs.existsSync(path.join(folder, 'launcher_profiles.json'))) return scanOfficial(folder);
  const nested = [...scanMmcRoot(folder, 'prism'), ...scanCurseRoot(folder)];
  return nested;
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of listDir(src)) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function copyInstanceFiles(gameDir, targetDir, { worlds = false } = {}) {
  const copied = [];
  const entries = worlds ? [...COPY_ENTRIES, 'saves'] : COPY_ENTRIES;
  for (const entry of entries) {
    const from = path.join(gameDir, entry);
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    const to = path.join(targetDir, entry);
    if (stat.isDirectory()) copyTree(from, to);
    else {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(from, to);
    }
    copied.push(entry);
  }
  return copied;
}

function localEntries(dir, test) {
  return listDir(dir)
    .filter(e => !e.isSymbolicLink() && test(e.name))
    .map(e => e.name.replace(/\.disabled$/, ''))
    .filter((name, i, all) => all.indexOf(name) === i)
    .map(fileName => ({
      projectId: `local:${fileName}`,
      title: fileName.replace(/\.(jar|zip)$/i, ''),
      icon: null,
      pinned: true,
      pinnedFileName: fileName
    }));
}

function pinnedFromTarget(targetDir) {
  return {
    mods: localEntries(path.join(targetDir, 'mods'), n => /\.jar(\.disabled)?$/i.test(n)),
    resourcePacks: localEntries(path.join(targetDir, 'resourcepacks'), n => /\.zip(\.disabled)?$/i.test(n)),
    shaders: localEntries(path.join(targetDir, 'shaderpacks'), n => /\.zip(\.disabled)?$/i.test(n))
  };
}

module.exports = {
  SOURCE_LABELS,
  defaultRoots,
  scanKnown,
  scanFolder,
  scanOfficial,
  readMmcInstance,
  readCurseInstance,
  loaderFromComponents,
  loaderFromVersionId,
  loaderFromCurseName,
  resolveMcVersion,
  parseIni,
  copyInstanceFiles,
  pinnedFromTarget
};
