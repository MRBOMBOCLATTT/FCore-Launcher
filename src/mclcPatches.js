const fs = require('fs');
const path = require('path');

// Правки minecraft-launcher-core, из-за которых запуск был медленнее официального лаунчера
// и у части пользователей падал:
// 1) ядро при каждом запуске считает SHA1 у всех ~4000 файлов ассетов одновременно.
//    Это нагружает диск и процессор, на HDD запуск тянется минутами, а при нехватке
//    дескрипторов проверка падает и ядро заново качает все ассеты.
//    Для ассетов сверяем размер файла из индекса, как делает официальный лаунчер.
// 2) при ошибке сети ядро повторяет загрузку один раз и молча идёт дальше.
//    Не скачанная библиотека или ассет даёт краш при старте игры. Повторяем до 3 раз.
// 3) проверка java запускает отдельный процесс JVM на каждый старт. Для абсолютного
//    пути хватает проверки существования файла.
function applyMclcPatches() {
  applyLaunchEnvPatch();
  let Handler;
  try {
    Handler = require('minecraft-launcher-core/components/handler');
  } catch (err) {
    console.warn('[mclc-patches] не удалось загрузить handler:', err.message);
    return;
  }
  if (Handler.prototype.__fcorePatched) return;
  Handler.prototype.__fcorePatched = true;

  const originalGetAssets = Handler.prototype.getAssets;
  const originalCheckSum = Handler.prototype.checkSum;
  const originalDownloadAsync = Handler.prototype.downloadAsync;
  const originalCheckJava = Handler.prototype.checkJava;

  Handler.prototype.getAssets = async function (...args) {
    try {
      const assetDirectory = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, 'assets'));
      const assetId = this.options.version.custom || this.options.version.number;
      const indexPath = path.join(assetDirectory, 'indexes', `${assetId}.json`);
      if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const sizes = new Map();
        for (const obj of Object.values(index.objects || {})) sizes.set(obj.hash, obj.size);
        this.__fcoreAssetSizes = sizes;
        this.__fcoreAssetRoot = path.join(assetDirectory, 'objects');
      }
    } catch {
      this.__fcoreAssetSizes = null;
    }
    try {
      return await originalGetAssets.apply(this, args);
    } finally {
      this.__fcoreAssetSizes = null;
    }
  };

  Handler.prototype.checkSum = function (hash, file) {
    const sizes = this.__fcoreAssetSizes;
    if (sizes && sizes.has(hash) && typeof file === 'string' && file.startsWith(this.__fcoreAssetRoot)) {
      try {
        return Promise.resolve(fs.statSync(file).size === sizes.get(hash));
      } catch {
        return Promise.resolve(false);
      }
    }
    return originalCheckSum.call(this, hash, file);
  };

  Handler.prototype.downloadAsync = async function (url, directory, name, retry, type) {
    const attempts = retry === false ? 1 : 3;
    let result;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      result = await originalDownloadAsync.call(this, url, directory, name, false, type);
      if (result === false) return result; // 404, повтор не поможет
      if (result && result.failed === false) return result;
      try { fs.rmSync(path.join(directory, name), { force: true }); } catch { /* занят, перезапишется */ }
      if (attempt < attempts) await new Promise(r => setTimeout(r, attempt * 800));
    }
    return result;
  };

  Handler.prototype.checkJava = function (java) {
    if (java && path.isAbsolute(java) && fs.existsSync(java)) {
      this.client.emit('debug', `[MCLC]: Using Java at ${java}`);
      return Promise.resolve({ run: true });
    }
    return originalCheckJava.call(this, java);
  };
}

function applyLaunchEnvPatch() {
  let Core;
  try {
    Core = require('minecraft-launcher-core/components/launcher');
  } catch (err) {
    console.warn('[mclc-patches] не удалось загрузить launcher:', err.message);
    return;
  }
  if (Core.prototype.__fcoreEnvPatched) return;
  Core.prototype.__fcoreEnvPatched = true;

  Core.prototype.startMinecraft = function (launchArguments) {
    const child = require('child_process');
    const env = this.options.fcoreEnv ? { ...process.env, ...this.options.fcoreEnv } : process.env;
    const minecraft = child.spawn(this.options.javaPath ? this.options.javaPath : 'java', launchArguments, {
      cwd: this.options.overrides.cwd || this.options.root,
      detached: this.options.overrides.detached,
      env
    });
    minecraft.stdout.on('data', data => this.emit('data', data.toString('utf-8')));
    minecraft.stderr.on('data', data => this.emit('data', data.toString('utf-8')));
    minecraft.on('close', code => this.emit('close', code));
    return minecraft;
  };
}

module.exports = { applyMclcPatches, applyLaunchEnvPatch };
