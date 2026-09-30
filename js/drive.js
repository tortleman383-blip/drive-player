/* Google Drive access.
 *
 * The folder is shared "anyone with the link", so an API key is enough and
 * there is no OAuth dance. The key lives in the browser's localStorage and is
 * never part of this repository.
 *
 * Audio is streamed from the API's alt=media endpoint rather than the
 * drive.google.com/uc?export=download URL: the API endpoint sends CORS
 * headers and honours Range requests, so seeking works and we can read ID3
 * tags out of the first chunk of a file.
 */
(function (global) {
  'use strict';

  var API = 'https://www.googleapis.com/drive/v3/files';
  var TAG_BYTES = 262144; // 256 KB: enough for a tag with embedded artwork

  var AUDIO_MIME = /^audio\//i;
  var AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|weba|webm)$/i;

  var GOOGLE_NATIVE = /^application\/vnd\.google-apps\./;

  function isAudio(file) {
    var mime = file.mimeType || '';
    if (GOOGLE_NATIVE.test(mime)) return false;   // Docs, Sheets, shortcuts...
    return AUDIO_MIME.test(mime) || AUDIO_EXT.test(file.name || '');
  }

  function isFolder(file) {
    return file.mimeType === 'application/vnd.google-apps.folder';
  }

  function isShortcut(file) {
    return file.mimeType === 'application/vnd.google-apps.shortcut';
  }

  /* Adding a file from "Shared with me" into your own folder leaves a
   * shortcut behind, not the file. A shortcut has the real name - and so
   * looks like audio - but downloading it fails, so swap in what it points
   * at before anything else looks at it. */
  function resolveShortcut(file) {
    if (!isShortcut(file)) return file;
    var target = file.shortcutDetails || {};
    if (!target.targetId) return file;
    return {
      id: target.targetId,
      name: file.name,
      mimeType: target.targetMimeType || '',
      size: file.size,
      modifiedTime: file.modifiedTime
    };
  }

  /* Accepts a bare folder id or any of the URL shapes Drive hands out. */
  function folderIdFrom(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    var m = s.match(/\/folders\/([-\w]{10,})/) ||
            s.match(/[?&]id=([-\w]{10,})/) ||
            s.match(/^([-\w]{10,})$/);
    return m ? m[1] : '';
  }

  function streamUrl(fileId, apiKey) {
    return API + '/' + encodeURIComponent(fileId) +
      '?alt=media&key=' + encodeURIComponent(apiKey);
  }

  function describeError(status, body) {
    var reason = '';
    try { reason = (JSON.parse(body).error || {}).message || ''; } catch (e) {}
    if (status === 400) return 'Drive rejected the request. Check the API key. ' + reason;
    if (status === 403) {
      return 'Drive refused the key (403). Usually this means the Drive API is ' +
        'not enabled on the key’s project, or the key’s HTTP-referrer ' +
        'restriction does not cover this page. ' + reason;
    }
    if (status === 404) {
      return 'Folder not found (404). Make sure it is shared as ' +
        '"Anyone with the link".';
    }
    if (status === 429) return 'Drive is rate-limiting the key (429). Wait a minute and retry.';
    return 'Drive returned HTTP ' + status + '. ' + reason;
  }

  function request(url) {
    return fetch(url).then(function (res) {
      if (res.ok) return res.json();
      return res.text().then(function (body) {
        throw new Error(describeError(res.status, body));
      });
    });
  }

  /* Lists one folder, following pagination. */
  function listFolder(folderId, apiKey) {
    var out = [];

    function page(token) {
      var url = API +
        '?q=' + encodeURIComponent('"' + folderId + '" in parents and trashed = false') +
        '&key=' + encodeURIComponent(apiKey) +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType,size,modifiedTime,' +
          'shortcutDetails(targetId,targetMimeType))') +
        '&pageSize=1000&orderBy=name' +
        '&supportsAllDrives=true&includeItemsFromAllDrives=true' +
        (token ? '&pageToken=' + encodeURIComponent(token) : '');

      return request(url).then(function (data) {
        out = out.concat((data.files || []).map(resolveShortcut));
        return data.nextPageToken ? page(data.nextPageToken) : out;
      });
    }

    return page(null);
  }

  /* Lists the folder and everything under it. onProgress is called with the
   * running count so the UI can say something while a big library loads. */
  function listTracks(folderId, apiKey, onProgress) {
    var tracks = [];
    var seen = {};

    function walk(id, path, depth) {
      if (seen[id] || depth > 6) return Promise.resolve();
      seen[id] = true;

      return listFolder(id, apiKey).then(function (files) {
        var folders = [];

        files.forEach(function (f) {
          if (isFolder(f)) {
            folders.push(f);
          } else if (isAudio(f)) {
            tracks.push({
              id: f.id,
              fileName: f.name,
              folder: path,
              size: Number(f.size) || 0,
              modifiedTime: f.modifiedTime || ''
            });
          }
        });

        if (onProgress) onProgress(tracks.length);

        // Sequential, so a deep library does not open dozens of sockets.
        return folders.reduce(function (chain, f) {
          return chain.then(function () {
            return walk(f.id, path ? path + '/' + f.name : f.name, depth + 1);
          });
        }, Promise.resolve());
      });
    }

    return walk(folderId, '', 0).then(function () { return tracks; });
  }

  // What Drive says when the refusal is about how fast, not about the file.
  var RATE_REASON = /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded/i;

  /* Whether a refusal is Google holding traffic back rather than anything to
   * do with this file: a 429, a server error, or a 403 over a rate limit.
   * Playback asks the same endpoint with the same key, so this is its
   * problem too. */
  function isThrottle(status, body) {
    if (status === 429 || status >= 500) return true;
    return status === 403 && RATE_REASON.test(body || '');
  }

  /* Reads the head of a file so ID3 tags can be parsed without downloading
   * the whole track.
   *
   * Resolves to { ok, buffer, throttled }. The distinctions matter: "Drive
   * would not give me the bytes" and "the bytes contain no tag" look
   * identical to the caller otherwise, and caching the first as the second
   * brands a file untaggable for good over what may be a temporary
   * permission problem. And "Google is holding traffic back" is not about
   * this file at all, but about the playback that shares its key. */
  function fetchTagBytes(fileId, apiKey) {
    return fetch(streamUrl(fileId, apiKey), {
      headers: { Range: 'bytes=0-' + (TAG_BYTES - 1) }
    }).then(function (res) {
      if (res.ok) {
        return res.arrayBuffer().then(function (buffer) {
          return { ok: true, buffer: buffer };
        });
      }
      return res.text().catch(function () { return ''; }).then(function (body) {
        return { ok: false, buffer: null, throttled: isThrottle(res.status, body) };
      });
    }).catch(function () {
      // No answer at all. A network Google has blocked gets a block page
      // with no CORS headers, which lands here too.
      return { ok: false, buffer: null, throttled: true };
    });
  }

  function describeDownloadError(status, body) {
    var reason = '';
    var code = '';
    try {
      var err = JSON.parse(body).error || {};
      reason = err.message || '';
      code = ((err.errors || [])[0] || {}).reason || '';
    } catch (e) {}

    if (status === 403 && /abusive/i.test(reason + code)) {
      return 'Drive has flagged this file and will not serve it to an API key ' +
        '(cannotDownloadAbusiveFile).';
    }
    // Before the general 403: a rate limit is not the key's settings, and
    // saying it was sent people off to change settings that were fine.
    if (status === 429 || (status === 403 && RATE_REASON.test(code + ' ' + reason))) {
      return 'Google is rate-limiting requests from this key or connection (' +
        status + '). It clears by itself within a few minutes.';
    }
    if (status === 403) {
      return 'Drive refused the download (403). The key can list the folder but ' +
        'not fetch the audio - usually the Drive API is enabled but the key has ' +
        'an application restriction that this page does not satisfy. ' + reason;
    }
    if (status === 404) {
      return 'Drive says the file does not exist (404). It may be a shortcut to ' +
        'something that is not shared, or it was removed.';
    }
    if (status === 416) return 'Drive rejected the range request (416).';
    return 'Drive returned HTTP ' + status + '. ' + reason;
  }

  /* Asks Drive for a single byte of a file. Cheap, and enough to tell a
   * permission problem apart from a format the browser cannot decode.
   *
   * Retried once: a rejected fetch covers everything from a dropped
   * connection to a throttled response arriving without CORS headers, and
   * one blip should not be reported as a broken setup. */
  function probe(fileId, apiKey, isRetry) {
    return fetch(streamUrl(fileId, apiKey), { headers: { Range: 'bytes=0-0' } })
      .then(function (res) {
        if (res.ok) return { ok: true, status: res.status };
        return res.text().then(function (body) {
          return {
            ok: false,
            status: res.status,
            throttled: isThrottle(res.status, body),
            message: describeDownloadError(res.status, body)
          };
        });
      })
      .catch(function (e) {
        if (!isRetry) {
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(probe(fileId, apiKey, true)); }, 1500);
          });
        }

        return {
          ok: false,
          status: 0,
          network: true,
          throttled: true,
          message: 'The request never reached Drive (' + (e && e.message) + '). ' +
            'If google.com pages are also refusing to load with "your computer ' +
            'or network may be sending automated queries", Google has blocked ' +
            'this network rather than this key, and it clears on its own — ' +
            'trying another connection confirms it. Otherwise an extension, a ' +
            'network filter, or a dropped connection is stopping the request.'
        };
      });
  }

  var NOISE = /\s*[\(\[](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visualizer|hd|hq|4k|full\s*album|remaster(?:ed)?(?:\s*\d{4})?|explicit|clean)[\)\]]\s*/gi;

  /* Junk that rippers and sync clients leave in filenames. Each of these is
   * something that carries no information about the music, which is the bar
   * for removal - "(Live)" and "(Acoustic)" say something real and stay. */
  var CLEANERS = [
    // Anything bracketed containing a web address: [SPOTDOWN.ORG], (y2mate.com)
    /\s*[\(\[\{][^\)\]\}]*\b[a-z0-9-]+\.(?:com|org|net|io|co|me|cc|to|info|xyz|ru|in|app)\b[^\)\]\}]*[\)\]\}]/gi,
    // The same sites unbracketed, with or without the suffix
    /\s*\b(?:spotdown|spotifydown|spotmate|y2mate|ytmp3|yt1s|mp3juices?|tubidy|savefrom|snapsave|slider\.kz|doubledouble)\b(?:\.[a-z]{2,4})?/gi,
    // Bare domains anywhere else in the name
    /\s*\b(?:www\.)[a-z0-9-]+\.[a-z]{2,4}\b/gi,
    // Bitrate and sample-rate stamps
    /\s*[\(\[]?\b\d{2,3}\s*kbps\b[\)\]]?/gi,
    /\s*[\(\[]\s*(?:flac|wav|m4a|mp3|24\s*bit|16\s*bit|\d{2,3}\s*k)\s*[\)\]]/gi,
    // Syncthing: "Name.sync-conflict-20260802-180148-YDN3SFC"
    /\s*\.?sync-conflict-\d{6,8}-\d{4,6}-[a-z0-9]+/gi,
    // Drive, Dropbox and OneDrive collision markers
    /\s*[\(\[][^\)\]]*\b(?:sync conflict|conflicted copy|case conflict|conflicted version)\b[^\)\]]*[\)\]]/gi,
    /\s*[-–—]\s*(?:sync conflict|copy)\b.*$/gi,
    /\s*\(\s*copy\s*\)/gi,
    /\s*[-–—]\s*copy\s*$/gi,
    // Trailing duplicate markers left by a second download: "Song (1)"
    /\s*\(\s*\d{1,2}\s*\)\s*$/g
  ];

  /* A version label - "Single Version", "Radio Edit", "Remastered 2014",
   * "2009 Remaster" - is part of the title, and reading it as an artist
   * invents one. A part is a label only when every word in it is one that
   * describes a version and at least one says which kind. A title that just
   * ends in such a word - "Intro", "Radio", "The Final Cut" - is a title, and
   * taking it for a label used to cost the real artist their credit. */
  var LABEL_KIND = /^(?:version|edit|mix|remix|remaster(?:ed)?|live|acoustic|demo|instrumental|bonus|reprise|remake|rerecord(?:ed)?)$/;
  var LABEL_WORD = /^(?:single|radio|album|original|extended|club|dub|short|long|alternate|alt|early|track|mono|stereo|digital|digitally|(?:19|20)\d{2})$/;

  // Labels that say so from their first words, whatever follows: "Remastered
  // in 2011", "Includes Hidden Track 'Life Is For Living'".
  var LEADING_LABEL = /^(?:remaster(?:ed)?|(?:includes\s+)?hidden\s+track)\b/i;

  function isLabel(part) {
    var text = String(part || '').trim();
    if (LEADING_LABEL.test(text)) return true;

    var words = text.toLowerCase().replace(/[()\[\]]/g, ' ').split(/\s+/).filter(Boolean);
    var kind = false;
    for (var i = 0; i < words.length; i++) {
      if (LABEL_KIND.test(words[i])) kind = true;
      else if (!LABEL_WORD.test(words[i])) return false;
    }
    return kind;
  }

  // Separators and punctuation stranded by the removals above.
  var STRANDED = /^[\s\-–—_.,·|]+|[\s\-–—_.,·|]+$/g;

  /* Cleans a filename and splits it on its dashes, setting version labels
   * aside wherever they sit after the first part: "My Sweet Lord -
   * Remastered 2014", or "Endless, Nameless - Remastered 2021 - Nirvana"
   * with the band named last. Returns what is left, and the labels as a
   * suffix for the title. */
  function splitFileName(name) {
    var s = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '');
    s = s.replace(/_/g, ' ').replace(NOISE, ' ');

    CLEANERS.forEach(function (rule) { s = s.replace(rule, ' '); });

    s = s.replace(/\s+/g, ' ').replace(STRANDED, '').trim();
    s = s.replace(/^\d{1,3}\s*[-.)]\s*/, '');       // leading track number
    s = s.replace(/^\d{1,3}\s+(?=\D)/, '');

    var parts = s.split(/\s+[-–—]\s+/).map(function (part) {
      return part.replace(STRANDED, '').trim();
    }).filter(Boolean);   // a stripped-out site name can leave a gap

    // Never the first part, which may be a band that happens to be called
    // what a label says: "Live - Lightning Crashes".
    var labels = [];
    parts = parts.filter(function (part, i) {
      if (i === 0 || !isLabel(part)) return true;
      labels.push(part);
      return false;
    });

    return {
      parts: parts,
      suffix: labels.length ? ' (' + labels.join(' - ') + ')' : '',
      whole: s.replace(STRANDED, '').trim()
    };
  }

  /* Best-effort artist/title from a filename, for files with no ID3 tag. */
  function parseFileName(name) {
    var n = splitFileName(name);
    if (n.parts.length >= 2) {
      return { artist: n.parts[0], title: n.parts.slice(1).join(' - ') + n.suffix };
    }
    return { artist: '', title: (n.parts[0] || n.whole) + n.suffix };
  }

  /* Filenames arrive in both orders - "Weezer - Say It Ain't So" and
   * "Say It Ain't So - Weezer" - and per file there is no way to tell which
   * half is the band. Across a library there is: artists recur, song titles
   * do not. So parse everything first, count how often each side's text shows
   * up anywhere, and flip the pairs whose second half looks more like an
   * artist than their first.
   *
   * Takes a list of filenames, returns their { artist, title } in order. */
  function parseLibrary(fileNames) {
    var split = (fileNames || []).map(splitFileName);
    var counts = Object.create(null);   // keyed by names, "constructor" included

    function key(value) {
      if (!value) return '';
      return global.Genres ? global.Genres.normaliseArtist(value)
                           : String(value).toLowerCase().trim();
    }

    split.forEach(function (n) {
      n.parts.forEach(function (value) {
        var k = key(value);
        if (k) counts[k] = (counts[k] || 0) + 1;
      });
    });

    function score(value) {
      // A year is never the band, however often it turns up: the one left
      // behind by a stripped "(Remaster)" recurs across an album just as an
      // artist's name would.
      if (!value || /^(?:19|20)\d{2}$/.test(value)) return -1;
      var points = 0;
      if (global.Genres && global.Genres.isKnownArtist(value)) points += 2;
      if (counts[key(value)] > 1) points += 1;
      return points;
    }

    return split.map(function (n) {
      var parts = n.parts;
      if (parts.length < 2) return { artist: '', title: (parts[0] || n.whole) + n.suffix };

      // The band is named first or last - "Say It Ain't So - Weezer", or
      // "Undone - The Sweater Song - Weezer" with a dash inside the title.
      // Only move it to the end on positive evidence for that side.
      var last = parts[parts.length - 1];
      if (score(last) > score(parts[0])) {
        return { artist: last, title: parts.slice(0, -1).join(' - ') + n.suffix };
      }
      return { artist: parts[0], title: parts.slice(1).join(' - ') + n.suffix };
    });
  }

  global.Drive = {
    parseLibrary: parseLibrary,
    folderIdFrom: folderIdFrom,
    streamUrl: streamUrl,
    listTracks: listTracks,
    probe: probe,
    fetchTagBytes: fetchTagBytes,
    parseFileName: parseFileName,
    isAudio: isAudio
  };
})(window);
