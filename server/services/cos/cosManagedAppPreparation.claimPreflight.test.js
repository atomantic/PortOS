import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../appActivity.js', () => ({ updateAppActivity: vi.fn(async () => {}) }));
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

import { prepareManagedAppImprovementTask } from './cosManagedAppPreparation.js';

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
    expect(res.task.description).toContain('SWARM MODE');
  });
});
