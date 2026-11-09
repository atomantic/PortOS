/**
 * #15552: a pr-watcher run whose dispatched PR merged between the poll and the
 * spawn correctly reports no-action-needed. Finalize must accept that only after
 * the forge confirms every stamped target is non-open, and must keep scoring a
 * no-op against a still-open PR as incomplete (operators customize pr-watcher
 * into commit-pushing flows, so it is not a general no-commit type).
 */

// The goal-fidelity gate reaches a local model at completion; pinned off here.
vi.mock('./codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: vi.fn(async () => null),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: 'main\n', stderr: '', exitCode: 0 })),
}));

const getPullRequestStateMock = vi.fn();
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'none', number: null, url: null })),
  getPullRequestState: (...args) => getPullRequestStateMock(...args),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('./gitlab.js', () => ({ findMergeRequestForBranch: vi.fn() }));
vi.mock('./git.js', () => ({
  resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh' })),
  getDefaultBranch: vi.fn(async () => 'main'),
}));

const getOriginInfoMock = vi.fn();
vi.mock('../lib/gitRemote.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getOriginInfo: (...args) => getOriginInfoMock(...args),
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
vi.mock('./cosTaskStore.js', () => ({ updateTask: (...args) => updateTaskMock(...args) }));
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
  resolveUndeliveredTaskUpdate: vi.fn(async (_task, outcome) => ({ status: 'pending', metadata: { taskOutcome: outcome } })),
  resolveTypeFailureSignal: vi.fn(() => ({ record: 'skip' })),
}));

// The empty branch: nothing was committed during the run.
vi.mock('../lib/gitCommitProbe.js', () => ({ committedDuringRun: vi.fn(async () => false) }));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: vi.fn(), completeAgentRun: vi.fn(async () => null) }));
vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => false),
  resolveTaskHookType: vi.fn(() => 'pr-watcher'),
  declaresNoCommitCriterion: vi.fn(() => false),
  getTaskOutputHook: vi.fn(async () => null),
  getTaskOutputPayloadPredicate: vi.fn(async () => null),
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractSimplifySummaries: vi.fn(() => null), extractFinalSummary: vi.fn(() => null) }));

import { finalizeAgent } from './agentFinalization.js';

const REPO = 'example-owner/example-repo';
const watcherTask = (prNumbers = [7]) => ({
  id: 'sys-app-pr-watcher-1',
  taskType: 'internal',
  description: 'review new PRs',
  metadata: { analysisType: 'pr-watcher', prWatcherTargets: { repoFullName: REPO, prNumbers } },
});
const noOpSentinel = JSON.stringify({ summary: 'PR already merged.', taskOutcome: {
  status: 'no-action-needed', reason: 'The listed PR is already MERGED with CI green.',
} });

const finalize = (overrides = {}) => finalizeAgent({
  agentId: 'agent-1',
  task: watcherTask(),
  runId: null,
  providerId: 'claude-code',
  success: true,
  exitCode: 0,
  duration: 10_000,
  startedAt: Date.now() - 10_000,
  outputBuffer: 'done',
  finalSummary: noOpSentinel,
  errorAnalysis: null,
  workspacePath: '/example/worktree',
  prExpected: false,
  ...overrides,
});
const completion = () => completeAgentMock.mock.calls[0][1];

beforeEach(() => {
  vi.clearAllMocks();
  getOriginInfoMock.mockResolvedValue({ host: 'github.com', fullName: REPO });
  getPullRequestStateMock.mockResolvedValue({ status: 'known', state: 'MERGED', detail: null });
});

describe('finalizeAgent — pr-watcher no-op against an already-settled selection (#15552)', () => {
  it('accepts no-action-needed when every stamped target PR is merged or closed', async () => {
    getPullRequestStateMock
      .mockResolvedValueOnce({ status: 'known', state: 'MERGED', detail: null })
      .mockResolvedValueOnce({ status: 'known', state: 'CLOSED', detail: null });
    await finalize({ task: watcherTask([7, 8]) });
    expect(completion()).toMatchObject({ success: true, validationPassed: true,
      taskOutcome: { status: 'no-action-needed' } });
    expect(getPullRequestStateMock.mock.calls.map(([ref]) => ref)).toEqual(['7', '8']);
    expect(resolveFailedTaskUpdateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a target PR is still open', () => getPullRequestStateMock.mockResolvedValue({ status: 'known', state: 'OPEN', detail: null }), {}],
    ['the forge cannot answer', () => getPullRequestStateMock.mockResolvedValue({ status: 'unavailable', state: null, detail: 'offline' }), {}],
    ['the workspace is another repository', () => getOriginInfoMock.mockResolvedValue({ host: 'github.com', fullName: 'someone/else' }), {}],
    ['no targets were stamped at dispatch', () => {}, { task: { ...watcherTask(), metadata: { analysisType: 'pr-watcher' } } }],
  ])('keeps the no-op incomplete when %s', async (_name, arrange, overrides) => {
    arrange();
    await finalize(overrides);
    expect(completion()).toMatchObject({ success: false, taskOutcome: { status: 'incomplete' } });
    expect(completion().validationPassed).not.toBe(true);
  });
});
