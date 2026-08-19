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

  /* Reads the head of a file so ID3 tags can be parsed without downloading
   * the whole track. Resolves to null if the range request is refused. */
  function fetchTagBytes(fileId, apiKey) {
    return fetch(streamUrl(fileId, apiKey), {
      headers: { Range: 'bytes=0-' + (TAG_BYTES - 1) }
    }).then(function (res) {
      if (!res.ok) return null;
      return res.arrayBuffer();
    }).catch(function () {
      return null;
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
    if (status === 429) return 'Drive is rate-limiting the key (429).';
    return 'Drive returned HTTP ' + status + '. ' + reason;
  }

  /* Asks Drive for a single byte of a file. Cheap, and enough to tell a
   * permission problem apart from a format the browser cannot decode. */
  function probe(fileId, apiKey) {
    return fetch(streamUrl(fileId, apiKey), { headers: { Range: 'bytes=0-0' } })
      .then(function (res) {
        if (res.ok) return { ok: true, status: res.status };
        return res.text().then(function (body) {
          return { ok: false, status: res.status, message: describeDownloadError(res.status, body) };
        });
      })
      .catch(function (e) {
        return {
          ok: false,
          status: 0,
          message: 'The request never reached Drive (' + (e && e.message) + '). ' +
            'Something between this page and googleapis.com is blocking it - a ' +
            'network filter, an extension, or an offline connection.'
        };
      });
  }

  var NOISE = /\s*[\(\[](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visualizer|hd|hq|4k|full\s*album|remaster(?:ed)?(?:\s*\d{4})?|explicit|clean)[\)\]]\s*/gi;

  /* Best-effort artist/title from a filename, for files with no ID3 tag. */
  function parseFileName(name) {
    var s = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '');
    s = s.replace(/_/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\d{1,3}\s*[-.)]\s*/, '');       // leading track number
    s = s.replace(/^\d{1,3}\s+(?=\D)/, '');

    var parts = s.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      return {
        artist: parts[0].trim(),
        title: parts.slice(1).join(' - ').trim()
      };
    }
    return { artist: '', title: s };
  }

  global.Drive = {
    folderIdFrom: folderIdFrom,
    streamUrl: streamUrl,
    listTracks: listTracks,
    probe: probe,
    fetchTagBytes: fetchTagBytes,
    parseFileName: parseFileName,
    isAudio: isAudio
  };
})(window);
