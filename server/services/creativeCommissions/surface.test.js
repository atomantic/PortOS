import { describe, it, expect, vi, beforeEach } from 'vitest';

// notifications is lazy-imported inside surfaceCommissionRun, so mock it. The
// mock lets us assert the surfacing shape without file I/O.
const addNotificationMock = vi.fn(async () => {});
vi.mock('../notifications.js', () => ({
  addNotification: (...a) => addNotificationMock(...a),
  NOTIFICATION_TYPES: { CREATIVE_COMMISSION: 'creative_commission' },
  PRIORITY_LEVELS: { LOW: 'low' },
}));

const { surfaceCommissionRun } = await import('./surface.js');

const commission = { id: 'commission-1', name: 'Nightly Surreal', targetAbility: 'video' };
const run = { id: 'run-A', projectId: 'cd-1' };

beforeEach(() => vi.clearAllMocks());

describe('surfaceCommissionRun', () => {
  it('emits a deep-linked, machine-local notification', async () => {
    await surfaceCommissionRun(commission, run);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'creative_commission',
      link: '/creative-commission/commission-1',
      metadata: expect.objectContaining({ commissionId: 'commission-1', runId: 'run-A', projectId: 'cd-1' }),
    }));
  });

  it('does NOT write to the (federated) brain inbox for a machine-local commission', async () => {
    // A brain inbox entry federates to peers where the commission does not exist;
    // surfacing must stay to the local notifications store only. Guard: importing
    // brainStorage would throw here (not mocked), so surfacing must never touch it.
    await expect(surfaceCommissionRun(commission, run)).resolves.toBeUndefined();
    expect(addNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a missing commission/run', async () => {
    await surfaceCommissionRun(null, run);
    await surfaceCommissionRun(commission, null);
    expect(addNotificationMock).not.toHaveBeenCalled();
  });

  it('never throws even if the notification store fails', async () => {
    addNotificationMock.mockRejectedValueOnce(new Error('notif store down'));
    await expect(surfaceCommissionRun(commission, run)).resolves.toBeUndefined();
  });
});
