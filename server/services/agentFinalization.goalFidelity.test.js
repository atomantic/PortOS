/**
 * Tests for the goal-fidelity completion gate (#5994).
 *
 * Every other check on the finalize path proves the run PRODUCED something —
 * commits exist, a change request was opened, the diff is decent code. None of
 * them can prove it is the change that was ASKED for, because no reviewer ever
 * sees the request. This gate re-reads the accumulated run-window diff against
 * the task's own objective and holds a run whose verdict is `rethink`.
 *
 * The failure mode being pinned: a clean, reviewed, green run that quietly
 * shipped something else — and, on the other side, a gate so eager it holds a
 * run because a local model was down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'found', number: 7, url: 'https://example.com/pr/7' })),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('./gitlab.js', () => ({ findMergeRequestForBranch: vi.fn() }));
vi.mock('./git.js', () => ({ resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh' })) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../lib/primaryCheckoutGuard.js', async (importOriginal) => ({
  ...(await importOriginal()),
  detectPrimaryCheckoutDrift: vi.fn(async () => ({ drifted: false })),
}));

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
vi.mock('./agentErrorAnalysis.js', () => ({
  resolveFailedTaskUpdate: vi.fn(async (_task, analysis) => ({
    status: 'pending',
    metadata: { lastErrorCategory: analysis?.category || null },
  })),
  resolveTypeFailureSignal: vi.fn(() => ({ record: 'skip' })),
}));

const runWindowDiffMock = vi.fn(async () => ({ diff: 'diff --git a/a.js b/a.js', base: 'abc', truncated: false, reason: null }));
vi.mock('../lib/gitCommitProbe.js', () => ({
  committedDuringRun: vi.fn(async () => true),
  runWindowDiff: (...args) => runWindowDiffMock(...args),
}));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: vi.fn(), completeAgentRun: vi.fn(async () => null) }));
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

const getGoalFidelityConfigMock = vi.fn(async () => ({ enabled: true, backend: 'ollama', model: 'example-model', effort: null }));
const runLocalGoalFidelityReviewMock = vi.fn();
vi.mock('./codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: (...args) => getGoalFidelityConfigMock(...args),
  runLocalGoalFidelityReview: (...args) => runLocalGoalFidelityReviewMock(...args),
}));

import { finalizeAgent } from './agentFinalization.js';
import { cosEvents } from './cosEvents.js';
import { GOAL_FIDELITY_CATEGORY, GOAL_FIDELITY_HOLD_EVENT } from '../lib/goalFidelity.js';

const verdict = (overrides = {}) => ({
  ok: true,
  backend: 'ollama',
  model: 'example-model',
  effort: null,
  verdict: 'ship',
  missing: [],
  unrequested: [],
  evidence: 'the suite was run',
  ...overrides,
});

const finalize = (overrides = {}) => finalizeAgent({
  agentId: 'agent-1',
  task: { id: 'task-1', taskType: 'internal', description: 'Add a retry to the uploader', metadata: {} },
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

const completion = () => completeAgentMock.mock.calls[0][1];

beforeEach(() => {
  vi.clearAllMocks();
  getGoalFidelityConfigMock.mockResolvedValue({ enabled: true, backend: 'ollama', model: 'example-model', effort: null });
  runWindowDiffMock.mockResolvedValue({ diff: 'diff --git a/a.js b/a.js', base: 'abc', truncated: false, reason: null });
  runLocalGoalFidelityReviewMock.mockResolvedValue(verdict());
});

describe('finalizeAgent — goal-fidelity gate', () => {
  it('judges the run-window diff against the TASK objective, not the agent transcript', async () => {
    await finalize();
    const [args] = runLocalGoalFidelityReviewMock.mock.calls[0];
    expect(args.objective).toContain('Add a retry to the uploader');
    expect(args.objective).not.toContain('done');
    expect(args.diff).toBe('diff --git a/a.js b/a.js');
    expect(args.backend).toBe('ollama');
  });

  it('records a passing verdict without disturbing the run — absence is what means "never judged"', async () => {
    await finalize();
    const result = completion();
    expect(result.success).toBe(true);
    expect(result.goalFidelity).toMatchObject({ verdict: 'ship', model: 'example-model' });
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
  });

  it('records fix-first as advisory: named gaps, but the run still ships', async () => {
    runLocalGoalFidelityReviewMock.mockResolvedValue(verdict({ verdict: 'fix-first', missing: ['the retry backoff'] }));
    await finalize();
    const result = completion();
    expect(result.success).toBe(true);
    expect(result.goalFidelity.missing).toEqual(['the retry backoff']);
  });

  it('holds a rethink verdict as needs-attention and raises it for the human', async () => {
    runLocalGoalFidelityReviewMock.mockResolvedValue(verdict({
      verdict: 'rethink',
      missing: ['the retry'],
      unrequested: ['an unrelated logging refactor'],
    }));
    await finalize();

    const result = completion();
    expect(result.success).toBe(false);
    expect(result.completionReason).toBe(GOAL_FIDELITY_CATEGORY);
    expect(result.errorAnalysis.category).toBe(GOAL_FIDELITY_CATEGORY);
    expect(result.error).toContain('stated objective');
    expect(result.errorAnalysis.suggestedFix).toContain('the retry');
    expect(updateTaskMock).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'internal');
    expect(cosEvents.emit).toHaveBeenCalledWith(GOAL_FIDELITY_HOLD_EVENT, expect.objectContaining({
      agentId: 'agent-1',
      taskId: 'task-1',
      review: expect.objectContaining({ verdict: 'rethink' }),
    }));
  });

  it('fails OPEN: a gate that is off, a diff git could not read, or a reviewer that errored leaves the run alone', async () => {
    for (const arrange of [
      () => getGoalFidelityConfigMock.mockResolvedValue(null),
      () => runWindowDiffMock.mockResolvedValue({ diff: null, base: null, truncated: false, reason: 'could not read the run window diff' }),
      () => runWindowDiffMock.mockResolvedValue({ diff: '', base: 'abc', truncated: false, reason: null }),
      () => runLocalGoalFidelityReviewMock.mockResolvedValue({ ok: false, error: 'ollama is not reachable' }),
      () => runLocalGoalFidelityReviewMock.mockRejectedValue(new Error('socket hang up')),
    ]) {
      vi.clearAllMocks();
      getGoalFidelityConfigMock.mockResolvedValue({ enabled: true, backend: 'ollama', model: 'example-model', effort: null });
      runWindowDiffMock.mockResolvedValue({ diff: 'diff --git a/a.js b/a.js', base: 'abc', truncated: false, reason: null });
      runLocalGoalFidelityReviewMock.mockResolvedValue(verdict());
      arrange();

      await finalize();
      const result = completion();
      expect(result.success).toBe(true);
      expect(result.goalFidelity).toBeUndefined();
      expect(cosEvents.emit).not.toHaveBeenCalledWith(GOAL_FIDELITY_HOLD_EVENT, expect.anything());
    }
  });

  it('never re-judges a run that already failed — the original diagnosis is the better one', async () => {
    await finalize({ success: false, errorAnalysis: { category: 'timeout', message: 'agent timed out' } });
    expect(runLocalGoalFidelityReviewMock).not.toHaveBeenCalled();
    expect(completion().errorAnalysis.category).toBe('timeout');
  });
});
