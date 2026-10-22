import { describe, it, expect } from 'vitest';
import { diceNotationSchema, requireDiceNotation } from './diceNotation.js';

describe('diceNotationSchema (#13088)', () => {
  it('accepts in-bounds notation and refuses counts and sides outside 1-100 dice and 2-1000 sides', () => {
    expect(diceNotationSchema.safeParse('2d6+3').success).toBe(true);
    expect(diceNotationSchema.safeParse('1d8').success).toBe(true);
    for (const bad of ['101d6', '0d6', '1d1', '1d1001', '1000000000d6']) {
      expect(diceNotationSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('requireDiceNotation (#13088)', () => {
  it('throws a 400 for out-of-bounds notation so non-route callers are bounded too', () => {
    let error;
    try { requireDiceNotation('1000000000d6'); } catch (err) { error = err; }
    expect(error?.status).toBe(400);
  });
});
