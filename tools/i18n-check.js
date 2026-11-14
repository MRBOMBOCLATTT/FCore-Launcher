// Проверка перевода: запускает настоящий интерфейс в jsdom с подставными данными,
// обходит вкладки и печатает русский текст, который остался без перевода.
//
//   npm install --no-save jsdom
//   npm run i18n:check
//
// Переменная TABS задаёт обход, например: TABS=builds,content:mods node tools/i18n-check.js
// Проверяются только те состояния, которые удалось воспроизвести подставными данными,
// поэтому «0 остатков» — не гарантия, а хороший ориентир. Новые строки добавляйте в renderer/i18n-en.js.
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const LANG = process.env.LANG_UI || 'en';
process.on('unhandledRejection', () => {});
process.on('uncaughtException', e => { errors.push('uncaught: ' + e.message); });
const errors = [];

const html = fs.readFileSync(path.join(R, 'index.html'), 'utf-8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(String(e.message).slice(0, 160)));
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: vc });
const w = dom.window;
w.localStorage.setItem('fcore-lang', LANG);

const CHANGELOG = require(path.join(ROOT, 'src/changelog')).CHANGELOG;
const builds = [
  { id: 'a1', name: 'Survival', mcVersion: '1.21.1', loader: 'fabric', active: true, modsCount: 12, packsCount: 2, shadersCount: 1, playtimeMs: 5400000, lastPlayedAt: Date.now() - 86400000, accent: null },
  { id: 'b2', name: 'PvP', mcVersion: '1.20.4', loader: 'forge', active: false, modsCount: 1, packsCount: 0, shadersCount: 0, playtimeMs: 0, lastPlayedAt: null, accent: null }
];
const mods = [
  { fileName: 'sodium.jar', title: 'Sodium', enabled: true, projectId: 'AANobbMI', isDependency: false },
  { fileName: 'lib.jar.disabled', title: 'Lib', enabled: false, projectId: 'x', isDependency: true }
];
const fixtures = {
  listBuilds: builds,
  getChangelog: CHANGELOG,
  getSettings: { memoryMin: '1G', memoryMax: '4G', jvmArgs: '', language: LANG, gameWidth: 854, gameHeight: 480, afterLaunch: 'keep', theme: 'green', themeMode: 'dark', gpuPreference: 'auto', notificationMode: 'internal' },
  listVersions: [{ id: '1.21.4', type: 'release' }, { id: '1.21.1', type: 'release' }, { id: '1.20.4', type: 'release' }],
  listInstalledMods: mods,
  getMemoryInfo: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 },
  currentAccount: { name: 'Steve', type: 'microsoft', uuid: 'abc' },
  listAccounts: [{ profile: { name: 'Steve', type: 'microsoft', uuid: 'abc' }, selected: true }],
  listWorlds: [{ folder: 'w1', displayName: 'My world', sizeBytes: 123456789, lastPlayed: Date.now(), gameMode: 'Survival', hardcore: true }],
  listScreenshots: [],
  listCrashLogs: [],
  searchMods: { hits: [{ id: 'AANobbMI', title: 'Sodium', description: 'A modern rendering engine', icon: '' }], totalHits: 1, limit: 20 },
  searchResourcePacks: { hits: [{ id: 'rp1', title: 'Faithful', description: 'Pack', icon: '' }], totalHits: 1, limit: 20 },
  searchShaders: { hits: [{ id: 'sh1', title: 'Complementary', description: 'Shader', icon: '' }], totalHits: 1, limit: 20 },
  getWantedMods: [{ projectId: 'x', title: 'Wanted mod', fileName: 'w.jar', pinned: true }],
  getWantedResourcePacks: [{ projectId: 'y', title: 'Wanted pack', fileName: 'p.zip' }],
  getWantedShaders: [{ projectId: 'z', title: 'Wanted shader', fileName: 's.zip' }],
  listModProfiles: [{ id: 'p1', name: 'Profile', loader: 'fabric', createdAt: Date.now(), mods: [] }],
  compareBuilds: { a: { name: 'Survival', mcVersion: '1.21.1', loader: 'fabric', mods: 12 }, b: { name: 'PvP', mcVersion: '1.20.4', loader: 'forge', mods: 5 },
    mods: { onlyA: [{ name: 'Sodium', version: '0.6.0' }], onlyB: [{ name: 'Embeddium', version: '1.0' }], different: [{ name: 'Lithium', versionA: '1.0', versionB: '2.0' }], same: 3 },
    packs: { onlyA: ['faithful.zip'], onlyB: [], same: 1 }, shaders: { onlyA: [], onlyB: ['bsl.zip'], same: 0 } },
  planBuildMigration: { mods: [{ title: 'Sodium', status: 'ok' }, { title: 'Old mod', status: 'missing' }, { title: 'CF mod', status: 'unknown' }], packs: [], shaders: [],
    summary: { mods: { ok: 1, missing: 1, unknown: 1, total: 3 }, packs: { ok: 0, missing: 0, unknown: 0, total: 0 }, shaders: { ok: 0, missing: 0, unknown: 0, total: 0 } } },
  planOptimization: [
    { slug: 'sodium', title: 'Sodium', why: 'FPS', state: 'candidate', projectId: 'a', versionNumber: '0.6.0' },
    { slug: 'lithium', title: 'Lithium', why: 'Logic', state: 'installed', projectId: 'b' },
    { slug: 'modernfix', title: 'ModernFix', why: 'Fast', state: 'unavailable', projectId: 'c' },
    { slug: 'x', title: 'Embeddium', why: 'x', state: 'conflict', projectId: 'd' }],
  listBackups: [{ fileName: 'w1.zip', sizeBytes: 5000000, createdAt: Date.now() }]
};
w.api = new Proxy({}, {
  get(_, name) {
    if (typeof name !== 'string') return undefined;
    if (name.startsWith('on')) return () => () => {};
    return async () => (name in fixtures ? JSON.parse(JSON.stringify(fixtures[name])) : (name.startsWith('list') ? [] : {}));
  }
});
w.fetch = async () => { throw new Error('offline'); };
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({}), set: () => true });
w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
w.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
w.Audio = class { play() { return Promise.resolve(); } pause() {} addEventListener() {} };
w.skinview3d = { SkinViewer: class { constructor() { this.playerObject = {}; } loadSkin() {} loadCape() {} dispose() {} }, IdleAnimation: class {}, WalkingAnimation: class {}, RunningAnimation: class {}, FlyingAnimation: class {} };

