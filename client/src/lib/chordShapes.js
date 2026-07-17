// Chord-name → per-instrument voicing derivation for the SongBook viewer's
// instrument-view toggle (guitar / ukulele / piano). Pure and dependency-free
// (no React, no browser APIs — these tests also run in node env in CI).
//
// Reuses tabNotation.js's chord-token grammar (CHORD_TOKEN_RE) and pitch-class
// tables (NOTE_TO_PC / spellPitchClass) rather than duplicating them.
//
// API:
//   parseChordName(name)             → { root, rootPc, quality, bass, bassPc } | null
//   getChordVoicing(name, instrument)→ instrument-shaped voicing | null
//     'guitar'  → { instrument, frets: [6 × (-1 muted | 0 open | n)], baseFret, bass }
//     'ukulele' → { instrument, frets: [4 × …], baseFret, bass }
//     'piano'   → { instrument, notes: ['A','C','E'], bass }
//   splitJoinedChords(name)          → dash-joined "Am-Am7" → ['Am', 'Am7']
//   toVoicingInstrument(instrument)  → song instrument → diagram instrument
//   VOICING_INSTRUMENTS              → ['guitar', 'ukulele', 'piano']
//
// Fret arrays run low string → high string (guitar EADGBE, ukulele GCEA).
// When baseFret > 1 the positive fret values are relative to the diagram
// window (1 = baseFret); at baseFret 1 they are absolute. Forgiving — unknown
// or unparseable chords return null, never throw.

import { CHORD_TOKEN_RE, NOTE_TO_PC, spellPitchClass } from './tabNotation.js';

export const VOICING_INSTRUMENTS = ['guitar', 'ukulele', 'piano'];

// Map a song record's `instrument` to the diagram instrument the viewer should
// default to: guitar/ukulele/piano pass through, everything else (bass, voice,
// other, unset) renders guitar shapes.
export const toVoicingInstrument = (instrument) =>
  (VOICING_INSTRUMENTS.includes(instrument) ? instrument : 'guitar');

// ---------------------------------------------------------------------------
// Chord-name parsing
// ---------------------------------------------------------------------------

// Written quality suffix → canonical quality key. Deliberately curated to the
// common set — anything else (11, maj9, alt, …) degrades to null upstream.
const QUALITY_ALIASES = {
  '': 'major', maj: 'major', M: 'major',
  m: 'minor', min: 'minor',
  7: '7', m7: 'm7', min7: 'm7',
  maj7: 'maj7', M7: 'maj7',
  m7b5: 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', 'm7(b5)': 'm7b5',
  dim: 'dim', '°': 'dim',
  dim7: 'dim7', '°7': 'dim7', o7: 'dim7',
  aug: 'aug', '+': 'aug',
  sus2: 'sus2',
  sus4: 'sus4', sus: 'sus4',
  add9: 'add9', '(add9)': 'add9',
  6: '6', m6: 'm6', min6: 'm6',
  9: '9',
};

// Canonical quality → chord tones as [degree, semitones-above-root] pairs.
// The degree drives letter-accurate piano spelling (the 3rd of E is G#, never
// Ab); the semitones drive the fretted-instrument solvers.
const QUALITY_DEGREES = {
  major: [[1, 0], [3, 4], [5, 7]],
  minor: [[1, 0], [3, 3], [5, 7]],
  7: [[1, 0], [3, 4], [5, 7], [7, 10]],
  m7: [[1, 0], [3, 3], [5, 7], [7, 10]],
  maj7: [[1, 0], [3, 4], [5, 7], [7, 11]],
  m7b5: [[1, 0], [3, 3], [5, 6], [7, 10]],
  dim: [[1, 0], [3, 3], [5, 6]],
  dim7: [[1, 0], [3, 3], [5, 6], [7, 9]],
  aug: [[1, 0], [3, 4], [5, 8]],
  sus2: [[1, 0], [2, 2], [5, 7]],
  sus4: [[1, 0], [4, 5], [5, 7]],
  add9: [[1, 0], [3, 4], [5, 7], [9, 14]],
  6: [[1, 0], [3, 4], [5, 7], [6, 9]],
  m6: [[1, 0], [3, 3], [5, 7], [6, 9]],
  9: [[1, 0], [3, 4], [5, 7], [7, 10], [9, 14]],
};

