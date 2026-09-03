import { describe, it, expect } from 'vitest';
import { renderWorkUnits, timedRenderSamples, fitRenderCost, estimateRenderMs } from './eta.js';

const MODEL = 'example_video_model';

// A history record as finalizeGeneratedVideo writes it. `at` orders records.
const rec = ({ modelId = MODEL, width = 768, height = 512, numFrames = 121, steps = 30, renderMs, createdAt = '2026-08-01T00:00:00.000Z' }) =>
  ({ modelId, width, height, numFrames, steps, renderMs, createdAt });

describe('renderWorkUnits', () => {
  it('multiplies pixels × frames × steps', () => {
    expect(renderWorkUnits({ width: 2, height: 3, numFrames: 5, steps: 7 })).toBe(210);
  });

  it('returns null (absent sentinel) when a dimension is missing or non-positive', () => {
    expect(renderWorkUnits({ width: 768, height: 512, numFrames: 121 })).toBeNull();
    expect(renderWorkUnits({ width: 768, height: 512, numFrames: 0, steps: 30 })).toBeNull();
    expect(renderWorkUnits({ width: 768, height: 512, numFrames: 121, steps: 'many' })).toBeNull();
  });
});

describe('timedRenderSamples', () => {
  it('keeps only timed, shape-complete records for the requested model, newest first', () => {
    const history = [
      rec({ renderMs: 1000, createdAt: '2026-08-01T00:00:00.000Z' }),
      rec({ renderMs: 2000, createdAt: '2026-08-03T00:00:00.000Z' }),
      rec({ modelId: 'other_model', renderMs: 9999 }),
      // Legacy record from before render timing was stamped.
      rec({ renderMs: undefined }),
      // A downloaded video: no shape at all.
      { modelId: MODEL, renderMs: 500 },
    ];
    const samples = timedRenderSamples(history, MODEL);
    expect(samples.map((s) => s.durationMs)).toEqual([2000, 1000]);
  });

  it('drops zero/negative durations rather than treating them as instant renders', () => {
    expect(timedRenderSamples([rec({ renderMs: 0 }), rec({ renderMs: -5 })], MODEL)).toEqual([]);
  });

  it('tolerates a missing history file (non-array)', () => {
    expect(timedRenderSamples(null, MODEL)).toEqual([]);
  });
});

describe('fitRenderCost', () => {
  it('recovers slope and fixed cost from a perfectly linear sample set', () => {
    // ms = 3·work + 60000
    const samples = [10, 20, 30].map((w) => ({ workUnits: w, durationMs: 3 * w + 60000 }));
    const fit = fitRenderCost(samples);
    expect(fit.perUnitMs).toBeCloseTo(3, 6);
    expect(fit.fixedMs).toBeCloseTo(60000, 3);
  });

  it('refuses to fit fewer than three samples', () => {
    expect(fitRenderCost([{ workUnits: 10, durationMs: 100 }, { workUnits: 20, durationMs: 200 }])).toBeNull();
  });

  it('refuses to fit when every sample has the same work units', () => {
    const samples = [1000, 1200, 1400].map((ms) => ({ workUnits: 50, durationMs: ms }));
    expect(fitRenderCost(samples)).toBeNull();
  });

  it('refuses to fit identical real-scale work units, where the denominator is float dust rather than 0', () => {
    const work = 768 * 512 * 121 * 30;
    const samples = [1_000_000, 1_200_000, 1_400_000].map((ms) => ({ workUnits: work, durationMs: ms }));
    expect(fitRenderCost(samples)).toBeNull();
  });

  it('rejects a non-positive slope (noise, not a cost curve)', () => {
    const samples = [{ workUnits: 10, durationMs: 900 }, { workUnits: 20, durationMs: 600 }, { workUnits: 30, durationMs: 300 }];
    expect(fitRenderCost(samples)).toBeNull();
  });

  it('stays numerically stable on real-scale, closely-spaced work units', () => {
    // ~1e9 work units per render: squaring these overflows the exactly-
    // representable integer range, so an unscaled normal-equation fit
    // catastrophically cancels and returns a garbage slope.
    const samples = [97, 105, 113].map((frames) => {
      const w = 768 * 512 * frames * 30;
      return { workUnits: w, durationMs: 2e-6 * w + 90_000 };
    });
    const fit = fitRenderCost(samples);
    expect(fit.perUnitMs).toBeCloseTo(2e-6, 12);
    expect(fit.fixedMs).toBeGreaterThan(89_000);
    expect(fit.fixedMs).toBeLessThan(91_000);
  });

  it('clamps a negative intercept to zero instead of estimating below zero', () => {
    // ms = 5·work − 100 → intercept would be negative.
    const samples = [40, 60, 80].map((w) => ({ workUnits: w, durationMs: 5 * w - 100 }));
    const fit = fitRenderCost(samples);
    expect(fit.perUnitMs).toBeGreaterThan(0);
    expect(fit.fixedMs).toBe(0);
  });
});

