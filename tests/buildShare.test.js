const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { createManifest, encodeBuildCode, decodeBuildCode } = require('../src/buildShare');

const record = {
  wantedMods: [
    { projectId: 'AANobbMI', title: 'Sodium', icon: 'x', source: 'modrinth', pinned: true, pinnedFileName: 'sodium.jar', lastFileName: 'a.jar' },
    { projectId: '306612', title: 'Fabric API', source: 'curseforge', asDependency: true },
    { projectId: 'bad id!', title: 'Нельзя' }
  ],
  wantedResourcePacks: [{ projectId: 'abc123', title: 'Faithful' }],
  wantedShaders: [],
  launch: { preCommand: 'calc.exe', env: 'A=1' },
  backgroundPath: 'C:/secret.png'
};

test('код содержит только список контента без локальных данных', () => {
  const manifest = createManifest({ name: 'Моя сборка', mcVersion: '1.21.1', loader: 'fabric', record });
  const code = encodeBuildCode(manifest);
  assert.ok(code.startsWith('FCB1:'));
  const text = zlib.inflateRawSync(Buffer.from(code.slice(5), 'base64url')).toString('utf8');
  assert.doesNotMatch(text, /calc\.exe|secret|sodium\.jar|pinned/);
});

test('кодирование туда и обратно', () => {
  const code = encodeBuildCode(createManifest({ name: 'Моя сборка', mcVersion: '1.21.1', loader: 'fabric', record }));
  const back = decodeBuildCode(`  ${code}\n`);
  assert.equal(back.name, 'Моя сборка');
  assert.equal(back.mcVersion, '1.21.1');
  assert.equal(back.loader, 'fabric');
  assert.deepEqual(back.mods.map(m => [m.projectId, m.source]), [['AANobbMI', 'modrinth'], ['306612', 'curseforge']]);
  assert.equal(back.mods[1].asDependency, true);
  assert.equal(back.mods[0].pinned, undefined);
  assert.deepEqual(back.resourcePacks.map(m => m.projectId), ['abc123']);
  assert.deepEqual(back.shaders, []);
});

test('мусор и подделки отклоняются', () => {
  assert.equal(decodeBuildCode('hello'), null);
  assert.equal(decodeBuildCode('FCB1:!!!'), null);
  assert.equal(decodeBuildCode(null), null);
  const forge = obj => 'FCB1:' + zlib.deflateRawSync(Buffer.from(JSON.stringify(obj))).toString('base64url');
  assert.equal(decodeBuildCode(forge({ v: 1, mc: '1.21', l: 'evil', m: [{ p: 'a' }] })), null);
  assert.equal(decodeBuildCode(forge({ v: 1, mc: '../x', l: 'fabric', m: [{ p: 'a' }] })), null);
  assert.equal(decodeBuildCode(forge({ v: 1, mc: '1.21', l: 'fabric', m: [] })), null);
  const bomb = 'FCB1:' + zlib.deflateRawSync(Buffer.alloc(5 * 1024 * 1024, 65)).toString('base64url');
  assert.equal(decodeBuildCode(bomb), null);
});

test('дубликаты и некорректные идентификаторы выкидываются', () => {
  const code = 'FCB1:' + zlib.deflateRawSync(Buffer.from(JSON.stringify({ v: 1, mc: '1.20.1', l: 'forge', m: [{ p: 'a1' }, { p: 'a1' }, { p: '../x' }, { p: 'b2', t: '<img src=x>' }] }))).toString('base64url');
  const m = decodeBuildCode(code);
  assert.deepEqual(m.mods.map(x => x.projectId), ['a1', 'b2']);
});
