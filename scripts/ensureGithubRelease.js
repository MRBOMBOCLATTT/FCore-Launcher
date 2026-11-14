// electron-builder публикует exe и blockmap двумя параллельными задачами, и
// каждая сама проверяет "есть ли уже релиз с этим тегом" и пытается создать
// его, если нет. Из-за гонки обе иногда стартуют создание одновременно,
// вторая получает 422 already_exists и падает вместе со своей загрузкой.
// Поэтому создаём релиз здесь заранее, одним запросом, до сборки —
// electron-builder увидит уже существующий релиз и просто прицепит файлы.
const fetch = require('node-fetch');
const pkg = require('../package.json');

const OWNER = pkg.build.publish.owner;
const REPO = pkg.build.publish.repo;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

async function main() {
  if (!TOKEN) {
    console.error('Нет GH_TOKEN в переменных окружения — релиз не создан заранее');
    process.exit(1);
  }

  const version = pkg.version;
  const tag = `v${version}`;

  const headers = {
    Authorization: `token ${TOKEN}`,
    'User-Agent': 'pfc-launcher-publish-script',
    Accept: 'application/vnd.github+json'
  };

  const existingRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`, { headers });
  if (existingRes.ok) {
    console.log(`Релиз ${tag} уже существует, ничего не создаю`);
    return;
  }
  if (existingRes.status !== 404) {
    const errBody = await existingRes.text();
    console.error(`Не удалось проверить существование релиза ${tag} (${existingRes.status})`);
    console.error(errBody);
    process.exit(1);
  }

  const createRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      draft: false,
      prerelease: false
    })
  });

  if (!createRes.ok) {
    const errBody = await createRes.text();
    console.error(`Не удалось создать релиз ${tag} (${createRes.status})`);
    console.error(errBody);
    process.exit(1);
  }

  console.log(`Релиз ${tag} создан заранее, electron-builder теперь просто прицепит файлы`);
}

main().catch(err => {
  console.error('Ошибка при создании релиза заранее:', err.message);
  process.exit(1);
});
