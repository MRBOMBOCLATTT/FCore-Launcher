const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../src/buildTools');

const mod = (key, version, name = key) => ({ key, name, version, fileName: `${key}.jar` });

test('сравнение сборок: только в одной, разные версии, одинаковые', () => {
  const a = [mod('sodium', '0.5.0'), mod('lithium', '1.0'), mod('onlya', '1')];
  const b = [mod('sodium', '0.6.0'), mod('lithium', '1.0'), mod('onlyb', '2')];
  const diff = tools.compareInventories(a, b);
  assert.deepEqual(diff.onlyA.map(m => m.name), ['onlya']);
  assert.deepEqual(diff.onlyB.map(m => m.name), ['onlyb']);
  assert.deepEqual(diff.different, [{ key: 'sodium', name: 'sodium', versionA: '0.5.0', versionB: '0.6.0' }]);
  assert.equal(diff.same, 1);
});

test('сравнение сборок: одинаковые сборки без отличий', () => {
  const list = [mod('a', '1'), mod('b', '2')];
  const diff = tools.compareInventories(list, list);
  assert.deepEqual([diff.onlyA, diff.onlyB, diff.different], [[], [], []]);
  assert.equal(diff.same, 2);
});

test('сравнение имён файлов', () => {
  const diff = tools.compareNames(['a.zip', 'b.zip'], ['b.zip', 'c.zip']);
  assert.deepEqual(diff, { onlyA: ['a.zip'], onlyB: ['c.zip'], same: 1 });
});

test('набор оптимизации зависит от загрузчика', () => {
  assert.equal(tools.optimizationSet('vanilla').length, 0);
  assert.equal(tools.optimizationSet('fabric')[0].slug, 'sodium');
  assert.equal(tools.optimizationSet('forge')[0].slug, 'embeddium');
  assert.equal(tools.optimizationSet('neoforge')[0].slug, 'embeddium');
  assert.ok(tools.optimizationSet('fabric').some(i => i.slug === 'lithium'));
  assert.equal(tools.optimizationSet('forge').some(i => i.slug === 'lithium'), false);
});

test('оптимизация: уже установленное и конфликты рендерера', () => {
  const plan = tools.planOptimization('fabric', ['sodium', 'ferritecore']);
  const state = slug => plan.find(i => i.slug === slug).state;
  assert.equal(state('sodium'), 'installed');
  assert.equal(state('ferrite-core'), 'installed');
  assert.equal(state('lithium'), 'candidate');

  const withOptifine = tools.planOptimization('fabric', ['optifine']);
  assert.equal(withOptifine.find(i => i.slug === 'sodium').state, 'conflict');
});

test('перенос: сводка по статусам', () => {
  const sum = tools.summarizeMigration([{ status: 'ok' }, { status: 'ok' }, { status: 'missing' }, { status: 'unknown' }]);
  assert.deepEqual(sum, { ok: 2, missing: 1, unknown: 1, total: 4 });
});

test('сравнение версий Minecraft', () => {
  assert.ok(tools.compareMcVersions('1.21.4', '1.21.1') > 0);
  assert.ok(tools.compareMcVersions('1.20', '1.20.1') < 0);
  assert.equal(tools.compareMcVersions('1.21', '1.21.0'), 0);
  assert.deepEqual(['1.20.4', '1.21', '1.19.2'].sort(tools.compareMcVersions), ['1.19.2', '1.20.4', '1.21']);
});

const withDeps = (key, requires = [], provides = []) => ({ ...mod(key, '1'), requires, provides });

test('перенос модов: тянет обязательные зависимости из исходной сборки', () => {
  const source = [withDeps('a', ['lib', 'minecraft']), withDeps('lib', ['deep']), withDeps('deep'), withDeps('other')];
  const plan = tools.planModTransfer(['a'], source, [], new Set(['minecraft']));
  assert.deepEqual(plan.mods.map(m => m.key), ['a']);
  assert.deepEqual(plan.deps.map(m => m.key).sort(), ['deep', 'lib']);
  assert.deepEqual(plan.missing, []);
});

