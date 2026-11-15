/**
 * Shared mocks and fixtures for the taskLearning leaf suites (reset, routing,
 * metrics, insights).
 *
 * `vi.mock` calls are hoisted per test file, so each suite declares them and
 * delegates the factories here.
 */
import { vi } from 'vitest';

export const fsPromisesFactory = () => ({
  readFile: vi.fn(),
  mkdir: vi.fn()
});

export const fsFactory = () => ({
  existsSync: vi.fn(() => true)
});

export const cosEventsFactory = () => ({
  cosEvents: { on: vi.fn(), emit: vi.fn() },
  emitLog: vi.fn()
});

// Mock fileUtils.js to use our mocked fs/promises
export const fileUtilsFactory = async () => {
  const fsPromises = await import('fs/promises');
  const fs = await import('fs');
  return {
    ensureDir: vi.fn(),
    atomicWrite: vi.fn().mockResolvedValue(undefined),
    readJSONFile: vi.fn(async (filePath, defaultValue) => {
      if (!fs.existsSync(filePath)) return defaultValue;
      const content = await fsPromises.readFile(filePath, 'utf-8');
      if (!content || !content.trim()) return defaultValue;
      return JSON.parse(content);
    }),
    PATHS: { cos: '/tmp/test/cos' }
  };
};

export const makeLearningData = (overrides = {}) => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  version: 1,
  lastUpdated: '2026-01-26T00:00:00.000Z',
  byTaskType: {
    'self-improve:ui': {
      completed: 200,
      succeeded: 10,
      failed: 190,
      totalDurationMs: 2000000,
      avgDurationMs: 10000,
      lastCompleted: '2026-01-25T00:00:00.000Z',
      successRate: 5
    },
    'user-task': {
      completed: 40,
      succeeded: 30,
      failed: 10,
      totalDurationMs: 4000000,
      avgDurationMs: 100000,
      lastCompleted: '2026-01-26T00:00:00.000Z',
      successRate: 75
    }
  },
  byModelTier: {
    'user-specified': {
      completed: 240,
      succeeded: 40,
      failed: 200,
      totalDurationMs: 6000000,
      avgDurationMs: 25000
    }
  },
  errorPatterns: {
    'server-error': {
      count: 190,
      taskTypes: { 'self-improve:ui': 185, 'user-task': 5 },
      lastOccurred: '2026-01-25T00:00:00.000Z'
    },
    'unknown': {
      count: 10,
      taskTypes: { 'self-improve:ui': 10 },
      lastOccurred: '2026-01-24T00:00:00.000Z'
    }
  },
  totals: {
    completed: 240,
    succeeded: 40,
    failed: 200,
    totalDurationMs: 6000000,
    avgDurationMs: 25000
  },
  ...overrides
});

// A correlation-quality window proving the enriched failure signal predicts
// outcomes (perfect correlation, >= MIN_CORRELATION_SAMPLES) — so `suggestModelTier`
// runs the AGGRESSIVE failure-sample bar (3) and the #2329 avoidance mechanics
// engage. Without this the #2344 gate holds avoidance back to the conservative
// bar (5) until the signal has earned it. Injected into the #2329 avoidance
// tests to isolate their intent from the new gate (which has its own tests).
export const provenCorrelationWindow = () => Array.from({ length: 24 }, (_, i) => ({
  taskType: 'user-task', tier: 'heavy',
  predictedRisk: i % 2 === 0,
  bad: i % 2 === 0,
  recordedAt: '2026-01-26T00:00:00.000Z'
}));
