import { describe, it, expect } from 'vitest';
import {
  parseScore,
  parsePitch,
  diatonicStep,
  durationBeats,
  keySignature,
  scoreHasMusic,
  DURATIONS,
} from './scoreNotation.js';

describe('diatonicStep', () => {
  it('places C4 at step 0 and counts up by letter', () => {
    expect(diatonicStep('C', 4)).toBe(0);
    expect(diatonicStep('D', 4)).toBe(1);
    expect(diatonicStep('B', 4)).toBe(6);
    expect(diatonicStep('C', 5)).toBe(7);
    expect(diatonicStep('E', 4)).toBe(2); // treble bottom line
  });
  it('goes negative below middle C', () => {
    expect(diatonicStep('G', 2)).toBe(-10); // bass bottom line
  });
  it('returns null for garbage', () => {
    expect(diatonicStep('H', 4)).toBeNull();
    expect(diatonicStep('C', NaN)).toBeNull();
  });
});

describe('parsePitch', () => {
  it('parses letter, accidental and octave', () => {
    expect(parsePitch('F#4')).toEqual({ letter: 'F', accidental: '#', octave: 4, step: 3 });
    expect(parsePitch('Bb3')).toEqual({ letter: 'B', accidental: 'b', octave: 3, step: -1 });
    expect(parsePitch('c4')).toMatchObject({ letter: 'C', octave: 4 });
  });
  it('rejects non-pitches', () => {
    expect(parsePitch('r')).toBeNull();
    expect(parsePitch('X9')).toBeNull();
    expect(parsePitch('')).toBeNull();
  });
});

describe('durationBeats', () => {
  it('maps undotted codes to quarter-note beats', () => {
    expect(durationBeats('w')).toBe(4);
    expect(durationBeats('h')).toBe(2);
    expect(durationBeats('q')).toBe(1);
    expect(durationBeats('e')).toBe(0.5);
  });
  it('applies dots as the geometric series', () => {
    expect(durationBeats('q', 1)).toBe(1.5);
    expect(durationBeats('h', 1)).toBe(3);
    expect(durationBeats('q', 2)).toBe(1.75);
  });
  it('returns 0 for an unknown code', () => {
    expect(durationBeats('z')).toBe(0);
  });
  it('every DURATIONS entry is internally consistent', () => {
    for (const [code, d] of Object.entries(DURATIONS)) {
      expect(d.code).toBe(code);
      expect(typeof d.beats).toBe('number');
      expect(typeof d.filled).toBe('boolean');
    }
  });
});

describe('keySignature', () => {
  it('returns no accidentals for C', () => {
    expect(keySignature('C major')).toEqual({ type: 'none', count: 0, letters: [] });
  });
  it('reads sharp keys and orders them', () => {
    expect(keySignature('G')).toMatchObject({ type: 'sharp', count: 1, letters: ['F'] });
    expect(keySignature('D major')).toMatchObject({ type: 'sharp', count: 2, letters: ['F', 'C'] });
  });
  it('reads flat keys', () => {
    expect(keySignature('F')).toMatchObject({ type: 'flat', count: 1, letters: ['B'] });
    // Eb minor's relative major is Gb (6 flats), not Eb major (3 flats) —
    // regression check for treating a minor tonic as if it were major.
    expect(keySignature('Eb minor')).toMatchObject({ type: 'flat', count: 6 });
  });
  it('falls back to C for unknown input', () => {
    expect(keySignature('nonsense')).toMatchObject({ type: 'none', count: 0 });
  });
  it('resolves a minor key to its relative major signature', () => {
    expect(keySignature('D minor')).toMatchObject({ type: 'flat', count: 1, letters: ['B'] });
    expect(keySignature('Em')).toMatchObject({ type: 'sharp', count: 1, letters: ['F'] });
    expect(keySignature('F# minor')).toMatchObject({ type: 'sharp', count: 3, letters: ['F', 'C', 'G'] });
    expect(keySignature('Bbm')).toMatchObject({ type: 'flat', count: 5, letters: ['B', 'E', 'A', 'D', 'G'] });
    expect(keySignature('D min')).toMatchObject({ type: 'flat', count: 1 });
  });
  it('major behavior is unchanged, and "major"/"maj" never misparse as minor', () => {
    expect(keySignature('D')).toMatchObject({ type: 'sharp', count: 2 });
    expect(keySignature('D major')).toMatchObject({ type: 'sharp', count: 2 });
    expect(keySignature('Dmaj')).toMatchObject({ type: 'sharp', count: 2 });
  });
});

