import { describe, it, expect } from 'vitest';
import {
  detectFrequency,
  frequencyToNote,
  noteToFrequency,
  createPitchTracker,
} from './pitchDetect.js';

const SAMPLE_RATE = 44100;

// Fill a Float32 frame with a pure sine of `hz` at the given amplitude.
const sine = (hz, { sampleRate = SAMPLE_RATE, length = 4096, amplitude = 0.5 } = {}) => {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) buf[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return buf;
};

// Deterministic pseudo-random white noise (seeded LCG so the test never flakes).
const noise = ({ length = 4096, amplitude = 0.5, seed = 12345 } = {}) => {
  const buf = new Float32Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    buf[i] = ((s / 0xffffffff) * 2 - 1) * amplitude;
  }
  return buf;
};

describe('frequencyToNote', () => {
  it('maps concert pitches to the right letter + octave + step', () => {
    expect(frequencyToNote(440)).toMatchObject({ letter: 'A', accidental: '', octave: 4 });
    expect(frequencyToNote(261.63)).toMatchObject({ letter: 'C', octave: 4, step: 0 });
    expect(frequencyToNote(523.25)).toMatchObject({ letter: 'C', octave: 5, step: 7 });
    expect(frequencyToNote(130.81)).toMatchObject({ letter: 'C', octave: 3, step: -7 });
  });

  it('reports a sharp pitch class with a sharp accidental', () => {
    // F#4 ≈ 369.99 Hz
    expect(frequencyToNote(369.99)).toMatchObject({ letter: 'F', accidental: '#', octave: 4 });
  });

  it('aligns step with scoreNotation (A4 = step 5, treble top space)', () => {
    expect(frequencyToNote(440).step).toBe(5);
  });

  it('cents are zero at a note center and signed (sharp positive, flat negative)', () => {
    expect(frequencyToNote(440).cents).toBe(0);
    // 20 cents sharp of A4 → positive; 20 cents flat → negative.
    expect(frequencyToNote(440 * Math.pow(2, 20 / 1200)).cents).toBeGreaterThan(0);
    expect(frequencyToNote(440 * Math.pow(2, -20 / 1200)).cents).toBeLessThan(0);
    expect(Math.abs(frequencyToNote(450).cents)).toBeLessThanOrEqual(50);
  });

  it('honors a non-440 a4 reference', () => {
    expect(frequencyToNote(432, { a4: 432 })).toMatchObject({ letter: 'A', octave: 4, cents: 0 });
    // 440 read against a 432 reference is sharp of A4.
    expect(frequencyToNote(440, { a4: 432 })).toMatchObject({ letter: 'A', octave: 4 });
    expect(frequencyToNote(440, { a4: 432 }).cents).toBeGreaterThan(0);
  });

  it('returns null for non-positive / non-finite input', () => {
    expect(frequencyToNote(0)).toBeNull();
    expect(frequencyToNote(-100)).toBeNull();
    expect(frequencyToNote(NaN)).toBeNull();
  });
});

describe('noteToFrequency', () => {
  it('returns the standard frequency of common notes', () => {
    expect(noteToFrequency({ letter: 'A', accidental: '', octave: 4 })).toBeCloseTo(440, 5);
    expect(noteToFrequency({ letter: 'C', octave: 4 })).toBeCloseTo(261.6256, 2);
    expect(noteToFrequency({ letter: 'A', octave: 5 })).toBeCloseTo(880, 5);
  });

  it('applies accidentals', () => {
    expect(noteToFrequency({ letter: 'F', accidental: '#', octave: 4 })).toBeCloseTo(369.994, 2);
    expect(noteToFrequency({ letter: 'B', accidental: 'b', octave: 3 })).toBeCloseTo(233.082, 2);
  });

  it('honors a non-440 a4 reference', () => {
    expect(noteToFrequency({ letter: 'A', octave: 4 }, { a4: 432 })).toBeCloseTo(432, 5);
  });

  it('returns null for an unrecognizable note', () => {
    expect(noteToFrequency(null)).toBeNull();
    expect(noteToFrequency({ letter: 'H', octave: 4 })).toBeNull();
    expect(noteToFrequency({ letter: 'C' })).toBeNull();
  });

  it('round-trips through frequencyToNote within a cent of tolerance', () => {
    for (const hz of [261.63, 440, 587.33, 450, 333.2]) {
      const note = frequencyToNote(hz);
      // Reconstruct: note center × the detune the detector reported.
      const recon = noteToFrequency(note) * Math.pow(2, note.cents / 1200);
      expect(recon).toBeCloseTo(hz, 0); // within ~0.5 cent (cents are integer-rounded)
    }
  });
});

