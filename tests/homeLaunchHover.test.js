const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Home launch card hover override targets the actual selected build card', () => {
  const html = read('renderer/index.html');
  const css = read('renderer/appearance.css');
  assert.match(html, /<section class="card build-card" aria-label="Выбранная сборка">/);
  assert.match(css, /body \.home-main > \.build-card:hover[\s\S]*?transform:\s*none\s*!important/);
  assert.match(css, /body \.home-main > \.build-card:hover[\s\S]*?border-color:\s*var\(--border\)\s*!important/);
});

test('obsolete cursor-following spotlight is removed from Home', () => {
  const js = read('renderer/renderer.js');
  const css = read('renderer/style.css');
  assert.doesNotMatch(js, /initHeroSpotlight|querySelector\(['"]\.play-hero['"]\)/);
  assert.doesNotMatch(css, /карточка "Играть" — мягкий свет следует за курсором|\.play-hero:hover::after/);
});
