/**
 * CD agent-deliverable gate (#4146) — the pure decisions behind "did the PATCH
 * actually land?" and "has this stage come back empty too many times to keep
 * re-dispatching?".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_CONSECUTIVE_MISSED_DELIVERABLES } from '../../lib/creativeDirectorPresets.js';

const mockUpdateRun = vi.fn(async () => ({}));
vi.mock('./local.js', () => ({ updateRun: (...a) => mockUpdateRun(...a) }));

const {
  DELIVERABLE_KINDS,
  blockedStageReason,
  closeDeliverableStreak,
  countConsecutiveMissedDeliverables,
  deliverableLanded,
  deliverableMark,
  exhaustedDeliverableStreak,
  missedDeliverableReason,
} = await import('./deliverableGate.js');

const missed = (over = {}) => ({ runId: `r-${Math.random()}`, kind: 'plan', status: 'failed', deliverableMissing: true, ...over });

beforeEach(() => vi.clearAllMocks());

describe('deliverableMark (pure)', () => {
  it('is null when the plan is absent or has no steps array', () => {
    expect(deliverableMark({}, 'plan')).toBeNull();
    expect(deliverableMark({ plan: {} }, 'plan')).toBeNull();
    expect(deliverableMark(null, 'plan')).toBeNull();
  });
  it('keys a plan on replanRounds so a re-plan is distinguishable from a no-op', () => {
    expect(deliverableMark({ plan: { steps: [], replanRounds: 0 } }, 'plan')).toBe('plan:0');
    expect(deliverableMark({ plan: { steps: [], replanRounds: 3 } }, 'plan')).toBe('plan:3');
  });
  it('is null when the treatment is absent, and shape-keyed when present', () => {
    expect(deliverableMark({}, 'treatment')).toBeNull();
    expect(deliverableMark({ treatment: {} }, 'treatment')).toBeNull();
    expect(deliverableMark({ treatment: { scenes: [{}, {}], logline: 'L' } }, 'treatment')).toBe('treatment:2:L');
  });
  it('is null for a kind with no verifiable PATCH deliverable', () => {
    expect(deliverableMark({ treatment: { scenes: [] } }, 'evaluate')).toBeNull();
    expect(DELIVERABLE_KINDS.has('evaluate')).toBe(false);
  });
});

describe('deliverableLanded (pure)', () => {
  it('is false when the deliverable is still absent', () => {
    expect(deliverableLanded({ plan: null }, 'plan', null)).toBe(false);
  });
  it('is true when it went from absent to present', () => {
    expect(deliverableLanded({ plan: { steps: [{}], replanRounds: 0 } }, 'plan', null)).toBe(true);
  });
  it('is FALSE for a re-plan that left the existing plan untouched', () => {
    const project = { plan: { steps: [{}], replanRounds: 1 } };
    expect(deliverableLanded(project, 'plan', 'plan:1')).toBe(false);
  });
  it('is true for a re-plan that rewrote the plan (replanRounds advanced)', () => {
    const project = { plan: { steps: [{}], replanRounds: 2 } };
    expect(deliverableLanded(project, 'plan', 'plan:1')).toBe(true);
  });
  it('distinguishes an ABSENT baseline (undefined) from a recorded-absent one (null)', () => {
    const project = { plan: { steps: [{}], replanRounds: 1 } };
    // undefined = a run enqueued before the mark existed — never manufacture a
    // failure from a baseline we never took.
    expect(deliverableLanded(project, 'plan', undefined)).toBe(true);
    // null = we DID record "there was no plan", and there still is one now.
    expect(deliverableLanded(project, 'plan', null)).toBe(true);
    // …but an unchanged plan with a recorded baseline is a miss.
    expect(deliverableLanded(project, 'plan', 'plan:1')).toBe(false);
  });
});

describe('countConsecutiveMissedDeliverables (pure)', () => {
  it('is 0 for no runs, a non-array, or runs of another kind', () => {
    expect(countConsecutiveMissedDeliverables(undefined, 'plan')).toBe(0);
    expect(countConsecutiveMissedDeliverables([], 'plan')).toBe(0);
    expect(countConsecutiveMissedDeliverables([missed({ kind: 'treatment' })], 'plan')).toBe(0);
  });
  it('counts the trailing streak of empty runs of that kind', () => {
    expect(countConsecutiveMissedDeliverables([missed(), missed()], 'plan')).toBe(2);
  });
  it('ignores interleaved runs of OTHER kinds without breaking the streak', () => {
    const runs = [missed(), { runId: 'e1', kind: 'evaluate', status: 'completed' }, missed()];
    expect(countConsecutiveMissedDeliverables(runs, 'plan')).toBe(2);
  });
  it('stops at the most recent run of that kind that DID deliver', () => {
    const runs = [missed(), { runId: 'ok', kind: 'plan', status: 'completed' }, missed()];
    expect(countConsecutiveMissedDeliverables(runs, 'plan')).toBe(1);
  });
  it('stops at an already-closed streak so a Resume gets a fresh budget', () => {
    const runs = [missed({ deliverableStreakClosed: true }), missed({ deliverableStreakClosed: true })];
    expect(countConsecutiveMissedDeliverables(runs, 'plan')).toBe(0);
    expect(countConsecutiveMissedDeliverables([...runs, missed()], 'plan')).toBe(1);
  });
  it('does not count an ordinary failed run (one that never reached the deliverable check)', () => {
    expect(countConsecutiveMissedDeliverables([{ runId: 'x', kind: 'plan', status: 'failed' }], 'plan')).toBe(0);
  });
});

describe('exhaustedDeliverableStreak', () => {
  it('trips exactly at the named bound, reporting the streak length', () => {
    const runs = Array.from({ length: MAX_CONSECUTIVE_MISSED_DELIVERABLES - 1 }, () => missed());
    expect(exhaustedDeliverableStreak(runs, 'plan')).toBe(0);
    expect(exhaustedDeliverableStreak([...runs, missed()], 'plan')).toBe(MAX_CONSECUTIVE_MISSED_DELIVERABLES);
  });
});

describe('closeDeliverableStreak', () => {
  it('stamps every run in the trailing streak and nothing older', async () => {
    const runs = [
      missed({ runId: 'old', deliverableStreakClosed: true }),
      { runId: 'ok', kind: 'plan', status: 'completed' },
      missed({ runId: 'a' }),
      missed({ runId: 'b' }),
    ];
    await closeDeliverableStreak('cd-1', runs, 'plan');
    expect(mockUpdateRun).toHaveBeenCalledTimes(2);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'b', { deliverableStreakClosed: true });
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'a', { deliverableStreakClosed: true });
  });
  it('is a no-op with no runs, and swallows a store error (runs outside the request lifecycle)', async () => {
    await closeDeliverableStreak('cd-1', undefined, 'plan');
    expect(mockUpdateRun).not.toHaveBeenCalled();
    mockUpdateRun.mockRejectedValueOnce(new Error('boom'));
    await expect(closeDeliverableStreak('cd-1', [missed({ runId: 'a' })], 'plan')).resolves.toBeUndefined();
  });
});

describe('reason strings', () => {
  it('name the stage and the concrete remedy', () => {
    expect(blockedStageReason('plan', 2)).toMatch(/plan agent finished 2 time\(s\)/);
    expect(blockedStageReason('plan', 2)).toMatch(/tool-capable model/);
    expect(missedDeliverableReason('treatment')).toMatch(/never wrote the treatment/);
  });
});
