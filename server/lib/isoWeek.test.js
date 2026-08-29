import { describe, expect, it } from 'vitest';
import {
  getIsoWeekNumber,
  getIsoWeekYear,
  getWeekId,
  isoWeekParts,
  isoWeeksInYear,
  parseWeekId,
} from './isoWeek.js';

// Local-calendar dates: the week id is a local-day concept, so build the
// fixtures the same way a caller would (`new Date(agent.completedAt)`).
const on = (year, month, day) => new Date(year, month - 1, day);

describe('getWeekId', () => {
  it('gives one id to the ISO week that straddles New Year (#3465)', () => {
    // Mon 2025-12-29 and Thu 2026-01-01 are the SAME ISO week. The pre-#3465
    // helper stamped them '2025-W01' and '2026-W01'.
    expect(getWeekId(on(2025, 12, 29))).toBe('2026-W01');
    expect(getWeekId(on(2026, 1, 1))).toBe('2026-W01');
    expect(getWeekId(on(2025, 12, 29))).toBe(getWeekId(on(2026, 1, 1)));
  });

  it('keeps the early-January week of a mid-week Jan 1 distinct from the December one', () => {
    // The collision half: both weeks used to stamp '2025-W01', so the December
    // digest overwrote the January one on disk.
    expect(getWeekId(on(2025, 1, 1))).toBe('2025-W01');
    expect(getWeekId(on(2025, 1, 1))).not.toBe(getWeekId(on(2025, 12, 29)));
  });

  it('files late December under the following year when the week belongs to it', () => {
    expect(getWeekId(on(2024, 12, 30))).toBe('2025-W01');
    expect(getWeekId(on(2025, 12, 28))).toBe('2025-W52');
  });

  it('files early January under the previous year when the week belongs to it', () => {
    // 2026 is a leap-week year, so its W53 runs through Sun 2027-01-03.
    expect(getWeekId(on(2027, 1, 1))).toBe('2026-W53');
    expect(getWeekId(on(2027, 1, 3))).toBe('2026-W53');
    expect(getWeekId(on(2027, 1, 4))).toBe('2027-W01');
  });

  it('numbers the 53rd week of a leap-week year', () => {
    expect(getWeekId(on(2026, 12, 27))).toBe('2026-W52');
    expect(getWeekId(on(2026, 12, 28))).toBe('2026-W53');
    expect(getWeekId(on(2020, 12, 28))).toBe('2020-W53');
  });

  it('zero-pads single-digit week numbers', () => {
    expect(getWeekId(on(2026, 3, 4))).toBe('2026-W10');
    expect(getWeekId(on(2026, 2, 9))).toBe('2026-W07');
  });

  it('holds every day of one ISO week on the same id', () => {
    const ids = [29, 30, 31].map(day => getWeekId(on(2025, 12, day)))
      .concat([1, 2, 3, 4].map(day => getWeekId(on(2026, 1, day))));
    expect(new Set(ids)).toEqual(new Set(['2026-W01']));
  });
});

describe('isoWeekParts / getIsoWeekNumber / getIsoWeekYear', () => {
  it('splits a boundary date into the numbering year, not the calendar year', () => {
    expect(isoWeekParts(on(2025, 12, 29))).toEqual({ year: 2026, week: 1 });
    expect(getIsoWeekYear(on(2025, 12, 29))).toBe(2026);
    expect(getIsoWeekNumber(on(2025, 12, 29))).toBe(1);
  });

  it('agrees with the calendar year away from the boundary', () => {
    expect(isoWeekParts(on(2026, 6, 15))).toEqual({ year: 2026, week: 25 });
  });
});

describe('isoWeeksInYear', () => {
  it('reports 52 for an ordinary year and 53 for a leap-week year', () => {
    expect(isoWeeksInYear(2024)).toBe(52);
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2015)).toBe(53);
  });
});

describe('parseWeekId', () => {
  it('parses a well-formed id', () => {
    expect(parseWeekId('2026-W01')).toEqual({ year: 2026, week: 1 });
    expect(parseWeekId('2026-W53')).toEqual({ year: 2026, week: 53 });
  });

  it('returns null rather than NaN for anything else', () => {
    for (const bad of ['', '2026', '2026-01', 'W01', '2026-W', '2026-W00', '2026-W54', null, undefined, 20261, {}]) {
      expect(parseWeekId(bad)).toBeNull();
    }
  });
});
