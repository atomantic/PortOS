import { describe, it, expect } from 'vitest';
import {
  isBlackKey,
  midiNoteName,
  keyboardRange,
  buildKeyboardLayout,
  BLACK_KEY_RATIO,
} from './pianoKeyboard.js';

describe('isBlackKey', () => {
  it('classifies the seven white keys of an octave', () => {
    // C D E F G A B = MIDI 60,62,64,65,67,69,71
    expect([60, 62, 64, 65, 67, 69, 71].every((m) => !isBlackKey(m))).toBe(true);
  });
  it('classifies the five black keys of an octave', () => {
    // C# D# F# G# A# = 61,63,66,68,70
    expect([61, 63, 66, 68, 70].every((m) => isBlackKey(m))).toBe(true);
  });
  it('handles notes below C-1 with positive-modulo classification', () => {
    expect(isBlackKey(-11)).toBe(true); // C#-ish class 1
    expect(isBlackKey(-12)).toBe(false); // C class 0
  });
});

describe('midiNoteName', () => {
  it('names middle C and the tuning A', () => {
    expect(midiNoteName(60)).toBe('C4');
    expect(midiNoteName(69)).toBe('A4');
  });
  it('uses sharps for black keys', () => {
    expect(midiNoteName(61)).toBe('C#4');
    expect(midiNoteName(70)).toBe('A#4');
  });
});

describe('keyboardRange', () => {
  it('snaps to whole C–B octaves around the notes', () => {
    // notes E4(64)..G4(67) → low snaps down to C4(60), high up to B (enforced min 2 oct)
    const { lowMidi, highMidi } = keyboardRange([64, 65, 67]);
    expect(lowMidi % 12).toBe(0); // a C
    expect((highMidi + 1) % 12).toBe(0); // a B (next up is a C)
    expect(highMidi - lowMidi + 1).toBeGreaterThanOrEqual(24); // min 2 octaves
  });
  it('enforces the minimum span for a single note', () => {
    const { lowMidi, highMidi } = keyboardRange([60]);
    expect(highMidi - lowMidi + 1).toBe(24); // 2 full octaves
    expect(lowMidi).toBe(60);
  });
  it('grows to cover a wide range, ending on a B', () => {
    const { lowMidi, highMidi } = keyboardRange([48, 84]); // C3..C6
    expect(lowMidi).toBe(48); // C3
    expect((highMidi + 1) % 12).toBe(0); // ends on a B
    expect(highMidi).toBe(95); // B6 — full octave block above the C6 note
  });
  it('always includes the highest note', () => {
    const { lowMidi, highMidi } = keyboardRange([48, 84]);
    expect(lowMidi).toBeLessThanOrEqual(48);
    expect(highMidi).toBeGreaterThanOrEqual(84);
  });
  it('defaults to a C4-centered window with no notes', () => {
    const { lowMidi, highMidi } = keyboardRange([]);
    expect(lowMidi).toBe(60);
    expect(highMidi - lowMidi + 1).toBe(24);
  });
});

describe('buildKeyboardLayout', () => {
  it('tiles white keys edge-to-edge across the width', () => {
    const { keys, whiteWidth } = buildKeyboardLayout({ lowMidi: 60, highMidi: 71, width: 700 });
    const whites = keys.filter((k) => !k.isBlack);
    expect(whites).toHaveLength(7); // C D E F G A B
    expect(whiteWidth).toBeCloseTo(100, 6);
    expect(whites[0].x).toBe(0);
    expect(whites[6].x).toBeCloseTo(600, 6);
    // No gaps: each white starts where the previous ends.
    for (let i = 1; i < whites.length; i += 1) {
      expect(whites[i].x).toBeCloseTo(whites[i - 1].x + whiteWidth, 6);
    }
  });

  it('overlays black keys centered on the white-key boundary, narrower', () => {
    const { keys, whiteWidth, blackWidth } = buildKeyboardLayout({ lowMidi: 60, highMidi: 71, width: 700 });
    const blacks = keys.filter((k) => k.isBlack);
    expect(blacks).toHaveLength(5); // C# D# F# G# A#
    expect(blackWidth).toBeCloseTo(whiteWidth * BLACK_KEY_RATIO, 6);
    // C#(61) sits on the boundary between C(0) and D(1): center at 1·whiteWidth.
    const cSharp = blacks.find((k) => k.midi === 61);
    expect(cSharp.x + cSharp.w / 2).toBeCloseTo(whiteWidth, 6);
  });

  it('orders white keys before black keys for draw order', () => {
    const { keys } = buildKeyboardLayout({ lowMidi: 60, highMidi: 71, width: 700 });
    const firstBlack = keys.findIndex((k) => k.isBlack);
    const lastWhite = keys.map((k) => k.isBlack).lastIndexOf(false);
    expect(lastWhite).toBeLessThan(firstBlack);
  });
});
