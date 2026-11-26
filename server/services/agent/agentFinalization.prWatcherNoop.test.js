/**
 * A watcher can deliver solely by merging its dispatched PRs (#19338). A stale
 * selection can also yield no-action-needed when each PR was merged or closed
 * (#15552). Both outcomes require forge evidence to pass without new commits.
 */

// The goal-fidelity gate reaches a local model at completion; pinned off here.
vi.mock('../codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: vi.fn(async () => null),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: 'main\n', stderr: '', exitCode: 0 })),
}));

const getPullRequestStateMock = vi.fn();
vi.mock('../github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'none', number: null, url: null })),
  getPullRequestState: (...args) => getPullRequestStateMock(...args),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('../gitlab.js', () => ({ findMergeRequestForBranch: vi.fn() }));
vi.mock('../forgeAuth.js', () => ({
  resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh' })),
}));
vi.mock('../git/status.js', () => ({
  getDefaultBranch: vi.fn(async () => 'main'),
}));

const getOriginInfoMock = vi.fn();
vi.mock('../../lib/gitRemote.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getOriginInfo: (...args) => getOriginInfoMock(...args),
}));
vi.mock('../cos/cosEvents.js', () => ({ emitLog: vi.fn() }));

const completeAgentMock = vi.fn();
vi.mock('../cos/cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => null),
  getAgentRecord: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  completeAgent: (...args) => completeAgentMock(...args),
}));

const updateTaskMock = vi.fn(async () => ({}));
vi.mock('../cos/cosTaskStore.js', () => ({ updateTask: (...args) => updateTaskMock(...args) }));
vi.mock('../provider/providers.js', () => ({ getActiveProvider: vi.fn(async () => null) }));
vi.mock('../provider/providerStatus.js', () => ({
  markProviderUsageLimit: vi.fn(async () => null),
  markProviderUnavailable: vi.fn(async () => null),
}));

const resolveUndeliveredTaskUpdateMock = vi.fn(async (_task, outcome) => ({ status: 'pending', metadata: { taskOutcome: outcome } }));
const resolveFailedTaskUpdateMock = vi.fn(async (_task, analysis) => ({
  status: 'pending',
  metadata: { lastErrorCategory: analysis?.category || null },
}));
vi.mock('./agentErrorAnalysis.js', () => ({
  resolveFailedTaskUpdate: (...args) => resolveFailedTaskUpdateMock(...args),
  resolveUndeliveredTaskUpdate: (...args) => resolveUndeliveredTaskUpdateMock(...args),
  resolveTypeFailureSignal: vi.fn(() => ({ record: 'skip' })),
}));

// The empty branch: nothing was committed during the run.
vi.mock('../../lib/gitCommitProbe.js', () => ({ committedDuringRun: vi.fn(async () => false) }));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: vi.fn(), completeAgentRun: vi.fn(async () => null) }));
vi.mock('../taskTypeHooks.js', () => ({
  isProgrammaticIoTaskType: vi.fn(() => false),
  resolveTaskHookType: vi.fn(task => task.metadata?.analysisType),
  declaresNoCommitCriterion: vi.fn(() => false),
  isClaimFlowDispatch: vi.fn(() => false),
  getTaskOutputHook: vi.fn(async () => null),
  getTaskOutputPayloadPredicate: vi.fn(async () => null),
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractFinalSummary: vi.fn(() => null) }));

import { committedDuringRun } from '../../lib/gitCommitProbe.js';
import { finalizeAgent } from './agentFinalization.js';

const REPO = 'example-owner/example-repo';
const watcherTask = (prNumbers = [7]) => ({
  id: 'sys-app-pr-watcher-1',
  taskType: 'internal',
  description: 'review new PRs',
  metadata: { analysisType: 'pr-watcher', prWatcherTargets: { repoFullName: REPO, repoHost: 'github.com', prNumbers } },
});
const noOpSentinel = JSON.stringify({ summary: 'PR already merged.', taskOutcome: {
  status: 'no-action-needed', reason: 'The listed PR is already MERGED with CI green.',
} });

