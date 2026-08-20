/* Genre lookup against MusicBrainz.
 *
 * The built-in artist table only knows what someone thought to type into it.
 * MusicBrainz knows about everyone, so an artist nobody has tagged can still
 * be placed automatically.
 *
 * Two rules govern everything here:
 *
 *   - MusicBrainz asks anonymous clients for no more than one request per
 *     second. A browser cannot set a User-Agent to identify itself either, so
 *     the least this can do is stay well inside the rate limit and never ask
 *     the same question twice. Every answer is cached, including "no match".
 *   - A wrong match is worse than no match: it puts a confident, incorrect
 *     genre on a whole artist. So a result is only accepted when the name
 *     really matches, or MusicBrainz itself is highly confident.
 */
(function (global) {
  'use strict';

  var WS = 'https://musicbrainz.org/ws/2';
  var GAP_MS = 1100;          // just over their one-per-second limit
  var MIN_SCORE = 90;         // for a name that does not match exactly

  var queue = [];
  var running = false;
  var lastCall = 0;

  /* Every call goes through here, so nothing can outrun the rate limit no
   * matter how many lookups are asked for at once. */
  function schedule(fn) {
    return new Promise(function (resolve, reject) {
      queue.push({ fn: fn, resolve: resolve, reject: reject });
      pump();
    });
  }

  function pump() {
    if (running || !queue.length) return;
    running = true;

    var wait = Math.max(0, GAP_MS - (Date.now() - lastCall));
    setTimeout(function () {
      var job = queue.shift();
      lastCall = Date.now();

      job.fn().then(job.resolve, job.reject).then(function () {
        running = false;
        pump();
      });
    }, wait);
  }

  function get(url) {
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('MusicBrainz returned HTTP ' + res.status);
        return res.json();
      });
  }

  function normalise(name) {
    return global.Genres ? global.Genres.normaliseArtist(name)
                         : String(name || '').toLowerCase().trim();
  }

  /* MusicBrainz search is fuzzy, which is what we want for a misspelled
   * filename - but it will happily return something for nonsense too. Accept
   * a match only when the name lines up or the score is very high. */
  function pickMatch(query, artists) {
    if (!artists || !artists.length) return null;
    var wanted = normalise(query);

    for (var i = 0; i < artists.length; i++) {
      var a = artists[i];
      if (normalise(a.name) === wanted) return a;

      var aliases = a.aliases || [];
      for (var j = 0; j < aliases.length; j++) {
        if (normalise(aliases[j].name) === wanted) return a;
      }
    }

    return artists[0].score >= MIN_SCORE ? artists[0] : null;
  }

  /* MusicBrainz genres and tags are free-form ("synthpop", "psychedelic
   * rock", "neo soul"). Run them through the same keyword matcher the rest
   * of the player uses, weighting genres over folksonomy tags. */
  function toTaxonomy(entity) {
    var words = [];

    (entity.genres || []).forEach(function (g) {
      // Genres are curated; count them twice so they outweigh loose tags.
      words.push(g.name, g.name);
    });

    (entity.tags || []).forEach(function (t) {
      if ((t.count || 0) > 0) words.push(t.name);
    });

    if (!words.length) return [];
    return global.Genres ? global.Genres.tagsFromText(words.join(' ')) : [];
  }

  /* Resolves to { name, mbid, tags } - tags possibly empty, meaning
   * "MusicBrainz knows them but says nothing useful about their genre" -
   * or null when there is no confident match at all. */
  function lookupArtist(name) {
    if (!name) return Promise.resolve(null);

    var search = WS + '/artist?fmt=json&limit=5&query=' +
      encodeURIComponent('artist:"' + String(name).replace(/"/g, '') + '"');

    return schedule(function () { return get(search); })
      .then(function (data) {
        var match = pickMatch(name, data.artists);
        if (!match) return null;

        var detail = WS + '/artist/' + encodeURIComponent(match.id) +
          '?fmt=json&inc=genres+tags';

        return schedule(function () { return get(detail); })
          .then(function (full) {
            return { name: full.name || match.name, mbid: match.id, tags: toTaxonomy(full) };
          })
          .catch(function () {
            // The detail call failed; the search result's own tags will do.
            return { name: match.name, mbid: match.id, tags: toTaxonomy(match) };
          });
      })
      .catch(function () { return null; });
  }

  function pending() {
    return queue.length;
  }

  function cancelAll() {
    queue.forEach(function (job) { job.resolve(null); });
    queue = [];
  }

  global.MusicBrainz = {
    lookupArtist: lookupArtist,
    pending: pending,
    cancelAll: cancelAll,
    GAP_MS: GAP_MS
  };
})(window);
