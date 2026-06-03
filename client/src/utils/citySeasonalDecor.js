// Pure, deterministic helpers for CyberCity's "seasonal decorations" (roadmap 3.5 follow-up,
// #824): date-driven city dressing that layers a holiday/seasonal theme onto the existing
// districts. The active theme is DERIVED from a date passed in by the caller — nothing here
// calls `new Date()` so the resolver is fully unit-testable for specific days (mirrors the
// "inject the input" rule the rest of the city helpers follow). No three.js / React imports.
//
// A "season" is the broad quarter (winter/spring/summer/autumn); a "holiday" is a tighter
// date window (e.g. the winter-holidays week, Halloween) that overrides the season's palette
// and adds a few extra accent decorations. When no holiday matches, the broad season still
// dresses the city with a subtle ambient palette + scattered decorations. There is always a
// theme — the city is never undressed — but each theme is intentionally low-key so it reads
// as seasonal flavor rather than clutter.

import { hashString } from './hashString';

// Decoration placement: a loose ring of accent props around the city center, well clear of the
// building cluster and the achievement/goal districts. Deterministic seeded scatter so the
// dressing doesn't reshuffle across refetches.
export const SEASONAL_DECOR = {
  base: [0, 0, 0], // ring is centered on the city origin; banner anchors here
  ringRadius: 70, // distance from origin — outside the active districts
  ringY: 0.5, // resting height of a ground decoration
  count: 8, // decorations placed around the ring per theme
  propSize: 2.2,
};

// Broad seasons keyed by an integer 0..3 the resolver computes from the month. Northern-
// hemisphere mapping (the install's locale is its own concern; this is a flavor layer, not a
// calendar API). Colors reuse PortOS Tailwind design tokens / the city's neon palette.
export const SEASONS = {
  winter: { id: 'winter', label: 'WINTER', color: '#3b82f6', accent: '#93c5fd', prop: 'crystal' }, // port-accent / icy
  spring: { id: 'spring', label: 'SPRING', color: '#22c55e', accent: '#86efac', prop: 'bloom' }, // port-success / green
  summer: { id: 'summer', label: 'SUMMER', color: '#f59e0b', accent: '#fcd34d', prop: 'beam' }, // port-warning / gold
  autumn: { id: 'autumn', label: 'AUTUMN', color: '#f97316', accent: '#fdba74', prop: 'leaf' }, // orange
};

// Holiday windows — tighter date ranges that override the season palette and bump the glow.
// Each entry is an inclusive [month, day] start .. [month, day] end window (1-based month).
// `wrapsYear` marks a window that straddles Dec→Jan (e.g. New Year). Kept deliberately small and
// culture-light; this is ambient dressing, not a comprehensive holiday calendar.
export const HOLIDAYS = [
  {
    id: 'new-year',
    label: 'NEW YEAR',
    color: '#fcd34d',
    accent: '#fde68a',
    prop: 'firework',
    start: [12, 31],
    end: [1, 1],
    wrapsYear: true,
  },
  {
    id: 'winter-holidays',
    label: 'WINTER HOLIDAYS',
    color: '#ef4444',
    accent: '#22c55e',
    prop: 'lights',
    start: [12, 20],
    end: [12, 30],
  },
  {
    id: 'spring-bloom',
    label: 'SPRING BLOOM',
    color: '#ec4899',
    accent: '#f9a8d4',
    prop: 'bloom',
    start: [3, 20],
    end: [3, 27],
  },
  {
    id: 'midsummer',
    label: 'MIDSUMMER',
    color: '#f59e0b',
    accent: '#fde68a',
    prop: 'beam',
    start: [6, 19],
    end: [6, 25],
  },
  {
    id: 'halloween',
    label: 'HALLOWEEN',
    color: '#f97316',
    accent: '#a855f7',
    prop: 'pumpkin',
    start: [10, 25],
    end: [10, 31],
  },
];

// Map a 1-based month to a broad season id. Dec/Jan/Feb → winter, etc.
function seasonForMonth(month) {
  if (month === 12 || month === 1 || month === 2) return 'winter';
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  return 'autumn';
}

// True when (month, day) falls inside a holiday window. Handles a window that wraps the year
// boundary (start month/day later than end month/day).
function inHolidayWindow(month, day, holiday) {
  const [sm, sd] = holiday.start;
  const [em, ed] = holiday.end;
  const afterStart = month > sm || (month === sm && day >= sd);
  const beforeEnd = month < em || (month === em && day <= ed);
  // A non-wrapping window is a simple AND; a year-wrapping window is an OR (after-start OR
  // before-end), since the valid range spans the Dec→Jan seam.
  return holiday.wrapsYear ? afterStart || beforeEnd : afterStart && beforeEnd;
}

// Resolve the active holiday for a date, or null. First match wins (HOLIDAYS is ordered most-
// specific first so New Year beats the broader winter-holidays week on Dec 31). Accepts any
// value with `.getMonth()` / `.getDate()`; a non-Date returns null (no holiday).
export function resolveHoliday(date) {
  if (!date || typeof date.getMonth !== 'function' || typeof date.getDate !== 'function') {
    return null;
  }
  const month = date.getMonth() + 1; // getMonth() is 0-based
  const day = date.getDate();
  for (const h of HOLIDAYS) {
    if (inHolidayWindow(month, day, h)) return h;
  }
  return null;
}

// Resolve the active broad season for a date. Returns the winter season as a safe default for a
// non-Date input so the city always has a theme.
export function resolveSeason(date) {
  if (!date || typeof date.getMonth !== 'function') return SEASONS.winter;
  return SEASONS[seasonForMonth(date.getMonth() + 1)];
}

// Place `count` decorations around the city ring, seeded by the theme id so the scatter is
// stable per-theme but differs between themes. Decorations alternate slightly in radius so the
// ring doesn't read as a perfect circle.
export function placeDecorations(themeId, count = SEASONAL_DECOR.count) {
  const decorations = [];
  for (let i = 0; i < count; i += 1) {
    const seed = hashString(`${themeId}-${i}`);
    const angle = (i / count) * Math.PI * 2 + (seed % 30) / 100; // even spread + small jitter
    const radius = SEASONAL_DECOR.ringRadius + ((seed >> 3) % 12) - 6; // ±6 radial jitter
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    decorations.push({
      id: `${themeId}-decor-${i}`,
      position: [Number(x.toFixed(3)), SEASONAL_DECOR.ringY, Number(z.toFixed(3))],
      // Per-decoration phase so a shared shimmer driver can offset each one.
      phase: (seed % 100) / 100,
    });
  }
  return decorations;
}

// Full derived view-model for the seasonal-decor component. Inject the date so the season is
// deterministic in tests. A holiday (when matched) supersedes the broad season for palette +
// prop + label, but the season id is always carried so the component can still reason about the
// time of year. There is always a theme → `hasData` is always true (the city is never undressed).
export function computeSeasonalDecor(date) {
  const season = resolveSeason(date);
  const holiday = resolveHoliday(date);
  const theme = holiday || season;
  const decorations = placeDecorations(theme.id);

  return {
    base: SEASONAL_DECOR.base,
    season: season.id,
    seasonLabel: season.label,
    isHoliday: !!holiday,
    themeId: theme.id,
    label: theme.label,
    color: theme.color,
    accent: theme.accent,
    prop: theme.prop,
    decorations,
    total: decorations.length,
    hasData: true,
  };
}
