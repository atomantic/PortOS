import { describe, it, expect } from 'vitest';
import {
  formatContextLength, formatDurationMin, formatDurationMs, formatEventDateTime, timeAgo,
  formatCooldown, parseSizeGb, recommendedRamGb, parseTimeoutMs, formatDurationSec, middleTruncate,
  formatWeight, formatPercent,
} from './formatters.js';

describe('formatWeight', () => {
  it('rounds unit-conversion float noise to one decimal', () => {
    expect(formatWeight(170.35000000000002)).toBe('170.4 lbs');
    expect(formatWeight(88.88888)).toBe('88.9 lbs');
  });

  it('drops trailing zeros instead of padding', () => {
    expect(formatWeight(180)).toBe('180 lbs');
    expect(formatWeight(180.0000001)).toBe('180 lbs');
  });

  it('honors unit, decimals, and fallback overrides', () => {
    expect(formatWeight(77.2345, { unit: 'kg' })).toBe('77.2 kg');
    expect(formatWeight(77.2345, { unit: 'kg', decimals: 2 })).toBe('77.23 kg');
    expect(formatWeight(12.345, { unit: '' })).toBe('12.3');
  });

  it('falls back for missing or non-numeric values', () => {
    expect(formatWeight(null)).toBe('—');
    expect(formatWeight(undefined)).toBe('—');
    expect(formatWeight('')).toBe('—');
    expect(formatWeight('heavy')).toBe('—');
    expect(formatWeight(NaN)).toBe('—');
    expect(formatWeight(Infinity)).toBe('—');
    expect(formatWeight(null, { fallback: 'n/a' })).toBe('n/a');
    // Values that coerce to 0 must not render as a real measurement.
    expect(formatWeight('   ')).toBe('—');
    expect(formatWeight(false)).toBe('—');
    expect(formatWeight([])).toBe('—');
  });

  it('keeps a legitimate zero rather than treating it as missing', () => {
    expect(formatWeight(0)).toBe('0 lbs');
  });

  it('accepts numeric strings', () => {
    expect(formatWeight('170.35000000000002')).toBe('170.4 lbs');
  });
});

describe('formatPercent', () => {
  it('rounds float noise and suffixes a percent sign', () => {
    expect(formatPercent(18.400000000000002)).toBe('18.4%');
    expect(formatPercent(42)).toBe('42%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('honors decimals and fallback overrides', () => {
    expect(formatPercent(18.4567, { decimals: 2 })).toBe('18.46%');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(null, { fallback: '?' })).toBe('?');
  });
});

describe('formatDurationSec', () => {
  it('formats seconds as M:SS with a zero-padded seconds field', () => {
    expect(formatDurationSec(75)).toBe('1:15');
    expect(formatDurationSec(5)).toBe('0:05');
    expect(formatDurationSec(600)).toBe('10:00');
  });

  it('renders a genuine zero as "0:00" (not the unknown dash)', () => {
    // Distinguishes "zero seconds" from "unknown" — the ruler and totals rely
    // on 0 → "0:00" rather than the old truthiness collapse to "—".
    expect(formatDurationSec(0)).toBe('0:00');
  });

  it('returns the unknown dash for missing/invalid/negative input', () => {
    expect(formatDurationSec(null)).toBe('—');
    expect(formatDurationSec(undefined)).toBe('—');
    expect(formatDurationSec(NaN)).toBe('—');
    expect(formatDurationSec(-3)).toBe('—');
  });
});

describe('formatContextLength', () => {
  it('formats common context windows compactly', () => {
    expect(formatContextLength(4096)).toBe('4K ctx');
    expect(formatContextLength(8192)).toBe('8K ctx');
    expect(formatContextLength(32768)).toBe('32K ctx');
    expect(formatContextLength(131072)).toBe('128K ctx');
    expect(formatContextLength(1048576)).toBe('1M ctx');
  });

  it('returns null for missing/invalid values', () => {
    expect(formatContextLength(null)).toBeNull();
    expect(formatContextLength(undefined)).toBeNull();
    expect(formatContextLength(0)).toBeNull();
    expect(formatContextLength(-5)).toBeNull();
    expect(formatContextLength('nope')).toBeNull();
  });
});

