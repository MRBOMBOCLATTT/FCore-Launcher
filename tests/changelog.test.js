const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { CHANGELOG } = require('../src/changelog');

const norm = s => String(s).replace(/\s+/g, ' ').trim();

test('у каждой записи журнала изменений есть английский перевод', () => {
  const window = {};
  const context = vm.createContext({ window });
  for (const file of ['i18n-en.js', 'i18n-changelog-en.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf-8'), context);
  }
  const exact = window.I18N_EN.exact;

  const missing = [];
  for (const release of CHANGELOG) {
    for (const key of ['added', 'fixed', 'changes']) {
      for (const entry of release[key] || []) {
        if (!exact[norm(entry)]) missing.push(`${release.version}: ${norm(entry).slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(missing, [],
    'Нет перевода для записей журнала. Добавьте их в renderer/i18n-changelog-en.js (ключ — русский текст записи):\n' + missing.join('\n'));
});
