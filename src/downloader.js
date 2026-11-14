const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { getDownloadContext } = require('./downloadTaskContext');

function makeCancelledError() {
  const error = new Error('Загрузка отменена');
  error.code = 'DOWNLOAD_CANCELLED';
  return error;
}

function getTaskSignal() {
  return getDownloadContext()?.signal || null;
}

function throwIfCancelled(signal = getTaskSignal()) {
  if (signal?.aborted) throw makeCancelledError();
}

function bindAbortSignal(controller, parentSignal) {
  if (!parentSignal) return () => {};
  const abort = () => controller.abort();
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  return () => parentSignal.removeEventListener('abort', abort);
}

function reportFileProgress(filePath, downloaded, total, reset = false) {
  const context = getDownloadContext();
  context?.reportFileProgress?.({
    reset,
    filePath,
    fileName: path.basename(filePath),
    downloaded: Number(downloaded) || 0,
    total: Number(total) || 0
  });
}

function reportFileComplete(filePath, bytes) {
  const context = getDownloadContext();
  context?.reportFileComplete?.({ filePath, fileName: path.basename(filePath), bytes: Number(bytes) || 0 });
}

// Обычный fetch() без сигнала может зависнуть навсегда, если сервер не отвечает.
// В контексте Download Manager запрос также прерывается по команде пользователя.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const parentSignal = options.signal || getTaskSignal();
  const removeAbortListener = bindAbortSignal(controller, parentSignal);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    throwIfCancelled(parentSignal);
    const requestOptions = { ...options, signal: controller.signal };
    return await fetch(url, requestOptions);
  } catch (err) {
    if (parentSignal?.aborted) throw makeCancelledError();
    if (err.name === 'AbortError') {
      throw new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)}с: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

async function getFreeSpaceBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stat = await fs.promises.statfs(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

async function ensureFreeSpace(dir, minBytes, label = 'файлов') {
  const free = await getFreeSpaceBytes(dir);
  if (free === null) return;
  if (free < minBytes) {
    const freeMb = Math.round(free / 1024 / 1024);
    const needMb = Math.round(minBytes / 1024 / 1024);
    throw new Error(`Недостаточно места на диске для загрузки ${label}: свободно ${freeMb} МБ, нужно примерно ${needMb} МБ.`);
  }
}

// Качает потоково во временный файл и атомарно переименовывает по завершении.
// Сигнал Download Manager прерывает запрос, очищает временный файл и не запускает retry.
async function downloadFileWithRetry(url, dest, { retries = 3, onRetry = () => {}, onProgress = () => {}, stallTimeoutMs = 20000 } = {}) {
  let lastError;
  const parentSignal = getTaskSignal();

  for (let attempt = 1; attempt <= retries; attempt++) {
    throwIfCancelled(parentSignal);
    if (attempt > 1) reportFileProgress(dest, 0, 0, true);
    const tmpDest = `${dest}.tmp-${process.pid}-${Date.now()}`;
    const controller = new AbortController();
    const removeAbortListener = bindAbortSignal(controller, parentSignal);
    let stallTimer = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
    };

    try {
      resetStallTimer();
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

      const total = Number(res.headers.get('content-length')) || 0;
      let downloaded = 0;
      let lastReported = 0;
      res.body.on('data', chunk => {
        downloaded += chunk.length;
        resetStallTimer();
        const now = Date.now();
        if (now - lastReported > 100) {
          lastReported = now;
          onProgress({ downloaded, total });
          reportFileProgress(dest, downloaded, total);
        }
      });

      await pipeline(res.body, fs.createWriteStream(tmpDest));
      clearTimeout(stallTimer);
      throwIfCancelled(parentSignal);

      const { size } = fs.statSync(tmpDest);
      fs.renameSync(tmpDest, dest);
      reportFileComplete(dest, size);
      return { bytes: size };
    } catch (err) {
      clearTimeout(stallTimer);
      if (parentSignal?.aborted || err?.code === 'DOWNLOAD_CANCELLED') {
        lastError = makeCancelledError();
        try { if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest); } catch {}
        throw lastError;
      }
      lastError = err.name === 'AbortError' ? new Error(`Загрузка зависла и была прервана: ${url}`) : err;
      try { if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest); } catch {}
      if (attempt < retries) {
        onRetry({ url, attempt, retries, error: lastError.message });
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    } finally {
      clearTimeout(stallTimer);
      removeAbortListener();
    }
  }

  throw new Error(`Не удалось скачать ${url} за ${retries} попыт${retries === 1 ? 'ку' : 'ки'}: ${lastError.message}`);
}

async function downloadFileMultiPart(url, dest, { parts = 6, onProgress = () => {}, stallTimeoutMs = 20000 } = {}) {
  const parentSignal = getTaskSignal();
  throwIfCancelled(parentSignal);
  const headRes = await fetchWithTimeout(url, { method: 'HEAD' }, stallTimeoutMs);
  if (!headRes.ok) throw new Error(`${headRes.status} ${headRes.statusText}`);

  const total = Number(headRes.headers.get('content-length')) || 0;
  const acceptsRanges = headRes.headers.get('accept-ranges') === 'bytes';

  if (!acceptsRanges || !total || total < 8 * 1024 * 1024) {
    return downloadFileWithRetry(url, dest, { onProgress });
  }

  const tmpDest = `${dest}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpDest, 'w');
  fs.ftruncateSync(fd, total);
  fs.closeSync(fd);

  const chunkSize = Math.ceil(total / parts);
  let downloaded = 0;
  let lastReported = 0;
  const ranges = [];
  for (let i = 0; i < parts; i++) {
    const start = i * chunkSize;
    if (start >= total) break;
    const end = Math.min(start + chunkSize, total) - 1;
    ranges.push({ start, end });
  }

  try {
    await runWithConcurrency(ranges, async ({ start, end }) => {
      throwIfCancelled(parentSignal);
      const controller = new AbortController();
      const removeAbortListener = bindAbortSignal(controller, parentSignal);
      let stallTimer = null;
      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
      };

      try {
        resetStallTimer();
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
        if (!res.ok && res.status !== 206) throw new Error(`${res.status} ${res.statusText}`);

        const writeStream = fs.createWriteStream(tmpDest, { flags: 'r+', start });
        res.body.on('data', chunk => {
          downloaded += chunk.length;
          resetStallTimer();
          const now = Date.now();
          if (now - lastReported > 100) {
            lastReported = now;
            onProgress({ downloaded, total });
            reportFileProgress(dest, downloaded, total);
          }
        });
        await pipeline(res.body, writeStream);
      } finally {
        clearTimeout(stallTimer);
        removeAbortListener();
      }
    }, ranges.length);
  } catch (err) {
    try { fs.unlinkSync(tmpDest); } catch {}
    if (parentSignal?.aborted || err?.code === 'DOWNLOAD_CANCELLED') throw makeCancelledError();
    return downloadFileWithRetry(url, dest, { onProgress });
  }

  throwIfCancelled(parentSignal);
  fs.renameSync(tmpDest, dest);
  reportFileComplete(dest, total);
  return { bytes: total };
}

async function runWithConcurrency(items, worker, concurrency = 6) {
  const queue = [...items];
  const results = [];
  const parentSignal = getTaskSignal();

  async function runOne() {
    while (queue.length) {
      throwIfCancelled(parentSignal);
      const item = queue.shift();
      results.push(await worker(item));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

module.exports = { downloadFileWithRetry, downloadFileMultiPart, runWithConcurrency, getFreeSpaceBytes, ensureFreeSpace, fetchWithTimeout };
