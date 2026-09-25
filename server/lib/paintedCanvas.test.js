import { describe, expect, it } from 'vitest';
import {
  PAINTED_CANVAS_LIMITS, PAINTED_CANVAS_SAMPLE_RATE, normalizePaintedCanvas, paintedCanvasStats, synthesizePaintedCanvas,
} from './paintedCanvas.js';
import { normalizeWaveSketch, synthesizeSketchChannels } from './waveSketch.js';
import { PORTOS_SCHEMA_VERSIONS, compareSchemaVersions } from './schemaVersions.js';

const L = PAINTED_CANVAS_LIMITS;
const SR = PAINTED_CANVAS_SAMPLE_RATE;

const canvasOf = (strokes, extra = {}) => ({ version: 2, durationSec: 2, strokes, ...extra });
const tone = (hz, { from = 0, to = 1, a = 0.8, ...rest } = {}) => ({ path: [{ t: from, hz, a }, { t: to, hz, a }], ...rest });

// Energy of one frequency in a window (Goertzel), normalized per sample.
const levelAt = (pcm, hz, from, to) => {
  const w = (2 * Math.PI * hz) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i += 1) {
    const s0 = pcm[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (to - from);
};

describe('normalizePaintedCanvas', () => {
  it('canonicalizes a painting and round-trips it idempotently (including through JSON)', () => {
    const raw = canvasOf([
      { name: '  breath  ', width: 900, pan: -2, overtones: [0.5], path: [{ t: 0.5, hz: 3000, a: 0.3 }, { t: 1.5, hz: 2500, a: 2 }] },
      {
        name: 'line',
        pan: 0.25,
        overtones: [0.5, 0.25, 0, 0],
        path: [
          { t: 0, hz: 220, a: 0.5 },
          { t: 0.4, hz: 220, a: 0.6, overtones: [0, 0.8, 7] },
          { t: 0.4, hz: 400, a: 1 }, // same instant — dropped
          { t: 1, hz: 'loud', a: 1 }, // no pitch — dropped
          { t: 1.2, hz: 99999, a: 0.2 },
        ],
      },
      { path: [{ t: 0, hz: 440, a: 1 }] }, // one keyframe cannot sound
    ], { title: '  Tide  ', bpm: 92.123, beatsPerBar: 3.4, sections: [{ start: 0, end: 1, name: 'a' }, { start: 0.5, end: 2 }, { start: 1, end: 2 }] });

    const canvas = normalizePaintedCanvas(raw);
    expect(canvas).toEqual({
      version: 2,
      title: 'Tide',
      durationSec: 2,
      bpm: 92.12,
      beatsPerBar: 3,
      // The overlapping section is dropped.
      sections: [{ start: 0, end: 1, name: 'a' }, { start: 1, end: 2 }],
      strokes: [
        {
          name: 'line',
          pan: 0.25,
          overtones: [0.5, 0.25],
          path: [{ t: 0, hz: 220, a: 0.5 }, { t: 0.4, hz: 220, a: 0.6, overtones: [0, 0.8, 1] }, { t: 1.2, hz: L.HZ_MAX, a: 0.2 }],
        },
        // A noise stroke keeps no overtones; pan and level are clamped.
        { name: 'breath', pan: -1, width: 900, path: [{ t: 0.5, hz: 3000, a: 0.3 }, { t: 1.5, hz: 2500, a: 1 }] },
      ],
    });
    expect(normalizePaintedCanvas(canvas)).toEqual(canvas);
    expect(normalizePaintedCanvas(JSON.parse(JSON.stringify(canvas)))).toEqual(canvas);
    // The version-dispatching entry point used by tracks and the client agrees.
    expect(normalizeWaveSketch(JSON.parse(JSON.stringify(canvas)))).toEqual(canvas);
  });

  it('returns null when no stroke survives', () => {
    expect(normalizePaintedCanvas(null)).toBeNull();
    expect(normalizePaintedCanvas(canvasOf([]))).toBeNull();
    expect(normalizePaintedCanvas(canvasOf([{ path: [{ t: 0, hz: 5, a: 1 }, { t: 1, hz: 10, a: 1 }] }]))).toBeNull();
  });

  it('drops strokes past the render-work budget, in reply order, and bounds its own scan', () => {
    // Each stroke: 100 s × 17 partials = 1700 partial-seconds.
    const heavy = Array.from({ length: 30 }, (_, i) => ({
      name: `s${i}`, overtones: Array(16).fill(0.5), path: [{ t: 0, hz: 110, a: 0.2 }, { t: 100, hz: 110, a: 0.2 }],
    }));
    const canvas = normalizePaintedCanvas(canvasOf(heavy, { durationSec: 180 }));
    expect(paintedCanvasStats(canvas).work).toBeLessThanOrEqual(L.WORK_MAX_PARTIAL_SEC);
    expect(canvas.strokes.map((s) => s.name)).toEqual(heavy.slice(0, canvas.strokes.length).map((s) => s.name));

    // A narrower per-passage budget is honoured too.
    expect(normalizePaintedCanvas(canvasOf(heavy, { durationSec: 180 }), { limits: { work: 3500 } }).strokes).toHaveLength(2);

    const huge = { path: Array.from({ length: 1_000_000 }, (_, i) => ({ t: i / 1000, hz: 220, a: 0.1 })) };
    expect(normalizePaintedCanvas(canvasOf([huge], { durationSec: 600 })).strokes[0].path).toHaveLength(L.KEYFRAMES_PER_STROKE_MAX);
  });
});

describe('synthesizePaintedCanvas', () => {
  it('renders stereo deterministically, with pitch, pan, and per-keyframe color as painted', () => {
    const canvas = normalizePaintedCanvas(canvasOf([
      // Hard left, pure 440 Hz for the first second, then its 2nd partial fades in.
      { pan: -1, path: [{ t: 0, hz: 440, a: 0.8 }, { t: 1, hz: 440, a: 0.8, overtones: [0] }, { t: 2, hz: 440, a: 0.8, overtones: [1] }] },
    ]));
    const [left, right] = synthesizePaintedCanvas(canvas);
    expect(left).toHaveLength(2 * SR);
    expect(synthesizePaintedCanvas(canvas)).toEqual([left, right]);
    expect(Math.max(...right.map(Math.abs))).toBeLessThan(1e-6);

    const firstHalf = [Math.floor(0.2 * SR), Math.floor(0.8 * SR)];
    const lateSecond = [Math.floor(1.7 * SR), Math.floor(1.95 * SR)];
    expect(levelAt(left, 440, ...firstHalf)).toBeGreaterThan(0.1);
    expect(levelAt(left, 880, ...firstHalf)).toBeLessThan(0.001);
    expect(levelAt(left, 880, ...lateSecond)).toBeGreaterThan(0.1);
  });

  it('glides pitch on the log axis and renders a noise band around its centre', () => {
    const canvas = normalizePaintedCanvas(canvasOf([
      { pan: -1, path: [{ t: 0, hz: 220, a: 0.8 }, { t: 2, hz: 880, a: 0.8 }] },
      { pan: 1, width: 200, path: [{ t: 0, hz: 3000, a: 0.8 }, { t: 2, hz: 3000, a: 0.8 }] },
    ]));
    const [left, right] = synthesizePaintedCanvas(canvas);
    // Halfway through a two-octave log glide the pitch is one octave up.
    const mid = [Math.floor(0.98 * SR), Math.floor(1.02 * SR)];
    expect(levelAt(left, 440, ...mid)).toBeGreaterThan(levelAt(left, 550, ...mid) * 3);
    const span = [Math.floor(0.5 * SR), Math.floor(1.5 * SR)];
    expect(levelAt(right, 3000, ...span)).toBeGreaterThan(levelAt(right, 6000, ...span) * 10);
    expect(levelAt(right, 3000, ...span)).toBeGreaterThan(levelAt(right, 1000, ...span) * 10);
  });

  it('renders a multi-section ~3 minute painting within the work bound', () => {
    const sections = [0, 30, 60, 90, 120, 150].map((start) => ({ start, end: start + 30 }));
    const strokes = [];
    for (let i = 0; i < 600; i += 1) {
      const t = (i * 0.3) % 178;
      strokes.push(i % 4 === 0
        ? { width: 1500, pan: -0.5, path: [{ t, hz: 6000, a: 0.2 }, { t: t + 0.4, hz: 5000, a: 0 }] }
        : { pan: 0.3, overtones: [0.5, 0.3, 0.2], path: [{ t, hz: 196, a: 0.4 }, { t: t + 0.8, hz: 220, a: 0.5, overtones: [0.2, 0.6] }, { t: t + 1.6, hz: 220, a: 0 }] });
    }
    const canvas = normalizePaintedCanvas(canvasOf(strokes, { durationSec: 180, bpm: 120, beatsPerBar: 4, sections }));
    expect(canvas.sections).toHaveLength(6);
    expect(canvas.strokes).toHaveLength(600);
    expect(paintedCanvasStats(canvas).work).toBeLessThanOrEqual(L.WORK_MAX_PARTIAL_SEC);

    const [left, right] = synthesizeSketchChannels(canvas);
    expect(left).toHaveLength(180 * SR);
    let peak = 0;
    for (let i = 0; i < left.length; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.98 + 1e-6);
  }, 30_000);
});

describe('sync compatibility', () => {
  it('makes a tracks-v7 peer reject a painting instead of stripping it', () => {
    const painting = normalizePaintedCanvas(canvasOf([tone(440)]));
    // What a v7 peer's v1-only normalizer would do to it: strip it to null and
    // LWW the loss back — the reason for the bump.
    expect(normalizeWaveSketch({ ...painting, version: 1 })).toBeNull();
    expect(PORTOS_SCHEMA_VERSIONS.tracks).toBe(8);
    const { ahead } = compareSchemaVersions(PORTOS_SCHEMA_VERSIONS, { ...PORTOS_SCHEMA_VERSIONS, tracks: 7 });
    expect(ahead).toEqual([{ category: 'tracks', senderV: 8, receiverV: 7 }]);
  });
});
