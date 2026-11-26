import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const state = vi.hoisted(() => ({
  interval: { perpetual: true, taskMetadata: { issueAuthorFilter: 'self' } },
  appOverrides: {},
  detection: {
    actionable: true,
    count: 1,
    total: 1,
    signature: '[42]',
    candidates: [{ number: 42, title: 'Fix crash', epic: false, author: 'alice' }],
    items: [{ ref: '42', title: 'Fix crash' }],
  },
  preflight: {
    epic: false,
    issueContext: { number: 42, title: 'Fix crash', body: 'Crash on boot', url: 'https://github.com/acme/widget/issues/42' },
    issueAuthor: 'alice',
    forgeContext: { repo: 'acme/widget', host: 'github.com', me: 'alice' },
    commentsClear: true,
    linkedWorkClear: true,
    linkedItems: [],
  },
}));

const prepareAppIssueClaimMock = vi.hoisted(() => vi.fn());
const detectActionableWorkMock = vi.hoisted(() => vi.fn());

vi.mock('../apps.js', () => ({
  getAppTaskTypeOverrides: vi.fn(async () => state.appOverrides),
  getActiveApps: vi.fn(async () => []),
  getAppById: vi.fn(async () => null),
}));
vi.mock('../appActivity.js', async original => ({
  ...await original(), updateAppActivity: vi.fn(async () => {}), loadAppActivity: vi.fn(async () => ({ apps: {} })),
}));
vi.mock('../../lib/planIds.js', async original => ({
  ...await original(), findInProgressIds: vi.fn(async () => new Set()),
}));
vi.mock('../appTaskProviderPin.js', () => ({ resolveAgentProviderPin: vi.fn(async () => ({ providerId: null, model: null })) }));
vi.mock('../../lib/workTracker.js', async (importActual) => ({
  ...(await importActual()),
  resolveAppWorkTracker: vi.fn(async () => ({ resolved: 'github', source: 'origin' })),
  resolveTrackerFilingBlock: vi.fn(async () => ({ trackerInstructions: '', workTracker: 'github', worktreeChangesExpected: false })),
}));
vi.mock('../perpetualWork.js', async (importActual) => ({
  ...(await importActual()),
  detectActionableWork: (...args) => detectActionableWorkMock(...args),
}));
vi.mock('../appIssues.js', () => ({
  prepareAppIssueClaim: (...args) => prepareAppIssueClaimMock(...args),
}));
vi.mock('../taskSchedule.js', async (importActual) => ({
  ...(await importActual()),
  getTaskInterval: vi.fn(async () => state.interval),
  getDueTasks: vi.fn(async () => []),
  recordExecution: vi.fn(async () => {}),
  getPerpetualDrainState: vi.fn(async () => ({ signature: null, dispatchCount: 0 })),
  recordPerpetualStall: vi.fn(async () => {}),
  recordPerpetualDispatch: vi.fn(async () => {}),
  parkPerpetual: vi.fn(async () => {}),
}));
vi.mock('../codeReview.js', async (importActual) => ({
  ...(await importActual()),
  getCodeReviewDefaults: vi.fn(async () => ({ reviewers: ['codex'] })),
}));
vi.mock('../claimReviewerPreflight.js', () => ({ preflightClaimReviewers: vi.fn(async () => '') }));
vi.mock('../provider/providers.js', () => ({ listProviders: vi.fn(() => []) }));
vi.mock('../taskTypeHooks.js', async (importActual) => ({
  ...(await importActual()),
  getTaskInputHook: vi.fn(() => null),
}));
vi.mock('../taskDataInputs.js', () => ({
  resolveTaskDataInputs: vi.fn(async () => ({ inputs: [] })),
  appendTaskDataInputs: vi.fn((desc) => desc),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('../taskLearning.js', () => ({
  getTaskTypeConfidence: vi.fn(async () => ({ confidence: 1, autoApprove: true, reason: 'mocked' })),
}));
vi.mock('../preflightTaskCard.js', () => ({
  recordPreflightOutcome: vi.fn(async () => {}),
  preflightReporter: vi.fn(() => () => {}),
}));

import { findInProgressIds } from '../../lib/planIds.js';
import { resolveAppWorkTracker } from '../../lib/workTracker.js';
import { updateAppActivity, loadAppActivity } from '../appActivity.js';
import { getActiveApps } from '../apps.js';
import { getTaskInputHook } from '../taskTypeHooks.js';
import { getDueTasks, getPerpetualDrainState, recordPerpetualDispatch, recordPerpetualStall } from '../taskSchedule.js';
import { emitLog } from './cosEvents.js';
import { prepareManagedAppImprovementTask } from './cosManagedAppPreparation.js';
import { PERPETUAL_TRANSIENT_ESCALATION_THRESHOLD, queueEligibleImprovementTasks } from './cosImprovementTasks.js';

const APP = { id: 'app-1', name: 'Widget', repoPath: '/repo' };
const COS_STATE = { config: {} };

beforeEach(() => {
  vi.clearAllMocks();
  state.interval = { perpetual: true, taskMetadata: { issueAuthorFilter: 'self' } };
  state.appOverrides = {};
  state.detection = {
    actionable: true,
    count: 1,
    total: 1,
    signature: '[42]',
    candidates: [{ number: 42, title: 'Fix crash', epic: false, author: 'alice' }],
    items: [{ ref: '42', title: 'Fix crash' }],
  };
  state.preflight = {
    epic: false,
    issueContext: { number: 42, title: 'Fix crash', body: 'Crash on boot', url: 'https://github.com/acme/widget/issues/42' },
    issueAuthor: 'alice',
    forgeContext: { repo: 'acme/widget', host: 'github.com', me: 'alice' },
    commentsClear: true,
    linkedWorkClear: true,
    linkedItems: [],
  };
  detectActionableWorkMock.mockImplementation(async () => state.detection);
  prepareAppIssueClaimMock.mockImplementation(async () => state.preflight);
});

describe('scheduled claim-work pre-selection and server provisioning', () => {
  it('pre-pins, prefetches, and enables server checkout for the top eligible non-epic issue', async () => {
    const res = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);
    expect(res.skip).toBeNull();
    expect(prepareAppIssueClaimMock).toHaveBeenCalledWith(APP, '42', 'github', { includePreflight: true });
    expect(res.task.metadata.claimTarget).toBe('42');
    expect(res.task.metadata.claimServerCheckout).toBe(true);
    const prompt = res.task.description;
    expect(prompt).toContain('Selected GitHub issue #42');
    expect(prompt).toContain('Crash on boot');
    expect(prompt.indexOf('<portos-prefetched-issue>')).toBeLessThan(prompt.indexOf('## Selection exit'));
    expect(prompt).toContain('## Phase 2 — Claim (already provisioned by PortOS)');
    expect(prompt).not.toContain('gh issue list --state open');
    expect(prompt).not.toContain('COMMENTS_FILE=');
    expect(prompt).not.toContain('## Phase 3b — Check linked issues and PRs');
  });

  it('renders and persists the configured reviewer model, effort and round limit together', async () => {
    state.interval = { perpetual: true, taskMetadata: {
      swarmCount: 3, reviewers: ['ollama'],
      reviewerModels: { ollama: 'example-model' }, reviewerEfforts: { ollama: 'high' }, reviewerMaxRounds: { ollama: 2 },
    } };

    const { task } = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);

    expect(task.metadata).toMatchObject({
      reviewers: ['ollama'], reviewerModels: { ollama: 'example-model' },
      reviewerEfforts: { ollama: 'high' }, reviewerMaxRounds: { ollama: 2 },
    });
    expect(task.description).toContain('ollama[example-model]~max=2~effort=high');
    expect(task.description).toContain('--arg backend ollama');
    expect(task.description).toContain('--arg effort high');
  });

  it('uses the GitLab prompt and honors a direct claim-work customization', async () => {
    state.interval = { taskMetadata: { issueAuthorFilter: 'any' } };
    resolveAppWorkTracker.mockResolvedValueOnce({ resolved: 'gitlab', source: 'test' });

    const delegated = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);

    expect(delegated.task.metadata).toMatchObject({ claimFlow: true, useWorktree: false, openPR: false });
    expect(delegated.task.description).toContain('glab issue list');
    expect(delegated.task.description).toContain('regardless of who opened it');

    state.interval.prompt = 'Custom claim-work prompt';
    resolveAppWorkTracker.mockResolvedValueOnce({ resolved: 'gitlab', source: 'test' });
    const customized = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);
    expect(customized.task.description).toContain('Custom claim-work prompt');
  });

  it('skips a raced 409 candidate and pre-pins the next eligible candidate', async () => {
    state.detection.candidates = [
      { number: 42, title: 'Raced', epic: false, author: 'alice' },
      { number: 43, title: 'Next issue', epic: false, author: 'alice' },
    ];
    prepareAppIssueClaimMock
      .mockRejectedValueOnce(Object.assign(new Error('in flight'), { status: 409, code: 'ISSUE_IN_FLIGHT' }))
      .mockResolvedValueOnce({ ...state.preflight, issueContext: { number: 43, title: 'Next issue', body: 'Second body' } });

    const res = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);
    expect(res.task.metadata.claimTarget).toBe('43');
    expect(res.task.metadata.claimServerCheckout).toBe(true);
    expect(res.task.description).toContain('Second body');
  });

  it('withholds eager server checkout markers for an untrusted third-party author under issueAuthorFilter: any', async () => {
    state.interval = { perpetual: true, taskMetadata: { issueAuthorFilter: 'any' } };
    state.preflight.issueAuthor = 'outsider';

    const res = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);
    expect(res.task.metadata.claimTarget).toBe('42');
    expect(res.task.metadata.claimServerCheckout).toBeUndefined();
    expect(res.task.description).toContain('Crash on boot');
    expect(res.task.description).toContain('git worktree add --no-track');
  });

  it('does not pre-pin a single target when swarm mode is enabled', async () => {
    state.interval = { perpetual: true, taskMetadata: { issueAuthorFilter: 'self', swarmCount: 3 } };

    const res = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);
    expect(prepareAppIssueClaimMock).not.toHaveBeenCalled();
    expect(res.task.metadata.claimTarget).toBeUndefined();
    expect(res.task.metadata.claimServerCheckout).toBeUndefined();
    expect(res.task.description).toMatch(/^# ⚡ SWARM MODE/);
  });
});

