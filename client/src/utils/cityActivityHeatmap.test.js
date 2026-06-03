import { describe, it, expect } from 'vitest';
import { HEATMAP, tileLevel, computeActivityHeatmap } from './cityActivityHeatmap';

// Minimal calendar payload mirroring getActivityCalendar's shape: weeks of 7 days.
function makeCalendar(taskGrid, { maxTasks, todayIndex } = {}) {
  let flat = 0;
  const weeks = taskGrid.map((week, wi) =>
    week.map((tasks, dow) => {
      const idx = flat++;
      return {
        date: `2026-w${wi}-d${dow}`,
        dayOfWeek: dow,
        tasks,
        successes: tasks,
        failures: 0,
        successRate: 100,
        isToday: idx === todayIndex,
        isFuture: false,
      };
    })
  );
  const computedMax = Math.max(1, ...taskGrid.flat());
  return { weeks, maxTasks: maxTasks ?? computedMax };
}

describe('tileLevel', () => {
  it('maps tasks/maxTasks into 0..1', () => {
    expect(tileLevel(5, 10)).toBe(0.5);
    expect(tileLevel(10, 10)).toBe(1);
  });

  it('treats a zero-task day as level 0', () => {
    expect(tileLevel(0, 10)).toBe(0);
  });

  it('clamps above the busiest day to 1', () => {
    expect(tileLevel(20, 10)).toBe(1);
  });

  it('falls back to max=1 (not divide-by-zero) for a single active day', () => {
    expect(tileLevel(3, 0)).toBe(1);
    expect(tileLevel(3, undefined)).toBe(1);
  });

  it('reads garbage / negative tasks as 0', () => {
    expect(tileLevel(undefined, 10)).toBe(0);
    expect(tileLevel(-4, 10)).toBe(0);
    expect(tileLevel('5', 10)).toBe(0);
    expect(tileLevel(NaN, 10)).toBe(0);
  });
});

describe('computeActivityHeatmap', () => {
  it('carries the anchored origin through unchanged', () => {
    const vm = computeActivityHeatmap(makeCalendar([[0, 0, 0, 0, 0, 0, 0]]));
    expect(vm.origin).toEqual(HEATMAP.origin);
  });

  it('builds one tile per non-future day with grid-aligned x/z', () => {
    const cal = makeCalendar([
      [0, 1, 2, 0, 0, 0, 0],
      [3, 0, 0, 0, 0, 0, 4],
    ]);
    const vm = computeActivityHeatmap(cal);
    expect(vm.present).toBe(true);
    expect(vm.tiles).toHaveLength(14);
    const step = HEATMAP.tileSize + HEATMAP.tileGap;
    // Week 1, day-of-week 6 (the "4-task" tile) sits at x=step, z=6*step.
    const last = vm.tiles.find((t) => t.tasks === 4);
    expect(last.x).toBeCloseTo(step);
    expect(last.z).toBeCloseTo(6 * step);
  });

  it('scales intensity by the busiest day and totals active days/tasks', () => {
    const cal = makeCalendar([[0, 2, 4, 0, 0, 0, 0]], { maxTasks: 4 });
    const vm = computeActivityHeatmap(cal);
    expect(vm.maxTasks).toBe(4);
    expect(vm.activeCount).toBe(2);
    expect(vm.totalTasks).toBe(6);
    const busiest = vm.tiles.find((t) => t.tasks === 4);
    const lighter = vm.tiles.find((t) => t.tasks === 2);
    expect(busiest.level).toBe(1);
    expect(lighter.level).toBe(0.5);
    expect(busiest.intensity).toBeGreaterThan(lighter.intensity);
  });

  it('draws empty days dim and dark, not glowing', () => {
    const vm = computeActivityHeatmap(makeCalendar([[0, 1, 0, 0, 0, 0, 0]]));
    const empty = vm.tiles.find((t) => t.tasks === 0);
    expect(empty.level).toBe(0);
    expect(empty.color).toBe('#1a2030');
    expect(empty.intensity).toBeLessThan(0.1);
  });

  it('accents today and keeps it legible even on a light day', () => {
    const cal = makeCalendar([[0, 1, 0, 0, 0, 0, 0]], { maxTasks: 10, todayIndex: 1 });
    const vm = computeActivityHeatmap(cal);
    const today = vm.tiles.find((t) => t.isToday);
    expect(today.color).toBe('#3b82f6'); // accent
    expect(today.intensity).toBeGreaterThanOrEqual(0.5);
  });

  it('picks out a zero-task today as accent, not as a dark empty day', () => {
    // todayIndex 0 has 0 tasks — it's still the "you are here" tile, not an empty day.
    const cal = makeCalendar([[0, 3, 0, 0, 0, 0, 0]], { maxTasks: 3, todayIndex: 0 });
    const vm = computeActivityHeatmap(cal);
    const today = vm.tiles.find((t) => t.isToday);
    expect(today.tasks).toBe(0);
    expect(today.color).toBe('#3b82f6'); // accent, NOT the empty #1a2030
    expect(today.intensity).toBeGreaterThanOrEqual(0.5);
  });

  it('skips future days in the trailing partial week', () => {
    const cal = makeCalendar([[1, 0, 0, 0, 0, 0, 0]]);
    cal.weeks[0][3].isFuture = true;
    cal.weeks[0][4].isFuture = true;
    const vm = computeActivityHeatmap(cal);
    expect(vm.tiles).toHaveLength(5); // 7 days minus 2 future
  });

  it('caps columns at maxWeeks, keeping the most recent', () => {
    const grid = Array.from({ length: 20 }, () => [1, 0, 0, 0, 0, 0, 0]);
    const vm = computeActivityHeatmap(makeCalendar(grid));
    expect(vm.weekCount).toBe(HEATMAP.maxWeeks);
  });

  it('handles missing / non-object / empty input as not-present without crashing', () => {
    for (const bad of [null, undefined, 'nope', 42, [], {}, { weeks: 'oops' }]) {
      const vm = computeActivityHeatmap(bad);
      expect(vm.present).toBe(false);
      expect(vm.tiles).toEqual([]);
      expect(vm.origin).toEqual(HEATMAP.origin);
    }
  });

  it('tolerates a non-object day or missing dayOfWeek', () => {
    const vm = computeActivityHeatmap({ weeks: [[null, { tasks: 2 }]], maxTasks: 2 });
    expect(vm.tiles).toHaveLength(2);
    // both fall back to dayOfWeek 0 → z 0
    expect(vm.tiles.every((t) => t.z === 0)).toBe(true);
  });
});
