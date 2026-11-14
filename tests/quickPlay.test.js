const test = require('node:test');
const assert = require('node:assert/strict');
const { supportsQuickPlay, sanitizeQuickPlay, buildQuickPlayArgs } = require('../src/quickPlay');

test('быстрый вход поддерживается с 1.20', () => {
  assert.equal(supportsQuickPlay('1.19.4'), false);
  assert.equal(supportsQuickPlay('1.20'), true);
  assert.equal(supportsQuickPlay('1.21.4'), true);
  assert.equal(supportsQuickPlay('26.1'), true);
  assert.equal(supportsQuickPlay('23w14a'), false);
  assert.equal(supportsQuickPlay(null), false);
});

test('имя мира проверяется', () => {
  assert.deepEqual(sanitizeQuickPlay({ type: 'world', value: ' Мой мир ' }), { type: 'world', value: 'Мой мир' });
  assert.equal(sanitizeQuickPlay({ type: 'world', value: '../x' }), null);
  assert.equal(sanitizeQuickPlay({ type: 'world', value: 'a\\b' }), null);
  assert.equal(sanitizeQuickPlay({ type: 'other', value: 'x' }), null);
  assert.equal(sanitizeQuickPlay({ type: 'server', value: 'bad host' }), null);
  assert.equal(sanitizeQuickPlay(null), null);
});

test('аргументы запуска', () => {
  assert.deepEqual(buildQuickPlayArgs({ type: 'world', value: 'New World' }, '1.21.1'), ['--quickPlaySingleplayer', 'New World']);
  assert.deepEqual(buildQuickPlayArgs(null, '1.21.1'), []);
  assert.throws(() => buildQuickPlayArgs({ type: 'world', value: 'x' }, '1.16.5'), /1\.20/);
});

test('аргументы для сервера зависят от версии', () => {
  assert.deepEqual(buildQuickPlayArgs({ type: 'server', value: 'play.example.com' }, '1.21'), ['--quickPlayMultiplayer', 'play.example.com:25565']);
  assert.deepEqual(buildQuickPlayArgs({ type: 'server', value: 'play.example.com:25566' }, '1.20.1'), ['--quickPlayMultiplayer', 'play.example.com:25566']);
  assert.deepEqual(buildQuickPlayArgs({ type: 'server', value: 'play.example.com:25566' }, '1.16.5'), ['--server', 'play.example.com', '--port', '25566']);
  assert.deepEqual(buildQuickPlayArgs({ type: 'server', value: '[::1]:25570' }, '1.21'), ['--quickPlayMultiplayer', '[::1]:25570']);
});