const order = ['i18n-en.js', 'i18n-changelog-en.js', 'i18n.js', 'renderer.js', 'diagnostics.js', '../src/gradientConfig.js', 'gradient.js', 'home.js', 'builds.js', 'buildTools.js'];
for (const f of order) {
  try { w.eval(fs.readFileSync(path.join(R, f), 'utf-8')); } catch (e) { errors.push(`${f}: ${e.message}`.slice(0, 200)); }
}

const cy = /[А-Яа-яЁё]/;
function leftovers() {
  const out = new Set();
  const walker = w.document.createTreeWalker(w.document.body, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || ['SCRIPT', 'STYLE'].includes(p.tagName) || p.closest('[data-no-i18n]')) continue;
    if (cy.test(n.nodeValue)) out.add(n.nodeValue.replace(/\s+/g, ' ').trim());
  }
  w.document.querySelectorAll('[placeholder],[title],[aria-label],[alt]').forEach(el => {
    if (el.closest('[data-no-i18n]')) return;
    for (const a of ['placeholder', 'title', 'aria-label', 'alt']) { const v = el.getAttribute(a); if (v && cy.test(v)) out.add(`[${a}] ${v}`); }
  });
  return out;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(300);
  const tabs = (process.env.TABS || 'home,builds,content,worlds,downloads,screenshots,activity,settings,changelog').split(',');
  const all = new Map();
  for (const tab of tabs) {
    try {
      if (tab.startsWith('content:')) { const pane = tab.split(':')[1]; w.eval("versionSelect.value='1.21.1'; loaderSelect.value='fabric';"); w.eval(`switchTab('content'); showContentPane(${JSON.stringify(pane)});`); await sleep(200); w.eval({ mods: 'runModSearch()', resourcepacks: 'runRpSearch()', shaders: 'runShSearch()' }[pane]); }
      else if (tab.startsWith('dialog:')) {
        const name = tab.split(':')[1];
        w.eval("versionSelect.value='1.21.1'; loaderSelect.value='fabric';");
        const b = 'JSON.parse(' + JSON.stringify(JSON.stringify(builds)) + ')';
        w.eval({
          compare: `fcBuildTools.openCompare(${b}[0], ${b})`,
          migrate: `fcBuildTools.openMigrate(${b}[0])`,
          optimize: 'fcBuildTools.openOptimize()'
        }[name]);
        await sleep(300);
        if (name === 'migrate') { [...w.document.querySelectorAll('.bc-foot button')].find(x => /Проверить|Check/.test(x.textContent))?.click(); await sleep(300); }
      }
      else w.eval(`switchTab(${JSON.stringify(tab)})`);
    } catch (e) { errors.push(`switchTab(${tab}): ${e.message}`.slice(0, 160)); }
    await sleep(400);
    for (const s of leftovers()) if (!all.has(s)) all.set(s, tab);
  }
  console.log('errors:', errors.length); [...new Set(errors)].slice(0, 12).forEach(e => console.log('  !', e));
  console.log('leftover Russian:', all.size);
  const clTexts = new Set();
  for (const e of CHANGELOG) for (const k of ['added','fixed','changes']) for (const t of (e[k]||[])) clTexts.add(String(t).replace(/\s+/g,' ').trim());
  let clCount = 0;
  for (const [s, tab] of all) { if (clTexts.has(s)) { clCount++; continue; } console.log(`  [${tab}] ${s.slice(0, 170)}`); }
  console.log('(changelog entries untranslated:', clCount, ')');
  process.exit(0);
})();
