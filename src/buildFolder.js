// Имя папки сборки в instances: из названия сборки, но безопасное для Windows и для Java.
// Кириллица переводится в латиницу, потому что Java на части систем плохо работает с русскими путями.

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g'
};

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const LOADER_SUFFIX = /-(fabric|forge|neoforge|quilt|vanilla)$/i;
const MAX_LENGTH = 40;

function transliterate(text) {
  let out = '';
  for (const ch of String(text)) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TRANSLIT, lower)) {
      const latin = TRANSLIT[lower];
      out += ch !== lower ? latin.charAt(0).toUpperCase() + latin.slice(1) : latin;
    } else {
      out += ch;
    }
  }
  return out;
}

function slugify(name) {
  let slug = transliterate(String(name || ''))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ._()-]+/g, '_')
    .replace(/[ _]{2,}/g, ' ')
    .replace(/^[ ._-]+|[ ._-]+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/^[ ._-]+|[ ._-]+$/g, '');
  if (!slug) slug = 'build';
  if (RESERVED.test(slug)) slug += '_';
  if (LOADER_SUFFIX.test(slug)) slug += '_';
  return slug;
}

function dirOf(build) {
  return (build && build.folder) || `build-${build.id}`;
}

// выбирает имя, которого нет среди занятых (без учёта регистра: в Windows папки не различают регистр)
function pickFolder(name, taken, exists = () => false) {
  const used = new Set([...taken].map(item => String(item).toLowerCase()));
  const base = slugify(name);
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()) || exists(candidate); n++) {
    candidate = `${base} ${n}`;
  }
  return candidate;
}

// переименовывает папку сборки под её текущее имя; возвращает новое имя папки или null, если менять нечего
function renameToMatch(build, instancesRoot, taken, fsImpl = require('fs')) {
  const path = require('path');
  const current = dirOf(build);
  const wanted = pickFolder(build.name, taken, name => name.toLowerCase() !== current.toLowerCase() && fsImpl.existsSync(path.join(instancesRoot, name)));
  if (wanted === current) return null;
  const from = path.join(instancesRoot, current);
  if (fsImpl.existsSync(from)) fsImpl.renameSync(from, path.join(instancesRoot, wanted));
  return wanted;
}

module.exports = { renameToMatch, slugify, dirOf, pickFolder, transliterate };
