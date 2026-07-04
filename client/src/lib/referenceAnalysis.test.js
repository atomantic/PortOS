import { describe, it, expect } from 'vitest';
import {
  extractPitchTrack,
  proposeSegmentScore,
  buildScoreText,
  barPitchClasses,
  diffScoreBars,
  REFERENCE_CLARITY_THRESHOLD,
  magnitudeSpectrum,
  averageMagnitudeSpectrum,
  estimateSpectralF0,
  extractSpectralDiffTrack,
  proposeStackedSegmentScore,
  STACKED_CLARITY_THRESHOLD,
  DEFAULT_FFT_SIZE,
} from './referenceAnalysis.js';

// Synthesize a sine tone as Float32 PCM. Amplitude well above the detector's
// silence floor; a pure tone gives NSDF clarity ≈ 1.
const sine = (hz, seconds, sampleRate, amp = 0.5) => {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
};

// Concatenate Float32Arrays (tone + silence + tone fixtures).
const concat = (...parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

// A voice-like tone: a fundamental plus a couple of decaying harmonics, so the
// harmonic-sum estimator has a real overtone series to lock onto (a pure sine
// is the degenerate one-harmonic case).
const harmonic = (f0, seconds, sampleRate, amp = 0.5) => {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = amp * (
      Math.sin(2 * Math.PI * f0 * t)
      + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t)
      + 0.33 * Math.sin(2 * Math.PI * 3 * f0 * t)
    );
  }
  return out;
};

// Sample-wise sum of equal-length Float32Arrays (mixing stacked layers).
const mix = (...parts) => {
  const n = Math.min(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) for (const p of parts) out[i] += p[i];
  return out;
};

const SR = 16000; // the mic-capture rate; keeps the fixtures small

describe('extractPitchTrack', () => {
  it('detects a steady tone with high clarity and monotonic tMs', () => {
    const track = extractPitchTrack(sine(220, 1.0, SR), SR);
    expect(track.length).toBeGreaterThan(20);
    const pitched = track.filter((f) => f.hz != null);
    expect(pitched.length).toBeGreaterThan(track.length * 0.8);
    for (const f of pitched) {
      expect(f.hz).toBeGreaterThan(215);
      expect(f.hz).toBeLessThan(225);
      expect(f.clarity).toBeGreaterThan(0.9);
    }
    for (let i = 1; i < track.length; i++) expect(track[i].tMs).toBeGreaterThan(track[i - 1].tMs);
    expect(track[0].tMs).toBe(0);
  });

  it('reports silence as unpitched frames (hz null, clarity 0)', () => {
    const track = extractPitchTrack(new Float32Array(SR), SR); // 1 s of silence
    expect(track.length).toBeGreaterThan(0);
    expect(track.every((f) => f.hz === null && f.clarity === 0)).toBe(true);
  });

  it('slices by startMs/endMs with segment-relative timestamps', () => {
    // 0.5 s silence, then 0.5 s of A3 — extracting only the tone half.
    const samples = concat(new Float32Array(SR / 2), sine(220, 0.5, SR));
    const track = extractPitchTrack(samples, SR, { startMs: 500, endMs: 1000 });
    expect(track[0].tMs).toBe(0);
    const pitched = track.filter((f) => f.hz != null);
    expect(pitched.length).toBeGreaterThan(track.length * 0.7);
    expect(Math.abs(pitched[0].hz - 220)).toBeLessThan(5);
  });

  it('returns [] for empty input or a bad sample rate', () => {
    expect(extractPitchTrack(new Float32Array(0), SR)).toEqual([]);
    expect(extractPitchTrack(sine(220, 0.2, SR), 0)).toEqual([]);
    expect(extractPitchTrack(null, SR)).toEqual([]);
  });
});

