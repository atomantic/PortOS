// Piano-keyboard geometry for the song system's Synthesia-style piano-roll
// visualizer (<PianoRoll>). Pure math, no canvas/React — turns a set of MIDI
// note numbers into a left-to-right key layout (white keys tiled edge-to-edge,
// black keys overlaid on the boundaries) so the renderer only does drawing and
// the layout is unit-testable. Companion to scorePlayback.js, whose
// buildSchedule now carries a `midi` per note.

// Pitch classes (semitone within an octave) that map to WHITE keys. Everything
// else is a black key.
const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

// Canonical sharps-spelling pitch-class name table — the single source for
// note/chord naming (referenceAnalysis.js re-exports it; midiChords.js
// consumes it). A spelling change here must not fork per consumer.
export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Positive modulo so negative MIDI numbers (below C-1) still classify correctly.
export const pitchClass = (midi) => ((midi % 12) + 12) % 12;

// True when this MIDI note is a black (sharp/flat) key.
export const isBlackKey = (midi) => !WHITE_PITCH_CLASSES.has(pitchClass(midi));

// Scientific note name for a MIDI number (sharps spelling). MIDI 60 → "C4".
export const midiNoteName = (midi) => {
  if (!Number.isFinite(midi)) return '';
  return `${PITCH_CLASS_NAMES[pitchClass(midi)]}${Math.floor(midi / 12) - 1}`;
};

// Black-key width as a fraction of a white-key width (real pianos ≈ 0.6).
export const BLACK_KEY_RATIO = 0.62;
// Black keys are shorter than white keys — fraction of the keyboard height.
export const BLACK_KEY_HEIGHT_RATIO = 0.62;

/**
 * Pad a set of MIDI numbers out to whole C–B octaves, with a minimum span, so
 * the keyboard always starts on a C and ends on a B and never collapses to a
 * sliver for a one-note part.
 *
 * @param {number[]} midis — note numbers in play (rests already filtered out).
 * @param {object} [opts]
 * @param {number} [opts.minSemitones=24] — minimum keyboard span (2 octaves).
 * @returns {{ lowMidi:number, highMidi:number }} inclusive, lowMidi is a C,
 *   highMidi is a B.
 */
export const keyboardRange = (midis, { minSemitones = 24 } = {}) => {
  const finite = (midis || []).filter((m) => Number.isFinite(m));
  // Default to a comfortable C4-centered window when there are no notes.
  let min = finite.length ? Math.min(...finite) : 60;
  let max = finite.length ? Math.max(...finite) : 71;

  // Snap the low end down to the C at or below it.
  const lowMidi = min - pitchClass(min);
  // Octaves from lowMidi that cover max, then take that block's B (…+12·n−1).
  let octaves = Math.ceil((max - lowMidi + 1) / 12);
  // Enforce the minimum span (in whole octaves).
  octaves = Math.max(octaves, Math.ceil(minSemitones / 12));
  const highMidi = lowMidi + octaves * 12 - 1;
  return { lowMidi, highMidi };
};

/**
 * Build the pixel layout for a keyboard spanning [lowMidi, highMidi] across a
 * given width. White keys tile edge-to-edge; black keys are overlaid centered
 * on the boundary between the two white keys they sit between.
 *
 * @param {object} args
 * @param {number} args.lowMidi — first (white) key, a C from keyboardRange.
 * @param {number} args.highMidi — last (white) key, a B from keyboardRange.
 * @param {number} args.width — total pixel width to fill.
 * @returns {{ keys: Array<{midi:number,isBlack:boolean,x:number,w:number}>,
 *   whiteWidth:number, blackWidth:number, lowMidi:number, highMidi:number }}
 *   keys are ordered white-first then black so a renderer can draw whites then
 *   overlay blacks; each carries its own x/width.
 */
export const buildKeyboardLayout = ({ lowMidi, highMidi, width }) => {
  const whites = [];
  for (let m = lowMidi; m <= highMidi; m += 1) if (!isBlackKey(m)) whites.push(m);
  const whiteCount = whites.length || 1;
  const whiteWidth = width / whiteCount;
  const blackWidth = whiteWidth * BLACK_KEY_RATIO;

  // White-key x by MIDI for positioning the black keys on their boundaries.
  const whiteX = new Map();
  const whiteKeys = whites.map((midi, i) => {
    const x = i * whiteWidth;
    whiteX.set(midi, x);
    return { midi, isBlack: false, x, w: whiteWidth };
  });

  const blackKeys = [];
  for (let m = lowMidi; m <= highMidi; m += 1) {
    if (!isBlackKey(m)) continue;
    // A black key always sits just above the white key one semitone below it;
    // center it on that white key's right edge (the boundary to the next white).
    const xBelow = whiteX.get(m - 1);
    if (xBelow == null) continue;
    const boundary = xBelow + whiteWidth;
    blackKeys.push({ midi: m, isBlack: true, x: boundary - blackWidth / 2, w: blackWidth });
  }

  return { keys: [...whiteKeys, ...blackKeys], whiteWidth, blackWidth, lowMidi, highMidi };
};
