/* A small ID3v2 reader.
 *
 * We only ever fetch the first chunk of a file (see drive.js), so this parses
 * whatever tag fits in that chunk and gives up quietly on anything else. It
 * handles ID3v2.2, v2.3 and v2.4, which covers everything that comes out of
 * iTunes, Bandcamp, yt-dlp and the usual taggers.
 */
(function (global) {
  'use strict';

  var NUL = String.fromCharCode(0);

  var FRAMES = {
    // v2.3 / v2.4       // v2.2
    TIT2: 'title',       TT2: 'title',
    TPE1: 'artist',      TP1: 'artist',
    TPE2: 'albumArtist', TP2: 'albumArtist',
    TALB: 'album',       TAL: 'album',
    TCON: 'genre',       TCO: 'genre',
    TYER: 'year',        TYE: 'year',
    TDRC: 'year',
    TRCK: 'track',       TRK: 'track',
    APIC: 'picture',     PIC: 'picture'
  };

  // ID3v1 numeric genres still show up inside TCON as "(17)" or "(17)Rock".
  var V1_GENRES = [
    'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge',
    'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B',
    'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
    'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient',
    'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical',
    'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
    'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative',
    'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave',
    'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream',
    'Southern Rock', 'Comedy', 'Cult', 'Gangsta Rap', 'Top 40',
    'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret',
    'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi',
    'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical',
    'Rock & Roll', 'Hard Rock'
  ];

  function synchsafe(b, o) {
    return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  }

  function plainSize(b, o) {
    return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }

  function decode(bytes, encoding) {
    try {
      switch (encoding) {
        case 1: return new TextDecoder('utf-16').decode(bytes);   // BOM
        case 2: return new TextDecoder('utf-16be').decode(bytes);
        case 3: return new TextDecoder('utf-8').decode(bytes);
        default: return new TextDecoder('iso-8859-1').decode(bytes);
      }
    } catch (e) {
      return '';
    }
  }

  function clean(s) {
    // Taggers pad with NULs, and v2.4 uses NUL to separate multiple values.
    return s.split(NUL)[0].trim();
  }

  function readText(body) {
    if (!body.length) return '';
    return clean(decode(body.subarray(1), body[0]));
  }

  function readGenre(body) {
    var raw = readText(body);
    return raw.replace(/^\((\d+)\)\s*/, function (match, n) {
      var name = V1_GENRES[parseInt(n, 10)];
      return name ? name + ' ' : '';
    }).trim();
  }

  function readPicture(body, isV22) {
    if (body.length < 4) return null;
    var enc = body[0];
    var i = 1;
    var mime;

    if (isV22) {
      // v2.2 uses a fixed 3-character image format ("JPG", "PNG").
      var fmt = decode(body.subarray(1, 4), 0).toUpperCase();
      mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
      i = 4;
    } else {
      var start = i;
      while (i < body.length && body[i] !== 0) i++;
      mime = decode(body.subarray(start, i), 0) || 'image/jpeg';
      i++; // skip the terminator
    }

    i++; // picture type byte

    // Skip the description, terminated the same way the text is encoded:
    // one NUL for the 8-bit encodings, two for UTF-16.
    if (enc === 1 || enc === 2) {
      while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
      i += 2;
    } else {
      while (i < body.length && body[i] !== 0) i++;
      i++;
    }

    if (i >= body.length) return null;
    return { mime: mime, data: body.subarray(i) };
  }

  /* Returns { title, artist, album, genre, year, track, picture } - every
   * field optional - or null when there is no readable ID3v2 tag. */
  function parse(buffer) {
    var b = new Uint8Array(buffer);
    if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;

    var major = b[3];
    if (major < 2 || major > 4) return null;

    var flags = b[5];
    var tagSize = synchsafe(b, 6);
    var end = Math.min(10 + tagSize, b.length);
    var i = 10;

    if (major >= 3 && (flags & 0x40)) {
      // Extended header: v2.4 counts itself in its size, v2.3 does not.
      var extSize = major === 4 ? synchsafe(b, i) : plainSize(b, i) + 4;
      i += extSize;
    }

    var isV22 = major === 2;
    var idLen = isV22 ? 3 : 4;
    var headerLen = isV22 ? 6 : 10;
    var out = {};

    while (i + headerLen <= end) {
      var id = String.fromCharCode.apply(null, b.subarray(i, i + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding, or we ran into the audio

      var size = isV22
        ? (b[i + 3] << 16) | (b[i + 4] << 8) | b[i + 5]
        : (major === 4 ? synchsafe(b, i + 4) : plainSize(b, i + 4));
      if (size <= 0) break;

      var frameFlags = isV22 ? 0 : b[i + 9];
      var start = i + headerLen;
      var stop = start + size;
      i = stop;

      var field = FRAMES[id];
      if (!field) continue;
      if (stop > b.length) break;          // frame runs past what we fetched
      if (frameFlags & 0x0e) continue;     // compressed / encrypted / grouped

      var body = b.subarray(start, stop);
      if (field === 'picture') {
        if (!out.picture) out.picture = readPicture(body, isV22);
      } else if (field === 'genre') {
        if (!out.genre) out.genre = readGenre(body);
      } else if (!out[field]) {
        out[field] = readText(body);
      }
    }

    return out;
  }

  global.ID3 = { parse: parse };
})(window);
