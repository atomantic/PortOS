import { describe, it, expect } from 'vitest';
import { parseTsMs, compareNewerWins, compareEarlierWins } from './lwwTimestamp.js';

describe('parseTsMs', () => {
  it('parses an ISO-8601 string to epoch ms', () => {
    expect(parseTsMs('1970-01-01T00:00:00.000Z')).toBe(0);
    expect(parseTsMs('2026-06-30T00:00:00.000Z')).toBe(Date.parse('2026-06-30T00:00:00.000Z'));
  });

  it('parses a non-ISO but Date.parse-able string', () => {
    // RFC-2822 style — not ISO, but Date.parse accepts it.
    expect(parseTsMs('Tue, 30 Jun 2026 00:00:00 GMT')).toBe(Date.parse('Tue, 30 Jun 2026 00:00:00 GMT'));
  });

  it('returns null for an unparseable string', () => {
    expect(parseTsMs('not-a-date')).toBeNull();
    expect(parseTsMs('')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(parseTsMs(null)).toBeNull();
    expect(parseTsMs(undefined)).toBeNull();
    expect(parseTsMs(0)).toBeNull();
    expect(parseTsMs(1719705600000)).toBeNull(); // a number is NOT parsed
    expect(parseTsMs(new Date())).toBeNull();
    expect(parseTsMs({})).toBeNull();
  });

  it('orders two parseable-but-different-format timestamps by epoch, not lexically', () => {
    // Lexicographically 'Jan' < 'Feb' is false but here the ISO form sorts the
    // other way from the RFC form — the point is both resolve to the same ms.
    const iso = parseTsMs('2026-01-02T03:04:05.000Z');
    const rfc = parseTsMs('Fri, 02 Jan 2026 03:04:05 GMT');
    expect(iso).toBe(rfc);
  });
});

describe('compareNewerWins', () => {
  it('returns true when candidate is strictly newer', () => {
    expect(compareNewerWins('2026-06-30T00:00:01.000Z', '2026-06-30T00:00:00.000Z')).toBe(true);
  });

  it('returns false when candidate is older', () => {
    expect(compareNewerWins('2026-06-30T00:00:00.000Z', '2026-06-30T00:00:01.000Z')).toBe(false);
  });

  it('breaks an exact tie to the incumbent (returns false)', () => {
    const t = '2026-06-30T00:00:00.000Z';
    expect(compareNewerWins(t, t)).toBe(false);
  });

  it('never lets an unparseable candidate override', () => {
    expect(compareNewerWins('garbage', '2026-06-30T00:00:00.000Z')).toBe(false);
    expect(compareNewerWins(null, '2026-06-30T00:00:00.000Z')).toBe(false);
  });

  it('lets a valid candidate beat an unparseable incumbent', () => {
    expect(compareNewerWins('2026-06-30T00:00:00.000Z', 'garbage')).toBe(true);
    expect(compareNewerWins('2026-06-30T00:00:00.000Z', null)).toBe(true);
  });

  it('breaks a both-unparseable tie to the incumbent (returns false)', () => {
    expect(compareNewerWins('garbage', 'also-garbage')).toBe(false);
    expect(compareNewerWins(null, undefined)).toBe(false);
  });

  it('compares ISO vs non-ISO formats by epoch value', () => {
    // RFC form is one second newer than the ISO form despite different shapes.
    expect(compareNewerWins('Fri, 02 Jan 2026 03:04:06 GMT', '2026-01-02T03:04:05.000Z')).toBe(true);
  });

  it('is antisymmetric for two distinct valid timestamps', () => {
    const a = '2026-06-30T00:00:01.000Z';
    const b = '2026-06-30T00:00:00.000Z';
    // exactly one direction wins
    expect(compareNewerWins(a, b)).toBe(true);
    expect(compareNewerWins(b, a)).toBe(false);
  });
});

describe('compareEarlierWins', () => {
  it('returns -1 when a is earlier (a wins)', () => {
    expect(compareEarlierWins('2026-06-30T00:00:00.000Z', '2026-06-30T00:00:01.000Z')).toBe(-1);
  });

  it('returns 1 when b is earlier (b wins)', () => {
    expect(compareEarlierWins('2026-06-30T00:00:01.000Z', '2026-06-30T00:00:00.000Z')).toBe(1);
  });

  it('returns 0 on an exact tie', () => {
    const t = '2026-06-30T00:00:00.000Z';
    expect(compareEarlierWins(t, t)).toBe(0);
  });

  it('returns 0 when both sides are unparseable', () => {
    expect(compareEarlierWins('garbage', 'also-garbage')).toBe(0);
    expect(compareEarlierWins(null, undefined)).toBe(0);
  });

  it('lets the parseable side win against an unparseable side', () => {
    // a unparseable → b wins (1)
    expect(compareEarlierWins('garbage', '2026-06-30T00:00:00.000Z')).toBe(1);
    // b unparseable → a wins (-1)
    expect(compareEarlierWins('2026-06-30T00:00:00.000Z', 'garbage')).toBe(-1);
  });

  it('is antisymmetric for two distinct valid timestamps', () => {
    const early = '2026-06-30T00:00:00.000Z';
    const late = '2026-06-30T00:00:01.000Z';
    expect(compareEarlierWins(early, late)).toBe(-1 * compareEarlierWins(late, early));
  });

  it('compares ISO vs non-ISO formats by epoch value', () => {
    // RFC form is one second earlier → a wins.
    expect(compareEarlierWins('Fri, 02 Jan 2026 03:04:04 GMT', '2026-01-02T03:04:05.000Z')).toBe(-1);
  });
});
