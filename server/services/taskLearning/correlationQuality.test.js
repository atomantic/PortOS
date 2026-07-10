import { describe, it, expect } from 'vitest';
import {
  recordCorrelationSample,
  computeCorrelationQuality,
  isCorrelationProven,
  CORRELATION_QUALITY_THRESHOLD,
  MIN_CORRELATION_SAMPLES
} from './correlationQuality.js';

// Pure correlation-quality core for issue #2344. No I/O — exercised directly
// against hand-built windows.

const pair = (predictedRisk, bad, over = {}) => ({ predictedRisk, bad, taskType: 'user-task', tier: 'heavy', ...over });

// Build a window of n perfectly-correlated pairs (risk↔bad), split good/bad.
const perfectWindow = (bad, good) => [
  ...Array.from({ length: bad }, () => pair(true, true)),
  ...Array.from({ length: good }, () => pair(false, false))
];

describe('recordCorrelationSample', () => {
  it('appends a normalized pair and is additive/back-compat on an old learning file', () => {
    const data = { version: 1 }; // predates correlationWindow
    const out = recordCorrelationSample(data, { taskType: 'user-task', tier: 'heavy', predictedRisk: true, bad: false });
    expect(out).toBe(data); // mutates in place
    expect(out.correlationWindow).toHaveLength(1);
    expect(out.correlationWindow[0]).toMatchObject({
      taskType: 'user-task', tier: 'heavy', predictedRisk: true, bad: false
    });
    expect(out.correlationWindow[0].recordedAt).toBeTruthy();
  });

  it('coerces predictedRisk/bad to booleans and nulls absent taskType/tier', () => {
    const data = {};
    recordCorrelationSample(data, { predictedRisk: 1, bad: 0 });
    expect(data.correlationWindow[0]).toMatchObject({
      predictedRisk: true, bad: false, taskType: null, tier: null
    });
  });

  it('bounds the rolling window to the last 200 samples', () => {
    const data = {};
    for (let i = 0; i < 250; i++) recordCorrelationSample(data, { predictedRisk: false, bad: false });
    expect(data.correlationWindow).toHaveLength(200);
  });
});

describe('computeCorrelationQuality', () => {
  it('scores a perfectly-correlated window at 1.0', () => {
    const q = computeCorrelationQuality(perfectWindow(15, 15));
    expect(q.score).toBe(1);
    expect(q.sampleCount).toBe(30);
    expect(q.confident).toBe(true);
    expect(q.matrix).toEqual({ tp: 15, fp: 0, fn: 0, tn: 15 });
  });

  it('scores a perfectly-anticorrelated window at -1.0', () => {
    const window = [
      ...Array.from({ length: 15 }, () => pair(true, false)),
      ...Array.from({ length: 15 }, () => pair(false, true))
    ];
    expect(computeCorrelationQuality(window).score).toBe(-1);
  });

  it('returns a null score (not 0) for a degenerate window with only one predicted class', () => {
    // Every run predicted-safe → (tp+fp) === 0 → denominator 0 → not measurable.
    const window = Array.from({ length: 30 }, () => pair(false, false));
    const q = computeCorrelationQuality(window);
    expect(q.score).toBeNull();
    expect(q.confident).toBe(false); // null score is never confident
    expect(q.sampleCount).toBe(30);
  });

  it('returns a null score for a degenerate window where no run went bad', () => {
    const window = [
      ...Array.from({ length: 15 }, () => pair(true, false)),
      ...Array.from({ length: 15 }, () => pair(false, false))
    ];
    expect(computeCorrelationQuality(window).score).toBeNull();
  });

  it('is not confident below the minimum sample bar even with a perfect score', () => {
    const q = computeCorrelationQuality(perfectWindow(2, 2)); // 4 < MIN_CORRELATION_SAMPLES
    expect(q.score).toBe(1);
    expect(q.sampleCount).toBe(4);
    expect(q.confident).toBe(false);
  });

  it('tolerates a missing/undefined window (pre-#2344 learning file)', () => {
    const q = computeCorrelationQuality(undefined);
    expect(q).toEqual({ score: null, sampleCount: 0, confident: false, matrix: { tp: 0, fp: 0, fn: 0, tn: 0 } });
  });

  it('honors a custom minSamples override', () => {
    const q = computeCorrelationQuality(perfectWindow(3, 2), { minSamples: 5 });
    expect(q.confident).toBe(true); // 5 samples >= 5
  });
});

describe('isCorrelationProven', () => {
  it('is true only for a confident, measurable score above the threshold', () => {
    expect(isCorrelationProven(computeCorrelationQuality(perfectWindow(15, 15)))).toBe(true);
  });

  it('is false when not confident (too few samples)', () => {
    expect(isCorrelationProven(computeCorrelationQuality(perfectWindow(2, 2)))).toBe(false);
  });

  it('is false for a degenerate null score', () => {
    const q = computeCorrelationQuality(Array.from({ length: 30 }, () => pair(false, false)));
    expect(isCorrelationProven(q)).toBe(false);
  });

  it('is false for a confident score that sits at or below the threshold', () => {
    // Mixed window with modest positive correlation below 0.8.
    const window = [
      ...Array.from({ length: 8 }, () => pair(true, true)),
      ...Array.from({ length: 4 }, () => pair(true, false)),
      ...Array.from({ length: 4 }, () => pair(false, true)),
      ...Array.from({ length: 8 }, () => pair(false, false))
    ];
    const q = computeCorrelationQuality(window);
    expect(q.confident).toBe(true);
    expect(q.score).toBeLessThanOrEqual(CORRELATION_QUALITY_THRESHOLD);
    expect(isCorrelationProven(q)).toBe(false);
  });

  it('exposes the documented threshold and sample-bar constants', () => {
    expect(CORRELATION_QUALITY_THRESHOLD).toBe(0.8);
    expect(MIN_CORRELATION_SAMPLES).toBeGreaterThan(0);
  });
});