describe('estimateRenderMs', () => {
  const target = { modelId: MODEL, width: 768, height: 512, numFrames: 121, steps: 30 };

  it('returns null when history holds no measurement for this model', () => {
    expect(estimateRenderMs({ history: [], ...target })).toBeNull();
    expect(estimateRenderMs({ history: [rec({ modelId: 'other_model', renderMs: 1000 })], ...target })).toBeNull();
  });

  it('returns null when the requested shape is incomplete', () => {
    expect(estimateRenderMs({ history: [rec({ renderMs: 1000 })], modelId: MODEL, width: 768, height: 512, steps: 30 })).toBeNull();
  });

  it('uses the median of exact-shape measurements, overriding the model', () => {
    const history = [
      rec({ renderMs: 900_000, createdAt: '2026-08-03T00:00:00.000Z' }),
      rec({ renderMs: 1_100_000, createdAt: '2026-08-02T00:00:00.000Z' }),
      rec({ renderMs: 1_000_000, createdAt: '2026-08-01T00:00:00.000Z' }),
      // Different shape, wildly different cost — must not perturb the exact match.
      rec({ width: 1024, renderMs: 60_000, createdAt: '2026-08-04T00:00:00.000Z' }),
    ];
    const est = estimateRenderMs({ history, ...target });
    expect(est.basis).toBe('measured');
    expect(est.etaMs).toBe(1_000_000);
    expect(est.sampleCount).toBe(3);
  });

  it('falls back to a linear fit across differing shapes', () => {
    // ms = 2e-6·work + 120000, over three distinct frame counts.
    const mk = (numFrames) => {
      const work = 768 * 512 * numFrames * 30;
      return rec({ numFrames, renderMs: Math.round(2e-6 * work + 120_000) });
    };
    const est = estimateRenderMs({ history: [mk(97), mk(145), mk(193)], ...target });
    expect(est.basis).toBe('linear');
    const expected = 2e-6 * (768 * 512 * 121 * 30) + 120_000;
    expect(est.etaMs).toBeGreaterThan(expected * 0.99);
    expect(est.etaMs).toBeLessThan(expected * 1.01);
  });

  it('falls back to a proportional rate when there are too few samples to fit', () => {
    const halfWork = rec({ numFrames: 61, renderMs: 500_000 });
    const est = estimateRenderMs({ history: [halfWork], ...target });
    expect(est.basis).toBe('proportional');
    // 121/61 of the measured run.
    expect(est.etaMs).toBe(Math.round(500_000 * (121 / 61)));
    expect(est.sampleCount).toBe(1);
  });

  it('multiplies by the chunk count for chained renders, paying the fixed cost per chunk', () => {
    const mk = (numFrames) => {
      const work = 768 * 512 * numFrames * 30;
      return rec({ numFrames, renderMs: Math.round(2e-6 * work + 120_000) });
    };
    const history = [mk(97), mk(145), mk(193)];
    const single = estimateRenderMs({ history, ...target });
    const chained = estimateRenderMs({ history, ...target, chunks: 4 });
    expect(chained.chunks).toBe(4);
    expect(chained.etaMs).toBe(single.perChunkMs * 4);
    // The fixed per-render cost is paid four times, so a 4-chunk chain costs
    // strictly more than one render of four times the sampler work would.
    const quadWork = estimateRenderMs({ history, ...target, numFrames: 121 * 4 });
    expect(chained.etaMs).toBeGreaterThan(quadWork.etaMs);
  });

  it('treats a bogus chunk count as a single chunk', () => {
    const history = [rec({ renderMs: 600_000 })];
    for (const chunks of [0, -3, NaN, undefined, 'two']) {
      expect(estimateRenderMs({ history, ...target, chunks }).chunks).toBe(1);
    }
  });

  it('returns null rather than a zero estimate when the samples round to nothing', () => {
    // A sub-millisecond measurement rounds to 0, and 0 is the one number this
    // must never report — the contract is "no estimate" instead.
    expect(estimateRenderMs({ history: [rec({ renderMs: 0.4 })], ...target })).toBeNull();
  });

  it('prefers recent measurements when the shape repeats many times', () => {
    // Six exact-shape records; only the newest five feed the median, so the
    // stale slow outlier at the bottom cannot drag the estimate up.
    const history = [
      ...[1, 2, 3, 4, 5].map((d) => rec({ renderMs: 600_000, createdAt: `2026-08-0${d + 1}T00:00:00.000Z` })),
      rec({ renderMs: 5_000_000, createdAt: '2026-07-01T00:00:00.000Z' }),
    ];
    expect(estimateRenderMs({ history, ...target }).etaMs).toBe(600_000);
  });
});

