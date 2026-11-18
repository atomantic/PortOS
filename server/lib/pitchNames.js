/**
 * Pitch-class names, pitch classes and scientific note names for MIDI numbers (sharps spelling), shared by the MIDI parser, chord naming and the client piano keyboard.
 *
 * Canonical sharps-spelling table — the single source for note/chord naming
 * (client/src/lib/pianoKeyboard.js and referenceAnalysis.js re-export it). A
 * spelling change here must not fork per consumer.
 */

export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Positive modulo so negative MIDI numbers (below C-1) still classify correctly.
export const pitchClass = (midi) => ((midi % 12) + 12) % 12;

// Scientific note name for a MIDI number (sharps spelling). MIDI 60 → "C4".
export const midiNoteName = (midi) => {
  if (!Number.isFinite(midi)) return '';
  return `${PITCH_CLASS_NAMES[pitchClass(midi)]}${Math.floor(midi / 12) - 1}`;
};
