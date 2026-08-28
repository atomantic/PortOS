import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendMindEvent: vi.fn(async (event) => ({ appended: true, event })),
  clearHistory: vi.fn(async () => ({ cleared: 12, preserved: 3 })),
  archiveMemories: vi.fn(async () => ({ archived: 4 })),
  clearRollups: vi.fn(async () => ({ cleared: 2 })),
  resetRuntime: vi.fn(async () => ({ status: 'thinking' })),
}));

vi.mock('./agentRunEventLog.js', () => ({
  appendMindEvent: (...args) => mocks.appendMindEvent(...args),
  clearPersistentMindHistory: (...args) => mocks.clearHistory(...args),
}));
vi.mock('./persistentMindContext.js', () => ({
  archivePersistentMindMemories: (...args) => mocks.archiveMemories(...args),
  clearPersistentMindRollups: (...args) => mocks.clearRollups(...args),
}));
vi.mock('./persistentMindSupervisor.js', () => ({
  resetPersistentMindRuntimeResidue: (...args) => mocks.resetRuntime(...args),
}));

const { cleanupPersistentMind } = await import('./persistentMindMaintenance.js');

beforeEach(() => vi.clearAllMocks());

describe('persistent mind maintenance', () => {
  it('clears selected owned state and preserves the requesting turn', async () => {
    const result = await cleanupPersistentMind({
      scopes: ['history', 'memories'],
      requestedBy: 'mind',
      preserveTurnId: 'turn-current',
      preserveMessageId: 'message-current',
      reason: 'Discard stale failures',
    });

    expect(mocks.archiveMemories).toHaveBeenCalledWith('cos-persistent-mind');
    expect(mocks.clearRollups).toHaveBeenCalledWith('cos-persistent-mind');
    expect(mocks.clearHistory).toHaveBeenCalledWith({
      mindId: 'cos-persistent-mind',
      preserveTurnId: 'turn-current',
      preserveMessageId: 'message-current',
    });
    expect(mocks.resetRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.appendMindEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mind.maintenance.completed',
      turnId: 'turn-current',
      data: expect.objectContaining({
        requestedBy: 'mind',
        reason: 'Discard stale failures',
        scopes: ['history', 'memories'],
      }),
    }));
    expect(result).toMatchObject({
      success: true,
      memoriesArchived: 4,
      historyEventsCleared: 12,
      historyEventsPreserved: 3,
      rollupsCleared: 2,
      runtimeResidueCleared: true,
      auditRecorded: true,
    });
  });

  it('does not clear unrelated surfaces for a memory-only request', async () => {
    await cleanupPersistentMind({ scopes: ['memories'] });

    expect(mocks.archiveMemories).toHaveBeenCalledTimes(1);
    expect(mocks.clearRollups).not.toHaveBeenCalled();
    expect(mocks.clearHistory).not.toHaveBeenCalled();
    expect(mocks.resetRuntime).not.toHaveBeenCalled();
  });
});
