const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGamingActivityStore } = require('../src/gamingActivity');

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcore-activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createGamingActivityStore(path.join(dir, 'gaming-activity.json'));
}

test('records sessions, mods and aggregates weekly activity', t => {
  const activity = makeStore(t);
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const startedAt = now.getTime();
  const id = activity.recordStart({
    mcVersion: '1.21.1', loader: 'fabric', buildId: 'abc123', buildName: 'PvP Pack', startedAt
  });
  assert.equal(activity.setSessionMods(id, [
    { id: 'sodium', name: 'Sodium', version: '0.6.0' },
    { id: 'sodium', name: 'Sodium duplicate' },
    { id: 'lithium', name: 'Lithium' }
  ]), true);
  assert.equal(activity.finishSession(id, { durationMs: 90 * 60 * 1000, exitCode: 0, endedAt: startedAt + 90 * 60 * 1000 }), true);

  const overview = activity.getOverview({
    totalLaunches: 12,
    totalPlaytimeMs: 7 * 60 * 60 * 1000,
    instances: [{ key: 'build:abc123', buildId: 'abc123', name: 'PvP Pack', launchCount: 12, playtimeMs: 7 * 60 * 60 * 1000 }],
    now: startedAt + 2 * 60 * 60 * 1000
  });
  assert.equal(overview.totalLaunches, 12);
  assert.equal(overview.weeklyLaunches, 1);
  assert.equal(overview.weeklyPlaytimeMs, 90 * 60 * 1000);
  assert.equal(overview.topMods.length, 2);
  assert.deepEqual(new Set(overview.topMods.map(mod => mod.id)), new Set(['sodium', 'lithium']));
  assert.equal(overview.sessions[0].status, 'closed');
  assert.equal(overview.builds[0].name, 'PvP Pack');
});

test('recovery marks open sessions interrupted using last heartbeat', t => {
  const activity = makeStore(t);
  const startedAt = Date.now() - 120000;
  const id = activity.recordStart({ mcVersion: '1.20.1', loader: 'forge', startedAt });
  activity.touchSession(id, startedAt + 75000);
  assert.equal(activity.recoverInterruptedSessions(startedAt + 180000), true);
  const session = activity.listSessions()[0];
  assert.equal(session.status, 'interrupted');
  assert.equal(session.durationMs, 75000);
  assert.equal(session.endedAt, startedAt + 75000);
});

test('does not finish the same session twice', t => {
  const activity = makeStore(t);
  const id = activity.recordStart({ mcVersion: '1.21', loader: 'vanilla' });
  assert.equal(activity.finishSession(id, { durationMs: 1000, exitCode: 0 }), true);
  assert.equal(activity.finishSession(id, { durationMs: 2000, exitCode: 0 }), false);
});


test('interrupted sessions contribute their last heartbeat to playtime', t => {
  const activity = makeStore(t);
  const startedAt = Date.now() - 120000;
  const id = activity.recordStart({ mcVersion: '1.21.1', loader: 'fabric' , startedAt });
  activity.touchSession(id, startedAt + 60000);
  activity.recoverInterruptedSessions(startedAt + 90000);
  const overview = activity.getOverview({ now: startedAt + 100000 });
  assert.equal(overview.totalPlaytimeMs, 60000);
  assert.equal(overview.weeklyPlaytimeMs, 60000);
  assert.equal(overview.sessionCount, 1);
});


test('splits playtime across calendar days when a session crosses midnight', t => {
  const activity = makeStore(t);
  const now = new Date();
  now.setHours(2, 0, 0, 0);
  const sessionStart = new Date(now);
  sessionStart.setDate(sessionStart.getDate() - 1);
  sessionStart.setHours(23, 0, 0, 0);
  const startedAt = sessionStart.getTime();
  const endedAt = startedAt + 3 * 60 * 60 * 1000;

  const id = activity.recordStart({ mcVersion: '1.21.1', loader: 'fabric', startedAt });
  activity.finishSession(id, { durationMs: 3 * 60 * 60 * 1000, exitCode: 0, endedAt });

  const overview = activity.getOverview({ now: endedAt });
  const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const startDay = overview.weekly.find(day => day.date === localDateKey(sessionStart));
  const nextDayDate = new Date(sessionStart);
  nextDayDate.setDate(nextDayDate.getDate() + 1);
  const nextDay = overview.weekly.find(day => day.date === `${nextDayDate.getFullYear()}-${String(nextDayDate.getMonth() + 1).padStart(2, '0')}-${String(nextDayDate.getDate()).padStart(2, '0')}`);

  assert.equal(startDay.playtimeMs, 60 * 60 * 1000);
  assert.equal(nextDay.playtimeMs, 2 * 60 * 60 * 1000);
  assert.equal(overview.weeklyPlaytimeMs, 3 * 60 * 60 * 1000);
  assert.equal(overview.weeklyLaunches, 1);
  assert.equal(overview.weeklyAverageSessionMs, 3 * 60 * 60 * 1000);
});
