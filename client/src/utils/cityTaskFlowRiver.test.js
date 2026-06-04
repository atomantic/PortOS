import { describe, it, expect } from 'vitest';
import { MONUMENT } from './cityProductivity';
import { TASK_QUEUE } from './cityTaskQueue';
import {
  RIVER,
  widthLevel,
  speedLevel,
  recentCalendarThroughput,
  computeTaskFlowRiver,
} from './cityTaskFlowRiver';

describe('widthLevel', () => {
  it('maps backlog/cap into 0..1', () => {
    expect(widthLevel(6, 12)).toBe(0.5);
    expect(widthLevel(12, 12)).toBe(1);
  });
  it('clamps above the cap and reads garbage as 0', () => {
    expect(widthLevel(99, 12)).toBe(1);
    expect(widthLevel(0, 12)).toBe(0);
    expect(widthLevel(undefined, 12)).toBe(0);
    expect(widthLevel(-3, 12)).toBe(0);
  });
});

describe('speedLevel', () => {
  it('maps throughput/cap into 0..1', () => {
    expect(speedLevel(5, 10)).toBe(0.5);
    expect(speedLevel(10, 10)).toBe(1);
  });
  it('clamps above the cap and reads garbage as 0', () => {
    expect(speedLevel(50, 10)).toBe(1);
    expect(speedLevel(undefined, 10)).toBe(0);
    expect(speedLevel('5', 10)).toBe(0);
  });
});

describe('computeTaskFlowRiver', () => {
  it('connects the warehouse to the monument', () => {
    const vm = computeTaskFlowRiver({ pending: 0 }, 0);
    expect(vm.from).toEqual(TASK_QUEUE.position);
    expect(vm.to).toEqual(MONUMENT.position);
    // Center is the midpoint of the two endpoints.
    expect(vm.center[0]).toBeCloseTo((TASK_QUEUE.position[0] + MONUMENT.position[0]) / 2);
    expect(vm.center[2]).toBeCloseTo((TASK_QUEUE.position[2] + MONUMENT.position[2]) / 2);
    // Length is the ground-plane distance between them.
    const dx = MONUMENT.position[0] - TASK_QUEUE.position[0];
    const dz = MONUMENT.position[2] - TASK_QUEUE.position[2];
    expect(vm.length).toBeCloseTo(Math.sqrt(dx * dx + dz * dz));
  });

  it('yaws so the channel local +x points from warehouse to monument', () => {
    const vm = computeTaskFlowRiver({ pending: 0 }, 0);
    // A +Y rotation by `angle` maps local +x (1,0,0) to world (cos, 0, -sin); that vector,
    // scaled by length, must reconstruct the warehouse→monument displacement.
    const dirX = Math.cos(vm.angle) * vm.length;
    const dirZ = -Math.sin(vm.angle) * vm.length;
    expect(dirX).toBeCloseTo(MONUMENT.position[0] - TASK_QUEUE.position[0]);
    expect(dirZ).toBeCloseTo(MONUMENT.position[2] - TASK_QUEUE.position[2]);
  });

  it('widens with backlog and quickens with throughput', () => {
    const empty = computeTaskFlowRiver({ pending: 0, inProgress: 0, blocked: 0 }, 0);
    const busy = computeTaskFlowRiver({ pending: 8, inProgress: 4, blocked: 0 }, 10);
    expect(busy.width).toBeGreaterThan(empty.width);
    expect(busy.speed).toBeGreaterThan(empty.speed);
    expect(busy.backlog).toBe(12);
    expect(busy.widthLevel).toBe(1); // 12 >= backlogCap
    expect(busy.speedLevel).toBe(1); // 10 >= throughputCap
    expect(busy.width).toBeCloseTo(RIVER.maxWidth);
    expect(busy.speed).toBeCloseTo(RIVER.maxSpeed);
  });

  it('floors width/speed for an empty, still channel', () => {
    const vm = computeTaskFlowRiver({ pending: 0 }, 0);
    expect(vm.width).toBeCloseTo(RIVER.minWidth);
    expect(vm.speed).toBeCloseTo(RIVER.minSpeed);
    expect(vm.flowing).toBe(false);
    expect(vm.state).toBe('idle');
    expect(vm.color).toBe('#475569');
  });

  it('colors by dominant queue state', () => {
    expect(computeTaskFlowRiver({ blocked: 1 }, 1).state).toBe('blocked');
    expect(computeTaskFlowRiver({ blocked: 1 }, 1).color).toBe('#f59e0b');
    expect(computeTaskFlowRiver({ inProgress: 2 }, 3).state).toBe('active');
    expect(computeTaskFlowRiver({ inProgress: 2 }, 3).color).toBe('#22c55e');
    expect(computeTaskFlowRiver({ pending: 2 }, 0).state).toBe('queued');
    expect(computeTaskFlowRiver({ pending: 2 }, 0).color).toBe('#3b82f6');
  });

  it('flows only when there is throughput and a non-idle state', () => {
    expect(computeTaskFlowRiver({ inProgress: 1 }, 4).flowing).toBe(true);
    // backlog present but nothing draining → not flowing
    expect(computeTaskFlowRiver({ pending: 5 }, 0).flowing).toBe(false);
  });

  it('emits evenly-phased particles scaled to channel length', () => {
    const vm = computeTaskFlowRiver({ pending: 3 }, 2);
    expect(vm.particles.length).toBeGreaterThanOrEqual(2);
    expect(vm.particles[0].phase).toBe(0);
    expect(vm.particles.every((p, i) => p.index === i)).toBe(true);
    expect(vm.particles.every((p) => p.phase >= 0 && p.phase < 1)).toBe(true);
  });

});

