// Pure, deterministic helpers for CyberCity's productivity-district activity heatmap
// (roadmap 2.6 follow-up, issue #817): a GitHub-style contribution grid rendered as a field
// of ground tiles laid out around the streak monument. Each tile is one day; its glow scales
// with that day's completed-task count relative to the busiest day in the window. The grid
// matches the calendar payload's shape exactly — weeks run left→right (x), day-of-week runs
// front→back (z) — so the field reads like the contribution chart on the productivity tab.
// No three.js / React imports so the topology is unit-testable (mirrors cityProductivity.js).

import { MONUMENT } from './cityProductivity';

export const HEATMAP = {
  // Anchored just east of the monument plinth so the grid frames the obelisk without
  // overlapping its footprint. Monument lives at MONUMENT.position ([-48, 0, 28]).
  origin: [MONUMENT.position[0] + MONUMENT.baseWidth * 1.4, 0, MONUMENT.position[2] - 12],
  tileSize: 1.6, // square footprint of each day tile
  tileGap: 0.4, // gap between adjacent tiles
  tileHeight: 0.18, // a thin slab so the field stays low to the ground
  maxWeeks: 14, // cap columns so the field never sprawls past the district (calendar default is 12)
};

const ACTIVE_COLOR = '#22c55e'; // port-success — completed work, GitHub-contribution green
const TODAY_COLOR = '#3b82f6'; // port-accent — highlight the current day
const EMPTY_COLOR = '#1a2030'; // near port-card — a quiet, unlit "no activity" tile

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Coerce to a finite, positive count or 0. Tile counts are never negative and a garbage
// value should read as "no activity," not crash the field.
function countOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// Map a day's task count to a 0..1 intensity against the window's busiest day. A zero-task
// day is 0 (drawn dim/empty); the busiest day(s) reach 1. A 0/garbage `maxTasks` falls back
// to 1 so a single active day still lights up rather than dividing by zero.
export function tileLevel(tasks, maxTasks) {
  const t = countOrZero(tasks);
  if (t === 0) return 0;
  const max = countOrZero(maxTasks);
  return clamp01(t / (max || 1));
}

// Full derived view-model for the component. `calendarData` is the `getActivityCalendar`
// payload (`{ weeks: [[{ date, dayOfWeek, tasks, isToday, isFuture, ... }]], maxTasks,
// summary, currentStreak }`). A missing/non-object payload, or one with no usable weeks,
// yields `present: false` and an empty tile list so the field simply doesn't render rather
// than crashing.
export function computeActivityHeatmap(calendarData) {
  const payload = calendarData && typeof calendarData === 'object' ? calendarData : {};
  const rawWeeks = Array.isArray(payload.weeks) ? payload.weeks : [];
  // Keep only the most recent `maxWeeks` columns so the field stays inside the district.
  const weeks = rawWeeks.slice(-HEATMAP.maxWeeks);
  const maxTasks = countOrZero(payload.maxTasks) || 1;

  const { tileSize, tileGap, tileHeight } = HEATMAP;
  const step = tileSize + tileGap;

  const tiles = [];
  let activeCount = 0;
  let totalTasks = 0;

  weeks.forEach((week, weekIndex) => {
    const days = Array.isArray(week) ? week : [];
    days.forEach((day) => {
      const dayObj = day && typeof day === 'object' ? day : {};
      // Future days in the trailing partial week aren't real activity — skip them so the
      // grid doesn't render a row of empty tiles past today.
      if (dayObj.isFuture) return;
      const dow = typeof dayObj.dayOfWeek === 'number' && Number.isFinite(dayObj.dayOfWeek)
        ? dayObj.dayOfWeek
        : 0;
      const tasks = countOrZero(dayObj.tasks);
      const level = tileLevel(tasks, maxTasks);
      const isToday = dayObj.isToday === true;
      if (tasks > 0) {
        activeCount += 1;
        totalTasks += tasks;
      }
      tiles.push({
        key: dayObj.date || `${weekIndex}-${dow}`,
        // Weeks run along x (columns), day-of-week runs along z (front→back rows).
        x: weekIndex * step,
        z: dow * step,
        // Animation phase derived from grid indices (not world coords) so the component's
        // shimmer reads as a coherent diagonal wave sweeping across the field rather than
        // near-random per-tile flicker.
        phase: (weekIndex + dow) * 0.18,
        tasks,
        level,
        isToday,
        // Today is always picked out in accent blue, even on a zero-task day — it's a
        // location sentinel, not an activity reading. Otherwise empty days sit dark and
        // active days glow green scaled by level.
        color: isToday ? TODAY_COLOR : tasks === 0 ? EMPTY_COLOR : ACTIVE_COLOR,
        // Emissive intensity: today always reads clearly (legible even at zero tasks); other
        // empty tiles barely glow; active tiles ramp with level.
        intensity: isToday ? Math.max(0.5, 0.25 + level * 0.7) : tasks === 0 ? 0.04 : 0.18 + level * 0.6,
      });
    });
  });

  return {
    origin: HEATMAP.origin,
    tileSize,
    tileHeight,
    present: tiles.length > 0,
    weekCount: weeks.length,
    tiles,
    activeCount,
    totalTasks,
    maxTasks,
  };
}