describe('detectFrequency', () => {
  it('recovers the fundamental of a pure sine across the vocal range', () => {
    for (const hz of [130.81, 261.63, 440, 587.33, 880]) {
      const res = detectFrequency(sine(hz), { sampleRate: SAMPLE_RATE });
      expect(res).not.toBeNull();
      expect(res.hz).toBeCloseTo(hz, 0); // within ~1 Hz
      expect(res.clarity).toBeGreaterThan(0.5);
    }
  });

  it('detected sine → correct note + octave', () => {
    const res = detectFrequency(sine(440), { sampleRate: SAMPLE_RATE });
    expect(frequencyToNote(res.hz)).toMatchObject({ letter: 'A', octave: 4 });
    const c4 = detectFrequency(sine(261.63), { sampleRate: SAMPLE_RATE });
    expect(frequencyToNote(c4.hz)).toMatchObject({ letter: 'C', octave: 4 });
  });

  it('cents sign survives detection (slightly sharp → positive, flat → negative)', () => {
    const sharp = detectFrequency(sine(440 * Math.pow(2, 30 / 1200)), { sampleRate: SAMPLE_RATE });
    const flat = detectFrequency(sine(440 * Math.pow(2, -30 / 1200)), { sampleRate: SAMPLE_RATE });
    expect(frequencyToNote(sharp.hz)).toMatchObject({ letter: 'A', octave: 4 });
    expect(frequencyToNote(sharp.hz).cents).toBeGreaterThan(0);
    expect(frequencyToNote(flat.hz).cents).toBeLessThan(0);
  });

  it('returns null for silence', () => {
    expect(detectFrequency(new Float32Array(4096), { sampleRate: SAMPLE_RATE })).toBeNull();
  });

  it('returns null for white noise (clarity gate)', () => {
    expect(detectFrequency(noise(), { sampleRate: SAMPLE_RATE })).toBeNull();
  });

  it('returns null for an empty / tiny frame', () => {
    expect(detectFrequency(new Float32Array(0))).toBeNull();
    expect(detectFrequency(new Float32Array(1))).toBeNull();
  });
});

describe('createPitchTracker', () => {
  // Minimal fake AnalyserNode: fills the frame with a fixed sine each pull.
  const fakeAnalyser = (hz) => ({
    fftSize: 4096,
    context: { sampleRate: SAMPLE_RATE },
    getFloatTimeDomainData: (out) => {
      for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    },
  });

  it('emits a smoothed note for a steady tone and stops cleanly', async () => {
    const updates = [];
    const tracker = createPitchTracker(fakeAnalyser(440), {
      intervalMs: 1, // drive off a timer so the test doesn't depend on rAF
      onUpdate: (u) => updates.push(u),
    });
    await new Promise((r) => setTimeout(r, 50));
    tracker.stop();
    const before = updates.length;
    expect(before).toBeGreaterThan(0);
    const last = updates[updates.length - 1];
    expect(last.note).toMatchObject({ letter: 'A', octave: 4 });
    expect(last.clarity).toBeGreaterThan(0.5);
    // No further callbacks after stop().
    await new Promise((r) => setTimeout(r, 20));
    expect(updates.length).toBe(before);
  });

  it('emits nulls when the frame is silent', async () => {
    const silent = {
      fftSize: 2048,
      context: { sampleRate: SAMPLE_RATE },
      getFloatTimeDomainData: (out) => out.fill(0),
    };
    const updates = [];
    const tracker = createPitchTracker(silent, { intervalMs: 1, onUpdate: (u) => updates.push(u) });
    await new Promise((r) => setTimeout(r, 30));
    tracker.stop();
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toMatchObject({ hz: null, note: null });
  });
});
