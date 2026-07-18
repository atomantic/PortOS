/**
 * Tests for `evaluateSuccessCriteria` (issue #2344) — the success-criteria
 * validation verdict finalizeAgent stamps onto every completion, distinct from
 * the runner's exit-code `success`. The `[task-<id>]` commit check is mocked so
 * these run without git; the focus is the null-sentinel gating (no criterion
 * declared vs declared-and-checked).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./agentRunTracking.js', () => ({
  checkForTaskCommit: vi.fn(),
  // finalizeAgent's other imports from this module — stubbed so the graph loads.
  createAgentRun: vi.fn(),
  completeAgentRun: vi.fn(),
}));

import { evaluateSuccessCriteria, resolveProgrammaticIoVerdict, withOutputHookTimeout } from './agentLifecycle.js';
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

  it('applies the criterion to a task typed on taskType alone, not just metadata.analysisType', async () => {
    // The criterion gate and the hook-dispatch gate share one resolver
    // (resolveTaskHookType), so a task shaped with the scheduled type at the top
    // level can't run a hook AND still get commit-checked (the #2700 bug, one shape
    // over).
    const task = { id: 't9', taskType: 'layered-intelligence' };
    expect(await evaluateSuccessCriteria({
      task, workspacePath: '/w', success: true, hookResult: { ran: true, threw: true }
    })).toBe(false);
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });
});

/**
 * `resolveProgrammaticIoVerdict` is the pure criterion behind the branch above.
 * Tested directly so the three-way sentinel (accepted / rejected / undeclared) is
 * pinned without routing every case through evaluateSuccessCriteria.
 */
describe('resolveProgrammaticIoVerdict (#2727)', () => {
  it('rejects a run whose hook threw, and one whose output was unparseable', () => {
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: { ran: true, threw: true } })).toBe(false);
    expect(resolveProgrammaticIoVerdict({
      success: true, hookResult: { ran: true, outcome: { reason: 'unparseable-response' } }
    })).toBe(false);
  });

  it('accepts a run whose hook processed the output', () => {
    expect(resolveProgrammaticIoVerdict({
      success: true, hookResult: { ran: true, outcome: { action: 'filed', reason: null } }
    })).toBe(true);
  });

  it('declares no verdict when nothing evaluated the output', () => {
    // No hook ran / no hook result at all / the dispatch timed out — none of these
    // are a rejection, so task-learning falls back to the exit code.
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: { ran: false } })).toBeNull();
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: null })).toBeNull();
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: { ran: false, timedOut: true } })).toBeNull();
  });

  it('declares no verdict when the hook ran but handed back no structured outcome', () => {
    // `ran: true` with a missing/non-object outcome must NOT optional-chain its way
    // into the success default — nothing evaluated the output.
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: { ran: true } })).toBeNull();
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: { ran: true, outcome: undefined } })).toBeNull();
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: { ran: true, outcome: 'nope' } })).toBeNull();
  });

  it('declares no verdict when the exit-code result is absent/non-boolean', () => {
    // "Not supplied" must not silently mean "the run failed".
    expect(resolveProgrammaticIoVerdict({ hookResult: { ran: true, outcome: { reason: null } } })).toBeNull();
    expect(resolveProgrammaticIoVerdict({ success: undefined, hookResult: { ran: true, outcome: { reason: null } } })).toBeNull();
  });

  it('treats a downstream tracker failure as a SUCCESS — the output was accepted', () => {
    // `file-failed` / `tracker-read-failed` mean the reasoning landed but the forge
    // was unreachable. That is environmental: blaming the run would tank the type's
    // success rate (and auto-park it) every time `gh` has a bad afternoon. Raised in
    // review on #2727 and deliberately kept.
    for (const reason of ['file-failed', 'tracker-read-failed']) {
      expect(resolveProgrammaticIoVerdict({ success: true, hookResult: { ran: true, outcome: { reason } } })).toBe(true);
    }
  });

  it('declares no verdict when the hook aborted before it could look at the output', () => {
    // `no-app` / `app-not-found` return before the payload is validated (and before
    // the hook records anything). Nothing evaluated the agent's output, so this is
    // the undeclared sentinel — NOT a success, which would bank a free win for the
    // type every time an app is deleted mid-run.
    for (const reason of ['no-app', 'app-not-found']) {
      expect(resolveProgrammaticIoVerdict({
        success: true, hookResult: { ran: true, outcome: { action: 'no-op', reason } }
      })).toBeNull();
    }
  });
});

