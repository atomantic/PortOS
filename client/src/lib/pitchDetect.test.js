import { describe, it, expect } from 'vitest';
import {
  detectFrequency,
  frequencyToNote,
  noteToFrequency,
  createPitchTracker,
  tuningQuality,
  IN_TUNE_CENTS,
  CLOSE_CENTS,
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

describe('tuningQuality', () => {
  it('returns the neutral bucket for a non-finite cents (no pitch)', () => {
    expect(tuningQuality(null)).toEqual({ level: 'none', label: '—' });
    expect(tuningQuality(NaN)).toEqual({ level: 'none', label: '—' });
    expect(tuningQuality(undefined)).toEqual({ level: 'none', label: '—' });
  });

  it('buckets dead-center and within the in-tune band as in-tune', () => {
    expect(tuningQuality(0).level).toBe('in-tune');
    expect(tuningQuality(IN_TUNE_CENTS).level).toBe('in-tune');
    expect(tuningQuality(-IN_TUNE_CENTS).level).toBe('in-tune');
  });

  it('buckets just past the in-tune band as close, with a direction label', () => {
    expect(tuningQuality(IN_TUNE_CENTS + 1).level).toBe('close');
    expect(tuningQuality(IN_TUNE_CENTS + 1).label).toMatch(/sharp/i);
    expect(tuningQuality(-(IN_TUNE_CENTS + 1)).label).toMatch(/flat/i);
    expect(tuningQuality(CLOSE_CENTS).level).toBe('close');
  });

  it('buckets beyond the close band as off, with a direction label', () => {
    expect(tuningQuality(CLOSE_CENTS + 1).level).toBe('off');
    expect(tuningQuality(CLOSE_CENTS + 1).label).toBe('Sharp');
    expect(tuningQuality(-(CLOSE_CENTS + 1)).level).toBe('off');
    expect(tuningQuality(-(CLOSE_CENTS + 1)).label).toBe('Flat');
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

describe('createPitchTracker — hysteresis, hold, and sticky label', () => {
  // Frame fillers for a scripted analyser: each produces a specific signal so we
  // can drive clarity and pitch frame-by-frame. With the emit throttle OFF (the
  // default), the tracker emits exactly one update per tick and consumes exactly
  // one filler per tick — so `updates[k]` corresponds to `fillers[k]`, giving a
  // deterministic sequence regardless of wall-clock timing.
  const fillSine = (hz, amplitude = 0.5) => (out) => {
    for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  };
  const fillSilence = () => (out) => out.fill(0);
  // A sine buried in seeded noise — clarity ≈ 0.81 at noiseAmp 0.3 (measured):
  // above holdClarity (0.6) but below acquireClarity (0.9), i.e. a "hold-band"
  // frame. Deterministic (fixed seed) so it never flakes.
  const fillMix = (hz, noiseAmp = 0.3, seed = 999) => (out) => {
    let s = seed >>> 0;
    for (let i = 0; i < out.length; i++) {
      s = (1664525 * s + 1013904223) >>> 0;
      out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) + ((s / 0xffffffff) * 2 - 1) * noiseAmp;
    }
  };

  // Analyser that plays a scripted list of frame fillers in order, repeating the
  // LAST one once the script is exhausted (so the loop keeps running in a stable
  // terminal state while we wait for enough ticks to fire).
  const scriptedAnalyser = (fillers, { fftSize = 4096 } = {}) => {
    let i = 0;
    return {
      fftSize,
      context: { sampleRate: SAMPLE_RATE },
      getFloatTimeDomainData: (out) => {
        fillers[Math.min(i, fillers.length - 1)](out);
        i += 1;
      },
    };
  };

  // Concert frequencies used below.
  const A4 = 440;
  const AS4 = 440 * Math.pow(2, 1 / 12);        // A♯4, a clean semitone up
  const A4_PLUS_55 = 440 * Math.pow(2, 55 / 1200); // +55¢ of A4 (inside the sticky band)

  const runScript = async (fillers, opts, ms = 90) => {
    const updates = [];
    const tracker = createPitchTracker(scriptedAnalyser(fillers), {
      intervalMs: 1,
      onUpdate: (u) => updates.push(u),
      ...opts,
    });
    await new Promise((r) => setTimeout(r, ms));
    tracker.stop();
    return updates;
  };

  it('a single interleaved unclear frame is HELD, not nulled — the smoother survives it', async () => {
    // Acquire + settle on A4 (6 clear frames), one dropout frame, then A4 again.
    const script = [...Array(6).fill(fillSine(A4)), fillSilence(), ...Array(6).fill(fillSine(A4))];
    const updates = await runScript(script, { releaseFrames: 3 });
    // The display never blanked: every frame kept a note.
    expect(updates.every((u) => u.note !== null)).toBe(true);
    // The dropout frame was emitted as a HELD reading on the same note.
    const held = updates.filter((u) => u.held);
    expect(held.length).toBeGreaterThanOrEqual(1);
    expect(held.every((u) => u.note?.letter === 'A' && u.note?.octave === 4)).toBe(true);
  });

  it('hold-band frames update an acquired pitch but never acquire from silence', async () => {
    // From silence: a run of hold-band frames (clarity ~0.81 < acquire 0.9) must
    // NOT acquire — the readout stays blank.
    const fromSilence = await runScript(Array(12).fill(fillMix(A4)), {});
    expect(fromSilence.length).toBeGreaterThan(0);
    expect(fromSilence.every((u) => u.note === null)).toBe(true);

    // Once acquired on clear frames, a hold-band frame keeps updating (it is
    // clear-enough to HOLD, so it is emitted live — not as a held/coasting frame).
    const afterAcquire = await runScript(
      [...Array(6).fill(fillSine(A4)), ...Array(6).fill(fillMix(A4))],
      {},
    );
    const holdBandLive = afterAcquire.filter(
      (u) => u.note?.letter === 'A' && !u.held && u.clarity >= 0.6 && u.clarity < 0.9,
    );
    expect(holdBandLive.length).toBeGreaterThanOrEqual(1);
  });

  it('emits nulls only after the release window of consecutive unclear frames', async () => {
    const RELEASE = 4;
    const script = [...Array(6).fill(fillSine(A4)), ...Array(20).fill(fillSilence())];
    const updates = await runScript(script, { releaseFrames: RELEASE });
    const firstNull = updates.findIndex((u) => u.note === null);
    // A null eventually arrives, but only after acquisition + the release window.
    expect(firstNull).toBeGreaterThanOrEqual(6 + RELEASE);
    // The RELEASE frames just before the first null are all HELD on A4…
    const window = updates.slice(firstNull - RELEASE, firstNull);
    expect(window.length).toBe(RELEASE);
    expect(window.every((u) => u.held && u.note?.letter === 'A')).toBe(true);
    // …and the frame before the window was a live (non-held) A4 reading.
    expect(updates[firstNull - RELEASE - 1]).toMatchObject({ held: false });
    expect(updates[firstNull - RELEASE - 1].note?.letter).toBe('A');
  });

  it('keeps one sticky label while the pitch wanders ±55¢, reporting cents past ±50', async () => {
    // Settle on A4, then sustain +55¢ — inside the ±60¢ sticky band, so the label
    // must stay A4 while cents (relative to the held note) climb past +50.
    const script = [...Array(6).fill(fillSine(A4)), ...Array(12).fill(fillSine(A4_PLUS_55))];
    const updates = await runScript(script, {});
    const voiced = updates.filter((u) => u.note !== null);
    expect(voiced.length).toBeGreaterThan(0);
    expect(voiced.every((u) => u.note.letter === 'A' && u.note.accidental === '' && u.note.octave === 4)).toBe(true);
    // Cents are relative to the HELD note, so they exceed the ±50 semitone edge.
    expect(voiced.some((u) => u.cents > 50)).toBe(true);
  });

  it('switches the label within a few frames on a clean semitone step', async () => {
    // Settle on A4, then step cleanly up to A♯4 (+100¢) — well past the sticky
    // band, so the label re-derives.
    const ACQUIRE = 6;
    const script = [...Array(ACQUIRE).fill(fillSine(A4)), ...Array(20).fill(fillSine(AS4))];
    const updates = await runScript(script, {}, 120);
    // The final voiced reading is A♯4.
    const voiced = updates.filter((u) => u.note !== null);
    const last = voiced[voiced.length - 1];
    expect(last.note).toMatchObject({ letter: 'A', accidental: '#', octave: 4 });
    // …and it switched promptly — within a few frames of the step, not stuck on A4.
    const firstSharp = updates.findIndex((u) => u.note?.accidental === '#');
    expect(firstSharp).toBeGreaterThanOrEqual(ACQUIRE);
    expect(firstSharp - ACQUIRE).toBeLessThanOrEqual(12);
  });

  it('throttles emits to ~updateHz for a steady tone (vs every frame unthrottled)', async () => {
    const steady = () => ({
      fftSize: 4096,
      context: { sampleRate: SAMPLE_RATE },
      getFloatTimeDomainData: (out) => { for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * A4 * i) / SAMPLE_RATE); },
    });
    const unthrottled = [];
    const throttled = [];
    const t1 = createPitchTracker(steady(), { intervalMs: 1, onUpdate: (u) => unthrottled.push(u) });
    const t2 = createPitchTracker(steady(), { intervalMs: 1, updateHz: 12, onUpdate: (u) => throttled.push(u) });
    await new Promise((r) => setTimeout(r, 120));
    t1.stop();
    t2.stop();
    // A steady note has no material change after acquisition, so the throttle caps
    // the ~12Hz stream far below the per-frame (~1kHz here) unthrottled stream.
    expect(throttled.length).toBeGreaterThanOrEqual(1);
    expect(unthrottled.length).toBeGreaterThan(throttled.length);
    expect(throttled.length).toBeLessThanOrEqual(6);
  });
});
