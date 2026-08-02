/**
 * Tests for the PR-claim verification finalizeAgent runs before it records a
 * completion (#3358).
 *
 * The bug: an agent that owns its own `/do:pr` step commits, pushes over SSH
 * (unaffected by an outbound block on `gh`), fails to create the pull request,
 * writes its `.agent-done` sentinel anyway — and PortOS records "Completed
 * successfully" against a branch nobody will ever review. Nothing in the
 * completion path asked the forge whether the PR exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execGitMock = vi.fn();
vi.mock('../lib/execGit.js', () => ({
  execGit: (...args) => execGitMock(...args),
}));

const findPullRequestForBranchMock = vi.fn();
vi.mock('./github.js', () => ({
  findPullRequestForBranch: (...args) => findPullRequestForBranchMock(...args),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));

const completeAgentMock = vi.fn();
vi.mock('./cosAgents.js', () => ({
  getAgent: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  completeAgent: (...args) => completeAgentMock(...args),
}));

const updateTaskMock = vi.fn(async () => ({}));
vi.mock('./cos.js', () => ({ updateTask: (...args) => updateTaskMock(...args) }));
vi.mock('./providers.js', () => ({ getActiveProvider: vi.fn(async () => null) }));
vi.mock('./providerStatus.js', () => ({
  markProviderUsageLimit: vi.fn(async () => null),
  markProviderRateLimited: vi.fn(async () => null),
}));
vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({ completeExecution: vi.fn(), errorExecution: vi.fn() }));

const resolveFailedTaskUpdateMock = vi.fn(async (_task, analysis) => ({
  status: 'pending',
  metadata: { lastErrorCategory: analysis?.category || null },
}));
vi.mock('./agentErrorAnalysis.js', () => ({
  resolveFailedTaskUpdate: (...args) => resolveFailedTaskUpdateMock(...args),
  resolveTypeFailureSignal: vi.fn(() => ({ record: 'skip' })),
}));

const completeAgentRunMock = vi.fn(async () => null);
vi.mock('./agentRunTracking.js', () => ({
  checkForTaskCommit: vi.fn(async () => true),
  createAgentRun: vi.fn(),
  completeAgentRun: (...args) => completeAgentRunMock(...args),
}));

vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => false),
  resolveTaskHookType: vi.fn(() => null),
  declaresNoCommitCriterion: vi.fn(() => false),
  getTaskOutputHook: vi.fn(async () => null),
}));

vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractSimplifySummaries: vi.fn(() => null) }));

import {
  verifyPrClaim,
  finalizeAgent,
  PR_MISSING_CATEGORY,
  FORGE_UNREACHABLE_CATEGORY,
} from './agentFinalization.js';

const onBranch = (name) => execGitMock.mockResolvedValue({ stdout: `${name}\n`, stderr: '', exitCode: 0 });

const prTask = () => ({
  id: 'task-1',
  taskType: 'internal',
  description: 'ship something',
  metadata: { openPR: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  execGitMock.mockResolvedValue({ stdout: 'claim/issue-1\n', stderr: '', exitCode: 0 });
  findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7' });
});

describe('verifyPrClaim (#3358)', () => {
  it('passes when the forge confirms a PR for the branch', async () => {
    onBranch('claim/issue-1');
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(true);
    expect(findPullRequestForBranchMock).toHaveBeenCalledWith('claim/issue-1', { cwd: '/w' });
  });

  it('fails with pr-missing when the forge answered and has no PR', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.category).toBe(PR_MISSING_CATEGORY);
    expect(verdict.branch).toBe('claim/issue-1');
  });

  it('fails with forge-unreachable — NOT pr-missing — when we could not ask', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({
      status: 'unavailable', number: null, url: null, detail: 'connect: bad file descriptor'
    });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.category).toBe(FORGE_UNREACHABLE_CATEGORY);
    // The two are deliberately distinct: one is the agent's miss, the other the
    // machine's, and only the latter is treated as environmental by learning.
    expect(verdict.category).not.toBe(PR_MISSING_CATEGORY);
  });

  it('does not check when PortOS (not the agent) owns PR creation', async () => {
    // The PR is created by cleanupAgentWorktree AFTER finalize, so a check here
    // would report every correct slashdo-free TUI / runner-mode run as missing.
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: false });
    expect(verdict.ok).toBe(true);
    expect(findPullRequestForBranchMock).not.toHaveBeenCalled();
  });

  it('does not check a run that already failed — there is no success claim to verify', async () => {
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: false, prExpected: true });
    expect(verdict.ok).toBe(true);
    expect(findPullRequestForBranchMock).not.toHaveBeenCalled();
  });

  it('passes (verifies nothing) when the workspace has no resolvable branch', async () => {
    execGitMock.mockResolvedValue({ stdout: 'HEAD\n', stderr: '', exitCode: 0 });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.branch).toBeNull();
    expect(findPullRequestForBranchMock).not.toHaveBeenCalled();
  });
});

describe('finalizeAgent — a PR-shaped run with no PR is not a success (#3358)', () => {
  const finalize = (overrides = {}) => finalizeAgent({
    agentId: 'agent-1',
    task: prTask(),
    runId: null,
    providerId: 'claude-code',
    success: true,
    exitCode: 0,
    duration: 1000,
    outputBuffer: 'done',
    errorAnalysis: null,
    workspacePath: '/w',
    prExpected: true,
    ...overrides,
  });

  it('records success when the PR exists', async () => {
    onBranch('claim/issue-1');
    await finalize();
    expect(completeAgentMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ success: true }));
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
  });

  it('does NOT record "completed" when the forge says no PR exists', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize();

    const [, result] = completeAgentMock.mock.calls[0];
    expect(result.success).toBe(false);
    expect(result.completionReason).toBe(PR_MISSING_CATEGORY);
    expect(result.error).toMatch(/no pull request exists for branch claim\/issue-1/i);
    // The task must not be marked completed — it goes back through the failure
    // path so it can retry and actually open the PR.
    expect(updateTaskMock).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
  });

  it('marks the RUN record failed too, even though the process exited 0', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize({ runId: 'run-1' });
    // 6th arg is the explicit success override — without it the run history
    // would keep reporting success off `exitCode === 0`.
    expect(completeAgentRunMock).toHaveBeenCalledWith('run-1', 'done', 0, 1000, expect.anything(), false);
  });

  it('leaves the run record alone when the PR is confirmed', async () => {
    onBranch('claim/issue-1');
    await finalize({ runId: 'run-1' });
    expect(completeAgentRunMock).toHaveBeenCalledWith('run-1', 'done', 0, 1000, null, null);
  });

  it('records forge-unreachable (not a generic failure) when gh cannot be reached', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({
      status: 'unavailable', number: null, url: null, detail: 'connect: bad file descriptor'
    });
    await finalize();

    const [, result] = completeAgentMock.mock.calls[0];
    expect(result.success).toBe(false);
    expect(result.completionReason).toBe(FORGE_UNREACHABLE_CATEGORY);
    expect(result.errorAnalysis.category).toBe(FORGE_UNREACHABLE_CATEGORY);
    expect(result.errorAnalysis.actionable).toBe(false);
    expect(resolveFailedTaskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      expect.objectContaining({ category: FORGE_UNREACHABLE_CATEGORY }),
      'agent-1'
    );
  });

  it('leaves a user-terminated run alone — it is already recorded as terminated', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize({ success: false, terminatedByUser: true });
    expect(findPullRequestForBranchMock).not.toHaveBeenCalled();
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'blocked' }), 'internal');
  });

  it('hands the corrected verdict back so worktree cleanup runs on the same answer', async () => {
    // Cleaning up as a success removes the worktree and deletes the local
    // branch — the exact state a retry needs to open the PR that is missing.
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await expect(finalize()).resolves.toMatchObject({ success: false });

    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'u' });
    await expect(finalize()).resolves.toMatchObject({ success: true });
  });

  it('falls back to the reported outcome when the verification itself throws', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockRejectedValue(new Error('boom'));
    await finalize();
    // A check that never ran is not a verdict — it must not manufacture a failure.
    expect(completeAgentMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ success: true }));
  });
});