// #4875 — a speed profile roughly halves render time, so its samples belong in
// their own cost bucket. These pin the split in BOTH directions: a fast render
// must not be estimated from quality history, and vice versa.
describe('speed-profile sample bucketing', () => {
  const target = { modelId: MODEL, width: 768, height: 512, numFrames: 121, steps: 30 };
  const quality = rec({ renderMs: 600_000 });
  const fast = { ...rec({ renderMs: 300_000 }), speedProfileId: 'fast' };

  it('treats an absent speedProfileId and the default id as the same bucket', () => {
    const history = [quality, { ...quality, speedProfileId: 'quality' }];
    expect(timedRenderSamples(history, MODEL)).toHaveLength(2);
    expect(timedRenderSamples(history, MODEL, 'quality')).toHaveLength(2);
    expect(timedRenderSamples(history, MODEL, '')).toHaveLength(2);
  });

  it('excludes profiled renders from the default bucket', () => {
    expect(timedRenderSamples([quality, fast], MODEL).map((s) => s.durationMs)).toEqual([600_000]);
  });

  it('excludes default renders from a profiled bucket', () => {
    expect(timedRenderSamples([quality, fast], MODEL, 'fast').map((s) => s.durationMs)).toEqual([300_000]);
  });

  it('estimates each bucket from its own measurements, not the pooled median', () => {
    const history = [quality, fast];
    expect(estimateRenderMs({ history, ...target }).etaMs).toBe(600_000);
    expect(estimateRenderMs({ history, ...target, speedProfileId: 'fast' }).etaMs).toBe(300_000);
  });

  it('returns no estimate for a profile this install has never measured', () => {
    // Deliberate: an honest "unknown" beats a confidently wrong number derived
    // from a different cost curve. Same contract as a newly-added model.
    expect(estimateRenderMs({ history: [quality], ...target, speedProfileId: 'fast' })).toBeNull();
  });
});

// Derived history rows (#5878). These inherit their SOURCE's modelId and dials
// but time something else — an ffmpeg upscale pass, a federated round-trip, a
// chain total whose chunks are already samples. They carry a positive renderMs,
// so nothing but this exclusion keeps them out of the least-squares fit.
describe('timedRenderSamples excludes derived rows', () => {
  const good = rec({ renderMs: 600_000 });

  it.each([
    ['an upscale (4x the work units, seconds of ffmpeg)', { upscaledFrom: 'src-id', width: 1536, height: 1024 }],
    ['a federated render (peer hardware + network round-trip)', { federatedPeerId: 'peer-1' }],
    ['a chained total (its chunks are already samples)', { chainedFrom: ['a', 'b'] }],
    ['a hand-stitched clip', { stitchedFrom: ['a', 'b'] }],
  ])('drops %s', (_label, over) => {
    const derived = { ...rec({ renderMs: 20_000 }), ...over };
    expect(timedRenderSamples([good, derived], MODEL)).toHaveLength(1);
  });

  it('keeps an ordinary local render', () => {
    expect(timedRenderSamples([good], MODEL)).toHaveLength(1);
  });
});
