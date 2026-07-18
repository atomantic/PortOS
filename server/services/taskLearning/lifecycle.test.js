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

import { backfillFromHistory } from './lifecycle.js';
import { recordTaskCompletion } from './metrics.js';

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
