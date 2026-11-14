(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PFCBuildMeta = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_GROUP = 24;
  const MAX_TAG = 20;
  const MAX_TAGS = 6;

  function cleanLabel(value, max) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function cleanTags(input) {
    const raw = Array.isArray(input) ? input : String(input || '').split(',');
    const seen = new Set();
    const tags = [];
    for (const item of raw) {
      const tag = cleanLabel(item, MAX_TAG).replace(/^#/, '');
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
    return tags;
  }

  function sanitizeMeta(input) {
    const src = input && typeof input === 'object' ? input : {};
    return {
      group: cleanLabel(src.group, MAX_GROUP),
      tags: cleanTags(src.tags)
    };
  }

  function listGroups(builds) {
    const names = new Map();
    for (const build of builds) {
      const group = cleanLabel(build.group, MAX_GROUP);
      if (group && !names.has(group.toLowerCase())) names.set(group.toLowerCase(), group);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  function filterBuilds(builds, { group = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return builds.filter(build => {
      const buildGroup = cleanLabel(build.group, MAX_GROUP);
      if (group === '') {
        if (buildGroup) return false;
      } else if (group && buildGroup.toLowerCase() !== String(group).toLowerCase()) {
        return false;
      }
      if (!q) return true;
      const haystack = [build.name, build.mcVersion, build.loader, buildGroup, ...(build.tags || [])]
        .join(' ')
        .toLowerCase();
      return q.split(/\s+/).every(part => haystack.includes(part));
    });
  }

  function groupBuilds(builds) {
    const groups = listGroups(builds);
    const sections = groups.map(name => ({
      name,
      builds: builds.filter(b => cleanLabel(b.group, MAX_GROUP).toLowerCase() === name.toLowerCase())
    }));
    const loose = builds.filter(b => !cleanLabel(b.group, MAX_GROUP));
    if (loose.length) sections.push({ name: '', builds: loose });
    return sections;
  }

  return { sanitizeMeta, cleanTags, listGroups, filterBuilds, groupBuilds, MAX_GROUP, MAX_TAG, MAX_TAGS };
});
