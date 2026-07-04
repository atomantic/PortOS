// PortOS lead-sheet notation — a tiny, dependency-free text format for melody +
// chords + lyrics, and the pure parser that turns it into a structured score the
// <ScoreSheet> SVG renderer draws. We render our own staff rather than pulling
// in abcjs / VexFlow / OpenSheetMusicDisplay, so this module is the single
// source of truth for "what the text means"; the renderer only does geometry.
//
// FORMAT (one worked example — "500 Miles", verse, ships as the seed score):
//
//   clef: treble        ← header lines: `key: value`, any order, before the music
//   key: C
//   time: 4/4
//   tempo: 68
//
//   | [C] E4q(If) G4q(you) G4q(miss) G4q(the) | [Am] A4h(train) G4q(I'm) E4q(on) |
//
// Music body: measures separated by `|` (a leading/trailing `|` is fine), notes
// separated by whitespace within a measure. A note token is:
//
//   [chord]  PITCH  DURATION  dots?  (lyric)
//   └ above  └ C4   └ q       └ .    └ under the note
//
//   PITCH    = letter A–G, optional accidental (# b n, or ## bb), octave digit
//              (scientific pitch: C4 = middle C). e.g. C4, F#4, Bb3, En5
//   DURATION = w h q e s t  → whole, half, quarter, eighth, sixteenth, 32nd
//   dots     = trailing `.` each adds half the value again (q. = 1.5 beats)
//   rest     = `r` + duration, e.g. rq, rh, re.   (no pitch, no lyric)
//   [chord]  = a chord symbol drawn above that note (C, Am, G7, F/A …)
//   (lyric)  = a syllable drawn under that note; use a trailing `-` to show a
//              held syllable (whis- / tle)
//
// The parser is forgiving: an unparseable token is collected into `errors` with
// its measure number and skipped, so the rest of the score still renders. Keep
// this module pure (no React, no imports) — it's unit-tested and barrelled.

// Diatonic letter → its index within an octave starting at C. Used to turn a
// pitch into a single "diatonic step" integer (C4 = 0, D4 = 1 … B4 = 6, C5 = 7),
// which is all the geometry needs: every staff line/space is one step apart.
const LETTER_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

// Duration code → its musical properties. `beats` is the undotted value in
// quarter-note beats; `filled` picks an open vs solid notehead; `flags` is how
// many flags hang off the stem (eighth = 1, sixteenth = 2 …); whole notes are
// stemless. Dots are applied on top of `beats` (see durationBeats).
export const DURATIONS = {
  w: { code: 'w', beats: 4, filled: false, stem: false, flags: 0, label: 'whole' },
  h: { code: 'h', beats: 2, filled: false, stem: true, flags: 0, label: 'half' },
  q: { code: 'q', beats: 1, filled: true, stem: true, flags: 0, label: 'quarter' },
  e: { code: 'e', beats: 0.5, filled: true, stem: true, flags: 1, label: 'eighth' },
  s: { code: 's', beats: 0.25, filled: true, stem: true, flags: 2, label: 'sixteenth' },
  t: { code: 't', beats: 0.125, filled: true, stem: true, flags: 3, label: 'thirty-second' },
};

// Beats for a duration code with `dots` dots applied. A single dot adds half the
// value (×1.5), two dots add a half + a quarter (×1.75), etc. — the standard
// dotted-note geometric series 2 − (1/2)^dots.
export const durationBeats = (code, dots = 0) => {
  const base = DURATIONS[code]?.beats;
  if (base == null) return 0;
  return base * (2 - Math.pow(0.5, dots));
};

// Major-key signatures: tonic letter (with optional accidental) → the ordered
// accidentals it carries. We key off the bare tonic so "C", "C major", "C Major"
// and "Cmaj" all resolve. Order matters — it's the order the glyphs are drawn at
// the clef (F C G D A E B for sharps; the reverse for flats).
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const SHARP_KEYS = { G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7 };
const FLAT_KEYS = { F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7 };

