import {
  RHYTHM_SHAPES as SHARED_RHYTHM_SHAPES,
  VOICE_LAYERS as SHARED_VOICE_LAYERS,
  HARMONY_PARTS as SHARED_HARMONY_PARTS,
} from '../../../server/lib/songCraftParts.js';

// Canonical a cappella song-craft reference data: dirge rhythm shapes, the
// layer-building ladder, a learning sequence, musical-notation help, and the
// movable-do solfège scale. The Songs Guide page renders directly from these
// arrays (rhythm shapes, layer ladder, learning steps, notation, solfège), and
// the Song editor reuses RHYTHM_SHAPES and VOICE_LAYERS for its picker options
// so the editor and the docs never drift. Keep this module pure (no React, no
// side effects) — shared vocabulary comes from a pure server/lib leaf.

// --- Rhythm shapes ---------------------------------------------------------
// A "rhythm shape" is the felt pulse + note-length feel a song leans on. A
// dirge is a slow, solemn lament (funeral march, ballad of loss) — "500 Miles"
// by Peter, Paul and Mary sits in the slow-ballad / dirge family. `bpm` carries
// the typical tempo band, `feel` the conductor's count, and `count` a spoken
// counting pattern the singer can tap. `dirge` marks the shapes that suit a
// lament so the guide can highlight the slow family the user asked about.
const RHYTHM_SHAPES_PRESENTATION = {
  'slow-4-4': {
    bpm: { min: 56, max: 76, label: '56–76 BPM' },
    count: '1 — 2 — 3 — 4',
    note: 'The default lament pulse. "500 Miles" lives here: long sustained vowels on the downbeats, lyrics breathing across the bar rather than chopping it up.',
  },
  'dirge-6-8': {
    bpm: { min: 40, max: 60, label: '40–60 BPM (dotted-quarter pulse)' },
    count: 'ONE-and-a Two-and-a',
    note: 'The rocking 6/8 underpins many spirituals and laments. Conduct in 2, sing in 6 — the triple subdivision gives the grief a heave-and-settle.',
  },
  'rubato-free': {
    bpm: { min: null, max: null, label: 'No fixed tempo — follow the lead' },
    count: 'Follow the words, not a click',
    note: 'Used for the most exposed laments. Drop the metronome: cadence on the lyric, let the harmony swell and release with the lead singer.',
  },
  'cut-time-march': {
    bpm: { min: 60, max: 84, label: '60–84 BPM (half-note pulse)' },
    count: 'ONE . . . TWO . . .',
    note: 'A dirge that moves. The half-note pulse keeps it solemn but gives a forward, funeral-procession walk under the melody.',
  },
  'driving-4-4': {
    bpm: { min: 96, max: 132, label: '96–132 BPM' },
    count: '1 2 3 4 with a clap on 2 & 4',
    note: 'Not a dirge — the contrast point. Useful when a set needs to lift out of the laments; clap or stomp the backbeat to drive it.',
  },
  'waltz-3-4': {
    bpm: { min: 84, max: 144, label: '84–144 BPM' },
    count: 'ONE two three',
    note: 'A lilting triple meter. Slowed right down it can read as a tender lament; kept moving it sways.',
  },
};

export const RHYTHM_SHAPES = SHARED_RHYTHM_SHAPES.map((part) => ({
  ...RHYTHM_SHAPES_PRESENTATION[part.id],
  ...part,
}));

// Human-readable label for a rhythm shape id — `Slow 4/4 ballad · dirge
// (56–76 BPM)`. Shared by the editor's <select> options and the read-only
// performance view so the format lives in one place. Empty string for an
// unknown id.
export const rhythmShapeLabel = (id) => {
  const shape = RHYTHM_SHAPES.find((s) => s.id === id);
  if (!shape) return '';
  return `${shape.label}${shape.dirge ? ' · dirge' : ''} (${shape.bpm.label})`;
};

// --- Voice layers ----------------------------------------------------------
// The order singers stack parts when arranging a cappella, foundation-first.
// This is the SAME vocabulary as the sheet-music HARMONY_PARTS stack below — ids
// and labels match — so a recorded take's layer lines up with the notated part of
// the same name (Melody, Bass, Mid/High Harmony I & II), and the recording
// "take types" stay in step with the parts the AI derive tool generates. The
// difference is framing: here `voices`/`role`/`advice` teach how to *build and
// sing* each layer, where HARMONY_PARTS carries the `range`/`voicing` rules the
// derive prompt needs. `order` is the recommended build sequence (melody → bass →
// inner voices → upper voices); `voices` names the typical SATB-ish home.
// songCraft.test.js guards that every layer id+label still exists in
// HARMONY_PARTS so the two vocabularies can't drift apart.
const VOICE_LAYERS_PRESENTATION = {
  'melody': {
    order: 1,
    advice: 'Lock the lead before adding anything. If the melody is shaky, every layer above it wobbles.',
  },
  'bass': {
    order: 2,
    advice: 'Add the bass second. It defines the chord under the melody and gives the upper voices their tuning reference.',
  },
  'mid-harmony-1': {
    order: 3,
    advice: 'The richest harmony, so build it first among the inner voices. Move smoothly and favour common tones between chords.',
  },
  'mid-harmony-2': {
    order: 4,
    advice: 'Fills the chord under Mid Harmony I. Sustain and move by step; do not chase the melody.',
  },
  'high-harmony-2': {
    order: 5,
    advice: 'A held pad above the inner voices. Keep the dominant-7 third so it resolves up to the tonic.',
  },
  'high-harmony-1': {
    order: 6,
    advice: 'The shimmer on top. Save it for the climaxes; rest through the opening and enter late.',
  },
};

