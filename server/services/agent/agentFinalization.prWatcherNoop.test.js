/**
 * Both delivery and stale selections require forge evidence for every stamped
 * target before a PR watcher can pass without new checkout commits.
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

const execGhMock = vi.fn();
vi.mock('../github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'none', number: null, url: null })),
  execGh: (...args) => execGhMock(...args),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('../gitlab.js', () => ({ findMergeRequestForBranch: vi.fn() }));
const resolveForgeForRepoMock = vi.fn();
vi.mock('../forgeAuth.js', () => ({
  resolveForgeForRepo: (...args) => resolveForgeForRepoMock(...args),
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

import { finalizeAgent } from './agentFinalization.js';
import { committedDuringRun } from '../../lib/gitCommitProbe.js';
import { PR_WATCHER_LIST_LIMIT } from '../prWatcherCompletion.js';

const OWNER = 'example-owner';
const NAME = 'example-repo';
const REPO = `${OWNER}/${NAME}`;
const HOST = 'github.example.com';
const FORGE_ENV = { GH_HOST: HOST, GH_ENTERPRISE_TOKEN: 'test-token' };
const WORKSPACE = '/example/worktree';
const watcherTask = (prNumbers = [7]) => ({
  id: 'sys-app-pr-watcher-1',
  taskType: 'internal',
  description: 'review new PRs',
  metadata: { analysisType: 'pr-watcher', prWatcherTargets: { repoFullName: REPO, repoHost: HOST, prNumbers } },
});
const noOpSentinel = JSON.stringify({ summary: 'PR already merged.', taskOutcome: {
  status: 'no-action-needed', reason: 'The listed PR is already MERGED with CI green.',
} });
const completedSentinel = JSON.stringify({ summary: 'Merged the dispatched PRs.', taskOutcome: {
  status: 'completed', reason: 'All dispatched PRs merged.',
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
  workspacePath: WORKSPACE,
  prExpected: false,
  ...overrides,
});
const completion = () => completeAgentMock.mock.calls[0][1];

const targetNumbers = (count) => Array.from({ length: count }, (_, index) => 7 + index * 3);
const requestedNumbers = (args) => [...args.at(-1).matchAll(/p(\d+):pullRequest\(number:\1\)/g)]
  .map(([, number]) => Number(number));
const batchResult = (args) => ({
  data: { repository: {
    nameWithOwner: REPO,
    ...Object.fromEntries(requestedNumbers(args).map(number => [`p${number}`, { number, state: 'MERGED' }])),
  } },
});
const expectBatches = (numbers, batchSizes) => {
  const calls = execGhMock.mock.calls;
  expect(calls.map(([args]) => requestedNumbers(args).length)).toEqual(batchSizes);
  expect(calls.flatMap(([args]) => requestedNumbers(args))).toEqual(numbers);
  for (const [args, timeout, options] of calls) {
    expect(args.slice(0, -1)).toEqual(['api', 'graphql', '--hostname', HOST, '-f', `owner=${OWNER}`, '-f', `repo=${NAME}`, '-f']);
    expect(timeout).toBe(10_000);
    expect(options).toEqual({ cwd: WORKSPACE, env: FORGE_ENV, backoffKey: `${HOST}/${REPO}` });
  }
  expect(resolveForgeForRepoMock).toHaveBeenCalledExactlyOnceWith(WORKSPACE);
};

beforeEach(() => {
  vi.clearAllMocks();
  getOriginInfoMock.mockResolvedValue({ host: HOST, fullName: REPO });
  resolveForgeForRepoMock.mockResolvedValue({ cli: 'gh', host: HOST, env: FORGE_ENV });
  execGhMock.mockImplementation(async args => JSON.stringify(batchResult(args)));
});

describe('finalizeAgent — PR watcher forge completion', () => {
  it.each([
    [51, [50, 1]],
    [PR_WATCHER_LIST_LIMIT - 1, [50, 50, 50, 49]],
  ])('accepts %i merged PRs without probing watcher-checkout commits', async (count, batchSizes) => {
    const numbers = targetNumbers(count);
    await finalize({ task: watcherTask(numbers), finalSummary: completedSentinel });
    expect(completion()).toMatchObject({ success: true, validationPassed: true, taskOutcome: { status: 'completed' } });
    expect(committedDuringRun).not.toHaveBeenCalled();
    expectBatches(numbers, batchSizes);
  });

  it('accepts no-action-needed across batches with both merged and closed PRs', async () => {
    const numbers = targetNumbers(51);
    execGhMock.mockImplementation(async args => {
      const result = batchResult(args);
      const pr = result.data.repository[`p${numbers.at(-1)}`];
      if (pr) pr.state = 'CLOSED';
      return JSON.stringify(result);
    });
    await finalize({ task: watcherTask(numbers) });
    expect(completion()).toMatchObject({ success: true, validationPassed: true,
      taskOutcome: { status: 'no-action-needed' } });
    expect(committedDuringRun).not.toHaveBeenCalled();
    expectBatches(numbers, [50, 1]);
    expect(resolveFailedTaskUpdateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a target is missing', (result, key) => { delete result.data.repository[key]; }],
    ['a target number does not match its alias', (result, key) => { result.data.repository[key].number++; }],
    ['the repository does not match', (result) => { result.data.repository.nameWithOwner = 'someone/else'; }],
    ['the forge returns partial GraphQL errors', (result) => { result.errors = [{ message: 'unreadable target' }]; }],
    ['a target is still open', (result, key) => { result.data.repository[key].state = 'OPEN'; }],
    ['a target was closed without merging', (result, key) => { result.data.repository[key].state = 'CLOSED'; }],
    ['the forge is unavailable', () => { throw new Error('offline'); }],
  ])('rejects completed when %s in the last batch', async (_name, changeResult) => {
    const numbers = targetNumbers(51);
    execGhMock.mockImplementation(async args => {
      const result = batchResult(args);
      const key = `p${numbers.at(-1)}`;
      if (result.data.repository[key]) changeResult(result, key);
      return JSON.stringify(result);
    });
    await finalize({ task: watcherTask(numbers), finalSummary: completedSentinel });
    expect(completion()).toMatchObject({ success: false, taskOutcome: { status: 'incomplete' } });
    expect(completion().validationPassed).toBe(false);
    expect(committedDuringRun).toHaveBeenCalledExactlyOnceWith(WORKSPACE, expect.any(Number));
    expectBatches(numbers, [50, 1]);
  });

  it('keeps a stale selection incomplete while any stamped target is open', async () => {
    execGhMock.mockResolvedValue(JSON.stringify({
      data: { repository: { nameWithOwner: REPO, p7: { number: 7, state: 'OPEN' } } },
    }));
    await finalize();
    expect(completion()).toMatchObject({ success: false, validationPassed: false, taskOutcome: { status: 'incomplete' } });
    expectBatches([7], [1]);
  });

  it.each([
    ['the workspace is another repository', () => getOriginInfoMock.mockResolvedValue({ host: HOST, fullName: 'someone/else' }), {}],
    ['the same repository name is on another forge', () => getOriginInfoMock.mockResolvedValue({ host: 'github.com', fullName: REPO }), {}],
    ['credential resolution fails', () => resolveForgeForRepoMock.mockRejectedValue(new Error('unavailable pin')), {}],
    ['the credential resolves for a different host', () => resolveForgeForRepoMock.mockResolvedValue({ cli: 'gh', host: 'github.com' }), {}],
    ['the target count reaches the polling cap', () => {}, { task: watcherTask(targetNumbers(PR_WATCHER_LIST_LIMIT)) }],
    ['the dispatched repository host was not captured', () => {}, { task: { ...watcherTask(), metadata: { analysisType: 'pr-watcher', prWatcherTargets: { repoFullName: REPO, prNumbers: [7] } } } }],
    ['no targets were stamped at dispatch', () => {}, { task: { ...watcherTask(), metadata: { analysisType: 'pr-watcher' } } }],
    ['the task is another type', () => {}, { task: { ...watcherTask(), metadata: { ...watcherTask().metadata, analysisType: 'code-quality' } } }],
  ])('keeps the no-op incomplete when %s', async (_name, arrange, overrides) => {
    arrange();
    await finalize(overrides);
    expect(completion()).toMatchObject({ success: false, taskOutcome: { status: 'incomplete' } });
    expect(completion().validationPassed).not.toBe(true);
    expect(execGhMock).not.toHaveBeenCalled();
  });
});
