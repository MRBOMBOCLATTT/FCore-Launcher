const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// без этого агента ванильный клиент лезет за скином к Mojang, а не к Ely.by,
// и там его, разумеется, нет — отсюда Стив вместо реального скина
const INJECTOR_URL = 'https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.5/authlib-injector-1.2.5.jar';

async function ensureAuthlibInjector(root) {
  const jarPath = path.join(root, 'authlib-injector.jar');
  if (fs.existsSync(jarPath)) return jarPath;

  const res = await fetch(INJECTOR_URL, { timeout: 30000 });
  if (!res.ok) throw new Error(`Не удалось скачать authlib-injector: ${res.status}`);

  const buffer = await res.buffer();
  fs.writeFileSync(jarPath, buffer);
  return jarPath;
}

module.exports = { ensureAuthlibInjector };