export const VOICE_LAYERS = SHARED_VOICE_LAYERS.map((part) => ({
  ...VOICE_LAYERS_PRESENTATION[part.id],
  ...part,
}));

// --- Harmony parts (sheet-music variations) --------------------------------
// The set of sheet-music parts a song can carry beyond its base melody. The
// base score is the `melody`; the rest are harmony variations the AI derive
// tool produces (and the user edits) — each its own staff in the same lead-sheet
// DSL, rhythm-aligned to the melody so the parts stack.
//
// The voicing model is CHORD-TONE, not parallel-interval: each voice targets a
// chord tone (sustaining / moving smoothly), rather than tracking the melody a
// fixed interval away — a folk/a cappella "layered build" where one clear melody
// sits over a grounded bass, two moving inner voices, and one or two sustained
// upper pads, with staggered entrances. Building parallel 3rds/6ths under every
// syllable reads as a "MIDI choir" and is explicitly what this avoids.
//
// `order` lays the stack low→high for the View-tab switcher; `range` and
// `voicing` are the per-voice rules the derive prompt and the UI hint inject.
// Identity and voicing come from the same vocabulary the AI prompts use.
const HARMONY_PARTS_PRESENTATION = {
  'melody': {
    advice: 'This is the base score. Lock it first; every derived part is voiced against its chords and phrasing.',
  },
  'bass': {
    advice: 'The harmonic floor and tuning reference. Long tones or soft pulses on beats 1 and 3; keep it simple.',
  },
  'mid-harmony-2': {
    advice: 'Fills the chord under Mid Harmony I. Sustain and move by step; do not chase the melody.',
  },
  'mid-harmony-1': {
    advice: 'The richest harmony. Move smoothly, favour common tones between chords, hold on a chord tone when the melody passes through a non-chord note.',
  },
  'high-harmony-2': {
    advice: 'A held pad above the inner voices. Keep the dominant-7 third (F# under D7) — it resolves up to the tonic.',
  },
  'high-harmony-1': {
    advice: 'The shimmer on top. Save it for the climaxes; rest through the opening and enter late, mostly long notes.',
  },
};

export const HARMONY_PARTS = SHARED_HARMONY_PARTS.map((part) => ({
  ...HARMONY_PARTS_PRESENTATION[part.id],
  ...part,
}));

// The parts the AI derive tool generates from the base melody (everything except
// the melody itself, which is the input). Declaration order is low→high.
export const DERIVABLE_HARMONY_PARTS = HARMONY_PARTS.filter((p) => p.derivable);

// Human-readable label for a harmony-part id; empty string for an unknown id so
// a custom/free-text part falls back to its own stored label at the call site.
export const harmonyPartLabel = (id) => HARMONY_PARTS.find((p) => p.id === id)?.label || '';

// Sort key so the View-tab switcher lists the stack low→high (Bass, Mid II, Mid
// I, High II, High I). A scorePart stores the HARMONY_PARTS id in its `role`
// field, so match on id first, then the generic role; unknown ⇒ after the set.
export const harmonyPartOrder = (roleOrId) => {
  const part = HARMONY_PARTS.find((p) => p.id === roleOrId) || HARMONY_PARTS.find((p) => p.role === roleOrId);
  return part ? part.order : 99;
};

