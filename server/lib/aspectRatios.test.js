import { describe, expect, it } from 'vitest';
import { nearestRatio } from './aspectRatios.js';

describe('nearestRatio', () => {
  it('uses proportional distance and keeps the first candidate on a tie', () => {
    expect(nearestRatio(16, 10, ['1:1', '2:1'])).toBe('2:1');
    expect(nearestRatio(1, 1, ['2:1', '1:2'])).toBe('2:1');
  });

  it('filters invalid candidate ratios and returns null if none remain', () => {
    const invalid = ['auto', '0:1', '1:0', '1:2:3', null];
    expect(nearestRatio('16', '9', [...invalid, '16:9'])).toBe('16:9');
    expect(nearestRatio(16, 9, invalid)).toBeNull();
    expect(nearestRatio(16, 9, [])).toBeNull();
  });

  it.each([0, -1, NaN, Infinity])('rejects dimension %s', (invalid) => {
    expect(nearestRatio(invalid, 1, ['1:1'])).toBeNull();
    expect(nearestRatio(1, invalid, ['1:1'])).toBeNull();
  });
});