describe('formatDurationMs', () => {
  it('formats sub-minute, minute, and hour buckets', () => {
    expect(formatDurationMs(0)).toBe('0s');
    expect(formatDurationMs(45_000)).toBe('45s');
    expect(formatDurationMs(72_000)).toBe('1m 12s');
    expect(formatDurationMs(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
  });

  it('buckets multi-day durations into days + hours', () => {
    expect(formatDurationMs(24 * 3_600_000)).toBe('1d 0h');
    expect(formatDurationMs(25 * 3_600_000)).toBe('1d 1h');
    expect(formatDurationMs(51 * 3_600_000)).toBe('2d 3h');
  });

  it('returns a dash for nullish input', () => {
    expect(formatDurationMs(null)).toBe('-');
    expect(formatDurationMs(undefined)).toBe('-');
  });
});

describe('formatDurationMin', () => {
  it('formats sub-hour, exact-hour, and hour+min durations', () => {
    expect(formatDurationMin(30)).toBe('30m');
    expect(formatDurationMin(60)).toBe('1h');
    expect(formatDurationMin(90)).toBe('1h 30m');
    expect(formatDurationMin(120)).toBe('2h');
  });

  it('returns empty string for null/undefined', () => {
    expect(formatDurationMin(null)).toBe('');
    expect(formatDurationMin(undefined)).toBe('');
  });

  it('does not prefix by default — existing callers stay unchanged', () => {
    expect(formatDurationMin(90)).toBe('1h 30m');
    expect(formatDurationMin(45)).toBe('45m');
  });

  it('prefixes with ~ when approximate (TaskItem estimate semantics)', () => {
    expect(formatDurationMin(30, { approximate: true })).toBe('~30m');
    expect(formatDurationMin(60, { approximate: true })).toBe('~1h');
    expect(formatDurationMin(210, { approximate: true })).toBe('~3h 30m');
  });

  it('tolerates a null options argument', () => {
    expect(formatDurationMin(90, null)).toBe('1h 30m');
  });
});

describe('formatEventDateTime', () => {
  // Local-time ISO (no trailing Z) so parsing is deterministic relative to
  // the test runtime's timezone.
  const sample = '2026-04-01T13:30:00';

  it('renders a timed event with short weekday + time', () => {
    expect(formatEventDateTime(sample)).toBe(
      new Date(sample).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    );
  });

  it('renders an all-day event as a full weekday + year date', () => {
    expect(formatEventDateTime(sample, { allDay: true })).toBe(
      new Date(sample).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    );
  });

  it('all-day and timed renderings differ', () => {
    expect(formatEventDateTime(sample, { allDay: true })).not.toBe(formatEventDateTime(sample));
  });

  it('tolerates a null options argument', () => {
    expect(formatEventDateTime(sample, null)).toBe(formatEventDateTime(sample));
  });

  it('passes malformed input straight through, like the original local formatter (no guard, by design)', () => {
    // The migration is deliberately behavior-identical: unparseable input
    // yields the raw toLocaleString result ("Invalid Date"), not an empty
    // string. Locks the no-guard decision so a future change does not re-add
    // a guard and silently alter the (unreachable) degenerate path.
    expect(formatEventDateTime('not-a-date')).toBe(
      new Date('not-a-date').toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    );
  });
});

describe('timeAgo', () => {
  it('returns the fallback for null/empty', () => {
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo('', 'n/a')).toBe('n/a');
  });

  it('returns the fallback for an unparseable date instead of "NaNy ago"', () => {
    expect(timeAgo('not-a-date')).toBe('never');
    expect(timeAgo('not-a-date', '—')).toBe('—');
  });

  it('formats a recent past date in days', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    expect(timeAgo(threeDaysAgo)).toBe('3d ago');
  });
});

describe('formatCooldown', () => {
  it('formats 0 ms as 0:00', () => {
    expect(formatCooldown(0)).toBe('0:00');
  });

  it('clamps negative values to 0:00', () => {
    expect(formatCooldown(-5000)).toBe('0:00');
    expect(formatCooldown(-1)).toBe('0:00');
  });

  it('formats 65000 ms (1 min 5 sec) as 1:05', () => {
    expect(formatCooldown(65000)).toBe('1:05');
  });

  it('formats exactly 60000 ms as 1:00', () => {
    expect(formatCooldown(60000)).toBe('1:00');
  });

  it('formats sub-minute values with leading zero seconds', () => {
    expect(formatCooldown(9000)).toBe('0:09');
    expect(formatCooldown(59000)).toBe('0:59');
  });
});

describe('parseSizeGb', () => {
  it('parses GB strings', () => {
    expect(parseSizeGb('4.7 GB')).toBeCloseTo(4.7);
    expect(parseSizeGb('1GB')).toBe(1);
  });

  it('parses MB strings (converts to fractional GB)', () => {
    const result = parseSizeGb('512 MB');
    expect(result).toBeCloseTo(0.5);
  });

  it('parses TB strings (converts to large GB)', () => {
    const result = parseSizeGb('2 TB');
    expect(result).toBeCloseTo(2048);
  });

  it('returns null for garbage input', () => {
    expect(parseSizeGb('not a size')).toBeNull();
    expect(parseSizeGb('')).toBeNull();
    expect(parseSizeGb(null)).toBeNull();
    expect(parseSizeGb(undefined)).toBeNull();
  });
});

