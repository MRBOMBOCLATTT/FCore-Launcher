const { store } = require('./store');

// Создай своё приложение на https://discord.com/developers/applications,
// возьми Client ID оттуда и подставь сюда. Там же, в Rich Presence -> Art Assets,
// нужно загрузить картинку с ключом "pfc_icon" — иначе крупная иконка не покажется
const CLIENT_ID = '1523341451172384789';

let client = null;
let ready = false;

async function init() {
  if (!store.get('discordRPC') || client) return;

  // библиотека тяжёлая (~100 мс на require), а RPC включён не у всех — грузим только когда он нужен
  const { Client } = require('@xhayper/discord-rpc');
  client = new Client({ clientId: CLIENT_ID });
  client.on('ready', () => { ready = true; });

  try {
    await client.login();
  } catch {
    // Discord не запущен или клиент не настроен — просто без RPC, не критично
    client = null;
  }
}

function setMenu() {
  if (!ready) return;
  client.user?.setActivity({
    details: 'В меню лаунчера',
    state: 'FCore Launcher',
    startTimestamp: Date.now(),
    largeImageKey: 'pfc_icon'
  });
}

function setLaunching(mcVersion, loader) {
  if (!ready) return;
  client.user?.setActivity({
    details: 'Запускается...',
    state: `Minecraft ${mcVersion} (${loader})`,
    startTimestamp: Date.now(),
    largeImageKey: 'pfc_icon'
  });
}

function setPlaying(mcVersion, loader, startedAt) {
  if (!ready) return;
  client.user?.setActivity({
    details: 'Играет в Minecraft',
    state: `${mcVersion} · ${loader}`,
    startTimestamp: startedAt,
    largeImageKey: 'pfc_icon'
  });
}

function setPlayingServer(mcVersion, loader, startedAt, host, online, max) {
  if (!ready) return;
  const hasCount = typeof online === 'number' && typeof max === 'number';
  client.user?.setActivity({
    details: `Играет на ${host}`,
    state: hasCount ? `${online}/${max} игроков онлайн` : `${mcVersion} · ${loader}`,
    startTimestamp: startedAt,
    largeImageKey: 'pfc_icon'
  });
}

function shutdown() {
  if (client) client.destroy();
  client = null;
  ready = false;
}

module.exports = { init, setMenu, setLaunching, setPlaying, setPlayingServer, shutdown };