// Minor tonic → its relative major (tonic + minor third up), so a minor key
// resolves through the SHARP_KEYS/FLAT_KEYS major lookup above instead of
// (incorrectly) reusing its own letter as if it were major. Covers the 15
// keys reachable through SHARP_KEYS/FLAT_KEYS + natural C/Am. Explicit modes
// (dorian, mixolydian, …) are out of scope — score those in C (all naturals)
// per the existing convention, same as the seed data does.
const MINOR_TO_MAJOR = {
  A: 'C', E: 'G', B: 'D', 'F#': 'A', 'C#': 'E', 'G#': 'B', 'D#': 'F#', 'A#': 'C#',
  D: 'F', G: 'Bb', C: 'Eb', F: 'Ab', Bb: 'Db', Eb: 'Gb', Ab: 'Cb',
};

// Matches a minor qualifier immediately following the tonic: `m`, `min`, or
// `minor` (case-insensitive), optionally preceded by whitespace. The trailing
// `\b` is what keeps this from misfiring on "major"/"maj" — after matching the
// bare `m`, the next character in "major" is the word-char `a`, so there's no
// word boundary and the whole match fails, leaving the tonic to resolve as
// major (unchanged default behavior).
const MINOR_QUALIFIER = /^\s*m(?:in(?:or)?)?\b/i;

