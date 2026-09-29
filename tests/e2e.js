/* End-to-end test: drives the real page in Chromium against a stubbed Drive
 * API, so listing, tagging, filtering, playback and persistence are all
 * exercised the way a browser would do it.
 *
 *   npm i playwright && node music/tests/e2e.js
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.error('playwright is not installed: npm i playwright');
  process.exit(2);
}

/* ---------- fixtures ---------- */

var FOLDER = '15IttG5K1ruTgzxWlLKOvDFZwS4ux1pmE';
var SUBFOLDER = 'sub-deep-cuts';
var ARTIST_FOLDER = 'sub-tame-impala';

var FILES = {};
FILES[FOLDER] = [
  { id: 'f1', name: 'Tame Impala - Let It Happen.mp3', mimeType: 'audio/mpeg' },
  { id: 'f2', name: 'Sidewalks and Skeletons - Void.mp3', mimeType: 'audio/mpeg' },
  { id: 'f3', name: '03 - Com Truise - Propagation (Official Audio).mp3', mimeType: 'audio/mpeg' },
  { id: 'f4', name: 'untitled demo 2.mp3', mimeType: 'audio/mpeg' },
  { id: 'f5', name: 'track05.mp3', mimeType: 'audio/mpeg' },      // ID3 only
  { id: 'f7', name: 'Grouper - Clearing.mp3', mimeType: 'audio/mpeg' },  // untaggable
  { id: 'f8', name: 'Borderline - Tame Impala.mp3', mimeType: 'audio/mpeg' },  // title first

  { id: 'img', name: 'cover.jpg', mimeType: 'image/jpeg' },
  { id: SUBFOLDER, name: 'Deep Cuts', mimeType: 'application/vnd.google-apps.folder' },
  { id: ARTIST_FOLDER, name: 'Tame Impala', mimeType: 'application/vnd.google-apps.folder' }
];
FILES[SUBFOLDER] = [
  { id: 'f6', name: 'Boards of Canada - Roygbiv.mp3', mimeType: 'audio/mpeg' },
  { id: 'f10', name: 'Nujabes - Feather.mp3', mimeType: 'audio/mpeg' }
];
FILES[ARTIST_FOLDER] = [
  { id: 'f9', name: 'Elephant.mp3', mimeType: 'audio/mpeg' }   // bare title
];

// A real 16x16 PNG, so the thumbnail pipeline has something to decode.
var COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABlklEQVR42g3L0QBAIQxA0RCGEMIQhjCE' +
  'EIYwhBBC2McFCCGEEEJ47/yf1hrS6A1tWMMboxGNbMzGalRjN07jNl6jNUGELqhgggtDCCGFKSyhhC0c' +
  '4QpP/tCRTu9oxzreGZ3oZGd2Vqc6u3M6t/P6HxRRuqKKKa4MJZRUprKUUrZylKs8/YMhRjfUMMONYYSR' +
  'xjSWUcY2jnGNZ39wxOmOOua4M5xw0pnOcsrZznGu8/wPAxn0gQ5s4IMxiEEO5mANarAHZ3AHb/whkKAH' +
  'GljgwQgiyGAGK6hgBye4wYs/JJL0RBNLPBlJJJnMZCWV7OQkN3n5h4lM+kQnNvHJmMQkJ3OyJjXZkzO5' +
  'kzf/sJBFX+jCFr4Yi1jkYi7WohZ7cRZ38dYfCil6oYUVXowiiixmsYoqdnGKW7z6w0Y2faMb2/hmbGKT' +
  'm7lZm9rszdnczdt/OMihH/RgBz+MQxzyMA/rUId9OId7eOcPF7n0i17s4pdxiUte5mVd6rIv53Iv7/7h' +
  'IY/+0Ic9/DEe8cjHfKxHPfbjPO7jPT74o6QQb2NdBgAAAABJRU5ErkJggg==', 'base64');

// Only f5 carries a tag; everything else has to be read off its filename.
var ID3_FILES = {
  f5: {
    artist: 'Perturbator', title: 'Sentient', album: 'Dangerous Days',
    picture: COVER_PNG
  }
};

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/* Latin-1 where the text fits it, as most taggers write; otherwise UTF-16
 * behind a byte order mark, in whichever order is asked for. */
function textFrame(id, text, bigEndian) {
  var body;
  if (/^[\u0000-ÿ]*$/.test(text) && !bigEndian) {
    body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1'), Buffer.from([0])]);
  } else {
    var chars = Buffer.alloc(text.length * 2);
    for (var i = 0; i < text.length; i++) {
      if (bigEndian) chars.writeUInt16BE(text.charCodeAt(i), i * 2);
      else chars.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    body = Buffer.concat([
      Buffer.from([1]), Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]),
      chars, Buffer.from([0, 0])
    ]);
  }
  var head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function apicFrame(mime, data) {
  var body = Buffer.concat([
    Buffer.from([0]),                        // ISO-8859-1
    Buffer.from(mime, 'latin1'), Buffer.from([0]),
    Buffer.from([3]),                        // front cover
    Buffer.from('cover', 'latin1'), Buffer.from([0]),
    data
  ]);
  var head = Buffer.alloc(10);
  head.write('APIC', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function id3Buffer(meta) {
  var frames = Buffer.concat([
    meta.title ? textFrame('TIT2', meta.title, meta.bigEndian) : Buffer.alloc(0),
    meta.artist ? textFrame('TPE1', meta.artist, meta.bigEndian) : Buffer.alloc(0),
    meta.album ? textFrame('TALB', meta.album, meta.bigEndian) : Buffer.alloc(0),
    meta.picture ? apicFrame('image/png', meta.picture) : Buffer.alloc(0)
  ]);
  var body = Buffer.concat([frames, Buffer.alloc(128)]);
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(body.length), body
  ]);
}

/* A real, decodable 5-second tone so playback genuinely runs. */
function wav(seconds, freq) {
  var rate = 8000;
  var n = rate * seconds;
  var data = Buffer.alloc(n * 2);
  for (var i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2);
  }
  var head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

var AUDIO = wav(5, 440);

// Albums only its tags know about: one whose first track credits nobody,
// an artist spelled two ways, names a plain object already has an answer
// for, and one record spelled five ways by five different rips.
var ODD = 'odd-library';
var ODD_FILES = {};
ODD_FILES[ODD] = ['intro', 'heavy water', 'other side', 'build', 'proto',
                  'view', 'dancefloor', 'mardy', 'sun', 'riot'].map(function (name, i) {
  return { id: 'o' + i, name: name + '.mp3', mimeType: 'audio/mpeg' };
});
var ODD_ID3 = {
  o0: { title: 'Intro', album: 'Split' },
  o1: { title: 'Heavy Water', artist: 'Grouper', album: 'Split' },
  o2: { title: 'Other Side', artist: 'GROUPER', album: 'Split' },
  o3: { title: 'Build', artist: 'Nobody', album: 'Constructor' },
  o4: { title: 'Proto', artist: 'Nobody', album: '__proto__' },
  o5: { title: 'The View from the Afternoon', artist: 'Arctic Monkeys',
        album: "Whatever People Say I Am, That's What I'm Not" },
  o6: { title: 'I Bet You Look Good on the Dancefloor', artist: 'Arctic Monkeys',
        album: 'Whatever People Say I Am, That’s What I’m Not', bigEndian: true },
  o7: { title: 'Mardy Bum', artist: 'Arctic Monkeys',
        album: "Whatever People Say I Am That's What I'm Not (Bonus Track Version)" },
  // A modifier-letter apostrophe, and an edition note after a dash.
  o8: { title: 'When the Sun Goes Down', artist: 'Arctic Monkeys',
        album: 'Whatever People Say I Am, That\u02bcs What I\u02bcm Not' },
  o9: { title: 'Riot Van', artist: 'Arctic Monkeys',
        album: "Whatever People Say I Am, That's What I'm Not - Deluxe Edition" }
};

// Enough tracks that most start off the bottom of the screen. The tags name
// a different artist from the filename, so a row shows whether it was read.
var BIG = 'big-library';
var BIG_FILES = {};
var BIG_ID3 = {};
BIG_FILES[BIG] = [];
for (var b = 0; b < 120; b++) {
  var num = ('00' + b).slice(-3);
  BIG_FILES[BIG].push({ id: 'b' + b, name: 'Artist ' + num + ' - Song ' + num + '.mp3', mimeType: 'audio/mpeg' });
  BIG_ID3['b' + b] = { title: 'Song ' + num, artist: 'Band ' + num, album: 'Record ' + Math.floor(b / 10) };
}

/* ---------- static server for the app itself ---------- */

var MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
             '.json': 'application/json' };

