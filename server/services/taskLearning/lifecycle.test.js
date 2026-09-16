import { describe, it, expect, vi, beforeEach } from 'vitest';

// backfillFromHistory (#2696): re-recording a pre-fix gh/git coordinator agent verbatim would
// restore the very learning bucket migration 198 purged, because those agents carry a fossil
// `result.validationPassed:false` stamped by the old commit criterion and recordTaskCompletion
// trusts a persisted boolean over the exit code. The backfill must strip that fossil for
// coordinator types (and only those) so the exit-code success stands.

const agentsStore = vi.hoisted(() => ({ list: [] }));

vi.mock('./metrics.js', () => ({
  recordTaskCompletion: vi.fn(async () => {}),
  recalculateModelTierMetrics: vi.fn(async () => {}),
}));
vi.mock('./store.js', () => ({
  cosEvents: { on: vi.fn() },
  emitLog: vi.fn(),
}));
vi.mock('../cos.js', () => ({ getAgents: vi.fn(async () => agentsStore.list) }));
vi.mock('../agentChurn.js', () => ({
  observeAgentChurn: vi.fn(async () => ({ flagged: false })),
}));

import { backfillFromHistory, initTaskLearning } from './lifecycle.js';
import { recordTaskCompletion } from './metrics.js';
import { cosEvents } from './store.js';
import { observeAgentChurn } from '../agentChurn.js';

const completed = (taskId, analysisType, validationPassed) => ({
  status: 'completed',
  taskId,
  result: { success: true, duration: 100, validationPassed },
  metadata: { analysisType, taskType: 'internal', taskDescription: taskId },
});

describe('backfillFromHistory — stale coordinator verdict (#2696)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('strips a fossil validationPassed:false for a coordinator agent before re-recording', async () => {
    agentsStore.list = [completed('t1', 'branch-reconcile', false)];
    await backfillFromHistory();
    const [agentArg] = recordTaskCompletion.mock.calls[0];
    // null → recordTaskCompletion falls back to the exit-code success (a true coordinator run),
    // instead of restoring the 0% bucket the migration just purged.
    expect(agentArg.result.validationPassed).toBeNull();
  });

  it('strips the fossil for every coordinator type', async () => {
    agentsStore.list = ['branch-reconcile', 'issue-reconcile', 'branch-cleanup', 'jira-status-report']
      .map((t, i) => completed(`t${i}`, t, false));
    await backfillFromHistory();
    for (const call of recordTaskCompletion.mock.calls) {
      expect(call[0].result.validationPassed).toBeNull();
    }
  });

  it('strips the fossil for the ARCHIVED shape (taskAnalysisType, no analysisType) (#2696 codex)', async () => {
    // agentLifecycle stamps the run type onto the AGENT as metadata.taskAnalysisType, and the
    // backfill re-processes exactly that shape. extractTaskType buckets it as
    // self-improve:branch-reconcile, so the sanitizer MUST recognize it too, or the purge is
    // undone. (No `analysisType` key — only the archived `taskAnalysisType`.)
    agentsStore.list = [{
      status: 'completed', taskId: 't1',
      result: { success: true, duration: 100, validationPassed: false },
      metadata: { taskAnalysisType: 'branch-reconcile', taskType: 'internal' },
    }];
    await backfillFromHistory();
    expect(recordTaskCompletion.mock.calls[0][0].result.validationPassed).toBeNull();
  });

  it('strips the fossil for an archived tracker-filing run on a forge tracker (#3273)', async () => {
    // A reference-watch/ux run on a github/gitlab/jira app files issues out of band
    // and makes no commit, so its persisted `validationPassed: false` is a fossil of
    // the same #2696 artifact. This is the ARCHIVED shape agentLifecycle projects —
    // `taskAnalysisType` plus the explicitly-projected `worktreeChangesExpected`
    // (a hand-picked projection: if that field ever stops being projected, this
    // fails and the backfill silently stops stripping these).
    agentsStore.list = ['reference-watch', 'ux'].map((t, i) => ({
      status: 'completed', taskId: `t${i}`,
      result: { success: true, duration: 100, validationPassed: false },
      metadata: { taskAnalysisType: t, taskType: 'internal', worktreeChangesExpected: false },
    }));
    await backfillFromHistory();
    for (const call of recordTaskCompletion.mock.calls) {
      expect(call[0].result.validationPassed).toBeNull();
    }
  });

  it('keeps the fossil for a tracker-filing run on a PLAN.md tracker — it really does commit', async () => {
    agentsStore.list = [{
      status: 'completed', taskId: 't1',
      result: { success: true, duration: 100, validationPassed: false },
      metadata: { taskAnalysisType: 'ux', taskType: 'internal', worktreeChangesExpected: true },
    }];
    await backfillFromHistory();
    expect(recordTaskCompletion.mock.calls[0][0].result.validationPassed).toBe(false);
  });

  it('skips a record retired by a resume — the live listener already refused it', async () => {
    // The listener below skips these as they happen, but the backfill re-reads the
    // ARCHIVE, where every relaunch it skipped is still sitting as a
    // `success: false` record. One backfill would re-import the whole set of
    // phantom failures the listener spent the install's lifetime refusing.
    agentsStore.list = [
      { status: 'completed', taskId: 't-relaunched',
        result: { success: false, duration: 100, resumed: true, resumedTaskId: 't-relaunched', error: 'Relaunched by user on codex' },
        metadata: { taskType: 'user', taskDescription: 'swapped providers mid-run' } },
      completed('t-real', 'accessibility', true),
    ];
    await backfillFromHistory();
    expect(recordTaskCompletion).toHaveBeenCalledTimes(1);
    expect(recordTaskCompletion.mock.calls[0][0].taskId).toBe('t-real');
  });

  it('passes a committing type through UNTOUCHED — its commit verdict is real', async () => {
    // accessibility genuinely commits; a persisted false is a real miss, not a fossil.
    agentsStore.list = [completed('t1', 'accessibility', false)];
    await backfillFromHistory();
    expect(recordTaskCompletion.mock.calls[0][0].result.validationPassed).toBe(false);
  });

  it('leaves a coordinator agent with no boolean verdict untouched (nothing to strip)', async () => {
    agentsStore.list = [completed('t1', 'branch-cleanup', null)];
    await backfillFromHistory();
    expect(recordTaskCompletion.mock.calls[0][0].result.validationPassed).toBeNull();
  });
});

