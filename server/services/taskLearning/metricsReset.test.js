import { describe, it, expect, vi, beforeEach } from 'vitest';

// resetTaskTypeLearning mutates + PERSISTS the learning store, so both the load
// and the save are mocked here — the save capture lets us assert the purge
// without ever touching the real learning.json (repo rule: file-backed tests
// must never mutate real data). withLock/emitLog/calculateDurationETA stay real.
const store = vi.hoisted(() => ({ saved: null }));

vi.mock('./store.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    loadLearningData: vi.fn(),
    saveLearningData: vi.fn(async (data) => { store.saved = data; })
  };
});

import { resetTaskTypeLearning } from './metrics.js';
import { loadLearningData } from './store.js';

// A learning fixture whose failure signatures + correlation window carry samples
// for TWO task types, so a reset of one must leave the other's samples intact.
const fixture = () => ({
  version: 2,
  totals: { completed: 30, succeeded: 20, failed: 10, totalDurationMs: 300000, successMaxDurationMs: 60000 },
  byTaskType: {
    'self-improve:x': { completed: 10, succeeded: 3, failed: 7, successRate: 30, totalDurationMs: 100000, avgDurationMs: 10000, successMaxDurationMs: 20000 },
    'self-improve:y': { completed: 20, succeeded: 17, failed: 3, successRate: 85, totalDurationMs: 200000, avgDurationMs: 10000, successMaxDurationMs: 60000 }
  },
  byModelTier: {},
  routingAccuracy: {},
  errorPatterns: {},
  failureSignatures: {
    'timeout': {
      count: 3,
      lastOccurred: '2026-06-01T00:00:00.000Z',
      recent: [
        { taskType: 'self-improve:x', modelTier: 'heavy', recordedAt: '2026-05-30T00:00:00.000Z' },
        { taskType: 'self-improve:x', modelTier: 'heavy', recordedAt: '2026-05-31T00:00:00.000Z' },
        { taskType: 'self-improve:y', modelTier: 'light', recordedAt: '2026-06-01T00:00:00.000Z' }
      ]
    },
    // A category populated ONLY by the reset type — must be dropped entirely.
    'oom': {
      count: 2,
      lastOccurred: '2026-06-02T00:00:00.000Z',
      recent: [
        { taskType: 'self-improve:x', modelTier: 'heavy', recordedAt: '2026-06-02T00:00:00.000Z' },
        { taskType: 'self-improve:x', modelTier: 'heavy', recordedAt: '2026-06-02T00:00:00.000Z' }
      ]
    }
  },
  correlationWindow: [
    { taskType: 'self-improve:x', tier: 'heavy', predictedRisk: true, bad: true, recordedAt: '2026-06-01T00:00:00.000Z' },
    { taskType: 'self-improve:y', tier: 'light', predictedRisk: false, bad: false, recordedAt: '2026-06-01T00:00:00.000Z' }
  ]
});

describe('resetTaskTypeLearning — failure-signature + correlation purge (#2619)', () => {
  beforeEach(() => {
    store.saved = null;
    vi.mocked(loadLearningData).mockReset();
  });

  it('removes the reset type from every failureSignatures.recent[] and rebuilds counts', async () => {
    vi.mocked(loadLearningData).mockResolvedValue(fixture());
    const result = await resetTaskTypeLearning('self-improve:x');
    expect(result.reset).toBe(true);

    const sig = store.saved.failureSignatures;
    // The shared 'timeout' bucket keeps only the y-sample; count decremented by 2.
    expect(sig.timeout.recent).toHaveLength(1);
    expect(sig.timeout.recent[0].taskType).toBe('self-improve:y');
    expect(sig.timeout.count).toBe(1);
    // The x-only 'oom' bucket is dropped entirely.
    expect(sig.oom).toBeUndefined();
  });

  it('drops the reset type rows from correlationWindow, keeping others', async () => {
    vi.mocked(loadLearningData).mockResolvedValue(fixture());
    await resetTaskTypeLearning('self-improve:x');
    expect(store.saved.correlationWindow).toHaveLength(1);
    expect(store.saved.correlationWindow[0].taskType).toBe('self-improve:y');
  });

  it('never decrements a rebuilt count below zero (defensive against a corrupt count)', async () => {
    const data = fixture();
    data.failureSignatures.timeout.count = 0; // corrupt: fewer than recent[] implies
    vi.mocked(loadLearningData).mockResolvedValue(data);
    await resetTaskTypeLearning('self-improve:x');
    // recent still trimmed to the y-sample; count floored at 0, bucket kept (has a sample).
    expect(store.saved.failureSignatures.timeout.count).toBe(0);
    expect(store.saved.failureSignatures.timeout.recent).toHaveLength(1);
  });

  it('is a no-op on the signature/window purge for an unknown task type', async () => {
    vi.mocked(loadLearningData).mockResolvedValue(fixture());
    const result = await resetTaskTypeLearning('never-seen');
    expect(result.reset).toBe(false);
    // Early return — nothing saved.
    expect(store.saved).toBeNull();
  });

  it('tolerates a store that predates the failureSignatures / correlationWindow keys', async () => {
    const data = fixture();
    delete data.failureSignatures;
    delete data.correlationWindow;
    vi.mocked(loadLearningData).mockResolvedValue(data);
    const result = await resetTaskTypeLearning('self-improve:x');
    expect(result.reset).toBe(true);
    expect(store.saved.byTaskType['self-improve:x']).toBeUndefined();
  });
});
