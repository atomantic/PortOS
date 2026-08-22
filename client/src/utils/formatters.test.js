import { describe, it, expect } from 'vitest';
import {
  clamp, formatContextLength, formatDurationMin, formatDurationMs, formatEventDateTime, timeAgo, formatAgeDays,
  formatCooldown, recommendedRamGb, parseTimeoutMs, formatDurationSec, middleTruncate,
  formatWeight, formatPercent, formatUsd, formatBytes,
  formatDateNumeric, formatTimeOfDaySeconds, formatClockTime, formatWeekdayDate,
  formatMonthDay, formatMonthYear, formatWeekdayShort, formatWeekdayTime, formatDateFull, formatDateShort, formatDateTime,
} from './formatters.js';

describe('clamp', () => {
  it('returns value unchanged when within [min, max]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('clamps values below min to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(-0.1, 0, 1)).toBe(0);
  });

  it('clamps values above max to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it('handles negative ranges correctly', () => {
    expect(clamp(-15, -10, -5)).toBe(-10);
    expect(clamp(0, -10, -5)).toBe(-5);
    expect(clamp(-7, -10, -5)).toBe(-7);
  });

  it('handles min equal to max', () => {
    expect(clamp(5, 10, 10)).toBe(10);
    expect(clamp(15, 10, 10)).toBe(10);
  });
});

describe('formatBytes', () => {
  it('renders whole-MB file-size caps with no decimals at decimals=0', () => {
    // The shape the "file too large" toasts depend on (issue #3869).
    expect(formatBytes(12 * 1024 * 1024, 0)).toBe('12 MB');
    expect(formatBytes(35 * 1024 * 1024, 0)).toBe('35 MB');
    expect(formatBytes(50 * 1024 * 1024, 0)).toBe('50 MB');
  });

  it('rounds a non-round cap to the nearest whole unit at decimals=0', () => {
    expect(formatBytes(9_999_999, 0)).toBe('10 MB');
  });
});

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

