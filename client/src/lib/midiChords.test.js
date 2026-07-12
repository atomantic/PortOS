import { describe, expect, it } from 'vitest';
import { detectChordWindows, nameChord, chordNoteNames } from './midiChords.js';

const note = (midi, startSec, durationSec) => ({ midi, startSec, durationSec });

describe('nameChord', () => {
  it('names root-position triads and sevenths', () => {
    expect(nameChord([0, 4, 7], 0)).toBe('C');          // C E G
    expect(nameChord([9, 0, 4], 9)).toBe('Am');         // A C E
    expect(nameChord([0, 4, 7, 11], 0)).toBe('Cmaj7');
    expect(nameChord([7, 11, 2, 5], 7)).toBe('G7');
    expect(nameChord([9, 0, 4, 7], 9)).toBe('Am7');
    expect(nameChord([11, 2, 5, 9], 11)).toBe('Bm7b5');
    expect(nameChord([0, 3, 6, 9], 0)).toBe('Cdim7');
    expect(nameChord([0, 3, 6], 0)).toBe('Cdim');
    expect(nameChord([0, 4, 8], 0)).toBe('Caug');
  });

  it('names suspensions and add9', () => {
    expect(nameChord([0, 2, 7], 0)).toBe('Csus2');
    expect(nameChord([0, 5, 7], 0)).toBe('Csus4');
    expect(nameChord([0, 2, 4, 7], 0)).toBe('Cadd9');
  });

  it('reports inversions as slash chords', () => {
    expect(nameChord([0, 4, 7], 4)).toBe('C/E');   // first inversion
    expect(nameChord([0, 4, 7], 7)).toBe('C/G');   // second inversion
  });

  it('falls back to pitch-class names for unmatched clusters, never a wrong guess', () => {
    expect(nameChord([0, 1, 2], 0)).toBe('C C# D');
    expect(nameChord([0, 4, 8, 11, 2], 0)).toBe('C D E G# B');
  });

  it('returns empty for fewer than two pitch classes', () => {
    expect(nameChord([0], 0)).toBe('');
    expect(nameChord([0, 12 + 0].map((m) => m % 12), 0)).toBe(''); // octave doubling, one pc
  });
});

describe('detectChordWindows', () => {
  it('detects a sustained triad as one labeled window', () => {
    const windows = detectChordWindows([
      note(60, 0, 1), note(64, 0, 1), note(67, 0, 1),
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: 'C', midis: [60, 64, 67] });
    expect(windows[0].startSec).toBeCloseTo(0, 5);
    expect(windows[0].endSec).toBeCloseTo(1, 5);
  });

  it('ignores overlaps shorter than the minimum window', () => {
    // 30ms passing-note overlap — below the 60ms default → no chord.
    expect(detectChordWindows([note(60, 0, 0.5), note(62, 0.47, 0.5)])).toEqual([]);
    // The same shape with a 200ms overlap IS a window.
    expect(detectChordWindows([note(60, 0, 0.5), note(62, 0.3, 0.5)])).toHaveLength(1);
  });

  it('produces no windows for a monophonic melody', () => {
    expect(detectChordWindows([note(60, 0, 0.5), note(62, 0.5, 0.5), note(64, 1, 0.5)])).toEqual([]);
  });

  it('octave doublings of one pitch class are not a chord', () => {
    expect(detectChordWindows([note(60, 0, 1), note(72, 0, 1)])).toEqual([]);
  });

  it('merges retriggered instances of the same chord', () => {
    const windows = detectChordWindows([
      note(60, 0, 0.5), note(64, 0, 0.5), note(67, 0, 0.5),
      note(60, 0.52, 0.5), note(64, 0.52, 0.5), note(67, 0.52, 0.5),
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].label).toBe('C');
    expect(windows[0].endSec).toBeCloseTo(1.02, 5);
  });

  it('splits when the sounding set changes to a different chord', () => {
    const windows = detectChordWindows([
      note(60, 0, 1), note(64, 0, 1), note(67, 0, 1),   // C
      note(57, 1, 1), note(60, 1, 1), note(64, 1, 1),   // Am
    ]);
    expect(windows.map((w) => w.label)).toEqual(['C', 'Am']);
  });

  it('handles empty and malformed input', () => {
    expect(detectChordWindows([])).toEqual([]);
    expect(detectChordWindows(null)).toEqual([]);
    expect(detectChordWindows([{ midi: NaN, startSec: 0, durationSec: 1 }])).toEqual([]);
  });
});

describe('chordNoteNames', () => {
  it('renders midi numbers as note names', () => {
    expect(chordNoteNames([60, 64, 67])).toBe('C4 E4 G4');
    expect(chordNoteNames([])).toBe('');
  });
});
