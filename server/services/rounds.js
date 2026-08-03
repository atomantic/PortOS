/**
 * Rounds workbench
 *
 * Write, arrange, and learn a cappella rounds (e.g. "500 Miles" by Peter, Paul
 * and Mary). Each round stores its key/tempo/rhythm-shape, lyric sections, and
 * the voice layers (lead / bass / harmony / drone / counter-melody) the user is
 * stacking — plus per-layer learning notes. Persisted to data/rounds.json.
 *
 * Pure-ish CRUD over a single JSON file: PortOS is single-user (see CLAUDE.md
 * "Security Model"), so a per-file write queue serializes the read-modify-write
 * cycle rather than guarding against competing humans.
 *
 * Shape bounds + sanitize helpers live in lib/roundsValidation.js and are
 * re-exported here so routes/rounds.js builds its Zod schema from the same
 * source — sanitize-on-read and validate-at-the-boundary agree by
 * construction. This file keeps the seed data (built-in rounds + canon-voice
 * derivation) and the file-backed CRUD.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { sanitizeRound as sanitizeRoundRecord } from '../lib/roundsValidation.js';

// Shape bounds re-exported so routes/rounds.js and the seed migrations keep
// their existing import surface (svc.TITLE_MAX_LENGTH, …).
export {
  TITLE_MAX_LENGTH, ARTIST_MAX_LENGTH, KEY_MAX_LENGTH, FIELD_MAX_LENGTH,
  SCORE_MAX_LENGTH, SCORE_PARTS_MAX, LABEL_MAX_LENGTH, PART_MAX_LENGTH,
  ID_MAX_LENGTH, TEMPO_MIN, TEMPO_MAX, SECTIONS_MAX, LAYERS_MAX,
  RECORDINGS_MAX, REFERENCES_MAX, PARTNERS_MAX, URL_MAX_LENGTH,
  REF_SEGMENTS_MAX, PITCH_TRACK_MAX, PER_NOTE_GRADES_MAX,
  PROGRESS_HISTORY_MAX, PROGRESS_SCOPES_MAX, RECORDING_GRADES,
} from '../lib/roundsValidation.js';

const STATE_PATH = join(PATHS.data, 'rounds.json');

// Service errors carry a `code` field so routes map to HTTP status without
// string-matching on err.message (which breaks on rename).
export const ERR_NOT_FOUND = 'NOT_FOUND';
// Raised when a refresh-from-template is requested for a song that isn't a
// bundled built-in default (no shipped template to restore from).
export const ERR_NOT_BUILTIN = 'NOT_BUILTIN';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Project a stored or inbound record onto the canonical song shape, stamping
// `builtIn` from the shipped-seed id set. Used on read (defends hand-edited
// JSON) and on write (normalizes the input). The sanitizer itself lives in
// lib/roundsValidation.js.
export const sanitizeRound = (raw) => sanitizeRoundRecord(raw, BUILTIN_ROUND_IDS);

// Worked-example harmony stack for the built-in "500 Miles" — the chord-tone
// voicing the AI-derive feature is meant to produce (the song the user pointed
// at as the first experiment). Each part is a complete lead-sheet score in the
// PortOS DSL, voiced from the chord-tone map (NOT parallel intervals): a
// hymn-like root–fifth bass, two sustained inner pads, a sustained upper pad
// that carries the F#→G leading tone on D7, and a sparse top descant that enters
// late. Kept as a named export so SEED_ROUNDS and migration 076 share ONE source
// (no drift). Voicing roles/ranges mirror songCraft.js HARMONY_PARTS.
export const SEED_500_MILES_SCORE_PARTS = [
  {
    id: 'part-500-bass', label: 'Bass', role: 'bass',
    score: [
      'clef: bass', 'key: G', 'time: 4/4', 'tempo: 68', '',
      '| rh [G] G2h(you) |',
      '| [G] G2h(miss) D3h(train) |',
      '| [Em] E2h(on) B2h(will) |',
      '| [C] C3h(know) G2h(am) |',
      '| [Am7] A2h(gone) E3h(can) |',
      '| [D7] D3h(hear) A2h(tle) |',
      '| [G] G2h(blow) D3h(dred) |',
      '| [G] G2w(miles) |',
    ].join('\n'),
  },
  {
    id: 'part-500-mid-2', label: 'Mid Harmony II', role: 'mid-harmony-2',
    score: [
      'clef: treble', 'key: G', 'time: 4/4', 'tempo: 68', '',
      '| rw |',
      '| [G] B3w(miss) |',
      '| [Em] B3w(on) |',
      '| [C] G3w(know) |',
      '| [Am7] G3w(gone) |',
      '| [D7] A3w(hear) |',
      '| [G] B3w(blow) |',
      '| [G] G3w(miles) |',
    ].join('\n'),
  },
  {
    id: 'part-500-mid-1', label: 'Mid Harmony I', role: 'mid-harmony-1',
    score: [
      'clef: treble', 'key: G', 'time: 4/4', 'tempo: 68', '',
      '| rw |',
      '| [G] D4w(miss) |',
      '| [Em] E4w(on) |',
      '| [C] E4w(know) |',
      '| [Am7] E4w(gone) |',
      '| [D7] C4w(hear) |',
      '| [G] D4w(blow) |',
      '| [G] D4w(miles) |',
    ].join('\n'),
  },
  {
    id: 'part-500-high-2', label: 'High Harmony II', role: 'high-harmony-2',
    score: [
      'clef: treble', 'key: G', 'time: 4/4', 'tempo: 68', '',
      '| rw |',
      '| [G] G4w(miss) |',
      '| [Em] G4w(on) |',
      '| [C] E4w(know) |',
      '| [Am7] E4w(gone) |',
      '| [D7] F#4w(hear) |',
      '| [G] G4w(blow) |',
      '| [G] G4w(miles) |',
    ].join('\n'),
  },
  {
    id: 'part-500-high-1', label: 'High Harmony I', role: 'high-harmony-1',
    score: [
      'clef: treble', 'key: G', 'time: 4/4', 'tempo: 68', '',
      '| rw |',
      '| rw |',
      '| rw |',
      '| rw |',
      '| [Am7] G4w(gone) |',
      '| [D7] A4w(hear) |',
      '| [G] B4w(blow) |',
      '| [G] B4w(miles) |',
    ].join('\n'),
  },
];

// Reference performances for the built-in "500 Miles" — TikTok clips the user
// pointed at as worked examples for the Reference material section. Kept as a
// named export so SEED_ROUNDS and the backfill migration share ONE source (no
// drift), the same pattern as SEED_500_MILES_SCORE_PARTS above.
export const SEED_500_MILES_REFERENCES = [
  { id: 'ref-tt-marie', url: 'https://www.tiktok.com/@marie.celestinee/video/7638358831205977376', label: 'TikTok · @marie.celestinee', note: 'Reference performance.' },
  { id: 'ref-tt-eric', url: 'https://www.tiktok.com/@ericolsith/video/7633158760659176718', label: 'TikTok · @ericolsith', note: 'Reference performance.' },
  { id: 'ref-tt-eric-2', url: 'https://www.tiktok.com/@ericolsith/video/7647221045618887949', label: 'TikTok · @ericolsith', note: 'Reference performance.' },
];

// --- Traditional rounds: melodies + canonic voice stacks --------------------
// The four built-in rounds are canons — the harmony IS the melody sung against
// itself, each voice entering a fixed number of bars late. Rather than hand-
// transcribe the staggered voices (which could drift from the tune), we DERIVE
// each canon voice from the one melody string below: every voice is provably the
// same melody, just delayed by whole-bar rests. SEED_ROUNDS uses these for both a
// round's base `score` and its `scoreParts`, and migration 086 backfills the
// parts onto installs that seeded the rounds before they carried a voice stack.

// Split a lead-sheet score into its header lines (`key: value`, no bar) and its
// music-body lines (everything containing a `|`). Blank lines are dropped.
const splitScoreLines = (score) => {
  const headers = [];
  const body = [];
  for (const raw of String(score).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes('|') && /^[A-Za-z]+\s*:/.test(line)) headers.push(line);
    else body.push(line);
  }
  return { headers, body };
};

// A canon voice: the melody entering `delayBars` whole-bar rests late (the
// round's staggered entry). Built from the melody so the voice can't drift from
// the tune. `role` is free-text (`voice-2` …) — it falls after the named harmony
// stack via harmonyPartOrder (→ 99, stable), so the View switcher lists the
// voices in entry order after the Melody tab.
const canonVoice = (melody, { delayBars, id, label, role }) => {
  const { headers, body } = splitScoreLines(melody);
  const rests = Array.from({ length: delayBars }, () => '| rw |');
  return { id, label, role, score: [...headers, '', ...rests, ...body].join('\n') };
};

// Hey Ho Nobody Home — eight bars, four 2-bar phrases. A 4-voice round: voices
// enter one phrase (2 bars) apart, and the phrases stack into the full D-minor
// chord. Centered on D with all naturals (score header `key: C` = no key
// signature), so it stacks cleanly with Ah Poor Bird and Rose Rose Rose Red in
// the D-minor quodlibet: phrase 1 (D/A) + phrase 2 (D–E–F) + phrase 3 (A–G–F–E)
// outline a D-minor triad, with no B-natural to sound a tritone against the
// partners' F. Contour matches the Wikibooks Songbook (E-minor) and Kodály
// teaching (D natural-minor) transcriptions, transposed to D
// (1-1-2-2-♭3-♭3-♭3-♭3-2 in phrase 2). Exported so migrations 158 and 214 can
// restore it onto installs holding an older transcription.
//
// Phrase 4 ("Hey, hey, ho") is the round's closing line. It was missing entirely
// until issue #3238 — the lyric sheet listed four lines while the staff carried
// three, and the 6-bar melody drifted out of phase against its own 8-bar
// quodlibet partners every four cycles. It cadences F–E–D onto the tonic, in the
// same two-half-notes-per-bar rhythm as phrase 1, using only the round's
// existing D natural-minor pentachord (A D E F G — no new pitch letters).
export const HEY_HO_MELODY = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 76',
  '',
  '| D4h(Hey) A3h(ho) | D4q(no-) D4e(bo-) D4e(dy) A3h(home) |',
  '| D4q(Meat) D4q(nor) E4q(drink) E4q(nor) | F4e(mon-) F4e(ey) F4e(have) F4e(I) E4h(none) |',
  '| A4q(Still) G4q(I) A4q(will) G4q(be) | F4h(mer-) E4h(ry) |',
  '| F4h(Hey) E4h(hey) | D4h(ho) rh |',
].join('\n');
export const HEY_HO_SCORE_PARTS = [
  canonVoice(HEY_HO_MELODY, { delayBars: 2, id: 'part-heyho-v2', label: 'Voice 2', role: 'voice-2' }),
  canonVoice(HEY_HO_MELODY, { delayBars: 4, id: 'part-heyho-v3', label: 'Voice 3', role: 'voice-3' }),
  canonVoice(HEY_HO_MELODY, { delayBars: 6, id: 'part-heyho-v4', label: 'Voice 4', role: 'voice-4' }),
];

// Ah Poor Bird — eight bars, four 2-bar phrases. A 4-voice round; voices enter
// every two bars.
const AH_POOR_BIRD_MELODY = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 72',
  '',
  '| D4h(Ah) E4h(poor) | F4w(bird) |',
  '| F4h(take) G4h(thy) | A4w(flight) |',
  '| A4q(far) D5q(a-) D5q(bove) C5q(the) | D5h(sor-) A4q(rows) G4q(of) |',
  '| F4h(this) E4h(sad) | D4w(night) |',
].join('\n');
const AH_POOR_BIRD_SCORE_PARTS = [
  canonVoice(AH_POOR_BIRD_MELODY, { delayBars: 2, id: 'part-ahpoorbird-v2', label: 'Voice 2', role: 'voice-2' }),
  canonVoice(AH_POOR_BIRD_MELODY, { delayBars: 4, id: 'part-ahpoorbird-v3', label: 'Voice 3', role: 'voice-3' }),
  canonVoice(AH_POOR_BIRD_MELODY, { delayBars: 6, id: 'part-ahpoorbird-v4', label: 'Voice 4', role: 'voice-4' }),
];

// Rose Rose Rose Red — eight bars, four 2-bar phrases. A 4-voice round; voices
// enter every two bars.
const ROSE_MELODY = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 76',
  '',
  '| D4h(Rose) C4h(rose) | D4h(rose) A3h(red) |',
  '| D4q(Will) D4q(I) E4q(ev-) E4q(er) | F4q(see) G4q(thee) E4h(wed) |',
  '| A4q(I) A4q(will) G4q(mar-) A4q(ry) | F4q(at) G4e(thy) F4e E4q(will) A3q(sir) |',
  '| D4h(At) C4q(thy) E4q(will) | D4w |',
].join('\n');
const ROSE_SCORE_PARTS = [
  canonVoice(ROSE_MELODY, { delayBars: 2, id: 'part-rose-v2', label: 'Voice 2', role: 'voice-2' }),
  canonVoice(ROSE_MELODY, { delayBars: 4, id: 'part-rose-v3', label: 'Voice 3', role: 'voice-3' }),
  canonVoice(ROSE_MELODY, { delayBars: 6, id: 'part-rose-v4', label: 'Voice 4', role: 'voice-4' }),
];

// Zum Gali Gali — the 2-bar chant stated twice. Because the chant repeats every
// two bars, an even delay would only double the voice in unison; a ONE-bar entry
// offsets the busy half against the resolving half so the two halves overlap
// into harmony (a single canonic Voice 2).
const ZUM_MELODY = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 112',
  '',
  '| D4q(Zoom) D4e(gul-) E4e(ly) F4e(gul-) E4e(ly) F4e(gul-) E4e(ly) | D4q(zoom) D4e(gul-) D4e(ly) A3q(gul-) C4q(ly) |',
  '| D4q(Zoom) D4e(gul-) E4e(ly) F4e(gul-) E4e(ly) F4e(gul-) E4e(ly) | D4q(zoom) D4e(gul-) D4e(ly) A3q(gul-) C4q(ly) |',
].join('\n');
const ZUM_SCORE_PARTS = [
  canonVoice(ZUM_MELODY, { delayBars: 1, id: 'part-zum-v2', label: 'Voice 2', role: 'voice-2' }),
];

// The canonic voice stacks for the four rounds, keyed by song id. Shared by
// SEED_ROUNDS (below) and migration 086 so there's ONE source — no drift.
export const SEED_ROUND_SCORE_PARTS = {
  'seed-hey-ho-nobody-home': HEY_HO_SCORE_PARTS,
  'seed-ah-poor-bird': AH_POOR_BIRD_SCORE_PARTS,
  'seed-rose-rose-rose-red': ROSE_SCORE_PARTS,
  'seed-zum-gali-gali': ZUM_SCORE_PARTS,
};

// Seeded on first read so a fresh install opens on a worked example — the song
// the feature was designed around. Mirrors the dirge `slow-4-4` rhythm shape
// and the foundation-first layer ladder from songCraft.js.
export const SEED_ROUNDS = [
  {
    id: 'seed-500-miles',
    title: '500 Miles',
    artist: 'Peter, Paul and Mary',
    key: 'G major',
    tempo: 68,
    rhythmShapeId: 'slow-4-4',
    notation: 'Verse chords (key of G, after Hedy West): G — Em — C — Am7 — D7 — G, four slow bars per line. A gentle 4/4 ballad; let each line breathe across the bar rather than chopping it.',
    // Sheet music in the PortOS lead-sheet DSL — the full melody (all verses plus
    // the closing coda) with chords and lyrics, in G major. Edit it in the Sheet
    // music tab; see client/src/lib/scoreNotation.js for the format. NOTE:
    // migration 073's SCORE_500_MILES constant must stay identical to this (the
    // 073 drift test asserts it) — update both together.
    score: [
      'clef: treble',
      'key: G',
      'time: 4/4',
      'tempo: 68',
      '',
      '| rh [G] D4q(If) D4q(you) |',
      '| [G] B4q.(miss) A4e(the) B4q.(train) A4e(I\'m) |',
      '| [Em] B4h(on) A4q(you) G4q(will) |',
      '| [C] C5q.(know) B4e(that) A4q(I) G4q(am) |',
      '| [Am7] E4h.(gone) F#4e(you) G4e(can) |',
      '| [D7] A4q.(hear) F#4e(the) A4q.(whis-) F#4e(tle) |',
      '| [G] G4h(blow) A4e(a) B4e(hun-) C5q(dred) |',
      '| [G] D5w(miles) |',
      '',
      '| [G] D5h(A) B4q(hun-) A4q(dred) |',
      '| [Em] B4q.(miles) A4e(a) B4q.(hun-) A4e(dred) |',
      '| [C] C5q.(miles) B4e(a) A4q(hun-) G4q(dred) |',
      '| [Am7] E4h.(miles) F#4e(you) G4e(can) |',
      '| [D7] A4q.(hear) F#4e(the) A4q.(whis-) F#4e(tle) |',
      '| [G] G4h(blow) A4e(a) B4e(hun-) C5q(dred) |',
      '| [G] D5w(miles) |',
      '',
      '| [G] D5h(Lord,) B4q(I\'m) A4q(one,) |',
      '| [Em] B4h(Lord,) A4q(I\'m) G4q(two,) |',
      '| [C] C5q.(Lord,) B4e(I\'m) A4q(three,) G4q(Lord,) |',
      '| [Am7] E4h.(I\'m) F#4e(four,) G4e(Lord,) |',
      '| [D7] A4q.(I\'m) F#4e(five) A4q.(hun-) F#4e(dred) |',
      '| [G] G4h(miles) A4e(a-) B4e(way) C5q(from) |',
      '| [G] D5w(home) |',
      '',
      '| [G] D5h(A-) B4q(way) A4q(from) |',
      '| [Em] B4h(home,) A4q(a-) G4q(way) |',
      '| [C] C5q.(from) B4e(home,) A4q(a-) G4q(way) |',
      '| [Am7] E4h.(from) F#4e(home,) G4e(Lord,) |',
      '| [D7] A4q.(I\'m) F#4e(five) A4q.(hun-) F#4e(dred) |',
      '| [G] G4h(miles) A4e(a-) B4e(way) C5q(from) |',
      '| [G] D5w(home) |',
      '',
      '| [G] D5h(Not) B4q(a) A4q(shirt) |',
      '| [Em] B4h(on) A4q(my) G4q(back,) |',
      '| [C] C5q.(not) B4e(a) A4q(pen-) G4q(ny) |',
      '| [Am7] E4h.(to) F#4e(my) G4e(name,) |',
      '| [D7] A4q.(Lord,) F#4e(I) A4q.(can\'t) F#4e(go) |',
      '| [G] G4h(back) A4e(home) B4e(this-) C5q(a-) |',
      '| [G] D5w(way) |',
      '',
      '| [G] D5h(This-) B4q(a-) A4q(way,) |',
      '| [Em] B4h(this-) A4q(a-) G4q(way,) |',
      '| [C] C5q.(this-) B4e(a-) A4q(way,) G4q(Lord,) |',
      '| [Am7] E4h.(I) F#4e(can\'t) G4e(go) |',
      '| [D7] A4q.(back) F#4e(home) A4q.(this-) F#4e(a-) |',
      '| [G] G4h(way) D5h |',
      '',
      '| [G] D5h(You) B4q(can) A4q(hear) |',
      '| [C] C5q.(the) B4e(whis-) A4q(tle) G4q(blow) |',
      '| [D7] A4q(a) F#4q(hun-) A4q(dred) F#4q(miles) |',
      '| [G] G4w(miles) |',
    ].join('\n'),
    // A full chord-tone harmony stack (bass + two mid pads + two high pads),
    // the worked example for the AI-derive feature. See SEED_500_MILES_SCORE_PARTS.
    scoreParts: SEED_500_MILES_SCORE_PARTS,
    notes: 'A travelling lament — keep it spacious and mournful. Sustain the vowels on the downbeats. Works beautifully with a soft hummed drone under the verses.',
    learned: false,
    sections: [
      { id: 'sec-verse-1', label: 'Verse 1', lyrics: 'If you miss the train I\'m on\nYou will know that I am gone\nYou can hear the whistle blow\nA hundred miles' },
      { id: 'sec-chorus-1', label: 'Chorus 1', lyrics: 'A hundred miles\nA hundred miles\nA hundred miles\nA hundred miles\nA hundred miles\nYou can hear the whistle blow a hundred miles' },
      { id: 'sec-verse-2', label: 'Verse 2', lyrics: 'Lord, I\'m one\nLord, I\'m two\nLord, I\'m three\nLord, I\'m four\nLord, I\'m five hundred miles from my home' },
      { id: 'sec-chorus-2', label: 'Chorus 2', lyrics: 'Five hundred miles\nFive hundred miles\nFive hundred miles\nFive hundred miles\nLord, I\'m five hundred miles from my home' },
      { id: 'sec-verse-3', label: 'Verse 3', lyrics: 'Not a shirt on my back\nNot a penny to my name\nLord, I can\'t go home\nThis a-way' },
      { id: 'sec-chorus-3', label: 'Chorus 3', lyrics: 'This a-way\nThis a-way\nThis a-way\nThis a-way\nThis a-way\nLord, I can\'t go home this a-way' },
      { id: 'sec-verse-4', label: 'Verse 4 (reprise)', lyrics: 'If you miss the train I\'m on\nYou will know that I am gone\nYou can hear the whistle blow a hundred miles' },
    ],
    layers: [
      { id: 'melody', label: 'Melody', part: 'Soprano / Tenor', notes: 'The tune everyone knows. Lock this first, in tune, before stacking anything.' },
      { id: 'bass', label: 'Bass', part: 'Bass', notes: 'Root of each chord — C, A, F, G — with the fifth as gentle movement. You are the floor; move slowly.' },
      { id: 'mid-harmony-1', label: 'Mid Harmony I', part: 'Alto / Tenor', notes: 'The main inner voice — a third/sixth under the melody, landing on chord tones. The richest harmony; build it first.' },
      { id: 'mid-harmony-2', label: 'Mid Harmony II', part: 'Alto', notes: 'Low inner pad — sustained chord tones under Mid Harmony I. Move by step; do not chase the melody.' },
      { id: 'high-harmony-2', label: 'High Harmony II', part: 'Soprano / Tenor', notes: 'Held upper pad — keep the leading tone (the B in G7) so it resolves up to C.' },
      { id: 'high-harmony-1', label: 'High Harmony I', part: 'Soprano', notes: 'Sparse top descant — high chord tones on the emotional phrases. Enter late; mostly long notes.' },
    ],
    references: SEED_500_MILES_REFERENCES,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  // --- Traditional rounds -------------------------------------------------
  // Four singable rounds that the user learned as a set. The first three —
  // Hey Ho Nobody Home, Ah Poor Bird, Rose Rose Rose Red — are the classic
  // English quodlibet: all in the same minor key, they can be sung at the same
  // time. Zum Gali Gali shares the key and rounds out the set. Each links the
  // others via partnerRoundIds, so the editor's round-stack view can render them
  // together. Melodies are scored with no key signature (D Dorian / D minor,
  // all naturals) so they stack cleanly; the `key` field names the tonality.
  {
    id: 'seed-hey-ho-nobody-home',
    title: 'Hey Ho Nobody Home',
    artist: 'Traditional',
    key: 'D minor (Dorian)',
    tempo: 76,
    rhythmShapeId: 'slow-4-4',
    notation: 'A round in up to six voices (Ravenscroft\'s Pammelia, 1609). Four two-bar phrases (8 bars); new voices enter one phrase behind the last, so four voices fill the round. Centered on D with no key signature — all naturals (D Dorian / natural minor), no B. Melody after the Wikibooks Songbook and Kodály teaching transcriptions, transposed to a D tonal center; the closing "Hey, hey, ho" cadences F–E–D onto the tonic.',
    score: HEY_HO_MELODY,
    // Canonic voice stack: the melody entering one phrase (2 bars) late per voice
    // — the round sung against itself. Derived from HEY_HO_MELODY so it can't
    // drift from the tune. Gives every round (not just 500 Miles) the layered
    // player + piano-roll view in the editor.
    scoreParts: HEY_HO_SCORE_PARTS,
    notes: 'One of the oldest English rounds. Sung with Ah Poor Bird and Rose Rose Rose Red it forms a classic three-round quodlibet — all three share one minor chord cycle and can be sung at the same time. Keep it light and lilting despite the minor key.',
    learned: false,
    sections: [
      { id: 'sec-round', label: 'Round', lyrics: 'Hey, ho, nobody home,\nMeat nor drink nor money have I none,\nStill I will be merry.\nHey, hey, ho.' },
    ],
    layers: [
      { id: 'voice-1', label: 'Voice 1 (lead)', part: 'Any', notes: 'Starts the round and sings it straight through. Everyone learns this line first.' },
      { id: 'voice-2', label: 'Voice 2', part: 'Any', notes: 'Enters as Voice 1 reaches "Meat nor drink…" (phrase 2) — one full phrase behind the lead.' },
      { id: 'voice-3', label: 'Voice 3', part: 'Any', notes: 'Enters at "Still I will be merry" (phrase 3); by here the stacked phrases fill out the minor chord.' },
      { id: 'voice-4', label: 'Voice 4', part: 'Any', notes: 'Enters at the closing "Hey, hey, ho" (phrase 4, bar 7) — the last of the four staggered entries, filling the round out.' },
    ],
    references: [],
    partnerRoundIds: ['seed-ah-poor-bird', 'seed-rose-rose-rose-red', 'seed-zum-gali-gali'],
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  },
  {
    id: 'seed-ah-poor-bird',
    title: 'Ah Poor Bird',
    artist: 'Traditional',
    key: 'D minor',
    tempo: 72,
    rhythmShapeId: 'slow-4-4',
    notation: 'A four-phrase round (8 bars). Voices enter every two bars. The melody climbs the minor scale to a leap in the third phrase, then settles back to the tonic. Scored in D minor with no key signature (all naturals). Phrase 3 \'the\' is sung C natural here (natural-minor variant); the Kodály-lineage teaching edition raises it to C♯ there (harmonic minor, tone set la-ti-do-re-mi-si). Both are widely sung — this is a deliberate variant choice, not an error.',
    score: AH_POOR_BIRD_MELODY,
    // Canonic voice stack: the melody entering two bars late per voice. Derived
    // from AH_POOR_BIRD_MELODY so it can't drift from the tune.
    scoreParts: AH_POOR_BIRD_SCORE_PARTS,
    notes: 'A gentle English lament-round. Combines with Hey Ho Nobody Home and Rose Rose Rose Red as a quodlibet. Two lyric sets ship: the common "take thy flight" verse and the "Oh poor bird, why art thou…" variant.',
    learned: false,
    sections: [
      { id: 'sec-verse', label: 'Verse', lyrics: 'Ah, poor bird,\nTake thy flight,\nFar above the sorrows\nOf this sad night.' },
      { id: 'sec-alt', label: 'Alternate (as learned)', lyrics: 'Oh, poor bird, why art thou\nHiding in the shadows\nOf this dark house?' },
    ],
    layers: [
      { id: 'voice-1', label: 'Voice 1 (lead)', part: 'Any', notes: 'Sings the climbing phrase straight through. The round is four 2-bar phrases.' },
      { id: 'voice-2', label: 'Voice 2', part: 'Any', notes: 'Enters at "take thy flight" (bar 3), two bars behind the lead.' },
      { id: 'voice-3', label: 'Voice 3', part: 'Any', notes: 'Enters at "far above the sorrows" (bar 5).' },
      { id: 'voice-4', label: 'Voice 4', part: 'Any', notes: 'Enters at "of this sad night" (bar 7) — four voices fill the lament.' },
    ],
    references: [],
    partnerRoundIds: ['seed-hey-ho-nobody-home', 'seed-rose-rose-rose-red', 'seed-zum-gali-gali'],
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  },
  {
    id: 'seed-rose-rose-rose-red',
    title: 'Rose Rose Rose Red',
    artist: 'Traditional',
    key: 'D minor',
    tempo: 76,
    rhythmShapeId: 'slow-4-4',
    notation: 'A four-phrase English round (i–VII–V harmony), 8 bars. Voices enter every two bars. Scored in D minor with no key signature (all naturals). Two documented variant points vs. the Kodály-lineage teaching edition (cross-checked against the Wikibooks Songbook and 8notes/Beth\'s Notes listings): this seed\'s verse is "I will marry at thy will, sire" where the teaching edition sings "Aye, marry, that I will / if thou but stay", and this melody resolves the final phrase to the tonic D where the teaching edition ends on A/mi so the loop leads back into the round. Both variants are widely sung.',
    score: ROSE_MELODY,
    // Canonic voice stack: the melody entering two bars late per voice. Derived
    // from ROSE_MELODY so it can't drift from the tune.
    scoreParts: ROSE_SCORE_PARTS,
    notes: 'The third of the classic quodlibet trio with Hey Ho Nobody Home and Ah Poor Bird — all three stack in the same key. A favourite singing-round.',
    learned: false,
    sections: [
      { id: 'sec-round', label: 'Round', lyrics: 'Rose, rose, rose, red,\nWill I ever see thee wed?\nI will marry at thy will, sire,\nAt thy will.' },
    ],
    layers: [
      { id: 'voice-1', label: 'Voice 1 (lead)', part: 'Any', notes: 'Sings the round straight through. Four 2-bar phrases.' },
      { id: 'voice-2', label: 'Voice 2', part: 'Any', notes: 'Enters at "Will I ever see thee wed" (bar 3).' },
      { id: 'voice-3', label: 'Voice 3', part: 'Any', notes: 'Enters at "I will marry…" (bar 5).' },
      { id: 'voice-4', label: 'Voice 4', part: 'Any', notes: 'Enters at "At thy will" (bar 7) — four voices complete the harmony.' },
    ],
    references: [],
    partnerRoundIds: ['seed-hey-ho-nobody-home', 'seed-ah-poor-bird', 'seed-zum-gali-gali'],
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  },
  {
    id: 'seed-zum-gali-gali',
    title: 'Zum Gali Gali',
    artist: 'Traditional',
    key: 'D minor',
    tempo: 112,
    rhythmShapeId: 'driving-4-4',
    notation: 'The refrain chant, repeated. Scored in D minor with no key signature (all naturals). Loop it as many times as you like; a second voice entering one phrase behind turns it into a round. Deliberate learned variant: this seed encodes the refrain as the user learned it, transposed to D minor to stack with the English trio; canonical printings of the Israeli round Zum Gali Gali are typically in E minor and include the verse ("Hechalutz le\'ma\'an avodah…") over the ostinato. Do not "correct" this toward the printed version — the transposition and refrain-only form are intentional.',
    score: ZUM_MELODY,
    // Canonic Voice 2: the chant entering ONE bar late so its busy half overlaps
    // the resolving half (an even delay would only double it in unison). Derived
    // from ZUM_MELODY so it can't drift from the tune.
    scoreParts: ZUM_SCORE_PARTS,
    notes: 'A simple chant on repeat — sung here as "zoom gully gully gully, zoom gully gully" (the refrain of the Israeli round Zum Gali Gali). Loop it as a driving ostinato; a second voice entering a phrase late turns it into a round. Shares the key with the English trio and rounds out the set.',
    learned: false,
    sections: [
      { id: 'sec-chant', label: 'Chant', lyrics: 'Zoom gully gully gully, zoom gully gully,\nZoom gully gully gully, zoom gully gully.' },
    ],
    layers: [
      { id: 'voice-1', label: 'Voice 1 (lead)', part: 'Any', notes: 'Chants the line and keeps it going on repeat — the engine the others ride on.' },
      { id: 'voice-2', label: 'Voice 2', part: 'Any', notes: 'Enters a phrase behind Voice 1 so the two halves of the chant overlap into harmony.' },
    ],
    references: [],
    partnerRoundIds: ['seed-hey-ho-nobody-home', 'seed-ah-poor-bird', 'seed-rose-rose-rose-red'],
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  },
];

// Ids of the bundled built-in default songs. The sanitizer stamps each read
// song with `builtIn` from this set, and refreshRoundFromTemplate restores a
// built-in's shipped content from the matching SEED_ROUNDS entry. A user who
// already has the song installed (older shipped lyrics) renews it on demand.
export const BUILTIN_ROUND_IDS = new Set(SEED_ROUNDS.map((s) => s.id));
const seedTemplate = (id) => SEED_ROUNDS.find((s) => s.id === id) || null;

// Serialize the read-modify-write cycle so two mutations issued back-to-back
// (e.g. a rename PATCH followed by a layer edit) each merge against the freshest
// persisted state instead of racing on a stale snapshot. Single-user, so this
// is re-entrancy hygiene, not a multi-actor lock (see CLAUDE.md Security Model).
const enqueue = createFileWriteQueue();

// Pure read + sanitize — NO write side effect. When the file is absent or
// malformed, returns the seed in-memory without persisting it. Mutations call
// this inside their enqueue() so the read-modify-write cycle never re-enters
// the queue (which would deadlock).
async function readRounds() {
  const state = await readJSONFile(STATE_PATH, null, { allowArray: false });
  if (!state || !Array.isArray(state.rounds)) {
    return SEED_ROUNDS.map(sanitizeRound).filter(Boolean);
  }
  return state.rounds.map(sanitizeRound).filter(Boolean);
}

// Public read. On first read (file absent) it persists the seed so the example
// is stable and editable — but the seed write is routed through the SAME queue
// as mutations and re-checks inside the queue, so a create that landed first
// can't be clobbered by a late seed write (read-path lazy-init race).
export async function listRounds() {
  const state = await readJSONFile(STATE_PATH, null, { allowArray: false });
  if (state && Array.isArray(state.rounds)) {
    return state.rounds.map(sanitizeRound).filter(Boolean);
  }
  return enqueue(async () => {
    // Re-check inside the queue: a queued create may have already written the
    // file (with seed + new song). If so, don't overwrite it with bare seed.
    const fresh = await readJSONFile(STATE_PATH, null, { allowArray: false });
    if (fresh && Array.isArray(fresh.rounds)) {
      return fresh.rounds.map(sanitizeRound).filter(Boolean);
    }
    const seeded = SEED_ROUNDS.map(sanitizeRound).filter(Boolean);
    await atomicWrite(STATE_PATH, { rounds: seeded });
    return seeded;
  });
}

export async function getRound(id) {
  const songs = await listRounds();
  return songs.find((s) => s.id === id) || null;
}

export async function createRound(input) {
  return enqueue(async () => {
    const songs = await readRounds();
    const now = new Date().toISOString();
    const song = sanitizeRound({ ...input, id: `round-${randomUUID()}`, createdAt: now, updatedAt: now });
    songs.unshift(song);
    await atomicWrite(STATE_PATH, { rounds: songs });
    console.log(`🎵 Created song "${song.title}" (${song.id})`);
    return song;
  });
}

export async function updateRound(id, patch) {
  return enqueue(async () => {
    const songs = await readRounds();
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) throw makeErr(`Song ${id} not found`, ERR_NOT_FOUND);
    // Merge field-by-field so an absent key preserves the stored value while a
    // present key (including empty string / empty array) applies the change.
    const merged = { ...songs[idx] };
    for (const key of ['title', 'artist', 'key', 'tempo', 'rhythmShapeId', 'notation', 'score', 'scoreParts', 'notes', 'learned', 'progress', 'sections', 'layers', 'recordings', 'references', 'partnerRoundIds']) {
      if (key in patch) merged[key] = patch[key];
    }
    merged.id = id;
    merged.createdAt = songs[idx].createdAt;
    merged.updatedAt = new Date().toISOString();
    const song = sanitizeRound(merged);
    songs[idx] = song;
    await atomicWrite(STATE_PATH, { rounds: songs });
    console.log(`🎵 Updated song "${song.title}" (${id})`);
    return song;
  });
}

// Restore a built-in default song's shipped content (metadata, lyrics, layers,
// notation, notes) to the current bundled template — for installs that seeded
// an older version of the song and want the newer shipped one. User-owned state
// is preserved: their recorded takes, their `learned` progress, and the
// original createdAt. Throws ERR_NOT_BUILTIN for a non-default song.
export async function refreshRoundFromTemplate(id) {
  return enqueue(async () => {
    const songs = await readRounds();
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) throw makeErr(`Song ${id} not found`, ERR_NOT_FOUND);
    const template = seedTemplate(id);
    if (!template) throw makeErr(`Song ${id} is not a built-in default`, ERR_NOT_BUILTIN);
    const existing = songs[idx];
    // Resetting layers to the template set can orphan a recording assigned to a
    // user-added layer the template doesn't define — unassign those so the
    // mixer doesn't reference a layer that no longer exists (the take still plays).
    const templateLayerIds = new Set((template.layers || []).map((l) => l.id));
    const recordings = (existing.recordings || []).map((r) => (
      r.layerId && !templateLayerIds.has(r.layerId) ? { ...r, layerId: '' } : r
    ));
    const song = sanitizeRound({
      ...template,
      id,
      learned: existing.learned,
      // Preserve the user's training progress — it's their practice record, not
      // the template's to reset (mirrors keeping `learned` + `recordings`).
      progress: existing.progress,
      recordings,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    songs[idx] = song;
    await atomicWrite(STATE_PATH, { rounds: songs });
    console.log(`🔄 Refreshed built-in song "${song.title}" (${id}) from template`);
    return song;
  });
}

export async function deleteRound(id) {
  return enqueue(async () => {
    const songs = await readRounds();
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) throw makeErr(`Song ${id} not found`, ERR_NOT_FOUND);
    const [removed] = songs.splice(idx, 1);
    await atomicWrite(STATE_PATH, { rounds: songs });
    console.log(`🗑️ Deleted song "${removed.title}" (${id})`);
    return { id };
  });
}
