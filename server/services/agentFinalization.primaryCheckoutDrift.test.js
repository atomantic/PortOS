/**
 * Tests for the branch-jack downgrade finalizeAgent applies (#3680).
 *
 * The bug: a CoS agent given its own git worktree ran `/do:pr` and applied its
 * commits onto the PRIMARY checkout's local `main`, where they sat unpushed and
 * unreviewed on an unprotected branch — while PortOS recorded the run as
 * "completed". Detection lives in the SHARED finalize path so all three spawn
 * modes (TUI, direct CLI, runner) are covered by one check.
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

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: 'claim/issue-3680\n', stderr: '', exitCode: 0 })),
}));

vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'found', number: 7, url: 'https://example.com/pr/7' })),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('./gitlab.js', () => ({ findMergeRequestForBranch: vi.fn() }));
vi.mock('./git.js', () => ({ resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh' })) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));

const detectPrimaryCheckoutDriftMock = vi.fn(async () => ({ drifted: false }));
vi.mock('../lib/primaryCheckoutGuard.js', async (importOriginal) => ({
  ...(await importOriginal()),
  detectPrimaryCheckoutDrift: (...args) => detectPrimaryCheckoutDriftMock(...args),
}));

const getAgentRecordMock = vi.fn(async () => null);
const completeAgentMock = vi.fn();
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => null),
  getAgentRecord: (...args) => getAgentRecordMock(...args),
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
vi.mock('../lib/gitCommitProbe.js', () => ({ committedDuringRun: vi.fn(async () => true) }));
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
vi.mock('./agentSummaryExtraction.js', () => ({ extractSimplifySummaries: vi.fn(() => null) }));

import { checkPrimaryCheckoutDrift, finalizeAgent } from './agentFinalization.js';
import { emitLog } from './cosEvents.js';
import { PRIMARY_CHECKOUT_MUTATED_CATEGORY, PRIMARY_CHECKOUT_MUTATED_REASON } from '../lib/primaryCheckoutGuard.js';

const BASELINE = { path: '/example/repo', branch: 'main', head: 'a'.repeat(40) };

const DRIFT = {
  drifted: true,
  reason: PRIMARY_CHECKOUT_MUTATED_REASON,
  category: PRIMARY_CHECKOUT_MUTATED_CATEGORY,
  baseline: BASELINE,
  current: { path: '/example/repo', branch: 'main', head: 'b'.repeat(40) },
  commitCount: 3,
  message: 'Worktree agent mutated the primary checkout /example/repo: branch main, HEAD aaaaaaaaa → bbbbbbbbb (3 new commits)',
  suggestedFix: 'git -C /example/repo reset --hard origin/main',
};

// #3703: commits were stranded on the primary, but none are patch-equivalent to
// this agent's own branch — a concurrent actor moved it. Warn-logged, not failed.
const UNATTRIBUTED_DRIFT = {
  drifted: false,
  unattributed: true,
  baseline: BASELINE,
  current: { path: '/example/repo', branch: 'main', head: 'b'.repeat(40) },
  commitCount: 1,
  unpushedCount: 1,
  message: 'Worktree agent mutated the primary checkout /example/repo: branch main, HEAD aaaaaaaaa → bbbbbbbbb (1 new commit)',
};

const task = () => ({ id: 'task-1', taskType: 'internal', description: 'ship something', metadata: {} });

const finalize = (overrides = {}) => finalizeAgent({
  agentId: 'agent-1',
  task: task(),
  runId: null,
  providerId: 'claude-code',
  success: true,
  exitCode: 0,
  duration: 1000,
  outputBuffer: 'done',
  errorAnalysis: null,
  workspacePath: '/example/worktree',
  prExpected: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  detectPrimaryCheckoutDriftMock.mockResolvedValue({ drifted: false });
  getAgentRecordMock.mockResolvedValue({
    id: 'agent-1',
    metadata: { isWorktree: true, worktreeBranch: 'claim/issue-3680', primaryCheckoutBaseline: BASELINE },
  });
});

describe('checkPrimaryCheckoutDrift', () => {
  it('checks the baseline the spawner stamped, naming the agent branch', async () => {
    await checkPrimaryCheckoutDrift('agent-1');
    expect(detectPrimaryCheckoutDriftMock).toHaveBeenCalledWith(BASELINE, { agentBranch: 'claim/issue-3680' });
  });

  it('short-circuits a non-worktree run before any git call', async () => {
    // A run that legitimately works IN the primary carries no baseline; checking
    // it would fail every ordinary coding-on-main run.
    getAgentRecordMock.mockResolvedValue({ id: 'agent-1', metadata: { isWorktree: false } });
    expect(await checkPrimaryCheckoutDrift('agent-1')).toEqual({ drifted: false });
    expect(detectPrimaryCheckoutDriftMock).not.toHaveBeenCalled();
  });

  it('reports no drift when the agent record is unreadable', async () => {
    getAgentRecordMock.mockRejectedValue(new Error('state read failed'));
    expect(await checkPrimaryCheckoutDrift('agent-1')).toEqual({ drifted: false });
  });
});

describe('finalizeAgent — a worktree run that mutated the primary is not a success', () => {
  it('records the drifted run as a FAILURE naming branch, count and recovery', async () => {
    detectPrimaryCheckoutDriftMock.mockResolvedValue(DRIFT);
    await finalize();

    const [, result] = completeAgentMock.mock.calls[0];
    expect(result.success).toBe(false);
    expect(result.completionReason).toBe(PRIMARY_CHECKOUT_MUTATED_REASON);
    expect(result.error).toBe(DRIFT.message);
    expect(result.errorAnalysis.category).toBe(PRIMARY_CHECKOUT_MUTATED_CATEGORY);
    // A human has to decide whether to discard the primary's commits, so this
    // escalates rather than blind-retrying.
    expect(result.errorAnalysis.actionable).toBe(true);
    expect(result.errorAnalysis.suggestedFix).toContain('reset --hard origin/main');
    expect(updateTaskMock).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
  });

  it('marks the RUN record failed too, even though the process exited 0', async () => {
    detectPrimaryCheckoutDriftMock.mockResolvedValue(DRIFT);
    await finalize({ runId: 'run-1' });
    expect(completeAgentRunMock).toHaveBeenCalledWith('run-1', 'done', 0, 1000, expect.anything(), false);
  });

  it('leaves an undrifted run completely unaffected', async () => {
    await finalize({ runId: 'run-1' });
    expect(completeAgentMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ success: true }));
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
    expect(completeAgentRunMock).toHaveBeenCalledWith('run-1', 'done', 0, 1000, null, null);
  });

  it('does not overwrite the diagnosis of a run that already failed', async () => {
    // The original analysis is the better answer to "why did this fail"; the
    // branch-jack is already on the record via the warn log.
    detectPrimaryCheckoutDriftMock.mockResolvedValue(DRIFT);
    const originalAnalysis = { category: 'test-failure', actionable: true, message: 'tests failed' };
    await finalize({ success: false, exitCode: 1, errorAnalysis: originalAnalysis, error: 'tests failed' });

    const [, result] = completeAgentMock.mock.calls[0];
    expect(result.success).toBe(false);
    expect(result.errorAnalysis).toBe(originalAnalysis);
    expect(result.completionReason).toBeUndefined();
  });

  it('does not turn a user-terminated run into a drift failure', async () => {
    detectPrimaryCheckoutDriftMock.mockResolvedValue(DRIFT);
    await finalize({ terminatedByUser: true });
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'blocked' }), 'internal');
  });

  it('falls back to "no drift" when the check itself throws', async () => {
    // A check that never ran is not a verdict — it must not manufacture a failure.
    detectPrimaryCheckoutDriftMock.mockRejectedValue(new Error('git wedged'));
    await finalize();
    expect(completeAgentMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ success: true }));
  });

  it('warn-logs an unattributed drift but does NOT downgrade a successful run', async () => {
    // #3703: the primary moved and stranded commits, but they are not this agent's
    // (no patch-equivalent on its branch). Surfacing without failing the run is the
    // whole point — a false failure escalates to a human and dents the success rate.
    detectPrimaryCheckoutDriftMock.mockResolvedValue(UNATTRIBUTED_DRIFT);
    await finalize({ runId: 'run-1' });

    expect(completeAgentMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({ success: true }));
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
    // The run record is a clean success — no error analysis, not force-failed.
    expect(completeAgentRunMock).toHaveBeenCalledWith('run-1', 'done', 0, 1000, null, null);
    // ...but the unreviewed commits are still surfaced.
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('not attributable to agent-1'), expect.anything());
  });
});
