const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/appearanceConfig');

test('пустой конфиг равен значениям по умолчанию и не даёт CSS', () => {
  assert.ok(A.isDefault({}));
  assert.ok(A.isDefault(null));
  assert.equal(A.buildCss({}), '');
});

test('sanitize отбрасывает мусор и ограничивает числа', () => {
  const c = A.sanitizeConfig({
    colors: { accent: 'red', bg: '#ABCDEF', panel: 'url(x)' },
    radius: 999,
    uiScale: 10,
    sidebarPosition: 'top',
    font: 'custom',
    fontCustom: "Evil'; } body { display:none"
  });
  assert.equal(c.colors.accent, null);
  assert.equal(c.colors.bg, '#abcdef');
  assert.equal(c.colors.panel, null);
  assert.equal(c.radius, 28);
  assert.equal(c.uiScale, 80);
  assert.equal(c.sidebarPosition, 'left');
  assert.ok(!/[';{}]/.test(c.fontCustom));
});

test('свой шрифт без названия откатывается на стандартный', () => {
  assert.equal(A.sanitizeConfig({ font: 'custom', fontCustom: '  ' }).font, 'default');
});

test('buildCss выставляет только изменённое', () => {
  const css = A.buildCss({ colors: { accent: '#ff0000' }, radius: 0 });
  assert.match(css, /--accent: #ff0000 !important/);
  assert.match(css, /--radius: 0px !important/);
  assert.match(css, /--r-scale: 0\.000/);
  assert.doesNotMatch(css, /--bg:/);
  assert.doesNotMatch(css, /--sidebar-w/);
});

test('светлый акцент получает тёмный текст кнопок', () => {
  assert.match(A.buildCss({ colors: { accent: '#ffd400' } }), /--accent-text: #0d0d0a/);
  assert.match(A.buildCss({ colors: { accent: '#202080' } }), /--accent-text: #ffffff/);
});

test('картинка фона попадает в CSS только когда передан адрес', () => {
  assert.doesNotMatch(A.buildCss({ bgImage: '/a.png' }), /fcBgLayer/);
  assert.match(A.buildCss({ bgImage: '/a.png' }, 'file:///a.png'), /url\("file:\/\/\/a\.png"\)/);
});

test('встроенные пресеты валидны и не содержат картинки', () => {
  const ids = new Set();
  A.PRESETS.forEach(p => {
    assert.ok(!ids.has(p.id));
    ids.add(p.id);
    assert.equal(p.config.bgImage, null);
    assert.deepEqual(A.sanitizeConfig(p.config), p.config);
  });
});

test('код для обмена: туда-обратно, без картинки, мусор отклоняется', () => {
  const src = { name: 'Мой пресет', mode: 'light', config: { colors: { accent: '#123456' }, radius: 4, bgImage: '/secret/path.png' } };
  const back = A.decodeShare(A.encodeShare(src));
  assert.equal(back.name, 'Мой пресет');
  assert.equal(back.mode, 'light');
  assert.equal(back.config.colors.accent, '#123456');
  assert.equal(back.config.radius, 4);
  assert.equal(back.config.bgImage, null);
  assert.equal(A.decodeShare('hello'), null);
  assert.equal(A.decodeShare('FCAP1:!!!'), null);
});

test('прозрачность панелей строится от цвета темы и не использует backdrop-filter', () => {
  const base = { panel: '#101010', panel2: '#202020' };
  const css = A.buildCss({ panelOpacity: 60, sidebarOpacity: 70 }, '', base);
  assert.match(css, /--panel: color-mix\(in srgb, #101010 60%, transparent\) !important/);
  assert.match(css, /--panel-2: color-mix\(in srgb, #202020 60%, transparent\) !important/);
  assert.doesNotMatch(css, /backdrop-filter/);
  const own = A.buildCss({ panelOpacity: 50, colors: { panel: '#abcdef' } }, '', base);
  assert.equal(own.match(/--panel:/g).length, 1);
  assert.match(own, /#abcdef 50%/);
});


test('локальные пресеты сохраняют файл шрифта, а код обмена не содержит локальную ссылку', () => {
  const config = { font: 'custom', fontCustom: 'FCore Custom', fontCustomFile: 'fcore-custom-123.woff2' };
  const local = A.sanitizePreset({ name: 'Custom font', config });
  assert.equal(local.config.fontCustomFile, 'fcore-custom-123.woff2');
  const code = A.encodeShare({ name: 'Custom font', config });
  const shared = A.decodeShare(code);
  assert.equal(shared.config.fontCustomFile, null);
});

test('локальный файл шрифта сохраняется безопасным именем и подключается через font-face', () => {
  const c = A.sanitizeConfig({ font: 'custom', fontCustom: 'FCore Display', fontCustomFile: 'fcore-custom.woff2' });
  assert.equal(c.fontCustomFile, 'fcore-custom.woff2');
  const css = A.buildCss(c, '', null, 'file:///C:/Users/Test/AppData/fcore-custom.woff2');
  assert.match(css, /@font-face/);
  assert.match(css, /format\('woff2'\)/);
  assert.match(css, /--body: 'FCore Display', system-ui, sans-serif !important/);
  assert.equal(A.sanitizeConfig({ font: 'custom', fontCustom: 'FCore', fontCustomFile: '../escape.ttf' }).fontCustomFile, null);
  assert.equal(A.withoutImage(c).fontCustomFile, 'fcore-custom.woff2');
});
