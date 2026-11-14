const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, pickFolder, dirOf } = require('../src/buildFolder');

test('slugify: русские названия переводятся в латиницу', () => {
  assert.equal(slugify('Моя сборка'), 'Moya sborka');
  assert.equal(slugify('Выживание с модами'), 'Vyzhivanie s modami');
  assert.equal(slugify('Щука и Ёж'), 'Shchuka i Yozh');
});

test('slugify: убирает запрещённые символы и не оставляет точки и пробелы по краям', () => {
  assert.equal(slugify('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(slugify('  ..Тест..  '), 'Test');
  assert.equal(slugify('😀😀'), 'build');
  assert.equal(slugify(''), 'build');
  assert.equal(slugify('a'.repeat(100)).length, 40);
});

test('slugify: зарезервированные имена Windows и имена как у старых версий', () => {
  assert.equal(slugify('CON'), 'CON_');
  assert.equal(slugify('nul'), 'nul_');
  assert.equal(slugify('COM1'), 'COM1_');
  assert.equal(slugify('1.21.1-fabric'), '1.21.1-fabric_');
  assert.equal(slugify('my-forge'), 'my-forge_');
  assert.equal(slugify('Fabric pack'), 'Fabric pack');
});

test('pickFolder: добавляет номер, если имя занято, без учёта регистра', () => {
  assert.equal(pickFolder('Моя сборка', ['moya sborka']), 'Moya sborka 2');
  assert.equal(pickFolder('Моя сборка', ['Moya sborka', 'Moya sborka 2']), 'Moya sborka 3');
  assert.equal(pickFolder('Pack', [], name => name === 'Pack'), 'Pack 2');
  assert.equal(pickFolder('Pack', ['other']), 'Pack');
});

test('dirOf: у старых сборок папка build-<id>, у новых из названия', () => {
  assert.equal(dirOf({ id: 'abc123' }), 'build-abc123');
  assert.equal(dirOf({ id: 'abc123', folder: 'Moya sborka' }), 'Moya sborka');
});

test('renameToMatch: переименовывает папку со всем содержимым и не трогает остальные', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { renameToMatch } = require('../src/buildFolder');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rename-'));
  fs.mkdirSync(path.join(root, 'build-abc', 'saves', 'World'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build-abc', 'saves', 'World', 'level.dat'), 'data');
  fs.mkdirSync(path.join(root, 'Moya sborka'), { recursive: true });

  const build = { id: 'abc', name: 'Моя сборка' };
  const first = renameToMatch(build, root, ['Moya sborka']);
  assert.equal(first, 'Moya sborka 2');
  assert.equal(fs.readFileSync(path.join(root, 'Moya sborka 2', 'saves', 'World', 'level.dat'), 'utf8'), 'data');
  assert.equal(fs.existsSync(path.join(root, 'build-abc')), false);
  assert.equal(fs.existsSync(path.join(root, 'Moya sborka')), true);

  assert.equal(renameToMatch({ id: 'abc', name: 'Моя сборка', folder: 'Moya sborka 2' }, root, ['Moya sborka']), null);
  const renamed = renameToMatch({ id: 'abc', name: 'Новое имя', folder: 'Moya sborka 2' }, root, []);
  assert.equal(renamed, 'Novoe imya');
  assert.equal(fs.existsSync(path.join(root, 'Novoe imya', 'saves', 'World', 'level.dat')), true);

  const missing = renameToMatch({ id: 'zzz', name: 'Пусто' }, root, []);
  assert.equal(missing, 'Pusto');
  assert.equal(fs.existsSync(path.join(root, 'Pusto')), false);
});

test('renameToMatch: ошибка переименования пробрасывается, папка остаётся на месте', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { renameToMatch } = require('../src/buildFolder');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rename2-'));
  fs.mkdirSync(path.join(root, 'build-abc'));
  const locked = { ...fs, renameSync() { throw new Error('EBUSY'); }, existsSync: fs.existsSync };
  assert.throws(() => renameToMatch({ id: 'abc', name: 'Имя' }, root, [], locked), /EBUSY/);
  assert.equal(fs.existsSync(path.join(root, 'build-abc')), true);
});