/**
 * The hard bound that keeps a hung output hook from pinning a CoS concurrency slot
 * until restart — the mitigation matters enough to pin directly (#2727).
 */
describe('withOutputHookTimeout (#2727)', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves a hung dispatch to the undeclared sentinel rather than hanging finalize', async () => {
    vi.useFakeTimers();
    // A hook that never settles — the wedge case.
    const settled = withOutputHookTimeout(new Promise(() => {}), { agentId: 'a1', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    // `ran: false` → resolveProgrammaticIoVerdict returns null → task-learning falls
    // back to the exit code. A timeout is "we never got a verdict", not a rejection.
    expect(await settled).toEqual({ ran: false, timedOut: true });
    expect(resolveProgrammaticIoVerdict({ success: true, hookResult: await settled })).toBeNull();
  });

  it('passes a hook that settles in time straight through, and clears its timer', async () => {
    vi.useFakeTimers();
    const outcome = { ran: true, outcome: { action: 'filed', reason: null } };
    const settled = withOutputHookTimeout(Promise.resolve(outcome), { agentId: 'a1', timeoutMs: 1000 });
    expect(await settled).toBe(outcome);
    // Timer cleared on the resolve path — nothing left pending to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a hook rejection (finalizeAgent maps it to the thrown-hook verdict)', async () => {
    await expect(withOutputHookTimeout(Promise.reject(new Error('boom')), { agentId: 'a1', timeoutMs: 1000 }))
      .rejects.toThrow('boom');
  });
});

describe('evaluateSuccessCriteria — commit criterion (#2344)', () => {
  beforeEach(() => vi.clearAllMocks());

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

/**
 * gh/git COORDINATOR task types (#2696): branch-reconcile / issue-reconcile drive
 * their work through git+gh in the app's LIVE checkout (workspacePath IS set) and never
 * produce a `[task-<id>]` commit, so the commit criterion scored every successful run a
 * failure and drove their learning bucket to ~0% — the same artifact #2700 fixed for the
 * programmatic-I/O reasoning run. They must declare NO commit criterion (fall back to the
 * exit code), exactly like pipeline/media jobs.
 */
describe('evaluateSuccessCriteria — gh/git coordinator exemption (#2696)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('declares NO commit criterion for a branch-reconcile coordinator run', async () => {
    const task = { id: 't1', taskType: 'internal', metadata: { analysisType: 'branch-reconcile' } };
    expect(await evaluateSuccessCriteria({ task, workspacePath: '/w', success: true })).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('declares NO commit criterion for an issue-reconcile coordinator run', async () => {
    const task = { id: 't1', taskType: 'internal', metadata: { analysisType: 'issue-reconcile' } };
    expect(await evaluateSuccessCriteria({ task, workspacePath: '/w', success: false })).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('exempts a coordinator typed on taskType alone, not just metadata.analysisType', async () => {
    // Same resolver as the programmatic-I/O gate (resolveTaskHookType), so a task shaped
    // with the scheduled type at the top level is exempted the same way.
    const task = { id: 't2', taskType: 'branch-reconcile' };
    expect(await evaluateSuccessCriteria({ task, workspacePath: '/w', success: true })).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
  });

  it('does NOT exempt accessibility — it is a fixing task that DOES commit (#2696 scope)', async () => {
    // accessibility's prompt ends "Test and commit changes": it makes code changes in a
    // worktree and commits, so its commit criterion is real and its 0% (if any) is a
    // genuine agent failure, NOT the coordinator artifact. Must stay commit-checked.
    checkForTaskCommit.mockResolvedValueOnce(false);
    const task = { id: 't3', taskType: 'internal', metadata: { analysisType: 'accessibility', selfImprovement: true } };
    expect(await evaluateSuccessCriteria({ task, workspacePath: '/w', success: true })).toBe(false);
    expect(checkForTaskCommit).toHaveBeenCalledWith('t3', '/w');
  });
});
