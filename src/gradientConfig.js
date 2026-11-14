// Конфиг градиента лаунчера: валидация, математика цветов и сборка CSS.
// Файл одновременно подключается в main-процессе (require) и в renderer
// (<script>, глобал PFCGradient), поэтому здесь нет ни Electron, ни DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PFCGradient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ANIMATIONS = ['none', 'flow', 'rotate', 'spectrum', 'pulse', 'shimmer'];
  const TYPES = ['linear', 'radial', 'conic'];
  const TARGET_KEYS = ['launch', 'progress', 'controls', 'banner', 'background'];
  const MIN_STOPS = 2;
  const MAX_STOPS = 4;
  const HEX = /^#[0-9a-f]{6}$/i;

  const DEFAULT_CONFIG = Object.freeze({
    stops: ['#474ed8', '#8a4bff', '#ff4bd8'],
    angle: 135,
    type: 'linear',
    animation: 'flow',
    speed: 5,
    glow: true,
    // насколько градиент «просвечивает» на фоне лаунчера (цель `background`), в процентах
    bgStrength: 45,
    targets: { launch: true, progress: true, controls: true, banner: true, background: true }
  });

  const PRESETS = [
    { id: 'pfc',     name: 'PFC',     stops: ['#474ed8', '#8a4bff', '#ff4bd8'], animation: 'flow' },
    { id: 'sunset',  name: 'Закат',   stops: ['#ff7e5f', '#feb47b', '#ff4b8b'], animation: 'flow' },
    { id: 'aurora',  name: 'Аврора',  stops: ['#00c9a7', '#4b7bff', '#b04bff'], animation: 'flow' },
    { id: 'neon',    name: 'Неон',    stops: ['#00f5ff', '#7a00ff', '#ff00c8'], animation: 'rotate', type: 'conic' },
    { id: 'lava',    name: 'Лава',    stops: ['#ff3d00', '#ff9100', '#ffd54f'], animation: 'pulse' },
    { id: 'ocean',   name: 'Океан',   stops: ['#0077b6', '#00b4d8', '#90e0ef'], animation: 'flow' },
    { id: 'mint',    name: 'Мята',    stops: ['#11998e', '#38ef7d'],            animation: 'flow' },
    { id: 'rainbow', name: 'Радуга',  stops: ['#ff4b4b', '#ffb84b', '#4bff88'], animation: 'spectrum' },
    { id: 'ice',     name: 'Лёд',     stops: ['#a8edea', '#6aa7ff', '#c4b5fd'], animation: 'shimmer' }
  ];

  const clampInt = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  function cloneDefault() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // Всё, что приходит из хранилища, из кода-«поделиться» или из UI, проходит
  // через sanitize: значения потом попадают прямо в CSS, поэтому принимаем
  // только строго проверенные hex-цвета, числа в диапазонах и значения из белых списков.
  function sanitizeConfig(input) {
    const src = input && typeof input === 'object' ? input : {};
    let stops = Array.isArray(src.stops)
      ? src.stops.filter(c => typeof c === 'string' && HEX.test(c)).map(c => c.toLowerCase())
      : [];
    stops = stops.slice(0, MAX_STOPS);
    if (stops.length < MIN_STOPS) stops = DEFAULT_CONFIG.stops.slice();

    const srcTargets = src.targets && typeof src.targets === 'object' ? src.targets : {};
    const targets = {};
    TARGET_KEYS.forEach(k => { targets[k] = srcTargets[k] !== false; });

    return {
      stops,
      angle: clampInt(src.angle, 0, 360, DEFAULT_CONFIG.angle),
      type: TYPES.includes(src.type) ? src.type : DEFAULT_CONFIG.type,
      animation: ANIMATIONS.includes(src.animation) ? src.animation : DEFAULT_CONFIG.animation,
      speed: clampInt(src.speed, 1, 10, DEFAULT_CONFIG.speed),
      glow: src.glow !== false,
      bgStrength: clampInt(src.bgStrength, 10, 100, DEFAULT_CONFIG.bgStrength),
      targets
    };
  }

  // Переопределение цвета для конкретной сборки:
  //   null                                  — как в общих настройках
  //   { kind: 'solid', color: '#rrggbb' }   — один цвет
  //   { kind: 'gradient', gradient: {...} } — свой градиент
  function sanitizeAccent(input) {
    if (!input || typeof input !== 'object') return null;
    if (input.kind === 'solid' && typeof input.color === 'string' && HEX.test(input.color)) {
      return { kind: 'solid', color: input.color.toLowerCase() };
    }
    if (input.kind === 'gradient') {
      return { kind: 'gradient', gradient: sanitizeConfig(input.gradient) };
    }
    return null;
  }

  // ---------- математика цвета ----------
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    const c = v => Math.min(255, Math.max(0, Math.round(v)));
    return '#' + ((1 << 24) + (c(r) << 16) + (c(g) << 8) + c(b)).toString(16).slice(1);
  }

  function mix(hexA, hexB, t) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }

  function lighten(hex, amount) {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(r + amount, g + amount, b + amount);
  }

  function luminance(hex) {
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function average(stops) {
    const sum = stops.reduce((acc, h) => {
      const [r, g, b] = hexToRgb(h);
      return [acc[0] + r, acc[1] + g, acc[2] + b];
    }, [0, 0, 0]);
    return rgbToHex(sum[0] / stops.length, sum[1] / stops.length, sum[2] / stops.length);
  }

  function randomConfig(rng = Math.random) {
    // Берём соседние оттенки (аналоговая схема) со сдвигом — выглядит гармоничнее,
    // чем три случайных цвета.
    const base = rng() * 360;
    const spread = 40 + rng() * 70;
    const count = rng() < 0.5 ? 2 : 3;
    const stops = [];
    for (let i = 0; i < count; i++) {
      const h = (base + spread * i) % 360;
      stops.push(hslToHex(h, 70 + rng() * 25, 52 + rng() * 10));
    }
    const anim = ['flow', 'rotate', 'spectrum', 'pulse', 'shimmer'];
    return sanitizeConfig({
      ...cloneDefault(),
      stops,
      angle: Math.round(rng() * 360),
      animation: anim[Math.floor(rng() * anim.length)]
    });
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }

  // ---------- палитра из картинки ----------
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, s * 100, l * 100];
  }

  // data — Uint8ClampedArray из canvas.getImageData (RGBA). Делим оттенки на
  // 12 секторов, считаем «яркость» каждого (насыщенность × значение, серые
  // и тёмные пиксели не в счёт) и берём самые весомые, но не соседние сектора.
  // null — если на картинке слишком мало цвета (ч/б, почти чёрная и т.п.).
  function extractPalette(data, count) {
    const want = Math.min(MAX_STOPS, Math.max(MIN_STOPS, count || 3));
    const SECT = 12;
    const bins = Array.from({ length: SECT }, (_, i) => ({ i, w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { h, s, v } = rgbToHsv(r, g, b);
      if (v < 0.18 || s < 0.2) continue;
      const w = s * v;
      const bin = bins[Math.floor(h / 30) % SECT];
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
    const ranked = bins.filter(b => b.w > 0).sort((a, b) => b.w - a.w);
    const total = ranked.reduce((sum, b) => sum + b.w, 0);
    const picked = [];
    for (const bin of ranked) {
      if (bin.w < total * 0.04) break;
      const farEnough = picked.every(p => {
        const d = Math.abs(p.i - bin.i);
        return Math.min(d, SECT - d) >= 2;
      });
      if (farEnough) picked.push(bin);
      if (picked.length === want) break;
    }
    if (picked.length < MIN_STOPS) return null;
    picked.sort((a, b) => a.i - b.i);
    return picked.map(bin => {
      const [h, s, l] = rgbToHsl(bin.r / bin.w, bin.g / bin.w, bin.b / bin.w);
      // подтягиваем к «приятному» диапазону: фон может быть блеклым или слишком тёмным
      return hslToHex(h, Math.max(s, 60), Math.min(Math.max(l, 48), 62));
    });
  }

  // ---------- сборка CSS ----------
  // Возвращает значения для CSS-переменных. Анимация вынесена в @keyframes
  // из gradient.css, здесь только строка `animation` и параметры.
  function buildCss(rawConfig, opts) {
    const cfg = sanitizeConfig(rawConfig);
    const relativeColor = !opts || opts.relativeColor !== false;

    // «Вращение» осмысленно только для линейного и конического градиентов;
    // у радиального оно превращается в перелив.
    let anim = cfg.animation;
    if (anim === 'rotate' && cfg.type === 'radial') anim = 'flow';
    if (anim === 'spectrum' && !relativeColor) anim = 'flow';

    const stopCss = hex => (anim === 'spectrum'
      ? `hsl(from ${hex} calc(h + var(--grad-hue)) s l)`
      : hex);
    const list = cfg.stops.map(stopCss);

    let image;
    if (cfg.type === 'radial') {
      image = `radial-gradient(circle at 30% 30%, ${list.join(', ')})`;
    } else if (cfg.type === 'conic') {
      image = `conic-gradient(from calc(${cfg.angle}deg + var(--grad-rot)) at 50% 50%, ${list.concat(list[0]).join(', ')})`;
    } else {
      const angleExpr = anim === 'rotate' ? `calc(${cfg.angle}deg + var(--grad-rot))` : `${cfg.angle}deg`;
      image = `linear-gradient(${angleExpr}, ${list.join(', ')})`;
    }

    const dur = Math.round((36 / cfg.speed) * 10) / 10;
    const animations = {
      none: 'none',
      shimmer: 'none',
      flow: `pfc-grad-flow ${dur}s ease-in-out infinite alternate`,
      rotate: `pfc-grad-rot ${dur}s linear infinite`,
      spectrum: `pfc-grad-hue ${Math.round(dur * 15) / 10}s linear infinite`,
      pulse: `pfc-grad-pulse ${Math.max(0.6, Math.round((dur / 4) * 10) / 10)}s ease-in-out infinite alternate`
    };

    const mid = average(cfg.stops);
    return {
      config: cfg,
      effectiveAnimation: anim,
      image,
      anim: animations[anim],
      size: anim === 'flow' ? '300% 300%' : '100% 100%',
      shimmerDur: Math.max(0.8, Math.round((dur / 2.5) * 10) / 10),
      // базовая длительность цикла (нужна «пульсу» фона) и доля фона темы поверх градиента
      dur,
      bgVeil: 100 - cfg.bgStrength,
      // решение для обычных "одноцветных" мест интерфейса (рамки, текст, тумблеры)
      accent: mid,
      accentHi: lighten(mid, 40),
      accentDim: mix('#000000', mid, 0.55),
      accentText: luminance(mid) > 0.5 ? '#0d0d0a' : '#ffffff',
      // статичный предпросмотр для плашки-переключателя в настройках
      swatch: `linear-gradient(135deg, ${cfg.stops.join(', ')})`
    };
  }

  // ---------- код «поделиться» ----------
  const SHARE_PREFIX = 'PFC1:';

  function encodeShare(cfg) {
    const json = JSON.stringify(sanitizeConfig(cfg));
    const b64 = typeof Buffer !== 'undefined'
      ? Buffer.from(json, 'utf8').toString('base64')
      : btoa(unescape(encodeURIComponent(json)));
    return SHARE_PREFIX + b64;
  }

  function decodeShare(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith(SHARE_PREFIX)) throw new Error('Код должен начинаться с PFC1:');
    const b64 = raw.slice(SHARE_PREFIX.length).replace(/\s+/g, '');
    let json;
    try {
      json = typeof Buffer !== 'undefined'
        ? Buffer.from(b64, 'base64').toString('utf8')
        : decodeURIComponent(escape(atob(b64)));
      const parsed = JSON.parse(json);
      if (!parsed || !Array.isArray(parsed.stops)) throw new Error('bad');
      return sanitizeConfig(parsed);
    } catch (e) {
      throw new Error('Не получилось прочитать код');
    }
  }

  return {
    ANIMATIONS, TYPES, TARGET_KEYS, MIN_STOPS, MAX_STOPS, PRESETS, DEFAULT_CONFIG,
    cloneDefault, sanitizeConfig, sanitizeAccent, buildCss, randomConfig, extractPalette,
    encodeShare, decodeShare,
    color: { hexToRgb, rgbToHex, mix, lighten, luminance, average, hslToHex }
  };
});