describe('formatUsd', () => {
  it('renders cents by default and treats a missing amount as zero', () => {
    expect(formatUsd(12.3)).toBe('$12.30');
    expect(formatUsd(null)).toBe('$0.00');
  });

  // The minus belongs OUTSIDE the dollar sign, so a negative saving reads as a
  // loss instead of as a malformed currency string.
  it('puts the sign before the dollar sign when signed', () => {
    expect(formatUsd(-5, { signed: true })).toBe('-$5.00');
    expect(formatUsd(5, { signed: true })).toBe('$5.00');
  });

  it('trims .00 only when asked', () => {
    expect(formatUsd(200, { trimWhole: true })).toBe('$200');
    expect(formatUsd(19.99, { trimWhole: true })).toBe('$19.99');
    expect(formatUsd(200)).toBe('$200.00');
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

  // Callers whose surrounding prose already says "tokens of context" drop the
  // badge suffix rather than keeping a near-copy of this function.
  it('drops the suffix when asked, across every magnitude bucket', () => {
    expect(formatContextLength(512, { suffix: '' })).toBe('512');
    expect(formatContextLength(4096, { suffix: '' })).toBe('4K');
    expect(formatContextLength(1048576, { suffix: '' })).toBe('1M');
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

  it("renders an empty string for malformed/missing input on BOTH branches (#3870)", () => {
    // Used to pass the raw "Invalid Date" string through for migration
    // fidelity. Once the all-day branch started routing through formatDateFull's
    // guard, one branch was guarded and one was not; both now follow the
    // module-wide fallback contract.
    expect(formatEventDateTime('not-a-date')).toBe('');
    expect(formatEventDateTime('not-a-date', { allDay: true })).toBe('');
    expect(formatEventDateTime(null)).toBe('');
    expect(formatEventDateTime('')).toBe('');
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

describe('formatAgeDays', () => {
  const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

  it('returns the fallback for a missing or unparseable value', () => {
    expect(formatAgeDays(null)).toBe('');
    expect(formatAgeDays('', 'unknown')).toBe('unknown');
    expect(formatAgeDays('not-a-date', '—')).toBe('—');
  });

  it('counts whole days rather than collapsing into month/year buckets', () => {
    expect(formatAgeDays(daysAgo(1))).toBe('1 day ago');
    expect(formatAgeDays(daysAgo(3))).toBe('3 days ago');
    // timeAgo would say '13mo ago' here — the day count is the point.
    expect(formatAgeDays(daysAgo(412))).toBe('412 days ago');
  });

  it('anchors a bare calendar date at local midnight so it never reads a day older', () => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(formatAgeDays(iso)).toBe('today');
  });

  it('reads a same-day or future-dated publish as today, never a negative count', () => {
    expect(formatAgeDays(new Date().toISOString())).toBe('today');
    expect(formatAgeDays(new Date(Date.now() + 3600 * 1000).toISOString())).toBe('today');
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

describe('recommendedRamGb', () => {
  it('uses exact bytes when provided', () => {
    // 4 GB in bytes: 4 * 1024^3 = 4294967296; + 20% overhead = 4.8 → ceil = 5
    expect(recommendedRamGb(4 * 1024 ** 3, null)).toBe(5);
  });

  it('falls back to size string when bytes are null', () => {
    // 4.7 GB string: 4.7 * 1.2 = 5.64 → ceil = 6
    expect(recommendedRamGb(null, '4.7 GB')).toBe(6);
    // 1 GB string: 1 * 1.2 = 1.2 → ceil = 2
    expect(recommendedRamGb(null, '1GB')).toBe(2);
    // 512 MB string: 0.5 * 1.2 = 0.6 → ceil = 1 (floor)
    expect(recommendedRamGb(null, '512 MB')).toBe(1);
    // 2 TB string: 2048 * 1.2 = 2457.6 → ceil = 2458
    expect(recommendedRamGb(null, '2 TB')).toBe(2458);
  });

  it('returns null when both inputs are absent or unparseable', () => {
    expect(recommendedRamGb(null, null)).toBeNull();
    expect(recommendedRamGb(undefined, undefined)).toBeNull();
    expect(recommendedRamGb(null, 'not a size')).toBeNull();
    expect(recommendedRamGb(null, '')).toBeNull();
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

describe('canonical date/time formatters (#3870)', () => {
  // The helpers below replaced ~60 inline `new Date(x).toLocaleDateString()`
  // calls across components. These assert the two contracts that inline call
  // sites got wrong or hand-rolled: local-midnight anchoring of a bare
  // calendar date, and a caller-chosen fallback instead of "Invalid Date".

  describe('formatDateNumeric', () => {
    it('anchors a bare YYYY-MM-DD at LOCAL midnight, not UTC', () => {
      // `new Date('2026-03-05')` is UTC midnight, which renders as Mar 4 in any
      // negative-offset zone — the reason call sites appended 'T00:00:00' by hand.
      expect(formatDateNumeric('2026-03-05')).toBe(new Date(2026, 2, 5).toLocaleDateString());
    });

    it('renders a full ISO timestamp and a Date the same way', () => {
      const d = new Date(2026, 2, 5, 13, 30);
      expect(formatDateNumeric(d)).toBe(formatDateNumeric(d.toISOString()));
    });

    it('returns the fallback for missing/blank/unparseable input', () => {
      expect(formatDateNumeric(null)).toBe('');
      expect(formatDateNumeric(undefined)).toBe('');
      expect(formatDateNumeric('')).toBe('');
      expect(formatDateNumeric('not-a-date', '—')).toBe('—');
      expect(formatDateNumeric(null, '—')).toBe('—');
    });
  });

  describe('formatTimeOfDaySeconds', () => {
    it('includes seconds and honors the fallback', () => {
      expect(formatTimeOfDaySeconds(new Date(2026, 2, 5, 14, 30, 45))).toMatch(/\b30\D+45\b/);
      expect(formatTimeOfDaySeconds(null)).toBe('');
      expect(formatTimeOfDaySeconds('garbage', '—')).toBe('—');
    });
  });

  describe('formatClockTime', () => {
    const at = new Date(2026, 2, 5, 14, 30, 45);

    it('includes seconds by default and drops them with seconds:false', () => {
      expect(formatClockTime(at)).toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(formatClockTime(at, { seconds: false })).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('forces a 24-hour clock with hour12:false', () => {
      expect(formatClockTime(at, { hour12: false })).toContain('14:30:45');
    });

    it('accepts an ISO string, not just a Date, and falls back on missing input', () => {
      expect(formatClockTime(at.toISOString())).toBe(formatClockTime(at));
      expect(formatClockTime(null)).toBe('');
    });
  });

  describe('formatWeekdayDate', () => {
    const day = new Date(2026, 2, 5);

    it('appends the year only when asked', () => {
      expect(formatWeekdayDate(day, { year: true })).toContain('2026');
      expect(formatWeekdayDate(day)).not.toContain('2026');
    });

    it('shortens the weekday on request', () => {
      const long = formatWeekdayDate(day);
      const short = formatWeekdayDate(day, { weekday: 'short' });
      expect(short.length).toBeLessThan(long.length);
    });

    it('anchors a bare calendar date locally', () => {
      expect(formatWeekdayDate('2026-03-05')).toBe(formatWeekdayDate(day));
    });
  });

  describe('formatMonthDay / formatMonthYear / formatWeekdayShort', () => {
    const day = new Date(2026, 2, 5);

    it('renders the day without a year, and the month without a day', () => {
      expect(formatMonthDay(day)).toContain('5');
      expect(formatMonthDay(day)).not.toContain('2026');
      expect(formatMonthYear(day)).toContain('2026');
      expect(formatMonthYear(day)).not.toContain('5');
    });

    it('renders an abbreviated weekday', () => {
      expect(formatWeekdayShort(day)).toMatch(/^[A-Za-z.]{2,5}$/);
    });

    it('formatWeekdayTime pairs the weekday with a time and drops the date', () => {
      const out = formatWeekdayTime(new Date(2026, 2, 5, 7, 0));
      expect(out).toMatch(/^[A-Za-z.]{2,5}\b/);
      expect(out).toContain('7');
      expect(out).not.toContain('2026');
      expect(formatWeekdayTime(null)).toBe('');
      expect(formatWeekdayTime('nope')).toBe('');
    });

    it('falls back rather than rendering "Invalid Date"', () => {
      expect(formatMonthDay('nope', '—')).toBe('—');
      expect(formatMonthYear(null)).toBe('');
      expect(formatWeekdayShort(null)).toBe('');
    });
  });

  describe('formatDateFull / formatDateShort', () => {
    it('formatDateFull accepts a bare calendar date string', () => {
      expect(formatDateFull('2026-03-05')).toBe(formatDateFull(new Date(2026, 2, 5)));
      expect(formatDateFull('2026-03-05')).toContain('2026');
    });

    it('formatDateFull returns "" instead of throwing on bad input', () => {
      expect(formatDateFull(null)).toBe('');
      expect(formatDateFull('nope')).toBe('');
    });

    it('formatDateShort keeps its em-dash fallback and anchors bare dates locally', () => {
      expect(formatDateShort(null)).toBe('—');
      expect(formatDateShort('nope')).toBe('—');
      expect(formatDateShort('2026-03-05')).toBe(formatDateShort(new Date(2026, 2, 5)));
    });
  });

  describe('formatDateTime', () => {
    it('takes a caller-supplied fallback for missing/invalid input', () => {
      expect(formatDateTime(null)).toBe('Unknown time');
      expect(formatDateTime(null, '—')).toBe('—');
      expect(formatDateTime('', 'Never')).toBe('Never');
      expect(formatDateTime('not-a-date', '—')).toBe('—');
    });

    it('anchors a bare calendar date locally', () => {
      expect(formatDateTime('2026-03-05')).toBe(formatDateTime(new Date(2026, 2, 5)));
    });
  });
});
// @vitest-environment node
