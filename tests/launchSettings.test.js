const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/launchSettings');

test('память разбирается и форматируется', () => {
  assert.equal(L.parseMemoryMb('4G'), 4096);
  assert.equal(L.parseMemoryMb('2048M'), 2048);
  assert.equal(L.parseMemoryMb('1.5g'), 1536);
  assert.equal(L.parseMemoryMb('abc'), null);
  assert.equal(L.formatMemory(4096), '4G');
  assert.equal(L.formatMemory(1536), '1536M');
});

test('sanitize возвращает значения по умолчанию на мусор', () => {
  assert.deepEqual(L.sanitize(null), L.DEFAULTS);
  const s = L.sanitize({ memoryMode: 'x', memoryMax: '99999G', jvmArgs: 'a\nb', env: 'A=1' });
  assert.equal(s.memoryMode, 'global');
  assert.equal(s.memoryMax, '4G');
  assert.equal(s.jvmArgs, 'a b');
});

test('validate находит ошибки памяти и окружения', () => {
  assert.equal(L.validate({ memoryMode: 'global' }).length, 0);
  assert.match(L.validate({ memoryMode: 'custom', memoryMin: '6G', memoryMax: '2G' })[0], /больше максимума/);
  assert.match(L.validate({ memoryMode: 'custom', memoryMin: 'x', memoryMax: '2G' })[0], /Память/);
  assert.match(L.validate({ env: 'ok=1\n=bad\n1X=2' })[0], /строки 2, 3/);
});

test('переменные окружения', () => {
  const { env, invalid } = L.parseEnv('FOO=bar\n\n  BAZ = a=b \nBAD LINE');
  assert.deepEqual(env, { FOO: 'bar', BAZ: 'a=b' });
  assert.deepEqual(invalid, [4]);
});

test('рекомендация памяти растёт с числом модов и упирается в ОЗУ', () => {
  const small = L.recommendMemory({ totalMb: 32768, mods: 0 });
  const big = L.recommendMemory({ totalMb: 32768, mods: 120, shaders: true });
  assert.equal(small.maxMb, 2048);
  assert.equal(big.maxMb, 7168);
  assert.ok(big.minMb >= 1024 && big.minMb <= big.maxMb);
  const weak = L.recommendMemory({ totalMb: 8192, mods: 200 });
  assert.equal(weak.maxMb, 6144);
  assert.ok(weak.reasons.some(r => /остаётся системе/.test(r)));
  assert.equal(L.recommendMemory({ totalMb: 0, mods: 300 }).maxMb, 4096);
});

test('resolveLaunch: режимы памяти, GC и Java', () => {
  const global = { memoryMin: '1G', memoryMax: '4G', jvmArgs: '-Dx=1', javaPath: 'C:/java.exe' };
  const asGlobal = L.resolveLaunch({ global, settings: {} });
  assert.deepEqual(asGlobal.memory, { min: '1G', max: '4G' });
  assert.equal(asGlobal.jvmArgs, '-Dx=1');
  assert.equal(asGlobal.javaPath, 'C:/java.exe');

  const custom = L.resolveLaunch({ global, settings: { memoryMode: 'custom', memoryMin: '2G', memoryMax: '6G', javaPath: 'D:/j.exe', jvmArgs: '-Dy=2' } });
  assert.deepEqual(custom.memory, { min: '2G', max: '6G' });
  assert.equal(custom.javaPath, 'D:/j.exe');
  assert.match(custom.jvmArgs, /^-Dx=1 -Dy=2$/);

  const auto = L.resolveLaunch({ global, settings: { memoryMode: 'auto' }, recommendation: { minMb: 2048, maxMb: 8192 } });
  assert.deepEqual(auto.memory, { min: '2G', max: '8G' });
  assert.match(auto.jvmArgs, /^-XX:\+UseG1GC .* -Dx=1$/);

  const own = L.resolveLaunch({ global: { ...global, jvmArgs: '-XX:+UseZGC' }, settings: { gcProfile: true } });
  assert.doesNotMatch(own.jvmArgs, /G1/);
});