describe('managed plan-task dispatch', () => {
  async function appWithPlan() {
    const repoPath = await mkdtemp(join(tmpdir(), 'cos-plan-'));
    onTestFinished(async () => { await rm(repoPath, { recursive: true, force: true }); });
    await writeFile(join(repoPath, 'PLAN.md'), '# PLAN\n\n- [ ] [do-work] Do work\n');
    return { ...APP, repoPath };
  }

  it.each(['plan-task', 'claim-work'])('leaves the plan item for %s to claim at execution', async taskType => {
    const app = await appWithPlan();
    if (taskType === 'claim-work') resolveAppWorkTracker.mockResolvedValueOnce({ resolved: 'plan', source: 'test' });

    const prepared = await prepareManagedAppImprovementTask(taskType, app, COS_STATE, { skipPreconditions: true });

    expect(findInProgressIds).toHaveBeenCalledWith(app.repoPath, new Set(['do-work']));
    expect(prepared.skip).toBeNull();
    expect(prepared.task.metadata).toMatchObject({ analysisType: taskType, app: app.id, claimFlow: true });
    expect(prepared.task.description).toContain('claim/<slug>');
    expect(prepared.task.metadata).not.toHaveProperty('planId');
    expect(prepared.task.description).not.toContain('## Item Constraint');
    expect(updateAppActivity).toHaveBeenCalledWith(app.id, expect.objectContaining({ lastImprovementType: taskType }));
  });

  it.each(['plan-task', 'claim-work'])('skips an in-flight plan for %s with no activity or dispatch charge', async taskType => {
    const app = await appWithPlan();
    if (taskType === 'claim-work') resolveAppWorkTracker.mockResolvedValueOnce({ resolved: 'plan', source: 'test' });
    findInProgressIds.mockResolvedValueOnce(new Set(['do-work']));

    const prepared = await prepareManagedAppImprovementTask(taskType, app, COS_STATE, { skipPreconditions: true });

    expect(prepared).toMatchObject({ task: null, skip: { gate: 'plan-gate' }, pendingPerpetualDispatch: null });
    expect(updateAppActivity).not.toHaveBeenCalled();
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
  });

  it('persists the full unpinned plan prompt when the preceding task is still settling', async () => {
    const app = await appWithPlan();
    getActiveApps.mockResolvedValueOnce([app]);
    loadAppActivity.mockResolvedValueOnce({ apps: { [app.id]: { lastReviewedAt: new Date().toISOString() } } });
    getDueTasks.mockImplementation(async appId => appId ? [
      { taskType: 'plan-task', interval: { perpetual: true }, reason: 'perpetual' },
    ] : []);
    const persistTask = vi.fn(async task => ({ ...task }));
    try {
      await queueEligibleImprovementTasks(
        { config: { improvementEnabled: true, appReviewCooldownMs: 60000 } },
        { tasks: [{ id: 'settling', status: 'in_progress', metadata: { app: app.id, analysisType: 'plan-task' } }] },
        { ignoreTaskId: 'settling', persistTask, wakeAfterRecord: false },
      );
      expect(loadAppActivity).toHaveBeenCalledOnce();
      expect(persistTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: expect.stringContaining('claim/<slug>'),
        metadata: expect.objectContaining({ analysisType: 'plan-task', claimFlow: true }),
      }), 'internal', expect.objectContaining({ raw: true, ignoreTaskId: 'settling' }));
      expect(persistTask.mock.calls[0][0].metadata).not.toHaveProperty('planId');
      expect(recordPerpetualDispatch).toHaveBeenCalledWith('plan-task', app.id, expect.any(String));
    } finally {
      getDueTasks.mockResolvedValue([]);
    }
  });
});

