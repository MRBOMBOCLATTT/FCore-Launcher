function createProfileRecord({ id, name, loader, packs, installedPacks, createdAt = Date.now() }) {
  const record = {
    id,
    name: String(name || '').trim(),
    loader,
    packs: Array.isArray(packs) ? packs.map(pack => ({ ...pack })) : [],
    createdAt
  };
  if (Array.isArray(installedPacks)) {
    record.installedPacks = installedPacks
      .filter(pack => pack && typeof pack.fileName === 'string' && pack.fileName)
      .map(pack => ({ fileName: pack.fileName, enabled: !!pack.enabled }));
  }
  return record;
}

function planProfileApply(profile, currentWanted = [], currentInstalled = []) {
  const wanted = Array.isArray(profile?.packs) ? profile.packs : [];
  if (!Array.isArray(profile?.installedPacks)) {
    // Совместимость со старыми профилями, которые сохраняли только список.
    const merged = [...currentWanted];
    for (const pack of wanted) {
      if (!merged.some(item => item.projectId === pack.projectId)) merged.push({ ...pack });
    }
    return { nextWanted: merged, enabledUpdates: [], legacy: true };
  }

  const nextWanted = wanted.map(pack => ({ ...pack }));
  const desired = new Map(profile.installedPacks
    .filter(pack => pack && typeof pack.fileName === 'string')
    .map(pack => [pack.fileName, !!pack.enabled]));
  const enabledUpdates = currentInstalled
    .filter(pack => pack && typeof pack.fileName === 'string')
    .map(pack => ({
      fileName: pack.fileName,
      enabled: desired.has(pack.fileName) ? desired.get(pack.fileName) : false
    }))
    .filter(update => {
      const current = currentInstalled.find(pack => pack.fileName === update.fileName);
      return current && !!current.enabled !== update.enabled;
    });

  return { nextWanted, enabledUpdates, legacy: false };
}

module.exports = { createProfileRecord, planProfileApply };
