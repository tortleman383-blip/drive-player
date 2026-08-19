# Drive Player

A web music player that reads a shared Google Drive folder and plays it, with
shuffle, skip, search and genre filtering. It is a static page — no build step,
no server, no account — and it talks to Drive directly from the browser.

```
music/
  index.html          the player
  css/player.css
  js/genres.js        taxonomy, artist table, tag inference
  js/id3.js           ID3v2 reader (v2.2 / v2.3 / v2.4)
  js/drive.js         Drive API client, filename parsing
  js/store.js         localStorage: settings, metadata cache, genre edits
  js/player.js        queue, shuffle order, repeat, transport
  js/app.js           wiring and rendering
  tests/units.js      parsing and tagging tests (node)
  tests/e2e.js        full browser test against a stubbed Drive API
```

## Running it

Open `music/index.html` — double-clicking the file works, and so does any
static host. `.github/workflows/pages.yml` publishes this folder to GitHub
Pages on every push to `main`, with the tests gating the deploy.

On first run it asks for two things:

**1. The folder.** Any Drive folder shared as *Anyone with the link*.
Subfolders are included.

The id is not baked into the page. On a public host that would hand every
passer-by the one thing standing between them and a link-shared folder, so
instead the page reads it from its own URL fragment:

```
https://<your-pages-url>/#folder=15Itt...       a bare id
https://<your-pages-url>/#folder=https://drive.google.com/drive/folders/15Itt...
```

Bookmark that and the folder is filled in for you. Fragments are never sent to
a server, so the id stays between your browser and Drive. Keys are never read
from the URL — only ever typed in, and only ever stored locally.

**2. A Google API key.** Drive will not list a folder's contents to an
anonymous caller, so the page needs a key of your own. It takes about two
minutes:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/projectcreate).
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Optionally **Restrict key → API restrictions → Google Drive API**, so the
   key can do nothing else.
5. Paste it into the player.

The key is kept in this browser's `localStorage` and is sent only to
`googleapis.com`. It is not in this repository and never leaves your machine
otherwise. Do not add an HTTP-referrer restriction if you open the page as a
`file://` URL — there is no referrer to match, and Drive will answer 403.

Nothing is uploaded, and no audio is copied: tracks stream from Drive as they
play.

## Genres

Every track carries a *list* of tags rather than a single genre, which is what
makes the obvious query work — picking **Synth** returns Tame Impala *and*
Sidewalks and Skeletons, even though one is psych rock and the other is witch
house.

Tags are worked out in this order, first hit wins:

1. **Your own edit** on that track, if you have made one.
2. **Your own rule for that artist**, if you have made one.
3. **The artist table** in `js/genres.js` — around 130 artists mapped to their
   genres. This is the one that does most of the work.
4. **The ID3 genre frame** in the file, matched against keywords.
5. **The album, title and filename**, matched the same way — this catches
   things like `lofi study beat 3.mp3` or a `darksynth` mix.
6. **Unsorted**, so nothing goes missing.

The artist comes from the file's ID3 tag when it has one. When it does not,
it is read off the filename: `Artist - Title.mp3`, with leading track numbers,
underscores and `(Official Video)` noise stripped.

### Fixing a tag

Click any genre chip on a track to open the editor, toggle tags, and add your
own in the text box (`Shoegaze`, `Late night`, whatever you like) — custom
tags appear in the filter bar alongside the built-in ones.

The editor's **Apply to everything by …** box is the one that matters for a
library of any size: it saves a rule for that artist rather than that track,
so every song by them — including ones you have not played, and ones added to
Drive later — picks it up. A track edit still wins over an artist rule, so one
odd song on an album can differ without breaking the rule.

Edits survive reloads, renames in Drive, and re-uploads of the same song.

### Tagging in bulk

Filter to **Unsorted** to see what the player could not place, then:

**Settings → Export untagged artists** writes a file listing every artist that
needs a decision, each with an empty tag list, plus the genre vocabulary to
choose from:

```json
{
  "version": 2,
  "artists": {
    "Men I Trust": [],
    "Yumi Zouma": []
  }
}
```

Fill in the lists — `["Indie", "Synth"]` — and **Settings → Import genres**
puts them to work. Artist rules merge on import, so a file covering part of
the library never wipes what is already there, and names are matched loosely
(case, punctuation and a leading `the` do not matter).

**Settings → Export genres** writes everything — artist rules and track edits
— which is how you move your work to another browser or phone.

To teach the player about an artist permanently rather than tagging track by
track, add a line to `ARTISTS` in `js/genres.js`:

```js
'men i trust': ['Indie', 'Synth', 'Funk'],
```

Keys are lowercase with punctuation removed and a leading `the` moved to the
front, so `The Black Angels` and `Black Angels, The` both match
`the black angels`.

## Keyboard

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | seek 5 seconds |
| `Shift`+`←` `→` | previous / next track |
| `↑` `↓` | volume |
| `S` | shuffle |
| `L` | repeat: all → one → off |
| `M` | mute |
| `/` | search |
| `Esc` | close a dialog, or leave the search box |

Lock-screen and headset buttons work too, via the Media Session API.

## How it holds up

- **Metadata** is read by fetching only the first 256 KB of each file and
  parsing the ID3 tag out of it, then cached in `localStorage` keyed by Drive's
  `modifiedTime`. The first load of a large folder does this in the background,
  four files at a time; later loads are instant.
- **Artwork** is fetched for the playing track only, with a 20-item cache, so
  a big library does not accumulate decoded images.
- **A file that will not play** is marked in the list and skipped rather than
  ending the session. If nothing at all plays — a revoked key, a folder that
  stopped being shared — it stops after five failures and says so instead of
  racing through the library.
- **Filtering never interrupts playback.** Changing genre or searching rebuilds
  the queue around whatever is currently playing.
- **Shuffle** is a real permutation, rebuilt on each pass, so every track plays
  once before any repeats, and `previous` walks back the way you actually heard
  it.

## When nothing plays

Listing the folder and downloading from it are two different permissions, so
seeing your tracks appear proves less than it looks. If every track skips, the
player probes Drive directly and puts the real reason in the bar above the
list rather than leaving you with "could not play". The three answers it gives:

- **"Drive refused the download (403)"** — the key can list but not fetch.
  Almost always an *Application restriction* on the key: `Credentials → your
  key → Application restrictions → None`. An HTTP-referrer restriction cannot
  match a page opened from `file://`, because there is no referrer to send.
- **"This browser cannot decode them"** — Drive served the bytes and the file
  is simply in a format the browser will not play. WMA, ALAC, and AIFF do
  this; MP3, M4A/AAC, FLAC, OGG, Opus and WAV are all fine.
- **"The request never reached Drive"** — a network filter, an extension, or
  no connection.

Shortcuts are handled: a file added from *Shared with me* leaves a shortcut
that carries the real filename but cannot be downloaded, so the player follows
it to the file it points at.

## Tests

```
node tests/units.js                      # 30 tests, no dependencies
npm i playwright && node tests/e2e.js    # 30 tests in a real browser
```

`units.js` covers ID3 parsing (including numeric genres, embedded artwork,
padding and tags truncated by the 256 KB window), filename parsing, folder-id
extraction and genre inference.

`e2e.js` runs the actual page in Chromium against a stubbed Drive API and
checks the whole path: setup validation, listing with subfolders, ID3
overriding the filename guess, the genre bar, filtering, search, playback,
seeking, next/previous, shuffle, tag editing, persistence across a reload, and
recovery from an unplayable file. It uses the browser already installed at
`/opt/pw-browsers/chromium` when there is one, otherwise Playwright's own.
