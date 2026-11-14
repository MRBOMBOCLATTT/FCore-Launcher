const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  SNAPSHOT_ROOTS,
  sanitizeSnapshotName,
  slugifySnapshotName,
  validateManagedRoots,
  resolveSnapshotEntry,
  formatSnapshotSummary
} = require('../src/buildSnapshotUtils');

const staging = path.join(path.sep, 'tmp', 'fcore-snapshot-test');

test('snapshot name is cleaned and limited', () => {
  assert.equal(sanitizeSnapshotName('  Before: update / test  '), 'Before update test');
  assert.equal(sanitizeSnapshotName('a'.repeat(100)).length, 64);
  assert.throws(() => sanitizeSnapshotName('   '), /название/i);
  assert.equal(slugifySnapshotName('Тестовая сборка #1'), 'тестовая-сборка-1');
});

test('managed roots default by snapshot format and reject unknown roots', () => {
  assert.deepEqual(validateManagedRoots(null, 1), ['mods', 'resourcepacks']);
  assert.deepEqual(validateManagedRoots(null, 2), [...SNAPSHOT_ROOTS]);
  assert.throws(() => validateManagedRoots(['mods', '../outside'], 2), /недопустимый список/i);
});

test('archive entry resolver allows safe relative paths only', () => {
  const target = resolveSnapshotEntry(staging, 'config/jei/world.toml', SNAPSHOT_ROOTS);
  assert.equal(target, path.join(staging, 'config', 'jei', 'world.toml'));
  assert.throws(() => resolveSnapshotEntry(staging, '../outside.txt', SNAPSHOT_ROOTS), /небезопасный путь/i);
  assert.throws(() => resolveSnapshotEntry(staging, 'mods\\..\\outside.jar', SNAPSHOT_ROOTS), /некорректный путь/i);
  assert.throws(() => resolveSnapshotEntry(staging, '/absolute/file', SNAPSHOT_ROOTS), /абсолютный путь/i);
  assert.throws(() => resolveSnapshotEntry(staging, 'unknown/file', SNAPSHOT_ROOTS), /неизвестную директорию/i);
  assert.throws(() => resolveSnapshotEntry(staging, 'mods/CON.jar', SNAPSHOT_ROOTS), /зарезервированное имя/i);
});

test('snapshot summary contains only non-zero categories', () => {
  assert.equal(formatSnapshotSummary({ mods: 4, shaders: 1, configFiles: 2 }), '4 мода · 1 шейдер · 2 файла конфигурации');
  assert.equal(formatSnapshotSummary({}), 'Без файлов контента');
});
