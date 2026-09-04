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

// The goal-fidelity gate (#5994) reaches a local model at completion. Pinned OFF
// here so these tests exercise the path they are about without depending on the
// developer's own reviewer settings — and so a machine that HAS a local reviewer
// configured never has its suite dispatch a real review request.
vi.mock('./codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: vi.fn(async () => null),
}));

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

const findMergeRequestForBranchMock = vi.fn();
vi.mock('./gitlab.js', () => ({
  findMergeRequestForBranch: (...args) => findMergeRequestForBranchMock(...args),
}));

const resolveForgeForRepoMock = vi.fn(async () => ({ cli: 'gh' }));
const getDefaultBranchMock = vi.fn(async () => 'main');
vi.mock('./git.js', () => ({
  resolveForgeForRepo: (...args) => resolveForgeForRepoMock(...args),
  getDefaultBranch: (...args) => getDefaultBranchMock(...args),
}));

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));

const completeAgentMock = vi.fn();
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => null),
  getAgentRecord: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  completeAgent: (...args) => completeAgentMock(...args),
}));

const updateTaskMock = vi.fn(async () => ({}));
vi.mock('./cos.js', () => ({ updateTask: (...args) => updateTaskMock(...args) }));
vi.mock('./providers.js', () => ({ getActiveProvider: vi.fn(async () => null) }));
vi.mock('./providerStatus.js', () => ({
  markProviderUsageLimit: vi.fn(async () => null),
  markProviderRateLimited: vi.fn(async () => null),
  markProviderUnavailable: vi.fn(async () => null),
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
vi.mock('../lib/gitCommitProbe.js', () => ({
  committedDuringRun: vi.fn(async () => true),
}));
vi.mock('./agentRunTracking.js', () => ({
  createAgentRun: vi.fn(),
  completeAgentRun: (...args) => completeAgentRunMock(...args),
}));

vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => false),
  resolveTaskHookType: vi.fn(() => null),
  declaresNoCommitCriterion: vi.fn(() => false),
  getTaskOutputHook: vi.fn(async () => null),
  getTaskOutputPayloadPredicate: vi.fn(async () => null),
}));

vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl) — mocked
// so finalization telemetry lands in a spy rather than the developing install's
// ledger, and so the boundary assertions below can read the envelope (#4540).
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractSimplifySummaries: vi.fn(() => null) }));

import {
  verifyPrClaim,
  finalizeAgent,
  PR_MISSING_CATEGORY,
  FORGE_UNREACHABLE_CATEGORY,
  ISSUE_TRAILER_MISSING_CATEGORY,
} from './agentFinalization.js';

/**
 * Routes the git calls verifyPrClaim makes by their argv, so a test can set the
 * branch and the commit count independently. A blanket `mockResolvedValue`
 * cannot: `rev-list --count` and `rev-parse --abbrev-ref HEAD` want different
 * answers, and feeding a branch name to the counter reads as "unknown".
 */
const git = { branch: 'claim/issue-1', ahead: 3, hasOriginRef: true };
const ok = (stdout) => ({ stdout, stderr: '', exitCode: 0 });
const routeGit = (args) => {
  if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok(`${git.branch}\n`);
  if (args[0] === 'rev-parse' && args.includes('--verify')) return ok(git.hasOriginRef ? 'abc1234\n' : '');
  if (args[0] === 'rev-list' && args.includes('--count')) return ok(git.ahead === null ? '\n' : `${git.ahead}\n`);
  return ok('');
};
const onBranch = (name) => {
  git.branch = name;
  execGitMock.mockImplementation(async (args) => routeGit(args));
};

