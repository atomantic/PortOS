/**
 * Wiring guard: every completion path that cleans a worktree must also audit the
 * repo state afterwards, and must not WAIT on that audit.
 *
 * The audit hangs off `cleanupAgentWorktree` — the coalescing wrapper — rather
 * than off any single completion path, because the runner, the TUI `finish()`,
 * the direct-CLI spawn and the manual stop each call cleanup themselves. Moving
 * the hook back onto one caller would silently skip the others, which is exactly
 * the shape of the bug it exists to catch, so it is pinned here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cos.js', () => ({
  addTask: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn().mockResolvedValue({}),
  getAgent: vi.fn().mockResolvedValue(null),
  getAgentRecord: vi.fn().mockResolvedValue(null),
  getTaskById: vi.fn().mockResolvedValue(null),
}));
vi.mock('./git.js', () => ({
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
  parsePullRequestUrl: vi.fn().mockReturnValue(null),
  deleteBranch: vi.fn(),
  push: vi.fn(),
  createPR: vi.fn(),
  generatePRDescription: vi.fn(),
  suggestPRTitle: vi.fn(),
  requestCopilotReview: vi.fn(),
  isBranchMergedInto: vi.fn().mockResolvedValue(true),
}));
vi.mock('./worktreeManager.js', () => ({
  removeWorktree: vi.fn().mockResolvedValue({ removed: true, warnings: [] }),
  classifyWorktreeDirt: vi.fn().mockReturnValue({ clean: true }),
}));
vi.mock('./agentRepoStateVerification.js', () => ({
  verifyAgentRepoState: vi.fn().mockResolvedValue({ verified: true, issues: [] }),
}));

import { cleanupAgentWorktree } from './agentWorktreeCleanup.js';
import { verifyAgentRepoState } from './agentRepoStateVerification.js';
import { getAgent, getAgentRecord } from './cos.js';
import { removeWorktree } from './worktreeManager.js';

const worktreeAgent = {
  metadata: {
    isWorktree: true,
    sourceWorkspace: '/repo',
    worktreeBranch: 'cos/task-x/agent-1',
    workspacePath: '/repo/data/cos/worktrees/agent-1',
  },
};

/** The audit is fired detached, so it lands a microtask after cleanup resolves. */
const auditRan = () => vi.waitFor(() => expect(verifyAgentRepoState).toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
  // A non-worktree agent makes the cleanup itself a no-op, so these exercise the
  // wrapper's hook rather than the teardown.
  getAgent.mockResolvedValue({ metadata: { isWorktree: false } });
  getAgentRecord.mockResolvedValue(worktreeAgent);
  removeWorktree.mockResolvedValue({ removed: true, warnings: [] });
  verifyAgentRepoState.mockResolvedValue({ verified: true, issues: [] });
});

describe('cleanupAgentWorktree → repo-state audit', () => {
  it('audits after cleanup, carrying the task, the run verdict and the PR expectation', async () => {
    const originalTask = { id: 'task-1', metadata: { app: 'demo-app', openPR: true } };

    await cleanupAgentWorktree('agent-1', true, { originalTask });
    await auditRan();

    expect(verifyAgentRepoState).toHaveBeenCalledTimes(1);
    expect(verifyAgentRepoState).toHaveBeenCalledWith({
      agentId: 'agent-1',
      task: originalTask,
      agentState: worktreeAgent,
      success: true,
      prExpected: true,
      cleanupWarnings: [],
    });
  });

  it('audits once when two completion paths race the same agent', async () => {
    // The runner path and the spawner's `finally` safety net both call cleanup for
    // one completing agent. They coalesce onto a single run — and must therefore
    // produce a single audit, not two probes and two recovery tasks.
    const originalTask = { id: 'task-1', metadata: { openPR: false } };

    const [a, b] = await Promise.all([
      cleanupAgentWorktree('agent-1', true, { originalTask }),
      cleanupAgentWorktree('agent-1', true, { originalTask }),
    ]);
    await auditRan();

    expect(a).toEqual(b);
    expect(verifyAgentRepoState).toHaveBeenCalledTimes(1);
    expect(verifyAgentRepoState.mock.calls[0][0].prExpected).toBe(false);
  });

  it('does not make callers wait on the audit', async () => {
    // The audit makes two network calls; the callers awaiting cleanup still owe
    // the run a retry-hold release, a lane release and a shell-session kill.
    let releaseAudit;
    verifyAgentRepoState.mockReturnValue(new Promise(resolve => { releaseAudit = resolve; }));

    await cleanupAgentWorktree('agent-1', true, { originalTask: { id: 'task-1', metadata: {} } });

    // Reaching here at all is the assertion — an awaited audit would deadlock the
    // test until the timeout.
    await auditRan();
    releaseAudit({ verified: true, issues: [] });
  });

  it('audits only after the teardown it is auditing has finished', async () => {
    // The audit's whole job is to check what cleanup LEFT BEHIND, so it must not
    // observe a half-removed worktree. Every other case here uses a non-worktree
    // agent (cleanup exits before `removeWorktree`), which cannot prove ordering —
    // this one runs the real teardown and holds it open.
    getAgent.mockResolvedValue(worktreeAgent);
    const order = [];
    let finishRemoval;
    removeWorktree.mockReturnValue(new Promise(resolve => {
      finishRemoval = () => { order.push('removeWorktree'); resolve({ removed: true, warnings: [] }); };
    }));
    verifyAgentRepoState.mockImplementation(async () => {
      order.push('audit');
      return { verified: true, issues: [] };
    });

    const cleanup = cleanupAgentWorktree('agent-1', true, { originalTask: { id: 'task-1', metadata: {} } });
    // The audit must not have fired while the teardown is still in flight.
    await Promise.resolve();
    expect(order).toEqual([]);

    finishRemoval();
    await cleanup;
    await auditRan();

    expect(order).toEqual(['removeWorktree', 'audit']);
  });

  it('returns the cleanup warnings unchanged, and survives an audit that throws', async () => {
    // The audit is an observer. A failure in it must never swallow the warnings
    // the caller uses to notify the user and spawn a merge recovery task.
    getAgent.mockResolvedValue(worktreeAgent);
    removeWorktree.mockResolvedValue({ removed: false, warnings: ['Worktree preserved — uncommitted changes detected'] });
    verifyAgentRepoState.mockRejectedValue(new Error('probe exploded'));

    const warnings = await cleanupAgentWorktree('agent-1', true, {
      originalTask: { id: 'task-1', metadata: {} },
    });
    await auditRan();

    expect(warnings).toEqual(['Worktree preserved — uncommitted changes detected']);
    expect(verifyAgentRepoState.mock.calls[0][0].cleanupWarnings)
      .toEqual(['Worktree preserved — uncommitted changes detected']);
  });
});
