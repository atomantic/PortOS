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

  it('returns the commit-check verdict for an autonomous code task (criterion declared)', async () => {
    checkForTaskCommit.mockResolvedValueOnce(true);
    expect(await evaluateSuccessCriteria({ task: { id: 't1', taskType: 'internal' }, workspacePath: '/w' })).toBe(true);
    expect(checkForTaskCommit).toHaveBeenCalledWith('t1', '/w');

    // A clean run that produced NO commit is an honest miss (false, not null).
    checkForTaskCommit.mockResolvedValueOnce(false);
    expect(await evaluateSuccessCriteria({ task: { id: 't2', taskType: 'internal' }, workspacePath: '/w' })).toBe(false);
  });
});