describe('recentCalendarThroughput', () => {
  const cal = (taskRows) => ({
    weeks: taskRows.map((row) =>
      row.map((tasks, dow) => ({ date: `d${dow}`, dayOfWeek: dow, tasks, isFuture: false }))
    ),
    summary: { totalTasks: taskRows.flat().reduce((s, t) => s + t, 0) },
  });

  it('sums only the most recent N days, excluding future days', () => {
    // 14 days total (two weeks); last 7 days carry 1+2+3 = 6 tasks.
    const data = cal([
      [5, 5, 5, 5, 5, 5, 5],
      [0, 0, 0, 0, 1, 2, 3],
    ]);
    expect(recentCalendarThroughput(data, 7)).toBe(6);
  });

  it('windows away the 12-week-total saturation problem', () => {
    // A big historical total but a quiet recent week reads as low, not pinned high.
    const busyWeeks = Array.from({ length: 12 }, () => [9, 9, 9, 9, 9, 9, 9]);
    busyWeeks.push([0, 0, 0, 0, 0, 0, 0]); // quiet current week
    const data = cal(busyWeeks);
    expect(data.summary.totalTasks).toBe(12 * 7 * 9); // huge historical total
    expect(recentCalendarThroughput(data, 7)).toBe(0); // but the recent window is quiet
  });

  it('skips future days in the trailing window', () => {
    const data = cal([[1, 1, 1, 1, 1, 1, 1]]);
    data.weeks[0][5].isFuture = true;
    data.weeks[0][6].isFuture = true;
    expect(recentCalendarThroughput(data, 7)).toBe(5);
  });

  it('returns null for a missing/empty calendar so the caller can fall back', () => {
    expect(recentCalendarThroughput(null)).toBeNull();
    expect(recentCalendarThroughput({})).toBeNull();
    expect(recentCalendarThroughput({ weeks: [] })).toBeNull();
    expect(recentCalendarThroughput({ weeks: 'oops' })).toBeNull();
  });
});

describe('computeTaskFlowRiver — idle resilience', () => {
  it('handles missing / non-object inputs as an idle trickle without crashing', () => {
    for (const badQueue of [null, undefined, 'nope', 42, []]) {
      for (const badThroughput of [null, undefined, 'nope', -5, NaN]) {
        const vm = computeTaskFlowRiver(badQueue, badThroughput);
        expect(vm.state).toBe('idle');
        expect(vm.backlog).toBe(0);
        expect(vm.throughput).toBe(0);
        expect(vm.width).toBeCloseTo(RIVER.minWidth);
        expect(vm.from).toEqual(TASK_QUEUE.position);
      }
    }
  });
});
