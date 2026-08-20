/* Everything the player remembers between visits, kept in localStorage.
 *
 * Four separate buckets so that clearing one does not disturb the others:
 *   settings  - key, folder, volume, shuffle/repeat, last filter
 *   cache     - ID3 metadata per file, so a reload is instant
 *   overrides - genre tags the listener set on individual tracks
 *   artists   - genre tags the listener set for a whole artist, which is how
 *               a library gets tagged without touching every track
 *
 * The last two are what Export and Import move around.
 */
(function (global) {
  'use strict';

  var KEYS = {
    settings: 'drivePlayer.settings.v1',
    cache: 'drivePlayer.metaCache.v1',
    overrides: 'drivePlayer.genreOverrides.v1',
    artists: 'drivePlayer.artistRules.v1',
    online: 'drivePlayer.onlineTags.v1'
  };

  var DEFAULT_SETTINGS = {
    apiKey: '',
    folderId: '',
    volume: 0.8,
    shuffle: false,
    repeat: 'all',   // 'off' | 'all' | 'one'
    genre: 'All',
    facet: 'genre'   // genre | artist | album
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
  var artistRules = null;
  var onlineTags = null;

  /* Only keys listed in DEFAULT_SETTINGS survive a round trip - anything
   * else is dropped on read, so a new setting has to be declared there. */
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

  /* Artist rules are keyed the way Genres normalises an artist, so "The
   * Black Angels", "black angels, the" and "THE BLACK ANGELS" are one rule. */
  function getArtistRules() {
    if (!artistRules) artistRules = read(KEYS.artists, {});
    return artistRules;
  }

  function artistKey(artist) {
    return global.Genres ? global.Genres.normaliseArtist(artist)
                         : String(artist || '').toLowerCase().trim();
  }

  /* Looks up every credited artist, so "Kavinsky feat. Lovefoxxx" still
   * matches a rule saved for Kavinsky. */
  function getArtistRule(artist) {
    if (!artist) return null;
    var rules = getArtistRules();
    var direct = rules[artistKey(artist)];
    if (direct) return direct;

    var parts = String(artist).split(/\s*(?:feat\.?|ft\.?|featuring|with|vs\.?|,|&|\/)\s*/i);
    for (var i = 0; i < parts.length; i++) {
      var found = rules[artistKey(parts[i])];
      if (found) return found;
    }
    return null;
  }

  function setArtistRule(artist, tags) {
    var rules = getArtistRules();
    var key = artistKey(artist);
    if (!key) return;
    if (tags && tags.length) rules[key] = tags.slice();
    else delete rules[key];
    write(KEYS.artists, rules);
  }

  /* Accepts artist names as typed - they are normalised on the way in, so a
   * hand-written or generated import file does not have to know the rules. */
  function replaceArtistRules(map, merge) {
    var rules = merge ? getArtistRules() : {};
    Object.keys(map || {}).forEach(function (name) {
      var tags = map[name];
      var key = artistKey(name);
      if (!key) return;
      if (tags && tags.length) rules[key] = tags.slice();
      else delete rules[key];
    });
    artistRules = rules;
    write(KEYS.artists, rules);
    return Object.keys(rules).length;
  }

  /* What MusicBrainz said about an artist, kept forever. A miss is recorded
   * too, so a fruitless lookup is never repeated - the rate limit makes
   * asking twice genuinely expensive. */
  function getOnlineTags() {
    if (!onlineTags) onlineTags = read(KEYS.online, {});
    return onlineTags;
  }

  function getOnline(artist) {
    if (!artist) return null;
    var entry = getOnlineTags()[artistKey(artist)];
    return entry || null;
  }

  function setOnline(artist, tags, mbid) {
    var all = getOnlineTags();
    var key = artistKey(artist);
    if (!key) return;
    all[key] = { tags: (tags || []).slice(), mbid: mbid || '', at: Date.now() };
    write(KEYS.online, all);
  }

  function clearOnline() {
    onlineTags = {};
    try { localStorage.removeItem(KEYS.online); } catch (e) {}
  }

  global.Store = {
    getSettings: getSettings,
    getOnline: getOnline,
    setOnline: setOnline,
    clearOnline: clearOnline,
    saveSettings: saveSettings,
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    clearCache: clearCache,
    getOverrides: getOverrides,
    getOverride: getOverride,
    setOverride: setOverride,
    replaceOverrides: replaceOverrides,
    overrideKey: overrideKey,
    getArtistRules: getArtistRules,
    getArtistRule: getArtistRule,
    setArtistRule: setArtistRule,
    replaceArtistRules: replaceArtistRules
  };
})(window);
