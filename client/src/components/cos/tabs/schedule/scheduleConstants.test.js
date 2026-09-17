import { describe, it, expect } from 'vitest';
import { isManualOnlyCadence, getTaskStatusGroup, taskSortKey, TASK_FILTERS, STATUS_GROUPS, describeNextRun, coverageTone, setMetadataOverride, toggleMetadataField, fileIssuesEffective, managedAgentOptionsFor, toggleFileIssuesMetadata, prReviewerStageRole, stagePublicReviewPosture, togglePrReviewerActions, suggestedOrderSteps, compareBySuggestedOrder } from './scheduleConstants';

describe('pr-reviewer pipeline helpers', () => {
  it('recognizes semantic roles and legacy prompt-key stages', () => {
    expect(prReviewerStageRole({ role: 'eligibility' })).toBe('eligibility');
    expect(prReviewerStageRole({ promptKey: 'pr-reviewer-review' })).toBe('actions');
    expect(prReviewerStageRole({ promptKey: 'other' })).toBeNull();
  });

  it('enforces tool-free PR roles over legacy profiles while preserving generic profiles', () => {
    expect(stagePublicReviewPosture({ role: 'actions', executionProfile: 'public-review-actions' })).toBe('no-tool');
    expect(stagePublicReviewPosture({ promptKey: 'pr-reviewer-review', executionProfile: 'public-review-actions' })).toBe('no-tool');
    expect(stagePublicReviewPosture({ role: 'eligibility', executionProfile: 'public-review-actions' })).toBe('no-tool');
    expect(stagePublicReviewPosture({ promptKey: 'custom-review', executionProfile: 'public-review-actions' })).toBe('sandboxed-actions');
  });

  it('removes only the optional actions stage and restores its full safe posture', () => {
    const stages = [
      { name: 'Security Scan', role: 'security' },
      { name: 'Eligibility Gate', role: 'eligibility' },
      { name: 'Code Review & Actions', role: 'actions', providerId: 'codex-cli' },
    ];
    expect(togglePrReviewerActions(stages, false)).toEqual(stages.slice(0, 2));
    expect(togglePrReviewerActions(stages.slice(0, 2), true)).toEqual([
      ...stages.slice(0, 2),
      expect.objectContaining({
        role: 'actions',
        promptKey: 'pr-reviewer-review',
        executionProfile: 'public-review-gate',
        discardWorktree: true,
        noCodeOutput: true,
      }),
    ]);
  });

  it('is idempotent when the optional stage is already enabled', () => {
    const stages = [{ role: 'security' }, { role: 'eligibility' }, { role: 'actions' }];
    expect(togglePrReviewerActions(stages, true)).toBe(stages);
  });
});

describe('setMetadataOverride', () => {
  it('sets a key without disturbing the app\'s other overrides', () => {
    expect(setMetadataOverride({ useWorktree: true }, 'prCompletion', 'merge-on-green'))
      .toEqual({ useWorktree: true, prCompletion: 'merge-on-green' });
  });

  it('deletes the key on the Inherit sentinel', () => {
    expect(setMetadataOverride({ useWorktree: true, prCompletion: 'leave-open' }, 'prCompletion', ''))
      .toEqual({ useWorktree: true });
  });

  it('keeps an explicit 0 — only "" means inherit', () => {
    expect(setMetadataOverride(null, 'swarmCount', 0)).toEqual({ swarmCount: 0 });
  });

  it('returns null once nothing is overridden so the row drops its object', () => {
    expect(setMetadataOverride({ prCompletion: 'leave-open' }, 'prCompletion', '')).toBeNull();
  });
});

describe('fileIssuesEffective', () => {
  it('prefers an app override, then the stored global, then the catalog default', () => {
    expect(fileIssuesEffective({ defaultFileIssues: true }, { fileIssues: false })).toBe(false);
    expect(fileIssuesEffective({ taskMetadata: { fileIssues: true }, defaultFileIssues: false })).toBe(true);
    expect(fileIssuesEffective({ defaultFileIssues: true })).toBe(true);
    expect(fileIssuesEffective({ defaultFileIssues: false })).toBe(false);
  });
});

