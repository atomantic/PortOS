import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ collectEidoverseWorldSources: vi.fn() }));

vi.mock('./eidoverseWorldSources.js', () => ({
  collectEidoverseWorldSources: (...args) => mock.collectEidoverseWorldSources(...args),
}));

const { resolvePersistentMindPlaybookPhase } = await import('./persistentMindPlaybookSignals.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolvePersistentMindPlaybookPhase', () => {
  it('derives a phase from a live world-signals projection', async () => {
    mock.collectEidoverseWorldSources.mockResolvedValue({
      apps: [{ id: 'a' }, { id: 'b' }],
      agents: [{ id: 'c' }],
      features: [{ id: 'd' }],
      peers: [{ travelAvailable: true, status: 'active' }],
      productivity: [{ succeededToday: 8, failedToday: 0 }],
    });
    const result = await resolvePersistentMindPlaybookPhase();
    expect(mock.collectEidoverseWorldSources).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe('coordinate');
    expect(result.signals).toMatchObject({ districtCount: 5, failureRate: 0, peersWithActivity: 1 });
  });

  it('degrades to the safe explore default when the signal read fails', async () => {
    mock.collectEidoverseWorldSources.mockRejectedValue(new Error('world source unavailable'));
    const result = await resolvePersistentMindPlaybookPhase();
    expect(result.phase).toBe('explore');
    expect(result.signals).toEqual({ districtCount: null, failureRate: null, peersWithActivity: null });
  });

  it('propagates an abort rather than swallowing it as a signal failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('turn interrupted'));
    mock.collectEidoverseWorldSources.mockRejectedValue(new Error('turn interrupted'));
    await expect(resolvePersistentMindPlaybookPhase({ signal: controller.signal })).rejects.toThrow('turn interrupted');
  });
});
