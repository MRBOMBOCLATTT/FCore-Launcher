const fs = require('fs');
const path = require('path');

// Бандлим CustomSkinLoader (Universal-сборка, работает и на Fabric, и на Forge)
// прямо с лаунчером — так же, как authlib-injector.jar, только на этот раз это
// настоящий клиентский мод, который кладём в mods/. Он нужен, помимо authlib-injector:
// authlib-injector подменяет сессию на Ely.by, но это помогает увидеть скины
// только если и СЕРВЕР тоже согласен работать через Ely.by/офлайн-режим. На
// серверах, где такое не настроено (или просто в одиночной игре без сервера),
// CustomSkinLoader тянет скины сам, по нику, независимо от того, что думает сервер.
const BUNDLED_JAR = path.join(__dirname, '..', 'resources', 'mods', 'CustomSkinLoader-Universal-15.0.1.jar');
const TARGET_NAME = '_pfc-customskinloader.jar'; // префикс "_" — чтобы не путать с модами, поставленными вручную/через Modrinth

function ensureCustomSkinLoader(modsDir) {
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, TARGET_NAME);
  const disabledDest = `${dest}.disabled`;

  // пользователь мог сам выключить мод через список модов в лаунчере — уважаем это
  if (fs.existsSync(disabledDest)) return null;

  if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(BUNDLED_JAR).size) {
    fs.copyFileSync(BUNDLED_JAR, dest);
  }
  return dest;
}

// вызывается, когда настройку выключили — убираем файл, чтобы не путался в списке модов
function removeCustomSkinLoader(modsDir) {
  for (const name of [TARGET_NAME, `${TARGET_NAME}.disabled`]) {
    const p = path.join(modsDir, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

module.exports = { ensureCustomSkinLoader, removeCustomSkinLoader, TARGET_NAME };
