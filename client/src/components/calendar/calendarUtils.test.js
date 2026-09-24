import { describe, it, expect } from 'vitest';

import { buildSubcalendarColorMap, eventChipStyle, eventOccursOnDay } from './calendarUtils';
import { chipColors, parseColor, contrastRatio, chipBackdrop } from '../../lib/chipContrast';

describe('eventOccursOnDay', () => {
  const day = (date) => new Date(2026, 8, date);
  const event = (start, end, isAllDay = true) => ({
    startTime: day(start).toISOString(), endTime: day(end).toISOString(), isAllDay,
  });

  it('treats the end midnight as exclusive for one-day and three-day all-day events', () => {
    const oneDay = event(23, 24);
    expect([22, 23, 24].map(date => eventOccursOnDay(oneDay, day(date))))
      .toEqual([false, true, false]);

    const threeDays = event(21, 24);
    expect([20, 21, 22, 23, 24].map(date => eventOccursOnDay(threeDays, day(date))))
      .toEqual([false, true, true, true, false]);
  });

  it('includes an all-day event that began before the visible range', () => {
    expect(eventOccursOnDay(event(19, 22), day(21))).toBe(true);
  });

  it('handles a timed event crossing midnight and rejects an end at midnight', () => {
    const overnight = {
      startTime: new Date(2026, 8, 23, 23).toISOString(),
      endTime: new Date(2026, 8, 24, 1).toISOString(),
      isAllDay: false,
    };
    expect(eventOccursOnDay(overnight, day(23))).toBe(true);
    expect(eventOccursOnDay(overnight, day(24))).toBe(true);
    expect(eventOccursOnDay(overnight, day(25))).toBe(false);
    expect(eventOccursOnDay({ ...overnight, endTime: day(24).toISOString() }, day(24))).toBe(false);
  });

  it('uses local midnight across daylight-saving transitions', () => {
    const spring = {
      startTime: new Date(2026, 2, 7).toISOString(),
      endTime: new Date(2026, 2, 9).toISOString(),
      isAllDay: true,
    };
    expect(eventOccursOnDay(spring, new Date(2026, 2, 8))).toBe(true);
    expect(eventOccursOnDay(spring, new Date(2026, 2, 9))).toBe(false);
  });
});

describe('buildSubcalendarColorMap', () => {
  it('flattens every account\'s colored subcalendars into one id → color map', () => {
    const map = buildSubcalendarColorMap([
      { subcalendars: [{ calendarId: 'a', color: '#fef2c0' }, { calendarId: 'b', color: null }] },
      { subcalendars: [{ calendarId: 'c', color: '#3b82f6' }] },
    ]);
    expect(map.get('a')).toBe('#fef2c0');
    expect(map.get('c')).toBe('#3b82f6');
    // A subcalendar with no color is omitted, so the caller's `|| null` branch
    // (the neutral chip) is what runs.
    expect(map.has('b')).toBe(false);
  });

  it('tolerates missing accounts / subcalendars', () => {
    expect(buildSubcalendarColorMap(undefined).size).toBe(0);
    expect(buildSubcalendarColorMap([{}]).size).toBe(0);
  });
});

describe('eventChipStyle', () => {
  // Google's subcalendar palette includes several pale entries; #fbd75b is one
  // of the pale ones the day themes rendered at ~1.2:1.
  const PALE = '#fbd75b';

  it('grades the subcalendar color for the mode it is handed', () => {
    expect(eventChipStyle(PALE, 'day')).toEqual(chipColors(PALE, 'day'));
    // parseColor on both sides — the point is that the two modes disagree, and
    // a hardcoded mode would make them identical.
    expect(parseColor(eventChipStyle(PALE, 'day').color))
      .not.toEqual(parseColor(eventChipStyle(PALE, 'night').color));
  });

  it('clears WCAG AA against the chip\'s own backdrop on both modes', () => {
    for (const mode of ['day', 'night']) {
      const graded = parseColor(eventChipStyle(PALE, mode).color);
      expect(contrastRatio(graded, chipBackdrop(parseColor(PALE), mode))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('falls back to the accent chip when there is no usable color', () => {
    for (const missing of [null, undefined, '', 'rebeccapurple']) {
      const style = eventChipStyle(missing, 'day');
      // Regression guard for `var(--port-accent, #3b82f6)`: `--port-accent` is a
      // space-separated triple, so that idiom resolved to `59 130 246` — not a
      // color — and the browser dropped the declaration entirely.
      expect(style.color).toMatch(/^rgb\(var\(--port-accent/);
      expect(style.borderColor).toMatch(/^rgb\(var\(--port-accent/);
      expect(style.backgroundColor).toMatch(/^rgb\(var\(--port-accent/);
    }
  });
});
