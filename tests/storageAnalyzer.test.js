const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeStorage, scanDirectory } = require('../src/storageAnalyzer');

test('storage analyzer totals categories, build directories and largest files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcore-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'instances', 'survival', 'mods'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances', 'survival', 'saves', 'world'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', 'survival', 'mods', 'mod.jar'), Buffer.alloc(120));
  fs.writeFileSync(path.join(root, 'instances', 'survival', 'saves', 'world', 'level.dat'), Buffer.alloc(30));
  fs.writeFileSync(path.join(root, 'assets', 'index.json'), Buffer.alloc(50));
  fs.writeFileSync(path.join(root, 'options.txt'), Buffer.alloc(10));

  const report = await analyzeStorage(root, [{ id: 'a1', name: 'Survival', folder: 'survival', mcVersion: '1.21.1', loader: 'fabric' }]);
  assert.equal(report.totalBytes, 210);
  assert.equal(report.totalFiles, 4);
  assert.equal(report.builds[0].name, 'Survival');
  assert.equal(report.builds[0].sizeBytes, 150);
  assert.equal(report.largestFiles[0].sizeBytes, 120);
  assert.ok(report.categories.some(c => c.key === 'assets' && c.sizeBytes === 50));
});

test('scanDirectory skips symbolic links', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcore-storage-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.bin');
  fs.writeFileSync(target, Buffer.alloc(100));
  try { fs.symlinkSync(target, path.join(root, 'link.bin')); }
  catch (err) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip('symlink permissions are unavailable'); throw err; }
  const report = await scanDirectory(root);
  assert.equal(report.sizeBytes, 100);
  assert.equal(report.fileCount, 1);
});
