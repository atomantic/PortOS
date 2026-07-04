import { describe, it, expect } from 'vitest';
import { parseScore, keySignature } from './scoreNotation.js';
import { noteToFrequency, frequencyToNote } from './pitchDetect.js';
import {
  segmentPitchTrack,
  quantizeSegments,
  segmentsToScoreDsl,
  transcribePitchTrack,
} from './singToScore.js';

// Synthesize a clear pitch track from a sequence of { note, durMs } where note
// is a lead-sheet pitch string ("E4") or null for a rest. Frames are emitted at
// `stepMs` with full clarity (1) for notes and 0 for rests, matching what the
// tracker pushes during capture.
const synth = (seq, { stepMs = 30, clarity = 1 } = {}) => {
  const track = [];
  let t = 0;
  for (const { note, durMs } of seq) {
    const hz = note ? noteToFrequency(parsePitchLike(note)) : 0;
    const n = Math.round(durMs / stepMs);
    for (let i = 0; i < n; i++) {
      track.push({ tMs: t, hz, clarity: note ? clarity : 0 });
      t += stepMs;
    }
  }
  // A trailing frame so the last run's end extends to a real timestamp.
  track.push({ tMs: t, hz: 0, clarity: 0 });
  return track;
};

// Minimal pitch parse for the synth helper (the lib under test owns the real one).
const parsePitchLike = (str) => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(str);
  return { letter: m[1], accidental: m[2] || '', octave: Number(m[3]) };
};

