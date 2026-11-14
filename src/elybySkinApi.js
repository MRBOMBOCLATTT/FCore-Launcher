'use strict';

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function normalizeTextureUrl(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : null;
}

function createElybySkinApi({ fetchImpl = globalThis.fetch, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const cache = new Map();

  function getTextureInfo(name, uuid = null) {
    const normalizedName = String(name || '').trim();
    const emptyResult = {
      type: 'elyby', name: normalizedName, uuid,
      skinUrl: null, capeUrl: null, variant: null
    };
    if (!USERNAME_RE.test(normalizedName)) return Promise.resolve(emptyResult);

    const key = normalizedName.toLowerCase();
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttlMs) return cached.promise;

    const promise = (async () => {
      const response = await fetchImpl(`https://skinsystem.ely.by/textures/${encodeURIComponent(normalizedName)}`, {
        headers: { Accept: 'application/json' }
      });

      // Ely.by documents 204 for profiles without textures. Treat 404 the same
      // way as a defensive fallback, rather than asking the browser for a missing PNG.
      if (response.status === 204 || response.status === 404) return emptyResult;
      if (!response.ok) throw new Error(`Ely.by skin API: ${response.status}`);

      const textures = await response.json();
      return {
        ...emptyResult,
        skinUrl: normalizeTextureUrl(textures?.SKIN?.url),
        capeUrl: normalizeTextureUrl(textures?.CAPE?.url),
        variant: textures?.SKIN?.metadata?.model || null
      };
    })();

    cache.set(key, { at: now(), promise });
    promise.catch(() => cache.delete(key));
    return promise;
  }

  return {
    getTextureInfo,
    clearCache() { cache.clear(); }
  };
}

module.exports = { createElybySkinApi, normalizeTextureUrl, USERNAME_RE };