function serve() {
  return new Promise(function (resolve) {
    var server = http.createServer(function (req, res) {
      var rel = req.url.split('?')[0];
      if (rel === '/') rel = '/index.html';
      var file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

      fs.readFile(file, function (err, body) {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

/* ---------- a library in a context of its own ---------- */

/* Opens the player in a fresh context against its own stubbed Drive, with
 * the key and folder already saved so it goes straight to the library. Tag
 * reads are answered after readDelay ms and counted, so a test can see
 * which files were read and whether two reads were ever in flight at once;
 * refuse(id), when given, picks the ones Drive turns away. */
async function openLibrary(browser, base, lib) {
  var ctx = await browser.newContext();
  var reads = { ids: [], refused: [], inFlight: 0, maxInFlight: 0 };

  await ctx.route(/googleapis\.com\/drive\/v3\/files/, function (route) {
    var request = route.request();
    var url = new URL(request.url());

    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Range'
        }
      });
    }

    if (url.searchParams.get('alt') === 'media') {
      var id = decodeURIComponent(url.pathname.split('/').pop());

      if ((request.headers()['range'] || '').indexOf('bytes=0-262143') === 0) {
        var meta = lib.id3[id];

        if (lib.refuse && lib.refuse(id)) {
          reads.refused.push(id);
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: { code: 403, message: 'nope' } })
          });
        }

        reads.ids.push(id);
        reads.inFlight++;
        reads.maxInFlight = Math.max(reads.maxInFlight, reads.inFlight);

        return new Promise(function (done) { setTimeout(done, lib.readDelay || 0); })
          .then(function () {
            reads.inFlight--;
            return route.fulfill({
              status: 206,
              headers: { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' },
              body: meta ? id3Buffer(meta) : AUDIO.slice(0, 1024)
            });
          });
      }

      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        },
        body: AUDIO
      });
    }

    var m = (url.searchParams.get('q') || '').match(/"([^"]+)" in parents/);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ files: lib.files[m && m[1]] || [] })
    });
  });

  var settings = { apiKey: 'AIzaTESTKEY', folderId: lib.folder };
  Object.keys(lib.settings || {}).forEach(function (k) { settings[k] = lib.settings[k]; });

  var seed = { 'drivePlayer.settings.v1': JSON.stringify(settings) };
  Object.keys(lib.storage || {}).forEach(function (k) { seed[k] = lib.storage[k]; });

  // Only the first load: a reload keeps whatever the page saved since.
  await ctx.addInitScript(function (seed) {
    if (localStorage.getItem('drivePlayer.settings.v1')) return;
    Object.keys(seed).forEach(function (k) { localStorage.setItem(k, seed[k]); });
  }, seed);

  var page = await ctx.newPage();
  var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });

  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  return { ctx: ctx, page: page, reads: reads, errors: errors };
}

/* ---------- layout ---------- */

function boxes(page) {
  return page.evaluate(function () {
    var box = function (sel) {
      var b = document.querySelector(sel).getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, height: b.height };
    };
    return {
      tabs: box('.tabs'),
      genres: box('#genres'),
      main: box('.main'),
      bar: box('.nowplaying'),
      genresHidden: document.getElementById('genres').hidden,
      viewport: window.innerHeight
    };
  });
}

/* The now playing bar keeps its own height at the bottom of the window, and
 * the list or grid gets all the room between it and whatever is above. */
function assertBarAtBottom(l, where) {
  var above = l.genresHidden ? l.tabs.bottom : l.genres.bottom;
  var seen = ' on the ' + where + ': ' + JSON.stringify(l);

  assert.ok(l.bar.height > 50 && l.bar.height < 140,
    'the now playing bar is ' + Math.round(l.bar.height) + 'px tall' + seen);
  assert.ok(Math.abs(l.bar.bottom - l.viewport) < 2,
    'the now playing bar is not at the bottom' + seen);
  assert.ok(Math.abs(l.main.top - above) < 2 && Math.abs(l.main.bottom - l.bar.top) < 2,
    'the list does not fill the room' + seen);
}

/* ---------- test harness ---------- */

var passed = 0;
var failed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL  ' + name + '\n      ' + (e && e.message));
  }
}

