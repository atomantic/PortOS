import { describe, it, expect } from 'vitest';
import {
  TASK_QUEUE,
  countByStatus,
  queueState,
  queueColor,
  computeTaskQueue,
} from './cityTaskQueue';

const tasks = (...statuses) => statuses.map((status, i) => ({ id: `t${i}`, status }));

describe('countByStatus', () => {
  it('tallies each status and buckets unknowns under other', () => {
    const c = countByStatus(tasks('pending', 'pending', 'in_progress', 'blocked', 'completed', 'weird'));
    expect(c).toEqual({ pending: 2, in_progress: 1, blocked: 1, completed: 1, other: 1 });
  });

  it('returns all-zero for missing / non-array input', () => {
    const zero = { pending: 0, in_progress: 0, blocked: 0, completed: 0, other: 0 };
    expect(countByStatus(undefined)).toEqual(zero);
    expect(countByStatus(null)).toEqual(zero);
    expect(countByStatus('nope')).toEqual(zero);
    expect(countByStatus([])).toEqual(zero);
  });

  it('counts always sum to the input length', () => {
    const list = tasks('pending', 'in_progress', 'blocked', 'completed', 'other', 'pending');
    const c = countByStatus(list);
    const sum = c.pending + c.in_progress + c.blocked + c.completed + c.other;
    expect(sum).toBe(list.length);
  });
});

describe('queueState', () => {
  it('prioritizes blocked > active > queued > idle', () => {
    expect(queueState({ blocked: 1, in_progress: 3, pending: 5 })).toBe('blocked');
    expect(queueState({ blocked: 0, in_progress: 2, pending: 5 })).toBe('active');
    expect(queueState({ blocked: 0, in_progress: 0, pending: 5 })).toBe('queued');
    expect(queueState({ blocked: 0, in_progress: 0, pending: 0 })).toBe('idle');
  });

  it('treats missing counts as idle', () => {
    expect(queueState(undefined)).toBe('idle');
    expect(queueState({})).toBe('idle');
  });
});

describe('queueColor', () => {
  it('maps each state to a distinct token', () => {
    expect(queueColor('idle')).toBe('#475569');
    expect(queueColor('queued')).toBe('#3b82f6');
    expect(queueColor('active')).toBe('#22c55e');
    expect(queueColor('blocked')).toBe('#f59e0b');
  });

  it('falls back to idle for an unknown state', () => {
    expect(queueColor('bogus')).toBe(queueColor('idle'));
  });
});

describe('computeTaskQueue', () => {
  it('carries the fixed position through unchanged', () => {
    expect(computeTaskQueue([]).position).toEqual(TASK_QUEUE.position);
  });

  it('an empty queue is idle with no crates', () => {
    const vm = computeTaskQueue([]);
    expect(vm.state).toBe('idle');
    expect(vm.crateCount).toBe(0);
    expect(vm.crates).toEqual([]);
    expect(vm.overflow).toBe(false);
    expect(vm.total).toBe(0);
  });

  it('stacks one crate per pending task', () => {
    const vm = computeTaskQueue(tasks('pending', 'pending', 'pending'));
    expect(vm.pending).toBe(3);
    expect(vm.crateCount).toBe(3);
    expect(vm.crates).toHaveLength(3);
    expect(vm.state).toBe('queued');
    expect(vm.overflow).toBe(false);
  });

  it('stacks crates upward with increasing y', () => {
    const vm = computeTaskQueue(tasks('pending', 'pending'));
    expect(vm.crates[0].y).toBeLessThan(vm.crates[1].y);
    expect(vm.crates[0].y).toBeCloseTo(TASK_QUEUE.crateSize / 2);
  });

  it('caps crate count at maxCrates and flags overflow', () => {
    const many = tasks(...Array(TASK_QUEUE.maxCrates + 4).fill('pending'));
    const vm = computeTaskQueue(many);
    expect(vm.pending).toBe(TASK_QUEUE.maxCrates + 4);
    expect(vm.crateCount).toBe(TASK_QUEUE.maxCrates);
    expect(vm.overflow).toBe(true);
  });

  it('honors a custom maxCrates', () => {
    const vm = computeTaskQueue(tasks('pending', 'pending', 'pending'), { maxCrates: 2 });
    expect(vm.crateCount).toBe(2);
    expect(vm.overflow).toBe(true);
  });

  it('lights active when an agent is working, even with pending backlog', () => {
    const vm = computeTaskQueue(tasks('pending', 'pending', 'in_progress'));
    expect(vm.state).toBe('active');
    expect(vm.active).toBe(true);
    expect(vm.color).toBe('#22c55e');
    // crate stack still reflects the pending backlog, independent of the lighting
    expect(vm.crateCount).toBe(2);
  });

  it('tints blocked when any task needs attention, overriding active', () => {
    const vm = computeTaskQueue(tasks('pending', 'in_progress', 'blocked'));
    expect(vm.state).toBe('blocked');
    expect(vm.hasBlocked).toBe(true);
    expect(vm.color).toBe('#f59e0b');
    expect(vm.total).toBe(3);
  });

  it('ignores completed tasks for stacking and totals', () => {
    const vm = computeTaskQueue(tasks('completed', 'completed', 'pending'));
    expect(vm.crateCount).toBe(1);
    expect(vm.total).toBe(1);
    expect(vm.state).toBe('queued');
  });
});