describe('buildScoreText', () => {
  it('wraps a body with key/tempo headers and omits a 4/4 time line', () => {
    const text = buildScoreText({ key: 'G', tempo: 90, body: '| G4q A4q B4q G4q |' });
    expect(text).toContain('key: G');
    expect(text).toContain('tempo: 90');
    expect(text).not.toContain('time:');
    expect(text).toContain('| G4q A4q B4q G4q |');
  });

  it('emits a time header for non-4/4 and returns "" without a body', () => {
    expect(buildScoreText({ key: 'C', beatsPerBar: 3, beatValue: 4, body: '| C4h. |' })).toContain('time: 3/4');
    expect(buildScoreText({ key: 'C', tempo: 100 })).toBe('');
  });
});

describe('proposeSegmentScore', () => {
  it('transcribes a solo tone segment into a parseable score in the round key', () => {
    // 1 s of A3 at 60 BPM → one bar containing an A3 (a quarter at minimum).
    const { track, body, text } = proposeSegmentScore(sine(220, 1.0, SR), SR, {
      startMs: 0, endMs: 1000, bpm: 60, key: 'C',
    });
    expect(track.length).toBeGreaterThan(0);
    expect(body).toMatch(/A3/);
    expect(text).toContain('key: C');
    expect(text).toContain('tempo: 60');
  });

  it('produces an empty proposal from a silent segment', () => {
    const { body, text } = proposeSegmentScore(new Float32Array(SR), SR, { bpm: 90, key: 'C' });
    expect(body).toBe('');
    expect(text).toBe('');
  });

  it('defaults the clarity gate to the reference threshold', () => {
    expect(REFERENCE_CLARITY_THRESHOLD).toBeGreaterThan(0);
    expect(REFERENCE_CLARITY_THRESHOLD).toBeLessThan(1);
  });
});

describe('barPitchClasses / diffScoreBars', () => {
  it('collapses octaves and skips rests per bar', () => {
    const bars = barPitchClasses('| C4q E4q rq G5q | Bb3h rh |');
    expect(bars).toEqual([[0, 4, 7], [10]]);
  });

  it('flags matching and mismatching bars, octave-insensitively', () => {
    const proposed = '| C3q E3q G3q C4q | D3h A3h |';
    const existing = '| C4q E4q G4q C5q | D4h B4h |'; // bar 1 same classes, bar 2 differs
    const rows = diffScoreBars(proposed, existing);
    expect(rows).toHaveLength(2);
    expect(rows[0].match).toBe(true);
    expect(rows[1].match).toBe(false);
    expect(rows[1].proposed).toEqual([2, 9]);
    expect(rows[1].existing).toEqual([2, 11]);
  });

  it('marks bars missing on one side as non-matching', () => {
    const rows = diffScoreBars('| C4q |', '| C4q | G4q |');
    expect(rows).toHaveLength(2);
    expect(rows[0].match).toBe(true);
    expect(rows[1].match).toBe(false);
    expect(rows[1].proposed).toBeNull();
  });

  it('treats different note counts in a bar as a mismatch', () => {
    const rows = diffScoreBars('| C4q C4q |', '| C4q |');
    expect(rows[0].match).toBe(false);
  });
});

// === Stacked-mix spectral-diff extraction (#2121) =========================

describe('magnitudeSpectrum', () => {
  it('peaks at the bin of a pure tone and returns fftSize/2 bins', () => {
    // 500 Hz at 16 kHz, fftSize 2048 → bin 500·2048/16000 = 64.
    const mag = magnitudeSpectrum(sine(500, 1.0, SR), { fftSize: DEFAULT_FFT_SIZE });
    expect(mag).toHaveLength(DEFAULT_FFT_SIZE / 2);
    let argmax = 0;
    for (let b = 1; b < mag.length; b++) if (mag[b] > mag[argmax]) argmax = b;
    expect(Math.abs(argmax - 64)).toBeLessThanOrEqual(1);
  });

  it('returns null when the frame is shorter than the FFT size', () => {
    expect(magnitudeSpectrum(sine(220, 0.01, SR), { fftSize: DEFAULT_FFT_SIZE })).toBeNull();
  });
});

