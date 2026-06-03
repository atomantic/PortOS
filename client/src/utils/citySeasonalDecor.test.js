import { describe, it, expect } from 'vitest';
import {
  SEASONAL_DECOR,
  SEASONS,
  HOLIDAYS,
  resolveSeason,
  resolveHoliday,
  placeDecorations,
  computeSeasonalDecor,
} from './citySeasonalDecor';

// Build a Date for a fixed (month, day) — month is 1-based here for readability.
const on = (month, day) => new Date(2025, month - 1, day, 12, 0, 0);

describe('resolveSeason', () => {
  it('maps months to the northern-hemisphere season', () => {
    expect(resolveSeason(on(1, 15)).id).toBe('winter');
    expect(resolveSeason(on(2, 15)).id).toBe('winter');
    expect(resolveSeason(on(4, 15)).id).toBe('spring');
    expect(resolveSeason(on(7, 15)).id).toBe('summer');
    expect(resolveSeason(on(10, 15)).id).toBe('autumn');
    expect(resolveSeason(on(12, 15)).id).toBe('winter');
  });

  it('defaults to winter for a non-Date input (city is never undressed)', () => {
    expect(resolveSeason(null).id).toBe('winter');
    expect(resolveSeason(undefined).id).toBe('winter');
    expect(resolveSeason('nope').id).toBe('winter');
  });
});

describe('resolveHoliday', () => {
  it('matches a non-wrapping window inclusively', () => {
    expect(resolveHoliday(on(10, 25))?.id).toBe('halloween');
    expect(resolveHoliday(on(10, 31))?.id).toBe('halloween');
    expect(resolveHoliday(on(10, 24))).toBeNull(); // day before the window
    expect(resolveHoliday(on(11, 1))).toBeNull(); // day after
  });

  it('matches a year-wrapping window across the Dec→Jan seam', () => {
    expect(resolveHoliday(on(12, 31))?.id).toBe('new-year');
    expect(resolveHoliday(on(1, 1))?.id).toBe('new-year');
    expect(resolveHoliday(on(1, 2))).toBeNull(); // out of the New Year window
  });

  it('lets a more-specific window win (New Year over winter-holidays on Dec 31)', () => {
    // Dec 31 is inside the winter-holidays season feel, but New Year is listed first.
    expect(resolveHoliday(on(12, 31))?.id).toBe('new-year');
    // Dec 25 is only inside winter-holidays.
    expect(resolveHoliday(on(12, 25))?.id).toBe('winter-holidays');
  });

  it('returns null when no holiday is active or input is not a Date', () => {
    expect(resolveHoliday(on(2, 14))).toBeNull();
    expect(resolveHoliday(null)).toBeNull();
    expect(resolveHoliday('nope')).toBeNull();
  });

  it('every holiday entry has well-formed window tuples + palette fields', () => {
    for (const h of HOLIDAYS) {
      expect(typeof h.color).toBe('string');
      expect(typeof h.accent).toBe('string');
      expect(typeof h.label).toBe('string');
      expect(typeof h.prop).toBe('string');
      for (const tuple of [h.start, h.end]) {
        expect(tuple).toHaveLength(2);
        const [month, day] = tuple;
        expect(month).toBeGreaterThanOrEqual(1);
        expect(month).toBeLessThanOrEqual(12);
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(31);
      }
    }
  });
});

describe('placeDecorations', () => {
  it('places the configured count by default', () => {
    expect(placeDecorations('winter')).toHaveLength(SEASONAL_DECOR.count);
  });

  it('is deterministic for a given theme id (stable across calls)', () => {
    expect(placeDecorations('summer')).toEqual(placeDecorations('summer'));
  });

  it('differs between theme ids', () => {
    const a = placeDecorations('winter');
    const b = placeDecorations('halloween');
    expect(a[0].position).not.toEqual(b[0].position);
  });

  it('each decoration carries an id, a 3-tuple position, and a 0..1 phase', () => {
    for (const d of placeDecorations('autumn')) {
      expect(typeof d.id).toBe('string');
      expect(d.position).toHaveLength(3);
      expect(d.phase).toBeGreaterThanOrEqual(0);
      expect(d.phase).toBeLessThanOrEqual(1);
    }
  });
});

describe('computeSeasonalDecor', () => {
  it('always returns a theme (hasData is always true — the city is never undressed)', () => {
    expect(computeSeasonalDecor(on(2, 14)).hasData).toBe(true);
    expect(computeSeasonalDecor(null).hasData).toBe(true);
  });

  it('uses the season when no holiday is active', () => {
    const vm = computeSeasonalDecor(on(7, 15)); // summer, no holiday
    expect(vm.isHoliday).toBe(false);
    expect(vm.themeId).toBe('summer');
    expect(vm.label).toBe(SEASONS.summer.label);
    expect(vm.season).toBe('summer');
  });

  it('overrides the season palette with a holiday when one is active', () => {
    const vm = computeSeasonalDecor(on(10, 31)); // Halloween, season autumn
    expect(vm.isHoliday).toBe(true);
    expect(vm.themeId).toBe('halloween');
    expect(vm.season).toBe('autumn'); // season still carried
    expect(vm.color).toBe(HOLIDAYS.find((h) => h.id === 'halloween').color);
  });

  it('places one decoration per configured slot and carries the ring base', () => {
    const vm = computeSeasonalDecor(on(4, 15));
    expect(vm.total).toBe(SEASONAL_DECOR.count);
    expect(vm.decorations).toHaveLength(SEASONAL_DECOR.count);
    expect(vm.base).toEqual(SEASONAL_DECOR.base);
  });
});
