/* Wiring: load the library, tag it, draw it, and hook up the controls. */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    setup: $('setup'), setupFolder: $('setup-folder'), setupKey: $('setup-key'),
    setupGo: $('setup-go'), setupError: $('setup-error'),
    app: $('app'), search: $('search'), refresh: $('btn-refresh'),
    main: document.querySelector('.main'),
    settings: $('btn-settings'), genres: $('genres'), status: $('status'),
    list: $('tracklist'), empty: $('empty'),
    npImg: $('np-img'), npTitle: $('np-title'), npArtist: $('np-artist'),
    shuffle: $('btn-shuffle'), prev: $('btn-prev'), play: $('btn-play'),
    next: $('btn-next'), repeat: $('btn-repeat'), repeatBadge: $('repeat-badge'),
    playIcon: $('play-icon'), volIcon: $('vol-icon'),
    timeNow: $('time-now'), timeTotal: $('time-total'), seek: $('seek'),
    seekFill: $('seek-fill'), seekBuffer: $('seek-buffer'),
    mute: $('btn-mute'), volume: $('volume'),
    tagdlg: $('tagdlg'), tagdlgTitle: $('tagdlg-title'), tagdlgSub: $('tagdlg-sub'),
    tagdlgTags: $('tagdlg-tags'), tagdlgCustom: $('tagdlg-custom'),
    tagdlgSave: $('tagdlg-save'), tagdlgCancel: $('tagdlg-cancel'),
    tagdlgReset: $('tagdlg-reset'), tagdlgArtist: $('tagdlg-artist'),
    tagdlgArtistRow: $('tagdlg-artistrow'), tagdlgArtistLabel: $('tagdlg-artistlabel'),
    setdlg: $('setdlg'), setFolder: $('set-folder'), setKey: $('set-key'),
    setSave: $('set-save'), setCancel: $('set-cancel'), setExport: $('set-export'),
    setImport: $('set-import'), setFile: $('set-file'), setClearCache: $('set-clearcache'),
    setUntagged: $('set-untagged'), setLookup: $('set-lookup'),
    toast: $('toast'), audio: $('audio')
  };

  var settings = Store.getSettings();
  var player = new Player(els.audio);

  var tracks = [];       // everything in the folder
  var view = [];         // what the filter and search leave visible
  var genre = settings.genre || 'All';
  var query = '';
  var editing = null;    // track open in the tag dialog

  /* ---------- helpers ---------- */

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 3200);
  }

  function setStatus(msg, isError) {
    if (!msg) { els.status.hidden = true; return; }
    els.status.textContent = msg;
    els.status.className = 'status' + (isError ? ' error' : '');
    els.status.hidden = false;
  }

  /* ---------- library ---------- */

  function displayName(t) {
    return t.title || Drive.parseFileName(t.fileName).title || t.fileName;
  }

  /* Fills in artist/title/tags from whatever we know so far: the ID3 tag if
   * we have read it, the filename otherwise. */
  // Folders people actually keep music in that say nothing about who made it.
  var GENERIC_FOLDERS = /^(music|songs?|audio|mp3s?|tracks?|media|downloads?|new folder|untitled|misc|stuff|files|shared|favou?rites)$/i;

  /* For files named as a bare title - no artist anywhere in the name - two
   * things are still worth a look before giving up: a known artist sitting at
   * the front of the filename, and the folder the file lives in, since a
   * library organised as "Tame Impala/Elephant.mp3" says exactly who it is. */
  function rescueArtist(track, guess) {
    var found = Genres.findArtistIn(guess.title || track.fileName);
    if (found) {
      // Use the spelling from the table rather than the filename's casing.
      return found.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    var folder = String(track.folder || '').split('/')[0].trim();
    if (folder && !GENERIC_FOLDERS.test(folder)) return folder;

    return '';
  }

  function applyMetadata(track, meta) {
    // nameGuess comes from the library-wide pass, which knows which half of
    // the filename is the artist; fall back if a track arrived on its own.
    var guess = track.nameGuess || Drive.parseFileName(track.fileName);

    track.title = (meta && meta.title) || guess.title || track.fileName;
    track.artist = (meta && (meta.artist || meta.albumArtist)) || guess.artist ||
      rescueArtist(track, guess) || '';
    track.album = (meta && meta.album) || '';
    track.id3Genre = (meta && meta.genre) || '';
    track.tagged = !!meta;

    var override = Store.getOverride(track);
    var artistRule = Store.getArtistRule(track.artist);
    var online = Store.getOnline(track.artist);

    track.tags = Genres.orderTags(
      Genres.inferTags(track, override, artistRule, online && online.tags));
    track.custom = !!(override || artistRule);
    track.haystack = [track.title, track.artist, track.album, track.fileName]
      .join(' ').toLowerCase();
  }

  function buildTrack(file) {
    var track = {
      id: file.id,
      fileName: file.fileName,
      folder: file.folder,
      size: file.size,
      modifiedTime: file.modifiedTime,
      nameGuess: file.nameGuess,
      url: Drive.streamUrl(file.id, settings.apiKey),
      duration: 0,
      dead: false
    };

    var cached = Store.cacheGet(file.id, file.modifiedTime);
    applyMetadata(track, cached ? cached.meta : null);
    if (cached) track.tagged = true;   // already inspected; do not re-fetch
    if (cached && cached.duration) track.duration = cached.duration;
    track.cachedArt = cached ? !!cached.art : false;

    return track;
  }

  function loadLibrary() {
    setStatus('Reading the folder…');
    els.refresh.disabled = true;

    return Drive.listTracks(settings.folderId, settings.apiKey, function (n) {
      setStatus('Found ' + n + ' track' + (n === 1 ? '' : 's') + '…');
    }).then(function (files) {
      var guesses = Drive.parseLibrary(files.map(function (f) { return f.fileName; }));
      files.forEach(function (f, i) { f.nameGuess = guesses[i]; });

      tracks = files.map(buildTrack);
      els.refresh.disabled = false;

      if (!tracks.length) {
        setStatus('No audio files in that folder. Check the link, or that the ' +
          'files are audio rather than shortcuts.', true);
      } else {
        setStatus('');
      }

      renderGenres();
      applyFilter();
      enrichAll();
      return tracks;
    }).catch(function (err) {
      els.refresh.disabled = false;
      setStatus(err.message || String(err), true);
      throw err;
    });
  }

  /* ---------- metadata enrichment ----------
   * Read the head of each untagged file, a few at a time, and fold the ID3
   * tag in as it arrives. Cached files are skipped, so this only costs
   * anything the first time a library is opened. */

  var enrichQueue = [];
  var enrichActive = 0;
  var ENRICH_CONCURRENCY = 4;
  var redrawTimer = null;

  function scheduleRedraw() {
    if (redrawTimer) return;
    redrawTimer = setTimeout(function () {
      redrawTimer = null;
      renderGenres();
      applyFilter();
    }, 400);
  }

  function enrichAll() {
    enrichQueue = tracks.filter(function (t) { return !t.tagged; });
    if (!enrichQueue.length) return;
    for (var i = 0; i < ENRICH_CONCURRENCY; i++) enrichNext();
  }

  function enrichNext() {
    if (!enrichQueue.length) {
      if (enrichActive === 0) scheduleRedraw();
      return;
    }

    var track = enrichQueue.shift();
    enrichActive++;

    Drive.fetchTagBytes(track.id, settings.apiKey).then(function (result) {
      if (!result.ok) {
        // Drive would not hand over the bytes. Leave the track untagged so
        // the next load tries again, rather than recording a verdict we did
        // not actually reach.
        return;
      }

      var meta = result.buffer ? ID3.parse(result.buffer) : null;
      if (meta) {
        applyMetadata(track, meta);
        Store.cacheSet(track.id, {
          modifiedTime: track.modifiedTime,
          art: !!meta.picture,
          meta: {
            title: meta.title, artist: meta.artist, albumArtist: meta.albumArtist,
            album: meta.album, genre: meta.genre
          }
        });
        track.cachedArt = !!meta.picture;
        scheduleRedraw();
      } else {
        // Genuinely no tag in the file: remember, so a reload does not retry.
        Store.cacheSet(track.id, { modifiedTime: track.modifiedTime, art: false, meta: null });
        track.tagged = true;
      }
    }).catch(function () {
      /* leave it on the filename guess */
    }).then(function () {
      enrichActive--;
      enrichNext();
    });
  }

  /* ---------- artwork ----------
   * Pulled on demand for the track being played, with a small cache, so a
   * big library does not sit on a pile of decoded images. */

  var artCache = {};
  var artOrder = [];

  function showArtwork(url) {
    if (url) {
      els.npImg.src = url;
      els.npImg.hidden = false;
    } else {
      els.npImg.removeAttribute('src');
      els.npImg.hidden = true;
    }
  }

  function loadArtwork(track) {
    if (artCache[track.id]) {
      track.artworkUrl = artCache[track.id];
      showArtwork(track.artworkUrl);
      player.updateMediaSession(track);
      return;
    }

    showArtwork(null);
    if (track.cachedArt === false && track.tagged) return;

    Drive.fetchTagBytes(track.id, settings.apiKey).then(function (result) {
      var meta = result.ok && result.buffer ? ID3.parse(result.buffer) : null;
      if (!meta || !meta.picture) return;

      var blob = new Blob([meta.picture.data], { type: meta.picture.mime });
      var url = URL.createObjectURL(blob);

      artCache[track.id] = url;
      artOrder.push(track.id);
      while (artOrder.length > 20) {
        var old = artOrder.shift();
        URL.revokeObjectURL(artCache[old]);
        delete artCache[old];
      }

      var np = player.nowPlaying();
      if (np && np.id === track.id) {
        track.artworkUrl = url;
        showArtwork(url);
        player.updateMediaSession(track);
      }
    }).catch(function () {});
  }

  /* ---------- filtering ---------- */

  function matches(track) {
    if (genre !== 'All' && track.tags.indexOf(genre) === -1) return false;
    if (query && track.haystack.indexOf(query) === -1) return false;
    return true;
  }

  function applyFilter() {
    view = tracks.filter(matches);
    player.setQueue(view);
    renderList();
  }

  function genreCounts() {
    var counts = {};
    tracks.forEach(function (t) {
      t.tags.forEach(function (tag) { counts[tag] = (counts[tag] || 0) + 1; });
    });
    return counts;
  }

  function renderGenres() {
    var counts = genreCounts();

    // Taxonomy order first, then anything the listener invented, and only
    // genres that something is actually tagged with.
    var known = Genres.TAXONOMY.filter(function (g) { return counts[g]; });
    var extra = Object.keys(counts).filter(function (g) {
      return Genres.TAXONOMY.indexOf(g) === -1;
    }).sort();

    var list = ['All'].concat(known, extra);
    if (list.indexOf(genre) === -1) genre = 'All';

    els.genres.textContent = '';
    list.forEach(function (g) {
      var b = document.createElement('button');
      b.className = 'chip' + (g === genre ? ' on' : '');
      b.type = 'button';
      b.textContent = g;

      var n = g === 'All' ? tracks.length : counts[g];
      var count = document.createElement('span');
      count.className = 'count';
      count.textContent = n;
      b.appendChild(count);

      b.addEventListener('click', function () {
        genre = g;
        Store.saveSettings({ genre: g });
        renderGenres();
        applyFilter();
        els.main.scrollTop = 0;
      });

      els.genres.appendChild(b);
    });
  }

  function renderList() {
    var current = player.nowPlaying();
    var scroll = els.main.scrollTop;
    els.list.textContent = '';
    els.empty.hidden = view.length > 0;

    var frag = document.createDocumentFragment();

    view.forEach(function (track, i) {
      var li = document.createElement('li');
      li.className = 'track';
      if (current && current.id === track.id) li.className += ' playing';
      if (track.dead) li.className += ' dead';

      var num = document.createElement('div');
      num.className = 'track-num';
      num.textContent = i + 1;

      var main = document.createElement('div');
      main.className = 'track-main';

      var title = document.createElement('div');
      title.className = 'track-title';
      title.textContent = displayName(track);

      var artist = document.createElement('div');
      artist.className = 'track-artist';
      artist.textContent = track.artist || 'Unknown artist';

      main.appendChild(title);
      main.appendChild(artist);

      var tags = document.createElement('div');
      tags.className = 'track-tags';

      var shown = track.tags.slice(0, 2);
      shown.forEach(function (tag) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'tag' + (tag === 'Unsorted' ? ' unsorted' : '');
        b.textContent = tag;
        b.title = 'Edit genres for this track';
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          openTagDialog(track);
        });
        tags.appendChild(b);
      });

      if (track.tags.length > shown.length) {
        var more = document.createElement('span');
        more.className = 'tag more';
        more.textContent = '+' + (track.tags.length - shown.length);
        tags.appendChild(more);
      }

      var dur = document.createElement('div');
      dur.className = 'track-dur';
      dur.textContent = track.duration ? fmtTime(track.duration) : '';
      li.dataset.trackId = track.id;

      li.appendChild(num);
      li.appendChild(main);
      li.appendChild(tags);
      li.appendChild(dur);

      li.addEventListener('click', function () { player.playIndex(i); });
      frag.appendChild(li);
    });

    els.list.appendChild(frag);
    els.main.scrollTop = scroll;   // redraws during tagging must not jump
  }

  function highlightPlaying() {
    var current = player.nowPlaying();
    var rows = els.list.children;
    for (var i = 0; i < rows.length; i++) {
      var isIt = current && view[i] && view[i].id === current.id;
      rows[i].classList.toggle('playing', !!isIt);
    }
  }

  /* ---------- transport UI ---------- */

  function renderNowPlaying(track) {
    if (!track) {
      els.npTitle.textContent = 'Nothing playing';
      els.npArtist.textContent = 'Pick a track, or hit shuffle';
      showArtwork(null);
      return;
    }
    els.npTitle.textContent = displayName(track);
    els.npArtist.textContent = [track.artist || 'Unknown artist']
      .concat(track.tags.length ? track.tags.join(' · ') : [])
      .join(' — ');
    loadArtwork(track);
  }

  function renderState() {
    var paused = els.audio.paused;
    els.playIcon.setAttribute('href', paused ? '#i-play' : '#i-pause');
    els.play.title = paused ? 'Play (Space)' : 'Pause (Space)';

    els.shuffle.classList.toggle('on', player.shuffle);
    els.repeat.classList.toggle('on', player.repeat !== 'off');
    els.repeatBadge.hidden = player.repeat !== 'one';

    var muted = els.audio.muted || els.audio.volume === 0;
    els.volIcon.setAttribute('href', muted ? '#i-mute' : '#i-volume');
    els.volume.value = els.audio.muted ? 0 : els.audio.volume;
  }

  function renderTime() {
    var a = els.audio;
    var d = isFinite(a.duration) ? a.duration : 0;
    var pct = d ? (a.currentTime / d) * 100 : 0;

    els.seekFill.style.width = pct + '%';
    els.timeNow.textContent = fmtTime(a.currentTime);
    els.timeTotal.textContent = fmtTime(d);
    els.seek.setAttribute('aria-valuenow', Math.round(pct));

    var buffered = 0;
    if (a.buffered.length && d) buffered = (a.buffered.end(a.buffered.length - 1) / d) * 100;
    els.seekBuffer.style.width = buffered + '%';

    // Duration is only known once the file loads; keep it for the list.
    // Patch the one cell rather than redrawing: a full rebuild detaches every
    // row, and a click that lands mid-rebuild is lost.
    var track = player.nowPlaying();
    if (track && d && !track.duration) {
      track.duration = d;
      Store.cacheSet(track.id, { modifiedTime: track.modifiedTime, duration: d });

      var row = els.list.querySelector('[data-track-id="' + track.id + '"] .track-dur');
      if (row) row.textContent = fmtTime(d);
    }
  }

  /* ---------- tag dialog ---------- */

  function retagAll() {
    tracks.forEach(function (t) {
      var cached = Store.cacheGet(t.id, t.modifiedTime);
      applyMetadata(t, cached ? cached.meta : null);
    });
    renderGenres();
    applyFilter();
    renderNowPlaying(player.nowPlaying());
  }

  function openTagDialog(track) {
    editing = track;
    els.tagdlgTitle.textContent = displayName(track);
    els.tagdlgSub.textContent = (track.artist || 'Unknown artist') +
      (track.custom ? ' · edited by you' : ' · auto-tagged');

    var selected = track.tags.slice();
    els.tagdlgTags.textContent = '';

    Genres.TAXONOMY.forEach(function (g) {
      if (g === 'Unsorted') return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (selected.indexOf(g) !== -1 ? ' on' : '');
      b.textContent = g;
      b.addEventListener('click', function () {
        var at = selected.indexOf(g);
        if (at === -1) selected.push(g); else selected.splice(at, 1);
        b.classList.toggle('on', at === -1);
      });
      els.tagdlgTags.appendChild(b);
    });

    els.tagdlgCustom.value = selected.filter(function (g) {
      return Genres.TAXONOMY.indexOf(g) === -1;
    }).join(', ');

    // Tagging by artist is how a library actually gets sorted: one decision
    // covers every track by them, including ones not loaded yet.
    if (track.artist) {
      els.tagdlgArtistLabel.textContent = 'Apply to everything by ' + track.artist;
      els.tagdlgArtist.checked = !!Store.getArtistRule(track.artist);
      els.tagdlgArtistRow.hidden = false;
    } else {
      els.tagdlgArtist.checked = false;
      els.tagdlgArtistRow.hidden = true;
    }

    els.tagdlg._selected = selected;
    els.tagdlg.hidden = false;
  }

  function closeTagDialog() {
    els.tagdlg.hidden = true;
    editing = null;
  }

  els.tagdlgSave.addEventListener('click', function () {
    if (!editing) return closeTagDialog();

    var selected = els.tagdlg._selected.filter(function (g) {
      return Genres.TAXONOMY.indexOf(g) !== -1;
    });

    els.tagdlgCustom.value.split(',').forEach(function (raw) {
      var t = raw.trim();
      if (t && selected.indexOf(t) === -1) selected.push(t);
    });

    var byArtist = els.tagdlgArtist.checked && editing.artist;
    var artist = editing.artist;

    if (byArtist) {
      // The rule carries the tags; a leftover track override would just mask
      // it for this one song.
      Store.setArtistRule(artist, selected);
      Store.setOverride(editing, null);
    } else {
      Store.setOverride(editing, selected);
      if (Store.getArtistRule(artist)) Store.setArtistRule(artist, null);
    }

    closeTagDialog();
    retagAll();

    if (byArtist) {
      var n = tracks.filter(function (t) {
        return Genres.normaliseArtist(t.artist) === Genres.normaliseArtist(artist);
      }).length;
      toast('Tagged ' + n + ' track' + (n === 1 ? '' : 's') + ' by ' + artist + '.');
    }
  });

  els.tagdlgReset.addEventListener('click', function () {
    if (!editing) return closeTagDialog();
    Store.setOverride(editing, null);
    if (editing.artist) Store.setArtistRule(editing.artist, null);
    closeTagDialog();
    retagAll();
  });

  els.tagdlgCancel.addEventListener('click', closeTagDialog);

  /* ---------- settings dialog ---------- */

  function openSettings() {
    els.setFolder.value = settings.folderId;
    els.setKey.value = settings.apiKey;
    els.setdlg.hidden = false;
  }

  els.settings.addEventListener('click', openSettings);
  els.setCancel.addEventListener('click', function () { els.setdlg.hidden = true; });

  els.setSave.addEventListener('click', function () {
    var folderId = Drive.folderIdFrom(els.setFolder.value);
    var apiKey = els.setKey.value.trim();

    if (!folderId || !apiKey) { toast('Need both a folder and a key.'); return; }

    var changed = folderId !== settings.folderId;
    settings = Store.saveSettings({ folderId: folderId, apiKey: apiKey });
    els.setdlg.hidden = true;

    if (changed) Store.clearCache();
    loadLibrary().catch(function () {});
  });

  els.setClearCache.addEventListener('click', function () {
    Store.clearCache();
    toast('Metadata cache cleared. Reloading…');
    loadLibrary().catch(function () {});
  });

  function download(name, data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  els.setExport.addEventListener('click', function () {
    download('drive-player-genres.json', {
      version: 2,
      artists: Store.getArtistRules(),
      tracks: Store.getOverrides()
    });
  });

  /* Writes out every artist the player could not place, with an empty tag
   * list each, so the file can be filled in and imported straight back. */
  els.setUntagged.addEventListener('click', function () {
    var artists = {};
    var namelessCount = 0;

    tracks.forEach(function (t) {
      if (t.tags.length && t.tags[0] !== 'Unsorted') return;
      if (!t.artist) { namelessCount++; return; }
      if (!artists[t.artist]) artists[t.artist] = [];
    });

    var names = Object.keys(artists).sort();
    if (!names.length) {
      toast(namelessCount ? 'Every named artist is tagged already.'
                          : 'Nothing is untagged.');
      return;
    }

    var out = {};
    names.forEach(function (n) { out[n] = []; });

    download('drive-player-untagged-artists.json', {
      version: 2,
      note: 'Fill in the tag lists, e.g. ["Synth", "Psych"], then import this ' +
            'file from Settings. Anything left empty is ignored.',
      genres: Genres.TAXONOMY.filter(function (g) { return g !== 'Unsorted'; }),
      artists: out
    });

    toast('Exported ' + names.length + ' untagged artist' +
      (names.length === 1 ? '' : 's') +
      (namelessCount ? ' (' + namelessCount + ' file(s) have no artist at all)' : '') + '.');
  });

  els.setImport.addEventListener('click', function () { els.setFile.click(); });

  /* Asks MusicBrainz about every artist still sitting in Unsorted. One
   * request a second, so this is deliberately slow and deliberately visible;
   * results land as they arrive rather than all at the end. */
  var lookingUp = false;

  els.setLookup.addEventListener('click', function () {
    if (lookingUp) {
      MusicBrainz.cancelAll();
      lookingUp = false;
      els.setLookup.textContent = 'Look up genres online';
      setStatus('');
      return;
    }

    var todo = [];
    var seen = {};

    tracks.forEach(function (t) {
      if (!t.artist) return;
      if (t.tags.length && t.tags[0] !== 'Unsorted') return;

      var key = Genres.normaliseArtist(t.artist);
      if (seen[key] || Store.getOnline(t.artist)) return;   // asked already
      seen[key] = true;
      todo.push(t.artist);
    });

    if (!todo.length) {
      toast('Nothing left to look up.');
      return;
    }

    lookingUp = true;
    els.setLookup.textContent = 'Stop looking up';
    els.setdlg.hidden = true;

    var done = 0;
    var found = 0;

    // Rough, but honest: two requests per artist at ~1.1s each.
    var estimate = Math.ceil((todo.length * 2 * MusicBrainz.GAP_MS) / 1000);
    setStatus('Asking MusicBrainz about ' + todo.length + ' artist' +
      (todo.length === 1 ? '' : 's') + ' — about ' +
      (estimate > 90 ? Math.ceil(estimate / 60) + ' minutes' : estimate + ' seconds') +
      '. You can keep listening.');

    todo.forEach(function (artist) {
      MusicBrainz.lookupArtist(artist).then(function (result) {
        if (!lookingUp) return;
        done++;

        if (result) {
          Store.setOnline(artist, result.tags, result.mbid);
          if (result.tags.length) found++;
        } else {
          Store.setOnline(artist, [], '');   // remember the miss
        }

        if (done % 5 === 0 || done === todo.length) retagAll();

        if (done === todo.length) {
          lookingUp = false;
          els.setLookup.textContent = 'Look up genres online';
          retagAll();
          setStatus('');
          toast('MusicBrainz placed ' + found + ' of ' + todo.length + ' artists.');
        } else {
          setStatus('Asking MusicBrainz… ' + done + ' of ' + todo.length +
            ' (' + found + ' placed so far). You can keep listening.');
        }
      });
    });
  });

  els.setFile.addEventListener('change', function () {
    var file = els.setFile.files[0];
    if (!file) return;

    file.text().then(function (text) {
      var data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('not an object');

      var artists = 0;
      var trackEdits = 0;

      if (data.artists || data.tracks) {
        // Current format. Artist rules merge, so importing a file covering
        // part of the library never wipes work already done.
        if (data.artists) artists = Store.replaceArtistRules(data.artists, true);
        if (data.tracks) {
          Store.replaceOverrides(data.tracks);
          trackEdits = Object.keys(data.tracks).length;
        }
      } else {
        // The original export was a bare map of per-track edits.
        Store.replaceOverrides(data);
        trackEdits = Object.keys(data).length;
      }

      retagAll();

      var parts = [];
      if (artists) parts.push(artists + ' artist rule' + (artists === 1 ? '' : 's'));
      if (trackEdits) parts.push(trackEdits + ' track edit' + (trackEdits === 1 ? '' : 's'));
      toast(parts.length ? 'Imported ' + parts.join(' and ') + '.'
                         : 'That file had nothing to import.');
    }).catch(function () {
      toast('That file did not look like an export.');
    });

    els.setFile.value = '';
  });

  /* ---------- transport wiring ---------- */

  els.play.addEventListener('click', function () { player.toggle(); });
  els.prev.addEventListener('click', function () { player.prev(); });
  els.next.addEventListener('click', function () { player.next(); });

  els.shuffle.addEventListener('click', function () {
    player.setShuffle(!player.shuffle);
    Store.saveSettings({ shuffle: player.shuffle });
    toast(player.shuffle ? 'Shuffle on' : 'Shuffle off');
  });

  els.repeat.addEventListener('click', function () {
    var order = ['all', 'one', 'off'];
    var mode = order[(order.indexOf(player.repeat) + 1) % order.length];
    player.setRepeat(mode);
    Store.saveSettings({ repeat: mode });
    toast(mode === 'one' ? 'Repeat one' : mode === 'all' ? 'Repeat all' : 'Repeat off');
  });

  els.volume.addEventListener('input', function () {
    els.audio.muted = false;
    player.setVolume(parseFloat(els.volume.value));
    Store.saveSettings({ volume: els.audio.volume });
  });

  els.mute.addEventListener('click', function () {
    els.audio.muted = !els.audio.muted;
    renderState();
  });

  els.search.addEventListener('input', function () {
    query = els.search.value.trim().toLowerCase();
    applyFilter();
  });

  els.refresh.addEventListener('click', function () { loadLibrary().catch(function () {}); });

  /* Seeking: pointer drag anywhere on the bar, plus arrow keys when focused. */
  function seekFromEvent(e) {
    var rect = els.seek.getBoundingClientRect();
    var ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.max(0, Math.min(1, ratio));
    if (isFinite(els.audio.duration)) player.seek(ratio * els.audio.duration);
  }

  els.seek.addEventListener('pointerdown', function (e) {
    els.seek.setPointerCapture(e.pointerId);
    seekFromEvent(e);
    var move = function (ev) { seekFromEvent(ev); };
    var up = function () {
      els.seek.removeEventListener('pointermove', move);
      els.seek.removeEventListener('pointerup', up);
    };
    els.seek.addEventListener('pointermove', move);
    els.seek.addEventListener('pointerup', up);
  });

  els.seek.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { player.nudge(5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { player.nudge(-5); e.preventDefault(); }
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

    if (e.key === 'Escape') {
      if (!els.tagdlg.hidden) closeTagDialog();
      else if (!els.setdlg.hidden) els.setdlg.hidden = true;
      else if (typing) e.target.blur();
      return;
    }

    if (e.key === '/' && !typing) { e.preventDefault(); els.search.focus(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ': e.preventDefault(); player.toggle(); break;
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? player.next() : player.nudge(5); break;
      case 'ArrowLeft': e.preventDefault(); e.shiftKey ? player.prev() : player.nudge(-5); break;
      case 'ArrowUp': e.preventDefault(); player.setVolume(els.audio.volume + 0.05); break;
      case 'ArrowDown': e.preventDefault(); player.setVolume(els.audio.volume - 0.05); break;
      case 's': case 'S': els.shuffle.click(); break;
      case 'l': case 'L': els.repeat.click(); break;
      case 'm': case 'M': els.mute.click(); break;
      case 'n': case 'N': player.next(); break;
      case 'p': case 'P': player.prev(); break;
    }
  });

  /* ---------- player events ---------- */

  player.on('change', function (track) {
    renderNowPlaying(track);
    highlightPlaying();
    document.title = displayName(track) + ' — Drive Player';
  });

  player.on('state', renderState);
  player.on('time', renderTime);
  player.on('queue', highlightPlaying);

  /* The <audio> element only ever reports "something went wrong". Ask Drive
   * directly what happened, once, and put the real answer on screen. */
  var diagnosing = false;
  var diagnosed = false;

  function diagnose(track) {
    if (diagnosing || diagnosed) return;
    diagnosing = true;

    var mediaError = els.audio.error ? els.audio.error.code : 0;

    Drive.probe(track.id, settings.apiKey).then(function (result) {
      diagnosing = false;
      diagnosed = true;

      if (!result.ok) {
        setStatus(result.message, true);
        return;
      }

      // Drive handed over the bytes, so the file is reachable and the key is
      // fine - this browser just cannot play the format.
      var name = track.fileName || displayName(track);
      if (mediaError === 3 || mediaError === 4) {
        setStatus('Drive is serving these files fine, but this browser cannot ' +
          'decode them. "' + name + '" is in a format it does not support — ' +
          'WMA, ALAC and some M4A files do this. Converting the library to MP3 ' +
          'or AAC fixes it.', true);
      } else {
        setStatus('Playback of "' + name + '" failed even though Drive served ' +
          'the file. Try reloading; if every track does this, the audio format ' +
          'is probably the problem.', true);
      }
    });
  }

  player.on('error', function (track) {
    track.dead = true;
    toast('Could not play "' + displayName(track) + '" — skipping.');
    scheduleRedraw();
    diagnose(track);
  });

  player.on('stalled', function () {
    if (!diagnosed) {
      setStatus('Nothing will play. Working out why…', true);
    }
  });

  // A track that plays clears the diagnosis, so a single bad file does not
  // leave a permanent banner.
  els.audio.addEventListener('playing', function () {
    diagnosed = false;
    if (els.status.classList.contains('error')) setStatus('');
  });

  /* ---------- boot ---------- */

  function startApp() {
    els.setup.hidden = true;
    els.app.hidden = false;

    player.shuffle = !!settings.shuffle;
    player.repeat = settings.repeat || 'all';
    els.audio.volume = typeof settings.volume === 'number' ? settings.volume : 0.8;
    els.volume.value = els.audio.volume;
    renderState();

    loadLibrary().catch(function () {});
  }

  els.setupGo.addEventListener('click', function () {
    var folderId = Drive.folderIdFrom(els.setupFolder.value);
    var apiKey = els.setupKey.value.trim();

    if (!folderId) {
      els.setupError.textContent = 'That does not look like a Drive folder link.';
      els.setupError.hidden = false;
      return;
    }
    if (!apiKey) {
      els.setupError.textContent = 'Paste an API key to continue.';
      els.setupError.hidden = false;
      return;
    }

    settings = Store.saveSettings({ folderId: folderId, apiKey: apiKey });
    els.setupError.hidden = true;
    startApp();
  });

  els.setupKey.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') els.setupGo.click();
  });

  /* A folder can be handed to the page in its own URL - "#folder=<id>", or
   * the whole Drive link - so a bookmark opens ready to go. It lives in the
   * fragment rather than the page source: when this is hosted somewhere
   * public, the id of a link-shared folder is the only thing standing between
   * a stranger and the music, and the fragment is never sent to a server.
   * Keys are never read from the URL. */
  function folderFromLocation() {
    var query = (location.hash || '').replace(/^#/, '') ||
                (location.search || '').replace(/^\?/, '');
    var match = query.match(/(?:^|&)folder=([^&]*)/);
    if (!match) return '';
    try {
      return Drive.folderIdFrom(decodeURIComponent(match[1]));
    } catch (e) {
      return '';
    }
  }

  if (settings.apiKey && settings.folderId) {
    startApp();
  } else {
    els.setupFolder.value = settings.folderId || folderFromLocation();
    els.setup.hidden = false;
    (els.setupFolder.value ? els.setupKey : els.setupFolder).focus();
  }

  global.DrivePlayer = { player: player, tracks: function () { return tracks; } };
})(window);