describe('managedAgentOptionsFor', () => {
  it('adds worktree/PR/simplify to the managed set when file-issues is on', () => {
    expect(managedAgentOptionsFor({
      fileIssuesCapable: true,
      defaultFileIssues: true,
      managedAgentOptions: ['claimFlow'],
    })).toEqual(['claimFlow', 'useWorktree', 'openPR', 'simplify']);
  });

  it('leaves non-audit tasks alone', () => {
    expect(managedAgentOptionsFor({ managedAgentOptions: ['useWorktree'] })).toEqual(['useWorktree']);
  });

  it('locks the worktree on for an isolation-required audit in do-work mode', () => {
    expect(managedAgentOptionsFor({
      fileIssuesCapable: true,
      defaultFileIssues: true,
      doWorkRequiresWorktree: true,
    }, { fileIssues: false })).toEqual(['useWorktree']);
  });
});

describe('toggleFileIssuesMetadata', () => {
  it('forces the no-code posture on and otherwise leaves agent options alone', () => {
    expect(toggleFileIssuesMetadata({ useWorktree: true, openPR: true, simplify: true }, true))
      .toEqual({ useWorktree: false, openPR: false, simplify: false, fileIssues: true });
    expect(toggleFileIssuesMetadata({ fileIssues: true, useWorktree: false }, false))
      .toEqual({ fileIssues: false, useWorktree: false });
  });

  it('restores required worktree isolation when do-work mode is selected', () => {
    expect(toggleFileIssuesMetadata(
      { fileIssues: true, useWorktree: false, openPR: false },
      false,
      true,
    )).toEqual({ fileIssues: false, useWorktree: true, openPR: false });
  });
});

describe('toggleMetadataField', () => {
  it('turns openPR on with the worktree it implies', () => {
    expect(toggleMetadataField({ useWorktree: false, openPR: false }, 'openPR'))
      .toEqual({ useWorktree: true, openPR: true });
  });

  it('turns openPR off with the worktree it depends on', () => {
    expect(toggleMetadataField({ useWorktree: true, openPR: false }, 'useWorktree'))
      .toEqual({ useWorktree: false, openPR: false });
  });

  // The invariant resolves in openPR's favor, so the worktree toggle can't strand
  // a PR task with nowhere to branch — turn Open PR off first.
  it('refuses to drop the worktree out from under an open PR', () => {
    expect(toggleMetadataField({ useWorktree: true, openPR: true }, 'useWorktree'))
      .toEqual({ useWorktree: true, openPR: true });
  });
});

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

  it('keeps a scheduled task active', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'cron', status: { nextRunAt: '2999-01-01T00:00:00Z' } })).toBe('active');
  });

  it('classifies a perpetual on-demand task as active — its drain runs unattended', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'on-demand', perpetual: true })).toBe('active');
    expect(getTaskStatusGroup({ enabled: true, type: 'on-demand' })).toBe('on-demand');
  });

  it('disabled wins over a perpetual drain', () => {
    expect(getTaskStatusGroup({ enabled: false, type: 'on-demand', perpetual: true })).toBe('disabled');
  });

  it('disabled wins over waiting', () => {
    expect(getTaskStatusGroup({ enabled: false, status: { reason: 'waiting-on-dependencies' } })).toBe('disabled');
  });
});

