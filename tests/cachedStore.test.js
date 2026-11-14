const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// electron-store импортирует 'electron'; вне Electron его может не быть вообще (или это просто путь к бинарнику) —
// подставляем пустую заглушку, чтобы тест шёл в обычном node
try {
  const e = require('electron');
  if (typeof e !== 'object') throw new Error('not electron runtime');
} catch {
  const Module = require('module');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === 'electron' ? require.resolve('./helpers/electronStub') : resolve.call(this, request, ...rest);
  };
}

const PlainStore = require('electron-store');
const CachedStore = require('../src/cachedStore');

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fcore-${label}-`));
}

const defaults = { theme: 'blue', accounts: [], instances: {}, nested: { a: { b: 1 } } };

test('get/set/delete ведут себя как у обычного electron-store (случайная последовательность операций)', () => {
  const plain = new PlainStore({ cwd: tmp('plain'), name: 'cfg', defaults });
  const cached = new CachedStore({ cwd: tmp('cached'), name: 'cfg', defaults });

  // mulberry32: у простого LCG младшие биты ходят по короткому циклу и операции получались почти одинаковыми
  let seed = 12345;
  const rnd = n => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const keys = ['theme', 'accounts', 'instances', 'nested.a.b', 'nested.c', 'x', 'y.z', 'list'];

  let reads = 0, writes = 0;
  for (let i = 0; i < 600; i++) {
    const key = keys[rnd(keys.length)];
    const op = rnd(4);
    if (op === 0) {
      const value = rnd(2) ? { id: i, items: [i, i + 1], deep: { n: i } } : `v${i}`;
      plain.set(key, value);
      cached.set(key, value);
      writes++;
    } else if (op === 1) {
      plain.delete(key);
      cached.delete(key);
      writes++;
    } else {
      reads++;
      assert.deepStrictEqual(cached.get(key), plain.get(key), `get(${key}) после шага ${i}`);
      assert.deepStrictEqual(cached.get(key, 'fallback'), plain.get(key, 'fallback'), `get(${key}, default) после шага ${i}`);
    }
  }
  assert.ok(reads > 100 && writes > 100, `слишком мало операций: reads=${reads}, writes=${writes}`);
  for (const key of keys) assert.deepStrictEqual(cached.get(key), plain.get(key));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cached.path, 'utf8')), JSON.parse(fs.readFileSync(plain.path, 'utf8')));
});

test('изменение возвращённого объекта не просачивается в хранилище', () => {
  const store = new CachedStore({ cwd: tmp('mut'), name: 'cfg', defaults });
  store.set('instances', { a: { wantedMods: ['one'] } });

  const first = store.get('instances');
  first.a.wantedMods.push('two');
  first.b = {};

  assert.deepStrictEqual(store.get('instances'), { a: { wantedMods: ['one'] } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(store.path, 'utf8')).instances, { a: { wantedMods: ['one'] } });
});

test('запись сбрасывает кэш: следующий get видит новое значение', () => {
  const store = new CachedStore({ cwd: tmp('inv'), name: 'cfg', defaults });
  assert.strictEqual(store.get('theme'), 'blue'); // прогрели кэш
  store.set('theme', 'green');
  assert.strictEqual(store.get('theme'), 'green');
  store.delete('theme');
  assert.strictEqual(store.get('theme', 'none'), 'none');
});

test('onDidAnyChange срабатывает на каждую запись (на нём держится резервная копия конфига)', () => {
  const store = new CachedStore({ cwd: tmp('evt'), name: 'cfg', defaults });
  let calls = 0;
  store.onDidAnyChange(() => { calls++; });

  store.get('theme');            // кэш прогрет
  store.set('theme', 'green');
  store.get('theme');
  store.set('theme', 'red');
  store.set('instances', { k: 1 });
  assert.strictEqual(calls, 3);
});