describe('segmentPitchTrack', () => {
  it('groups a held note into one segment with the median pitch', () => {
    const track = synth([{ note: 'A4', durMs: 600 }]);
    const segs = segmentPitchTrack(track);
    expect(segs).toHaveLength(1);
    expect(segs[0].rest).toBe(false);
    // Median Hz maps back to A4.
    const note = frequencyToNote(segs[0].hz);
    expect(note.letter).toBe('A');
    expect(note.octave).toBe(4);
  });

  it('splits on a pitch change into separate notes', () => {
    const track = synth([
      { note: 'C4', durMs: 400 },
      { note: 'G4', durMs: 400 },
    ]);
    const segs = segmentPitchTrack(track);
    const pitched = segs.filter((s) => !s.rest);
    expect(pitched).toHaveLength(2);
    expect(frequencyToNote(pitched[0].hz).letter).toBe('C');
    expect(frequencyToNote(pitched[1].hz).letter).toBe('G');
  });

  it('emits a rest where clarity drops', () => {
    const track = synth([
      { note: 'E4', durMs: 400 },
      { note: null, durMs: 400 },
      { note: 'E4', durMs: 400 },
    ]);
    const segs = segmentPitchTrack(track);
    expect(segs.map((s) => s.rest)).toEqual([false, true, false]);
  });

  it('drops a sub-threshold stray note (detection noise)', () => {
    const track = synth([
      { note: 'C4', durMs: 400 },
      { note: 'C5', durMs: 30 }, // one stray frame — below MIN_NOTE_MS
      { note: 'C4', durMs: 400 },
    ]);
    const segs = segmentPitchTrack(track);
    // The stray is dropped; the two C4 spans remain (a tiny gap may not become a rest).
    expect(segs.every((s) => s.rest || frequencyToNote(s.hz).letter === 'C')).toBe(true);
    expect(segs.filter((s) => !s.rest).length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty for too-short or absent tracks', () => {
    expect(segmentPitchTrack([])).toEqual([]);
    expect(segmentPitchTrack(null)).toEqual([]);
    expect(segmentPitchTrack([{ tMs: 0, hz: 440, clarity: 1 }])).toEqual([]);
  });
});

describe('quantizeSegments', () => {
  it('snaps a one-second note to a quarter at 60 BPM', () => {
    // 60 BPM → 1000 ms/beat. A 1000ms note is exactly a quarter (1 beat).
    const segs = [{ rest: false, hz: 440, startMs: 0, endMs: 1000 }];
    const q = quantizeSegments(segs, { bpm: 60 });
    expect(q).toHaveLength(1);
    expect(q[0].code).toBe('q');
    expect(q[0].beats).toBe(1);
  });

  it('snaps a half-beat note to an eighth', () => {
    const segs = [{ rest: false, hz: 440, startMs: 0, endMs: 500 }];
    const q = quantizeSegments(segs, { bpm: 60 });
    expect(q[0].code).toBe('e');
  });

  it('snaps a 2-beat note to a half and a 4-beat to a whole', () => {
    const half = quantizeSegments([{ rest: false, hz: 440, startMs: 0, endMs: 2000 }], { bpm: 60 });
    const whole = quantizeSegments([{ rest: false, hz: 440, startMs: 0, endMs: 4000 }], { bpm: 60 });
    expect(half[0].code).toBe('h');
    expect(whole[0].code).toBe('w');
  });

  it('rounds an imperfect human duration to the nearest grid value', () => {
    // 1100ms at 60 BPM = 1.1 beats → nearest is a quarter (1 beat), not a half.
    const q = quantizeSegments([{ rest: false, hz: 440, startMs: 0, endMs: 1100 }], { bpm: 60 });
    expect(q[0].code).toBe('q');
  });

  it('uses quarter-note BPM semantics (independent of time signature)', () => {
    // BPM is quarter-notes-per-minute (same as metronome/scorePlayback). At
    // 120 BPM a quarter is 500ms; a 250ms note is half that → an eighth.
    const q = quantizeSegments([{ rest: false, hz: 440, startMs: 0, endMs: 250 }], { bpm: 120 });
    expect(q[0].code).toBe('e');
    expect(q[0].beats).toBeCloseTo(0.5, 5);
  });

  it('drops zero/negative-length segments', () => {
    expect(quantizeSegments([{ rest: false, hz: 440, startMs: 100, endMs: 100 }], { bpm: 60 })).toEqual([]);
  });
});

describe('segmentsToScoreDsl', () => {
  it('emits a parseable measure body', () => {
    const quantized = [
      { rest: false, hz: noteToFrequency(parsePitchLike('C4')), code: 'q', dots: 0, beats: 1 },
      { rest: false, hz: noteToFrequency(parsePitchLike('D4')), code: 'q', dots: 0, beats: 1 },
      { rest: false, hz: noteToFrequency(parsePitchLike('E4')), code: 'q', dots: 0, beats: 1 },
      { rest: false, hz: noteToFrequency(parsePitchLike('F4')), code: 'q', dots: 0, beats: 1 },
    ];
    const dsl = segmentsToScoreDsl(quantized, { beatsPerBar: 4, beatValue: 4 });
    expect(dsl).toBe('| C4q D4q E4q F4q |');
    const parsed = parseScore(`time: 4/4\n${dsl}`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.measures).toHaveLength(1);
    expect(parsed.measures[0].notes).toHaveLength(4);
  });

  it('breaks notes into measures by the time signature', () => {
    const quantized = Array.from({ length: 6 }, () => ({
      rest: false, hz: noteToFrequency(parsePitchLike('C4')), code: 'q', dots: 0, beats: 1,
    }));
    const dsl = segmentsToScoreDsl(quantized, { beatsPerBar: 4, beatValue: 4 });
    const parsed = parseScore(`time: 4/4\n${dsl}`);
    // 6 quarters → a full 4-beat bar then a 2-beat partial bar.
    expect(parsed.measures).toHaveLength(2);
    expect(parsed.measures[0].notes).toHaveLength(4);
    expect(parsed.measures[1].notes).toHaveLength(2);
  });

  it('spells accidentals with flats in a flat key', () => {
    // A black key between A and B: sharp spelling A#, flat spelling Bb.
    const hz = noteToFrequency({ letter: 'A', accidental: '#', octave: 4 });
    const quantized = [{ rest: false, hz, code: 'q', dots: 0, beats: 1 }];
    const flat = segmentsToScoreDsl(quantized, { keySig: keySignature('Bb'), beatsPerBar: 4 });
    const sharp = segmentsToScoreDsl(quantized, { keySig: keySignature('C'), beatsPerBar: 4 });
    expect(flat).toContain('Bb4');
    expect(sharp).toContain('A#4');
  });

  it('spells accidentals with flats for a minor key (relative-major signature, not parallel major)', () => {
    // D minor's relative major is F (1 flat) — it should spell the flat side
    // (Bb) even though "D" alone (D major, 2 sharps) would spell the sharp
    // side (A#) for the same pitch.
    const hz = noteToFrequency({ letter: 'A', accidental: '#', octave: 4 });
    const quantized = [{ rest: false, hz, code: 'q', dots: 0, beats: 1 }];
    const minor = segmentsToScoreDsl(quantized, { keySig: keySignature('D minor'), beatsPerBar: 4 });
    expect(minor).toContain('Bb4');
  });

  it('renders an interior rest (and trims leading/trailing rests)', () => {
    const quantized = [
      { rest: true, code: 'q', dots: 0, beats: 1 }, // leading rest — trimmed
      { rest: false, hz: noteToFrequency(parsePitchLike('C4')), code: 'q', dots: 0, beats: 1 },
      { rest: true, code: 'h', dots: 0, beats: 2 }, // interior rest — kept
      { rest: false, hz: noteToFrequency(parsePitchLike('C4')), code: 'q', dots: 0, beats: 1 },
      { rest: true, code: 'q', dots: 0, beats: 1 }, // trailing rest — trimmed
    ];
    const dsl = segmentsToScoreDsl(quantized, { beatsPerBar: 4 });
    expect(dsl).toBe('| C4q rh C4q |');
    expect(parseScore(`time: 4/4\n${dsl}`).errors).toEqual([]);
  });

  it('returns empty string for no segments', () => {
    expect(segmentsToScoreDsl([])).toBe('');
    expect(segmentsToScoreDsl(null)).toBe('');
  });
});

describe('transcribePitchTrack (round-trip)', () => {
  it('transcribes a sung scale into notation that re-parses cleanly', () => {
    // Sing C-D-E-F-G as quarter notes at 60 BPM (1000ms each).
    const track = synth([
      { note: 'C4', durMs: 1000 },
      { note: 'D4', durMs: 1000 },
      { note: 'E4', durMs: 1000 },
      { note: 'F4', durMs: 1000 },
      { note: 'G4', durMs: 1000 },
    ]);
    const dsl = transcribePitchTrack(track, { bpm: 60, key: 'C', beatsPerBar: 4, beatValue: 4 });
    const parsed = parseScore(`clef: treble\nkey: C\ntime: 4/4\ntempo: 60\n${dsl}`);
    expect(parsed.errors).toEqual([]);
    const letters = parsed.measures.flatMap((m) => m.notes).filter((n) => !n.rest).map((n) => n.pitch.letter);
    expect(letters).toEqual(['C', 'D', 'E', 'F', 'G']);
    // All quarter notes.
    const codes = parsed.measures.flatMap((m) => m.notes).filter((n) => !n.rest).map((n) => n.duration.code);
    expect(codes.every((c) => c === 'q')).toBe(true);
  });

  it('returns empty string for an empty/silent track', () => {
    expect(transcribePitchTrack([], { bpm: 120 })).toBe('');
    expect(transcribePitchTrack(synth([{ note: null, durMs: 1000 }]), { bpm: 120 })).toBe('');
  });
});
