const MEMORY_MODES = ['global', 'auto', 'custom'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ENV_LINES = 30;
const MIN_HEAP_MB = 512;
const MAX_HEAP_MB = 65536;
const AUTO_MIN_MB = 2048;
const AUTO_MAX_MB = 16384;

const GC_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1'
];

const DEFAULTS = Object.freeze({
  memoryMode: 'global',
  memoryMin: '1G',
  memoryMax: '4G',
  gcProfile: false,
  jvmArgs: '',
  javaPath: '',
  env: '',
  preCommand: '',
  postCommand: ''
});

function parseMemoryMb(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGkmg]?)[Bb]?\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  const mb = unit === 'G' ? n * 1024 : unit === 'K' ? n / 1024 : n;
  return Number.isFinite(mb) ? Math.round(mb) : null;
}

function formatMemory(mb) {
  const rounded = Math.round(mb);
  return rounded % 1024 === 0 ? `${rounded / 1024}G` : `${rounded}M`;
}

function cleanLine(value, max) {
  return typeof value === 'string' ? value.replace(/[\r\n\0]+/g, ' ').trim().slice(0, max) : '';
}

function parseEnv(text) {
  const env = {};
  const invalid = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!ENV_KEY.test(key) || Object.keys(env).length >= MAX_ENV_LINES) {
      invalid.push(i + 1);
      return;
    }
    env[key] = line.slice(eq + 1).trim().replace(/\0/g, '').slice(0, 500);
  });
  return { env, invalid };
}

function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {
    memoryMode: MEMORY_MODES.includes(src.memoryMode) ? src.memoryMode : DEFAULTS.memoryMode,
    memoryMin: DEFAULTS.memoryMin,
    memoryMax: DEFAULTS.memoryMax,
    gcProfile: src.gcProfile === true,
    jvmArgs: cleanLine(src.jvmArgs, 1000),
    javaPath: cleanLine(src.javaPath, 500),
    env: typeof src.env === 'string'
      ? src.env.replace(/\0/g, '').split(/\r?\n/).slice(0, MAX_ENV_LINES + 10).join('\n').slice(0, 6000)
      : '',
    preCommand: cleanLine(src.preCommand, 500),
    postCommand: cleanLine(src.postCommand, 500)
  };

  const min = parseMemoryMb(src.memoryMin);
  const max = parseMemoryMb(src.memoryMax);
  if (min !== null && min >= MIN_HEAP_MB && min <= MAX_HEAP_MB) out.memoryMin = formatMemory(min);
  if (max !== null && max >= MIN_HEAP_MB && max <= MAX_HEAP_MB) out.memoryMax = formatMemory(max);
  return out;
}

function validate(input) {
  const problems = [];
  const s = sanitize(input);
  const min = parseMemoryMb(input && input.memoryMin);
  const max = parseMemoryMb(input && input.memoryMax);
  if (s.memoryMode === 'custom') {
    if (min === null || max === null || min < MIN_HEAP_MB || max < MIN_HEAP_MB || min > MAX_HEAP_MB || max > MAX_HEAP_MB) {
      problems.push('Память укажите в формате 2G или 2048M, от 512 МБ до 64 ГБ');
    } else if (min > max) {
      problems.push('Минимум памяти не может быть больше максимума');
    }
  }
  const { invalid } = parseEnv(s.env);
  if (invalid.length) problems.push(`Переменные окружения: проверьте строки ${invalid.join(', ')} (формат ИМЯ=значение, не больше ${MAX_ENV_LINES} штук)`);
  return problems;
}

function roundDown(mb, step = 512) {
  return Math.floor(mb / step) * step;
}

function recommendMemory({ totalMb, mods = 0, shaders = false }) {
  const reasons = [];
  let want;
  if (mods <= 0) want = 2048;
  else if (mods <= 20) want = 3072;
  else if (mods <= 80) want = 4096;
  else if (mods <= 150) want = 6144;
  else if (mods <= 250) want = 8192;
  else want = 10240;

  reasons.push(mods > 0
    ? `Модов в сборке: ${mods}, для них нужно около ${want / 1024} ГБ`
    : `Модов нет, для чистой игры хватает ${want / 1024} ГБ`);

  if (shaders) {
    want += 1024;
    reasons.push('Есть шейдеры: добавили 1 ГБ');
  }

  let max = want;
  if (totalMb > 0) {
    const reserve = Math.max(2048, Math.floor(totalMb / 4));
    const ceiling = Math.max(AUTO_MIN_MB, roundDown(totalMb - reserve));
    if (max > ceiling) {
      max = ceiling;
      reasons.push(`В компьютере ${(totalMb / 1024).toFixed(1)} ГБ ОЗУ: ${(reserve / 1024).toFixed(1)} ГБ остаётся системе и другим программам, поэтому максимум ограничен ${(ceiling / 1024).toFixed(1)} ГБ`);
    }
  } else {
    max = Math.min(max, 4096);
    reasons.push('Объём ОЗУ компьютера не определён, взяли безопасные 4 ГБ');
  }

  max = Math.min(Math.max(roundDown(max), AUTO_MIN_MB), AUTO_MAX_MB);
  const min = Math.min(max, Math.max(1024, roundDown(max / 4)));
  reasons.push('Оптимизированные флаги сборщика мусора включены: меньше подлагиваний при большом числе модов');
  return { minMb: min, maxMb: max, reasons };
}

function resolveLaunch({ global = {}, settings, recommendation }) {
  const s = sanitize(settings);
  let memory = { min: global.memoryMin, max: global.memoryMax };
  if (s.memoryMode === 'custom') memory = { min: s.memoryMin, max: s.memoryMax };
  else if (s.memoryMode === 'auto' && recommendation) memory = { min: formatMemory(recommendation.minMb), max: formatMemory(recommendation.maxMb) };

  const userArgs = [cleanLine(global.jvmArgs, 1000), s.jvmArgs].filter(Boolean).join(' ');
  const useGc = (s.gcProfile || s.memoryMode === 'auto') && !/-XX:\+Use\w*GC\b/.test(userArgs);
  const jvmArgs = [useGc ? GC_FLAGS.join(' ') : '', userArgs].filter(Boolean).join(' ');

  return {
    memory,
    jvmArgs,
    javaPath: s.javaPath || global.javaPath || null,
    env: parseEnv(s.env).env,
    preCommand: s.preCommand,
    postCommand: s.postCommand
  };
}

module.exports = {
  DEFAULTS,
  GC_FLAGS,
  parseMemoryMb,
  formatMemory,
  parseEnv,
  sanitize,
  validate,
  recommendMemory,
  resolveLaunch
};
