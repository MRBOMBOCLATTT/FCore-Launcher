const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nbt = require('../src/nbt');
const { parseAddress, listServers, addServer, editServer, removeServer } = require('../src/serverList');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-servers-'));

test('адреса разбираются и проверяются', () => {
  assert.deepEqual(parseAddress('play.example.com'), { host: 'play.example.com', port: 25565, value: 'play.example.com' });
  assert.deepEqual(parseAddress(' 1.2.3.4:25566 '), { host: '1.2.3.4', port: 25566, value: '1.2.3.4:25566' });
  assert.equal(parseAddress('[::1]:25570').value, '[::1]:25570');
  assert.equal(parseAddress('host:99999'), null);
  assert.equal(parseAddress('bad host'), null);
  assert.equal(parseAddress('a:b:c'), null);
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress('-bad.com'), null);
});

test('список из отсутствующего файла пуст, добавление создаёт servers.dat', () => {
  const dir = tempDir();
  assert.deepEqual(listServers(dir), []);
  const list = addServer(dir, { name: 'Мой сервер', ip: 'play.example.com:25566' });
  assert.deepEqual(list, [{ index: 0, name: 'Мой сервер', ip: 'play.example.com:25566' }]);
  assert.ok(fs.existsSync(path.join(dir, 'servers.dat')));
});

test('правка и удаление сохраняют чужие поля и делают копию', () => {
  const dir = tempDir();
  const root = {
    name: '', type: nbt.TAG.Compound, value: [{
      name: 'servers', type: nbt.TAG.List, value: {
        itemType: nbt.TAG.Compound,
        items: [[
          { name: 'name', type: nbt.TAG.String, value: 'Old' },
          { name: 'ip', type: nbt.TAG.String, value: 'old.example.com' },
          { name: 'acceptTextures', type: nbt.TAG.Byte, value: 1 }
        ], [
          { name: 'name', type: nbt.TAG.String, value: 'Other' },
          { name: 'ip', type: nbt.TAG.String, value: 'other.example.com' }
        ]]
      }
    }]
  };
  fs.writeFileSync(path.join(dir, 'servers.dat'), nbt.serialize(root));

  editServer(dir, 0, { name: 'New', ip: 'new.example.com' });
  const parsed = nbt.parse(fs.readFileSync(path.join(dir, 'servers.dat')));
  const first = nbt.findEntry(parsed.value, 'servers').value.items[0];
  assert.equal(nbt.findEntry(first, 'acceptTextures').value, 1);
  assert.equal(nbt.findEntry(first, 'name').value, 'New');
  assert.ok(fs.existsSync(path.join(dir, 'servers.dat_old')));

  const after = removeServer(dir, 0);
  assert.deepEqual(after.map(s => s.name), ['Other']);
  assert.throws(() => removeServer(dir, 5), /не найден/);
});

test('неверные данные отклоняются', () => {
  const dir = tempDir();
  assert.throws(() => addServer(dir, { name: '', ip: 'a.com' }), /название/);
  assert.throws(() => addServer(dir, { name: 'x', ip: 'bad host' }), /адрес/i);
});