test('перенос модов: не трогает то, что уже есть в целевой сборке', () => {
  const source = [withDeps('a', ['lib']), withDeps('lib')];
  const target = [withDeps('lib')];
  const plan = tools.planModTransfer(['a'], source, target);
  assert.deepEqual(plan.deps, []);
});

test('перенос модов: зависимость находится через provides, а отсутствующая попадает в missing', () => {
  const source = [withDeps('a', ['api', 'ghost']), withDeps('fabric-api', [], ['api'])];
  const plan = tools.planModTransfer(['a'], source, []);
  assert.deepEqual(plan.deps.map(m => m.key), ['fabric-api']);
  assert.deepEqual(plan.missing, ['ghost']);
});

test('перенос модов: отмеченный мод не дублируется как зависимость', () => {
  const source = [withDeps('a', ['b']), withDeps('b', ['a'])];
  const plan = tools.planModTransfer(['a', 'b'], source, []);
  assert.equal(plan.mods.length, 2);
  assert.deepEqual(plan.deps, []);
});

test('перенос модов: записи списка переносятся, ручные файлы попадают в unlisted', () => {
  const targetWanted = [{ projectId: 'x', title: 'X' }];
  const sourceWanted = [
    { projectId: 'x', title: 'X', lastFileName: 'x.jar' },
    { projectId: 'p', title: 'P', lastFileName: 'p-1.jar' },
    { projectId: 'q', title: 'Q', pinned: true, pinnedFileName: 'q-2.jar' }
  ];
  const files = [{ fileName: 'x.jar' }, { fileName: 'p-1.jar' }, { fileName: 'q-2.jar' }, { fileName: 'manual.jar' }];
  const res = tools.mergeWantedMods(targetWanted, sourceWanted, files);
  assert.deepEqual(res.wanted.map(w => w.projectId), ['x', 'p', 'q']);
  assert.deepEqual(res.added.map(w => w.projectId), ['p', 'q']);
  assert.deepEqual(res.unlisted, ['manual.jar']);
});

test('версии без сборки: находит папки с модами и пропускает пустые и сборочные', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-legacy-'));
  const make = (folder, files) => {
    for (const rel of files) {
      const file = path.join(root, folder, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
    }
  };
  make('1.21.1-fabric', ['mods/a.jar', 'mods/b.jar', 'mods/c.jar.disabled', 'resourcepacks/p.zip', 'saves/w/level.dat']);
  make('1.20.1-forge', ['mods/a.jar']);
  make('1.21-pre1-neoforge', ['shaderpacks/s.zip']);
  make('1.19.4-fabric', ['config/x.json']);
  make('build-abc123', ['mods/a.jar']);
  make('random', ['mods/a.jar']);
  const list = require('../src/buildTools').scanLegacyVersions(root);
  assert.deepEqual(list.map(v => v.folder), ['1.21.1-fabric', '1.20.1-forge', '1.21-pre1-neoforge']);
  assert.deepEqual(list[0], { folder: '1.21.1-fabric', mcVersion: '1.21.1', loader: 'fabric', mods: 3, resourcePacks: 1, shaders: 0, hasWorlds: true });
  assert.equal(list[2].mcVersion, '1.21-pre1');
  assert.deepEqual(require('../src/buildTools').scanLegacyVersions(path.join(root, 'нет')), []);
});

test('версии без сборки: папки сборок из списка исключения не попадают в результат', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-legacy2-'));
  for (const folder of ['1.21.1-fabric', 'my-fabric_']) {
    fs.mkdirSync(path.join(root, folder, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(root, folder, 'mods', 'a.jar'), 'x');
  }
  fs.mkdirSync(path.join(root, 'Pack-forge', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Pack-forge', 'mods', 'a.jar'), 'x');
  const list = require('../src/buildTools').scanLegacyVersions(root, new Set(['pack-forge']));
  assert.deepEqual(list.map(v => v.folder), ['1.21.1-fabric']);
});
