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

  it('a same-instant ISO and RFC string parse to the identical epoch ms', () => {
    const iso = parseTsMs('2026-01-02T03:04:05.000Z');
    const rfc = parseTsMs('Fri, 02 Jan 2026 03:04:05 GMT');
    expect(iso).toBe(rfc);
  });

  it('orders two different-format timestamps by epoch even when lexical order disagrees', () => {
    // The ISO string is the LATER instant (2030) but sorts EARLIER as a raw
    // string because '2' < 'F'. A lexicographic compare would therefore call the
    // 2030 ISO value "smaller/earlier" than the 2026 RFC value — inverting the
    // true order. Epoch parsing is what keeps the polarity correct.
    const isoLater = '2030-01-01T00:00:00.000Z';
    const rfcEarlier = 'Fri, 02 Jan 2026 03:04:06 GMT';
    expect(isoLater < rfcEarlier).toBe(true);                          // lexical: ISO sorts first
    expect(parseTsMs(isoLater)).toBeGreaterThan(parseTsMs(rfcEarlier)); // epoch: ISO is later
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

  it('decides newer-wins by epoch even when lexical order disagrees', () => {
    // The 2030 ISO value is chronologically NEWER but sorts EARLIER as a string
    // ('2' < 'F') than the 2026 RFC value — so a lexicographic compare would get
    // BOTH directions wrong. Pinning both directions rules out a string-compare
    // regression that a same-direction case (e.g. RFC newer AND lexically larger)
    // would silently pass.
    const isoNewer = '2030-01-01T00:00:00.000Z';
    const rfcOlder = 'Fri, 02 Jan 2026 03:04:06 GMT';
    expect(isoNewer < rfcOlder).toBe(true);                 // lexical: ISO sorts first
    expect(compareNewerWins(isoNewer, rfcOlder)).toBe(true);  // epoch: ISO is newer → overrides
    expect(compareNewerWins(rfcOlder, isoNewer)).toBe(false); // epoch: RFC is older → loses
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

  it('decides earlier-wins by epoch even when lexical order disagrees', () => {
    // a (2030 ISO) is chronologically LATER but sorts EARLIER as a string than
    // b (2026 RFC) — a lexicographic compare would wrongly call a "earlier" and
    // return -1; epoch comparison correctly returns 1 (b is earlier, b wins).
    const aLater = '2030-01-01T00:00:00.000Z';
    const bEarlier = 'Fri, 02 Jan 2026 03:04:06 GMT';
    expect(aLater < bEarlier).toBe(true);              // lexical: a sorts first
    expect(compareEarlierWins(aLater, bEarlier)).toBe(1); // epoch: b is earlier → b wins
  });
});
