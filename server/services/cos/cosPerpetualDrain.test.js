import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectActionableWork } from '../perpetualWork.js';
import { cosEvents } from './cosEvents.js';
import {
  applyPerpetualWorkGate,
  recordDeferredPerpetualDispatch,
  shouldParkUnchangedPerpetualWork,
} from './cosPerpetualDrain.js';

vi.mock('../perpetualWork.js', () => ({ detectActionableWork: vi.fn() }));

describe('claim drain convergence', () => {
  it('parks a successful no-progress run when the actionable set is unchanged', () => {
    const detection = { actionable: true, signature: '[101,202]' };
    expect(shouldParkUnchangedPerpetualWork(detection, '[101,202]', 2)).toBe(true);
    expect(shouldParkUnchangedPerpetualWork(detection, '[101,202]', 1)).toBe(false);
  });

  it('continues when the candidate set changed or has no progress identity', () => {
    expect(shouldParkUnchangedPerpetualWork({ actionable: true, signature: '[202]' }, '[101,202]', 2)).toBe(false);
    expect(shouldParkUnchangedPerpetualWork({ actionable: true }, '[101,202]', 2)).toBe(false);
    expect(shouldParkUnchangedPerpetualWork({ actionable: true, signature: '[101,202]' }, null, 2)).toBe(false);
    expect(shouldParkUnchangedPerpetualWork({ actionable: false, signature: '[]' }, '[]', 2)).toBe(false);
  });

  it('does not confuse tracker-specific signatures', () => {
    expect(shouldParkUnchangedPerpetualWork(
      { actionable: true, signature: '{"taskType":"claim-issue-gitlab","candidates":"[1]"}' },
      '{"taskType":"claim-issue","candidates":"[1]"}',
      2
    )).toBe(false);
  });
});

describe('recordDeferredPerpetualDispatch (#6871)', () => {
  it.each([
    { taskType: 'code-quality', appId: 'app-1', signature: 'sig-abc' },
    { taskType: 'code-quality', appId: null, signature: null },
  ])('spends the budget from the dispatch record %j', async (pendingPerpetualDispatch) => {
    const recordPerpetualDispatch = vi.fn(async () => 1);

    const recorded = await recordDeferredPerpetualDispatch(pendingPerpetualDispatch, { recordPerpetualDispatch });

    expect(recorded).toBe(true);
    expect(recordPerpetualDispatch).toHaveBeenCalledExactlyOnceWith(
      pendingPerpetualDispatch.taskType, pendingPerpetualDispatch.appId, pendingPerpetualDispatch.signature,
    );
  });

  it.each([null, {}, { appId: 'app-1', signature: 'sig-abc' }])('ignores a missing task type in %j', async (pendingDispatch) => {
    const recordPerpetualDispatch = vi.fn(async () => 1);

    expect(await recordDeferredPerpetualDispatch(pendingDispatch, { recordPerpetualDispatch })).toBe(false);
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
  });
});

