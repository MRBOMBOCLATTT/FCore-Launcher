const test = require('node:test');
const assert = require('node:assert/strict');
const { toLiveSample } = require('../src/performanceSample');

test('normalizes process CPU usage against all logical cores', () => {
  const sample = toLiveSample({ t: 5000, rssMb: 1024.26, cpuCores: 2, totalCores: 8, totalMemMb: 32768, capturedAt: 123 });
  assert.equal(sample.cpuPercent, 25);
  assert.equal(sample.cpuCores, 2);
  assert.equal(sample.rssMb, 1024.3);
  assert.equal(sample.capturedAt, 123);
});

test('caps CPU usage at 100 percent and normalizes invalid core counts', () => {
  const sample = toLiveSample({ cpuCores: 12, totalCores: 0, rssMb: -3 });
  assert.equal(sample.totalCores, 1);
  assert.equal(sample.cpuPercent, 100);
  assert.equal(sample.rssMb, 0);
});

test('represents first sample CPU as unavailable until there are two process measurements', () => {
  const sample = toLiveSample({ t: 0, rssMb: 500, cpuCores: null, totalCores: 4 });
  assert.equal(sample.cpuCores, null);
  assert.equal(sample.cpuPercent, null);
});
