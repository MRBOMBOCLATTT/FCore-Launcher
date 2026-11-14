const yauzl = require('yauzl');
const yazl = require('yazl');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// Общий модуль для работы с zip без разворачивания всего архива в памяти —
// раньше adm-zip читал/писал архивы целиком одним буфером, что на крупных
// сборках (сотни МБ-гигабайт модов и ресурспаков) давало заметный всплеск RAM
// при каждом экспорте/импорте/бэкапе/снимке сборки. yauzl/yazl работают потоково:
// файлы читаются и пишутся кусками, в памяти в любой момент только текущий чанк.

// --- чтение ---

// Проходит по всем файлам (не папкам) архива по одному за раз (lazyEntries) и
// вызывает handler(entryName, openStream) для каждого. openStream() — функция,
// возвращающая Promise<Readable> с содержимым именно этой записи — вызывать
// только если содержимое реально нужно, иначе запись просто пропускается
async function iterateZipEntries(zipPath, handler) {
  const zipfile = await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => (err ? reject(err) : resolve(zf)));
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      reject(err);
    };

    zipfile.on('error', fail);
    zipfile.on('end', () => { if (!settled) { settled = true; resolve(); } });

    zipfile.on('entry', entry => {
      if (/\/$/.test(entry.fileName)) {
        zipfile.readEntry();
        return;
      }

      const openStream = () => new Promise((res, rej) => {
        zipfile.openReadStream(entry, (err, stream) => (err ? rej(err) : res(stream)));
      });

      Promise.resolve(handler(entry.fileName, openStream))
        .then(() => zipfile.readEntry())
        .catch(fail);
    });

    zipfile.readEntry();
  });
}

// Читает содержимое записи в память как буфер — только для маленьких файлов
// вроде manifest.json, где это оправдано и не влияет на общее потребление памяти
async function readEntryToBuffer(stream, maxBytes = Infinity) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Содержимое ZIP-записи превышает допустимый размер');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

// Пишет содержимое записи потоком прямо в файл на диске — для jar/zip модов
// и ресурспаков, которые могут быть от пары МБ до сотен МБ каждый
async function extractEntryToFile(stream, destPath) {
  await pipeline(stream, fs.createWriteStream(destPath));
}

// Разворачивает весь архив в папку на диске, сохраняя структуру каталогов —
// используется вместо `powershell Expand-Archive` при установке JDK: у
// PowerShell там ощутимый оверхед на старт процесса и на сам Expand-Archive,
// а yauzl помимо этого ещё и не тащит содержимое файлов в память целиком.
async function extractZipToDir(zipPath, destDir) {
  await iterateZipEntries(zipPath, async (entryName, openStream) => {
    const destPath = path.join(destDir, entryName);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const stream = await openStream();
    await extractEntryToFile(stream, destPath);
  });
}

// --- запись ---

function createZip() {
  return new yazl.ZipFile();
}

// yazl сам стримит файл с диска через fs.createReadStream — не грузит его в
// память целиком, в отличие от adm-zip'овского addLocalFile/addLocalFolder
function addFile(zipfile, diskPath, zipEntryPath) {
  zipfile.addFile(diskPath, zipEntryPath);
}

function addBuffer(zipfile, buffer, zipEntryPath) {
  zipfile.addBuffer(buffer, zipEntryPath);
}

// Рекурсивно добавляет содержимое папки в архив (замена addLocalFolder)
function addFolder(zipfile, diskDir, zipBasePath) {
  if (!fs.existsSync(diskDir)) return;
  for (const name of fs.readdirSync(diskDir)) {
    const diskPath = path.join(diskDir, name);
    const zipEntryPath = `${zipBasePath}/${name}`;
    if (fs.statSync(diskPath).isDirectory()) {
      addFolder(zipfile, diskPath, zipEntryPath);
    } else {
      zipfile.addFile(diskPath, zipEntryPath);
    }
  }
}

// Финализирует архив и потоково пишет его в destPath
async function finalizeZip(zipfile, destPath) {
  zipfile.end();
  await pipeline(zipfile.outputStream, fs.createWriteStream(destPath));
}

module.exports = {
  iterateZipEntries,
  readEntryToBuffer,
  extractEntryToFile,
  extractZipToDir,
  createZip,
  addFile,
  addBuffer,
  addFolder,
  finalizeZip
};