describe('taskSortKey', () => {
  it('orders active before on-demand before waiting before disabled', () => {
    const active = taskSortKey('a', { enabled: true, type: 'cron' });
    const onDemand = taskSortKey('b', { enabled: true, type: 'on-demand' });
    const waiting = taskSortKey('c', { enabled: true, type: 'cron', status: { reason: 'waiting-on-dependencies' } });
    const disabled = taskSortKey('d', { enabled: false });
    expect(active.order).toBeLessThan(onDemand.order);
    expect(onDemand.order).toBeLessThan(waiting.order);
    expect(waiting.order).toBeLessThan(disabled.order);
  });

  it('sorts active tasks by soonest next run, missing runs last', () => {
    const soon = taskSortKey('a', { enabled: true, type: 'cron', status: { nextRunAt: '2999-01-01T00:00:00Z' } });
    const later = taskSortKey('b', { enabled: true, type: 'cron', status: { nextRunAt: '2999-06-01T00:00:00Z' } });
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

  it('reports the dependency list with a warn flag when waiting', () => {
    const out = describeNextRun({ enabled: true, status: { reason: 'waiting-on-dependencies', pendingDeps: ['build', 'lint'] } });
    expect(out.text).toBe('waiting on build, lint');
    expect(out.warn).toBe(true);
    expect(out.title).toContain('build, lint');
  });

  it('reports a relative countdown for a scheduled task with a next run', () => {
    expect(describeNextRun({ enabled: true, type: 'cron', status: { nextRunAt: '2999-01-01T00:00:00Z' } }).text).toMatch(/^in /);
  });

  it('reports a relative countdown with cron description for a scheduled cron task with next run', () => {
    const out = describeNextRun({ enabled: true, type: 'cron', cronExpression: '0 6 * * 1-5', status: { nextRunAt: '2999-01-01T00:00:00Z' } });
    expect(out.text).toMatch(/^in .* · Weekdays at 06:00/);
    expect(out.title).toBe('Weekdays at 06:00 (0 6 * * 1-5)');
  });

  it('falls back to an interval-label pending string when no next run is known', () => {
    expect(describeNextRun({ enabled: true, type: 'cron' }).text).toBe('Scheduled — pending');
    expect(describeNextRun({ enabled: true, type: 'cron', cronExpression: '0 6 * * 1-5' }).text).toBe('Weekdays at 06:00 — pending');
  });

  it('reports a draining perpetual task', () => {
    const out = describeNextRun({ enabled: true, type: 'on-demand', perpetual: true, status: { reason: 'perpetual-drain' } });
    expect(out.text).toMatch(/draining/i);
    expect(out.tone).toBe('text-port-success');
  });

  it('reports a parked perpetual task with its recheck countdown and reason', () => {
    const out = describeNextRun({
      enabled: true,
      type: 'cron',
      perpetual: true,
      cronExpression: '0 3 * * *',
      status: { reason: 'perpetual-parked', nextRunAt: '2999-01-01T00:00:00Z', parkReason: 'no-actionable-issues' }
    });
    expect(out.text).toMatch(/parked · rechecks/);
    expect(out.title).toContain('no-actionable-issues');
  });

  it('prefers the per-app aggregate over the global drain status for app-scoped perpetual tasks', () => {
    // Global status reads drain, but all tracked apps are parked — aggregate wins.
    const out = describeNextRun({
      enabled: true,
      type: 'on-demand',
      perpetual: true,
      status: { reason: 'perpetual-drain' },
      perpetualStatus: { parkedAppCount: 2, trackedAppCount: 2, globalParked: false, nextRecheckAt: '2999-01-01T00:00:00Z', parkReason: 'no-actionable-issues' }
    });
    expect(out.text).toMatch(/2 app\(s\) parked · rechecks/);
    expect(out.title).toContain('no-actionable-issues');
  });

  it('shows draining when some apps still have work in the aggregate', () => {
    const out = describeNextRun({
      enabled: true,
      type: 'on-demand',
      perpetual: true,
      status: { reason: 'perpetual-drain' },
      perpetualStatus: { parkedAppCount: 1, trackedAppCount: 3, globalParked: false, nextRecheckAt: null, parkReason: null }
    });
    expect(out.text).toMatch(/draining/);
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
// @vitest-environment node

describe('suggestedOrderSteps', () => {
  it('ranks a chain one step past its latest predecessor', () => {
    const steps = suggestedOrderSteps({
      a: {},
      b: { suggestedAfter: ['a'] },
      c: { suggestedAfter: ['b'] },
      d: { suggestedAfter: ['a', 'c'] },
    });
    expect(steps).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });

  it('leaves a task that neither names nor is named unranked, not "step 1"', () => {
    const steps = suggestedOrderSteps({ ordered: { suggestedAfter: ['head'] }, head: {}, loner: {} });
    expect(steps.loner).toBeUndefined();
    expect(steps).toMatchObject({ head: 1, ordered: 2 });
  });

  it('ignores an edge naming a task this install does not have', () => {
    expect(suggestedOrderSteps({ here: { suggestedAfter: ['from-a-newer-peer'] } })).toEqual({});
  });

  it('terminates on a user-declared cycle instead of hanging', () => {
    const steps = suggestedOrderSteps({ a: { suggestedAfter: ['b'] }, b: { suggestedAfter: ['a'] } });
    expect(Number.isInteger(steps.a)).toBe(true);
    expect(Number.isInteger(steps.b)).toBe(true);
  });

  it('sorts unranked tasks last — they make no ordering claim', () => {
    const steps = { late: 3, early: 1 };
    const sorted = [['unranked', {}], ['late', {}], ['early', {}]].sort(compareBySuggestedOrder(steps));
    expect(sorted.map(([taskType]) => taskType)).toEqual(['early', 'late', 'unranked']);
  });
});

// A task can read "On Demand" on its global row while one of its apps runs it
// on a cron. Every surface that summarizes cadence has to say so — "Manual
// trigger only" is simply wrong for that task, and it filed under the wrong
// status group too.
describe('per-app schedules on a globally on-demand task', () => {
  const APP_CRON = [{ appId: 'acme', appName: 'Acme', cronExpression: '0 7 * * *', nextRunAt: '2999-01-01T07:00:00Z' }];

  it('counts as Active, not On-Demand — a clock launches it with nobody pressing Run', () => {
    expect(getTaskStatusGroup({ enabled: true, type: 'on-demand', appSchedules: APP_CRON })).toBe('active');
    expect(getTaskStatusGroup({ enabled: true, type: 'on-demand', appSchedules: [] })).toBe('on-demand');
  });

  it('still reads as Disabled or Waiting when those apply', () => {
    expect(getTaskStatusGroup({ enabled: false, type: 'on-demand', appSchedules: APP_CRON })).toBe('disabled');
    expect(getTaskStatusGroup({
      enabled: true, type: 'on-demand', appSchedules: APP_CRON, status: { reason: 'waiting-on-dependencies' },
    })).toBe('waiting');
  });

  it('describes the app cadence instead of "Manual trigger only"', () => {
    const out = describeNextRun({ enabled: true, type: 'on-demand', appSchedules: APP_CRON });
    expect(out.text).toContain('1 app · at 07:00');
    expect(out.text).not.toBe('Manual trigger only');
    expect(out.title).toContain('Acme — at 07:00 (0 7 * * *)');
  });

  it('names both clocks when the task has a cron of its own and an app overrides it', () => {
    const out = describeNextRun({
      enabled: true, type: 'cron', cronExpression: '0 9 * * *',
      status: { nextRunAt: '2999-01-01T09:00:00Z' },
      appSchedules: APP_CRON,
    });
    expect(out.text).toContain('at 09:00');
    expect(out.title).toContain('at 09:00 (0 9 * * *)');
    expect(out.title).toContain('Acme — at 07:00 (0 7 * * *)');
  });

  it('sorts by the app slot when the task itself has no next run', () => {
    const sorted = [
      ['later', { enabled: true, type: 'cron', status: { nextRunAt: '2999-01-02T00:00:00Z' } }],
      ['app-scheduled', { enabled: true, type: 'on-demand', appSchedules: APP_CRON }],
    ]
      .map(([taskType, config]) => taskSortKey(taskType, config))
      .sort((a, b) => a.next - b.next);
    expect(sorted[0].taskType).toBe('app-scheduled');
  });
});

// The Schedule card and the Timeline both ask "does anything but a human start
// this?" — they used to carry separate copies of the answer that disagreed
// about autoStart, so one page could show a track for a task the other filed
// as manual.
describe('isManualOnlyCadence', () => {
  it('is true only when nothing automatic can start the task', () => {
    expect(isManualOnlyCadence({ type: 'on-demand' })).toBe(true);
    expect(isManualOnlyCadence({ type: 'cron', cronExpression: '0 7 * * *' })).toBe(false);
  });

  it('treats a manual drain as manual and an auto-starting one as not', () => {
    expect(isManualOnlyCadence({ type: 'on-demand', perpetual: true, autoStart: false })).toBe(true);
    expect(isManualOnlyCadence({ type: 'on-demand', perpetual: true })).toBe(false);
  });

  it('is false as soon as one app pins its own cron, whatever the global row says', () => {
    const appSchedules = [{ appId: 'acme', cronExpression: '0 7 * * *' }];
    expect(isManualOnlyCadence({ type: 'on-demand', appSchedules })).toBe(false);
    expect(isManualOnlyCadence({ type: 'on-demand', perpetual: true, autoStart: false, appSchedules })).toBe(false);
  });

  it('answers for a missing or empty cadence without throwing', () => {
    expect(isManualOnlyCadence()).toBe(false);
    expect(isManualOnlyCadence({})).toBe(false);
  });
});
