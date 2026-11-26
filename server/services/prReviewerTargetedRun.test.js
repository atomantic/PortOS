import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllTasks } from './cos/cosTaskStore.js';
import { listExternalOpenPullRequests } from './prReviewerSecurity.js';
import { getOnDemandRequests, triggerOnDemandTask } from './taskSchedule.js';
import { queueTargetedPrReview, reviewActionFor } from './prReviewerTargetedRun.js';

vi.mock('./cos/cosTaskStore.js', () => ({ getAllTasks: vi.fn() }));
vi.mock('./prReviewerSecurity.js', () => ({ listExternalOpenPullRequests: vi.fn() }));
vi.mock('./taskSchedule.js', () => ({
  getOnDemandRequests: vi.fn(),
  triggerOnDemandTask: vi.fn(),
}));

const app = { id: 'example-app' };
const pr = { number: 42, headRefOid: 'a'.repeat(40) };
const noTasks = { user: { tasks: [] }, cos: { tasks: [] } };
const queued = { id: 'request-1', taskType: 'pr-reviewer', appId: app.id, targetPullRequest: '42' };
const reviewTask = {
  id: 'review-task',
  status: 'in_progress',
  metadata: { analysisType: 'pr-reviewer', app: app.id, targetPullRequest: '42' },
};

beforeEach(() => {
  vi.resetAllMocks();
  listExternalOpenPullRequests.mockResolvedValue({ ok: true, prs: [pr] });
  getAllTasks.mockResolvedValue(noTasks);
  getOnDemandRequests.mockResolvedValue([]);
  triggerOnDemandTask.mockResolvedValue(queued);
});

describe('queueTargetedPrReview', () => {
  it.each([
    ['unreadable forge', { ok: false, code: 'security-scan-pr-list-failed' }, {
      status: 503, code: 'FORGE_UNAVAILABLE', context: { reason: 'security-scan-pr-list-failed' },
    }],
    ['unavailable forge without a specific reason', { ok: false }, {
      status: 503, code: 'FORGE_UNAVAILABLE', context: { reason: 'security-scan-target-unavailable' },
    }],
    ['target absent from the eligible set', { ok: true, prs: [{ ...pr, number: 43 }] }, {
      status: 409, code: 'PULL_REQUEST_NOT_REVIEWABLE',
    }],
    ['unresolvable head', { ok: true, prs: [{ ...pr, headRefOid: null }] }, {
      status: 502, code: 'PULL_REQUEST_CONTEXT_UNAVAILABLE',
    }],
  ])('refuses the request for %s before accessing the queue', async (_name, target, expected) => {
    listExternalOpenPullRequests.mockResolvedValue(target);

    await expect(queueTargetedPrReview(app, pr.number)).rejects.toMatchObject(expected);
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(getOnDemandRequests).not.toHaveBeenCalled();
    expect(triggerOnDemandTask).not.toHaveBeenCalled();
  });

  it.each([
    ['task store rejects', () => getAllTasks.mockRejectedValue(new Error('Task store unavailable'))],
    ['user tasks missing', () => getAllTasks.mockResolvedValue({ cos: noTasks.cos })],
    ['CoS tasks malformed', () => getAllTasks.mockResolvedValue({ ...noTasks, cos: { tasks: {} } })],
    ['request store rejects', () => getOnDemandRequests.mockRejectedValue(new Error('Request store unavailable'))],
    ['request store returns an invalid shape', () => getOnDemandRequests.mockResolvedValue({ requests: [] })],
  ])('fails closed when the %s', async (_name, failRead) => {
    failRead();

    await expect(queueTargetedPrReview(app, pr.number)).rejects.toMatchObject({
      status: 503, code: 'AGENT_ACTION_UNAVAILABLE',
    });
    expect(triggerOnDemandTask).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', 'user'],
    ['in_progress', 'cos'],
    ['blocked', 'cos'],
  ])('reuses the %s task in the %s task store', async (status, store) => {
    getAllTasks.mockResolvedValue({ ...noTasks, [store]: { tasks: [{ ...reviewTask, status }] } });
    getOnDemandRequests.mockResolvedValue([queued]);

    await expect(queueTargetedPrReview(app, pr.number)).resolves.toEqual({
      duplicate: true,
      reviewAction: { taskId: reviewTask.id, status },
    });
    expect(triggerOnDemandTask).not.toHaveBeenCalled();
  });

  it('reuses a queued request before it has a task', async () => {
    getOnDemandRequests.mockResolvedValue([queued]);

    await expect(queueTargetedPrReview(app, pr.number)).resolves.toEqual({
      duplicate: true,
      reviewAction: { taskId: null, status: 'pending' },
    });
    expect(triggerOnDemandTask).not.toHaveBeenCalled();
  });

  it('queues exactly one targeted run with the supplied options and ignores unrelated actions', async () => {
    getAllTasks.mockResolvedValue({ ...noTasks, cos: { tasks: [
      { ...reviewTask, metadata: { ...reviewTask.metadata, targetPullRequest: undefined } },
      { ...reviewTask, metadata: { ...reviewTask.metadata, analysisType: 'code-review' } },
      { ...reviewTask, status: 'completed' },
    ] } });
    getOnDemandRequests.mockResolvedValue([
      { ...queued, appId: 'another-app' },
      { ...queued, targetPullRequest: 43 },
      { ...queued, taskType: 'code-review' },
    ]);
    const options = { provider: 'example-provider', model: 'example-model', effort: 'medium', origin: 'autopilot' };

    await expect(queueTargetedPrReview(app, pr.number, options)).resolves.toEqual({
      duplicate: false, request: queued,
    });
    expect(triggerOnDemandTask).toHaveBeenCalledExactlyOnceWith('pr-reviewer', app.id, {
      targetPullRequest: pr.number, ...options,
    });
  });

  it('reports a schedule refusal without returning a queued request', async () => {
    triggerOnDemandTask.mockResolvedValue({ error: 'PR reviewer is disabled' });

    await expect(queueTargetedPrReview(app, pr.number)).rejects.toMatchObject({
      status: 409, code: 'PR_REVIEWER_UNAVAILABLE', message: 'PR reviewer is disabled',
    });
  });
});

describe('reviewActionFor', () => {
  it.each([
    ['feedback', { preflight: { outcome: 'programmatic', reason: 'patch-conflict-markers', note: 'Feedback posted' } }, {
      status: 'feedback', error: 'Feedback posted',
    }],
    ['failure', { preflightFailure: 'security-guard-not-ready', note: 'Abuse Guard unavailable' }, {
      status: 'failed', failureReason: 'security-guard-not-ready', error: 'Abuse Guard unavailable',
    }],
  ])('presents the latest completed preflight %s until a retry is pending', (_name, extraMetadata, expected) => {
    const tasks = [
      { ...reviewTask, id: 'old-review', status: 'completed' },
      { ...reviewTask, status: 'completed', metadata: { ...reviewTask.metadata, ...extraMetadata } },
    ];

    expect(reviewActionFor(pr, tasks, [], app.id)).toEqual({ taskId: reviewTask.id, ...expected });
    expect(reviewActionFor(pr, tasks, [queued], app.id)).toEqual({ taskId: null, status: 'pending' });
  });

  it('shows no action when state is unreadable or the completed task has no diagnostic', () => {
    expect(reviewActionFor(pr, null, null, app.id)).toBeNull();
    expect(reviewActionFor(pr, [{ ...reviewTask, status: 'completed' }], [], app.id)).toBeNull();
  });
});
