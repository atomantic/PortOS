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

  it('returns null for a programmatic-I/O task — its deliverable is the sentinel, not a commit (#2700)', async () => {
    // A layered-intelligence run is explicitly told NOT to commit or open a PR: it
    // writes `.agent-done` and its output hook does the filing. Checking for a
    // `[task-<id>]` commit would stamp validationPassed:false on every correct run —
    // and since a declared verdict OVERRIDES the runner's exit code in task-learning,
    // that recorded successful LI runs as failures and drove the type's success rate
    // to ~0.
    const task = { id: 't1', taskType: 'internal', metadata: { analysisType: 'layered-intelligence', selfImprovement: true } };
    expect(await evaluateSuccessCriteria({ task, workspacePath: '/w' })).toBeNull();
    expect(checkForTaskCommit).not.toHaveBeenCalled();
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
