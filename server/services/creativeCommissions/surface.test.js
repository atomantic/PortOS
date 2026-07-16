import { describe, it, expect, vi, beforeEach } from 'vitest';

// notifications + brainStorage are lazy-imported inside surfaceCommissionRun, so
// mock both. The mocks let us assert the surfacing shape without file/DB I/O.
const addNotificationMock = vi.fn(async () => {});
vi.mock('../notifications.js', () => ({
  addNotification: (...a) => addNotificationMock(...a),
  NOTIFICATION_TYPES: { CREATIVE_COMMISSION: 'creative_commission' },
  PRIORITY_LEVELS: { LOW: 'low' },
}));

const createInboxLogMock = vi.fn(async () => ({ id: 'inbox-1' }));
vi.mock('../brainStorage.js', () => ({ createInboxLog: (...a) => createInboxLogMock(...a) }));

const { surfaceCommissionRun } = await import('./surface.js');

const commission = { id: 'commission-1', name: 'Nightly Surreal', targetAbility: 'video' };
const run = { id: 'run-A', projectId: 'cd-1' };

beforeEach(() => vi.clearAllMocks());

describe('surfaceCommissionRun', () => {
  it('emits a deep-linked notification and a brain inbox entry', async () => {
    await surfaceCommissionRun(commission, run);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'creative_commission',
      link: '/creative-commission/commission-1',
      metadata: expect.objectContaining({ commissionId: 'commission-1', runId: 'run-A', projectId: 'cd-1' }),
    }));
    expect(createInboxLogMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'creative_commission',
      status: 'needs_review',
      creative: true,
    }));
  });

  it('creates the brain entry WITHOUT ai metadata (no cold classifier LLM call)', async () => {
    await surfaceCommissionRun(commission, run);
    const entry = createInboxLogMock.mock.calls[0][0];
    expect(entry.ai).toBeUndefined();
  });

  it('is a no-op for a missing commission/run', async () => {
    await surfaceCommissionRun(null, run);
    await surfaceCommissionRun(commission, null);
    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(createInboxLogMock).not.toHaveBeenCalled();
  });

  it('never throws, and still tries the inbox even if the notification fails', async () => {
    addNotificationMock.mockRejectedValueOnce(new Error('notif store down'));
    await expect(surfaceCommissionRun(commission, run)).resolves.toBeUndefined();
    expect(createInboxLogMock).toHaveBeenCalledTimes(1); // second surface still attempted
  });
});