it('forwards the completing task to the input hook and the perpetual detector', async () => {
  state.interval.taskMetadata.swarmCount = 3;
  const hook = vi.fn(async () => ({ hookMetadata: { analysisType: 'overwritten', dispatchKey: 'next-work' } }));
  getTaskInputHook.mockResolvedValueOnce(hook);

  const prepared = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE, { ignoreTaskId: 'task-finishing' });

  expect(hook).toHaveBeenCalledWith(expect.objectContaining({ ignoreTaskId: 'task-finishing' }));
  expect(detectActionableWorkMock).toHaveBeenCalledWith('claim-issue', APP, expect.objectContaining({ ignoreTaskId: 'task-finishing' }));
  expect(prepared.task.metadata).toMatchObject({ analysisType: 'claim-work', dispatchKey: 'next-work' });
  expect(prepared.pendingPerpetualDispatch).toEqual({
    taskType: 'claim-work', appId: APP.id, signature: JSON.stringify({ taskType: 'claim-issue', candidates: '[42]' }),
  });
  expect(recordPerpetualDispatch).not.toHaveBeenCalled();
});

it('parks a capped drain before the work detector or activity update runs', async () => {
  state.interval.drainDispatchCap = 5;
  getPerpetualDrainState.mockResolvedValueOnce({ dispatchCount: 5 });

  const prepared = await prepareManagedAppImprovementTask('claim-work', APP, COS_STATE);

  expect(prepared).toMatchObject({ task: null, skip: { gate: 'drain-cap' } });
  expect(detectActionableWorkMock).not.toHaveBeenCalled();
  expect(updateAppActivity).not.toHaveBeenCalled();
});

