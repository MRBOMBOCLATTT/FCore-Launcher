const { Auth, validate } = require('msmc');

// один Auth-менеджер на весь лаунчер — так refresh() и launch() делят
// один и тот же внутренний клиент
const authManager = new Auth('select_account');

// Пятиминутный запас перед реальным истечением — чтобы токен не протух
// прямо во время загрузки/захода в мир, пока идёт запуск
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

// msmc сам кладёт exp (epoch ms) в meta при mclc(true) — раньше лаунчер
// обновлял токен перед каждым запуском игры безусловно, это лишний поход
// в Xbox Live/XSTS на 1-3 секунды почти всегда впустую, ведь токен живёт ~23 часа
function isMicrosoftTokenValid(mclcAuth) {
  const exp = mclcAuth?.meta?.exp;
  return typeof exp === 'number' && validate(mclcAuth) && exp - Date.now() > EXPIRY_SAFETY_MARGIN_MS;
}

// Открывает окно входа Microsoft (msmc сам поднимает своё Electron-окно)
// и возвращает объект авторизации в формате, который minecraft-launcher-core
// понимает напрямую — как и mclcAuth у остальных типов аккаунтов.
// refresh-токен просим вшить в meta.refresh, чтобы не хранить его отдельно
async function loginMicrosoft() {
  const xboxManager = await authManager.launch('electron');
  const minecraft = await xboxManager.getMinecraft();
  return minecraft.mclc(true);
}

// Обновляет токен по refresh-токену из meta.refresh предыдущего входа
async function refreshMicrosoft(refreshToken) {
  const xboxManager = await authManager.refresh(refreshToken);
  const minecraft = await xboxManager.getMinecraft();
  return minecraft.mclc(true);
}

module.exports = { loginMicrosoft, refreshMicrosoft, isMicrosoftTokenValid };
