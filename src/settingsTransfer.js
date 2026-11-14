const { sanitizeConfig } = require('./gradientConfig');

const FORMAT = 'fcore-launcher-settings';
const VERSION = 1;

const ok = value => ({ ok: true, value });
const bad = reason => ({ ok: false, reason });

const bool = v => (typeof v === 'boolean' ? ok(v) : bad('ожидалось true или false'));
const oneOf = (...allowed) => v => (allowed.includes(v) ? ok(v) : bad('недопустимое значение'));
const int = (min, max) => v => (Number.isInteger(v) && v >= min && v <= max ? ok(v) : bad(`ожидалось целое число от ${min} до ${max}`));

// память хранится строкой вида "4G" / "512M"
const memory = v => (typeof v === 'string' && /^\d{1,6}\s?[GMgm]$/.test(v.trim()) ? ok(v.trim().toUpperCase()) : bad('ожидалось значение вроде 4G или 512M'));

// JVM-аргументы запускаются вместе с игрой, поэтому из чужого файла нельзя принимать
// ничего, что подключает код (агенты, classpath) или выполняет команды
const DANGEROUS_JVM = /-javaagent|-agentpath|-agentlib|-Xbootclasspath|-Djava\.class\.path|-Djava\.library\.path|-Djava\.ext\.dirs|(^|\s)-(cp|classpath|jar)(\s|=|$)|--class-path|--module-path|-XX:OnError|-XX:OnOutOfMemoryError|-XX:\+?ExtensionDirs|-XX:Flight/i;
const jvmArgs = v => {
  if (typeof v !== 'string' || v.length > 2000) return bad('ожидалась строка до 2000 символов');
  if (DANGEROUS_JVM.test(v)) return bad('содержит параметры JVM, подключающие код или запускающие команды');
  return ok(v.trim());
};

const hexColor = v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? ok(v) : bad('ожидался цвет вида #aabbcc'));
const themeName = v => (typeof v === 'string' && /^[a-z0-9_-]{1,32}$/i.test(v) ? ok(v) : bad('недопустимое имя темы'));

const favorites = v => {
  if (!Array.isArray(v) || v.length > 500) return bad('ожидался список версий');
  const clean = v.filter(x => typeof x === 'string' && /^[\w.\- ]{1,40}$/.test(x));
  return ok([...new Set(clean)]);
};

const gradient = v => (v && typeof v === 'object' && !Array.isArray(v) ? ok(sanitizeConfig(v)) : bad('ожидался объект'));
const volume = v => (typeof v === 'number' && v >= 0 && v <= 1 ? ok(v) : bad('ожидалось число от 0 до 1'));

// только то, что имеет смысл переносить между компьютерами. Намеренно НЕ входят:
// аккаунты и токены, ключ CurseForge, пути (папка игры, Java, свои иконки и звуки)
const RULES = {
  memoryMax: memory,
  memoryMin: memory,
  jvmArgs,
  gameWidth: int(200, 16384),
  gameHeight: int(200, 16384),
  fullscreen: bool,
  launcherWidth: int(400, 16384),
  launcherHeight: int(300, 16384),
  gpuPreference: oneOf('auto', 'powersaving', 'performance'),
  afterLaunch: oneOf('close', 'minimize', 'keep'),
  gameLogsEnabled: bool,
  debugMode: bool,
  discordRPC: bool,
  minimizeToTray: bool,
  backupSavesBeforeReinstall: bool,
  customSkinLoaderEnabled: bool,
  notificationsEnabled: bool,
  notificationMode: oneOf('internal', 'system'),
  notificationSoundVolume: volume,
  theme: themeName,
  themeMode: oneOf('dark', 'light'),
  themeCustom: hexColor,
  gradient,
  favoriteVersions: favorites,
  language: oneOf('ru', 'en')
};

function exportSettings(get, appVersion) {
  const settings = {};
  for (const [key, rule] of Object.entries(RULES)) {
    const value = get(key);
    if (value === undefined || value === null) continue;
    const res = rule(value);
    if (res.ok) settings[key] = res.value;
  }
  return { format: FORMAT, version: VERSION, appVersion: appVersion || null, exportedAt: new Date().toISOString(), settings };
}

function parseImport(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Файл повреждён: это не JSON');
  }
  if (!data || data.format !== FORMAT || typeof data.settings !== 'object' || data.settings === null) {
    throw new Error('Это не файл настроек FCore Launcher');
  }
  if (typeof data.version === 'number' && data.version > VERSION) {
    throw new Error('Файл создан более новой версией лаунчера — обновите лаунчер');
  }

  const settings = {};
  const skipped = [];
  for (const [key, value] of Object.entries(data.settings)) {
    const rule = Object.prototype.hasOwnProperty.call(RULES, key) ? RULES[key] : null;
    if (!rule) { skipped.push({ key, reason: 'неизвестная настройка' }); continue; }
    const res = rule(value);
    if (res.ok) settings[key] = res.value;
    else skipped.push({ key, reason: res.reason });
  }
  return { settings, skipped };
}

module.exports = { exportSettings, parseImport, RULES, FORMAT };
