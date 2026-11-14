// Локализация интерфейса. Исходные строки в коде и в HTML русские; для английского
// языка текст подменяется «на лету» по словарю из i18n-en.js. Оригинал запоминается,
// а смена языка перезагружает окно, поэтому возвращаться на русский можно без потерь.
(function () {
  const KEY = 'fcore-lang';
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* localStorage недоступен — остаёмся на русском */ }
  const lang = stored === 'en' ? 'en' : 'ru';

  const CYRILLIC = /[А-Яа-яЁё]/;
  const norm = s => s.replace(/\s+/g, ' ').trim();

  const api = {
    lang,
    locale: lang === 'en' ? 'en-US' : 'ru-RU',
    setLanguage(next) {
      try { localStorage.setItem(KEY, next === 'en' ? 'en' : 'ru'); } catch { /* ignore */ }
    },
    t: text => text
  };
  window.i18n = api;
  document.documentElement.lang = lang;
  if (lang !== 'en' || !window.I18N_EN) return;

  const exact = new Map(Object.entries(window.I18N_EN.exact));

  // шаблоны вида "Скачиваю ${name}..." превращаем в регулярки; самые «длинные» проверяем первыми
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ${#} в шаблоне — только число: иначе "${#} модов" цеплялось бы за любую фразу, оканчивающуюся на «модов»
  const templates = window.I18N_EN.templates.map(([ru, en]) => {
    const parts = ru.split(/\$\{[^}]*\}/);
    const exprs = ru.match(/\$\{[^}]*\}/g) || [];
    let source = '';
    parts.forEach((part, i) => {
      source += escapeRe(part);
      if (i < exprs.length) source += exprs[i] === '${#}' ? '(\\d+(?:[.,]\\d+)?)' : '(.*?)';
    });
    return { re: new RegExp(`^${source}$`), en, weight: parts.join('').length };
  }).filter(t => t.weight >= 4) // слишком «короткие» шаблоны совпадали бы с чем попало
    .sort((a, b) => b.weight - a.weight);

  // «Не удалось загрузить статистику: <причина>» — ключи с двоеточием ищем как начало строки
  const prefixes = [...exact.keys()].filter(k => k.endsWith(':')).sort((a, b) => b.length - a.length);

  function translate(text) {
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    const core = norm(text);
    if (!core) return text;

    let out = exact.get(core);
    if (out === undefined) {
      for (const tpl of templates) {
        const m = tpl.re.exec(core);
        if (!m) continue;
        out = tpl.en.replace(/\{(\d+)\}/g, (_, i) => {
          const value = m[Number(i) + 1] ?? '';
          return exact.get(norm(value)) ?? value;
        });
        break;
      }
    }
    if (out === undefined) {
      const prefix = prefixes.find(p => core.startsWith(p));
      if (prefix) out = `${exact.get(prefix)} ${core.slice(prefix.length).trim()}`.trim();
    }
    return out === undefined ? text : lead + out + trail;
  }
  api.t = translate;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  const skipped = el => !el || SKIP_TAGS.has(el.tagName) || !!el.closest?.('[data-no-i18n]');

  function translateText(node) {
    if (skipped(node.parentElement)) return;
    const value = node.nodeValue;
    if (!value || !CYRILLIC.test(value)) return;
    const out = translate(value);
    if (out !== value) node.nodeValue = out;
  }

  function translateAttrs(el) {
    if (skipped(el)) return;
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (!value || !CYRILLIC.test(value)) continue;
      const out = translate(value);
      if (out !== value) el.setAttribute(name, out);
    }
  }

  function translateTree(root) {
    if (root.nodeType === Node.TEXT_NODE) return translateText(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    translateAttrs(root);
    root.querySelectorAll('[placeholder],[title],[aria-label],[alt]').forEach(translateAttrs);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) translateText(node);
  }

  function start() {
    document.title = translate(document.title);
    translateTree(document.body);
    new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'childList') m.addedNodes.forEach(translateTree);
        else if (m.type === 'characterData') translateText(m.target);
        else if (m.type === 'attributes') translateAttrs(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
