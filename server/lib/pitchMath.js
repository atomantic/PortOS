/**
 * Scientific-pitch math shared by the LLM-authored music formats (chiptune
 * scores, drawn waveform sketches) on both runtimes. Pure and dependency-free,
 * so the client imports it directly (see client/src/lib/README.md).
 */

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PITCH_RE = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d)$/;

/** MIDI number for a scientific-pitch string ("C4" = 60, "A4" = 69), or null. */
export function pitchToMidi(pitch) {
  const m = PITCH_RE.exec(String(pitch || '').trim());
  if (!m) return null;
  const pc = PITCH_CLASS[m[1].toUpperCase()];
  const shift = m[2] ? (m[2][0] === '#' ? m[2].length : -m[2].length) : 0;
  const octave = Number(m[3]);
  return (octave + 1) * 12 + pc + shift;
}

/** Frequency (Hz) for a MIDI note number, A4 (69) = 440. */
export const midiToFreq = (midi) => (Number.isFinite(midi) ? 440 * Math.pow(2, (midi - 69) / 12) : null);
