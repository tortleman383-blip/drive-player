/* Unit tests for the parts that can run without a browser:
 * ID3 reading, filename parsing, folder-id extraction and genre inference.
 *
 *   node music/tests/units.js
 */
'use strict';

var fs = require('fs');
var vm = require('vm');
var path = require('path');
var assert = require('assert');

var JS = path.join(__dirname, '..', 'js');
var win = {};
var ctx = vm.createContext({
  window: win, TextDecoder: TextDecoder, console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise,
  fetch: function () { return Promise.reject(new Error('no network in tests')); }
});

['genres.js', 'id3.js', 'drive.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
});

var Genres = win.Genres, ID3 = win.ID3, Drive = win.Drive;

// Arrays created inside the vm context have that context's Array prototype,
// so compare copies rather than the originals.
function eqTags(actual, expected) {
  assert.deepStrictEqual(Array.from(actual), expected);
}

var passed = 0;
var pending = Promise.resolve();

// Tests may return a promise; they still run in declaration order.
function test(name, fn) {
  pending = pending.then(function () {
    return Promise.resolve().then(fn).then(function () {
      passed++;
    }, function (e) {
      console.error('FAIL  ' + name + '\n      ' + e.message);
      process.exitCode = 1;
    });
  });
}

/* ---------- helpers for building an ID3v2.3 tag ---------- */

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function textFrame(id, text) {
  var body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1'), Buffer.from([0])]);
  var head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function apicFrame(mime, desc, data) {
  var body = Buffer.concat([
    Buffer.from([0]),                       // ISO-8859-1
    Buffer.from(mime, 'latin1'), Buffer.from([0]),
    Buffer.from([3]),                       // front cover
    Buffer.from(desc, 'latin1'), Buffer.from([0]),
    data
  ]);
  var head = Buffer.alloc(10);
  head.write('APIC', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function tag(frames, padding) {
  var body = Buffer.concat(frames.concat([Buffer.alloc(padding || 0)]));
  var head = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0]),   // v2.3.0
    Buffer.from([0]),      // no flags
    syncsafe(body.length)
  ]);
  return Buffer.concat([head, body, Buffer.from('AUDIODATA', 'latin1')]);
}

/* ---------- ID3 ---------- */

test('reads title, artist, album and genre from a v2.3 tag', function () {
  var buf = tag([
    textFrame('TIT2', 'Let It Happen'),
    textFrame('TPE1', 'Tame Impala'),
    textFrame('TALB', 'Currents'),
    textFrame('TCON', 'Psychedelic Rock')
  ], 64);

  var meta = ID3.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.strictEqual(meta.title, 'Let It Happen');
  assert.strictEqual(meta.artist, 'Tame Impala');
  assert.strictEqual(meta.album, 'Currents');
  assert.strictEqual(meta.genre, 'Psychedelic Rock');
});

test('expands the numeric genre form used by older taggers', function () {
  var buf = tag([textFrame('TCON', '(17)')]);
  var meta = ID3.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.strictEqual(meta.genre, 'Rock');
});

test('extracts embedded artwork past the mime type and description', function () {
  var art = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  var buf = tag([apicFrame('image/jpeg', 'cover', art)]);
  var meta = ID3.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));

  assert.ok(meta.picture, 'no picture parsed');
  assert.strictEqual(meta.picture.mime, 'image/jpeg');
  assert.deepStrictEqual(Buffer.from(meta.picture.data), art);
});

test('stops cleanly at padding instead of reading into the audio', function () {
  var buf = tag([textFrame('TIT2', 'Only Field')], 256);
  var meta = ID3.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.strictEqual(meta.title, 'Only Field');
  assert.strictEqual(meta.artist, undefined);
});

test('returns null for a file with no tag', function () {
  var buf = Buffer.from('RIFFxxxxWAVEfmt ');
  assert.strictEqual(ID3.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)), null);
});

test('survives a truncated frame at the end of the fetched chunk', function () {
  var full = tag([textFrame('TIT2', 'Complete'), textFrame('TPE1', 'Cut Off Here')]);
  var short = full.slice(0, full.length - 12);
  var meta = ID3.parse(short.buffer.slice(short.byteOffset, short.byteOffset + short.length));
  assert.strictEqual(meta.title, 'Complete');
});

/* ---------- filenames ---------- */

test('splits "Artist - Title"', function () {
  var r = Drive.parseFileName('Tame Impala - The Less I Know The Better.mp3');
  assert.strictEqual(r.artist, 'Tame Impala');
  assert.strictEqual(r.title, 'The Less I Know The Better');
});

