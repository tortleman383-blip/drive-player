/* Album art, stored as small thumbnails in IndexedDB.
 *
 * The important constraint is that artwork costs no extra requests. The tag
 * pass already downloads the first 256 KB of a file, and an embedded cover
 * is usually sitting right there in it - so the picture is taken from bytes
 * we already have, shrunk, and kept. Fetching a cover per track would be a
 * request per track, which is the exact pattern that gets a network blocked.
 *
 * Thumbnails are ~128px, which is enough for a list row, a browse card and
 * the now playing corner, and lands around 4-8 KB each. localStorage is the
 * wrong home for that many blobs, hence IndexedDB.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'drivePlayer';
  var STORE = 'thumbs';
  var MAX_EDGE = 128;
  var LIVE_URLS = 240;      // object URLs held at once

  var dbPromise = null;
  var urls = {};            // id -> object URL
  var order = [];           // ids, oldest first
  var missing = {};         // ids known to have no art, so we stop asking

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('no IndexedDB'));

      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    }).catch(function (e) {
      dbPromise = null;     // let a later call try again
      throw e;
    });

    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* Shrinks whatever the tag carried into something list-sized. Resolves to
   * null rather than throwing when the bytes are not a usable image. */
  function makeThumbnail(bytes, mime) {
    return new Promise(function (resolve) {
      var blob = new Blob([bytes], { type: mime || 'image/jpeg' });
      var url = URL.createObjectURL(blob);
      var img = new Image();

      img.onload = function () {
        URL.revokeObjectURL(url);

        var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        canvas.toBlob(function (out) { resolve(out || null); }, 'image/jpeg', 0.72);
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };

      img.src = url;
    });
  }

  function remember(id, url) {
    urls[id] = url;
    order.push(id);

    while (order.length > LIVE_URLS) {
      var old = order.shift();
      if (old === id) continue;
      if (urls[old]) {
        URL.revokeObjectURL(urls[old]);
        delete urls[old];
      }
    }
  }

  /* Stores a cover taken from a tag. modifiedTime rides along so the entry
   * can be spotted as stale if the file is replaced in Drive. */
  function put(id, modifiedTime, picture) {
    if (!picture || !picture.data) {
      missing[id] = true;
      return Promise.resolve(null);
    }

    return makeThumbnail(picture.data, picture.mime).then(function (thumb) {
      if (!thumb) { missing[id] = true; return null; }

      return tx('readwrite', function (store) {
        return store.put({ blob: thumb, modifiedTime: modifiedTime || '' }, id);
      }).then(function () {
        var url = URL.createObjectURL(thumb);
        remember(id, url);
        return url;
      }).catch(function () {
        // No database: still usable for this session.
        var url = URL.createObjectURL(thumb);
        remember(id, url);
        return url;
      });
    });
  }

  /* Resolves to an object URL, or null when there is no stored art. Cheap to
   * call repeatedly: results and misses are both remembered. */
  function get(id, modifiedTime) {
    if (urls[id]) return Promise.resolve(urls[id]);
    if (missing[id]) return Promise.resolve(null);

    return tx('readonly', function (store) { return store.get(id); })
      .then(function (entry) {
        if (!entry || !entry.blob) { missing[id] = true; return null; }
        if (modifiedTime && entry.modifiedTime && entry.modifiedTime !== modifiedTime) {
          missing[id] = true;    // the file changed; the tag pass will replace it
          return null;
        }

        var url = URL.createObjectURL(entry.blob);
        remember(id, url);
        return url;
      })
      .catch(function () { return null; });
  }

  function has(id) {
    return !!urls[id];
  }

  function clear() {
    Object.keys(urls).forEach(function (id) { URL.revokeObjectURL(urls[id]); });
    urls = {};
    order = [];
    missing = {};
    return tx('readwrite', function (store) { return store.clear(); })
      .catch(function () { return null; });
  }

  global.Artwork = {
    put: put,
    get: get,
    has: has,
    clear: clear,
    MAX_EDGE: MAX_EDGE
  };
})(window);
