import { describe, it, expect } from 'vitest';
import { getTaskStatusGroup, taskSortKey, TASK_FILTERS, STATUS_GROUPS, describeNextRun, coverageTone } from './scheduleConstants';

describe('getTaskStatusGroup', () => {
  it('classifies a disabled task as disabled regardless of type', () => {
    expect(getTaskStatusGroup({ enabled: false, type: 'daily' })).toBe('disabled');
    expect(getTaskStatusGroup({ enabled: false, type: 'on-demand' })).toBe('disabled');
  });

  it('classifies a dependency-blocked task as waiting', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'daily', status: { reason: 'waiting-on-dependencies' } })).toBe('waiting');
  });

  it('classifies an on-demand task', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'on-demand' })).toBe('on-demand');
  });

  it('classifies a normal enabled scheduled task as active', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'daily' })).toBe('active');
  });

  it('classifies a completed one-shot task as completed, not active', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'once', status: { reason: 'once-completed' } })).toBe('completed');
  });

  it('keeps a not-yet-run one-shot task active', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'once', status: { nextRunAt: '2999-01-01T00:00:00Z' } })).toBe('active');
  });

  it('disabled wins over a completed one-shot', () => {
    expect(getTaskStatusGroup({ enabled: false, type: 'once', status: { reason: 'once-completed' } })).toBe('disabled');
  });

  it('disabled wins over waiting', () => {
    expect(getTaskStatusGroup({ enabled: false, status: { reason: 'waiting-on-dependencies' } })).toBe('disabled');
  });
});

describe('taskSortKey', () => {
  it('orders active before on-demand before waiting before disabled', () => {
    const active = taskSortKey('a', { enabled: true, type: 'daily' });
    const onDemand = taskSortKey('b', { enabled: true, type: 'on-demand' });
    const waiting = taskSortKey('c', { enabled: true, type: 'daily', status: { reason: 'waiting-on-dependencies' } });
    const disabled = taskSortKey('d', { enabled: false });
    expect(active.order).toBeLessThan(onDemand.order);
    expect(onDemand.order).toBeLessThan(waiting.order);
    expect(waiting.order).toBeLessThan(disabled.order);
  });

  it('sorts active tasks by soonest next run, missing runs last', () => {
    const soon = taskSortKey('a', { enabled: true, type: 'daily', status: { nextRunAt: '2999-01-01T00:00:00Z' } });
    const later = taskSortKey('b', { enabled: true, type: 'daily', status: { nextRunAt: '2999-06-01T00:00:00Z' } });
    const none = taskSortKey('c', { enabled: true, type: 'daily' });
    expect(soon.next).toBeLessThan(later.next);
    expect(later.next).toBeLessThan(none.next);
    expect(none.next).toBe(Infinity);
  });
});

describe('TASK_FILTERS', () => {
  it('has one filter per status group plus All', () => {
    const ids = TASK_FILTERS.map(f => f.id);
    expect(ids).toContain('all');
    Object.keys(STATUS_GROUPS).forEach(g => expect(ids).toContain(g));
  });

  it('status filters match only their group', () => {
    const waiting = TASK_FILTERS.find(f => f.id === 'waiting');
    expect(waiting.match(['x', { enabled: true, status: { reason: 'waiting-on-dependencies' } }])).toBe(true);
    expect(waiting.match(['y', { enabled: true, type: 'daily' }])).toBe(false);
  });
});

describe('describeNextRun', () => {
  it('reports Paused for disabled tasks', () => {
    expect(describeNextRun({ enabled: false }).text).toBe('Paused');
  });

  it('reports manual-only for on-demand tasks', () => {
    expect(describeNextRun({ enabled: true, type: 'on-demand' }).text).toBe('Manual trigger only');
  });

  it('reports a completed one-shot as completed with a reset hint', () => {
    const out = describeNextRun({ enabled: true, type: 'once', status: { reason: 'once-completed' } });
    expect(out.text).toMatch(/completed/i);
  });

  it('reports the dependency list with a warn flag when waiting', () => {
    const out = describeNextRun({ enabled: true, status: { reason: 'waiting-on-dependencies', pendingDeps: ['build', 'lint'] } });
    expect(out.text).toBe('waiting on build, lint');
    expect(out.warn).toBe(true);
    expect(out.title).toContain('build, lint');
  });

  it('reports a relative countdown for a scheduled task with a next run', () => {
    expect(describeNextRun({ enabled: true, type: 'daily', status: { nextRunAt: '2999-01-01T00:00:00Z' } }).text).toMatch(/^in /);
  });

  it('falls back to an interval-label pending string when no next run is known', () => {
    expect(describeNextRun({ enabled: true, type: 'daily' }).text).toBe('Daily — pending');
  });
});

describe('coverageTone', () => {
  it('is error when no apps are enabled', () => {
    expect(coverageTone(0, 5).bar).toBe('bg-port-error');
  });
  it('is success when all apps are enabled', () => {
    expect(coverageTone(5, 5).bar).toBe('bg-port-success');
  });
  it('is warning for partial coverage', () => {
    expect(coverageTone(2, 5).bar).toBe('bg-port-warning');
  });
});
