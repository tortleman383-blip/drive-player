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

var FILES = {};
FILES[FOLDER] = [
  { id: 'f1', name: 'Tame Impala - Let It Happen.mp3', mimeType: 'audio/mpeg' },
  { id: 'f2', name: 'Sidewalks and Skeletons - Void.mp3', mimeType: 'audio/mpeg' },
  { id: 'f3', name: '03 - Com Truise - Propagation (Official Audio).mp3', mimeType: 'audio/mpeg' },
  { id: 'f4', name: 'untitled demo 2.mp3', mimeType: 'audio/mpeg' },
  { id: 'f5', name: 'track05.mp3', mimeType: 'audio/mpeg' },      // ID3 only
  { id: 'f7', name: 'Grouper - Clearing.mp3', mimeType: 'audio/mpeg' },  // untaggable

  { id: 'img', name: 'cover.jpg', mimeType: 'image/jpeg' },
  { id: SUBFOLDER, name: 'Deep Cuts', mimeType: 'application/vnd.google-apps.folder' }
];
FILES[SUBFOLDER] = [
  { id: 'f6', name: 'Boards of Canada - Roygbiv.mp3', mimeType: 'audio/mpeg' }
];

// Only f5 carries a tag; everything else has to be read off its filename.
var ID3_FILES = { f5: { artist: 'Perturbator', title: 'Sentient', album: 'Dangerous Days' } };

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

function id3Buffer(meta) {
  var frames = Buffer.concat([
    textFrame('TIT2', meta.title),
    textFrame('TPE1', meta.artist),
    textFrame('TALB', meta.album)
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
    assert.strictEqual(titles.length, 7, 'expected 7 tracks, got ' + titles.length + ': ' + titles);
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
      return document.querySelectorAll('#tracklist .track').length === 7;
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
      return document.querySelectorAll('#tracklist .track').length === 7;
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
      assert.strictEqual(order.length, 7, 'order length ' + order.length);
      assert.strictEqual(Object.keys(unique).length, 7, 'shuffle dropped or repeated entries');
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
      return document.querySelectorAll('#tracklist .track').length === 7;
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

  /* ---- tagging a whole artist at once ---- */

  await step('tagging by artist covers every track by them', async function () {
    await page.click('#genres .chip >> text=/^All/');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#tracklist .track').length === 7;
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
      return document.querySelectorAll('#tracklist .track').length === 7;
    });

    var tags = await page.evaluate(function () {
      var t = window.DrivePlayer.tracks().filter(function (x) {
        return x.artist === 'Com Truise';
      })[0];
      return t.tags.slice();
    });
    assert.ok(tags.indexOf('Jazz') !== -1, 'artist rule lost on reload: ' + tags);
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

  await browser.close();
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
