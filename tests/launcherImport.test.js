const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const li = require('../src/launcherImport');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fc-import-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('Prism: версия, загрузчик и имя берутся из mmc-pack.json и instance.cfg', () => {
  const root = tmp();
  const dir = path.join(root, 'abc');
  write(path.join(dir, 'instance.cfg'), '[General]\nname=Моя сборка\n');
  write(path.join(dir, 'mmc-pack.json'), JSON.stringify({
    components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.15.7' }]
  }));
  write(path.join(dir, 'minecraft', 'mods', 'a.jar'), 'x');
  write(path.join(dir, 'minecraft', 'mods', 'b.jar.disabled'), 'x');
  fs.mkdirSync(path.join(dir, 'minecraft', 'saves', 'World'), { recursive: true });
  const [item] = li.scanKnown({ prism: [root], multimc: [], curseforge: [], official: [] });
  assert.equal(item.name, 'Моя сборка');
  assert.equal(item.mcVersion, '1.20.1');
  assert.equal(item.loader, 'fabric');
  assert.equal(item.mods, 2);
  assert.equal(item.worlds, 1);
});

test('Prism: без версии Minecraft или без папки игры инстанс пропускается', () => {
  const root = tmp();
  write(path.join(root, 'a', 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.fabricmc.fabric-loader', version: '1' }] }));
  fs.mkdirSync(path.join(root, 'a', 'minecraft'), { recursive: true });
  write(path.join(root, 'b', 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.20.1' }] }));
  assert.deepEqual(li.scanFolder(root), []);
});

test('CurseForge: загрузчик из baseModLoader', () => {
  const root = tmp();
  write(path.join(root, 'Pack', 'minecraftinstance.json'), JSON.stringify({
    name: 'Pack', gameVersion: '1.20.1', baseModLoader: { name: 'forge-47.2.0' }
  }));
  const [item] = li.scanFolder(root);
  assert.equal(item.loader, 'forge');
  assert.equal(item.mcVersion, '1.20.1');
  assert.equal(li.loaderFromCurseName('neoforge-21.1.5'), 'neoforge');
  assert.equal(li.loaderFromCurseName('fabric-0.15.7-1.20.1'), 'fabric');
});

test('официальный лаунчер: версия берётся из inheritsFrom, latest-* пропускается', () => {
  const root = tmp();
  write(path.join(root, 'launcher_profiles.json'), JSON.stringify({
    profiles: {
      a: { name: 'Fabric', lastVersionId: 'fabric-loader-0.15.7-1.20.1' },
      b: { name: 'Последняя', lastVersionId: 'latest-release' },
      c: { name: 'Ванилла', lastVersionId: '1.19.4' }
    }
  }));
  write(path.join(root, 'versions', 'fabric-loader-0.15.7-1.20.1', 'fabric-loader-0.15.7-1.20.1.json'), JSON.stringify({ inheritsFrom: '1.20.1' }));
  const items = li.scanOfficial(root);
  assert.deepEqual(items.map(i => [i.name, i.mcVersion, i.loader]), [['Fabric', '1.20.1', 'fabric'], ['Ванилла', '1.19.4', 'vanilla']]);
});

test('копирование: только нужное, симлинки пропускаются, миры по запросу', () => {
  const src = tmp();
  const dst = tmp();
  write(path.join(src, 'mods', 'a.jar'), 'jar');
  write(path.join(src, 'options.txt'), 'x');
  write(path.join(src, 'logs', 'latest.log'), 'secret');
  write(path.join(src, 'saves', 'W', 'level.dat'), 'w');
  const outside = tmp();
  write(path.join(outside, 'passwd'), 'top secret');
  try {
    fs.symlinkSync(path.join(outside, 'passwd'), path.join(src, 'mods', 'link.jar'));
  } catch {
    // симлинки недоступны на этой системе
  }
  const copied = li.copyInstanceFiles(src, dst, { worlds: false });
  assert.deepEqual(copied.sort(), ['mods', 'options.txt']);
  assert.ok(!fs.existsSync(path.join(dst, 'logs')));
  assert.ok(!fs.existsSync(path.join(dst, 'saves')));
  assert.ok(!fs.existsSync(path.join(dst, 'mods', 'link.jar')));
  li.copyInstanceFiles(src, dst, { worlds: true });
  assert.ok(fs.existsSync(path.join(dst, 'saves', 'W', 'level.dat')));
});

test('pinnedFromTarget: все файлы закрепляются, .disabled без суффикса', () => {
  const dir = tmp();
  write(path.join(dir, 'mods', 'a.jar'), '1');
  write(path.join(dir, 'mods', 'b.jar.disabled'), '1');
  write(path.join(dir, 'resourcepacks', 'p.zip'), '1');
  write(path.join(dir, 'shaderpacks', 's.zip'), '1');
  const pinned = li.pinnedFromTarget(dir);
  assert.deepEqual(pinned.mods.map(m => m.pinnedFileName).sort(), ['a.jar', 'b.jar']);
  assert.equal(pinned.mods[0].pinned, true);
  assert.equal(pinned.resourcePacks[0].projectId, 'local:p.zip');
  assert.equal(pinned.shaders[0].title, 's');
});

test('defaultRoots: пути зависят от платформы', () => {
  const win = li.defaultRoots('win32', { APPDATA: 'C:\\Users\\m\\AppData\\Roaming' }, 'C:\\Users\\m');
  assert.ok(win.prism[0].includes('PrismLauncher'));
  const linux = li.defaultRoots('linux', {}, '/home/m');
  assert.ok(linux.official[0].endsWith('.minecraft'));
});