test('drops leading track numbers and underscores', function () {
  var r = Drive.parseFileName('03 - Sidewalks_and_Skeletons - Void.flac');
  assert.strictEqual(r.artist, 'Sidewalks and Skeletons');
  assert.strictEqual(r.title, 'Void');
});

test('strips download noise like (Official Video)', function () {
  var r = Drive.parseFileName('Com Truise - Propagation (Official Audio) [HQ].m4a');
  assert.strictEqual(r.artist, 'Com Truise');
  assert.strictEqual(r.title, 'Propagation');
});

test('keeps the whole name as the title when there is no separator', function () {
  var r = Drive.parseFileName('untitled sketch 4.ogg');
  assert.strictEqual(r.artist, '');
  assert.strictEqual(r.title, 'untitled sketch 4');
});

test('handles en and em dashes as separators', function () {
  assert.strictEqual(Drive.parseFileName('Boards of Canada – Roygbiv.mp3').artist, 'Boards of Canada');
  assert.strictEqual(Drive.parseFileName('Burial — Archangel.mp3').artist, 'Burial');
});

/* ---------- working out which half of a filename is the artist ---------- */

test('a library named "Title - Artist" is flipped the right way round', function () {
  // The shape that broke it: Weezer covers named title-first.
  var out = Drive.parseLibrary([
    "Say It Ain't So - Weezer.mp3",
    'Surf Wax America - Weezer.mp3',
    'Undone - Weezer.mp3',
    'Buddy Holly - Weezer.mp3'
  ]);

  out.forEach(function (t) {
    assert.strictEqual(t.artist, 'Weezer', 'got artist ' + t.artist + ' / title ' + t.title);
  });
  assert.strictEqual(out[0].title, "Say It Ain't So");
});

test('a library named "Artist - Title" is left alone', function () {
  var out = Drive.parseLibrary([
    'Tame Impala - Let It Happen.mp3',
    'Tame Impala - Borderline.mp3',
    'Tame Impala - Elephant.mp3'
  ]);

  out.forEach(function (t) {
    assert.strictEqual(t.artist, 'Tame Impala', 'got artist ' + t.artist);
  });
});

test('a known artist is recognised even appearing only once', function () {
  var out = Drive.parseLibrary(['Borderline - Tame Impala.mp3', 'random thing.mp3']);
  assert.strictEqual(out[0].artist, 'Tame Impala');
  assert.strictEqual(out[0].title, 'Borderline');
});

test('mixed conventions in one folder both come out right', function () {
  var out = Drive.parseLibrary([
    'Weezer - Island In The Sun.mp3',
    "Say It Ain't So - Weezer.mp3",
    'Undone - Weezer.mp3',
    'MGMT - Kids.mp3'
  ]);

  assert.strictEqual(out[0].artist, 'Weezer');
  assert.strictEqual(out[0].title, 'Island In The Sun');
  assert.strictEqual(out[1].artist, 'Weezer');
  assert.strictEqual(out[1].title, "Say It Ain't So");
  assert.strictEqual(out[3].artist, 'MGMT');
  assert.strictEqual(out[3].title, 'Kids');
});

test('an unknown artist appearing once is not flipped on a guess', function () {
  var out = Drive.parseLibrary(['Some Band - Some Song.mp3']);
  assert.strictEqual(out[0].artist, 'Some Band');
  assert.strictEqual(out[0].title, 'Some Song');
});

test('files with no separator are passed through untouched', function () {
  var out = Drive.parseLibrary(['just a title.mp3', 'Weezer - Pork And Beans.mp3']);
  assert.strictEqual(out[0].artist, '');
  assert.strictEqual(out[0].title, 'just a title');
  assert.strictEqual(out[1].artist, 'Weezer');
});

/* ---------- finding an artist with no separator to split on ---------- */

test('a multi-word known artist is found at the front of a bare filename', function () {
  assert.strictEqual(Genres.findArtistIn('Tame Impala Elephant'), 'tame impala');
  assert.strictEqual(Genres.findArtistIn('Sidewalks and Skeletons Void'), 'sidewalks and skeletons');
  assert.strictEqual(Genres.findArtistIn('Boards of Canada Roygbiv'), 'boards of canada');
});

test('the longest matching name wins', function () {
  // "Tame Impala" must not be beaten by any shorter prefix.
  assert.strictEqual(Genres.findArtistIn('Tame Impala The Less I Know The Better'), 'tame impala');
});

