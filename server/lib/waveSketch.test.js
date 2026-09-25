import { describe, expect, it } from 'vitest';
import {
  WAVE_SKETCH_LIMITS, WAVE_SKETCH_SAMPLE_RATE, normalizeWaveSketch, pcmPeaks, synthesizeWaveSketch,
} from './waveSketch.js';

// One drawn sine cycle — 16 points, the example the LLM prompt teaches.
const SINE = [0, 0.38, 0.71, 0.92, 1, 0.92, 0.71, 0.38, 0, -0.38, -0.71, -0.92, -1, -0.92, -0.71, -0.38];

const sketchOf = (voices, extra = {}) => ({ version: 1, durationSec: 2, shapes: { sine: SINE }, voices, ...extra });

// Rising zero crossings per second ≈ the fundamental of a periodic signal.
const risingCrossings = (pcm, from, to) => {
  let count = 0;
  for (let i = from + 1; i < to; i += 1) if (pcm[i - 1] < 0 && pcm[i] >= 0) count += 1;
  return count;
};

describe('normalizeWaveSketch', () => {
  it('returns null when nothing playable survives', () => {
    expect(normalizeWaveSketch(null)).toBeNull();
    expect(normalizeWaveSketch([])).toBeNull();
    expect(normalizeWaveSketch({ shapes: { sine: SINE }, voices: [] })).toBeNull();
    // A voice naming an undeclared shape, and a tonal note without a pitch.
    expect(normalizeWaveSketch(sketchOf([{ shape: 'nope', notes: [{ t: 0, d: 1, pitch: 'A4' }] }]))).toBeNull();
    expect(normalizeWaveSketch(sketchOf([{ shape: 'sine', notes: [{ t: 0, d: 1, pitch: 'kick' }] }]))).toBeNull();
  });

  it('resolves pitches, clamps values, and clips strokes to the piece', () => {
    const sketch = normalizeWaveSketch(sketchOf([{
      shape: 'sine',
      gain: 3,
      notes: [
        { t: 1.5, d: 5, pitch: 'A4', glideTo: 'A5', v: -1, env: [0, 2, 0.5] },
        { t: 0, d: 0.5, hz: 99999 },
      ],
    }], { shapes: { sine: [...SINE.slice(0, -1), 7] } }));

    expect(sketch.shapes.sine.at(-1)).toBe(1);
    const [voice] = sketch.voices;
    expect(voice).toMatchObject({ name: 'voice1', gain: 1 });
    // Sorted by onset; the overlong stroke is clipped at durationSec.
    expect(voice.notes[0]).toEqual({ t: 0, d: 0.5, hz: WAVE_SKETCH_LIMITS.HZ_MAX, v: 0.8 });
    expect(voice.notes[1]).toEqual({ t: 1.5, d: 0.5, hz: 440, pitch: 'A4', toHz: 880, v: 0, env: [0, 1, 0.5] });
  });

  it('lets noise strokes skip a pitch and keeps morph targets only on tonal voices', () => {
    const sketch = normalizeWaveSketch(sketchOf([
      { shape: 'noise', notes: [{ t: 0, d: 0.1 }, { t: 0.5, d: 0.05, hz: 12000, morphTo: 'saw' }] },
      { shape: 'sine', notes: [{ t: 0, d: 1, pitch: 'C4', morphTo: 'saw' }, { t: 1, d: 1, pitch: 'C4', morphTo: 'missing' }] },
    ], { shapes: { sine: SINE, saw: [-1, -0.5, 0, 0.5, 1], unused: [0, 1, 0, -1] } }));

    expect(sketch.voices[0].notes).toEqual([{ t: 0, d: 0.1, hz: null, v: 0.8 }, { t: 0.5, d: 0.05, hz: 12000, v: 0.8 }]);
    expect(sketch.voices[1].notes.map((n) => n.morphTo)).toEqual(['saw', undefined]);
    // A drawing nothing plays is dropped, so what is shown is what is heard.
    expect(Object.keys(sketch.shapes).sort()).toEqual(['saw', 'sine']);
  });

  it('derives the duration from the strokes when none is given', () => {
    const sketch = normalizeWaveSketch({ shapes: { sine: SINE }, voices: [{ shape: 'sine', notes: [{ t: 2, d: 1.5, pitch: 'E3' }] }] });
    expect(sketch.durationSec).toBe(3.5);
  });

  it('enforces the aggregate stroke caps', () => {
    const notes = Array.from({ length: WAVE_SKETCH_LIMITS.NOTES_PER_VOICE_MAX + 50 }, (_, i) => ({ t: i * 0.01, d: 0.01, pitch: 'A4' }));
    const sketch = normalizeWaveSketch(sketchOf([{ shape: 'sine', notes }], { durationSec: 60 }));
    expect(sketch.voices[0].notes).toHaveLength(WAVE_SKETCH_LIMITS.NOTES_PER_VOICE_MAX);

    // Voiced seconds: 8 voices × 60s fills the budget; a 9th voice (over the
    // voice cap anyway) and further full-length notes are refused.
    const full = Array.from({ length: 12 }, () => ({ shape: 'sine', notes: [{ t: 0, d: 60, pitch: 'A2' }, { t: 0, d: 60, pitch: 'A3' }] }));
    const capped = normalizeWaveSketch(sketchOf(full, { durationSec: 60 }));
    const voiced = capped.voices.flatMap((v) => v.notes).reduce((sum, n) => sum + n.d, 0);
    expect(capped.voices.length).toBeLessThanOrEqual(WAVE_SKETCH_LIMITS.VOICES_MAX);
    expect(voiced).toBeLessThanOrEqual(WAVE_SKETCH_LIMITS.NOTE_SECONDS_MAX);
  });

  it('bounds its work by the caps, not by the size of an oversized input', () => {
    const huge = new Array(2_000_000).fill(0.5);
    const sketch = normalizeWaveSketch(sketchOf([{ shape: 'sine', notes: [{ t: 0, d: 1, pitch: 'A4', env: huge }] }], { shapes: { sine: huge } }));
    expect(sketch.shapes.sine).toHaveLength(WAVE_SKETCH_LIMITS.SHAPE_POINTS_MAX);
    expect(sketch.voices[0].notes[0].env).toHaveLength(WAVE_SKETCH_LIMITS.ENV_POINTS_MAX);
  });

  it('is idempotent, so a sketch round-trips through the client unchanged', () => {
    const once = normalizeWaveSketch(sketchOf([
      { name: 'lead', shape: 'sine', notes: [{ t: 0.1234567, d: 0.5, pitch: 'F#4', glideTo: 'B4', env: [0, 1, 0.3, 0] }] },
      { shape: 'noise', notes: [{ t: 1, d: 0.2 }] },
    ], { title: '  Glass Tide ', contour: [0.2, 1, 0.4] }));
    expect(once.title).toBe('Glass Tide');
    expect(normalizeWaveSketch(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe('synthesizeWaveSketch', () => {
  it('plays a drawn cycle at the requested pitch for the whole piece length', () => {
    const sketch = normalizeWaveSketch(sketchOf([{ shape: 'sine', notes: [{ t: 0, d: 1, pitch: 'A4' }] }]));
    const pcm = synthesizeWaveSketch(sketch);
    expect(pcm).toHaveLength(2 * WAVE_SKETCH_SAMPLE_RATE);
    // Mid-note second: ~440 cycles. Second half is silent (the note ended).
    expect(risingCrossings(pcm, 0, WAVE_SKETCH_SAMPLE_RATE)).toBeGreaterThanOrEqual(438);
    expect(risingCrossings(pcm, 0, WAVE_SKETCH_SAMPLE_RATE)).toBeLessThanOrEqual(441);
    expect(Math.max(...pcm.subarray(WAVE_SKETCH_SAMPLE_RATE + 10).map(Math.abs))).toBe(0);
  });

  it('glides exponentially from pitch to glideTo', () => {
    const sketch = normalizeWaveSketch(sketchOf([{ shape: 'sine', notes: [{ t: 0, d: 2, hz: 200, glideTo: 800 }] }]));
    const pcm = synthesizeWaveSketch(sketch);
    const quarter = WAVE_SKETCH_SAMPLE_RATE / 4;
    // First and last quarter-second windows centre on ~224 Hz and ~713 Hz.
    expect(risingCrossings(pcm, 0, quarter) * 4).toBeLessThan(260);
    expect(risingCrossings(pcm, pcm.length - quarter, pcm.length) * 4).toBeGreaterThan(650);
  });

  it('is deterministic — noise included — so preview and saved take match', () => {
    const sketch = normalizeWaveSketch(sketchOf([
      { shape: 'noise', notes: [{ t: 0, d: 0.5 }, { t: 0.5, d: 0.5, hz: 3000 }] },
      { shape: 'sine', notes: [{ t: 0, d: 2, pitch: 'C3', env: [0, 1, 0] }] },
    ]));
    expect(synthesizeWaveSketch(sketch)).toEqual(synthesizeWaveSketch(sketch));
  });

  it('never clips a dense drawing and applies the drawn contour', () => {
    const loud = Array.from({ length: 8 }, () => ({ shape: 'sine', gain: 1, notes: [{ t: 0, d: 2, pitch: 'A3', v: 1 }] }));
    const pcm = synthesizeWaveSketch(normalizeWaveSketch(sketchOf(loud)));
    expect(Math.max(...pcm.map(Math.abs))).toBeLessThanOrEqual(0.98 + 1e-6);

    const faded = synthesizeWaveSketch(normalizeWaveSketch(sketchOf(loud.slice(0, 1), { contour: [1, 0] })));
    expect(Math.abs(faded.at(-1))).toBeLessThan(0.001);
  });
});

describe('drawing helpers', () => {
  it('pcmPeaks reduces a buffer to per-column [min, max]', () => {
    expect(pcmPeaks(Float32Array.from([0.5, -0.25, 0, 1]), 2)).toEqual([[-0.25, 0.5], [0, 1]]);
  });
});
