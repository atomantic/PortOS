/**
 * Tests for `evaluateSuccessCriteria` (issue #2344) — the success-criteria
 * validation verdict finalizeAgent stamps onto every completion, distinct from
 * the runner's exit-code `success`. The `[task-<id>]` commit check is mocked so
 * these run without git; the focus is the null-sentinel gating (no criterion
 * declared vs declared-and-checked).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./agentRunTracking.js', () => ({
  checkForTaskCommit: vi.fn(),
  // finalizeAgent's other imports from this module — stubbed so the graph loads.
  createAgentRun: vi.fn(),
  completeAgentRun: vi.fn(),
}));

import { evaluateSuccessCriteria } from './agentLifecycle.js';
import { checkForTaskCommit } from './agentRunTracking.js';

describe('evaluateSuccessCriteria (#2344)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null (no declared criterion) for interactive/user tasks', async () => {
    expect(await evaluateSuccessCriteria({ task: { id: 't1', taskType: 'user' }, workspacePath: '/w' })).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('returns null for a user-terminated run — no criterion was evaluated', async () => {
    const out = await evaluateSuccessCriteria({ task: { id: 't1', taskType: 'internal' }, terminatedByUser: true, workspacePath: '/w' });
    expect(out).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('returns null when there is no task id or no workspace to validate against', async () => {
    expect(await evaluateSuccessCriteria({ task: { taskType: 'internal' }, workspacePath: '/w' })).toBeNull();
    expect(await evaluateSuccessCriteria({ task: { id: 't1', taskType: 'internal' } })).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('returns null for pipeline/media tasks (they deliver artifacts, not a commit)', async () => {
    expect(await evaluateSuccessCriteria({ task: { id: 't1', taskType: 'internal', metadata: { pipeline: true } }, workspacePath: '/w' })).toBeNull();
    expect(await evaluateSuccessCriteria({ task: { id: 't1', taskType: 'internal', metadata: { mediaJob: true } }, workspacePath: '/w' })).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('never applies the commit criterion to a programmatic-I/O task (#2700)', async () => {
    // A layered-intelligence run is explicitly told NOT to commit or open a PR: it
    // writes `.agent-done` and its output hook does the filing. Checking for a
    // `[task-<id>]` commit would stamp validationPassed:false on every correct run —
    // and since a declared verdict OVERRIDES the runner's exit code in task-learning,
    // that recorded successful LI runs as failures and drove the type's success rate
    // to ~0.
    const task = { id: 't1', taskType: 'internal', metadata: { analysisType: 'layered-intelligence', selfImprovement: true } };
    await evaluateSuccessCriteria({ task, workspacePath: '/w', success: true, hookResult: { ran: true, outcome: { action: 'filed' } } });
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });
});

/**
 * The programmatic-I/O criterion (#2727): these tasks declare their OWN success
 * criterion — "the sentinel parsed and the output hook accepted it" — instead of
 * declaring none and falling through to the runner's exit code, which recorded an
 * exit-0 run that produced nothing usable as a success.
 */
describe('evaluateSuccessCriteria — programmatic-I/O criterion (#2727)', () => {
  beforeEach(() => vi.clearAllMocks());

  const liTask = { id: 't1', taskType: 'internal', metadata: { analysisType: 'layered-intelligence' } };

  it('records an exit-0 run with a missing/malformed sentinel as a FAILURE', async () => {
    // The hook reports `unparseable-response` when the `.agent-done` payload is
    // absent or unparseable — the run exited clean but produced nothing usable.
    const hookResult = { ran: true, outcome: { action: 'no-op', reason: 'unparseable-response' } };
    expect(await evaluateSuccessCriteria({ task: liTask, workspacePath: '/w', success: true, hookResult })).toBe(false);
  });

  it('records an exit-0 run whose output hook THREW as a FAILURE', async () => {
    expect(await evaluateSuccessCriteria({
      task: liTask, workspacePath: '/w', success: true, hookResult: { ran: true, threw: true }
    })).toBe(false);
  });

  it('records an exit-0 run whose hook accepted the payload as a SUCCESS — no commit required', async () => {
    const hookResult = { ran: true, outcome: { app: 'a1', action: 'filed', reason: null } };
    expect(await evaluateSuccessCriteria({ task: liTask, workspacePath: '/w', success: true, hookResult })).toBe(true);
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('treats benign hook reasons (no-proposal, duplicate, scope-suppressed) as a SUCCESS', async () => {
    // The agent did its job; the deterministic step simply had nothing to file.
    for (const reason of ['no-proposal', 'duplicate', 'semantic-duplicate', 'scope-suppressed', 'tracker-read-failed']) {
      expect(await evaluateSuccessCriteria({
        task: liTask, workspacePath: '/w', success: true, hookResult: { ran: true, outcome: { action: 'no-op', reason } }
      })).toBe(true);
    }
  });

  it('records a non-zero exit as a FAILURE regardless of the hook outcome', async () => {
    expect(await evaluateSuccessCriteria({
      task: liTask, workspacePath: '/w', success: false, hookResult: { ran: true, outcome: { action: 'no-op', reason: 'agent-failed' } }
    })).toBe(false);
  });

  it('declares NO verdict (null) when no hook ran — "not evaluated" must not become "accepted"', async () => {
    // Sentinel discipline: a registered type whose module exports no
    // processTaskOutput yields `{ ran: false }`. Nothing judged the output, so the
    // verdict is undeclared and task-learning falls back to the exit code.
    expect(await evaluateSuccessCriteria({ task: liTask, workspacePath: '/w', success: true, hookResult: { ran: false } })).toBeNull();
    expect(await evaluateSuccessCriteria({ task: liTask, workspacePath: '/w', success: true })).toBeNull();
  });

  it('declares NO verdict for a user-terminated programmatic-I/O run', async () => {
    expect(await evaluateSuccessCriteria({
      task: liTask, workspacePath: '/w', success: false, terminatedByUser: true, hookResult: { ran: true, threw: true }
    })).toBeNull();
  });

  it('judges the hook result even with no workspace to validate against', async () => {
    // The commit criterion needs a workspace; the programmatic-I/O criterion does
    // not — a hook that already ran is a real verdict even if the worktree is gone.
    expect(await evaluateSuccessCriteria({
      task: liTask, success: true, hookResult: { ran: true, threw: true }
    })).toBe(false);
  });

  it('still applies the commit criterion to a NON-programmatic self-improvement task', async () => {
    // The exemption is keyed on the taskTypeHooks registry, not on selfImprovement —
    // an ordinary self-improve task still commits and must still be checked.
    checkForTaskCommit.mockResolvedValueOnce(true);
    const task = { id: 't1', taskType: 'internal', metadata: { analysisType: 'ui', selfImprovement: true } };
    expect(await evaluateSuccessCriteria({ task, workspacePath: '/w' })).toBe(true);
    expect(checkForTaskCommit).toHaveBeenCalledWith('t1', '/w');
  });

  it('returns the commit-check verdict for an autonomous code task (criterion declared)', async () => {
    checkForTaskCommit.mockResolvedValueOnce(true);
    expect(await evaluateSuccessCriteria({ task: { id: 't1', taskType: 'internal' }, workspacePath: '/w' })).toBe(true);
    expect(checkForTaskCommit).toHaveBeenCalledWith('t1', '/w');

    // A clean run that produced NO commit is an honest miss (false, not null).
    checkForTaskCommit.mockResolvedValueOnce(false);
    expect(await evaluateSuccessCriteria({ task: { id: 't2', taskType: 'internal' }, workspacePath: '/w' })).toBe(false);
  });
});
