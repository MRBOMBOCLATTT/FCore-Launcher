const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runWithDownloadContext } = require('./downloadTaskContext');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_HISTORY = 60;

const STAGE_LABELS = {
  start: 'Подготовка загрузки',
  checking: 'Проверка файлов',
  downloading: 'Загрузка файлов',
  downloaded: 'Файл загружен',
  retry: 'Повторная попытка',
  'java-check': 'Проверка Java',
  'java-download': 'Загрузка Java',
  'java-extract': 'Распаковка Java',
  'installing-loader': 'Установка загрузчика',
  progress: 'Загрузка файлов Minecraft',
  download: 'Загрузка файлов Minecraft',
  'game-started': 'Minecraft запущен'
};

function safeErrorMessage(error) {
  return String(error?.message || error || 'Неизвестная ошибка').slice(0, 500);
}

class DownloadManager {
  constructor({ onUpdate = () => {}, maxHistory = MAX_HISTORY, historyFile = null } = {}) {
    this.onUpdate = onUpdate;
    this.maxHistory = Math.max(10, Number(maxHistory) || MAX_HISTORY);
    this.historyFile = historyFile ? path.resolve(historyFile) : null;
    this.persistTimer = null;
    this.tasks = new Map();
    this.order = [];
    this._loadHistory();
  }

  _loadHistory() {
    if (!this.historyFile || !fs.existsSync(this.historyFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tasks) ? parsed.tasks : [];
      for (const saved of entries.slice(-this.maxHistory)) {
        if (!saved || typeof saved.id !== 'string' || !saved.id) continue;
        const interrupted = !TERMINAL.has(saved.status);
        const status = interrupted ? 'failed' : saved.status;
        const task = {
          id: saved.id,
          type: String(saved.type || 'download'),
          title: String(saved.title || 'Загрузка'),
          subtitle: String(saved.subtitle || ''),
          build: String(saved.build || ''),
          status,
          stage: interrupted ? 'Прервано при закрытии лаунчера' : String(saved.stage || ''),
          currentFile: String(saved.currentFile || ''),
          queuedFiles: Array.isArray(saved.queuedFiles) ? saved.queuedFiles.map(String).slice(0, 300) : [],
          completedFiles: Math.max(0, Number(saved.completedFiles) || 0),
          totalFiles: Math.max(0, Number(saved.totalFiles) || 0),
          downloadedBytes: Math.max(0, Number(saved.downloadedBytes) || 0),
          totalBytes: Math.max(0, Number(saved.totalBytes) || 0),
          speedBps: 0,
          etaSeconds: null,
          percent: saved.percent == null ? null : Math.max(0, Math.min(100, Number(saved.percent) || 0)),
          error: interrupted ? 'Загрузка была прервана при закрытии лаунчера' : String(saved.error || ''),
          createdAt: Number(saved.createdAt) || Date.now(),
          startedAt: Number(saved.startedAt) || Number(saved.createdAt) || Date.now(),
          finishedAt: interrupted ? Date.now() : (Number(saved.finishedAt) || null),
          cancellable: false,
          retryable: false,
          controller: null,
          retryOperation: null,
          fileProgress: new Map(),
          lastSpeedAt: Date.now(),
          lastSpeedBytes: 0,
          lastEventAt: Date.now()
        };
        this.tasks.set(task.id, task);
        this.order.push(task.id);
      }
      this._trimHistory();
      if (this.order.length) this._schedulePersist();
    } catch (error) {
      console.warn('[downloads] не удалось прочитать историю загрузок:', error.message);
    }
  }

  _schedulePersist() {
    if (!this.historyFile || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, 1500);
    this.persistTimer.unref?.();
  }

