const test = require('node:test');
const assert = require('node:assert/strict');
const { redactLog, prepareLog, uploadLog } = require('../src/logShare');

test('токены скрываются', () => {
  const out = redactLog('java --accessToken abc123SECRET --uuid x\naccess_token=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl\nAuthorization: Bearer abcdefgh12345678');
  assert.doesNotMatch(out, /abc123SECRET|eyJhbGciOi|abcdefgh12345678/);
  assert.match(out, /--accessToken \[скрыто\]/);
});

test('длинный лог режется с начала', () => {
  const lines = Array.from({ length: 30000 }, (_, i) => `line ${i}`).join('\n');
  const out = prepareLog(lines).split('\n');
  assert.equal(out.length, 25000);
  assert.equal(out[out.length - 1], 'line 29999');
});

test('успешная загрузка возвращает ссылку', async () => {
  let sent;
  const url = await uploadLog('hello', async (u, init) => {
    sent = init.body;
    return { json: async () => ({ success: true, url: 'https://mclo.gs/abc' }) };
  });
  assert.equal(url, 'https://mclo.gs/abc');
  assert.match(sent, /^content=hello$/);
});

test('ошибки сервиса и чужие ссылки отклоняются', async () => {
  await assert.rejects(uploadLog('x', async () => ({ json: async () => ({ success: false, error: 'Too big' }) })), /Too big/);
  await assert.rejects(uploadLog('x', async () => ({ json: async () => ({ success: true, url: 'https://evil.example/x' }) })));
  await assert.rejects(uploadLog('   ', async () => ({})), /пуст/);
  await assert.rejects(uploadLog('x', async () => { throw new Error('net'); }), /Не удалось/);
});