const prTask = () => ({
  id: 'task-1',
  taskType: 'internal',
  description: 'ship something',
  metadata: { openPR: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(git, { branch: 'claim/issue-1', ahead: 3, hasOriginRef: true });
  execGitMock.mockImplementation(async (args) => routeGit(args));
  getDefaultBranchMock.mockResolvedValue('main');
  findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7', body: 'Closes #1' });
  findMergeRequestForBranchMock.mockResolvedValue({ status: 'found', number: 12, url: 'https://example.com/mr/12', body: 'Closes #1' });
  resolveForgeForRepoMock.mockResolvedValue({ cli: 'gh' });
});

describe('verifyPrClaim (#3358)', () => {
  it('passes when the forge confirms a PR for the branch', async () => {
    onBranch('claim/issue-1');
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(true);
    expect(findPullRequestForBranchMock).toHaveBeenCalledWith('claim/issue-1', { cwd: '/w', env: null });
  });

  it('fails claim branches with a dedicated category when the PR body lacks a closing trailer', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7', body: 'Summary only' });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict).toMatchObject({ ok: false, category: ISSUE_TRAILER_MISSING_CATEGORY, branch: 'claim/issue-1' });
    expect(verdict.message).toMatch(/issue #1/i);
  });

  it.each(['Closes #1', 'Fixes #1', 'Resolves #1'])('accepts a closing trailer: %s', async (body) => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7', body });
    await expect(verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true }))
      .resolves.toMatchObject({ ok: true, branch: 'claim/issue-1' });
  });

  it.each(['Refs #1', 'Part of #1'])('permits a partial-ship trailer with an advisory: %s', async (body) => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7', body });
    await expect(verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true }))
      .resolves.toMatchObject({ ok: true, branch: 'claim/issue-1', advisory: expect.stringMatching(/partially ships/i) });
  });

  it('skips trailer verification for a non-claim branch', async () => {
    onBranch('feature/pr-body-verification');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7', body: null });
    await expect(verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true }))
      .resolves.toMatchObject({ ok: true, branch: 'feature/pr-body-verification' });
  });

  it('is inconclusive rather than reporting a trailer miss when the PR body is unreadable', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7', body: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict).toMatchObject({ ok: false, category: FORGE_UNREACHABLE_CATEGORY, inconclusive: true });
    expect(verdict.category).not.toBe(ISSUE_TRAILER_MISSING_CATEGORY);
  });

  it('threads the repo-pinned gh credential into the lookup', async () => {
    // The agent opened its PR as the repo-owner-matched account; querying as the
    // ambient one may not even see it on a multi-login host.
    onBranch('claim/issue-1');
    const env = { GH_TOKEN: 'pinned-token' };
    resolveForgeForRepoMock.mockResolvedValue({ cli: 'gh', env });
    await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(findPullRequestForBranchMock).toHaveBeenCalledWith('claim/issue-1', { cwd: '/w', env });
  });

  it('fails with pr-missing when the forge answered and has no PR', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.category).toBe(PR_MISSING_CATEGORY);
    expect(verdict.branch).toBe('claim/issue-1');
  });

  it('passes when the branch holds no commits — there was nothing to open a PR for', async () => {
    // agent-446c4f47: the agent investigated, found the reported defect already
    // fixed on main, and stopped without touching a file. `gh pr create` on a
    // zero-commit branch fails because there is no diff, not because the agent
    // slipped — recording that as pr-missing failed a correct run.
    onBranch('cos/sys-1/agent-1');
    git.ahead = 0;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.noChangesToShip).toBe(true);
    expect(verdict.category).toBeUndefined();
  });

  it('counts against origin/<default>, not the worktree\'s stale local copy', async () => {
    // A worktree's local `main` is whatever the primary last pulled and routinely
    // sits behind the commit the worktree branched from. Counting against it
    // reports inherited merge commits as the agent's own — backwards for a check
    // that exists to recognize "this agent wrote nothing".
    onBranch('cos/sys-1/agent-1');
    git.ahead = 0;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(execGitMock).toHaveBeenCalledWith(['rev-list', '--count', 'origin/main..HEAD'], '/w', expect.anything());
  });

  it('falls back to the local default branch when origin/<default> is absent', async () => {
    onBranch('cos/sys-1/agent-1');
    git.ahead = 0;
    git.hasOriginRef = false;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(execGitMock).toHaveBeenCalledWith(['rev-list', '--count', 'main..HEAD'], '/w', expect.anything());
  });

  it('keeps pr-missing when the commit count is unreadable — that is not evidence of an empty branch', async () => {
    onBranch('claim/issue-1');
    git.ahead = null;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.category).toBe(PR_MISSING_CATEGORY);
  });

  it('keeps pr-missing when the default branch cannot be resolved', async () => {
    onBranch('claim/issue-1');
    git.ahead = 0;
    getDefaultBranchMock.mockResolvedValue(null);
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.category).toBe(PR_MISSING_CATEGORY);
  });

  it('never blocks finalize on a network round-trip to name the default branch', async () => {
    onBranch('claim/issue-1');
    git.ahead = 0;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(getDefaultBranchMock).toHaveBeenCalledWith('/w', { allowRemote: false });
  });

  it('still reports pr-missing when the branch DOES hold commits', async () => {
    // The #3358 case must survive the no-op exemption: real work, pushed, no PR.
    onBranch('claim/issue-1');
    git.ahead = 4;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.category).toBe(PR_MISSING_CATEGORY);
    expect(verdict.commitsAhead).toBe(4);
  });

  it('does not count commits when a PR was found — the check is only for the miss path', async () => {
    onBranch('claim/issue-1');
    await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(getDefaultBranchMock).not.toHaveBeenCalled();
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

  it('asks glab on a GitLab repo — asking gh there would fail every correct MR run', async () => {
    onBranch('claim/issue-1');
    resolveForgeForRepoMock.mockResolvedValue({ cli: 'glab' });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.ok).toBe(true);
    expect(findMergeRequestForBranchMock).toHaveBeenCalledWith('claim/issue-1', '/w');
    expect(findPullRequestForBranchMock).not.toHaveBeenCalled();
  });

  it('names the GitLab noun when an MR is missing', async () => {
    onBranch('claim/issue-1');
    resolveForgeForRepoMock.mockResolvedValue({ cli: 'glab' });
    findMergeRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const verdict = await verifyPrClaim({ task: prTask(), workspacePath: '/w', success: true, prExpected: true });
    expect(verdict.category).toBe(PR_MISSING_CATEGORY);
    expect(verdict.message).toMatch(/merge request/);
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
    expect(verdict.inconclusive).toBe(true);
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

  it('records "completed" for a run that committed nothing and opened no PR', async () => {
    // The retry loop this closes: pr-missing is non-actionable, so a correct
    // "nothing to fix here" conclusion was re-run to the retry budget, burning
    // three Opus agents to reach the same answer three times (agent-446c4f47).
    onBranch('cos/sys-1/agent-1');
    git.ahead = 0;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize();

    expect(completeAgentMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ success: true }));
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
    expect(resolveFailedTaskUpdateMock).not.toHaveBeenCalled();
  });

  it('proves a marked no-op audit even when cleanup owns PR creation', async () => {
    onBranch('cos/sys-1/agent-1');
    git.ahead = 0;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const finalized = await finalize({
      prExpected: false,
      task: {
        ...prTask(),
        metadata: { ...prTask().metadata, autonomousJob: true, noChangeSuccess: true }
      }
    });

    expect(findPullRequestForBranchMock).toHaveBeenCalledWith('cos/sys-1/agent-1', { cwd: '/w', env: null });
    const [, result] = completeAgentMock.mock.calls[0];
    expect(result).toMatchObject({ success: true, validationPassed: true });
    expect(finalized.prVerdict).toMatchObject({ ok: true, branch: 'cos/sys-1/agent-1', noChangesToShip: true });
  });

  it('leaves validation undeclared when a marked no-op audit cannot reach the forge', async () => {
    onBranch('cos/sys-1/agent-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'unavailable', number: null, url: null, detail: 'connection refused' });
    await finalize({
      prExpected: false,
      task: {
        ...prTask(),
        metadata: { ...prTask().metadata, autonomousJob: true, noChangeSuccess: true }
      }
    });

    const [, result] = completeAgentMock.mock.calls[0];
    expect(result).toMatchObject({ success: true, validationPassed: null });
  });

  it('leaves validation undeclared when a marked no-op audit cannot prove its empty branch', async () => {
    onBranch('cos/sys-1/agent-1');
    git.ahead = null;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize({
      prExpected: false,
      task: {
        ...prTask(),
        metadata: { ...prTask().metadata, autonomousJob: true, noChangeSuccess: true }
      }
    });

    const [, result] = completeAgentMock.mock.calls[0];
    expect(result).toMatchObject({ success: true, validationPassed: null });
  });

  it('records validation success when the marked catalog audit has no change to ship', async () => {
    onBranch('cos/sys-1/agent-1');
    git.ahead = 0;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize({
      task: {
        ...prTask(),
        metadata: { ...prTask().metadata, autonomousJob: true, noChangeSuccess: true }
      }
    });

    const [, result] = completeAgentMock.mock.calls[0];
    expect(result).toMatchObject({ success: true, validationPassed: true });
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

    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'u', body: 'Closes #1' });
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

// ─── Lifecycle ledger — the PR-verification boundary (#4540) ─────────────────

describe('finalizeAgent — records the PR verdict in the lifecycle ledger', () => {
  const prVerified = () => appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.pr-verified');

  const finalize = (overrides = {}) => finalizeAgent({
    agentId: 'agent-1',
    task: prTask(),
    runId: 'run-1',
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

  it('records the passing verdict with the branch it was checked against', async () => {
    onBranch('claim/issue-1');
    await finalize();
    expect(prVerified()).toEqual([expect.objectContaining({
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      data: expect.objectContaining({ verified: true, branch: 'claim/issue-1' })
    })]);
  });

  it('records a FAILED verdict with the category, not just an absence', async () => {
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize();
    expect(prVerified()[0].data).toMatchObject({ verified: false, category: PR_MISSING_CATEGORY });
  });

  it('is keyed on the run, so a retried finalize files one verdict', async () => {
    onBranch('claim/issue-1');
    await finalize();
    await finalize();
    const ids = prVerified().map((e) => e.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it('writes NOTHING when the run never promised a PR', async () => {
    // `verifyPrClaim` returns the same `{ ok: true }` for "verified" and for
    // "not applicable". Recording both would put two different facts on the
    // ledger under one word.
    onBranch('claim/issue-1');
    await finalize({ prExpected: false });
    expect(prVerified()).toHaveLength(0);
  });

  it('records the auxiliary no-change proof and returns it to cleanup', async () => {
    onBranch('cos/sys-1/agent-1');
    git.ahead = 0;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const finalized = await finalize({
      prExpected: false,
      task: {
        ...prTask(),
        metadata: { ...prTask().metadata, autonomousJob: true, noChangeSuccess: true }
      }
    });

    expect(prVerified()).toEqual([expect.objectContaining({
      data: expect.objectContaining({
        verified: true,
        branch: 'cos/sys-1/agent-1',
        noChangesToShip: true,
      })
    })]);
    expect(finalized.prVerdict).toMatchObject({ branch: 'cos/sys-1/agent-1', noChangesToShip: true });
  });

  it('does not record a premature miss while cleanup can still create a PR', async () => {
    onBranch('cos/sys-1/agent-1');
    git.ahead = 3;
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    const finalized = await finalize({
      prExpected: false,
      task: {
        ...prTask(),
        metadata: { ...prTask().metadata, autonomousJob: true, noChangeSuccess: true }
      }
    });

    expect(prVerified()).toHaveLength(0);
    // The auxiliary proof is deliberately not returned for a non-empty branch:
    // cleanup still owns the backstop PR creation and must be free to ask again.
    expect(finalized.prVerdict).toEqual({ ok: true });
  });

  it('writes NOTHING when the check itself threw', async () => {
    // A throw is not a verdict — the finalize path already falls back to the
    // reported outcome, and the ledger must not claim a forge confirmed anything.
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockRejectedValue(new Error('forge exploded'));
    await finalize();
    expect(prVerified()).toHaveLength(0);
  });

  it('writes NOTHING when there was no branch to ask a forge about', async () => {
    // A detached HEAD or non-repo workspace returns the SAME `{ ok: true }` as a
    // confirmed PR. Recording it would put "verified" on a run nothing verified —
    // which is the failure mode this whole ledger exists to make impossible.
    execGitMock.mockRejectedValue(new Error('not a git repository'));
    await finalize();
    expect(prVerified()).toHaveLength(0);
  });
});

describe('finalizeAgent — the PR verdict is only recorded when one was reached', () => {
  const prVerified = () => appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.pr-verified');

  const finalize = (overrides = {}) => finalizeAgent({
    agentId: 'agent-1',
    task: prTask(),
    runId: 'run-1',
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

  it('writes NOTHING when the forge was unreachable', async () => {
    // The forge being down is not evidence about the PR. Recording it as
    // `verified: false` would put "this run shipped no PR" on the record for a
    // run that may well have shipped one.
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'error', number: null, url: null, detail: 'gh: connection refused' });
    await finalize();

    expect(completeAgentMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ completionReason: FORGE_UNREACHABLE_CATEGORY }));
    expect(prVerified()).toHaveLength(0);
  });

  it('records a later verdict that CHANGED, rather than suppressing it as a duplicate', async () => {
    // A retry that finally opens the PR is exactly the transition worth reading
    // the ledger for; a run-scoped key alone would swallow it.
    onBranch('claim/issue-1');
    findPullRequestForBranchMock.mockResolvedValue({ status: 'none', number: null, url: null, detail: null });
    await finalize();
    findPullRequestForBranchMock.mockResolvedValue({ status: 'found', number: 7, url: 'https://example.com/pr/7', body: 'Closes #1' });
    await finalize();

    expect(prVerified().map((e) => e.data.verified)).toEqual([false, true]);
    expect(new Set(prVerified().map((e) => e.eventId)).size).toBe(2);
  });
});
