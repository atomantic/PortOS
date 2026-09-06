import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ check: vi.fn(), screen: vi.fn(), persist: vi.fn() }));
vi.mock('./apps.js', () => ({ getActiveApps: vi.fn() }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: vi.fn() }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: vi.fn(async () => ({ host: 'github.com' })) }));
vi.mock('./forgeMaintenanceEvidence.js', () => ({ screenForgeMaintenance: mock.screen }));
vi.mock('./prWatcher.js', () => ({
  checkPullRequests: mock.check,
  persistPrWatcherState: mock.persist,
  readPrWatcherState: app => app.prWatcherState,
  formatPullRequestsForPrompt: records => records.map(record => `PR #${record.number}`).join('\n'),
}));
import { resolvePrWatcherBlock } from './cosTaskPreStepBlocks.js';

describe('trusted PR scheduling after discussion screening', () => {
  const app = { id: 'example', name: 'Example', repoPath: '/repo', prWatcherState: { activityByPr: { 7: 'old' } } };
  beforeEach(() => {
    vi.clearAllMocks();
    mock.check.mockResolvedValue({ ok: true, firstRun: false, newPrs: [{ number: 7 }, { number: 8 }], newLastSeen: 8, activityByPr: { 7: 'changed', 8: 'new' }, repoFullName: 'example/project', defaultBranch: 'main' });
  });

  it('dispatches cleared records and keeps the withheld fingerprint retryable', async () => {
    mock.screen.mockResolvedValue({ ok: true, records: [{ number: 8 }], withheld: [{ number: 7, code: 'injection' }], code: 'injection' });
    const metadata = {};
    const result = await resolvePrWatcherBlock(app, 'pr-watcher', metadata, { recordExecution: vi.fn() });
    expect(result).toMatchObject({ skip: false, block: 'PR #8' });
    expect(metadata.forgeMaintenanceVersion).toBe(1);
    expect(mock.persist).toHaveBeenCalledWith(app.id, expect.objectContaining({ activityByPr: { 7: 'old', 8: 'new' }, lastError: 'injection' }));
  });

  it('does not acknowledge any activity or authorize a task when screening is unavailable', async () => {
    mock.screen.mockResolvedValue({ ok: false, records: [], withheld: [{ number: 7, code: 'unavailable' }], code: 'unavailable' });
    const metadata = {};
    const recordExecution = vi.fn();
    expect(await resolvePrWatcherBlock(app, 'pr-watcher', metadata, { recordExecution })).toEqual({ skip: true });
    expect(mock.persist.mock.calls[0][1]).not.toHaveProperty('activityByPr');
    expect(metadata).not.toHaveProperty('forgeMaintenanceVersion');
    expect(recordExecution).toHaveBeenCalledOnce();
  });
});
