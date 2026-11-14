const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findExactDuplicateFiles } = require('../src/modConflictDetector');

test('detects byte-identical enabled JARs even when filenames differ', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcore-mod-dupes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('same-jar-content');
  fs.writeFileSync(path.join(dir, 'example.jar'), bytes);
  fs.writeFileSync(path.join(dir, 'example (1).jar'), bytes);
  fs.writeFileSync(path.join(dir, 'different.jar'), Buffer.from('different-content'));

  const groups = await findExactDuplicateFiles(dir);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].enabledCount, 2);
  assert.deepEqual(groups[0].files.map(f => f.diskName).sort(), ['example (1).jar', 'example.jar']);
});

test('does not report a disabled copy as two active duplicates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcore-mod-disabled-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('identical');
  fs.writeFileSync(path.join(dir, 'example.jar'), bytes);
  fs.writeFileSync(path.join(dir, 'example-copy.jar.disabled'), bytes);

  const groups = await findExactDuplicateFiles(dir);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].enabledCount, 1);
  assert.equal(groups[0].disabledCount, 1);
});

test('returns an empty list for a missing mods folder', async () => {
  const dir = path.join(os.tmpdir(), `fcore-missing-${Date.now()}`);
  assert.deepEqual(await findExactDuplicateFiles(dir), []);
});


test('does not treat the (1) filename suffix as proof of a duplicate', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcore-mod-name-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'example.jar'), Buffer.from('first-file'));
  fs.writeFileSync(path.join(dir, 'example (1).jar'), Buffer.from('other-file'));
  assert.deepEqual(await findExactDuplicateFiles(dir), []);
});
