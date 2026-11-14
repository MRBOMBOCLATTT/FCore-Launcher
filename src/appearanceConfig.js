(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PFCAppearance = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEX = /^#[0-9a-f]{6}$/i;
  const COLOR_KEYS = ['accent', 'bg', 'bg2', 'panel', 'panel2', 'border', 'text', 'textDim'];
  const FONTS = ['default', 'system', 'mono', 'serif', 'custom'];
  const SIDEBAR_POSITIONS = ['left', 'right'];
  const SIDEBAR_STYLES = ['full', 'compact'];
  const CODE_PREFIX = 'FCAP1:';

  const FONT_STACKS = {
    system: "system-ui, 'Segoe UI', Roboto, sans-serif",
    mono: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    serif: "Georgia, 'Times New Roman', serif"
  };

  const DEFAULT_CONFIG = Object.freeze({
    colors: Object.freeze({
      accent: null, bg: null, bg2: null, panel: null, panel2: null, border: null, text: null, textDim: null
    }),
    radius: 10,
    uiScale: 100,
    sidebarWidth: 236,
    sidebarPosition: 'left',
    sidebarStyle: 'full',
    sidebarOpacity: 100,
    panelOpacity: 100,
    font: 'default',
    fontCustom: '',
    fontCustomFile: null,
    bgImage: null,
    bgDim: 55,
    bgBlur: 0,
    reduceMotion: false
  });

  const clampInt = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  function cloneDefault() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  function sanitizeFontName(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[^\p{L}\p{N} \-_.]/gu, '').trim().slice(0, 40);
  }

  function sanitizeConfig(input) {
    const src = input && typeof input === 'object' ? input : {};
    const srcColors = src.colors && typeof src.colors === 'object' ? src.colors : {};
    const colors = {};
    COLOR_KEYS.forEach(k => {
      const v = srcColors[k];
      colors[k] = typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null;
    });

    const font = FONTS.includes(src.font) ? src.font : DEFAULT_CONFIG.font;
    const fontCustom = sanitizeFontName(src.fontCustom);
    const fontCustomFile = typeof src.fontCustomFile === 'string' && /^[a-z0-9_-]{1,48}\.(?:woff2?|ttf|otf)$/i.test(src.fontCustomFile) ? src.fontCustomFile : null;

    return {
      colors,
      radius: clampInt(src.radius, 0, 28, DEFAULT_CONFIG.radius),
      uiScale: clampInt(src.uiScale, 80, 130, DEFAULT_CONFIG.uiScale),
      sidebarWidth: clampInt(src.sidebarWidth, 200, 320, DEFAULT_CONFIG.sidebarWidth),
      sidebarPosition: SIDEBAR_POSITIONS.includes(src.sidebarPosition) ? src.sidebarPosition : DEFAULT_CONFIG.sidebarPosition,
      sidebarStyle: SIDEBAR_STYLES.includes(src.sidebarStyle) ? src.sidebarStyle : DEFAULT_CONFIG.sidebarStyle,
      sidebarOpacity: clampInt(src.sidebarOpacity, 30, 100, DEFAULT_CONFIG.sidebarOpacity),
      panelOpacity: clampInt(src.panelOpacity, 30, 100, DEFAULT_CONFIG.panelOpacity),
      font: font === 'custom' && !fontCustom ? 'default' : font,
      fontCustom,
      fontCustomFile,
      bgImage: typeof src.bgImage === 'string' && src.bgImage.length > 0 && src.bgImage.length < 1024 ? src.bgImage : null,
      bgDim: clampInt(src.bgDim, 0, 90, DEFAULT_CONFIG.bgDim),
      bgBlur: clampInt(src.bgBlur, 0, 30, DEFAULT_CONFIG.bgBlur),
      reduceMotion: src.reduceMotion === true
    };
  }

  function withoutImage(config) {
    const clean = sanitizeConfig(config);
    clean.bgImage = null;
    return clean;
  }

  function sanitizePreset(input) {
    if (!input || typeof input !== 'object') return null;
    const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim().slice(0, 32) : '';
    if (!name) return null;
    const id = typeof input.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(input.id) ? input.id : null;
    return {
      id,
      name,
      mode: input.mode === 'light' || input.mode === 'dark' ? input.mode : null,
      config: withoutImage(input.config)
    };
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    const c = v => Math.min(255, Math.max(0, Math.round(v)));
    return '#' + ((1 << 24) + (c(r) << 16) + (c(g) << 8) + c(b)).toString(16).slice(1);
  }

  function mix(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
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

  function fontStack(cfg) {
    if (cfg.font === 'custom' && cfg.fontCustom) return `'${cfg.fontCustom}', system-ui, sans-serif`;
    return FONT_STACKS[cfg.font] || null;
  }

  function colorVars(colors) {
    const vars = [];
    const add = (name, value) => { if (value) vars.push([name, value]); };
    const c = colors;

    if (c.accent) {
      add('--accent', c.accent);
      add('--accent-hi', lighten(c.accent, 40));
      add('--accent-dim', mix('#000000', c.accent, 0.55));
      add('--accent-text', luminance(c.accent) > 0.4 ? '#0d0d0a' : '#ffffff');
    }
    add('--bg', c.bg);
    add('--bg-2', c.bg2);
    add('--panel', c.panel);
    add('--panel-2', c.panel2);
    if (c.border) {
      add('--border', c.border);
      add('--border-hi', mix(c.border, luminance(c.border) > 0.4 ? '#000000' : '#ffffff', 0.14));
    }
    add('--text', c.text);
    if (c.textDim) {
      add('--text-dim', c.textDim);
      const floor = c.bg || (luminance(c.textDim) > 0.4 ? '#000000' : '#ffffff');
      add('--text-faint', mix(c.textDim, floor, 0.45));
    }
    return vars;
  }

  function isDefault(config) {
    return JSON.stringify(sanitizeConfig(config)) === JSON.stringify(DEFAULT_CONFIG);
  }

  function buildCss(input, bgUrl, base, fontUrl) {
    const cfg = sanitizeConfig(input);
    const d = DEFAULT_CONFIG;
    const rules = [];
    const vars = colorVars(cfg.colors).map(([k, v]) => `${k}: ${v} !important;`);

    if (cfg.panelOpacity < 100 && base) {
      const alpha = cfg.panelOpacity;
      [['--panel', cfg.colors.panel || base.panel], ['--panel-2', cfg.colors.panel2 || base.panel2]].forEach(([name, hex]) => {
        if (!HEX.test(hex || '')) return;
        const i = vars.findIndex(v => v.startsWith(name + ':'));
        const value = `${name}: color-mix(in srgb, ${hex} ${alpha}%, transparent) !important;`;
        if (i >= 0) vars[i] = value;
        else vars.push(value);
      });
    }

    if (cfg.radius !== d.radius) {
      const r = cfg.radius;
      vars.push(`--radius: ${r}px !important;`);
      vars.push(`--radius-sm: ${Math.round(r * 0.8)}px !important;`);
      vars.push(`--radius-lg: ${Math.round(r * 1.8)}px !important;`);
      vars.push(`--r-scale: ${(r / d.radius).toFixed(3)} !important;`);
    }

    const compact = cfg.sidebarStyle === 'compact';
    if (compact) vars.push('--sidebar-w: 76px !important;');
    else if (cfg.sidebarWidth !== d.sidebarWidth) vars.push(`--sidebar-w: ${cfg.sidebarWidth}px !important;`);

    const stack = fontStack(cfg);
    if (stack) {
      vars.push(`--body: ${stack} !important;`);
      vars.push(`--display: ${stack} !important;`);
    }

    if (cfg.font === 'custom' && cfg.fontCustom && fontUrl) {
      const ext = (cfg.fontCustomFile || '').split('.').pop().toLowerCase();
      const format = ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : ext === 'otf' ? 'opentype' : 'truetype';
      const safeFamily = sanitizeFontName(cfg.fontCustom).replace(/\\/g, '');
      rules.push(`@font-face { font-family: '${safeFamily}'; src: url(${JSON.stringify(fontUrl)}) format('${format}'); font-style: normal; font-weight: 100 900; font-display: swap; }`);
    }

    if (vars.length) rules.push(`body[data-fc-ap] {\n  ${vars.join('\n  ')}\n}`);

    if (cfg.sidebarPosition === 'right') {
      rules.push('body[data-fc-ap] .app-body { flex-direction: row-reverse; }');
      rules.push('body[data-fc-ap] .sidebar { border-right: 0 !important; border-left: 1px solid var(--border); padding-top: calc(var(--titlebar-h) + 8px) !important; }');
    }

    if (cfg.sidebarOpacity < 100) {
      rules.push(`body[data-fc-ap] .sidebar { background: color-mix(in srgb, var(--bg-2) ${cfg.sidebarOpacity}%, transparent) !important; }`);
    }

    if (bgUrl) {
      rules.push(`body[data-fc-ap] #fcBgLayer { display: block; background-image: url("${bgUrl}"); filter: blur(${cfg.bgBlur}px); transform: scale(${cfg.bgBlur > 0 ? 1.08 : 1}); }`);
      rules.push(`body[data-fc-ap] #fcBgLayer::after { opacity: ${(cfg.bgDim / 100).toFixed(2)}; }`);
    }

    if (cfg.reduceMotion) {
      rules.push('body[data-fc-ap] *, body[data-fc-ap] *::before, body[data-fc-ap] *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }');
    }

    return rules.join('\n');
  }

  const PRESETS = [
    {
      id: 'default', name: 'По умолчанию', mode: null,
      config: {}
    },
    {
      id: 'midnight', name: 'Полночь', mode: 'dark',
      config: {
        colors: { accent: '#5b8cff', bg: '#0b0d17', bg2: '#10131f', panel: '#151a2a', panel2: '#1c2236', border: '#262d45', text: '#e8ecff', textDim: '#8d97c4' },
        radius: 12
      }
    },
    {
      id: 'graphite', name: 'Графит', mode: 'dark',
      config: {
        colors: { accent: '#3ecf8e', bg: '#121212', bg2: '#181818', panel: '#1e1e1e', panel2: '#272727', border: '#323232', text: '#ececec', textDim: '#9a9a9a' },
        radius: 8
      }
    },
    {
      id: 'ocean', name: 'Океан', mode: 'dark',
      config: {
        colors: { accent: '#25b8e8', bg: '#07131c', bg2: '#0a1a26', panel: '#0f2433', panel2: '#152e41', border: '#1f425c', text: '#e6f4fb', textDim: '#86b3cc' },
        radius: 14
      }
    },
    {
      id: 'forest', name: 'Лес', mode: 'dark',
      config: {
        colors: { accent: '#5fd38a', bg: '#0c140f', bg2: '#101b14', panel: '#15241a', panel2: '#1b2e21', border: '#25402d', text: '#e9f5ec', textDim: '#8fb59a' },
        radius: 10
      }
    },
    {
      id: 'sunset', name: 'Закат', mode: 'dark',
      config: {
        colors: { accent: '#ff7a59', bg: '#1a0f14', bg2: '#22131a', panel: '#2b1820', panel2: '#361e28', border: '#4a2733', text: '#fbeee9', textDim: '#c79a98' },
        radius: 16
      }
    },
    {
      id: 'cyber', name: 'Киберпанк', mode: 'dark',
      config: {
        colors: { accent: '#ff2bd6', bg: '#07040f', bg2: '#0d0818', panel: '#130b24', panel2: '#1c1036', border: '#35195e', text: '#f3e9ff', textDim: '#a98ad1' },
        radius: 2,
        font: 'mono'
      }
    },
    {
      id: 'contrast', name: 'Контраст', mode: 'dark',
      config: {
        colors: { accent: '#ffd400', bg: '#000000', bg2: '#080808', panel: '#111111', panel2: '#1a1a1a', border: '#6b6b6b', text: '#ffffff', textDim: '#d0d0d0' },
        radius: 4
      }
    },
    {
      id: 'paper', name: 'Бумага', mode: 'light',
      config: {
        colors: { accent: '#3a7bd5', bg: '#f5f3ee', bg2: '#ece9e0', panel: '#fffefb', panel2: '#efece3', border: '#d9d4c5', text: '#26231c', textDim: '#7a7464' },
        radius: 6
      }
    },
    {
      id: 'sakura', name: 'Сакура', mode: 'light',
      config: {
        colors: { accent: '#e0558f', bg: '#fbf3f6', bg2: '#f6e8ee', panel: '#ffffff', panel2: '#f9e9f0', border: '#ecd0dc', text: '#3a2230', textDim: '#8b6577' },
        radius: 18,
        font: 'serif'
      }
    },
    {
      id: 'square', name: 'Квадраты', mode: null,
      config: { radius: 0 }
    }
  ].map(p => ({ id: p.id, name: p.name, mode: p.mode, config: withoutImage(p.config), builtin: true }));

  function encodeShare(preset) {
    const clean = sanitizePreset(preset);
    if (!clean) return '';
    // Share codes cannot carry references to font files stored on one user's PC.
    clean.config.fontCustomFile = null;
    const json = JSON.stringify({ n: clean.name, m: clean.mode, c: clean.config });
    const bytes = typeof Buffer !== 'undefined' ? Buffer.from(json, 'utf-8') : new TextEncoder().encode(json);
    let b64;
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
    else {
      let bin = '';
      bytes.forEach(b => { bin += String.fromCharCode(b); });
      b64 = btoa(bin);
    }
    return CODE_PREFIX + b64;
  }

  function decodeShare(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith(CODE_PREFIX) || trimmed.length > 20000) return null;
    try {
      const b64 = trimmed.slice(CODE_PREFIX.length);
      let json;
      if (typeof Buffer !== 'undefined') json = Buffer.from(b64, 'base64').toString('utf-8');
      else {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        json = new TextDecoder().decode(bytes);
      }
      const data = JSON.parse(json);
      const preset = sanitizePreset({ name: data.n || 'Импортированный', mode: data.m, config: data.c });
      if (preset) preset.config.fontCustomFile = null;
      return preset;
    } catch {
      return null;
    }
  }

  return {
    COLOR_KEYS,
    FONTS,
    DEFAULT_CONFIG,
    PRESETS,
    cloneDefault,
    sanitizeConfig,
    sanitizePreset,
    withoutImage,
    isDefault,
    buildCss,
    encodeShare,
    decodeShare,
    mix,
    luminance
  };
});
