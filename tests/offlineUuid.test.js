const test = require('node:test');
const assert = require('node:assert/strict');
const { offlineUuid, isValidOfflineName } = require('../src/offlineUuid');

test('UUID постоянный для ника и разный для разных ников', () => {
  assert.equal(offlineUuid('Steve'), offlineUuid('Steve'));
  assert.notEqual(offlineUuid('Steve'), offlineUuid('Alex'));
  assert.notEqual(offlineUuid('Steve'), offlineUuid('steve'));
});

test('UUID — версия 3 с корректным вариантом', () => {
  const uuid = offlineUuid('Steve');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('проверка ника: 3–16 символов, латиница, цифры и _', () => {
  for (const ok of ['Steve', 'a_b', 'Player_123', 'A'.repeat(16)]) assert.equal(isValidOfflineName(ok), true, ok);
  for (const bad of ['', 'ab', 'A'.repeat(17), 'Игрок', 'a b', 'a-b', 'a<b>', null, undefined]) assert.equal(isValidOfflineName(bad), false, String(bad));
});
