import { describe, expect, it } from 'vitest';
import { eidoverseModelBounds, eidoverseModelPlacement } from './eidoverseCityLayout.js';

describe('library geometry placement', () => {
  it('centers an offset, rotated model on the authored ground point at the requested size', () => {
    const bounds = { min: [10, -2, -40], max: [18, 8, -20] };
    const placement = eidoverseModelPlacement({ bounds, pos: [4, 0.1, 6], yaw: Math.PI / 2, scale: 1, size: 8 });
    expect(placement.scale).toBe(0.4);
    // Transform the source model's bottom-center, independently of the fitter.
    const ground = [14, -2, -30].map((n) => n * placement.scale);
    expect(placement.pos[0] + ground[2]).toBeCloseTo(4);
    expect(placement.pos[1] + ground[1]).toBeCloseTo(0.1);
    expect(placement.pos[2] - ground[0]).toBeCloseTo(6);
    expect(eidoverseModelBounds({ min: [0, 0, 0], max: [0, 0, 0] })).toBeNull();
    expect(eidoverseModelBounds({ min: [0, 0, NaN], max: [1, 1, 1] })).toBeNull();
  });
});
