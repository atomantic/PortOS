// Canonical a cappella song-craft reference data: dirge rhythm shapes, the
// layer-building ladder, a learning sequence, musical-notation help, and the
// movable-do solfège scale. The Songs Guide page renders directly from these
// arrays (rhythm shapes, layer ladder, learning steps, notation, solfège), and
// the Song editor reuses RHYTHM_SHAPES and VOICE_LAYERS for its picker options
// so the editor and the docs never drift. Keep this module pure (no React, no
// imports) — it is mirrored into the client lib barrel and unit-tested.

// --- Rhythm shapes ---------------------------------------------------------
// A "rhythm shape" is the felt pulse + note-length feel a song leans on. A
// dirge is a slow, solemn lament (funeral march, ballad of loss) — "500 Miles"
// by Peter, Paul and Mary sits in the slow-ballad / dirge family. `bpm` carries
// the typical tempo band, `feel` the conductor's count, and `count` a spoken
// counting pattern the singer can tap. `dirge` marks the shapes that suit a
// lament so the guide can highlight the slow family the user asked about.
export const RHYTHM_SHAPES = [
  {
    id: 'slow-4-4',
    label: 'Slow 4/4 ballad',
    dirge: true,
    bpm: { min: 56, max: 76, label: '56–76 BPM' },
    feel: 'Four even beats per bar, weight on 1 and 3.',
    count: '1 — 2 — 3 — 4',
    note: 'The default lament pulse. "500 Miles" lives here: long sustained vowels on the downbeats, lyrics breathing across the bar rather than chopping it up.',
  },
  {
    id: 'dirge-6-8',
    label: 'Compound 6/8 dirge',
    dirge: true,
    bpm: { min: 40, max: 60, label: '40–60 BPM (dotted-quarter pulse)' },
    feel: 'Two slow pulses per bar, each split into three — a swaying funeral-march lilt.',
    count: 'ONE-and-a Two-and-a',
    note: 'The rocking 6/8 underpins many spirituals and laments. Conduct in 2, sing in 6 — the triple subdivision gives the grief a heave-and-settle.',
  },
  {
    id: 'rubato-free',
    label: 'Rubato / free-time lament',
    dirge: true,
    bpm: { min: null, max: null, label: 'No fixed tempo — follow the lead' },
    feel: 'Pulse stretches and contracts with the phrase; the lead breathes, the layers follow.',
    count: 'Follow the words, not a click',
    note: 'Used for the most exposed laments. Drop the metronome: cadence on the lyric, let the harmony swell and release with the lead singer.',
  },
  {
    id: 'cut-time-march',
    label: 'Cut-time processional',
    dirge: true,
    bpm: { min: 60, max: 84, label: '60–84 BPM (half-note pulse)' },
    feel: 'Two broad pulses per bar — a walking, processional tread.',
    count: 'ONE . . . TWO . . .',
    note: 'A dirge that moves. The half-note pulse keeps it solemn but gives a forward, funeral-procession walk under the melody.',
  },
  {
    id: 'driving-4-4',
    label: 'Driving 4/4 (uptempo)',
    dirge: false,
    bpm: { min: 96, max: 132, label: '96–132 BPM' },
    feel: 'Steady, energetic four — backbeat emphasis on 2 and 4.',
    count: '1 2 3 4 with a clap on 2 & 4',
    note: 'Not a dirge — the contrast point. Useful when a set needs to lift out of the laments; clap or stomp the backbeat to drive it.',
  },
  {
    id: 'waltz-3-4',
    label: 'Waltz 3/4',
    dirge: false,
    bpm: { min: 84, max: 144, label: '84–144 BPM' },
    feel: 'Three beats per bar, strong downbeat then two lighter beats.',
    count: 'ONE two three',
    note: 'A lilting triple meter. Slowed right down it can read as a tender lament; kept moving it sways.',
  },
];

// --- Voice layers ----------------------------------------------------------
// The order singers stack parts when arranging a cappella, foundation-first.
// `order` is the recommended build sequence; `voices` names the typical
// SATB-ish home for the part. The editor offers these as part labels.
export const VOICE_LAYERS = [
  {
    id: 'lead',
    label: 'Lead melody',
    order: 1,
    voices: 'Any — the tune everyone knows',
    role: 'The song itself. Everyone learns this first so the harmony has a home to orbit.',
    advice: 'Lock the lead before adding anything. If the melody is shaky, every layer above it wobbles.',
  },
  {
    id: 'bass',
    label: 'Bass / root',
    order: 2,
    voices: 'Bass',
    role: 'The harmonic floor — usually the root of each chord, moving slowly.',
    advice: 'Add the bass second. It defines the chord under the melody and gives the upper voices their tuning reference.',
  },
  {
    id: 'harmony-3rd',
    label: 'Harmony (third)',
    order: 3,
    voices: 'Alto / Tenor',
    role: 'A line a third above or below the melody — the first taste of chord color.',
    advice: 'Thirds are the sweet spot: close enough to feel like the tune, far enough to bloom into harmony. Build this before stacking wider intervals.',
  },
  {
    id: 'harmony-5th',
    label: 'Harmony (fifth)',
    order: 4,
    voices: 'Tenor / Soprano',
    role: 'The fifth fills out the triad and opens the sound up.',
    advice: 'With root, third and fifth you have a full chord. Add this once the third is solid so the stack stays in tune.',
  },
  {
    id: 'drone',
    label: 'Drone / pedal',
    order: 5,
    voices: 'Bass / Alto',
    role: 'A sustained held note (often the tonic or fifth) under everything.',
    advice: 'A drone is the cheapest way to make a lament feel ancient and grounded. One held vowel under the whole verse does enormous work.',
  },
  {
    id: 'counter',
    label: 'Counter-melody',
    order: 6,
    voices: 'Soprano / Tenor',
    role: 'An independent melodic line that answers the lead in its gaps.',
    advice: 'Save this for last. It fills the lead\'s breathing spaces — write it into the rests, not on top of the words.',
  },
  {
    id: 'vocal-perc',
    label: 'Vocal percussion / texture',
    order: 7,
    voices: 'Any',
    role: 'Breath, hums, clicks, "doo"/"ah" pads, or beatbox — rhythmic and textural glue.',
    advice: 'Optional and genre-dependent. For a dirge, a soft hummed pad beats a beatbox; keep texture serving the mood.',
  },
];

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