describe('applyPerpetualWorkGate', () => {
  const app = { id: 'example-app', name: 'Example App' };
  const taskType = 'claim-work';
  const promptTaskType = 'claim-issue';
  const signature = JSON.stringify({ taskType: promptTaskType, candidates: '[101,202]' });
  const actionable = {
    actionable: true, count: 2, total: 7, inFlightCount: 3, filteredCount: 2,
    signature: '[101,202]', candidates: [101, 202],
  };
  const transient = {
    actionable: false, transient: true, cli: 'gh', reason: 'gh-unavailable',
    detail: 'Example forge unreachable', remedy: 'Restore forge access',
  };
  let schedule;
  let metadata;

  const evaluate = ({ target = app, type = taskType, interval = { perpetual: true }, ignoreTaskId } = {}) => (
    applyPerpetualWorkGate(target, type, promptTaskType, metadata, interval, schedule, { ignoreTaskId })
  );

  beforeEach(() => {
    detectActionableWork.mockReset();
    schedule = {
      recordPerpetualStall: vi.fn(),
      getPerpetualDrainState: vi.fn().mockResolvedValue({ signature: null, dispatchCount: 0 }),
      parkPerpetual: vi.fn(),
      recordPerpetualDispatch: vi.fn(),
    };
    metadata = {};
  });

  it.each([
    ['cadenced task', taskType, { perpetual: false }],
    ['branch reconciliation', 'branch-reconcile', { perpetual: true }],
    ['issue reconciliation', 'issue-reconcile', { perpetual: true }],
  ])('leaves the detector idle for %s', async (_name, type, interval) => {
    await expect(evaluate({ type, interval })).resolves.toEqual({ skip: false });
    expect(detectActionableWork).not.toHaveBeenCalled();
    expect(schedule.parkPerpetual).not.toHaveBeenCalled();
    expect(metadata).toEqual({});
  });

  it.each([
    ['one same-issue continuation', signature, 1],
    ['changed signature', 'previous-candidates', 2],
  ])('admits actionable work for %s and defers spending', async (_name, previous, dispatchCount) => {
    detectActionableWork.mockResolvedValue(actionable);
    schedule.getPerpetualDrainState.mockResolvedValue({ signature: previous, dispatchCount });
    metadata = { issueAuthorFilter: 'self', issueExcludeLabels: ['blocked'], issueMinAgeMinutes: 30 };

    await expect(evaluate({ ignoreTaskId: 'just-finished' })).resolves.toEqual({
      skip: false, spendDispatch: true, signature, candidates: [101, 202],
    });
    expect(detectActionableWork).toHaveBeenCalledExactlyOnceWith(promptTaskType, app, {
      issueAuthorFilter: 'self', issueExcludeLabels: ['blocked'], issueMinAgeMinutes: 30,
      ignoreTaskId: 'just-finished',
    });
    expect(metadata.perpetual).toBe(true);
    expect(schedule.recordPerpetualStall).toHaveBeenCalledExactlyOnceWith(taskType, app.id, null);
    expect(schedule.parkPerpetual).not.toHaveBeenCalled();
    expect(schedule.recordPerpetualDispatch).not.toHaveBeenCalled();
  });

  it('admits an actionable detector without a signature without reading prior progress', async () => {
    detectActionableWork.mockResolvedValue({ actionable: true, count: 1 });

    await expect(evaluate()).resolves.toEqual({ skip: false, spendDispatch: true, signature: null, candidates: [] });
    expect(schedule.getPerpetualDrainState).not.toHaveBeenCalled();
  });

  it.each([
    [actionable, { open: 7, inFlight: 3, filtered: 2 }],
    [{ ...actionable, total: undefined }, null],
  ])('parks unchanged work after the continuation for detector result %j', async (detection, counts) => {
    detectActionableWork.mockResolvedValue(detection);
    schedule.getPerpetualDrainState.mockResolvedValue({ signature, dispatchCount: 2 });

    await expect(evaluate()).resolves.toEqual({ skip: true });
    expect(schedule.parkPerpetual).toHaveBeenCalledExactlyOnceWith(taskType, app.id, {
      reason: 'no-progress', actionableCount: 2, counts, signature: null,
    });
    expect(metadata).toEqual({});
    expect(schedule.recordPerpetualDispatch).not.toHaveBeenCalled();
  });

  it('parks a definitive idle result with the detector’s breakdown', async () => {
    detectActionableWork.mockResolvedValue({
      actionable: false, reason: 'all-filtered', count: 0, total: 3,
      filteredCount: 3, skipCauses: { blocked: 3 },
    });

    await expect(evaluate()).resolves.toEqual({ skip: true });
    expect(schedule.recordPerpetualStall).toHaveBeenCalledExactlyOnceWith(taskType, app.id, null);
    expect(schedule.parkPerpetual).toHaveBeenCalledExactlyOnceWith(taskType, app.id, {
      reason: 'all-filtered', actionableCount: 0, counts: { open: 3, inFlight: 0, filtered: 3 },
      skipCauses: { blocked: 3 }, signature: null,
    });
  });

  it('escalates at the third consecutive transient failure for the same task type and app without parking', async () => {
    detectActionableWork.mockResolvedValue(transient);
    const target = { ...app, id: 'stalled-app' };
    const sibling = { ...app, id: 'sibling-app' };
    const log = vi.fn();
    cosEvents.on('log', log);
    try {
      for (const attempt of [{ target }, { target }, { target: sibling }, { target, type: 'plan-task' }]) {
        await expect(evaluate(attempt)).resolves.toEqual({
          skip: true,
          verdict: { cli: 'gh', reason: 'gh-unavailable', detail: transient.detail, remedy: transient.remedy },
        });
      }
      expect(schedule.recordPerpetualStall).not.toHaveBeenCalled();

      await evaluate({ target });
      expect(schedule.recordPerpetualStall).toHaveBeenCalledExactlyOnceWith(taskType, target.id, {
        cli: 'gh', reason: 'gh-unavailable', detail: transient.detail, consecutive: 3,
      });
      expect(log.mock.calls.map(([entry]) => [entry.level, entry.consecutive])).toEqual([
        ['debug', 1], ['debug', 2], ['debug', 1], ['debug', 1], ['warn', 3],
      ]);
      expect(schedule.parkPerpetual).not.toHaveBeenCalled();
    } finally {
      cosEvents.off('log', log);
    }
  });

  it.each([
    ['actionable', actionable],
    ['definitive idle', { actionable: false, reason: 'empty', count: 0 }],
  ])('clears the stall and resets the transient streak after an %s probe', async (name, recovered) => {
    const target = { ...app, id: `recover-${name}` };
    detectActionableWork.mockResolvedValue(transient);
    await evaluate({ target });
    await evaluate({ target });
    await evaluate({ target });

    detectActionableWork.mockResolvedValueOnce(recovered);
    await evaluate({ target });
    expect(schedule.recordPerpetualStall).toHaveBeenLastCalledWith(taskType, target.id, null);

    schedule.recordPerpetualStall.mockClear();
    await evaluate({ target });
    await evaluate({ target });
    expect(schedule.recordPerpetualStall).not.toHaveBeenCalled();
  });
});
