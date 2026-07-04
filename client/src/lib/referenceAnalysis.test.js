import { describe, it, expect } from 'vitest';
import {
  extractPitchTrack,
  proposeSegmentScore,
  buildScoreText,
  barPitchClasses,
  diffScoreBars,
  REFERENCE_CLARITY_THRESHOLD,
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
