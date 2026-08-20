/* Genre taxonomy and inference.
 *
 * A track carries a LIST of tags, not one genre, so a filter for "Synth"
 * can return both Tame Impala and Sidewalks and Skeletons even though one
 * is psych rock and the other is witch house. The first tag in the list is
 * the one shown as the track's primary genre.
 *
 * Order of precedence when tagging a track (see inferTags):
 *   1. a manual override the listener saved
 *   2. the artist table below
 *   3. keywords in the ID3 genre frame
 *   4. keywords in the title / filename
 *   5. "Unsorted"
 */
(function (global) {
  'use strict';

  // Display order of the filter bar. Keep "All" and "Unsorted" at the ends.
  var TAXONOMY = [
    'Synth', 'Psych', 'Rock', 'Indie', 'Punk', 'Metal', 'Electronic',
    'Ambient', 'Witch House', 'Hip-Hop', 'R&B', 'Pop', 'Jazz', 'Funk',
    'Folk', 'Country', 'Classical', 'Soundtrack', 'Lo-Fi', 'Unsorted'
  ];

  // artist (lowercased, punctuation-stripped) -> tags, most specific first.
  var ARTISTS = {
    'tame impala':              ['Psych', 'Synth', 'Indie'],
    'sidewalks and skeletons':  ['Witch House', 'Synth', 'Electronic'],
    'pond':                     ['Psych', 'Synth', 'Indie'],
    'king gizzard and the lizard wizard': ['Psych', 'Rock'],
    'unknown mortal orchestra': ['Psych', 'Indie'],
    'ty segall':                ['Psych', 'Rock', 'Punk'],
    'thee oh sees':             ['Psych', 'Punk', 'Rock'],
    'the black angels':         ['Psych', 'Rock'],
    'melody s echo chamber':    ['Psych', 'Synth', 'Indie'],

    'com truise':               ['Synth', 'Electronic'],
    'carpenter brut':           ['Synth', 'Electronic', 'Metal'],
    'perturbator':              ['Synth', 'Electronic'],
    'gunship':                  ['Synth', 'Electronic'],
    'the midnight':             ['Synth', 'Pop'],
    'fm 84':                    ['Synth', 'Pop'],
    'timecop1983':              ['Synth', 'Pop'],
    'kavinsky':                 ['Synth', 'Electronic'],
    'college':                  ['Synth', 'Electronic'],
    'electric youth':           ['Synth', 'Pop'],
    'mitch murder':             ['Synth', 'Electronic'],
    'daniel deluxe':            ['Synth', 'Electronic'],
    'dance with the dead':      ['Synth', 'Metal', 'Electronic'],
    'lazerhawk':                ['Synth', 'Electronic'],
    'power glove':              ['Synth', 'Electronic'],
    'wice':                     ['Synth', 'Witch House'],
    'crystal castles':          ['Synth', 'Electronic', 'Punk'],
    'chromatics':               ['Synth', 'Pop', 'Indie'],
    'desire':                   ['Synth', 'Pop'],
    'johnny jewel':             ['Synth', 'Ambient'],
    'm83':                      ['Synth', 'Electronic', 'Indie'],
    'kraftwerk':                ['Synth', 'Electronic'],
    'depeche mode':             ['Synth', 'Pop', 'Rock'],
    'new order':                ['Synth', 'Indie', 'Pop'],
    'joy division':             ['Rock', 'Punk', 'Indie'],
    'tangerine dream':          ['Synth', 'Ambient', 'Electronic'],
    'vangelis':                 ['Synth', 'Ambient', 'Soundtrack'],
    'jean michel jarre':        ['Synth', 'Electronic'],
    'john carpenter':           ['Synth', 'Soundtrack', 'Electronic'],
    'disasterpeace':            ['Synth', 'Soundtrack', 'Ambient'],
    'trent reznor and atticus ross': ['Soundtrack', 'Electronic', 'Ambient'],
    'hans zimmer':              ['Soundtrack', 'Classical'],
    'ludovico einaudi':         ['Classical', 'Ambient'],

    'crystal skulls':           ['Indie', 'Rock'],
    'salvia palth':             ['Lo-Fi', 'Indie'],
    'nirvana':                  ['Rock', 'Punk'],
    'radiohead':                ['Rock', 'Indie', 'Electronic'],
    'thom yorke':               ['Electronic', 'Indie'],
    'pink floyd':               ['Psych', 'Rock'],
    'led zeppelin':             ['Rock'],
    'the beatles':              ['Rock', 'Pop', 'Psych'],
    'the rolling stones':       ['Rock'],
    'queens of the stone age':  ['Rock'],
    'arctic monkeys':           ['Indie', 'Rock'],
    'the strokes':              ['Indie', 'Rock'],
    'mac demarco':              ['Indie', 'Lo-Fi', 'Psych'],
    'beach house':              ['Indie', 'Ambient', 'Synth'],
    'slowdive':                 ['Indie', 'Ambient', 'Rock'],
    'my bloody valentine':      ['Indie', 'Rock'],
    'the smiths':               ['Indie', 'Rock'],
    'interpol':                 ['Indie', 'Rock'],
    'tv girl':                  ['Indie', 'Lo-Fi', 'Pop'],
    'current joys':             ['Indie', 'Lo-Fi'],
    'wild nothing':             ['Indie', 'Synth'],
    'toro y moi':               ['Indie', 'Synth', 'Electronic'],
    'washed out':               ['Synth', 'Electronic', 'Indie'],
    'neon indian':              ['Synth', 'Indie', 'Electronic'],
    'boards of canada':         ['Electronic', 'Ambient', 'Lo-Fi'],
    'aphex twin':               ['Electronic', 'Ambient'],
    'burial':                   ['Electronic', 'Ambient'],
    'four tet':                 ['Electronic'],
    'flying lotus':             ['Electronic', 'Hip-Hop', 'Jazz'],
    'bonobo':                   ['Electronic', 'Ambient'],
    'tycho':                    ['Electronic', 'Ambient', 'Synth'],
    'brian eno':                ['Ambient', 'Electronic'],
    'daft punk':                ['Electronic', 'Synth', 'Funk'],
    'justice':                  ['Electronic', 'Funk'],
    'the chemical brothers':    ['Electronic'],
    'the prodigy':              ['Electronic', 'Punk'],
    'gorillaz':                 ['Indie', 'Hip-Hop', 'Electronic'],
    'massive attack':           ['Electronic', 'Ambient'],
    'portishead':               ['Electronic', 'Ambient'],

    'michael jackson':          ['Pop', 'R&B', 'Funk'],
    'good kid':                 ['Indie', 'Rock'],
    'kendrick lamar':           ['Hip-Hop'],
    'tyler the creator':        ['Hip-Hop', 'R&B'],
    'mf doom':                  ['Hip-Hop'],
    'madvillain':               ['Hip-Hop'],
    'j dilla':                  ['Hip-Hop', 'Lo-Fi'],
    'a tribe called quest':     ['Hip-Hop', 'Jazz'],
    'outkast':                  ['Hip-Hop', 'Funk'],
    'danny brown':              ['Hip-Hop'],
    'death grips':              ['Hip-Hop', 'Punk', 'Electronic'],
    'clipping':                 ['Hip-Hop', 'Electronic'],
    'jpegmafia':                ['Hip-Hop', 'Electronic'],
    'earl sweatshirt':          ['Hip-Hop'],
    'frank ocean':              ['R&B', 'Pop'],
    'sza':                      ['R&B', 'Pop'],
    'the weeknd':               ['R&B', 'Pop', 'Synth'],
    'daniel caesar':            ['R&B'],
    'steve lacy':               ['R&B', 'Indie', 'Funk'],

    'miles davis':              ['Jazz'],
    'john coltrane':            ['Jazz'],
    'bill evans':               ['Jazz'],
    'thelonious monk':          ['Jazz'],
    'nujabes':                  ['Lo-Fi', 'Hip-Hop', 'Jazz'],
    'yoko kanno':               ['Jazz', 'Soundtrack', 'Funk'],
    'the seatbelts':            ['Jazz', 'Soundtrack', 'Funk'],
    'cowboy bebop':             ['Jazz', 'Soundtrack', 'Funk'],
    'james brown':              ['Funk', 'R&B'],
    'parliament':               ['Funk'],
    'vulfpeck':                 ['Funk', 'Jazz'],
    'khruangbin':               ['Funk', 'Psych'],

    'bon iver':                 ['Folk', 'Indie'],
    'sufjan stevens':           ['Folk', 'Indie'],
    'fleet foxes':              ['Folk', 'Indie'],
    'nick drake':               ['Folk'],
    'johnny cash':              ['Country', 'Folk'],
    'tyler childers':           ['Country', 'Folk'],

    'black sabbath':            ['Metal', 'Rock'],
    'metallica':                ['Metal'],
    'gojira':                   ['Metal'],
    'deftones':                 ['Metal', 'Rock'],
    'tool':                     ['Metal', 'Psych', 'Rock'],
    'sleep token':              ['Metal', 'Rock'],
    'ghost':                    ['Metal', 'Rock'],
    'nine inch nails':          ['Rock', 'Electronic', 'Metal'],

    'weezer':                   ['Rock', 'Indie', 'Punk'],
    'coldplay':                 ['Rock', 'Pop', 'Indie'],
    'fleetwood mac':            ['Rock', 'Pop', 'Folk'],
    'mgmt':                     ['Psych', 'Synth', 'Indie'],
    'empire of the sun':        ['Synth', 'Pop', 'Electronic'],
    'grimes':                   ['Synth', 'Pop', 'Electronic'],
    'air':                      ['Electronic', 'Ambient', 'Synth'],
    'animal collective':        ['Psych', 'Indie', 'Electronic'],
    'panchiko':                 ['Indie', 'Lo-Fi', 'Psych'],
    'c418':                     ['Ambient', 'Electronic', 'Soundtrack'],
    'biting elbows':            ['Rock', 'Punk', 'Electronic'],
    'men i trust':              ['Indie', 'Synth', 'Funk'],
    'yumi zouma':               ['Indie', 'Synth', 'Pop'],
    'the ramones':              ['Punk', 'Rock'],
    'dead kennedys':            ['Punk'],
    'idles':                    ['Punk', 'Rock'],
    'fontaines dc':             ['Punk', 'Indie', 'Rock']
  };

  // Substring hints matched against the ID3 genre frame, title and filename.
  // Checked in order, so put the specific ones first.
  var KEYWORDS = [
    [/witch\s*house|drag(?!on)/i,                    ['Witch House', 'Electronic']],
    [/synth\s*wave|synthwave|retrowave|outrun|vaporwave|darksynth|chillwave/i, ['Synth', 'Electronic']],
    [/psych|psychedelic|shoegaze|krautrock/i,        ['Psych', 'Rock']],
    [/lo\s*-?\s*fi|lofi|chillhop/i,                  ['Lo-Fi']],
    [/ambient|drone|new\s*age/i,                     ['Ambient']],
    [/soundtrack|score|\bost\b|theme from/i,         ['Soundtrack']],
    [/hip\s*-?\s*hop|rap|trap|boom\s*bap/i,          ['Hip-Hop']],
    [/r\s*&\s*b|rnb|soul|neo\s*-?\s*soul/i,          ['R&B']],
    [/metal|doom|djent|hardcore|metalcore/i,         ['Metal']],
    [/punk|garage/i,                                 ['Punk', 'Rock']],
    [/house|techno|trance|dubstep|drum\s*(and|n|&)\s*bass|dnb|edm|electro|idm|breakbeat/i, ['Electronic']],
    [/jazz|bebop|swing/i,                            ['Jazz']],
    [/funk|disco|groove/i,                           ['Funk']],
    [/folk|acoustic|bluegrass|singer\s*-?\s*songwriter/i, ['Folk']],
    [/country|americana|honky/i,                     ['Country']],
    [/classical|orchestra|symphony|concerto|sonata|piano|baroque/i, ['Classical']],
    [/indie|alt(ernative)?\b|dream\s*pop|bedroom/i,  ['Indie']],
    [/\bpop\b/i,                                     ['Pop']],
    [/\brock\b|grunge|blues/i,                       ['Rock']],
    [/synth|analog|neon|retro|80s|1980s/i,           ['Synth']]
  ];

  // "The Black Angels" and "Black Angels, The" and "the  black angels!" all
  // need to hit the same key.
  function normaliseArtist(name) {
    if (!name) return '';
    var n = String(name).toLowerCase().trim();
    n = n.replace(/^(.*),\s*the$/, 'the $1');
    n = n.replace(/&/g, ' and ');
    n = n.replace(/[^a-z0-9]+/g, ' ').trim();
    return n;
  }

  // Collaborations: "Kavinsky feat. Lovefoxxx" should still read as Kavinsky,
  // but we look up every credited artist and merge what we find.
  function splitArtists(name) {
    if (!name) return [];
    return String(name)
      .split(/\s*(?:feat\.?|ft\.?|featuring|with|vs\.?|,|&|\/|\bx\b)\s*/i)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function fromArtist(artist) {
    var found = [];
    var candidates = [artist].concat(splitArtists(artist));
    for (var i = 0; i < candidates.length; i++) {
      var tags = ARTISTS[normaliseArtist(candidates[i])];
      if (tags) {
        for (var j = 0; j < tags.length; j++) {
          if (found.indexOf(tags[j]) === -1) found.push(tags[j]);
        }
      }
    }
    return found;
  }

  function fromKeywords(text) {
    if (!text) return [];
    var found = [];
    for (var i = 0; i < KEYWORDS.length; i++) {
      if (KEYWORDS[i][0].test(text)) {
        var tags = KEYWORDS[i][1];
        for (var j = 0; j < tags.length; j++) {
          if (found.indexOf(tags[j]) === -1) found.push(tags[j]);
        }
      }
    }
    return found;
  }

  /* track:      { artist, title, album, id3Genre, fileName }
   * override:   tags the listener set on this one track, or undefined
   * artistRule: tags the listener set for this artist, or undefined
   *
   * The track override wins over the artist rule so that one odd song on an
   * album can be re-tagged without breaking the rule for everything else. */
  function inferTags(track, override, artistRule, onlineTags) {
    if (override && override.length) return override.slice();
    if (artistRule && artistRule.length) return artistRule.slice();

    var tags = fromArtist(track.artist);
    if (tags.length) return tags;

    // What MusicBrainz says about the artist beats anything guessed from the
    // file, since it is about the act rather than one filename.
    if (onlineTags && onlineTags.length) return onlineTags.slice();

    // The ID3 genre frame is the next most trustworthy signal, then whatever
    // the title and filename give away.
    tags = fromKeywords(track.id3Genre);
    if (tags.length) return tags;

    tags = fromKeywords([track.album, track.title, track.fileName].filter(Boolean).join(' '));
    if (tags.length) return tags;

    return ['Unsorted'];
  }

  // Sort a set of tags into the taxonomy's display order.
  function orderTags(tags) {
    return TAXONOMY.filter(function (t) { return tags.indexOf(t) !== -1; })
      .concat(tags.filter(function (t) { return TAXONOMY.indexOf(t) === -1; }));
  }

  // Does the built-in table recognise this as an artist? Used to work out
  // which half of a "A - B" filename is the band.
  function isKnownArtist(name) {
    return fromArtist(name).length > 0;
  }

  /* Finds a known artist inside free text - for files named "Tame Impala
   * Elephant.mp3", with no separator to split on.
   *
   * Only multi-word names are considered, and only at the start. A one-word
   * name like "Air" would match half the song titles in existence, and a
   * match in the middle is far more likely to be a coincidence than a
   * credit. Returns the artist's canonical spelling, or ''. */
  function findArtistIn(text) {
    var words = normaliseArtist(text).split(' ').filter(Boolean);
    if (words.length < 2) return '';

    // Longest first, so "boards of canada" wins over any shorter prefix.
    for (var take = Math.min(words.length - 1, 5); take >= 2; take--) {
      var candidate = words.slice(0, take).join(' ');
      if (ARTISTS[candidate]) return candidate;
    }
    return '';
  }

  global.Genres = {
    TAXONOMY: TAXONOMY,
    isKnownArtist: isKnownArtist,
    tagsFromText: fromKeywords,
    findArtistIn: findArtistIn,
    ARTISTS: ARTISTS,
    inferTags: inferTags,
    orderTags: orderTags,
    normaliseArtist: normaliseArtist
  };
})(window);