describe('recommendedRamGb', () => {
  it('uses exact bytes when provided', () => {
    // 4 GB in bytes: 4 * 1024^3 = 4294967296; + 20% overhead = 4.8 → ceil = 5
    expect(recommendedRamGb(4 * 1024 ** 3, null)).toBe(5);
  });

  it('falls back to size string when bytes are null', () => {
    // 4.7 GB string: 4.7 * 1.2 = 5.64 → ceil = 6
    expect(recommendedRamGb(null, '4.7 GB')).toBe(6);
  });

  it('returns null when both inputs are absent', () => {
    expect(recommendedRamGb(null, null)).toBeNull();
    expect(recommendedRamGb(undefined, undefined)).toBeNull();
  });

  it('enforces a 1 GB floor for tiny models', () => {
    // 10 MB: 10/1024 GB * 1.2 < 1 → floor to 1
    expect(recommendedRamGb(10 * 1024 * 1024, null)).toBe(1);
  });
});

describe('parseTimeoutMs', () => {
  it('returns null for null/empty/blank', () => {
    expect(parseTimeoutMs(null)).toBeNull();
    expect(parseTimeoutMs(undefined)).toBeNull();
    expect(parseTimeoutMs('')).toBeNull();
    expect(parseTimeoutMs('   ')).toBeNull();
  });

  it('returns null for values below the 1000ms floor', () => {
    expect(parseTimeoutMs('999')).toBeNull();
    expect(parseTimeoutMs('0')).toBeNull();
  });

  it('accepts the minimum boundary (1000)', () => {
    expect(parseTimeoutMs('1000')).toBe(1000);
  });

  it('accepts the maximum boundary (12 hours)', () => {
    expect(parseTimeoutMs('43200000')).toBe(43200000);
  });

  it('returns null for values above the 12-hour ceiling', () => {
    expect(parseTimeoutMs('43200001')).toBeNull();
  });

  it('rejects scientific notation ("1e3") — digit-only gate', () => {
    expect(parseTimeoutMs('1e3')).toBeNull();
  });

  it('rejects decimal strings ("1.5") — must be integer digit-only', () => {
    expect(parseTimeoutMs('1.5')).toBeNull();
  });

  it('accepts a mid-range valid value', () => {
    expect(parseTimeoutMs('30000')).toBe(30000);
  });
});

describe('middleTruncate', () => {
  it('returns the string untouched when it already fits', () => {
    expect(middleTruncate('short name', 20)).toBe('short name');
    expect(middleTruncate('exactly-ten', 11)).toBe('exactly-ten');
  });

  it('keeps the distinguishing tail that an end-clip would eat', () => {
    const a = middleTruncate('Nightly Surreal Landscapes — 2026-08-01', 24);
    const b = middleTruncate('Nightly Surreal Landscapes — 2026-08-02', 24);
    expect(a).not.toBe(b);
    expect(a.endsWith('2026-08-01')).toBe(true);
    expect(a.length).toBe(24);
  });

  it('coerces nullish input to an empty string', () => {
    expect(middleTruncate(null, 10)).toBe('');
    expect(middleTruncate(undefined, 10)).toBe('');
  });

  it('falls back to a head slice when max cannot fit a middle', () => {
    expect(middleTruncate('abcdef', 2)).toBe('ab');
    expect(middleTruncate('abcdef', 0)).toBe('');
  });

  it('never splits a surrogate pair', () => {
    // Both cut points land inside an astral character; slicing by UTF-16 code
    // unit would emit a lone surrogate that renders as the replacement glyph.
    const out = middleTruncate('AAAAAAAAAAAAAAAA🎬BBBBBBBBBBBB🎬CCCC', 20);
    // Array.from groups a valid pair into one char above 0xFFFF; a LONE
    // surrogate survives as a single char inside the surrogate range.
    const lone = Array.from(out).filter((ch) => {
      const cp = ch.codePointAt(0);
      return cp >= 0xD800 && cp <= 0xDFFF;
    });
    expect(lone).toEqual([]);
    expect(Array.from(out)).toHaveLength(20);
  });

  it('counts the cap in code points, not UTF-16 units', () => {
    // 10 emoji = 20 code units but only 10 code points, so a cap of 10 fits.
    expect(middleTruncate('🎬'.repeat(10), 10)).toBe('🎬'.repeat(10));
  });

  it('returns the string whole for a non-finite cap instead of discarding it', () => {
    expect(middleTruncate('keep me', NaN)).toBe('keep me');
    expect(middleTruncate('keep me', Infinity)).toBe('keep me');
    expect(middleTruncate('keep me', undefined)).toBe('keep me');
  });
});
