const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const redesignCss = fs.readFileSync(path.join(root, 'renderer', 'redesign.css'), 'utf8');

test('group membership target is independent from the visible-list filter', () => {
  assert.match(html, /id="modsGroupFilter"/);
  assert.match(html, /id="modsGroupTarget"/);
  assert.match(renderer, /function selectedModGroup\(\)\s*\{\s*const id = document\.getElementById\('modsGroupTarget'\)/);
  assert.doesNotMatch(renderer, /function selectedModGroup\(\)\s*\{\s*const id = document\.getElementById\('modsGroupFilter'\)/);
});

test('choosing a target group returns the visible list to all mods', () => {
  const handler = renderer.match(/document\.getElementById\('modsGroupTarget'\)\.addEventListener\('change',[\s\S]*?\n\}\);/);
  assert.ok(handler, 'target group change handler exists');
  assert.match(handler[0], /modsGroupFilter\.value\s*=\s*'all'/);
  assert.match(handler[0], /renderInstalledModsFiltered\(\)/);
});

test('creating a group selects it as target without filtering the list to an empty group', () => {
  const handler = renderer.match(/document\.getElementById\('modsCreateGroupBtn'\)\.addEventListener\('click',[\s\S]*?\n\}\);/);
  assert.ok(handler, 'create group handler exists');
  assert.match(handler[0], /modsGroupTarget'\)\.value\s*=\s*installedModGroups\[installedModGroups\.length\s*-\s*1\]/);
  assert.match(handler[0], /modsGroupFilter\.value\s*=\s*'all'/);
});

test('assign action sends selected installed mod keys to the separate target group', () => {
  const handler = renderer.match(/document\.getElementById\('modsAssignSelectedBtn'\)\.addEventListener\('click',[\s\S]*?\n\}\);/);
  assert.ok(handler, 'assign selected handler exists');
  assert.match(handler[0], /selectedModGroup\(\)/);
  assert.match(handler[0], /selectedInstalledMods\(\)/);
  assert.match(handler[0], /assignModsToGroup\([^;]+toAssign\.map\(m => m\.modKey\)/);
});


test('group selection uses a visible square checkbox rather than the global toggle switch', () => {
  assert.match(redesignCss, /#tab-mods \.mod-group-check input\[type=\"checkbox\"\][\s\S]*?width: 17px !important/);
  assert.match(redesignCss, /#tab-mods \.mod-group-check input\[type=\"checkbox\"]:checked::after[\s\S]*?rotate\(45deg\) scale\(1\)/);
});