// Resolve a key string ("C major", "Eb", "D minor", "F# minor", "Bbm") to a
// key-signature descriptor. We read the tonic (letter + optional single
// accidental) plus an optional minor qualifier right after it; a minor tonic
// is mapped to its relative major before the lookup, so the signature matches
// the actual key rather than the parallel major. Unknown → C (no accidentals).
export const keySignature = (keyName) => {
  const raw = keyName || '';
  const m = /^\s*([A-Ga-g])([#b]?)/.exec(raw);
  let tonic = m ? `${m[1].toUpperCase()}${m[2]}` : 'C';
  if (m && MINOR_QUALIFIER.test(raw.slice(m[0].length)) && MINOR_TO_MAJOR[tonic]) {
    tonic = MINOR_TO_MAJOR[tonic];
  }
  if (SHARP_KEYS[tonic]) {
    const count = SHARP_KEYS[tonic];
    return { type: 'sharp', count, letters: SHARP_ORDER.slice(0, count) };
  }
  if (FLAT_KEYS[tonic]) {
    const count = FLAT_KEYS[tonic];
    return { type: 'flat', count, letters: FLAT_ORDER.slice(0, count) };
  }
  return { type: 'none', count: 0, letters: [] };
};

// Diatonic step for a letter+octave (C4 = 0). Ignores accidentals — they shift
// pitch chromatically but a sharp/flat note still sits on its letter's line.
export const diatonicStep = (letter, octave) => {
  const idx = LETTER_INDEX[String(letter || '').toUpperCase()];
  if (idx == null || !Number.isFinite(octave)) return null;
  return (octave - 4) * 7 + idx;
};

// Parse a bare pitch (no duration), e.g. "F#4" → { letter, accidental, octave,
// step }. Accidental is normalized to '', '#', '##', 'b', 'bb', or 'n'. Returns
// null for anything that isn't a pitch (callers treat null as "not a note").
export const parsePitch = (str) => {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2}|n)?(-?\d)$/.exec(String(str || '').trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accidental = m[2] || '';
  const octave = Number(m[3]);
  return { letter, accidental, octave, step: diatonicStep(letter, octave) };
};

// Default headers — every field has a sane fallback so a score with no header
// block still renders (treble, C major, 4/4).
const DEFAULT_HEADER = { clef: 'treble', key: 'C', beats: 4, beatValue: 4, tempo: null };

const parseTimeSignature = (raw) => {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(raw || '');
  if (!m) return null;
  const beats = Number(m[1]);
  const beatValue = Number(m[2]);
  if (!beats || !beatValue) return null;
  return { beats, beatValue };
};

// One token → a note/rest object, or { error } if it doesn't parse. Grammar:
//   [chord]? (r | PITCH) DURATION dots? (lyric)?
const TOKEN_RE = /^(?:\[([^\]]*)\])?(r|[A-Ga-g](?:#{1,2}|b{1,2}|n)?-?\d)([whqest])(\.*)(?:\((.*)\))?$/;

const parseToken = (token) => {
  const m = TOKEN_RE.exec(token);
  if (!m) return { error: `unrecognized token "${token}"` };
  const [, chord, core, durCode, dotStr, lyric] = m;
  const dots = dotStr ? dotStr.length : 0;
  // Carry the static duration properties (filled / stem / flags) the renderer
  // needs alongside the per-token dots/beats, so a duration object is fully
  // self-describing — a quarter note knows it's solid-with-stem, not just "1 beat".
  const base = DURATIONS[durCode];
  const duration = { code: durCode, dots, beats: durationBeats(durCode, dots), filled: base.filled, stem: base.stem, flags: base.flags };
  if (core === 'r') {
    return { rest: true, duration, chord: chord || '' };
  }
  const pitch = parsePitch(core);
  if (!pitch) return { error: `bad pitch in "${token}"` };
  return {
    rest: false,
    pitch,
    step: pitch.step,
    duration,
    chord: chord || '',
    lyric: lyric || '',
  };
};

// Parse a full score string into { clef, key, keySig, time, tempo, measures,
// errors }. `measures` is an array of { notes, beats } where `beats` is the
// summed duration (handy for the renderer to flag incomplete bars, and for
// tests). Always returns a usable object — never throws.
export const parseScore = (text) => {
  const header = { ...DEFAULT_HEADER };
  const errors = [];
  const bodyLines = [];

  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // A header line is `key: value` and contains no `|` (music) and no note
    // tokens. We detect it by the leading `word:` shape before any `|`.
    const headerMatch = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(line);
    if (headerMatch && !line.includes('|')) {
      const field = headerMatch[1].toLowerCase();
      const value = headerMatch[2].trim();
      if (field === 'clef') header.clef = /^bass$/i.test(value) ? 'bass' : 'treble';
      else if (field === 'key') header.key = value;
      else if (field === 'tempo') { const t = Number(value); if (Number.isFinite(t)) header.tempo = t; }
      else if (field === 'time') {
        const ts = parseTimeSignature(value);
        if (ts) { header.beats = ts.beats; header.beatValue = ts.beatValue; }
        else errors.push(`bad time signature "${value}"`);
      }
      continue;
    }
    bodyLines.push(line);
  }

  // Join the music body and split into measures on `|`. Empty segments (from a
  // leading/trailing/double `|`) are dropped.
  const body = bodyLines.join(' ');
  const segments = body.split('|').map((s) => s.trim()).filter(Boolean);
  const measures = segments.map((segment, mi) => {
    const notes = [];
    // A standalone `[chord]` token attaches to the NEXT note (the readable form
    // `[C] E4q`); the attached form `[C]E4q` also works. `pendingChord` carries a
    // bare bracket forward until a note consumes it.
    let pendingChord = '';
    for (const token of segment.split(/\s+/).filter(Boolean)) {
      const bare = /^\[([^\]]*)\]$/.exec(token);
      if (bare) { pendingChord = bare[1]; continue; }
      const parsed = parseToken(token);
      if (parsed.error) { errors.push(`measure ${mi + 1}: ${parsed.error}`); continue; }
      if (pendingChord && !parsed.chord) parsed.chord = pendingChord;
      pendingChord = '';
      notes.push(parsed);
    }
    const beats = notes.reduce((sum, n) => sum + (n.duration?.beats || 0), 0);
    return { notes, beats };
  });

  return {
    clef: header.clef,
    key: header.key,
    keySig: keySignature(header.key),
    time: { beats: header.beats, beatValue: header.beatValue },
    tempo: header.tempo,
    measures,
    errors,
  };
};

// True when the text contains at least one parseable note — lets the UI decide
// whether to show the staff or an empty-state hint without rendering first.
export const scoreHasMusic = (text) => parseScore(text).measures.some((m) => m.notes.length > 0);
