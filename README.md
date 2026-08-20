# Drive Player

A web music player that reads a shared Google Drive folder and plays it, with
shuffle, skip, search and genre filtering. It is a static page — no build step,
no server, no account — and it talks to Drive directly from the browser.

```
music/
  index.html          the player
  css/player.css
  js/genres.js        taxonomy, artist table, tag inference
  js/musicbrainz.js   rate-limited genre lookup
  js/id3.js           ID3v2 reader (v2.2 / v2.3 / v2.4)
  js/artwork.js       cover thumbnails, cached in IndexedDB
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

## The queue

The **+** on any row queues a track. Queued tracks play before the rest of the
list, and — importantly — without moving your place in it: once the queue
drains, the album or filter you were listening to carries on from exactly
where it was.

The queue button in the transport (or **Q**) opens *Up next*, which shows what
you queued by hand followed by what the list plays after that, and lets you
drop individual tracks or clear the lot. A queue you built survives a reload.

## Browsing

Three tabs above the list:

- **Genres** — the chip bar, filtering the whole library by tag.
- **Artists** — every artist with a track count, most-played-by-you first.
- **Albums** — the same for albums, read from ID3. Tracks with no album
  information are grouped under *No album* rather than hidden, and an album
  credited to several artists shows as *Various artists*.

Picking an artist or album filters the list to it; **Back** returns to the
grid. Search narrows whichever view is showing, including the grids. The tab
you were last on is remembered.

## Genres

Every track carries a *list* of tags rather than a single genre, which is what
makes the obvious query work — picking **Synth** returns Tame Impala *and*
Sidewalks and Skeletons, even though one is psych rock and the other is witch
house.

Tags are worked out in this order, first hit wins:

1. **Your own edit** on that track, if you have made one.
2. **Your own rule for that artist**, if you have made one.
3. **The artist table** in `js/genres.js` — around 145 artists mapped to their
   genres. This is the one that does most of the work.
4. **MusicBrainz**, for any artist looked up (see below).
5. **The ID3 genre frame** in the file, matched against keywords.
6. **The album, title and filename**, matched the same way — this catches
   things like `lofi study beat 3.mp3` or a `darksynth` mix.
7. **Unsorted**, so nothing goes missing.

The artist comes from the file's ID3 tag when it has one. When it does not,
it is read off the filename, with leading track numbers, underscores and
`(Official Video)` noise stripped.

Junk that rippers and sync clients leave behind is stripped first: site
stamps (`[SPOTDOWN.ORG]`, `(y2mate.com)`, bare `www.` addresses), bitrate and
format markers (`320kbps`, `[FLAC]`), cloud collision markers (`(sync
conflict)`, `(Marc's conflicted copy 2024-03-02)`, `- Copy`) and trailing
duplicate numbers (`Song (1)`). The bar for removal is that it says nothing
about the music, so `(Live)`, `(Acoustic)` and `(Blood Orange Remix)` all
survive.

When a filename is a bare title with no artist in it at all, two last
resorts apply: a known multi-word artist sitting at the front of the name
(`Tame Impala Elephant.mp3`), and the folder the file lives in, since a
library organised as `Tame Impala/Elephant.mp3` says exactly who it is.
Generic folder names — `Music`, `Downloads`, `New folder` — are ignored.

Filenames come in both orders — `Weezer - Say It Ain't So` and `Say It Ain't
So - Weezer` — and a single filename cannot tell you which half is the band.
A library can: **artists recur, song titles do not.** So the whole listing is
parsed first, each side's text is counted across every file, and a pair is
flipped when its second half looks more like an artist than its first (either
the built-in table knows it, or it shows up in several filenames). Mixed
conventions in one folder come out right, and a lone unknown name is left
alone rather than flipped on a guess.

### Fixing artist, album and grouping

The editor also carries **Artist** and **Album** boxes, and a checkbox to
apply what you change to **everything in that Drive folder**. That is how a
soundtrack of loose files, or an album whose tracks each claim to be their own
record, gets pulled back together — name it once on any track in the folder.

Only fields you actually edit are pushed folder-wide. The artist box opens
pre-filled, and applying it untouched would rename every other artist in the
folder to whichever track you happened to click.

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

### Letting MusicBrainz do it

**Settings → Look up genres online** asks [MusicBrainz](https://musicbrainz.org)
about every artist still sitting in Unsorted, and applies what comes back.
This is the fastest way to tag a library full of artists nobody has hand-
listed.

What it sends is artist names, nothing else — no filenames, no folder id, no
key. MusicBrainz asks anonymous clients for at most one request a second, and
a browser cannot send a User-Agent identifying itself, so the player stays
well inside that limit: roughly two seconds per artist, running in the
background while you listen. Every answer is stored permanently, misses
included, so nothing is ever asked twice.

A wrong match is worse than no match — it puts a confident, incorrect genre
across a whole artist — so a result is only accepted when the name really
matches (including aliases) or MusicBrainz scores it above 90. That last part
is what lets a misspelled `Micheal Jackson` still find the right person.

Its answers rank below the built-in table and anything you set by hand, and
above anything guessed from a filename.

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
| `Q` | up next |
| `/` | search |
| `Esc` | close a dialog, or leave the search box |

Lock-screen and headset buttons work too, via the Media Session API.

## How it holds up

- **Metadata** is read by fetching only the first 256 KB of each file and
  parsing the ID3 tag out of it, then cached in `localStorage` keyed by Drive's
  `modifiedTime`. A file is only recorded as having no tag when Drive actually
  served its bytes — a refused request is left untagged so the next load tries
  again, rather than writing down a verdict that was never reached.

  Reading is deliberately slow and deliberately partial: one request at a
  time, spaced, only for tracks on screen or playing, and no more than 300 per
  page load. A tag read costs a request per file, so doing a whole library at
  once is a burst of hundreds of requests to googleapis — enough for Google to
  decide the network is sending automated queries and block it outright, which
  takes playback down too. Tags are a nicety; playback is not.
- **Artwork** costs no requests of its own. The tag pass already downloads the
  first 256 KB of a file, and an embedded cover is usually sitting in it, so
  the picture is taken from bytes already in hand, shrunk to 128px, and kept
  in IndexedDB — a few KB each rather than a few hundred. Covers appear in the
  list, on the browse cards and in the now playing corner as the tag pass
  reaches each file. A cover per track fetched on demand would be a request
  per track, which is the pattern that gets a network blocked.
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
node tests/units.js                      # 57 tests, no dependencies
npm i playwright && node tests/e2e.js    # 48 tests in a real browser
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