describe('agent:completed listener — a resumed record is a continuation, not an outcome', () => {
  beforeEach(() => vi.clearAllMocks());

  // `resumeAgent` (agentManagement.js) retires a PAUSED record via completeAgent so it
  // stops showing as paused. That fires `agent:completed` with `success: false` — but the
  // run wasn't a failure, it was interrupted by the user and its task is already back in
  // the queue. Learning from it charges the task type and model tier a phantom failure
  // per pause, and double-counts the task once the continuation finishes.
  const emitCompleted = async (agent) => {
    initTaskLearning();
    const handler = cosEvents.on.mock.calls.find(([event]) => event === 'agent:completed')[1];
    await handler(agent);
  };

  it('skips a record retired by a resume', async () => {
    await emitCompleted({
      status: 'completed', taskId: 't1',
      result: { success: false, resumed: true, resumedTaskId: 't1' },
      metadata: { taskType: 'user', taskDescription: 'Half-finished work' },
    });
    expect(recordTaskCompletion).not.toHaveBeenCalled();
  });

  it('still records an ordinary failed run', async () => {
    await emitCompleted({
      status: 'completed', taskId: 't1',
      result: { success: false, error: 'tests failed' },
      metadata: { taskType: 'user', taskDescription: 'Half-finished work' },
    });
    expect(recordTaskCompletion).toHaveBeenCalledTimes(1);
    expect(observeAgentChurn).toHaveBeenCalledTimes(1);
  });

  it('does not observe churn for a resume continuation', async () => {
    await emitCompleted({
      status: 'completed', taskId: 't1',
      result: { success: false, resumed: true, resumedTaskId: 't1' },
      metadata: { taskType: 'user', taskDescription: 'Half-finished work' },
    });
    expect(observeAgentChurn).not.toHaveBeenCalled();
  });
});
