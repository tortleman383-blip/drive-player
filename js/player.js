/* The playback engine: one <audio> element, a queue, and a play order.
 *
 * The queue is whatever the current genre filter and search leave visible.
 * The order is a list of positions into that queue - sequential normally,
 * shuffled when shuffle is on - so "previous" walks back through the shuffle
 * the way it was actually heard rather than reshuffling.
 */
(function (global) {
  'use strict';

  function Player(audio) {
    this.audio = audio;
    this.queue = [];
    this.order = [];
    this.pos = -1;
    this.playing = null;   // what is actually loaded, even if filtered out
    this.errorStreak = 0;
    this.shuffle = false;
    this.repeat = 'all';
    this.listeners = {};

    var self = this;

    audio.addEventListener('ended', function () { self.onEnded(); });
    audio.addEventListener('timeupdate', function () { self.emit('time'); });
    audio.addEventListener('durationchange', function () { self.emit('time'); });
    audio.addEventListener('progress', function () { self.emit('time'); });
    audio.addEventListener('play', function () { self.emit('state'); });
    audio.addEventListener('pause', function () { self.emit('state'); });
    audio.addEventListener('waiting', function () { self.emit('state'); });
    audio.addEventListener('playing', function () {
      self.errorStreak = 0;
      self.emit('state');
    });

    audio.addEventListener('error', function () {
      var track = self.playing;
      if (!track) return;
      self.emit('error', track);

      // A single unplayable file should not end the session - but if nothing
      // plays at all (a bad key, say) stop rather than race through the
      // whole library.
      self.errorStreak++;
      if (self.autoAdvanceOnError && self.errorStreak < 5) self.next(true);
      else if (self.errorStreak >= 5) self.emit('stalled');
    });

    this.autoAdvanceOnError = true;
  }

  Player.prototype.on = function (name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
    return this;
  };

  Player.prototype.emit = function (name, arg) {
    (this.listeners[name] || []).forEach(function (fn) { fn(arg); });
  };

  /* The track at the current position in the play order. Null when the
   * filter has moved on past whatever is loaded - use nowPlaying() for
   * "what is coming out of the speakers". */
  Player.prototype.current = function () {
    if (this.pos < 0 || this.pos >= this.order.length) return null;
    return this.queue[this.order[this.pos]] || null;
  };

  Player.prototype.nowPlaying = function () {
    return this.playing;
  };

  function shuffled(n, first) {
    var idx = [];
    for (var i = 0; i < n; i++) if (i !== first) idx.push(i);
    for (var j = idx.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = idx[j]; idx[j] = idx[k]; idx[k] = t;
    }
    return first === undefined || first < 0 ? idx : [first].concat(idx);
  }

  /* Rebuilds the play order, keeping the current track playing and in place
   * so that changing the filter or toggling shuffle never cuts the audio. */
  Player.prototype.rebuildOrder = function (keepCurrent) {
    var track = keepCurrent ? this.playing : null;
    var keepAt = -1;

    if (track) {
      for (var i = 0; i < this.queue.length; i++) {
        if (this.queue[i].id === track.id) { keepAt = i; break; }
      }
    }

    if (this.shuffle) {
      this.order = shuffled(this.queue.length, keepAt);
      this.pos = keepAt >= 0 ? 0 : -1;
    } else {
      this.order = [];
      for (var j = 0; j < this.queue.length; j++) this.order.push(j);
      this.pos = keepAt;
    }

    this.emit('queue');
  };

  Player.prototype.setQueue = function (tracks) {
    this.queue = tracks || [];
    this.rebuildOrder(true);
  };

  Player.prototype.setShuffle = function (on) {
    this.shuffle = !!on;
    this.rebuildOrder(true);
    this.emit('state');
  };

  Player.prototype.setRepeat = function (mode) {
    this.repeat = mode;
    this.emit('state');
  };

  /* Start a specific track by its index in the queue. */
  Player.prototype.playIndex = function (queueIndex) {
    var at = this.order.indexOf(queueIndex);
    if (at === -1) return;

    // Jumping into a shuffled queue by hand: move that track to the front of
    // what is left, so the rest of the shuffle still plays out after it.
    if (this.shuffle) {
      this.order.splice(at, 1);
      if (at < this.pos) this.pos--;   // removing it shifted us back one
      this.order.splice(this.pos + 1, 0, queueIndex);
      at = this.pos + 1;
    }

    this.pos = at;
    this.load(true);
  };

  Player.prototype.load = function (autoplay) {
    var track = this.current();
    if (!track) return;

    this.playing = track;
    this.audio.src = track.url;
    this.audio.load();
    this.emit('change', track);
    this.updateMediaSession(track);

    if (autoplay) {
      var p = this.audio.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked; user will press play */ });
    }
  };

  Player.prototype.toggle = function () {
    if (!this.playing) {
      if (this.order.length) { this.pos = 0; this.load(true); }
      return;
    }
    if (this.audio.paused) {
      var p = this.audio.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      this.audio.pause();
    }
  };

  Player.prototype.next = function (fromError) {
    if (!this.order.length) return;

    if (this.pos + 1 < this.order.length) {
      this.pos++;
      this.load(true);
      return;
    }

    if (this.repeat === 'off') {
      // Park on the last track rather than looping round.
      this.audio.pause();
      if (!fromError) this.audio.currentTime = 0;
      this.emit('state');
      return;
    }

    if (this.shuffle) this.rebuildOrder(false);
    this.pos = 0;
    this.load(true);
  };

  Player.prototype.prev = function () {
    if (!this.order.length) return;

    // Same behaviour as every other player: the first press restarts.
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }

    if (this.pos > 0) {
      this.pos--;
    } else if (this.repeat !== 'off') {
      this.pos = this.order.length - 1;
    }
    this.load(true);
  };

  Player.prototype.onEnded = function () {
    if (this.repeat === 'one') {
      this.audio.currentTime = 0;
      var p = this.audio.play();
      if (p && p.catch) p.catch(function () {});
      return;
    }
    this.next();
  };

  Player.prototype.seek = function (seconds) {
    if (isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, seconds));
    }
  };

  Player.prototype.nudge = function (delta) {
    this.seek((this.audio.currentTime || 0) + delta);
  };

  Player.prototype.setVolume = function (v) {
    this.audio.volume = Math.max(0, Math.min(1, v));
    this.emit('state');
  };

  /* Lock screen and headset buttons. */
  Player.prototype.updateMediaSession = function (track) {
    if (!('mediaSession' in navigator)) return;
    var self = this;

    try {
      var art = [];
      if (track.artworkUrl) art.push({ src: track.artworkUrl, sizes: '512x512' });

      navigator.mediaSession.metadata = new global.MediaMetadata({
        title: track.title || track.fileName,
        artist: track.artist || 'Unknown artist',
        album: track.album || (track.tags || []).join(', '),
        artwork: art
      });

      navigator.mediaSession.setActionHandler('play', function () { self.toggle(); });
      navigator.mediaSession.setActionHandler('pause', function () { self.toggle(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { self.prev(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { self.next(); });
    } catch (e) { /* not supported here */ }
  };

  global.Player = Player;
})(window);
