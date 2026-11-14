const crypto = require('crypto');
const fs = require('fs');

const CHUNK_SIZE = 1024 * 1024; // 1 МБ

// Читаем файл по кусочкам, а не целиком через readFileSync — для модов (обычно
// пара МБ) разницы почти нет, а вот на крупных ресурспаках (сотни МБ текстур)
// это не даёт лишний раз аллоцировать буфер размером с весь файл только чтобы
// посчитать его хэш и тут же выкинуть
function sha1File(filePath) {
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(CHUNK_SIZE);

  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, null);
      if (bytesRead > 0) hash.update(bytesRead === CHUNK_SIZE ? buffer : buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

// true, если по этому пути уже лежит файл с ожидаемым содержимым
function isAlreadyDownloaded(filePath, expectedSha1) {
  if (!fs.existsSync(filePath)) return false;
  if (!expectedSha1) return true; // хэша нет — доверяем, что имя файла уникально для версии
  try {
    return sha1File(filePath) === expectedSha1;
  } catch {
    return false;
  }
}

module.exports = { sha1File, isAlreadyDownloaded };
