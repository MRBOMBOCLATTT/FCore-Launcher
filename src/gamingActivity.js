// Локальная история игровых сессий и агрегированная статистика FCore Launcher.
// Не требует сети: хранит только время запусков, сборки и снимок включённых модов.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SESSIONS = 1200;
const MAX_MODS_PER_SESSION = 500;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanMods(mods) {
  const byId = new Map();
  for (const mod of Array.isArray(mods) ? mods : []) {
    if (!mod || typeof mod !== 'object') continue;
    const id = String(mod.id || mod.key || '').trim().slice(0, 180);
    const name = String(mod.name || id || 'Неизвестный мод').trim().slice(0, 180);
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      name,
      version: mod.version == null ? null : String(mod.version).slice(0, 80)
    });
    if (byId.size >= MAX_MODS_PER_SESSION) break;
  }
  return [...byId.values()];
}

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function createGamingActivityStore(filePath) {
  if (!filePath) throw new Error('Не указан путь к файлу статистики');
  const resolvedPath = path.resolve(filePath);

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      return {
        version: 1,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions.slice(-MAX_SESSIONS) : []
      };
    } catch {
      return { version: 1, sessions: [] };
    }
  }

  let state = readState();

  function persist() {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const tempPath = `${resolvedPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state), 'utf8');
    fs.renameSync(tempPath, resolvedPath);
  }

  function recordStart({ mcVersion, loader, buildId = null, buildName = null, startedAt = Date.now() } = {}) {
    const id = `activity-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const session = {
      id,
      mcVersion: String(mcVersion || 'unknown').slice(0, 40),
      loader: String(loader || 'unknown').slice(0, 20),
      buildId: buildId ? String(buildId).slice(0, 80) : null,
      buildName: buildName ? String(buildName).slice(0, 100) : null,
      buildKey: buildId ? `build:${String(buildId)}` : `instance:${String(mcVersion || 'unknown')}|${String(loader || 'unknown')}`,
      startedAt: safeNumber(startedAt, Date.now()),
      endedAt: null,
      lastHeartbeatAt: safeNumber(startedAt, Date.now()),
      durationMs: 0,
      exitCode: null,
      status: 'running',
      mods: []
    };
    state.sessions.push(session);
    state.sessions = state.sessions.slice(-MAX_SESSIONS);
    persist();
    return id;
  }

  function setSessionMods(id, mods) {
    const session = state.sessions.find(item => item.id === id);
    if (!session) return false;
    session.mods = cleanMods(mods);
    persist();
    return true;
  }

  function touchSession(id, at = Date.now()) {
    const session = state.sessions.find(item => item.id === id);
    if (!session || session.status !== 'running') return false;
    const touchedAt = Math.max(session.startedAt, safeNumber(at, Date.now()));
    session.lastHeartbeatAt = touchedAt;
    session.durationMs = Math.max(safeNumber(session.durationMs), touchedAt - session.startedAt);
    persist();
    return true;
  }

  function finishSession(id, { durationMs = 0, exitCode = null, endedAt = Date.now() } = {}) {
    const session = state.sessions.find(item => item.id === id);
    if (!session || session.status !== 'running') return false;
    session.endedAt = Math.max(session.startedAt, safeNumber(endedAt, Date.now()));
    session.durationMs = Math.max(0, safeNumber(durationMs));
    session.lastHeartbeatAt = session.endedAt;
    session.exitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : null;
    session.status = session.exitCode != null && session.exitCode !== 0 ? 'crashed' : 'closed';
    persist();
    return true;
  }

  // Сессия, оставшаяся running после аварийного закрытия лаунчера, не должна
  // превращаться в десятки часов наигранного времени.
  function touchRunningSessions(at = Date.now()) {
    let changed = false;
    const touchedAt = safeNumber(at, Date.now());
    for (const session of state.sessions) {
      if (session.status !== 'running') continue;
      const value = Math.max(session.startedAt, touchedAt);
      session.lastHeartbeatAt = value;
      session.durationMs = Math.max(safeNumber(session.durationMs), value - session.startedAt);
      changed = true;
    }
    if (changed) persist();
    return changed;
  }

  function recoverInterruptedSessions(recoveredAt = Date.now()) {
    let changed = false;
    for (const session of state.sessions) {
      if (session.status !== 'running') continue;
      session.status = 'interrupted';
      session.recoveredAt = safeNumber(recoveredAt, Date.now());
      session.durationMs = Math.max(0, safeNumber(session.durationMs), safeNumber(session.lastHeartbeatAt) - safeNumber(session.startedAt));
      session.endedAt = Math.max(session.startedAt, safeNumber(session.lastHeartbeatAt, session.startedAt));
      changed = true;
    }
    if (changed) persist();
    return changed;
  }

  function listSessions() {
    return state.sessions.map(session => ({ ...session, mods: (session.mods || []).map(mod => ({ ...mod })) }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  function getOverview({ totalLaunches = 0, totalPlaytimeMs = 0, instances = [], now = Date.now() } = {}) {
    const sessions = listSessions();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const days = [];
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      days.push({ date: dayKey(date), timestamp: date.getTime(), launches: 0, playtimeMs: 0 });
    }
    const weekStart = days[0].timestamp;
    let weeklyLaunches = 0;
    let weeklyPlaytimeMs = 0;
    let weeklySessionDurationMs = 0;

    for (const session of sessions) {
      const startedAt = safeNumber(session.startedAt);
      const duration = Math.max(0, safeNumber(session.durationMs));
      const sessionEnd = Math.min(now, startedAt + duration);

      // Число запусков и средняя длительность относятся к дате старта сессии.
      if (startedAt >= weekStart && startedAt <= now) {
        const launchDay = days.find(day => {
          const next = new Date(day.timestamp);
          next.setDate(next.getDate() + 1);
          return startedAt >= day.timestamp && startedAt < next.getTime();
        });
        if (launchDay) launchDay.launches++;
        weeklyLaunches++;
        weeklySessionDurationMs += duration;
      }

      // Игровое время распределяется по календарным дням, даже если сессия
      // началась до начала недели или пересекла полночь.
      if (!duration || sessionEnd <= startedAt) continue;
      for (const day of days) {
        const nextDay = new Date(day.timestamp);
        nextDay.setDate(nextDay.getDate() + 1);
        const overlapStart = Math.max(startedAt, day.timestamp);
        const overlapEnd = Math.min(sessionEnd, nextDay.getTime());
        if (overlapEnd <= overlapStart) continue;
        const overlap = overlapEnd - overlapStart;
        day.playtimeMs += overlap;
        weeklyPlaytimeMs += overlap;
      }
    }

    const buildMap = new Map();
    for (const item of Array.isArray(instances) ? instances : []) {
      if (!item || !item.key) continue;
      buildMap.set(String(item.key), {
        key: String(item.key),
        buildId: item.buildId || null,
        name: String(item.name || item.label || `${item.mcVersion || 'Minecraft'} (${item.loader || ''})`),
        mcVersion: item.mcVersion || null,
        loader: item.loader || null,
        launchCount: Math.max(0, safeNumber(item.launchCount)),
        playtimeMs: Math.max(0, safeNumber(item.playtimeMs)),
        lastPlayedAt: Math.max(0, safeNumber(item.lastPlayedAt))
      });
    }

    // Сохранённые сессии остаются видны, даже если соответствующую сборку позже удалили.
    const historicalBuilds = new Map();
    for (const session of sessions) {
      const key = session.buildKey || `instance:${session.mcVersion}|${session.loader}`;
      if (!buildMap.has(key)) {
        if (!historicalBuilds.has(key)) {
          historicalBuilds.set(key, {
            key,
            buildId: session.buildId || null,
            name: session.buildName || `Minecraft ${session.mcVersion} (${session.loader})`,
            mcVersion: session.mcVersion,
            loader: session.loader,
            launchCount: 0,
            playtimeMs: 0,
            lastPlayedAt: 0
          });
        }
        const row = historicalBuilds.get(key);
        row.launchCount++;
        row.lastPlayedAt = Math.max(row.lastPlayedAt, safeNumber(session.startedAt));
        if (session.status === 'closed' || session.status === 'crashed' || session.status === 'interrupted' || session.status === 'running') row.playtimeMs += Math.max(0, safeNumber(session.durationMs));
      }
    }

    for (const session of sessions) {
      if (session.status !== 'interrupted' && session.status !== 'running') continue;
      const key = session.buildKey || `instance:${session.mcVersion}|${session.loader}`;
      const row = buildMap.get(key);
      if (row) row.playtimeMs += Math.max(0, safeNumber(session.durationMs));
    }

    const interruptedPlaytimeMs = sessions
      .filter(session => session.status === 'interrupted' || session.status === 'running')
      .reduce((sum, session) => sum + Math.max(0, safeNumber(session.durationMs)), 0);

    const modsMap = new Map();
    for (const session of sessions) {
      const used = new Set();
      for (const mod of Array.isArray(session.mods) ? session.mods : []) {
        if (!mod || !mod.id || used.has(mod.id)) continue;
        used.add(mod.id);
        if (!modsMap.has(mod.id)) modsMap.set(mod.id, { id: mod.id, name: mod.name || mod.id, sessions: 0, lastUsedAt: 0, version: mod.version || null });
        const row = modsMap.get(mod.id);
        row.sessions++;
        row.lastUsedAt = Math.max(row.lastUsedAt, safeNumber(session.startedAt));
        if (mod.version) row.version = mod.version;
        if (mod.name) row.name = mod.name;
      }
    }

    return {
      generatedAt: now,
      totalLaunches: Math.max(0, safeNumber(totalLaunches, sessions.length)),
      totalPlaytimeMs: Math.max(0, safeNumber(totalPlaytimeMs)) + interruptedPlaytimeMs,
      weeklyLaunches,
      weeklyPlaytimeMs,
      weeklyAverageSessionMs: weeklyLaunches ? weeklySessionDurationMs / weeklyLaunches : 0,
      weekly: days,
      builds: [...buildMap.values(), ...historicalBuilds.values()]
        .sort((a, b) => (b.playtimeMs - a.playtimeMs) || (b.launchCount - a.launchCount) || (b.lastPlayedAt - a.lastPlayedAt))
        .slice(0, 8),
      topMods: [...modsMap.values()].sort((a, b) => (b.sessions - a.sessions) || (b.lastUsedAt - a.lastUsedAt)).slice(0, 12),
      sessionCount: sessions.length,
      sessions: sessions.slice(0, 80)
    };
  }

  return { recordStart, setSessionMods, touchSession, touchRunningSessions, finishSession, recoverInterruptedSessions, listSessions, getOverview };
}

module.exports = { createGamingActivityStore, cleanMods, dayKey };
