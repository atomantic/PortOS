import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = {
  confidenceAutoApproval: { enabled: true, highThreshold: 80, lowThreshold: 50, minSamples: 5 },
  safetyKindApproval: { enabled: true, alwaysApproveKinds: ['content', 'publish', 'federation', 'external-pr'] },
};

vi.mock('./cosState.js', async () => {
  const actual = await vi.importActual('./cosState.js');
  return {
    ...actual,
    loadConfig: vi.fn(async () => structuredClone(stored)),
    saveConfig: vi.fn(async (config) => config),
    withConfigLock: vi.fn(async (fn) => fn()),
  };
});

vi.mock('../userActionScheduleLog.js', () => ({ logCosScheduleUpdate: vi.fn() }));
vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn(), on: vi.fn() },
  emitLog: vi.fn(),
}));

const { updateConfig } = await import('./cos.js');
const { saveConfig, loadConfig } = await import('./cosState.js');

describe('updateConfig approval gates', () => {
  beforeEach(() => {
    loadConfig.mockResolvedValue(structuredClone(stored));
    saveConfig.mockImplementation(async (config) => config);
  });

  it('field-merges a partial confidence patch and keeps sibling fields', async () => {
    const next = await updateConfig({ confidenceAutoApproval: { lowThreshold: 40 } });
    expect(next.confidenceAutoApproval).toEqual({
      enabled: true,
      highThreshold: 80,
      lowThreshold: 40,
      minSamples: 5,
    });
    expect(next.safetyKindApproval).toEqual(stored.safetyKindApproval);
  });

  it('rejects a threshold that crosses the stored sibling', async () => {
    await expect(updateConfig({ confidenceAutoApproval: { highThreshold: 40 } }))
      .rejects.toMatchObject({ status: 400 });
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('field-merges a safety-kind list without clearing the enabled flag', async () => {
    const next = await updateConfig({ safetyKindApproval: { alwaysApproveKinds: ['content'] } });
    expect(next.safetyKindApproval).toEqual({ enabled: true, alwaysApproveKinds: ['content'] });
    expect(next.confidenceAutoApproval).toEqual(stored.confidenceAutoApproval);
  });
});
