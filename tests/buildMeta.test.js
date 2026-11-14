const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeMeta, cleanTags, listGroups, filterBuilds, groupBuilds } = require('../src/buildMeta');

const builds = [
  { id: 'a', name: 'Выживание', mcVersion: '1.21.1', loader: 'fabric', group: 'Друзья', tags: ['hardcore', 'моды'] },
  { id: 'b', name: 'Креатив', mcVersion: '1.20.1', loader: 'forge', group: 'друзья', tags: [] },
  { id: 'c', name: 'PvP', mcVersion: '1.8.9', loader: 'vanilla', tags: ['pvp'] },
  { id: 'd', name: 'Тест', mcVersion: '1.21.1', loader: 'neoforge', group: 'Работа' }
];

test('теги: убирает дубли, решётки и лишнее, режет по лимитам', () => {
  assert.deepEqual(cleanTags('#pvp, PvP , , моды,   сервер'), ['pvp', 'моды', 'сервер']);
  assert.equal(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 6);
  assert.equal(cleanTags(['x'.repeat(50)])[0].length, 20);
});

test('sanitizeMeta: чистит управляющие символы и угловые скобки', () => {
  const meta = sanitizeMeta({ group: '  <b>Друзья</b>\n', tags: ['a<script>'] });
  assert.equal(meta.group, 'bДрузья/b');
  assert.deepEqual(meta.tags, ['ascript']);
  assert.deepEqual(sanitizeMeta(null), { group: '', tags: [] });
});

test('listGroups: уникальные без учёта регистра и по алфавиту', () => {
  assert.deepEqual(listGroups(builds), ['Друзья', 'Работа']);
});

test('filterBuilds: по группе, без группы и по запросу', () => {
  assert.deepEqual(filterBuilds(builds, { group: 'друзья' }).map(b => b.id), ['a', 'b']);
  assert.deepEqual(filterBuilds(builds, { group: '' }).map(b => b.id), ['c']);
  assert.deepEqual(filterBuilds(builds, { query: 'hardcore 1.21' }).map(b => b.id), ['a']);
  assert.deepEqual(filterBuilds(builds, { query: 'forge' }).map(b => b.id), ['b', 'd']);
  assert.equal(filterBuilds(builds, {}).length, 4);
});

test('groupBuilds: секции по группам, сборки без группы в конце', () => {
  const sections = groupBuilds(builds);
  assert.deepEqual(sections.map(s => s.name), ['Друзья', 'Работа', '']);
  assert.deepEqual(sections[0].builds.map(b => b.id), ['a', 'b']);
});