describe('averageMagnitudeSpectrum', () => {
  it('averages to fftSize/2 magnitude bins over a window', () => {
    const avg = averageMagnitudeSpectrum(harmonic(220, 1.0, SR), SR);
    expect(avg).toHaveLength(DEFAULT_FFT_SIZE / 2);
  });

  it('returns null for a window too short to hold one frame', () => {
    expect(averageMagnitudeSpectrum(sine(220, 0.02, SR), SR)).toBeNull();
    expect(averageMagnitudeSpectrum(new Float32Array(0), SR)).toBeNull();
  });
});

describe('estimateSpectralF0', () => {
  it('locks onto the fundamental of a harmonic tone (no octave error)', () => {
    const mag = magnitudeSpectrum(harmonic(220, 1.0, SR).subarray(0, DEFAULT_FFT_SIZE), { fftSize: DEFAULT_FFT_SIZE });
    const res = estimateSpectralF0(mag, SR, DEFAULT_FFT_SIZE);
    expect(res).not.toBeNull();
    expect(res.hz).toBeGreaterThan(212); // not 110 (octave-down)
    expect(res.hz).toBeLessThan(228);    // not 440 (octave-up)
    expect(res.clarity).toBeGreaterThan(0.5);
  });

  it('returns null for a flat/empty spectrum', () => {
    expect(estimateSpectralF0(new Float32Array(DEFAULT_FFT_SIZE / 2), SR, DEFAULT_FFT_SIZE)).toBeNull();
    expect(estimateSpectralF0(null, SR, DEFAULT_FFT_SIZE)).toBeNull();
  });
});

describe('extractSpectralDiffTrack', () => {
  it('recovers a new voice entering over a steady backing layer', () => {
    // [0, 0.8s]: C4 (262) alone. [0.8s, 1.8s]: C4 + a NEW A4 (440) on top.
    const backing = harmonic(262, 0.8, SR);
    const stacked = mix(harmonic(262, 1.0, SR), harmonic(440, 1.0, SR));
    const audio = concat(backing, stacked);
    const track = extractSpectralDiffTrack(audio, SR, {
      bgStartMs: 0, bgEndMs: 800, startMs: 800, endMs: 1800,
    });
    const pitched = track.filter((f) => f.hz != null).map((f) => f.hz).sort((a, b) => a - b);
    expect(pitched.length).toBeGreaterThan(5);
    const median = pitched[Math.floor(pitched.length / 2)];
    // Subtracting the backing profile leaves the new A4, not the C4 backing.
    expect(median).toBeGreaterThan(420);
    expect(median).toBeLessThan(460);
  });

  it('returns [] for empty input or a bad sample rate', () => {
    expect(extractSpectralDiffTrack(new Float32Array(0), SR, { startMs: 0, endMs: 100 })).toEqual([]);
    expect(extractSpectralDiffTrack(harmonic(220, 0.5, SR), 0, {})).toEqual([]);
  });

  it('degrades to plain spectral f0 (no subtraction) without a backing window', () => {
    const track = extractSpectralDiffTrack(harmonic(330, 1.0, SR), SR, { startMs: 0, endMs: 1000 });
    const pitched = track.filter((f) => f.hz != null);
    expect(pitched.length).toBeGreaterThan(5);
  });
});

describe('proposeStackedSegmentScore', () => {
  it('transcribes the extracted new voice into a parseable score', () => {
    const audio = concat(harmonic(262, 0.8, SR), mix(harmonic(262, 1.0, SR), harmonic(440, 1.0, SR)));
    const { track, body, text } = proposeStackedSegmentScore(audio, SR, {
      bgStartMs: 0, bgEndMs: 800, startMs: 800, endMs: 1800, bpm: 60, key: 'C',
    });
    expect(track.length).toBeGreaterThan(0);
    expect(body).toMatch(/A4/);
    expect(text).toContain('key: C');
    expect(text).toContain('tempo: 60');
  });

  it('exposes a stacked clarity gate in (0, 1)', () => {
    expect(STACKED_CLARITY_THRESHOLD).toBeGreaterThan(0);
    expect(STACKED_CLARITY_THRESHOLD).toBeLessThan(1);
  });
});