test('a one-word artist is not hunted for inside a title', function () {
  // "Air" and "Weezer" are real entries, but matching them mid-title would
  // mis-credit any song with the word in it.
  assert.strictEqual(Genres.findArtistIn('Air Force Ones'), '');
  assert.strictEqual(Genres.findArtistIn('Weezer'), '');
});

test('an artist named only later in the title is ignored', function () {
  assert.strictEqual(Genres.findArtistIn('Cover of Tame Impala Elephant'), '');
});

test('nothing is invented from an unknown name', function () {
  assert.strictEqual(Genres.findArtistIn('Some Local Demo Track'), '');
});

test('Cowboy Bebop is tagged as the soundtrack it is', function () {
  var tags = Genres.inferTags({ artist: 'Yoko Kanno', title: 'Tank!' });
  assert.ok(Array.from(tags).indexOf('Jazz') !== -1, String(tags));
  assert.ok(Array.from(tags).indexOf('Soundtrack') !== -1, String(tags));
  assert.ok(Array.from(Genres.inferTags({ artist: 'The Seatbelts' })).indexOf('Jazz') !== -1);
  assert.ok(Array.from(Genres.inferTags({ artist: 'Cowboy Bebop' })).indexOf('Soundtrack') !== -1);
});

/* ---------- folder ids ---------- */

test('pulls the folder id out of every link shape', function () {
  var id = '15IttG5K1ruTgzxWlLKOvDFZwS4ux1pmE';
  assert.strictEqual(Drive.folderIdFrom('https://drive.google.com/drive/folders/' + id + '?usp=sharing'), id);
  assert.strictEqual(Drive.folderIdFrom('https://drive.google.com/drive/folders/' + id), id);
  assert.strictEqual(Drive.folderIdFrom('https://drive.google.com/open?id=' + id), id);
  assert.strictEqual(Drive.folderIdFrom('  ' + id + '  '), id);
  assert.strictEqual(Drive.folderIdFrom('not a link'), '');
});

/* ---------- shortcuts and download probing ---------- */

test('a shortcut is swapped for the file it points at', function () {
  ctx.fetch = function (url) {
    fetched = url;
    return Promise.resolve({ ok: true, status: 206, text: function () { return Promise.resolve(''); } });
  };
  var fetched = '';

  // listTracks goes through the network, so exercise the resolution the way
  // the listing does: a shortcut carrying an audio target.
  var files = [{
    id: 'shortcut-id',
    name: 'Tame Impala - Elephant.mp3',
    mimeType: 'application/vnd.google-apps.shortcut',
    shortcutDetails: { targetId: 'real-file-id', targetMimeType: 'audio/mpeg' }
  }];

  ctx.fetch = function () {
    return Promise.resolve({
      ok: true,
      json: function () { return Promise.resolve({ files: files }); }
    });
  };

  return Drive.listTracks('folder', 'key').then(function (tracks) {
    assert.strictEqual(tracks.length, 1);
    assert.strictEqual(tracks[0].id, 'real-file-id', 'shortcut was not resolved');
    assert.strictEqual(tracks[0].fileName, 'Tame Impala - Elephant.mp3');
  });
});

test('a shortcut with no target is not treated as playable audio', function () {
  assert.ok(!Drive.isAudio({
    name: 'song.mp3',
    mimeType: 'application/vnd.google-apps.shortcut'
  }));
});

test('probe reports a 403 from Drive in words', function () {
  ctx.fetch = function () {
    return Promise.resolve({
      ok: false,
      status: 403,
      text: function () {
        return Promise.resolve(JSON.stringify({
          error: { message: 'The caller does not have permission', errors: [{ reason: 'forbidden' }] }
        }));
      }
    });
  };

  return Drive.probe('id', 'key').then(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
    assert.ok(/403/.test(r.message), r.message);
    assert.ok(/does not have permission/.test(r.message), r.message);
  });
});

test('probe names the abusive-file case specifically', function () {
  ctx.fetch = function () {
    return Promise.resolve({
      ok: false,
      status: 403,
      text: function () {
        return Promise.resolve(JSON.stringify({
          error: { message: 'x', errors: [{ reason: 'cannotDownloadAbusiveFile' }] }
        }));
      }
    });
  };

  return Drive.probe('id', 'key').then(function (r) {
    assert.ok(/flagged/i.test(r.message), r.message);
  });
});

