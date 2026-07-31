import { describe, expect, it } from 'vitest';
import { powersBreakdown, powersBreakdownFromPrompt } from './powersBreakdown.js';

describe('powersBreakdown', () => {
  it('renders the worked split-exponent path for 5^9', () => {
    const result = powersBreakdown(5, 9);
    expect(result.technique).toBe('split-exponent');
    expect(result.steps).toContain('5^8 = 625 × 625 = 390,625');
    expect(result.steps.at(-1)).toContain('1,953,125');
  });

  it('renders every doubling step from the 2^10 anchor', () => {
    expect(powersBreakdown(2, 13).steps).toEqual([
      '2^10 = 1,024',
      '× 2 → 2^11 = 2,048',
      '× 2 → 2^12 = 4,096',
      '× 2 → 2^13 = 8,192',
    ]);
  });

  it('returns an explicit fallback for an unsupported pair', () => {
    expect(powersBreakdown(7, 8).fallback).toBe(true);
    expect(powersBreakdownFromPrompt('not a power')).toBeNull();
  });
});
