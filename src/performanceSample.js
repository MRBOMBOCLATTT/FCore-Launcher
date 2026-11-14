function round(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** decimals;
  return Math.round(n * scale) / scale;
}

function toLiveSample({ t, rssMb, cpuCores, totalCores, totalMemMb, capturedAt = Date.now() } = {}) {
  const cores = Math.max(1, Number(totalCores) || 1);
  const cpu = cpuCores == null || !Number.isFinite(Number(cpuCores)) ? null : Math.max(0, Number(cpuCores));
  return {
    t: Math.max(0, Number(t) || 0),
    rssMb: round(Math.max(0, Number(rssMb) || 0), 1),
    cpuCores: cpu == null ? null : round(cpu, 2),
    // Процент нормирован на все логические ядра, а не на одно ядро.
    cpuPercent: cpu == null ? null : round(Math.min(100, cpu / cores * 100), 1),
    totalCores: cores,
    totalMemMb: Math.max(0, Number(totalMemMb) || 0),
    capturedAt: Number(capturedAt) || Date.now()
  };
}

module.exports = { toLiveSample };
