import { describe, expect, it } from 'vitest';
import { excerptRangeFits } from './musicVideoExcerptRange.js';

describe('excerptRangeFits', () => {
  it('accepts an end up to one frame past a frame-quantized render', () => {
    expect(excerptRangeFits(0, 119.943, 119.92, 24)).toBe(true);
    expect(excerptRangeFits(0, 119.92 + 1 / 24, 119.92, 24)).toBe(true);
  });
  it('refuses an end more than a frame past the render, and empty or negative windows', () => {
    expect(excerptRangeFits(0, 120, 119.92, 24)).toBe(false);
    expect(excerptRangeFits(5, 5, 119.92, 24)).toBe(false);
    expect(excerptRangeFits(-1, 4, 119.92, 24)).toBe(false);
  });
  it('allows no slack without a usable fps', () => {
    expect(excerptRangeFits(0, 119.93, 119.92, 0)).toBe(false);
  });
});
