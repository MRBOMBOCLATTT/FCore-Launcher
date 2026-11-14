const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFabricJson, parseLooseJson } = require('../src/modIndex');

test('parseLooseJson: сырые переводы строк и табы внутри строк', () => {
  const j = parseLooseJson('{"name":"a\nb\tc","id":"x"}');
  assert.equal(j.name, 'a\nb\tc');
});

test('parseLooseJson: экранированные кавычки не ломают разбор', () => {
  const j = parseLooseJson('{"name":"q\\"w\ne"}');
  assert.equal(j.name, 'q"w\ne');
});

test('parseLooseJson: BOM в начале файла', () => {
  assert.equal(parseLooseJson('\uFEFF{"id":"x"}').id, 'x');
});

test('parseLooseJson: настоящий мусор по-прежнему ошибка', () => {
  assert.throws(() => parseLooseJson('{"id": '));
});

test('parseFabricJson: зависимости, provides и вложенные jar', () => {
  const parsed = parseFabricJson(JSON.stringify({
    id: 'm', version: '2.0', name: 'M',
    depends: { 'fabric-api': '*', minecraft: ['>=1.20', '<1.22'] },
    suggests: { extra: '*' },
    breaks: { bad: '<1' },
    provides: ['m-alias'],
    jars: [{ file: 'META-INF/jars/lib.jar' }]
  }));
  const [mod] = parsed.mods;
  assert.equal(mod.id, 'm');
  assert.deepEqual(mod.provides, ['m-alias']);
  assert.deepEqual(mod.deps.map(d => `${d.kind}:${d.id}`).sort(),
    ['breaks:bad', 'optional:extra', 'required:fabric-api', 'required:minecraft']);
  assert.deepEqual(parsed.nestedJars, ['META-INF/jars/lib.jar']);
});
