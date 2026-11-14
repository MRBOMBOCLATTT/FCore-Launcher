const test = require('node:test');
const assert = require('node:assert/strict');
const { exportSettings, parseImport, FORMAT } = require('../src/settingsTransfer');

const file = settings => JSON.stringify({ format: FORMAT, version: 1, settings });

test('экспорт берёт только известные настройки и не трогает секреты', () => {
  const store = { memoryMax: '4G', theme: 'blue', accounts: [{ token: 'x' }], curseforgeApiKey: 'secret', javaPath: 'C:\\java', language: 'en' };
  const out = exportSettings(k => store[k], '1.7.0');
  assert.deepEqual(Object.keys(out.settings).sort(), ['language', 'memoryMax', 'theme']);
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.equal(out.format, FORMAT);
});

test('импорт принимает корректные значения', () => {
  const { settings, skipped } = parseImport(file({ memoryMax: '6g', themeMode: 'light', fullscreen: true, gameWidth: 1280, language: 'en' }));
  assert.deepEqual(settings, { memoryMax: '6G', themeMode: 'light', fullscreen: true, gameWidth: 1280, language: 'en' });
  assert.deepEqual(skipped, []);
});

test('импорт отбрасывает неизвестные ключи и неверные типы', () => {
  const { settings, skipped } = parseImport(file({ accounts: [], curseforgeApiKey: 'k', fullscreen: 'yes', gameWidth: -5, themeMode: 'pink' }));
  assert.deepEqual(settings, {});
  assert.deepEqual(skipped.map(s => s.key).sort(), ['accounts', 'curseforgeApiKey', 'fullscreen', 'gameWidth', 'themeMode']);
});

test('JVM-аргументы: обычные флаги проходят, подключение кода — нет', () => {
  assert.equal(parseImport(file({ jvmArgs: '-XX:+UseG1GC -Xss1M' })).settings.jvmArgs, '-XX:+UseG1GC -Xss1M');
  for (const evil of ['-javaagent:evil.jar', '-XX:OnError=calc.exe', '-cp evil.jar', '-Xbootclasspath/a:x.jar', '-agentlib:jdwp=transport=dt_socket', '-jar x.jar']) {
    const res = parseImport(file({ jvmArgs: evil }));
    assert.equal('jvmArgs' in res.settings, false, evil);
    assert.equal(res.skipped[0].key, 'jvmArgs');
  }
});

test('импорт отвергает чужие и битые файлы', () => {
  assert.throws(() => parseImport('не json'), /не JSON/);
  assert.throws(() => parseImport('{"hello":1}'), /не файл настроек/);
  assert.throws(() => parseImport(JSON.stringify({ format: FORMAT, version: 99, settings: {} })), /новой версией/);
});

test('список избранных версий очищается от мусора и дублей', () => {
  const { settings } = parseImport(file({ favoriteVersions: ['1.21.1', '1.21.1', '<script>', 5, '1.20.4'] }));
  assert.deepEqual(settings.favoriteVersions, ['1.21.1', '1.20.4']);
});

test('цвет темы: только #rrggbb', () => {
  assert.equal(parseImport(file({ themeCustom: '#6aa437' })).settings.themeCustom, '#6aa437');
  assert.equal('themeCustom' in parseImport(file({ themeCustom: 'red; background:url(x)' })).settings, false);
});
