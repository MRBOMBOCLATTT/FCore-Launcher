const test = require('node:test');
const assert = require('node:assert/strict');
const { createElybySkinApi, normalizeTextureUrl } = require('../src/elybySkinApi');

test('Ely.by texture lookup returns an empty result for missing textures without image URLs', async () => {
  let calls = 0;
  const api = createElybySkinApi({ fetchImpl: async () => { calls++; return { status: 204, ok: false }; } });
  const info = await api.getTextureInfo('NoSkinPlayer', 'uuid-1');
  assert.equal(info.skinUrl, null);
  assert.equal(info.capeUrl, null);
  assert.equal(info.uuid, 'uuid-1');
  assert.equal(calls, 1);
});

test('Ely.by texture lookup parses skin/cape URLs and slim model', async () => {
  const api = createElybySkinApi({ fetchImpl: async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      SKIN: { url: 'http://textures.example/skin.png', metadata: { model: 'slim' } },
      CAPE: { url: 'http://textures.example/cape.png' }
    })
  }) });
  const info = await api.getTextureInfo('PlayerName');
  assert.equal(info.skinUrl, 'https://textures.example/skin.png');
  assert.equal(info.capeUrl, 'https://textures.example/cape.png');
  assert.equal(info.variant, 'slim');
});

test('Ely.by texture lookup caches names case-insensitively and can be cleared', async () => {
  let calls = 0;
  const api = createElybySkinApi({ fetchImpl: async () => {
    calls++;
    return { status: 204, ok: false };
  } });
  await api.getTextureInfo('ExampleUser');
  await api.getTextureInfo('exampleuser');
  assert.equal(calls, 1);
  api.clearCache();
  await api.getTextureInfo('EXAMPLEUSER');
  assert.equal(calls, 2);
});

test('invalid Ely.by nicknames are rejected without a network request', async () => {
  let calls = 0;
  const api = createElybySkinApi({ fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  const info = await api.getTextureInfo('../not-a-player');
  assert.equal(info.skinUrl, null);
  assert.equal(calls, 0);
});

test('texture URL normalization upgrades plain HTTP URLs', () => {
  assert.equal(normalizeTextureUrl('http://textures.example/skin.png'), 'https://textures.example/skin.png');
  assert.equal(normalizeTextureUrl(null), null);
});