const completedSentinel = JSON.stringify({ summary: 'Merged the selected PRs.', taskOutcome: {
  status: 'completed', reason: 'The selected PRs were merged.',
  prWatcherTargets: { repoFullName: 'someone/else', repoHost: 'github.com', prNumbers: [9] },
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
    ['the same repository name is on another forge', () => getOriginInfoMock.mockResolvedValue({ host: 'github.example.com', fullName: REPO }), {}],
    ['the dispatched repository host was not captured', () => {}, { task: { ...watcherTask(), metadata: { analysisType: 'pr-watcher', prWatcherTargets: { repoFullName: REPO, prNumbers: [7] } } } }],
    ['no targets were stamped at dispatch', () => {}, { task: { ...watcherTask(), metadata: { analysisType: 'pr-watcher' } } }],
  ])('keeps the no-op incomplete when %s', async (_name, arrange, overrides) => {
    arrange();
    await finalize(overrides);
    expect(completion()).toMatchObject({ success: false, taskOutcome: { status: 'incomplete' } });
    expect(completion().validationPassed).not.toBe(true);
  });
});

describe('finalizeAgent — completed PR watcher delivery (#19338)', () => {
  it('settles all dispatched merges without probing commits or scheduling a retry', async () => {
    await finalize({ task: watcherTask([7, 8]), finalSummary: completedSentinel });
    expect(completion()).toMatchObject({ success: true, validationPassed: true,
      taskOutcome: { status: 'completed' } });
    const repo = { cwd: '/example/worktree', env: null, repoSpec: `github.com/${REPO}` };
    expect(getPullRequestStateMock.mock.calls).toEqual([['7', repo], ['8', repo]]);
    expect(committedDuringRun).not.toHaveBeenCalled();
    expect(updateTaskMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }), 'internal');
    expect(resolveUndeliveredTaskUpdateMock).not.toHaveBeenCalled();
    expect(resolveFailedTaskUpdateMock).not.toHaveBeenCalled();
  });

  it.each(['OPEN', 'CLOSED', null])('falls back to the commit criterion when one target has state %s', async (state) => {
    getPullRequestStateMock
      .mockResolvedValueOnce({ status: 'known', state: 'MERGED', detail: null })
      .mockResolvedValueOnce({ status: state ? 'known' : 'unavailable', state });
    await finalize({ task: watcherTask([7, 8]), finalSummary: completedSentinel });
    expect(getPullRequestStateMock.mock.calls.map(([ref]) => ref)).toEqual(['7', '8']);
    expect(committedDuringRun).toHaveBeenCalledOnce();
    expect(completion()).toMatchObject({ success: false, validationPassed: false, taskOutcome: { status: 'incomplete' } });
    expect(resolveUndeliveredTaskUpdateMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['origin points to another repository', { host: 'github.com', fullName: 'someone/else' }, watcherTask()],
    ['origin points to a different forge', { host: 'github.example.com', fullName: REPO }, watcherTask()],
    ['dispatch lacks stamped targets', { host: 'github.com', fullName: REPO }, { ...watcherTask(), metadata: { analysisType: 'pr-watcher' } }],
    ['task is not a PR watcher', { host: 'github.com', fullName: REPO }, { ...watcherTask(), metadata: { ...watcherTask().metadata, analysisType: 'code-quality' } }],
  ])('falls back to the commit criterion when %s', async (_reason, origin, task) => {
    getOriginInfoMock.mockResolvedValue(origin);
    await finalize({ task, finalSummary: completedSentinel });
    expect(getPullRequestStateMock).not.toHaveBeenCalled();
    expect(committedDuringRun).toHaveBeenCalledOnce();
    expect(completion()).toMatchObject({ success: false, validationPassed: false, taskOutcome: { status: 'incomplete' } });
  });

  it('accepts an actual run commit when a watcher has unresolved targets', async () => {
    getPullRequestStateMock.mockResolvedValue({ status: 'known', state: 'OPEN' });
    committedDuringRun.mockResolvedValueOnce(true);
    await finalize({ finalSummary: completedSentinel });
    expect(committedDuringRun).toHaveBeenCalledOnce();
    expect(completion()).toMatchObject({ success: true, validationPassed: true, taskOutcome: { status: 'completed' } });
  });

  it('does not verify merges after an unsuccessful run', async () => {
    await finalize({ success: false, exitCode: 1, finalSummary: completedSentinel });
    expect(getPullRequestStateMock).not.toHaveBeenCalled();
    expect(completion()).toMatchObject({ success: false, taskOutcome: { status: 'incomplete' } });
  });
});