describe('parseScore', () => {
  it('reads headers with sensible defaults', () => {
    const s = parseScore('clef: treble\nkey: C\ntime: 4/4\ntempo: 68\n\n| C4q |');
    expect(s.clef).toBe('treble');
    expect(s.time).toEqual({ beats: 4, beatValue: 4 });
    expect(s.tempo).toBe(68);
    expect(s.keySig.count).toBe(0);
  });

  it('defaults headers when absent', () => {
    const s = parseScore('| C4q |');
    expect(s.clef).toBe('treble');
    expect(s.time).toEqual({ beats: 4, beatValue: 4 });
    expect(s.tempo).toBeNull();
  });

  it('parses notes with chord and lyric', () => {
    const s = parseScore('| [C] E4q(If) G4q(you) |');
    expect(s.measures).toHaveLength(1);
    const [a, b] = s.measures[0].notes;
    expect(a).toMatchObject({ rest: false, chord: 'C', lyric: 'If', step: 2 });
    expect(a.duration).toMatchObject({ code: 'q', beats: 1, dots: 0 });
    expect(b).toMatchObject({ chord: '', lyric: 'you', step: 4 });
  });

  it('carries the renderer-facing duration props (filled / stem / flags)', () => {
    const s = parseScore('| C4q C4h C4w C4e |');
    const [q, h, w, e] = s.measures[0].notes.map((n) => n.duration);
    expect(q).toMatchObject({ filled: true, stem: true, flags: 0 });   // solid head + stem
    expect(h).toMatchObject({ filled: false, stem: true, flags: 0 });  // open head + stem
    expect(w).toMatchObject({ filled: false, stem: false, flags: 0 }); // open head, no stem
    expect(e).toMatchObject({ filled: true, stem: true, flags: 1 });   // one flag
  });

  it('parses rests (no pitch / lyric)', () => {
    const s = parseScore('| C4q rq rh |');
    const notes = s.measures[0].notes;
    expect(notes[1]).toMatchObject({ rest: true });
    expect(notes[1].duration).toMatchObject({ code: 'q', beats: 1 });
    expect(notes[2].duration.beats).toBe(2);
  });

  it('parses dotted and accidental notes', () => {
    const s = parseScore('| F#4q. Bb3e |');
    const [a, b] = s.measures[0].notes;
    expect(a.pitch.accidental).toBe('#');
    expect(a.duration.beats).toBe(1.5);
    expect(b.pitch).toMatchObject({ letter: 'B', accidental: 'b', octave: 3 });
  });

  it('splits multiple measures and sums beats', () => {
    const s = parseScore('| C4h C4h | C4w |');
    expect(s.measures).toHaveLength(2);
    expect(s.measures[0].beats).toBe(4);
    expect(s.measures[1].beats).toBe(4);
  });

  it('collects errors for bad tokens but keeps the good ones', () => {
    const s = parseScore('| C4q zzz G4q |');
    expect(s.measures[0].notes).toHaveLength(2);
    expect(s.errors.length).toBe(1);
    expect(s.errors[0]).toMatch(/measure 1/);
  });

  it('flags a bad time signature', () => {
    const s = parseScore('time: 4/x\n| C4q |');
    expect(s.errors.some((e) => /time signature/.test(e))).toBe(true);
  });

  it('handles a bass clef header', () => {
    const s = parseScore('clef: bass\n| C3q |');
    expect(s.clef).toBe('bass');
  });

  it('never throws on empty / garbage input', () => {
    expect(parseScore('').measures).toEqual([]);
    expect(parseScore(null).measures).toEqual([]);
    expect(parseScore('just some prose').measures.every((m) => m.notes.length === 0)).toBe(true);
  });

  it('parses the shipped 500 Miles verse into four 4-beat bars', () => {
    const score = [
      'clef: treble', 'key: C', 'time: 4/4', 'tempo: 68', '',
      "| [C] E4q(If) G4q(you) G4q(miss) G4q(the) | [Am] A4h(train) G4q(I'm) E4q(on) |",
      '| [F] F4q(You) A4q(will) A4q(know) A4q(that) | [C] G4h(I) E4q(am) C4q(gone) |',
      '| [F] F4q(You) A4q(can) A4q(hear) A4q(the) | [C] G4q(whis-) E4q(tle) C4h(blow) |',
      '| [G] D4q(A) F4q(hun-) G4q(dred) rq | [C] C4w(miles) |',
    ].join('\n');
    const s = parseScore(score);
    expect(s.errors).toEqual([]);
    expect(s.measures).toHaveLength(8);
    for (const m of s.measures) expect(m.beats).toBeCloseTo(4, 5);
  });
});

describe('scoreHasMusic', () => {
  it('is true only when at least one note parses', () => {
    expect(scoreHasMusic('| C4q |')).toBe(true);
    expect(scoreHasMusic('clef: treble\n\n')).toBe(false);
    expect(scoreHasMusic('')).toBe(false);
  });
});
