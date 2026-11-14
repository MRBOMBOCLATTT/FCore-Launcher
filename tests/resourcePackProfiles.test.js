const test = require('node:test');
const assert = require('node:assert/strict');
const { createProfileRecord, planProfileApply } = require('../src/resourcePackProfiles');

test('new profiles snapshot managed packs and installed enabled states', () => {
  const profile = createProfileRecord({
    id: 'p1', name: 'PvP', loader: 'fabric',
    packs: [{ projectId: 'pvp-pack', title: 'PvP Pack' }],
    installedPacks: [{ fileName: 'pvp.zip', enabled: true }, { fileName: 'vanilla.zip', enabled: false }],
    createdAt: 123
  });
  assert.deepEqual(profile.installedPacks, [
    { fileName: 'pvp.zip', enabled: true },
    { fileName: 'vanilla.zip', enabled: false }
  ]);
  assert.equal(profile.createdAt, 123);
});

test('new profile replaces managed list, restores pack states and disables files absent from snapshot without deleting', () => {
  const profile = {
    packs: [{ projectId: 'saved', title: 'Saved' }],
    installedPacks: [{ fileName: 'saved.zip', enabled: true }, { fileName: 'off.zip', enabled: false }]
  };
  const plan = planProfileApply(profile,
    [{ projectId: 'current', title: 'Current' }],
    [
      { fileName: 'saved.zip', enabled: false },
      { fileName: 'off.zip', enabled: true },
      { fileName: 'new-local.zip', enabled: true }
    ]
  );
  assert.deepEqual(plan.nextWanted, [{ projectId: 'saved', title: 'Saved' }]);
  assert.deepEqual(plan.enabledUpdates, [
    { fileName: 'saved.zip', enabled: true },
    { fileName: 'off.zip', enabled: false },
    { fileName: 'new-local.zip', enabled: false }
  ]);
  assert.equal(plan.legacy, false);
});

test('legacy profiles retain merge behavior and do not change local enabled states', () => {
  const plan = planProfileApply({ packs: [{ projectId: 'new', title: 'New' }] },
    [{ projectId: 'existing', title: 'Existing' }],
    [{ fileName: 'local.zip', enabled: true }]
  );
  assert.deepEqual(plan.nextWanted.map(p => p.projectId), ['existing', 'new']);
  assert.deepEqual(plan.enabledUpdates, []);
  assert.equal(plan.legacy, true);
});
