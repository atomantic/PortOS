import { describe, it, expect } from 'vitest';
import { clampImageDimensions, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from './imageGenResolutions';

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
