import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock dependencies before importing the module
vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}));

vi.mock('./cos/cosEvents.js', () => ({
  cosEvents: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn(),
  // atomicWrite replaced the raw writeFile(JSON.stringify) site (#1837); route
  // it through the mocked fs/promises.writeFile so writeFile.mockImplementation
  // capture in the tests keeps working unchanged.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
  PATHS: { cos: '/mock/data/cos' },
  readJSONFile: vi.fn()
}));

// Helper to create mock decision data
const makeDecisionData = (overrides = {}) => ({
  version: 1,
  decisions: [],
  stats: {
    totalDecisions: 0,
    byType: {}
  },
  ...overrides
});

describe('decisionLog.js', () => {
  let savedData;
  let writeFile;
  let readJSONFile;
  let recordDecision;
  let getDecisionSummary;
  let DECISION_TYPES;

  beforeAll(async () => {
    // Import mocks after they're set up
    const fsPromises = await import('fs/promises');
    writeFile = fsPromises.writeFile;
    const fileUtils = await import('../lib/fileUtils.js');
    readJSONFile = fileUtils.readJSONFile;
  });

  beforeEach(async () => {
    // Reset modules to clear the in-memory cache between tests
    vi.resetModules();

    // Re-mock after reset
    vi.doMock('fs/promises', () => ({
      writeFile: vi.fn(),
      mkdir: vi.fn()
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn(() => true)
    }));
    vi.doMock('./cos/cosEvents.js', () => ({
      cosEvents: { emit: vi.fn(), on: vi.fn() }
    }));
    vi.doMock('../lib/fileUtils.js', () => ({
      ensureDir: vi.fn(),
      atomicWrite: vi.fn(async (filePath, data) => {
        const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
        const { writeFile } = await import('fs/promises');
        return writeFile(filePath, payload);
      }),
      PATHS: { cos: '/mock/data/cos' },
      readJSONFile: vi.fn()
    }));

    // Re-import fresh module instances
    const fsPromises = await import('fs/promises');
    writeFile = fsPromises.writeFile;
    const fileUtils = await import('../lib/fileUtils.js');
    readJSONFile = fileUtils.readJSONFile;
    const decisionLogModule = await import('./decisionLog.js');
    recordDecision = decisionLogModule.recordDecision;
    getDecisionSummary = decisionLogModule.getDecisionSummary;
    DECISION_TYPES = decisionLogModule.DECISION_TYPES;

    savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
    });
  });

  describe('recordDecision', () => {
    it('should record a new decision', async () => {
      readJSONFile.mockResolvedValue(makeDecisionData());

      const result = await recordDecision(
        DECISION_TYPES.TASK_SELECTED,
        'Selected high-priority user task',
        { taskType: 'user-task', priority: 'high' }
      );

      expect(result.type).toBe(DECISION_TYPES.TASK_SELECTED);
      expect(result.reason).toBe('Selected high-priority user task');
      expect(result.context.taskType).toBe('user-task');
      expect(result.id).toMatch(/^dec-/);
      expect(result.timestamp).toBeDefined();
    });

    it('should add decision to beginning of list', async () => {
      const existing = makeDecisionData({
        decisions: [
          { id: 'dec-old', type: DECISION_TYPES.IDLE, reason: 'Old decision', timestamp: '2026-01-01T00:00:00.000Z' }
        ]
      });
      readJSONFile.mockResolvedValue(existing);

      await recordDecision(DECISION_TYPES.TASK_SELECTED, 'New decision', {});

      expect(savedData.decisions[0].reason).toBe('New decision');
      expect(savedData.decisions[1].id).toBe('dec-old');
    });

    it('should collapse consecutive identical decisions', async () => {
      const existing = makeDecisionData({
        decisions: [
          {
            id: 'dec-existing',
            type: DECISION_TYPES.IDLE,
            reason: 'No work available',
            count: 1,
            timestamp: '2026-01-25T10:00:00.000Z'
          }
        ]
      });
      readJSONFile.mockResolvedValue(existing);

      const result = await recordDecision(DECISION_TYPES.IDLE, 'No work available', {});

      expect(result.count).toBe(2);
      expect(result.lastTimestamp).toBeDefined();
      expect(savedData.decisions).toHaveLength(1);
    });

    it('should not collapse different decision types', async () => {
      const existing = makeDecisionData({
        decisions: [
          { id: 'dec-1', type: DECISION_TYPES.IDLE, reason: 'No work', timestamp: '2026-01-25T10:00:00.000Z' }
        ]
      });
      readJSONFile.mockResolvedValue(existing);

      await recordDecision(DECISION_TYPES.TASK_SELECTED, 'Task picked', {});

      expect(savedData.decisions).toHaveLength(2);
    });

    it('should not collapse different reasons', async () => {
      const existing = makeDecisionData({
        decisions: [
          { id: 'dec-1', type: DECISION_TYPES.TASK_SKIPPED, reason: 'Reason A', timestamp: '2026-01-25T10:00:00.000Z' }
        ]
      });
      readJSONFile.mockResolvedValue(existing);

      await recordDecision(DECISION_TYPES.TASK_SKIPPED, 'Reason B', {});

      expect(savedData.decisions).toHaveLength(2);
    });

    it('should trim decisions to max size (200)', async () => {
      const decisions = Array(200).fill(null).map((_, i) => ({
        id: `dec-${i}`,
        type: DECISION_TYPES.IDLE,
        reason: `Decision ${i}`,
        timestamp: '2026-01-25T10:00:00.000Z'
      }));
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      await recordDecision(DECISION_TYPES.TASK_SELECTED, 'New one', {});

      expect(savedData.decisions).toHaveLength(200);
      expect(savedData.decisions[0].reason).toBe('New one');
    });

    it('persists every occurrence from overlapping calls and keeps the missing-file default empty', async () => {
      readJSONFile.mockImplementation(async (_path, fallback) => fallback);

      const decisions = await Promise.all([
        recordDecision(DECISION_TYPES.IDLE, 'No work', { cycle: 1 }),
        recordDecision(DECISION_TYPES.IDLE, 'No work', { cycle: 2 }),
        recordDecision(DECISION_TYPES.TASK_SELECTED, 'New work')
      ]);

      expect(decisions.map(({ count }) => count)).toEqual([1, 2, 1]);
      expect(savedData.decisions).toMatchObject([
        { reason: 'New work', count: 1 },
        { reason: 'No work', count: 2, context: { cycle: 2 } }
      ]);
      expect(savedData.stats).toEqual({
        totalDecisions: 3,
        byType: { [DECISION_TYPES.IDLE]: 2, [DECISION_TYPES.TASK_SELECTED]: 1 }
      });
      expect(readJSONFile.mock.calls[0][1]).toEqual(makeDecisionData());
    });

    it('isolates defaults across cold reads while a decision is being recorded', async () => {
      const firstRead = Promise.withResolvers();
      const readStarted = Promise.withResolvers();
      readJSONFile
        .mockImplementationOnce(async (_path, fallback) => {
          readStarted.resolve();
          await firstRead.promise;
          return fallback;
        })
        .mockImplementation(async (_path, fallback) => fallback);

      const dashboardRead = getDecisionSummary();
      await readStarted.promise;
      try {
        await recordDecision(DECISION_TYPES.IDLE, 'Recorded during dashboard read');
      } finally {
        firstRead.resolve();
        await dashboardRead;
      }

      const [, firstFallback] = readJSONFile.mock.calls[0];
      const [, secondFallback] = readJSONFile.mock.calls[1];
      expect(secondFallback.decisions).not.toBe(firstFallback.decisions);
      expect(secondFallback.stats).not.toBe(firstFallback.stats);
      expect((await dashboardRead).last24Hours.total).toBe(1);
      expect((await getDecisionSummary()).last24Hours.total).toBe(1);
    });

    it('continues queued writes from the last persisted state when a write fails', async () => {
      readJSONFile.mockResolvedValue(makeDecisionData());
      const failure = new Error('Decision write failed');
      writeFile.mockRejectedValueOnce(failure);

      const outcomes = await Promise.allSettled([
        recordDecision(DECISION_TYPES.IDLE, 'Failed write'),
        recordDecision(DECISION_TYPES.IDLE, 'Persisted write')
      ]);

      expect(outcomes[0]).toEqual({ status: 'rejected', reason: failure });
      expect(outcomes[1].status).toBe('fulfilled');
      expect(savedData.decisions.map(({ reason }) => reason)).toEqual(['Persisted write']);
      expect(savedData.stats.totalDecisions).toBe(1);
      expect((await getDecisionSummary()).last24Hours.total).toBe(1);
    });

    it('should update stats', async () => {
      readJSONFile.mockResolvedValue(makeDecisionData());

      await recordDecision(DECISION_TYPES.TASK_SKIPPED, 'Poor success rate', {});

      expect(savedData.stats.totalDecisions).toBe(1);
      expect(savedData.stats.byType[DECISION_TYPES.TASK_SKIPPED]).toBe(1);
    });
  });

  describe('getDecisionSummary', () => {
    it('invalidates once when the next collapsed decision leaves the rolling window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
      const { dashboardEvents, scheduleDashboardExpiry } = await import('./dashboardEvents.js');
      const changed = vi.fn();
      dashboardEvents.on('cos:decisions:changed', changed);
      try {
        readJSONFile.mockResolvedValue(makeDecisionData({ decisions: [{
          id: 'example', type: DECISION_TYPES.TASK_SKIPPED, reason: 'Example', count: 2,
          timestamp: '2026-01-01T11:00:00Z', lastTimestamp: '2026-01-01T12:00:30Z',
        }] }));
        expect((await getDecisionSummary()).last24Hours.total).toBe(2);
        await getDecisionSummary(); // another browser shares the same expiry
        await vi.advanceTimersByTimeAsync(30_000);
        expect(changed).toHaveBeenCalledTimes(1);
        expect((await getDecisionSummary()).last24Hours.total).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(changed).toHaveBeenCalledTimes(1);
      } finally {
        scheduleDashboardExpiry('cos:decisions:changed', null);
        dashboardEvents.off('cos:decisions:changed', changed);
        vi.useRealTimers();
      }
    });

    it('should return summary for last 24 hours', async () => {
      const now = new Date();
      const recentTimestamp = new Date(now.getTime() - 1000 * 60 * 60).toISOString(); // 1 hour ago
      const oldTimestamp = new Date(now.getTime() - 1000 * 60 * 60 * 30).toISOString(); // 30 hours ago

      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.TASK_SELECTED, reason: 'A', timestamp: recentTimestamp },
        { id: 'dec-2', type: DECISION_TYPES.IDLE, reason: 'B', timestamp: recentTimestamp },
        { id: 'dec-3', type: DECISION_TYPES.TASK_SELECTED, reason: 'C', timestamp: oldTimestamp }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getDecisionSummary();

      expect(result.last24Hours.total).toBe(2);
    });

    it('should count collapsed decisions correctly', async () => {
      const now = new Date();
      const recentTimestamp = now.toISOString();

      const decisions = [
        {
          id: 'dec-1',
          type: DECISION_TYPES.IDLE,
          reason: 'No work',
          count: 10,
          timestamp: recentTimestamp,
          lastTimestamp: recentTimestamp
        }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getDecisionSummary();

      expect(result.last24Hours.total).toBe(10);
      expect(result.last24Hours.idle).toBe(10);
    });

    it('should identify impactful decisions', async () => {
      const now = new Date();
      const recentTimestamp = now.toISOString();

      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.TASK_SKIPPED, reason: 'Poor rate', timestamp: recentTimestamp, context: { taskType: 'test' } },
        { id: 'dec-2', type: DECISION_TYPES.CAPACITY_FULL, reason: 'Max agents', timestamp: recentTimestamp, context: {} },
        { id: 'dec-3', type: DECISION_TYPES.IDLE, reason: 'No work', timestamp: recentTimestamp }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getDecisionSummary();

      expect(result.impactfulDecisions).toHaveLength(2);
      expect(result.hasImpactfulDecisions).toBe(true);
    });

    it('should calculate transparency score', async () => {
      const now = new Date();
      const recentTimestamp = now.toISOString();

      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.IDLE, reason: 'Has reason', timestamp: recentTimestamp },
        { id: 'dec-2', type: DECISION_TYPES.IDLE, reason: '', timestamp: recentTimestamp },
        { id: 'dec-3', type: DECISION_TYPES.IDLE, reason: 'Has reason too', timestamp: recentTimestamp }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getDecisionSummary();

      // 2 out of 3 have reasons = 67%
      expect(result.transparencyScore).toBe(67);
    });

    it('should return 100 transparency when no decisions', async () => {
      readJSONFile.mockResolvedValue(makeDecisionData());

      const result = await getDecisionSummary();

      expect(result.transparencyScore).toBe(100);
    });
  });
});
