const test = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../src/modGroups');

test('creates groups with trimmed unique names', () => {
  const one = groups.createGroup([], '  Performance  ');
  assert.equal(one[0].name, 'Performance');
  assert.throws(() => groups.createGroup(one, 'performance'), /уже существует/i);
});

test('assigning members moves them from another group', () => {
  let current = groups.createGroup([], 'Visual');
  current = groups.createGroup(current, 'Optimization');
  const [a, b] = current;
  current = groups.assignMembers(current, a.id, ['id:sodium', 'id:lithium']);
  current = groups.assignMembers(current, b.id, ['id:sodium']);
  assert.deepEqual(current.find(g => g.id === a.id).members, ['id:lithium']);
  assert.deepEqual(current.find(g => g.id === b.id).members, ['id:sodium']);
});

test('renames and deletes groups without mutating the original array', () => {
  const current = groups.createGroup([], 'Old');
  const renamed = groups.renameGroup(current, current[0].id, 'New');
  assert.equal(current[0].name, 'Old');
  assert.equal(renamed[0].name, 'New');
  assert.deepEqual(groups.deleteGroup(renamed, current[0].id), []);
});

test('normalizes malformed and duplicate group records', () => {
  const result = groups.normalizeGroups([
    { id: 'a', name: 'Test', members: ['x', 'x', '', 4] },
    { id: 'b', name: 'test', members: ['y'] },
    null
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].members, ['x']);
});


test('stable fallback group keys ignore the disabled filename suffix', () => {
  const { modMemberKey, normalizeModFileName } = require('../src/modGroups');
  assert.equal(normalizeModFileName('LocalMod.jar.disabled'), 'LocalMod.jar');
  assert.equal(modMemberKey({ fileName: 'LocalMod.jar' }), 'file:localmod.jar');
  assert.equal(modMemberKey({ fileName: 'LocalMod.jar.disabled' }), 'file:localmod.jar');
  assert.equal(modMemberKey({ fileName: 'Other.jar.disabled', mods: [{ id: 'ExampleMod' }] }), 'mod:examplemod');
});

test('removing selected members leaves the rest of the target group intact', () => {
  let current = groups.createGroup([], 'Optimization');
  const id = current[0].id;
  current = groups.assignMembers(current, id, ['mod:sodium', 'mod:lithium', 'file:custom.jar']);
  current = groups.removeMembers(current, id, ['mod:lithium']);
  assert.deepEqual(current[0].members, ['mod:sodium', 'file:custom.jar']);
});
