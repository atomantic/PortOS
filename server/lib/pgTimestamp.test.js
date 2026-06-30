import { describe, it, expect } from 'vitest';
import { mirrorTimestamp } from './pgTimestamp.js';

const FALLBACK = '__fallback__';

describe('mirrorTimestamp', () => {
  it('normalizes a valid ISO timestamp to canonical toISOString form', () => {
    // Offset form gets normalized to the canonical Z form.
    expect(mirrorTimestamp('2026-06-30T00:00:00+00:00', FALLBACK)).toBe('2026-06-30T00:00:00.000Z');
  });

  it('returns the canonical ISO string (not the raw input) for an in-range value', () => {
    const out = mirrorTimestamp('2026-01-02T03:04:05.000Z', FALLBACK);
    expect(out).toBe('2026-01-02T03:04:05.000Z');
    expect(new Date(out).toISOString()).toBe(out); // round-trips cleanly
  });

  it('normalizes an out-of-range calendar date that Date.parse rolls over', () => {
    // 2026-02-31 does not exist; Date.parse rolls it to Mar 3. The normalized
    // canonical string is what PG can actually bind.
    const out = mirrorTimestamp('2026-02-31T00:00:00.000Z', FALLBACK);
    expect(out).toBe('2026-03-03T00:00:00.000Z');
    expect(out).not.toBe(FALLBACK);
  });

  it('accepts a non-ISO but Date.parse-able string and normalizes it', () => {
    expect(mirrorTimestamp('Tue, 30 Jun 2026 00:00:00 GMT', FALLBACK)).toBe('2026-06-30T00:00:00.000Z');
  });

  it('falls back for an unparseable string', () => {
    expect(mirrorTimestamp('not-a-date', FALLBACK)).toBe(FALLBACK);
    expect(mirrorTimestamp('', FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for non-string inputs', () => {
    expect(mirrorTimestamp(null, FALLBACK)).toBe(FALLBACK);
    expect(mirrorTimestamp(undefined, FALLBACK)).toBe(FALLBACK);
    expect(mirrorTimestamp(1719705600000, FALLBACK)).toBe(FALLBACK);
    expect(mirrorTimestamp(new Date(), FALLBACK)).toBe(FALLBACK);
  });

  it('rejects year 0000 (no Gregorian year zero) and falls back', () => {
    // Date.parse('0000-01-01...') is accepted and toISOString emits '0000-...',
    // which PG would still reject — so mirrorTimestamp must fall back.
    const iso = new Date(Date.parse('0000-01-01T00:00:00.000Z')).toISOString();
    expect(iso.startsWith('0000-')).toBe(true); // confirm the precondition
    expect(mirrorTimestamp('0000-01-01T00:00:00.000Z', FALLBACK)).toBe(FALLBACK);
  });

  it('accepts a low but non-zero 4-digit year (0001)', () => {
    const out = mirrorTimestamp('0001-01-01T00:00:00.000Z', FALLBACK);
    expect(out).toBe('0001-01-01T00:00:00.000Z');
  });

  it('accepts the top of the 4-digit year range (9999)', () => {
    const out = mirrorTimestamp('9999-12-31T23:59:59.000Z', FALLBACK);
    expect(out).toBe('9999-12-31T23:59:59.000Z');
  });

  it('rejects a positive expanded-year form (+275760) that PG cannot bind', () => {
    // Far-future date toISOString emits the signed +YYYYYY- expanded form.
    const out = mirrorTimestamp('+275760-09-13T00:00:00.000Z', FALLBACK);
    expect(out).toBe(FALLBACK);
  });

  it('rejects a negative expanded-year (BCE) form that PG cannot bind', () => {
    const out = mirrorTimestamp('-100000-01-01T00:00:00.000Z', FALLBACK);
    expect(out).toBe(FALLBACK);
  });

  it('passes the fallback through verbatim (any type)', () => {
    expect(mirrorTimestamp(null, null)).toBeNull();
    expect(mirrorTimestamp('bad', undefined)).toBeUndefined();
  });
});