// --- Learning steps --------------------------------------------------------
// The practice sequence for learning a new a cappella song, in order.
export const LEARNING_STEPS = [
  {
    id: 'listen',
    label: 'Listen first, sing nothing',
    detail: 'Play a reference recording several times before opening your mouth. Internalize the melody, the feel, and where the phrases breathe.',
  },
  {
    id: 'lyrics',
    label: 'Learn the lyrics cold',
    detail: 'Speak the words in rhythm until they are automatic. You can\'t hold a harmony while still hunting for the next line.',
  },
  {
    id: 'melody',
    label: 'Own the melody',
    detail: 'Sing the lead until it is effortless and in tune — even if you\'ll ultimately sing harmony. The melody is your map.',
  },
  {
    id: 'find-part',
    label: 'Find your part',
    detail: 'Pick the layer that fits your range (see the layer ladder). Learn it against the melody, one phrase at a time.',
  },
  {
    id: 'intervals',
    label: 'Drill the intervals',
    detail: 'Where your part leaps or sits against the lead, practice that interval in isolation until you can find it without the melody playing.',
  },
  {
    id: 'layer',
    label: 'Layer in slowly',
    detail: 'Add voices one at a time, foundation-first: lead, then bass, then thirds, then fifths. Stop and re-tune whenever a chord sounds muddy.',
  },
  {
    id: 'tempo',
    label: 'Slow, then up to tempo',
    detail: 'Rehearse below performance speed until the tuning is locked, then walk the tempo up. For a free-time dirge, rehearse the breaths instead of a click.',
  },
  {
    id: 'memorize',
    label: 'Memorize and perform',
    detail: 'Drop the sheet. A cappella lives or dies on listening to each other — you can\'t blend with your eyes buried in a page.',
  },
];

// --- Notation help ---------------------------------------------------------
// Plain-language primers for reading lead sheets and basic notation. Each
// `group` carries a title, a one-line summary, and a list of point strings.
export const NOTATION_HELP = [
  {
    id: 'staff',
    title: 'The staff & note names',
    summary: 'Five lines, four spaces. Pitch rises as you go up.',
    points: [
      'Treble-clef lines bottom→top: E G B D F ("Every Good Boy Does Fine"); spaces spell F A C E.',
      'Bass-clef lines bottom→top: G B D F A ("Good Boys Do Fine Always"); spaces: A C E G.',
      'The seven letters A–G repeat each octave; a sharp (♯) raises a semitone, a flat (♭) lowers one.',
    ],
  },
  {
    id: 'time-signature',
    title: 'Time signatures',
    summary: 'Top number = beats per bar; bottom = which note gets the beat.',
    points: [
      '4/4 ("common time"): four quarter-note beats per bar — the default for ballads like "500 Miles".',
      '3/4: a waltz — three beats per bar.',
      '6/8: six eighth-notes grouped as two pulses of three — the swaying dirge feel.',
    ],
  },
  {
    id: 'note-values',
    title: 'Note durations',
    summary: 'How long to hold each note, relative to the beat.',
    points: [
      'Whole note = 4 beats, half = 2, quarter = 1, eighth = ½, sixteenth = ¼.',
      'A dot after a note adds half its value again (dotted half = 3 beats).',
      'Rests mirror these durations — silence is part of the rhythm, especially in a lament.',
    ],
  },
  {
    id: 'dynamics',
    title: 'Dynamics & expression',
    summary: 'Markings that shape volume and feel — where a dirge lives.',
    points: [
      'p (piano) = soft, f (forte) = loud; pp / ff are the extremes, mp / mf the middles.',
      'Crescendo (<) swells louder; decrescendo (>) fades — laments breathe on these.',
      'Fermata (𝄐) = hold the note longer than written, at the singer\'s discretion.',
    ],
  },
  {
    id: 'lead-sheet',
    title: 'Reading a lead sheet',
    summary: 'Most a cappella folk songs are shared as melody + chord symbols + lyrics.',
    points: [
      'Chord symbols (C, Am, G7) sit above the staff at the beat they change — the bass and harmony build their notes from these.',
      'Lyrics align under the notes they\'re sung on; a slur or hyphen shows a syllable held across notes.',
      'No staff? A Nashville-number or solfège chart still tells you the chord motion — learn the shape, transpose to your key.',
    ],
  },
];

// --- Solfège -------------------------------------------------------------
// The movable-do major scale degrees. Used by the editor's harmony helper to
// label a part's home degree and by the guide. Index 0 = tonic (Do).
export const SOLFEGE_DEGREES = [
  { degree: 1, solfege: 'Do', semitone: 0 },
  { degree: 2, solfege: 'Re', semitone: 2 },
  { degree: 3, solfege: 'Mi', semitone: 4 },
  { degree: 4, solfege: 'Fa', semitone: 5 },
  { degree: 5, solfege: 'Sol', semitone: 7 },
  { degree: 6, solfege: 'La', semitone: 9 },
  { degree: 7, solfege: 'Ti', semitone: 11 },
];

// Map a 1–7 scale degree to its solfège syllable. Degrees outside 1–7 wrap
// into the octave (so 8 → Do, 9 → Re) so callers can pass raw step counts.
// Returns null for non-numeric input rather than throwing.
export function solfegeForDegree(degree) {
  if (typeof degree !== 'number' || !Number.isFinite(degree)) return null;
  const idx = ((Math.round(degree) - 1) % 7 + 7) % 7;
  return SOLFEGE_DEGREES[idx].solfege;
}

// Only the dirge-family rhythm shapes, in declaration order. The Songs Guide
// leads with these because the lament is what the workbench is built around.
export const DIRGE_RHYTHM_SHAPES = RHYTHM_SHAPES.filter((s) => s.dirge);
