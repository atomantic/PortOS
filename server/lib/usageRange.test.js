import { describe, it, expect } from 'vitest';
import { resolveUsageRange } from './usageRange.js';

describe('resolveUsageRange', () => {
  it('counts period days back from today inclusive', () => {
    const { from, to } = resolveUsageRange({ period: '30d' });
    const expected = new Date();
    expected.setDate(expected.getDate() - 29);
    expect(from).toBe(expected.toISOString().split('T')[0]);
    expect(to).toBeNull();
  });

  it('defaults to 7d when nothing is given', () => {
    const { from } = resolveUsageRange();
    const expected = new Date();
    expected.setDate(expected.getDate() - 6);
    expect(from).toBe(expected.toISOString().split('T')[0]);
  });

  it('resolves period=all to an unbounded range', () => {
    expect(resolveUsageRange({ period: 'all' })).toEqual({ from: null, to: null });
  });

  it('lets explicit dates win over period', () => {
    expect(resolveUsageRange({ period: '90d', from: '2026-01-01' })).toEqual({ from: '2026-01-01', to: null });
    expect(resolveUsageRange({ from: '2026-01-01', to: '2026-02-01' })).toEqual({ from: '2026-01-01', to: '2026-02-01' });
  });
});