// Same token gate tabNotation applies (length cap keeps the alternation-star
// from chewing on pasted garbage).
const isChordToken = (token) =>
  typeof token === 'string' && token.length > 0 && token.length <= 12 && CHORD_TOKEN_RE.test(token);

// Parse one chord symbol into { root, rootPc, quality, bass, bassPc }, or null
// when it isn't a chord token or uses a quality outside the curated set.
// "N.C." parses as a token but has no voicing → null.
export const parseChordName = (name) => {
  const raw = String(name ?? '');
  if (!isChordToken(raw) || /^N\.?C\.?$/.test(raw)) return null;
  const m = /^([A-G])([#b]?)(.*)$/.exec(raw);
  if (!m) return null;
  let suffix = m[3];
  let bass = null;
  const slash = /^(.*)\/([A-G][#b]?)$/.exec(suffix);
  if (slash) {
    suffix = slash[1];
    bass = slash[2];
  }
  const quality = QUALITY_ALIASES[suffix];
  if (!quality) return null;
  return {
    root: m[1] + m[2],
    rootPc: NOTE_TO_PC[m[1] + m[2]],
    quality,
    bass,
    bassPc: bass ? NOTE_TO_PC[bass] : null,
  };
};

// Dash-joined chord runs ("Am-Am7", a quick change written as one token) are
// several voicings. Split when EVERY dash-separated segment is itself a chord
// token — mirroring tabNotation, where bare dash runs are rhythm filler and a
// hyphenated lyric word is not a chord. Anything else returns whole.
export const splitJoinedChords = (name) => {
  const raw = String(name ?? '');
  if (!raw.includes('-')) return [raw];
  const parts = raw.split('-');
  return parts.every((p) => isChordToken(p)) ? parts : [raw];
};

// ---------------------------------------------------------------------------
// Piano voicing — interval math with letter-accurate spelling
// ---------------------------------------------------------------------------

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Spell the note `semis` above the root that serves scale degree `deg`: pick
// the letter `deg-1` letter-steps up, then the accidental that lands on the
// target pitch class. A would-be double accidental (Ebdim's Bbb) falls back to
// the simple enharmonic spelling honoring the root's accidental preference.
const spellDegree = (root, rootPc, deg, semis) => {
  const letter = LETTERS[(LETTERS.indexOf(root[0]) + deg - 1) % 7];
  const targetPc = (rootPc + semis) % 12;
  let diff = (targetPc - LETTER_PC[letter] + 12) % 12;
  if (diff > 6) diff -= 12;
  if (diff === 0) return letter;
  if (diff === 1) return `${letter}#`;
  if (diff === -1) return `${letter}b`;
  return spellPitchClass(targetPc, root[1] || '');
};

const pianoVoicing = (parsed) => ({
  instrument: 'piano',
  notes: QUALITY_DEGREES[parsed.quality].map(([deg, semis]) =>
    spellDegree(parsed.root, parsed.rootPc, deg, semis)),
  bass: parsed.bass,
});

// ---------------------------------------------------------------------------
// Guitar voicing — curated opens + movable E-form / A-form templates
// ---------------------------------------------------------------------------

// Movable shape templates: fret offsets from the ROOT fret per string (low E →
// high e), null = muted. At root fret 0 these ARE the open E-/A-root chords
// (E-form major at 0 = 022100, A-form m7 at 0 = x02010), so only non-E/A-root
// open classics need curating.
const E_FORM = {
  major: [0, 2, 2, 1, 0, 0],
  minor: [0, 2, 2, 0, 0, 0],
  7: [0, 2, 0, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, 2, 1, 1, 0, 0],
  sus4: [0, 2, 2, 2, 0, 0],
  add9: [0, 2, 2, 1, 0, 2],
  6: [0, 2, 2, 1, 2, 0],
  9: [0, 2, 0, 1, 0, 2],
  aug: [0, 3, 2, 1, 1, null],
};
const A_FORM = {
  major: [null, 0, 2, 2, 2, 0],
  minor: [null, 0, 2, 2, 1, 0],
  7: [null, 0, 2, 0, 2, 0],
  m7: [null, 0, 2, 0, 1, 0],
  maj7: [null, 0, 2, 1, 2, 0],
  sus2: [null, 0, 2, 2, 0, 0],
  sus4: [null, 0, 2, 2, 3, 0],
  m7b5: [null, 0, 1, 0, 1, null],
  dim: [null, 0, 1, 2, 1, null],
  dim7: [null, 0, 1, 2, 1, 2],
  aug: null, // no comfortable A-form — E-form covers it
  add9: [null, 0, 2, 4, 2, 0],
  6: [null, 0, 2, 2, 2, 2],
  m6: [null, 0, 2, 2, 1, 2],
  9: [null, 0, -1, 0, 0, 0],
};
const GUITAR_FORMS = [
  { openPc: 4, shapes: E_FORM }, // root on string 6 (low E)
  { openPc: 9, shapes: A_FORM }, // root on string 5 (A)
];

// First-position classics that beat the barre-derived shape, keyed
// `${rootPc}:${quality}` (absolute frets, -1 muted).
const GUITAR_OPEN_SHAPES = {
  '0:major': [-1, 3, 2, 0, 1, 0],   // C
  '0:maj7': [-1, 3, 2, 0, 0, 0],
  '0:7': [-1, 3, 2, 3, 1, 0],
  '0:add9': [-1, 3, 2, 0, 3, 0],
  '0:6': [-1, 3, 2, 2, 1, 0],
  '0:sus4': [-1, 3, 3, 0, 1, 1],
  '2:major': [-1, -1, 0, 2, 3, 2],  // D
  '2:minor': [-1, -1, 0, 2, 3, 1],
  '2:7': [-1, -1, 0, 2, 1, 2],
  '2:m7': [-1, -1, 0, 2, 1, 1],
  '2:maj7': [-1, -1, 0, 2, 2, 2],
  '2:sus2': [-1, -1, 0, 2, 3, 0],
  '2:sus4': [-1, -1, 0, 2, 3, 3],
  '2:6': [-1, -1, 0, 2, 0, 2],
  '5:maj7': [-1, -1, 3, 2, 1, 0],   // Fmaj7
  '7:major': [3, 2, 0, 0, 0, 3],    // G
  '7:7': [3, 2, 0, 0, 0, 1],
  '7:maj7': [3, -1, 0, 0, 0, 2],
  '7:6': [3, 2, 0, 0, 0, 0],
  '11:7': [-1, 2, 1, 2, 0, 2],      // B7
};

// Absolute frets → { frets, baseFret } diagram window: low shapes stay
// absolute at baseFret 1; higher shapes re-base so 1 = baseFret.
const toDiagramWindow = (absFrets) => {
  const fretted = absFrets.filter((f) => f > 0);
  const maxFret = fretted.length ? Math.max(...fretted) : 0;
  if (maxFret <= 4) return { frets: absFrets, baseFret: 1 };
  const baseFret = Math.min(...fretted);
  return { frets: absFrets.map((f) => (f > 0 ? f - baseFret + 1 : f)), baseFret };
};

// Symmetric chords repeat their shape every N frets (any inversion is the
// same pitch-class set), so the root fret can drop toward the nut.
const SHAPE_SYMMETRY = { aug: 4, dim7: 3 };

const guitarVoicing = (parsed) => {
  const open = GUITAR_OPEN_SHAPES[`${parsed.rootPc}:${parsed.quality}`];
  if (open) return { instrument: 'guitar', ...toDiagramWindow(open), bass: parsed.bass };
  let best = null;
  for (const { openPc, shapes } of GUITAR_FORMS) {
    const offsets = shapes[parsed.quality];
    if (!offsets) continue;
    let rootFret = (parsed.rootPc - openPc + 12) % 12;
    if (SHAPE_SYMMETRY[parsed.quality]) rootFret %= SHAPE_SYMMETRY[parsed.quality];
    const minOffset = Math.min(...offsets.filter((o) => o != null));
    if (rootFret + minOffset < 0) rootFret += 12;
    const frets = offsets.map((o) => (o == null ? -1 : rootFret + o));
    const maxFret = Math.max(...frets);
    if (!best || maxFret < best.maxFret) best = { frets, maxFret };
  }
  if (!best) return null;
  return { instrument: 'guitar', ...toDiagramWindow(best.frets), bass: parsed.bass };
};

// ---------------------------------------------------------------------------
// Ukulele voicing — small exact search over GCEA
// ---------------------------------------------------------------------------

const UKE_OPEN_PCS = [7, 0, 4, 9]; // G C E A (re-entrant high-G)

// Find the lowest playable 4-string fingering: every string sounds a chord
// tone, all required tones are covered (the perfect 5th is droppable when the
// chord has more tones than strings), fingers stay inside a 4-fret window
// (open strings always allowed). Scans windows bottom-up, so the first hits
// are the canonical first-position shapes (C=0003, Am=2000, G7=0212, …).
const solveUkulele = (parsed) => {
  const intervals = QUALITY_DEGREES[parsed.quality].map(([, semis]) => semis % 12);
  const allowed = new Set(intervals.map((s) => (parsed.rootPc + s) % 12));
  const requiredIntervals = intervals.length > UKE_OPEN_PCS.length
    ? intervals.filter((s) => s !== 7)
    : intervals;
  const required = [...new Set(requiredIntervals.map((s) => (parsed.rootPc + s) % 12))];
  if (required.length > UKE_OPEN_PCS.length) return null;

  for (let base = 0; base <= 9; base += 1) {
    const perString = UKE_OPEN_PCS.map((openPc) => {
      const options = base === 0 ? [0, 1, 2, 3] : [0, base, base + 1, base + 2, base + 3];
      return [...new Set(options)].filter((f) => allowed.has((openPc + f) % 12));
    });
    if (perString.some((opts) => opts.length === 0)) continue;
    let best = null;
    for (const f0 of perString[0]) for (const f1 of perString[1]) {
      for (const f2 of perString[2]) for (const f3 of perString[3]) {
        const frets = [f0, f1, f2, f3];
        const sounded = new Set(frets.map((f, i) => (UKE_OPEN_PCS[i] + f) % 12));
        if (!required.every((pc) => sounded.has(pc))) continue;
        const sum = f0 + f1 + f2 + f3;
        const max = Math.max(f0, f1, f2, f3);
        if (!best || max < best.max || (max === best.max && sum < best.sum)) {
          best = { frets, sum, max };
        }
      }
    }
    if (best) return { instrument: 'ukulele', ...toDiagramWindow(best.frets), bass: parsed.bass };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Public voicing API
// ---------------------------------------------------------------------------

// Chord name + instrument → voicing (see module header for shapes). Slash
// chords voice the base chord and carry the bass note name in `bass` (piano
// prepends it; string instruments render it as a "/G bass" hint). Returns
// null for unknown/unparseable chords or unsupported instruments.
export const getChordVoicing = (name, instrument) => {
  const parsed = parseChordName(name);
  if (!parsed) return null;
  if (instrument === 'piano') return pianoVoicing(parsed);
  if (instrument === 'guitar') return guitarVoicing(parsed);
  if (instrument === 'ukulele') return solveUkulele(parsed);
  return null;
};
