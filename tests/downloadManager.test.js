const test = require('node:test');
const assert = require('node:assert/strict');
const { DownloadManager } = require('../src/downloadManager');
const { getDownloadContext } = require('../src/downloadTaskContext');

test('Download Manager tracks task progress and completion', async () => {
  const manager = new DownloadManager();
  await manager.run({ type: 'mods', title: 'Test mod', totalFiles: 1 }, async () => {
    const context = getDownloadContext();
    context.reportFileProgress({ filePath: '/mods/example.jar', fileName: 'example.jar', downloaded: 45, total: 100 });
    context.reportFileComplete({ filePath: '/mods/example.jar', fileName: 'example.jar', bytes: 100 });
    return { ok: true };
  });

  const task = manager.list().tasks[0];
  assert.equal(task.title, 'Test mod');
  assert.equal(task.status, 'completed');
  assert.equal(task.percent, 100);
  assert.equal(task.totalBytes, 100);
});

test('Download Manager cancels an active cancellable task', async () => {
  const manager = new DownloadManager();
  const pending = manager.run({ type: 'mods', title: 'Cancelable task' }, async () => {
    const signal = getDownloadContext().signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  const id = manager.list().tasks[0].id;
  assert.equal(manager.cancel(id), true);
  await assert.rejects(pending, { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(manager.list().tasks[0].status, 'cancelled');
});

test('Download Manager retries a failed task as a new task', async () => {
  const manager = new DownloadManager();
  let attempts = 0;
  await assert.rejects(manager.run(
    { type: 'resourcepacks', title: 'Retry me' },
    async () => { attempts++; throw new Error('network down'); },
    async () => { attempts++; return { ok: true }; }
  ), /network down/);

  const failedTask = manager.list().tasks[0];
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.canRetry, true);
  const result = await manager.retry(failedTask.id);
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(manager.list().tasks[0].status, 'completed');
});

test('Download Manager clears terminal history without removing active tasks', async () => {
  const manager = new DownloadManager();
  await manager.run({ title: 'Done' }, async () => true);
  const pending = manager.run({ title: 'Running' }, async () => new Promise(resolve => setTimeout(resolve, 30)));
  const activeId = manager.list().tasks[0].id;
  manager.clearHistory();
  assert.deepEqual(manager.list().tasks.map(task => task.id), [activeId]);
  await pending;
});

test('Download Manager persists completed history and marks interrupted tasks after restart', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcore-download-history-'));
  const historyFile = path.join(tempDir, 'download-history.json');
  try {
    const first = new DownloadManager({ historyFile });
    await first.run({ type: 'mods', title: 'Completed task' }, async () => ({ ok: true }));
    const pending = first.run({ type: 'java', title: 'Interrupted task' }, async () => {
      const signal = getDownloadContext().signal;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true }));
    });
    first.flush();
    const second = new DownloadManager({ historyFile });
    const tasks = second.list().tasks;
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].title, 'Interrupted task');
    assert.equal(tasks[0].status, 'failed');
    assert.match(tasks[0].error, /прервана при закрытии/i);
    assert.equal(tasks[0].canRetry, false);
    assert.equal(tasks[1].status, 'completed');
    first.cancel(first.list().tasks.find(task => task.title === 'Interrupted task').id);
    await pending.catch(() => {});
    first.flush();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('Download Manager treats dismissed file picker as cancelled', async () => {
  const manager = new DownloadManager();
  await manager.run({ title: 'Import modpack', cancelOnNull: true }, async () => null);
  assert.equal(manager.list().tasks[0].status, 'cancelled');
});

test('Download Manager retry reports an operation-level failure', async () => {
  const manager = new DownloadManager();
  await assert.rejects(manager.run({ title: 'Import', retryable: true }, async () => { throw new Error('initial failure'); }, async () => ({ ok: false, error: 'still failing' })), /initial failure/);
  const task = manager.list().tasks[0];
  const result = await manager.retry(task.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /still failing/);
  assert.equal(manager.list().tasks[0].status, 'failed');
});

test('Download Manager exposes queued files and file counters', async () => {
  const manager = new DownloadManager();
  let release;
  let signalReady;
  const ready = new Promise(resolve => { signalReady = resolve; });
  const pending = manager.run({ type: 'build', title: 'Modpack import' }, async () => {
    getDownloadContext().reportTaskProgress({
      stage: 'downloading', totalFiles: 3, completedFiles: 1,
      queuedFiles: ['b.jar', 'c.jar'], currentFile: 'a.jar'
    });
    signalReady();
    await new Promise(resolve => { release = resolve; });
    return { ok: true };
  });
  await ready;
  const task = manager.list().tasks[0];
  assert.equal(task.totalFiles, 3);
  assert.equal(task.completedFiles, 1);
  assert.deepEqual(task.queuedFiles, ['b.jar', 'c.jar']);
  release();
  await pending;
});
