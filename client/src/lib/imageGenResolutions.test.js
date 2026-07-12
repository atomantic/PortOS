import { describe, it, expect } from 'vitest';
import { clampImageDimensions, clampImageEdge, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from './imageGenResolutions';

describe('clampImageEdge', () => {
  it('passes valid edges through unchanged', () => {
    expect(clampImageEdge(704)).toBe(704);
    expect(clampImageEdge(1280)).toBe(1280);
    expect(clampImageEdge(64)).toBe(64);
    expect(clampImageEdge(MAX_IMAGE_EDGE)).toBe(MAX_IMAGE_EDGE);
  });

  it('snaps below-minimum / non-finite / non-positive input up to the 64 floor', () => {
    expect(clampImageEdge(0)).toBe(64);
    expect(clampImageEdge(10)).toBe(64);
    expect(clampImageEdge(-5)).toBe(64);
    expect(clampImageEdge(NaN)).toBe(64);
    expect(clampImageEdge('')).toBe(64);
    expect(clampImageEdge(undefined)).toBe(64);
  });

  it('caps oversized edges at MAX_IMAGE_EDGE', () => {
    expect(clampImageEdge(9999)).toBe(MAX_IMAGE_EDGE);
    expect(clampImageEdge(MAX_IMAGE_EDGE + 1)).toBe(MAX_IMAGE_EDGE);
  });

  it('floors fractional input (runners want integer pixels)', () => {
    expect(clampImageEdge(704.9)).toBe(704);
    expect(clampImageEdge('1280px'.replace('px', ''))).toBe(1280);
  });

  it('honors custom { min, max } bounds (e.g. video 64..2048)', () => {
    const v = { min: 64, max: 2048 };
    expect(clampImageEdge(1024, v)).toBe(1024);
    expect(clampImageEdge(9999, v)).toBe(2048);
    expect(clampImageEdge(0, v)).toBe(64);
  });

  it('snaps DOWN to the nearest multiple of step when step > 1', () => {
    expect(clampImageEdge(700, { min: 64, max: 2048, step: 64 })).toBe(640);
    expect(clampImageEdge(768, { min: 64, max: 2048, step: 64 })).toBe(768);
    expect(clampImageEdge(705, { min: 64, max: 3840, step: 8 })).toBe(704);
  });

  it('never snaps below min after stepping', () => {
    // 100 floored to a multiple of 64 is 64, still ≥ min.
    expect(clampImageEdge(100, { min: 64, max: 2048, step: 64 })).toBe(64);
  });
});

describe('clampImageDimensions', () => {
  const underCaps = (d) =>
    d.width <= MAX_IMAGE_EDGE && d.height <= MAX_IMAGE_EDGE && d.width * d.height <= MAX_IMAGE_PIXELS;

  it('passes already-valid sizes through (snapped to multiples of 8)', () => {
    expect(clampImageDimensions(1024, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(clampImageDimensions(1216, 832)).toEqual({ width: 1216, height: 832 });
  });

  it('clamps a large phone photo under the edge AND pixel caps, preserving aspect', () => {
    // 4032×3024 (12MP, 4:3) — over the 8.29MP pixel cap.
    const d = clampImageDimensions(4032, 3024);
    expect(underCaps(d)).toBe(true);
    // aspect ratio preserved within rounding tolerance
    expect(Math.abs(d.width / d.height - 4032 / 3024)).toBeLessThan(0.02);
    expect(d.width % 8).toBe(0);
    expect(d.height % 8).toBe(0);
  });

  it('caps the long edge at MAX_IMAGE_EDGE for an extreme aspect ratio', () => {
    const d = clampImageDimensions(8000, 1000);
    expect(d.width).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(underCaps(d)).toBe(true);
  });

  it('never returns a dimension below 64', () => {
    const d = clampImageDimensions(10000, 5);
    expect(d.width).toBeGreaterThanOrEqual(64);
    expect(d.height).toBeGreaterThanOrEqual(64);
  });

  it('returns null for non-finite or non-positive input', () => {
    expect(clampImageDimensions(0, 100)).toBeNull();
    expect(clampImageDimensions(NaN, 100)).toBeNull();
    expect(clampImageDimensions(undefined, undefined)).toBeNull();
  });
});
