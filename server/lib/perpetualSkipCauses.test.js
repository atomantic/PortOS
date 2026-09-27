import { describe, it, expect } from 'vitest';
import { formatSkipCauses } from './perpetualSkipCauses.js';

describe('formatSkipCauses', () => {
  it('renders causes largest-first, capped at maxCauses', () => {
    expect(formatSkipCauses({ 'needs-input': 49, blocked: 17, 'decomposed-epic': 12, assigned: 2 }))
      .toBe('49 needs-input, 17 blocked, 12 decomposed-epic');
    expect(formatSkipCauses({ 'needs-input': 49, blocked: 17, 'decomposed-epic': 12, assigned: 2 }, 2))
      .toBe('49 needs-input, 17 blocked');
  });

  it('excludes a cause another channel already shows (the toast excludes in-flight)', () => {
    expect(formatSkipCauses({ 'in-flight': 10, 'needs-input': 6, blocked: 4 }, 3, 'in-flight'))
      .toBe('6 needs-input, 4 blocked');
  });

  it('returns "" for an absent, empty, or non-object map', () => {
    expect(formatSkipCauses(null)).toBe('');
    expect(formatSkipCauses(undefined)).toBe('');
    expect(formatSkipCauses({})).toBe('');
    expect(formatSkipCauses('needs-input')).toBe('');
    // An array is typeof 'object' but its entries are index/count pairs — a
    // corrupt persisted map must not render bogus causes like "49 0, 17 1".
    expect(formatSkipCauses([49, 17])).toBe('');
  });

  it('drops non-finite and non-positive counts rather than rendering them', () => {
    // The map crosses a persisted-JSON boundary (the schedule store), so a
    // hand-edited or corrupted entry must not reach the string.
    expect(formatSkipCauses({ blocked: 3, stale: NaN, zero: 0 })).toBe('3 blocked');
  });
});
