/* Everything the player remembers between visits, kept in localStorage.
 *
 * Three separate buckets so that clearing one does not disturb the others:
 *   settings  - key, folder, volume, shuffle/repeat, last filter
 *   cache     - ID3 metadata per file, so a reload is instant
 *   overrides - genre tags the listener set by hand; the only bucket worth
 *               exporting, and the one the Export button writes out
 */
(function (global) {
  'use strict';

  var KEYS = {
    settings: 'drivePlayer.settings.v1',
    cache: 'drivePlayer.metaCache.v1',
    overrides: 'drivePlayer.genreOverrides.v1'
  };

  var DEFAULT_SETTINGS = {
    apiKey: '',
    folderId: '',
    volume: 0.8,
    shuffle: false,
    repeat: 'all',   // 'off' | 'all' | 'one'
    genre: 'All'
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Quota exceeded, or storage disabled in a private window. The player
      // still works, it just forgets things.
      return false;
    }
  }

  var settings = null;
  var cache = null;
  var overrides = null;

  function getSettings() {
    if (!settings) {
      var stored = read(KEYS.settings, {});
      settings = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
        settings[k] = stored[k] === undefined ? DEFAULT_SETTINGS[k] : stored[k];
      });
    }
    return settings;
  }

  function saveSettings(patch) {
    var s = getSettings();
    if (patch) Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    write(KEYS.settings, s);
    return s;
  }

  function getCache() {
    if (!cache) cache = read(KEYS.cache, {});
    return cache;
  }

  /* Cache entries are invalidated when the file changes in Drive. */
  function cacheGet(id, modifiedTime) {
    var entry = getCache()[id];
    if (!entry) return null;
    if (modifiedTime && entry.modifiedTime && entry.modifiedTime !== modifiedTime) return null;
    return entry;
  }

  /* Merged rather than replaced: the ID3 pass and the duration that only
   * arrives once a track plays write to the same entry at different times. */
  function cacheSet(id, entry) {
    var all = getCache();
    var existing = all[id] || {};
    Object.keys(entry).forEach(function (k) { existing[k] = entry[k]; });
    all[id] = existing;
    scheduleCacheWrite();
  }

  // Tagging a whole library fires this hundreds of times; batch the writes.
  var cacheTimer = null;
  function scheduleCacheWrite() {
    if (cacheTimer) return;
    cacheTimer = setTimeout(function () {
      cacheTimer = null;
      if (!write(KEYS.cache, getCache())) {
        // Out of room: drop the cache rather than wedge on every write.
        cache = {};
        try { localStorage.removeItem(KEYS.cache); } catch (e) {}
      }
    }, 1500);
  }

  function clearCache() {
    cache = {};
    try { localStorage.removeItem(KEYS.cache); } catch (e) {}
  }

  function getOverrides() {
    if (!overrides) overrides = read(KEYS.overrides, {});
    return overrides;
  }

  /* Overrides are written under two keys: the Drive file id, and
   * "artist|title". The id survives a retag or a rename; the artist/title
   * survives re-uploading the same song as a new file. Either one finding a
   * match is enough. */
  function overrideKey(track) {
    var artist = (track.artist || '').toLowerCase().trim();
    var title = (track.title || track.fileName || '').toLowerCase().trim();
    return (artist + '|' + title).replace(/\s+/g, ' ');
  }

  function idKey(track) {
    return 'id:' + track.id;
  }

  function getOverride(track) {
    var o = getOverrides();
    return o[idKey(track)] || o[overrideKey(track)] || null;
  }

  function setOverride(track, tags) {
    var o = getOverrides();
    [idKey(track), overrideKey(track)].forEach(function (key) {
      if (tags && tags.length) o[key] = tags.slice();
      else delete o[key];
    });
    write(KEYS.overrides, o);
  }

  function replaceOverrides(map) {
    overrides = map || {};
    write(KEYS.overrides, overrides);
  }

  global.Store = {
    getSettings: getSettings,
    saveSettings: saveSettings,
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    clearCache: clearCache,
    getOverrides: getOverrides,
    getOverride: getOverride,
    setOverride: setOverride,
    replaceOverrides: replaceOverrides,
    overrideKey: overrideKey
  };
})(window);
