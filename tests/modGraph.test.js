const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../src/modGraph');

const jar = (fileName, id, deps = [], opts = {}) => ({
  fileName,
  enabled: opts.enabled !== false,
  format: 'fabric',
  mods: [{ id, name: id, version: opts.version || '1.0.0', deps, provides: opts.provides || [] }],
  nested: []
});
const req = (id, range = ['*']) => ({ id, kind: 'required', range });

test('satisfies: диапазоны Fabric', () => {
  assert.equal(graph.satisfies(['>=1.20'], '1.20.1', 'fabric'), true);
  assert.equal(graph.satisfies(['>=1.21'], '1.20.1', 'fabric'), false);
  assert.equal(graph.satisfies(['~1.20'], '1.20.4', 'fabric'), true);
  assert.equal(graph.satisfies(['1.20.x'], '1.20.6', 'fabric'), true);
});

test('satisfies: непонятная версия даёт null, а не ложную тревогу', () => {
  assert.equal(graph.satisfies(['>=1.0'], '${file.jarVersion}', 'fabric'), null);
});

test('satisfies: Maven-диапазоны Forge', () => {
  assert.equal(graph.satisfies(['[1.0,2.0)'], '1.5', 'forge'), true);
  assert.equal(graph.satisfies(['[1.0,2.0)'], '2.0', 'forge'), false);
});

test('находит недостающую зависимость', () => {
  const g = graph.buildGraph([jar('a.jar', 'a', [req('fabric-api')])], { mcVersion: '1.21.1' });
  const [p] = graph.findProblems(g);
  assert.equal(p.type, 'missing-dependency');
  assert.equal(p.dependencyId, 'fabric-api');
});

test('выключенный поставщик предлагается к включению', () => {
  const g = graph.buildGraph([
    jar('a.jar', 'a', [req('lib')]),
    jar('lib.jar', 'lib', [], { enabled: false })
  ], { mcVersion: '1.21.1' });
  const [p] = graph.findProblems(g);
  assert.equal(p.type, 'missing-dependency');
  assert.deepEqual(p.disabledProviders, ['lib.jar']);
});

test('встроенные зависимости (minecraft, fabricloader) не считаются недостающими', () => {
  const g = graph.buildGraph([
    jar('a.jar', 'a', [req('fabricloader', ['>=0.15']), req('minecraft', ['>=1.20'])])
  ], { mcVersion: 'Minecraft 1.21.1' });
  assert.deepEqual(graph.findProblems(g), []);
});

test('чужая версия Minecraft', () => {
  const g = graph.buildGraph([jar('a.jar', 'a', [req('minecraft', ['>=1.21'])])], { mcVersion: '1.20.1' });
  assert.equal(graph.findProblems(g)[0].type, 'wrong-minecraft-version');
});

test('дубликаты и конфликты', () => {
  const g = graph.buildGraph([
    jar('x1.jar', 'x'),
    jar('x2.jar', 'x'),
    jar('c.jar', 'c', [{ id: 'x', kind: 'breaks', range: ['*'] }])
  ], { mcVersion: '1.21.1' });
  const types = graph.findProblems(g).map(p => p.type).sort();
  assert.deepEqual(types, ['duplicate', 'incompatible']);
});

test('simulateDisable: каскад поломок', () => {
  const g = graph.buildGraph([
    jar('core.jar', 'core'),
    jar('mid.jar', 'mid', [req('core')]),
    jar('top.jar', 'top', [req('mid')])
  ], { mcVersion: '1.21.1' });
  const sim = graph.simulateDisable(g, ['core.jar']);
  assert.deepEqual(sim.direct.map(b => b.fileName), ['mid.jar']);
  assert.deepEqual(sim.cascade.map(b => b.fileName), ['top.jar']);
});

test('jar-in-jar и provides закрывают зависимость', () => {
  const g = graph.buildGraph([
    jar('a.jar', 'a', [req('api')]),
    jar('bundle.jar', 'bundle', [], { provides: ['api'] })
  ], { mcVersion: '1.21.1' });
  assert.deepEqual(graph.findProblems(g), []);
});