test('probe reports a request that never reached Drive', function () {
  ctx.fetch = function () { return Promise.reject(new Error('Failed to fetch')); };

  return Drive.probe('id', 'key').then(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 0);
    assert.ok(/never reached Drive/.test(r.message), r.message);
  });
});

test('probe is happy when Drive serves the bytes', function () {
  ctx.fetch = function () { return Promise.resolve({ ok: true, status: 206 }); };
  return Drive.probe('id', 'key').then(function (r) {
    assert.strictEqual(r.ok, true);
  });
});

/* ---------- audio detection ---------- */

test('recognises audio by mime type or extension, and nothing else', function () {
  assert.ok(Drive.isAudio({ name: 'a.mp3', mimeType: 'audio/mpeg' }));
  assert.ok(Drive.isAudio({ name: 'b.flac', mimeType: 'application/octet-stream' }));
  assert.ok(Drive.isAudio({ name: 'c.opus', mimeType: '' }));
  assert.ok(!Drive.isAudio({ name: 'cover.jpg', mimeType: 'image/jpeg' }));
  assert.ok(!Drive.isAudio({ name: 'notes.txt', mimeType: 'text/plain' }));
});

/* ---------- genre inference ---------- */

test('the example from the brief: Synth returns both artists', function () {
  var tame = Genres.inferTags({ artist: 'Tame Impala', title: 'Elephant' });
  var sas = Genres.inferTags({ artist: 'Sidewalks and Skeletons', title: 'Void' });
  assert.ok(tame.indexOf('Synth') !== -1, 'Tame Impala missing Synth: ' + tame);
  assert.ok(sas.indexOf('Synth') !== -1, 'Sidewalks and Skeletons missing Synth: ' + sas);
  assert.ok(tame.indexOf('Psych') !== -1);
  assert.ok(sas.indexOf('Witch House') !== -1);
});

test('artist matching ignores case, punctuation and a leading "the"', function () {
  var a = Genres.inferTags({ artist: 'THE BLACK ANGELS' });
  var b = Genres.inferTags({ artist: 'Black Angels, The' });
  eqTags(a, Array.from(b));
  assert.ok(a.indexOf('Psych') !== -1);
});

test('merges tags across a featured credit', function () {
  var tags = Genres.inferTags({ artist: 'Kavinsky feat. Lovefoxxx', title: 'Nightcall' });
  assert.ok(tags.indexOf('Synth') !== -1);
});

test('falls back to the ID3 genre frame when the artist is unknown', function () {
  var tags = Genres.inferTags({ artist: 'Some Local Band', title: 'Demo', id3Genre: 'Darksynth' });
  assert.ok(tags.indexOf('Synth') !== -1, String(tags));
});

test('falls back to the filename when there is nothing else', function () {
  var tags = Genres.inferTags({ artist: '', title: '', fileName: 'lofi study beat 3.mp3' });
  eqTags(tags, ['Lo-Fi']);
});

test('unknown everything lands in Unsorted', function () {
  eqTags(Genres.inferTags({ artist: 'Nobody', title: 'Xyzzy' }), ['Unsorted']);
});

test('an artist rule beats the built-in table but loses to a track override', function () {
  var track = { artist: 'Tame Impala', title: 'Elephant' };
  eqTags(Genres.inferTags(track, null, ['Shoegaze']), ['Shoegaze']);
  eqTags(Genres.inferTags(track, ['Metal'], ['Shoegaze']), ['Metal']);
});

test('an artist rule tags an artist the built-in table has never heard of', function () {
  var tags = Genres.inferTags({ artist: 'Some Local Band', title: 'Demo' }, null, ['Punk', 'Indie']);
  eqTags(tags, ['Punk', 'Indie']);
});

test('an empty artist rule falls through instead of blanking the tags', function () {
  var tags = Genres.inferTags({ artist: 'Tame Impala', title: 'Elephant' }, null, []);
  assert.ok(Array.from(tags).indexOf('Psych') !== -1, String(tags));
});

test('a manual override beats every rule', function () {
  var tags = Genres.inferTags({ artist: 'Tame Impala', title: 'Elephant' }, ['Metal']);
  eqTags(tags, ['Metal']);
});

test('orderTags follows the taxonomy and keeps custom tags at the end', function () {
  var out = Genres.orderTags(['Late Night', 'Rock', 'Synth']);
  eqTags(out, ['Synth', 'Rock', 'Late Night']);
});

pending.then(function () {
  console.log(passed + ' unit tests passed' +
    (process.exitCode ? ', with failures above' : ''));
});