it('escalates repeated transient detector failures and clears the stall on recovery', async () => {
  const app = { ...APP, id: 'app-with-transient-probe' };
  const fault = { actionable: false, transient: true, cli: 'gh', reason: 'forge unavailable' };
  detectActionableWorkMock.mockResolvedValue(fault);

  for (let i = 1; i < PERPETUAL_TRANSIENT_ESCALATION_THRESHOLD; i++) {
    const prepared = await prepareManagedAppImprovementTask('claim-work', app, COS_STATE);
    expect(prepared.task).toBeNull();
  }
  expect(recordPerpetualStall).not.toHaveBeenCalled();
  expect(emitLog).toHaveBeenCalledWith('debug', expect.stringContaining(fault.reason), expect.anything());

  await prepareManagedAppImprovementTask('claim-work', app, COS_STATE);
  expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining(fault.reason), expect.anything());
  expect(recordPerpetualStall).toHaveBeenCalledExactlyOnceWith('claim-work', app.id, expect.objectContaining({
    cli: fault.cli, reason: fault.reason, consecutive: PERPETUAL_TRANSIENT_ESCALATION_THRESHOLD,
  }));

  detectActionableWorkMock.mockResolvedValue(state.detection);
  await prepareManagedAppImprovementTask('claim-work', app, COS_STATE);
  expect(recordPerpetualStall).toHaveBeenLastCalledWith('claim-work', app.id, null);
});