  flush() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (!this.historyFile) return false;
    const entries = this.order.map(id => this.tasks.get(id)).filter(Boolean).map(task => ({
      id: task.id,
      type: task.type,
      title: task.title,
      subtitle: task.subtitle,
      build: task.build,
      status: task.status,
      stage: task.stage,
      currentFile: task.currentFile,
      queuedFiles: task.queuedFiles,
      completedFiles: task.completedFiles,
      totalFiles: task.totalFiles,
      downloadedBytes: task.downloadedBytes,
      totalBytes: task.totalBytes,
      percent: task.percent,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt
    })).slice(-this.maxHistory);
    const tempPath = `${this.historyFile}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, tasks: entries }, null, 2), 'utf8');
      fs.renameSync(tempPath, this.historyFile);
      return true;
    } catch (error) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
      console.warn('[downloads] не удалось сохранить историю загрузок:', error.message);
      return false;
    }
  }

  _emit() {
    this._schedulePersist();
    try { this.onUpdate(this.list()); } catch (error) {
      console.warn('[downloads] не удалось обновить интерфейс:', error.message);
    }
  }

  _publicTask(task) {
    return {
      id: task.id,
      type: task.type,
      title: task.title,
      subtitle: task.subtitle,
      build: task.build,
      status: task.status,
      stage: task.stage,
      currentFile: task.currentFile,
      queuedFiles: [...task.queuedFiles],
      completedFiles: task.completedFiles,
      totalFiles: task.totalFiles,
      downloadedBytes: task.downloadedBytes,
      totalBytes: task.totalBytes,
      speedBps: task.speedBps,
      etaSeconds: task.etaSeconds,
      percent: task.percent,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      canCancel: !!task.cancellable && task.status === 'running',
      canRetry: !!task.retryable && task.status === 'failed'
    };
  }

  list() {
    const tasks = [...this.order].reverse()
      .map(id => this.tasks.get(id))
      .filter(Boolean)
      .map(task => this._publicTask(task));
    const active = tasks.filter(task => !TERMINAL.has(task.status));
    const completed = tasks.filter(task => task.status === 'completed');
    const failed = tasks.filter(task => task.status === 'failed');
    const totalSpeedBps = active.reduce((sum, task) => sum + (Number(task.speedBps) || 0), 0);
    return { tasks, activeCount: active.length, completedCount: completed.length, failedCount: failed.length, totalSpeedBps };
  }

  _trimHistory() {
    const terminalIds = this.order.filter(id => {
      const task = this.tasks.get(id);
      return task && TERMINAL.has(task.status);
    });
    const overflow = terminalIds.length - this.maxHistory;
    if (overflow <= 0) return;
    for (const id of terminalIds.slice(0, overflow)) {
      this.tasks.delete(id);
      this.order = this.order.filter(entry => entry !== id);
    }
  }

  run(meta, operation, retryOperation = null) {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const now = Date.now();
    const task = {
      id,
      type: String(meta.type || 'download'),
      title: String(meta.title || 'Загрузка'),
      subtitle: String(meta.subtitle || ''),
      build: String(meta.build || ''),
      status: 'running',
      stage: 'Подготовка',
      currentFile: '',
      queuedFiles: [],
      completedFiles: 0,
      totalFiles: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      percent: null,
      error: '',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      cancellable: meta.cancellable !== false,
      retryable: meta.retryable !== false,
      cancelOnNull: meta.cancelOnNull === true,
      controller,
      retryOperation,
      fileProgress: new Map(),
      lastSpeedAt: now,
      lastSpeedBytes: 0,
      lastEventAt: now
    };
    this.tasks.set(id, task);
    this.order.push(id);
    this._emit();

    const context = {
      taskId: id,
      signal: controller.signal,
      reportFileProgress: info => this.reportFileProgress(id, info),
      reportFileComplete: info => this.reportFileComplete(id, info),
      reportTaskProgress: info => this.reportTaskProgress(id, info)
    };

    return runWithDownloadContext(context, async () => {
      try {
        const result = await operation();
        if (controller.signal.aborted || (task.cancelOnNull && result == null)) this._finish(id, 'cancelled');
        else if (result && result.ok === false) this._finish(id, 'failed', safeErrorMessage(result.error || 'Операция не выполнена'));
        else this._finish(id, 'completed');
        return result;
      } catch (error) {
        const current = this.tasks.get(id);
        if (controller.signal.aborted || error?.code === 'DOWNLOAD_CANCELLED' || error?.name === 'AbortError') {
          this._finish(id, 'cancelled');
          const cancelled = new Error('Загрузка отменена');
          cancelled.code = 'DOWNLOAD_CANCELLED';
          throw cancelled;
        }
        this._finish(id, 'failed', safeErrorMessage(error));
        throw error;
      }
    });
  }

  _finish(id, status, error = '') {
    const task = this.tasks.get(id);
    if (!task || TERMINAL.has(task.status)) return;
    task.status = status;
    task.error = error;
    task.stage = status === 'completed' ? 'Готово' : status === 'cancelled' ? 'Отменено' : 'Ошибка';
    task.finishedAt = Date.now();
    task.speedBps = 0;
    task.etaSeconds = null;
    if (status === 'completed') task.percent = 100;
    this._trimHistory();
    this._emit();
  }

  _updateByteTotals(task) {
    let downloaded = 0;
    let total = 0;
    let fileProgressSum = 0;
    for (const file of task.fileProgress.values()) {
      downloaded += file.downloaded;
      total += file.total;
      fileProgressSum += file.complete ? 1 : file.total > 0 ? Math.min(1, file.downloaded / file.total) : 0;
    }
    task.downloadedBytes = downloaded;
    task.totalBytes = total;
    if (task.totalFiles > 0) {
      const aggregateProgress = Math.max(task.completedFiles, fileProgressSum);
      task.percent = Math.max(0, Math.min(99, (aggregateProgress / task.totalFiles) * 100));
    } else if (total > 0) {
      task.percent = Math.max(0, Math.min(99, (downloaded / total) * 100));
    }
  }

  reportTaskProgress(id, info = {}) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    if (info.stage) task.stage = STAGE_LABELS[info.stage] || String(info.stage);
    if (info.currentFile != null) task.currentFile = String(info.currentFile).slice(0, 180);
    if (Array.isArray(info.queuedFiles)) task.queuedFiles = info.queuedFiles.map(String).slice(0, 300);
    if (Number.isFinite(Number(info.totalFiles))) task.totalFiles = Math.max(task.totalFiles, Number(info.totalFiles));
    if (Number.isFinite(Number(info.completedFiles))) task.completedFiles = Math.max(task.completedFiles, Number(info.completedFiles));
    if (Number.isFinite(Number(info.percent))) task.percent = Math.max(0, Math.min(99, Number(info.percent)));
    this._updateByteTotals(task);
    task.lastEventAt = Date.now();
    this._emit();
  }

  reportFileProgress(id, info = {}) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    const key = String(info.filePath || info.url || info.fileName || 'active-file');
    const file = info.reset
      ? { downloaded: 0, total: 0, complete: false }
      : (task.fileProgress.get(key) || { downloaded: 0, total: 0, complete: false });
    file.downloaded = info.reset ? 0 : Math.max(file.downloaded, Number(info.downloaded) || 0);
    file.total = info.reset ? (Number(info.total) || 0) : Math.max(file.total, Number(info.total) || 0);
    task.fileProgress.set(key, file);
    task.currentFile = String(info.fileName || (info.filePath ? path.basename(info.filePath) : task.currentFile)).slice(0, 180);

    const now = Date.now();
    const totalDownloaded = [...task.fileProgress.values()].reduce((sum, entry) => sum + entry.downloaded, 0);
    if (info.reset) {
      task.lastSpeedAt = now;
      task.lastSpeedBytes = totalDownloaded;
      task.speedBps = 0;
    }
    const elapsed = Math.max((now - task.lastSpeedAt) / 1000, 0.001);
    const delta = Math.max(0, totalDownloaded - task.lastSpeedBytes);
    const instant = delta / elapsed;
    if (instant > 0) task.speedBps = task.speedBps > 0 ? task.speedBps * 0.65 + instant * 0.35 : instant;
    task.lastSpeedAt = now;
    task.lastSpeedBytes = totalDownloaded;
    task.lastEventAt = now;
    this._updateByteTotals(task);
    if (task.speedBps > 0 && task.totalBytes > task.downloadedBytes) {
      task.etaSeconds = Math.ceil((task.totalBytes - task.downloadedBytes) / task.speedBps);
    }
    this._emit();
  }

  reportFileComplete(id, info = {}) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    const key = String(info.filePath || info.url || info.fileName || 'active-file');
    const file = task.fileProgress.get(key) || { downloaded: 0, total: 0, complete: false };
    if (Number(info.bytes) > 0) file.downloaded = Math.max(file.downloaded, Number(info.bytes));
    if (file.total > 0) file.downloaded = Math.max(file.downloaded, file.total);
    file.complete = true;
    task.fileProgress.set(key, file);
    task.currentFile = String(info.fileName || (info.filePath ? path.basename(info.filePath) : task.currentFile)).slice(0, 180);
    this._updateByteTotals(task);
    this._emit();
  }

  reportEvent(channel, payload) {
    const { getDownloadContext } = require('./downloadTaskContext');
    const context = getDownloadContext();
    if (!context || !payload || typeof payload !== 'object') return;
    if (channel === 'game:progress' && !['java-check', 'java-download', 'java-extract', 'installing-loader', 'progress', 'download', 'game-started'].includes(payload.stage)) return;
    if (!['mods:progress', 'resourcepacks:progress', 'shaders:progress', 'java:progress', 'meteor:progress', 'game:progress', 'update:progress'].includes(channel)) return;
    const task = this.tasks.get(context.taskId);
    if (!task || task.status !== 'running') return;

    let hasAggregateByteProgress = false;
    if (payload.stage && STAGE_LABELS[payload.stage]) task.stage = STAGE_LABELS[payload.stage];
    if (payload.title) task.currentFile = String(payload.title).slice(0, 180);
    else if (payload.fileName) task.currentFile = String(payload.fileName).slice(0, 180);
    if (Array.isArray(payload.queue)) task.queuedFiles = payload.queue.map(item => String(item?.title || item?.fileName || item).slice(0, 120)).slice(0, 300);
    if (Array.isArray(payload.queuedFiles)) task.queuedFiles = payload.queuedFiles.map(item => String(item?.title || item?.fileName || item).slice(0, 120)).slice(0, 300);
    if (Number.isFinite(Number(payload.totalFiles)) && Number(payload.totalFiles) >= 0) task.totalFiles = Math.max(task.totalFiles, Number(payload.totalFiles));
    if (Number.isFinite(Number(payload.doneFiles)) && Number(payload.doneFiles) >= 0) task.completedFiles = Math.max(task.completedFiles, Number(payload.doneFiles));
    if (Number.isFinite(Number(payload.total)) && Number(payload.total) > 0) {
      if (channel === 'java:progress' || (channel === 'game:progress' && payload.stage === 'java-download')) {
        task.totalBytes = Number(payload.total);
        hasAggregateByteProgress = true;
      } else {
        task.totalFiles = Math.max(task.totalFiles, Number(payload.total));
      }
    }
    if (Number.isFinite(Number(payload.done))) task.completedFiles = Math.max(task.completedFiles, Number(payload.done));
    if (['downloading', 'downloaded'].includes(payload.stage) && task.currentFile) {
      task.queuedFiles = task.queuedFiles.filter(file => file !== task.currentFile && file !== String(payload.fileName || ''));
    }
    if (channel === 'game:progress' && Number(payload.total) > 0 && Number(payload.task) >= 0) {
      task.percent = Math.max(0, Math.min(99, (Number(payload.task) / Number(payload.total)) * 100));
    }
    if (Number.isFinite(Number(payload.downloaded)) && Number(payload.downloaded) >= 0) {
      task.downloadedBytes = hasAggregateByteProgress ? Number(payload.downloaded) : Math.max(task.downloadedBytes, Number(payload.downloaded));
      if (task.totalBytes > 0) task.percent = Math.max(0, Math.min(99, task.downloadedBytes / task.totalBytes * 100));
    }
    if (Number.isFinite(Number(payload.speedBps)) && Number(payload.speedBps) >= 0) task.speedBps = Number(payload.speedBps);
    if (Number.isFinite(Number(payload.etaSec)) && Number(payload.etaSec) >= 0) task.etaSeconds = Number(payload.etaSec);
    if (payload.percent != null && Number.isFinite(Number(payload.percent))) task.percent = Math.max(0, Math.min(99, Number(payload.percent)));
    if (payload.stage === 'game-started') {
      this._finish(task.id, 'completed');
      return;
    }
    if (!hasAggregateByteProgress) this._updateByteTotals(task);
    task.lastEventAt = Date.now();
    this._emit();
  }

  cancel(id) {
    const task = this.tasks.get(String(id));
    if (!task || task.status !== 'running' || !task.cancellable) return false;
    task.status = 'cancelling';
    task.stage = 'Отмена…';
    task.controller.abort();
    this._emit();
    return true;
  }

  async retry(id) {
    const task = this.tasks.get(String(id));
    if (!task || task.status !== 'failed' || !task.retryable || typeof task.retryOperation !== 'function') {
      return { ok: false, error: 'Эту загрузку нельзя повторить' };
    }
    const meta = {
      type: task.type,
      title: `Повтор: ${task.title}`,
      subtitle: task.subtitle,
      build: task.build,
      cancellable: task.cancellable,
      retryable: task.retryable,
      cancelOnNull: false
    };
    try {
      const result = await this.run(meta, task.retryOperation, task.retryOperation);
      if (result && result.ok === false) return { ok: false, error: safeErrorMessage(result.error || 'Операция не выполнена') };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error) };
    }
  }

  clearHistory() {
    for (const [id, task] of this.tasks) {
      if (TERMINAL.has(task.status)) this.tasks.delete(id);
    }
    this.order = this.order.filter(id => this.tasks.has(id));
    this._emit();
    return this.list();
  }
}

module.exports = { DownloadManager };
