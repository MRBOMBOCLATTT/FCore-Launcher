// electron-builder --publish сам собирает и заливает exe в GitHub Releases,
// но описание релиза при этом остаётся пустым (releaseInfo из его конфига
// ненадёжно работает именно с GitHub — известная проблема самого electron-builder).
// Поэтому просто дописываем body уже созданному релизу отдельным вызовом API,
// текст берём из src/changelog.js по версии из package.json.
const fetch = require('node-fetch');
const { CHANGELOG } = require('../src/changelog');
const pkg = require('../package.json');

const OWNER = pkg.build.publish.owner;
const REPO = pkg.build.publish.repo;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

function formatReleaseNotes(version) {
  const entry = CHANGELOG.find(c => c.version === version);
  if (!entry) return null;

  const title = `# FCore Launcher ${version}`;
  const sections = [];

  if (entry.added && entry.added.length) {
    sections.push(`### Новое:\n\n${entry.added.map(line => `* ${line}`).join('\n')}`);
  }
  if (entry.fixed && entry.fixed.length) {
    sections.push(`### Исправление:\n\n${entry.fixed.map(line => `* ${line}`).join('\n')}`);
  }

  // Старые записи без added/fixed — совместимость со старым форматом
  if (!sections.length && entry.changes && entry.changes.length) {
    sections.push(entry.changes.map(line => `* ${line}`).join('\n'));
  }

  if (!sections.length) return null;

  return `${title}\n\n${sections.join('\n\n')}`;
}

async function main() {
  if (!TOKEN) {
    console.error('Нет GH_TOKEN в переменных окружения — описание релиза не обновлено');
    process.exit(1);
  }

  const version = pkg.version;
  const notes = formatReleaseNotes(version);
  if (!notes) {
    console.warn(`В changelog.js нет записи для версии ${version} — добавь её перед публикацией, если хочешь описание в релизе`);
    return;
  }

  const headers = {
    Authorization: `token ${TOKEN}`,
    'User-Agent': 'pfc-launcher-publish-script',
    Accept: 'application/vnd.github+json'
  };

  const tag = `v${version}`;
  const releaseRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`, { headers });
  if (!releaseRes.ok) {
    const errBody = await releaseRes.text();
    console.error(`Релиз ${tag} не найден на GitHub (${releaseRes.status}) — сначала должен отработать electron-builder --publish`);
    console.error(errBody);
    process.exit(1);
  }
  const release = await releaseRes.json();
  console.log(`Найден релиз id=${release.id} draft=${release.draft} tag_name=${release.tag_name}`);

  const patchRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: notes })
  });

  if (!patchRes.ok) {
    const errBody = await patchRes.text();
    console.error(`Не удалось обновить описание релиза (${patchRes.status})`);
    console.error(errBody);
    process.exit(1);
  }

  console.log(`Описание релиза ${tag} обновлено`);
}

main().catch(err => {
  console.error('Ошибка при обновлении описания релиза:', err.message);
  process.exit(1);
});