async function main() {
  var server = await serve();
  var base = 'http://127.0.0.1:' + server.address().port + '/index.html';

  // Use the browser that is already on the machine when there is one, so the
  // test does not depend on playwright's own download.
  var launch = {
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox']
  };
  var local = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  if (fs.existsSync(local)) launch.executablePath = local;

  var browser = await chromium.launch(launch);
  var context = await browser.newContext();
  var page = await context.newPage();

  var consoleErrors = [];
  page.on('pageerror', function (e) { consoleErrors.push(String(e)); });
  page.on('console', function (m) {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  // Stub the Drive API. A regex rather than a glob: playwright's glob "*"
  // does not cross a path separator, so the per-file /files/<id> media URLs
  // would slip past the handler and hit the network.
  await context.route(/googleapis\.com\/drive\/v3\/files/, function (route) {
    var request = route.request();
    var url = new URL(request.url());

    // A range request can be preflighted; answer it the way Google does.
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Max-Age': '600'
        }
      });
    }

    if (url.searchParams.get('alt') === 'media') {
      var id = decodeURIComponent(url.pathname.split('/').pop());
      var range = request.headers()['range'] || '';

      // The metadata probe asks for exactly the tag window; the <audio>
      // element asks for everything.
      if (range.indexOf('bytes=0-262143') === 0) {
        var meta = ID3_FILES[id];
        return route.fulfill({
          status: 206,
          headers: {
          'Content-Type': 'audio/mpeg',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Range'
        },
          body: meta ? id3Buffer(meta) : AUDIO.slice(0, 1024)
        });
      }

      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        },
        body: AUDIO
      });
    }

    var q = url.searchParams.get('q') || '';
    var m = q.match(/"([^"]+)" in parents/);
    var parent = m ? m[1] : '';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ files: FILES[parent] || [] })
    });
  });

  await page.goto(base);

  /* ---- setup ---- */

  await step('the setup screen appears when there is no saved key', async function () {
    await page.waitForSelector('#setup:not([hidden])');
    assert.ok(await page.isVisible('#setup-key'), 'no key field on the setup screen');
  });

  await step('a bad folder link is rejected before anything loads', async function () {
    await page.fill('#setup-folder', 'nonsense');
    await page.fill('#setup-key', 'AIzaTESTKEY');
    await page.click('#setup-go');
    await page.waitForSelector('#setup-error:not([hidden])');
    assert.ok(await page.isVisible('#setup'), 'setup should still be showing');
  });

  await step('a valid folder and key load the library', async function () {
    await page.fill('#setup-folder',
      'https://drive.google.com/drive/folders/' + FOLDER + '?usp=sharing');
    await page.click('#setup-go');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length > 0;
    });
  });

  /* ---- listing ---- */

  await step('lists audio from the folder and its subfolder, and skips images', async function () {
    var titles = await page.$$eval('.track-title', function (els) {
      return els.map(function (e) { return e.textContent; });
    });
    assert.strictEqual(titles.length, 10, 'expected 10 tracks, got ' + titles.length + ': ' + titles);
    assert.ok(titles.some(function (t) { return /Roygbiv/.test(t); }), 'subfolder track missing');
    assert.ok(!titles.some(function (t) { return /cover/i.test(t); }), 'image was listed');
  });

  await step('filenames are cleaned up into artist and title', async function () {
    var rows = await page.$$eval('.track', function (els) {
      return els.map(function (e) {
        return {
          title: e.querySelector('.track-title').textContent,
          artist: e.querySelector('.track-artist').textContent
        };
      });
    });
    var comTruise = rows.filter(function (r) { return r.artist === 'Com Truise'; })[0];
    assert.ok(comTruise, 'Com Truise row not found: ' + JSON.stringify(rows));
    assert.strictEqual(comTruise.title, 'Propagation');
  });

  await step('a title-first filename is read the right way round', async function () {
    var row = await page.$$eval('.track', function (els) {
      return els.map(function (e) {
        return {
          title: e.querySelector('.track-title').textContent,
          artist: e.querySelector('.track-artist').textContent
        };
      }).filter(function (r) { return r.title === 'Borderline'; })[0];
    });

    assert.ok(row, 'Borderline not listed');
    assert.strictEqual(row.artist, 'Tame Impala',
      'title-first filename not flipped: ' + JSON.stringify(row));
  });

  await step('a bare title in an artist-named folder is credited to that artist',
    async function () {
      var row = await page.$$eval('.track', function (els) {
        return els.map(function (e) {
          return {
            title: e.querySelector('.track-title').textContent,
            artist: e.querySelector('.track-artist').textContent,
            tags: Array.prototype.map.call(e.querySelectorAll('.tag'),
              function (t) { return t.textContent; })
          };
        }).filter(function (r) { return r.title === 'Elephant'; })[0];
      });

      assert.ok(row, 'Elephant not listed');
      assert.strictEqual(row.artist, 'Tame Impala',
        'folder name not used as the artist: ' + JSON.stringify(row));
      assert.ok(row.tags.indexOf('Unsorted') === -1,
        'still untagged despite a known artist: ' + JSON.stringify(row));
    });

  await step('ID3 tags replace the filename guess once they are read', async function () {
    await page.waitForFunction(function () {
      return Array.prototype.some.call(document.querySelectorAll('.track-artist'),
        function (e) { return e.textContent === 'Perturbator'; });
    }, null, { timeout: 10000 });

    var row = await page.$('.track:has(.track-artist:text-is("Perturbator")) .track-title');
    assert.strictEqual(await row.textContent(), 'Sentient');
  });

  /* ---- genres ---- */

  await step('the genre bar is built from what the library actually contains', async function () {
    var chips = await page.$$eval('#genres .chip', function (els) {
      return els.map(function (e) { return e.textContent; });
    });
    assert.ok(chips[0].indexOf('All') === 0, 'first chip should be All: ' + chips[0]);
    assert.ok(chips.some(function (c) { return c.indexOf('Synth') === 0; }), 'no Synth chip: ' + chips);
    assert.ok(chips.some(function (c) { return c.indexOf('Unsorted') === 0; }), 'no Unsorted chip');
  });

  await step('the brief: filtering by Synth returns Tame Impala and Sidewalks and Skeletons',
    async function () {
      await page.click('#genres .chip >> text=/^Synth/');

      await page.waitForFunction(function () {
        return document.querySelector('#genres .chip.on').textContent.indexOf('Synth') === 0;
      });

      var artists = await page.$$eval('.track-artist', function (els) {
        return els.map(function (e) { return e.textContent; });
      });
      assert.ok(artists.indexOf('Tame Impala') !== -1, 'Tame Impala missing: ' + artists);
      assert.ok(artists.indexOf('Sidewalks and Skeletons') !== -1, 'Sidewalks and Skeletons missing: ' + artists);
      assert.ok(artists.indexOf('Perturbator') !== -1, 'Perturbator missing: ' + artists);
      assert.ok(artists.indexOf('Boards of Canada') === -1, 'Boards of Canada should not be Synth');
    });

  await step('All brings everything back', async function () {
    await page.click('#genres .chip >> text=/^All/');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 10;
    });
  });

  /* ---- search ---- */

  await step('search narrows the list and clears cleanly', async function () {
    await page.fill('#search', 'roygbiv');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 1;
    });
    await page.fill('#search', '');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 10;
    });
  });

  /* ---- playback ---- */

  await step('clicking a track plays it', async function () {
    await page.click('#tracklist .track:nth-child(1)');
    await page.waitForFunction(function () {
      var a = document.getElementById('audio');
      return !a.paused && a.currentTime > 0.15;
    }, null, { timeout: 10000 });

    var np = await page.textContent('#np-title');
    assert.ok(np && np !== 'Nothing playing', 'now playing not updated');
    assert.strictEqual(await page.$$eval('#tracklist .track.playing', function (e) { return e.length; }), 1);
  });

  await step('space pauses and resumes', async function () {
    await page.keyboard.press('Space');
    await page.waitForFunction(function () { return document.getElementById('audio').paused; });
    await page.keyboard.press('Space');
    await page.waitForFunction(function () { return !document.getElementById('audio').paused; });
  });

  await step('next and previous move through the queue', async function () {
    var first = await page.textContent('#np-title');
    await page.click('#btn-next');
    await page.waitForFunction(function (t) {
      return document.getElementById('np-title').textContent !== t;
    }, first);

    var second = await page.textContent('#np-title');
    assert.notStrictEqual(second, first);

    // The first press restarts a track that is already past 3s, so seek back.
    await page.evaluate(function () { document.getElementById('audio').currentTime = 0; });
    await page.click('#btn-prev');
    await page.waitForFunction(function (t) {
      return document.getElementById('np-title').textContent === t;
    }, first);
  });

  await step('seeking by clicking the bar moves playback', async function () {
    var el = await page.$('#seek');
    var box = await el.boundingBox();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.waitForFunction(function () {
      return document.getElementById('audio').currentTime > 2;
    }, null, { timeout: 5000 });
  });

  await step('shuffle and repeat toggle and stick', async function () {
    await page.click('#btn-shuffle');
    assert.ok(await page.$eval('#btn-shuffle', function (e) { return e.classList.contains('on'); }));

    await page.click('#btn-repeat');   // all -> one
    assert.ok(await page.$eval('#repeat-badge', function (e) { return !e.hidden; }),
      'repeat-one badge not shown');
    await page.click('#btn-repeat');   // one -> off
    assert.ok(await page.$eval('#btn-repeat', function (e) { return !e.classList.contains('on'); }));
    await page.click('#btn-repeat');   // off -> all
  });

  await step('shuffle still plays every track exactly once before repeating',
    async function () {
      var order = await page.evaluate(function () {
        var p = window.DrivePlayer.player;
        p.setShuffle(true);
        p.rebuildOrder(false);
        return p.order.slice();
      });
      var unique = {};
      order.forEach(function (i) { unique[i] = true; });
      assert.strictEqual(order.length, 10, 'order length ' + order.length);
      assert.strictEqual(Object.keys(unique).length, 10, 'shuffle dropped or repeated entries');
    });

  /* ---- tagging ---- */

  await step('a genre can be re-tagged by hand and the bar updates', async function () {
    await page.evaluate(function () { window.DrivePlayer.player.setShuffle(false); });
    await page.click('#genres .chip >> text=/^All/');

    // Open the editor from the first track's tag chip.
    await page.click('#tracklist .track:nth-child(1) .track-tags .tag');
    await page.waitForSelector('#tagdlg:not([hidden])');

    await page.click('#tagdlg-tags .chip >> text=Metal');
    await page.fill('#tagdlg-custom', 'Late Night');
    await page.click('#tagdlg-save');
    await page.waitForFunction(function () {
      return document.getElementById('tagdlg').hidden;
    });

    await page.waitForFunction(function () {
      var chips = document.querySelectorAll('#genres .chip');
      return Array.prototype.some.call(chips, function (c) { return c.textContent.indexOf('Late Night') === 0; });
    });

    // The editor starts from the tags a track already has, so Metal joins
    // them rather than replacing them. What matters is that filtering by the
    // new genres finds the track.
    var tagged = await page.evaluate(function () {
      return window.DrivePlayer.tracks()[0].tags.slice();
    });
    assert.ok(tagged.indexOf('Metal') !== -1, 'Metal not applied: ' + tagged);
    assert.ok(tagged.indexOf('Late Night') !== -1, 'custom tag not applied: ' + tagged);

    await page.click('#genres .chip >> text=/^Metal/');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 1;
    });

    await page.click('#genres .chip >> text=/^Late Night/');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 1;
    });

    await page.click('#genres .chip >> text=/^All/');
  });

  await step('manual tags survive a reload', async function () {
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 10;
    });

    var chips = await page.$$eval('#genres .chip', function (els) {
      return els.map(function (e) { return e.textContent; });
    });
    assert.ok(chips.some(function (c) { return c.indexOf('Late Night') === 0; }),
      'custom genre lost on reload: ' + chips);
  });

  await step('the saved key means setup is not asked for again', async function () {
    assert.ok(await page.$eval('#setup', function (e) { return e.hidden; }),
      'setup shown despite saved settings');
  });

  /* ---- resilience ---- */

  await step('an unplayable file is marked and skipped rather than stopping playback',
    async function () {
      await page.evaluate(function () {
        var p = window.DrivePlayer.player;
        p.queue.forEach(function (t, i) { if (i === 0) t.url = 'http://127.0.0.1:9/none.mp3'; });
      });
      await page.click('#tracklist .track:nth-child(1)');
      await page.waitForFunction(function () {
        return document.querySelectorAll('#tracklist .track.dead').length === 1;
      }, null, { timeout: 10000 });
      await page.waitForFunction(function () {
        var a = document.getElementById('audio');
        return !a.paused || a.currentTime > 0;
      }, null, { timeout: 10000 });
    });

  await step('the page reported no script errors', async function () {
    var real = consoleErrors.filter(function (e) {
      return !/net::ERR|Failed to load resource|MEDIA_ELEMENT_ERROR|play\(\) request/i.test(e);
    });
    assert.deepStrictEqual(real, []);
  });

  /* ---- the failure mode where listing works but downloads do not ---- */

  await step('a folder that lists but will not download explains itself',
    async function () {
      var ctx2 = await browser.newContext();

      await ctx2.route(/googleapis\.com\/drive\/v3\/files/, function (route) {
        var url = new URL(route.request().url());

        if (url.searchParams.get('alt') === 'media') {
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({
              error: {
                code: 403,
                message: 'Requests from referer <empty> are blocked.',
                errors: [{ reason: 'forbidden' }]
              }
            })
          });
        }

        var m = (url.searchParams.get('q') || '').match(/"([^"]+)" in parents/);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ files: FILES[m && m[1]] || [] })
        });
      });

      var page2 = await ctx2.newPage();
      await page2.goto(base);
      await page2.fill('#setup-folder', 'https://drive.google.com/drive/folders/' + FOLDER);
      await page2.fill('#setup-key', 'AIzaTESTKEY');
      await page2.click('#setup-go');
      await page2.waitForSelector('#tracklist .track');

      await page2.click('#tracklist .track:nth-child(1)');

      await page2.waitForFunction(function () {
        var s = document.getElementById('status');
        return !s.hidden && /403/.test(s.textContent);
      }, null, { timeout: 15000 });

      var message = await page2.textContent('#status');
      assert.ok(/refused the download/i.test(message), 'unhelpful message: ' + message);
      assert.ok(/referer/i.test(message), 'Drive reason not passed through: ' + message);

      await ctx2.close();
    });

  await step('a refused download is not remembered as "this file has no tag"',
    async function () {
      var ctxA = await browser.newContext();
      var refuse = true;

      await ctxA.route(/googleapis\.com\/drive\/v3\/files/, function (route) {
        var url = new URL(route.request().url());

        if (url.searchParams.get('alt') === 'media') {
          if (refuse) {
            return route.fulfill({
              status: 403,
              contentType: 'application/json',
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: JSON.stringify({ error: { code: 403, message: 'nope' } })
            });
          }
          var id = decodeURIComponent(url.pathname.split('/').pop());
          var meta = ID3_FILES[id];
          return route.fulfill({
            status: 206,
            headers: { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' },
            body: meta ? id3Buffer(meta) : AUDIO.slice(0, 1024)
          });
        }

        var m = (url.searchParams.get('q') || '').match(/"([^"]+)" in parents/);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ files: FILES[m && m[1]] || [] })
        });
      });

      var pageA = await ctxA.newPage();
      await pageA.goto(base);
      await pageA.fill('#setup-folder', 'https://drive.google.com/drive/folders/' + FOLDER);
      await pageA.fill('#setup-key', 'AIzaTESTKEY');
      await pageA.click('#setup-go');
      await pageA.waitForSelector('#tracklist .track');

      // Give the (failing) metadata pass time to run and, previously, to
      // write "no tag" into the cache for every file.
      await pageA.waitForTimeout(2500);

      var beforeFix = await pageA.evaluate(function () {
        return Array.prototype.some.call(document.querySelectorAll('.track-artist'),
          function (e) { return e.textContent === 'Perturbator'; });
      });
      assert.ok(!beforeFix, 'ID3 somehow read while downloads were refused');

      // Permissions come good; a reload must try again rather than trust a
      // verdict it never actually reached.
      refuse = false;
      await pageA.reload();
      await pageA.waitForSelector('#tracklist .track');

      await pageA.waitForFunction(function () {
        return Array.prototype.some.call(document.querySelectorAll('.track-artist'),
          function (e) { return e.textContent === 'Perturbator'; });
      }, null, { timeout: 15000 });

      await ctxA.close();
    });

  await step('a folder that downloads but will not decode blames the format',
    async function () {
      var ctx3 = await browser.newContext();

      await ctx3.route(/googleapis\.com\/drive\/v3\/files/, function (route) {
        var url = new URL(route.request().url());

        if (url.searchParams.get('alt') === 'media') {
          // Served happily, but it is not audio this browser can play.
          return route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'audio/x-ms-wma', 'Access-Control-Allow-Origin': '*' },
            body: Buffer.from('not really audio at all')
          });
        }

        var m = (url.searchParams.get('q') || '').match(/"([^"]+)" in parents/);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ files: FILES[m && m[1]] || [] })
        });
      });

      var page3 = await ctx3.newPage();
      await page3.goto(base);
      await page3.fill('#setup-folder', 'https://drive.google.com/drive/folders/' + FOLDER);
      await page3.fill('#setup-key', 'AIzaTESTKEY');
      await page3.click('#setup-go');
      await page3.waitForSelector('#tracklist .track');

      await page3.click('#tracklist .track:nth-child(1)');

      await page3.waitForFunction(function () {
        var s = document.getElementById('status');
        return !s.hidden && /cannot\s+decode/i.test(s.textContent);
      }, null, { timeout: 15000 });

      await ctx3.close();
    });

  /* ---- the queue ---- */

  await step('a track can be queued without playing it', async function () {
    await page.click('.tab[data-facet="genre"]');
    await page.click('#genres .chip >> text=/^All/');
    await page.waitForSelector('#tracklist:not([hidden])');

    var before = await page.textContent('#np-title');

    await page.click('#tracklist .track:nth-child(3) .track-add');
    await page.waitForSelector('#adddlg:not([hidden])');
    await page.click('#add-queue');
    await page.waitForFunction(function () { return document.getElementById('adddlg').hidden; });

    await page.waitForFunction(function () {
      return !document.getElementById('queue-badge').hidden;
    });
    assert.strictEqual(await page.textContent('#queue-badge'), '1');

    // Queueing must not hijack what is playing.
    assert.strictEqual(await page.textContent('#np-title'), before,
      'adding to the queue changed the current track');
  });

  await step('a queued track plays next, then the order resumes where it was',
    async function () {
      var state = await page.evaluate(function () {
        var p = window.DrivePlayer.player;

        // An earlier test pointed queue[0] at a dead URL to prove a bad file
        // is skipped. Put it back, or its error auto-advances and eats the
        // queued track before this test can click anything.
        p.queue.forEach(function (t) {
          if (t.url.indexOf('googleapis.com') === -1) {
            t.url = 'https://www.googleapis.com/drive/v3/files/' + t.id +
              '?alt=media&key=AIzaTESTKEY';
            t.dead = false;
          }
        });

        p.setShuffle(false);
        p.clearUpNext();
        p.playIndex(1);
        var queued = p.queue[3];
        p.enqueue(queued, false);
        return { pos: p.pos, queued: queued.id, next: p.queue[2].id };
      });

      // Skipping should take the queued track, not the next one in the list.
      await page.click('#btn-next');
      var playing = await page.evaluate(function () {
        return window.DrivePlayer.player.nowPlaying().id;
      });
      assert.strictEqual(playing, state.queued, 'the queued track did not play next');

      var pos = await page.evaluate(function () { return window.DrivePlayer.player.pos; });
      assert.strictEqual(pos, state.pos,
        'playing a queued track moved the position in the order');

      // With the queue drained, the list carries on from where it was.
      await page.click('#btn-next');
      var after = await page.evaluate(function () {
        return window.DrivePlayer.player.nowPlaying().id;
      });
      assert.strictEqual(after, state.next,
        'the order did not resume where it left off');
    });

  await step('the queue panel lists and removes queued tracks', async function () {
    await page.evaluate(function () {
      var p = window.DrivePlayer.player;
      p.clearUpNext();
      p.enqueue(p.queue[4], false);
      p.enqueue(p.queue[5], false);
    });

    await page.click('#btn-queue');
    await page.waitForSelector('#queuedlg:not([hidden])');

    var queued = await page.$$eval('.queuerow:not(.later)', function (els) { return els.length; });
    assert.strictEqual(queued, 2, 'expected 2 hand-queued rows, got ' + queued);

    await page.click('.queuerow:not(.later) .icon-btn');
    await page.waitForFunction(function () {
      return document.querySelectorAll('.queuerow:not(.later)').length === 1;
    });
    assert.strictEqual(await page.textContent('#queue-badge'), '1');

    await page.click('#queue-clear');
    await page.waitForFunction(function () {
      return document.getElementById('queue-badge').hidden;
    });
    await page.click('#queue-close');
  });

  await step('a queue survives a reload', async function () {
    await page.evaluate(function () {
      var p = window.DrivePlayer.player;
      p.clearUpNext();
      p.enqueue(p.queue[6], false);
    });

    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(function () {
      return window.DrivePlayer && window.DrivePlayer.tracks().length === 10;
    });

    await page.waitForFunction(function () {
      return window.DrivePlayer.player.upNext.length === 1;
    }, null, { timeout: 10000 });

    await page.evaluate(function () { window.DrivePlayer.player.clearUpNext(); });
  });

  /* ---- playlists ---- */

  await step('a playlist can be started from a track', async function () {
    await page.evaluate(function () { window.DrivePlayer.player.clearUpNext(); });
    await page.click('.tab[data-facet="genre"]');
    await page.waitForSelector('#tracklist:not([hidden])');

    await page.click('#tracklist .track:nth-child(2) .track-add');
    await page.waitForSelector('#adddlg:not([hidden])');

    await page.fill('#add-newname', 'Late Night');
    await page.click('#add-create');

    // The row flips to "Remove", which is how you can tell it went in.
    await page.waitForFunction(function () {
      return document.querySelector('#add-playlists .pl-row.in') !== null;
    });

    await page.click('#add-close');
  });

  await step('the Playlists tab shows it and plays it in the order built',
    async function () {
      // Add a second track, so order is observable.
      await page.click('#tracklist .track:nth-child(5) .track-add');
      await page.waitForSelector('#adddlg:not([hidden])');
      await page.click('#add-playlists .pl-row');
      await page.click('#add-close');

      await page.click('.tab[data-facet="playlist"]');
      await page.waitForSelector('#browse:not([hidden])');

      var card = await page.$$eval('.card', function (cards) {
        return cards.map(function (c) {
          return {
            name: c.querySelector('.card-name').textContent,
            count: c.querySelector('.card-count').textContent
          };
        });
      });
      assert.strictEqual(card.length, 1, 'expected one playlist: ' + JSON.stringify(card));
      assert.strictEqual(card[0].name, 'Late Night');
      assert.strictEqual(card[0].count, '2 tracks');

      await page.click('.card:has(.card-name:text-is("Late Night"))');
      await page.waitForSelector('#crumb:not([hidden])');

      var titles = await page.$$eval('.track-title', function (els) {
        return els.map(function (e) { return e.textContent; });
      });
      assert.strictEqual(titles.length, 2, 'playlist should hold 2 tracks: ' + titles);

      // Built second-then-fifth, so that is the order it plays in, not the
      // library's.
      var order = await page.evaluate(function () {
        return window.DrivePlayer.player.queue.map(function (t) { return t.id; });
      });
      assert.deepStrictEqual(order.length, 2, 'queue should be the playlist');
    });

  await step('a track can be taken back out of a playlist', async function () {
    await page.click('#tracklist .track:nth-child(1) .track-add');
    await page.waitForSelector('#adddlg:not([hidden])');
    await page.click('#add-playlists .pl-row.in');      // shows "Remove"
    await page.click('#add-close');

    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 1;
    });
  });

  await step('a playlist found by searching opens with all of its tracks', async function () {
    await page.click('#crumb-back');
    await page.waitForSelector('#browse:not([hidden])');

    // "late" finds Late Night by its name. Nothing about the song left in it
    // says "late", so applying the search again inside emptied the list.
    await page.fill('#search', 'late');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#browse .card').length === 1;
    });
    await page.click('.card:has(.card-name:text-is("Late Night"))');
    await page.waitForSelector('#crumb:not([hidden])');

    var rows = await page.$$eval('#tracklist .track', function (e) { return e.length; });
    await page.fill('#search', '');

    assert.strictEqual(rows, 1, 'the playlist came up empty');
  });

  await step('playlists survive a reload, and can be deleted', async function () {
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#browse:not([hidden])');

    var names = await page.$$eval('.card-name', function (els) {
      return els.map(function (e) { return e.textContent; });
    });
    assert.deepStrictEqual(names, ['Late Night'], 'playlist lost on reload: ' + names);

    await page.click('.card:has(.card-name:text-is("Late Night"))');
    await page.waitForSelector('#crumb-delete:not([hidden])');
    await page.click('#crumb-delete');

    await page.waitForFunction(function () {
      return document.querySelectorAll('#browse .card').length === 0;
    });

    // Hand the app back on the Genres tab: later steps click genre chips, and
    // those are hidden on every other tab.
    await page.click('.tab[data-facet="genre"]');
    await page.waitForSelector('#genres:not([hidden])');
  });

  /* ---- tagging a whole artist at once ---- */

  await step('tagging by artist covers every track by them', async function () {
    await page.click('#genres .chip >> text=/^All/');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 10;
    });

    // "untitled demo 2.mp3" has no artist and no tags; Boards of Canada does.
    await page.click('.track:has(.track-artist:text-is("Boards of Canada")) .track-tags .tag');
    await page.waitForSelector('#tagdlg:not([hidden])');

    assert.ok(!(await page.$eval('#tagdlg-artistrow', function (e) { return e.hidden; })),
      'the artist option should be offered');
    var label = await page.textContent('#tagdlg-artistlabel');
    assert.ok(/Boards of Canada/.test(label), label);

    await page.check('#tagdlg-artist');
    await page.click('#tagdlg-tags .chip >> text=Jazz');
    await page.click('#tagdlg-save');
    await page.waitForFunction(function () { return document.getElementById('tagdlg').hidden; });

    var tags = await page.evaluate(function () {
      var t = window.DrivePlayer.tracks().filter(function (x) {
        return x.artist === 'Boards of Canada';
      })[0];
      return t.tags.slice();
    });
    assert.ok(tags.indexOf('Jazz') !== -1, 'artist rule not applied: ' + tags);
  });

  await step('a track with no artist is not offered the artist option', async function () {
    await page.click('.track:has(.track-artist:text-is("Unknown artist")) .track-tags .tag');
    await page.waitForSelector('#tagdlg:not([hidden])');
    assert.ok(await page.$eval('#tagdlg-artistrow', function (e) { return e.hidden; }),
      'artist option offered for a track with no artist');
    await page.click('#tagdlg-cancel');
  });

  await step('the untagged-artist export lists only what needs tagging',
    async function () {
      var payload = await page.evaluate(function () {
        // Capture what the download would contain, without a file dialog.
        var captured = null;
        var realCreate = URL.createObjectURL;
        var reader = null;

        return new Promise(function (resolve) {
          // If no download is produced, fail fast rather than hanging.
          var giveUp = setTimeout(function () {
            URL.createObjectURL = realCreate;
            resolve(null);
          }, 5000);

          URL.createObjectURL = function (blob) {
            captured = blob;
            reader = new FileReader();
            reader.onload = function () {
              clearTimeout(giveUp);
              URL.createObjectURL = realCreate;
              resolve(JSON.parse(reader.result));
            };
            reader.readAsText(blob);
            return 'blob:stub';
          };
          document.getElementById('set-untagged').click();
        });
      });

      assert.ok(payload, 'no file was produced by the untagged export');
      assert.strictEqual(payload.version, 2);
      assert.ok(Array.isArray(payload.genres) && payload.genres.length > 5,
        'the genre vocabulary should be included for whoever fills this in');

      var names = Object.keys(payload.artists);
      names.forEach(function (n) {
        assert.deepStrictEqual(payload.artists[n], [], n + ' should be blank');
      });
      assert.ok(names.indexOf('Grouper') !== -1, 'the untagged artist was not listed: ' + names);
      assert.ok(names.indexOf('Tame Impala') === -1, 'a tagged artist was listed');
      assert.ok(names.indexOf('Boards of Canada') === -1, 'the artist just tagged was listed');
    });

  await step('importing a filled-in artist file tags the library', async function () {
    var applied = await page.evaluate(function () {
      var file = new File([JSON.stringify({
        version: 2,
        artists: { 'THE Local Band': ['Punk'], 'Com Truise': ['Jazz'] }
      })], 'genres.json', { type: 'application/json' });

      var input = document.getElementById('set-file');
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));

      return new Promise(function (resolve) {
        setTimeout(function () {
          var t = window.DrivePlayer.tracks().filter(function (x) {
            return x.artist === 'Com Truise';
          })[0];
          resolve(t.tags.slice());
        }, 400);
      });
    });

    assert.ok(applied.indexOf('Jazz') !== -1,
      'imported artist rule not applied (case-insensitive match?): ' + applied);
  });

  await step('imported artist rules survive a reload', async function () {
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 10;
    });

    var tags = await page.evaluate(function () {
      var t = window.DrivePlayer.tracks().filter(function (x) {
        return x.artist === 'Com Truise';
      })[0];
      return t.tags.slice();
    });
    assert.ok(tags.indexOf('Jazz') !== -1, 'artist rule lost on reload: ' + tags);
  });

  await step('looking up genres online places an artist the player did not know',
    async function () {
      // Grouper is in the fixture precisely because nothing can tag it.
      await context.route('https://musicbrainz.org/**', function (route) {
        var url = route.request().url();

        if (url.indexOf('/artist?') !== -1) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({
              artists: [{ id: 'grouper-id', name: 'Grouper', score: 100 }]
            })
          });
        }

        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            id: 'grouper-id',
            name: 'Grouper',
            genres: [{ name: 'ambient' }, { name: 'dream pop' }],
            tags: [{ name: 'drone', count: 2 }]
          })
        });
      });

      await page.click('#genres .chip >> text=/^All/');
      await page.click('#btn-settings');
      await page.waitForSelector('#setdlg:not([hidden])');
      await page.click('#set-lookup');

      await page.waitForFunction(function () {
        var rows = document.querySelectorAll('.track');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].querySelector('.track-artist').textContent !== 'Grouper') continue;
          var tags = rows[i].querySelectorAll('.tag');
          for (var j = 0; j < tags.length; j++) {
            if (tags[j].textContent === 'Ambient') return true;
          }
        }
        return false;
      }, null, { timeout: 30000 });
    });

  await step('an online result survives a reload without asking again',
    async function () {
      var asked = 0;
      await context.route('https://musicbrainz.org/**', function (route) {
        asked++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ artists: [] })
        });
      });

      await page.reload();
      await page.waitForSelector('#app:not([hidden])');
      await page.waitForFunction(function () {
        return Array.prototype.some.call(document.querySelectorAll('.track'),
          function (row) {
            if (row.querySelector('.track-artist').textContent !== 'Grouper') return false;
            return Array.prototype.some.call(row.querySelectorAll('.tag'),
              function (t) { return t.textContent === 'Ambient'; });
          });
      }, null, { timeout: 15000 });

      assert.strictEqual(asked, 0, 'MusicBrainz was queried again after caching');
    });

  await step('a cover embedded in a tag shows in the list and now playing',
    async function () {
      // The tag pass already downloads these bytes; artwork must not cost a
      // request of its own, so nothing new is fetched here.
      await page.waitForFunction(function () {
        var rows = document.querySelectorAll('.track');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].querySelector('.track-artist').textContent !== 'Perturbator') continue;
          var img = rows[i].querySelector('.art');
          return !!(img && img.src && img.src.indexOf('blob:') === 0);
        }
        return false;
      }, null, { timeout: 20000 });

      // A track with no cover must show a blank slot, not a broken image.
      var blank = await page.evaluate(function () {
        var rows = document.querySelectorAll('.track');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].querySelector('.track-artist').textContent !== 'Unknown artist') continue;
          var img = rows[i].querySelector('.art');
          return { src: img.getAttribute('src') || '', complete: img.complete };
        }
        return null;
      });
      assert.ok(blank && blank.src.indexOf('data:image/gif') === 0,
        'a coverless row should hold a blank placeholder: ' + JSON.stringify(blank));
      assert.ok(blank.complete, 'the placeholder failed to load');

      var size = await page.evaluate(function () {
        var rows = document.querySelectorAll('.track');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].querySelector('.track-artist').textContent !== 'Perturbator') continue;
          var img = rows[i].querySelector('.art');
          return { w: img.naturalWidth, h: img.naturalHeight };
        }
        return null;
      });

      assert.ok(size && size.w > 0, 'the thumbnail did not decode: ' + JSON.stringify(size));
      assert.ok(size.w <= 128 && size.h <= 128,
        'thumbnails should be shrunk, got ' + JSON.stringify(size));

      // And the same stored thumbnail feeds the now playing corner.
      await page.click('.track:has(.track-artist:text-is("Perturbator"))');
      await page.waitForFunction(function () {
        var img = document.getElementById('np-img');
        return !img.hidden && img.src.indexOf('blob:') === 0;
      }, null, { timeout: 15000 });
    });

  await step('the genre bar is a bar and the list gets the room', async function () {
    // The app is a grid with one row per child. An extra child with no row of
    // its own takes the 1fr, and the genre chips balloon while the list is
    // squeezed to nothing - which is exactly what adding the tabs did.
    await page.click('.tab[data-facet="genre"]');
    await page.waitForSelector('#genres:not([hidden])');

    var sizes = await page.evaluate(function () {
      var box = function (sel) {
        return document.querySelector(sel).getBoundingClientRect().height;
      };
      return {
        genres: box('#genres'),
        main: box('.main'),
        chip: document.querySelector('#genres .chip').getBoundingClientRect(),
        viewport: window.innerHeight
      };
    });

    assert.ok(sizes.genres < 90,
      'the genre bar should be a bar, not ' + Math.round(sizes.genres) + 'px');
    assert.ok(sizes.main > sizes.viewport / 3,
      'the track list got squeezed to ' + Math.round(sizes.main) + 'px');
    assert.ok(sizes.chip.height > 22 && sizes.chip.width > 40,
      'genre chips collapsed: ' + JSON.stringify(sizes.chip));
  });

  /* ---- browsing by artist and album ---- */

  await step('the Artists tab lists artists with their track counts',
    async function () {
      await page.click('.tab[data-facet="artist"]');
      await page.waitForSelector('#browse:not([hidden])');

      assert.ok(await page.$eval('#genres', function (e) { return e.hidden; }),
        'genre chips should be hidden while browsing artists');
      assert.ok(await page.$eval('#tracklist', function (e) { return e.hidden; }),
        'the track list should be hidden while browsing');

      var names = await page.$$eval('.card-name', function (els) {
        return els.map(function (e) { return e.textContent; });
      });
      assert.ok(names.indexOf('Tame Impala') !== -1, 'Tame Impala missing: ' + names);
      assert.ok(names.indexOf('Weezer') === -1, 'an artist not in the library was listed');

      // Three in the fixture: the dash-named one, the title-first one, and
      // the bare title in its own folder.
      var count = await page.$$eval('.card', function (cards) {
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].querySelector('.card-name').textContent === 'Tame Impala') {
            return cards[i].querySelector('.card-count').textContent;
          }
        }
        return '';
      });
      assert.strictEqual(count, '3 tracks', 'wrong count: ' + count);
    });

  await step('picking an artist shows only their tracks, and Back returns',
    async function () {
      await page.click('.card:has(.card-name:text-is("Tame Impala"))');
      await page.waitForSelector('#crumb:not([hidden])');

      assert.strictEqual(await page.textContent('#crumb-label'), 'Tame Impala');

      var artists = await page.$$eval('.track-artist', function (els) {
        return els.map(function (e) { return e.textContent; });
      });
      assert.strictEqual(artists.length, 3, 'expected 3 tracks: ' + artists);
      artists.forEach(function (a) { assert.strictEqual(a, 'Tame Impala'); });

      await page.click('#crumb-back');
      await page.waitForSelector('#browse:not([hidden])');
      assert.ok(await page.$eval('#crumb', function (e) { return e.hidden; }));
    });

  await step('the Albums tab groups by album, including tracks with none',
    async function () {
      await page.click('.tab[data-facet="album"]');
      await page.waitForSelector('#browse:not([hidden])');

      var names = await page.$$eval('.card-name', function (els) {
        return els.map(function (e) { return e.textContent; });
      });
      assert.ok(names.indexOf('Dangerous Days') !== -1,
        'the album read from ID3 is missing: ' + names);
      assert.ok(names.indexOf('No album') !== -1,
        'tracks without an album should still be reachable: ' + names);
    });

  await step('once every tag is read, the Albums tab says what is left in No album',
    async function () {
      // A No album card that has stopped shrinking looked the same whether
      // reading was resting, refused or finished.
      await page.waitForSelector('#browse-note:not([hidden])');
      var note = await page.textContent('#browse-note');
      assert.ok(/no album name in its tags/.test(note), 'note: ' + note);
    });

  await step('the now playing bar stays a bar on the Albums tab, over the grid or an album',
    async function () {
      // The genre bar is hidden on every tab but Genres, and a hidden child
      // takes no row: the grid slid into the genre bar's row and the 1fr went
      // to the now playing bar, which ballooned over a short grid and went
      // off the bottom of the screen under a long one.
      assertBarAtBottom(await boxes(page), 'album grid');

      await page.click('.card:has(.card-name:text-is("Dangerous Days"))');
      await page.waitForSelector('#crumb:not([hidden])');
      assertBarAtBottom(await boxes(page), 'album');

      await page.click('#crumb-back');
      await page.waitForSelector('#browse:not([hidden])');
    });

  await step('an album found by searching opens with all of its tracks', async function () {
    // "No album" is the card's name, not anything a track says about itself,
    // so applying the search that found the card again inside it emptied it.
    await page.fill('#search', 'no album');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#browse .card').length === 1;
    });
    await page.click('.card:has(.card-name:text-is("No album"))');
    await page.waitForSelector('#crumb:not([hidden])');

    var rows = await page.$$eval('#tracklist .track', function (e) { return e.length; });

    // Tidy up before judging, so a failure here does not leak into later steps.
    await page.fill('#search', '');
    await page.click('#crumb-back');
    await page.waitForSelector('#browse:not([hidden])');

    assert.ok(rows > 0, 'the album came up empty');
  });

  await step('an album can be applied to a whole folder at once', async function () {
    // Two tracks by different artists sit in "Deep Cuts"; naming the album
    // once should pull both together, the way a soundtrack needs.
    await page.click('.tab[data-facet="genre"]');
    await page.waitForSelector('#tracklist:not([hidden])');
    await page.click('.track:has(.track-artist:text-is("Boards of Canada")) .track-tags .tag');
    await page.waitForSelector('#tagdlg:not([hidden])');

    assert.ok(!(await page.$eval('#tagdlg-folderrow', function (e) { return e.hidden; })),
      'the folder option should be offered for a track in a folder');

    await page.fill('#tagdlg-album', 'Deep Cuts Compilation');
    await page.check('#tagdlg-folder');
    await page.click('#tagdlg-save');
    await page.waitForFunction(function () { return document.getElementById('tagdlg').hidden; });

    var albums = await page.evaluate(function () {
      return window.DrivePlayer.tracks().filter(function (t) {
        return t.folder === 'Deep Cuts';
      }).map(function (t) { return t.album; });
    });

    assert.strictEqual(albums.length, 2, 'expected 2 tracks in the folder');
    albums.forEach(function (a) {
      assert.strictEqual(a, 'Deep Cuts Compilation', 'album not applied: ' + albums);
    });

    await page.click('.tab[data-facet="album"]');
    await page.waitForSelector('#browse:not([hidden])');

    var card = await page.$$eval('.card', function (cards) {
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].querySelector('.card-name').textContent === 'Deep Cuts Compilation') {
          return {
            count: cards[i].querySelector('.card-count').textContent,
            sub: cards[i].querySelector('.card-sub') ?
              cards[i].querySelector('.card-sub').textContent : ''
          };
        }
      }
      return null;
    });

    assert.ok(card, 'the folder album is not in the Albums grid');
    assert.strictEqual(card.count, '2 tracks');
    assert.strictEqual(card.sub, 'Various artists',
      'an album spanning artists should say so, got: ' + card.sub);

    // The artist box opens pre-filled; saving folder-wide without touching it
    // must not rename everyone in the folder to the track that was clicked.
    var artists = await page.evaluate(function () {
      return window.DrivePlayer.tracks().filter(function (t) {
        return t.folder === 'Deep Cuts';
      }).map(function (t) { return t.artist; }).sort();
    });
    assert.deepStrictEqual(artists, ['Boards of Canada', 'Nujabes'],
      'an untouched artist field overwrote the folder: ' + artists);
  });

  await step('a folder album survives a reload', async function () {
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(function () {
      return window.DrivePlayer && window.DrivePlayer.tracks().length === 10;
    });

    var albums = await page.evaluate(function () {
      return window.DrivePlayer.tracks().filter(function (t) {
        return t.folder === 'Deep Cuts';
      }).map(function (t) { return t.album; });
    });
    albums.forEach(function (a) {
      assert.strictEqual(a, 'Deep Cuts Compilation', 'folder rule lost on reload');
    });
  });

  await step('search filters the browse grid too', async function () {
    await page.click('.tab[data-facet="artist"]');
    await page.waitForSelector('#browse:not([hidden])');
    await page.fill('#search', 'tame');

    await page.waitForFunction(function () {
      return document.querySelectorAll('#browse .card').length === 1;
    });

    await page.fill('#search', '');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#browse .card').length > 1;
    });
  });

  await step('the chosen tab survives a reload', async function () {
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#browse:not([hidden])');
    assert.ok(await page.$eval('.tab[data-facet="artist"]',
      function (e) { return e.classList.contains('on'); }), 'tab not restored');

    await page.click('.tab[data-facet="genre"]');
    await page.waitForSelector('#genres:not([hidden])');
  });

  await step('a folder in the URL fragment pre-fills setup', async function () {
    var ctx4 = await browser.newContext();
    var page4 = await ctx4.newPage();

    await page4.goto(base + '#folder=https://drive.google.com/drive/folders/' + FOLDER);
    await page4.waitForSelector('#setup:not([hidden])');
    assert.strictEqual(await page4.inputValue('#setup-folder'), FOLDER);

    // A bare id works too, and nothing else in the fragment is honoured.
    await page4.goto(base + '#folder=' + FOLDER + '&key=SHOULD-BE-IGNORED');
    await page4.waitForSelector('#setup:not([hidden])');
    assert.strictEqual(await page4.inputValue('#setup-folder'), FOLDER);
    assert.strictEqual(await page4.inputValue('#setup-key'), '');

    await ctx4.close();
  });

  await step('with no folder in the URL, setup starts empty', async function () {
    var ctx5 = await browser.newContext();
    var page5 = await ctx5.newPage();

    await page5.goto(base);
    await page5.waitForSelector('#setup:not([hidden])');
    assert.strictEqual(await page5.inputValue('#setup-folder'), '',
      'a folder id is baked into the page');

    var source = await page5.content();
    assert.ok(source.indexOf(FOLDER) === -1, 'folder id appears in the page source');

    await ctx5.close();
  });

  /* ---- the Albums tab, and reading tags as the library is browsed ---- */

  await step('the Albums tab reads album names itself, even straight after a reload onto it',
    async function () {
      var lib = await openLibrary(browser, base, {
        folder: ODD, files: ODD_FILES, id3: ODD_ID3, settings: { facet: 'album' }
      });
      var p = lib.page;
      await p.waitForSelector('#browse:not([hidden])');

      // Album names live in tags, and a grid has no rows on screen to read
      // them for - so nothing was read, and every track sat in one "No
      // album" card for good.
      await p.waitForFunction(function () {
        var names = Array.prototype.map.call(document.querySelectorAll('#browse .card-name'),
          function (e) { return e.textContent; });
        return ['Split', 'Constructor', '__proto__'].every(function (n) {
          return names.indexOf(n) !== -1;
        });
      }, null, { timeout: 15000 });

      // Credited from the first track that names anyone, and not made
      // Various by a second spelling of the same artist.
      var split = await p.evaluate(function () {
        var cards = document.querySelectorAll('#browse .card');
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].querySelector('.card-name').textContent !== 'Split') continue;
          var sub = cards[i].querySelector('.card-sub');
          return {
            count: cards[i].querySelector('.card-count').textContent,
            sub: sub ? sub.textContent : ''
          };
        }
        return null;
      });
      assert.deepStrictEqual(split, { count: '3 tracks', sub: 'Grouper' });

      // One record spelled five ways by five rips - straight apostrophes,
      // curly ones in a tag written big-endian, modifier-letter ones, a
      // bonus-track edition with no comma, and a deluxe edition after a dash
      // - is one record, named the way it was first met. Each used to be an
      // album of its own.
      await p.waitForFunction(function () {
        return Array.prototype.some.call(document.querySelectorAll('#browse .card'), function (c) {
          return /whatever people say/i.test(c.querySelector('.card-name').textContent) &&
            c.querySelector('.card-count').textContent === '5 tracks';
        });
      }, null, { timeout: 15000 });

      var monkeys = await p.evaluate(function () {
        return Array.prototype.filter.call(document.querySelectorAll('#browse .card'), function (c) {
          return /whatever people say/i.test(c.querySelector('.card-name').textContent);
        }).map(function (c) {
          return c.querySelector('.card-name').textContent + ' / ' +
            c.querySelector('.card-count').textContent + ' / ' + c.title;
        });
      });
      // The card cuts a long name short; hovering it shows the whole thing.
      assert.deepStrictEqual(monkeys, [
        "Whatever People Say I Am, That's What I'm Not / 5 tracks / " +
        "Whatever People Say I Am, That's What I'm Not — Arctic Monkeys"
      ]);

      // With every tag read and every track in an album, nothing is left to
      // say about the reading.
      await p.waitForFunction(function () {
        return document.getElementById('browse-note').hidden;
      });

      assertBarAtBottom(await boxes(p), 'short album grid');

      // A grid has no list to play from, and after a reload onto one Play
      // found an empty queue and did nothing.
      await p.click('#btn-play');
      await p.waitForFunction(function () {
        var a = document.getElementById('audio');
        return !a.paused && a.currentTime > 0.1;
      }, null, { timeout: 10000 });

      assert.deepStrictEqual(lib.errors, []);
      await lib.ctx.close();
    });

  await step('with the tag budget spent, reading rests and then carries on by itself',
    async function () {
      // As if 300 tags had been read in the last fifteen minutes, freeing up
      // a few seconds after the page opens. The count used to live in the
      // page, so a reload reset it; now it is kept.
      var spent = [];
      for (var i = 0; i < 300; i++) spent.push(Date.now() - 15 * 60 * 1000 + 4000);

      var lib = await openLibrary(browser, base, {
        folder: ODD, files: ODD_FILES, id3: ODD_ID3, settings: { facet: 'album' },
        storage: { 'drivePlayer.tagReads.v1': JSON.stringify(spent) }
      });
      var p = lib.page;

      await p.waitForFunction(function () {
        var note = document.getElementById('browse-note');
        return !note.hidden && /Resting until/.test(note.textContent);
      }, null, { timeout: 5000 });
      assert.strictEqual(lib.reads.ids.length, 0, 'tags were read with the budget spent');

      // Spent used to mean stopped until the next page load.
      await p.waitForFunction(function () {
        return Array.prototype.some.call(document.querySelectorAll('#browse .card-name'),
          function (e) { return e.textContent === 'Split'; });
      }, null, { timeout: 20000 });

      assert.deepStrictEqual(lib.errors, []);
      await lib.ctx.close();
    });

  await step('Scan now goes ahead without waiting out the rest', async function () {
    // Spent five minutes ago, so ten more to wait - unless asked not to.
    var spent = [];
    for (var i = 0; i < 300; i++) spent.push(Date.now() - 5 * 60 * 1000);

    var lib = await openLibrary(browser, base, {
      folder: ODD, files: ODD_FILES, id3: ODD_ID3, settings: { facet: 'album' },
      storage: { 'drivePlayer.tagReads.v1': JSON.stringify(spent) }
    });
    var p = lib.page;

    await p.waitForSelector('#browse-scan:not([hidden])', { timeout: 5000 });
    assert.strictEqual(await p.textContent('#browse-scan'), 'Scan now');
    assert.strictEqual(lib.reads.ids.length, 0, 'tags were read with the budget spent');

    await p.click('#browse-scan');
    await p.waitForFunction(function () {
      return Array.prototype.some.call(document.querySelectorAll('#browse .card-name'),
        function (e) { return e.textContent === 'Split'; });
    }, null, { timeout: 15000 });

    assert.deepStrictEqual(lib.errors, []);
    await lib.ctx.close();
  });

  await step('Try again goes back to what Drive refused, stopped or not', async function () {
    var refusing = { all: true, ids: {} };
    var lib = await openLibrary(browser, base, {
      folder: ODD, files: ODD_FILES, id3: ODD_ID3, settings: { facet: 'album' },
      refuse: function (id) { return refusing.all || !!refusing.ids[id]; }
    });
    var p = lib.page;
    var note = function () { return p.textContent('#browse-note-text'); };

    // A run of refusals stops reading, and it used to take a reload to start
    // it again.
    await p.waitForFunction(function () {
      return /Stopped/.test(document.getElementById('browse-note-text').textContent);
    }, null, { timeout: 15000 });
    assert.strictEqual(await p.textContent('#browse-scan'), 'Try again');

    // Now Drive turns away only two files. They are skipped rather than
    // stopping everything, and the note says so instead of looking stalled.
    refusing = { all: false, ids: { o3: true, o4: true } };
    await p.click('#browse-scan');
    await p.waitForFunction(function () {
      return /Drive refused 2 files/.test(document.getElementById('browse-note-text').textContent);
    }, null, { timeout: 15000 });
    assert.strictEqual(await p.textContent('#browse-scan'), 'Try again', await note());

    // And once Drive relents, trying again reads them.
    refusing = { all: false, ids: {} };
    await p.click('#browse-scan');
    await p.waitForFunction(function () {
      var names = Array.prototype.map.call(document.querySelectorAll('#browse .card-name'),
        function (e) { return e.textContent; });
      return names.indexOf('Constructor') !== -1 && names.indexOf('__proto__') !== -1;
    }, null, { timeout: 15000 });

    assert.deepStrictEqual(lib.errors, []);
    await lib.ctx.close();
  });

  await step('scrolling the list reads the tags that come on screen, one at a time',
    async function () {
      var lib = await openLibrary(browser, base, {
        folder: BIG, files: BIG_FILES, id3: BIG_ID3, readDelay: 200
      });
      var p = lib.page;
      await p.waitForFunction(function () {
        return document.querySelectorAll('#tracklist .track').length === 120;
      });

      await p.waitForFunction(function () {
        return document.querySelector('#tracklist .track-artist').textContent === 'Band 000';
      }, null, { timeout: 10000 });

      // Only the top sixty rows were ever read, however far down the list
      // was scrolled.
      await p.evaluate(function () {
        var main = document.querySelector('.main');
        main.scrollTop = main.scrollHeight;
      });
      await p.waitForFunction(function () {
        var rows = document.querySelectorAll('#tracklist .track-artist');
        return rows[rows.length - 1].textContent === 'Band 119';
      }, null, { timeout: 15000 });

      // What was queued for the top and scrolled away from is dropped, not
      // read on the way.
      assert.ok(lib.reads.ids.indexOf('b80') === -1,
        'a row that was never on screen was read: ' + lib.reads.ids.join(' '));

      // However often the view changes, one read in flight at a time: a
      // change landing in the gap between two reads used to start a second
      // chain of them.
      var searches = ['artist 01', 'artist 04', 'artist 07', 'artist 02', 'artist 09', 'artist 05', ''];
      for (var i = 0; i < searches.length; i++) {
        await p.fill('#search', searches[i]);
        await p.waitForTimeout(300);
      }
      assert.strictEqual(lib.reads.maxInFlight, 1,
        lib.reads.maxInFlight + ' tag reads were in flight at once');

      assert.deepStrictEqual(lib.errors, []);
      await lib.ctx.close();
    });

  await step('a click on an album holds while tags land and the grid redraws under it',
    async function () {
      var lib = await openLibrary(browser, base, {
        folder: BIG, files: BIG_FILES, id3: BIG_ID3, settings: { facet: 'artist' }
      });
      var p = lib.page;

      // A long grid: the now playing bar used to be pushed off the screen.
      await p.waitForFunction(function () {
        return document.querySelectorAll('#browse .card').length === 120;
      });
      assertBarAtBottom(await boxes(p), 'long artist grid');

      await p.click('.tab[data-facet="album"]');
      await p.waitForFunction(function () {
        return document.querySelectorAll('#browse .card').length >= 2;
      }, null, { timeout: 10000 });

      // Every read that lands redraws the grid. Hold a press across one: the
      // card pressed is the one that opens.
      var target = await p.evaluate(function () {
        var card = document.querySelector('#browse .card');
        var r = card.getBoundingClientRect();
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          name: card.querySelector('.card-name').textContent
        };
      });
      await p.mouse.move(target.x, target.y);
      await p.mouse.down();
      await p.waitForTimeout(700);
      await p.mouse.up();

      await p.waitForSelector('#crumb:not([hidden])', { timeout: 3000 });
      assert.strictEqual(await p.textContent('#crumb-label'), target.name);

      assert.deepStrictEqual(lib.errors, []);
      await lib.ctx.close();
    });

  await step('a click on a row holds while tags land and the list redraws under it',
    async function () {
      var lib = await openLibrary(browser, base, { folder: BIG, files: BIG_FILES, id3: BIG_ID3 });
      var p = lib.page;

      // Reads are landing at the top of the list, each one rebuilding it -
      // and a press on a row that is swapped out before the release is no
      // click at all.
      await p.waitForFunction(function () {
        return document.querySelector('#tracklist .track-artist').textContent === 'Band 000';
      }, null, { timeout: 10000 });

      var row = await p.evaluate(function () {
        var r = document.querySelectorAll('#tracklist .track')[3]
          .querySelector('.track-main').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await p.mouse.move(row.x, row.y);
      await p.mouse.down();
      await p.waitForTimeout(700);
      await p.mouse.up();

      await p.waitForFunction(function () {
        var playing = window.DrivePlayer.player.nowPlaying();
        return playing && playing.id === 'b3';
      }, null, { timeout: 3000 });

      assert.deepStrictEqual(lib.errors, []);
      await lib.ctx.close();
    });

  await step('clearing the metadata cache reads the tags again, without a reload',
    async function () {
      var lib = await openLibrary(browser, base, { folder: FOLDER, files: FILES, id3: ID3_FILES });
      var p = lib.page;

      await p.waitForFunction(function () {
        return Array.prototype.some.call(document.querySelectorAll('.track-artist'),
          function (e) { return e.textContent === 'Perturbator'; });
      }, null, { timeout: 10000 });

      await p.click('#btn-settings');
      await p.waitForSelector('#setdlg:not([hidden])');
      await p.click('#set-clearcache');

      // Every file had already been tried this page load, so none was read
      // again: the tags stayed gone until the page itself was reloaded.
      await p.waitForFunction(function () {
        return !Array.prototype.some.call(document.querySelectorAll('.track-artist'),
          function (e) { return e.textContent === 'Perturbator'; });
      });
      await p.waitForFunction(function () {
        return Array.prototype.some.call(document.querySelectorAll('.track-artist'),
          function (e) { return e.textContent === 'Perturbator'; });
      }, null, { timeout: 15000 });

      await p.click('#set-cancel');
      assert.deepStrictEqual(lib.errors, []);
      await lib.ctx.close();
    });

  await browser.close();
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
