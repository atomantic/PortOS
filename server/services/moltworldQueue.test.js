import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { addAction, getQueue } from './moltworldQueue.js';

describe('moltworldQueue scheduledFor', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const NOW = Date.parse('2026-01-01T12:00:00Z');

  it('hides future-scheduled items until due, always returns unscheduled ones', () => {
    const agent = randomUUID();
    const immediate = addAction(agent, 'think');
    const future = addAction(agent, 'think', {}, '2026-01-01T13:00:00Z');
    const due = addAction(agent, 'think', {}, '2026-01-01T11:00:00Z');

    const ids = (now) => getQueue(agent, { now }).map(i => i.id);
    expect(ids(NOW)).toEqual([immediate.id, due.id]);
    expect(ids(Date.parse('2026-01-01T13:00:00Z'))).toEqual([immediate.id, future.id, due.id]);
  });

  it('still counts future-scheduled items toward the per-agent cap', () => {
    const agent = randomUUID();
    for (let i = 0; i < 100; i++) addAction(agent, 'think', {}, '2999-01-01T00:00:00Z');
    expect(getQueue(agent)).toHaveLength(0);
    expect(() => addAction(agent, 'think')).toThrow(/Queue full/);
  });
});
