import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { id: 'cadence-app', name: 'Cadence app', repoPath: '/fixture/app' },
  type: 'mobile-responsive',
  recordExecution: vi.fn(async () => {}),
  updateAppActivity: vi.fn(async () => {}),
  emitLog: vi.fn(),
  applicable: false,
}));
vi.mock('./apps.js', async (actual) => ({
  ...await actual(), getActiveApps: async () => [mocks.app], getAppTaskTypeOverrides: async () => ({}),
}));
vi.mock('./appActivity.js', async (actual) => ({
  ...await actual(), getNextAppForReview: async () => mocks.app,
  markIdleReviewStarted: async () => {}, markAppReviewCooldown: async () => {}, bindAppReviewAgent: async () => {},
  updateAppActivity: (...args) => mocks.updateAppActivity(...args),
}));
vi.mock('./cosState.js', async (actual) => ({
  ...await actual(), withStateLock: async (fn) => fn(), loadState: async () => ({ stats: {} }), saveState: async () => {},
}));
vi.mock('./cosEvents.js', async (actual) => ({ ...await actual(), emitLog: (...args) => mocks.emitLog(...args) }));
vi.mock('./taskSchedule.js', async (actual) => ({
  ...await actual(), getOnDemandRequests: async () => [],
  getNextTaskType: async () => ({ taskType: mocks.type, reason: 'scheduled' }),
  getTaskInterval: async () => ({ taskMetadata: {}, prompt: 'Review {appName}' }),
  recordExecution: (...args) => mocks.recordExecution(...args),
}));
vi.mock('./appQualitySchedule.js', () => ({ resolveAuditApplicability: async () => ({ applicable: mocks.applicable, reason: 'No mobile app' }) }));
vi.mock('./taskTypeHooks.js', () => ({ getTaskInputHook: async () => null }));
vi.mock('./prWatcher.js', () => ({
  checkPullRequests: async () => ({ ok: true, firstRun: false, newPrs: [], repoFullName: 'fixture/app', defaultBranch: 'main' }),
  persistPrWatcherState: async () => {},
}));
vi.mock('./taskPromptService.js', async (actual) => ({ ...await actual(), getTaskPrompt: async () => 'Review {appName}' }));

import { generateIdleReviewTask } from './cosTaskGenerator.js';

const state = { config: { improvementEnabled: true, idleReviewPriority: 'MEDIUM', requireApproval: true, confidenceAutoApproval: { enabled: false } }, stats: {} };
describe('idle-review execution ownership (#12570)', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.applicable = false; });
  it.each(['mobile-responsive', 'pr-watcher'])('records %s skip once without announcing generation', async (type) => {
    mocks.type = type;
    const result = await generateIdleReviewTask(state);
    expect(result.task).toBeNull();
    expect(mocks.recordExecution).toHaveBeenCalledExactlyOnceWith(type, mocks.app.id);
    expect(mocks.updateAppActivity).not.toHaveBeenCalled();
    expect(mocks.emitLog.mock.calls.filter(([, message]) => message.startsWith('Generating improvement task'))).toHaveLength(0);
  });
  it('records and announces a successfully prepared task once', async () => {
    mocks.type = 'code-quality';
    mocks.applicable = true;
    const result = await generateIdleReviewTask(state);
    expect(result.task).toBeTruthy();
    expect(mocks.recordExecution).toHaveBeenCalledExactlyOnceWith('task:code-quality', mocks.app.id);
    expect(mocks.updateAppActivity).toHaveBeenCalledExactlyOnceWith(mocks.app.id, { lastImprovementType: 'code-quality' });
    expect(mocks.emitLog.mock.calls.filter(([, message]) => message.startsWith('Generating improvement task'))).toHaveLength(1);
  });
});
