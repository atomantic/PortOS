import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock dependencies before importing the module
vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn(), on: vi.fn() }
}));

vi.mock('../lib/fileUtils.js', () => ({
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
  let cosEvents;
  let recordDecision;
  let getRecentDecisions;
  let getDecisionSummary;
  let getDecisionPatterns;
  let cleanupOldDecisions;
  let DECISION_TYPES;

  beforeAll(async () => {
    // Import mocks after they're set up
    const fsPromises = await import('fs/promises');
    writeFile = fsPromises.writeFile;
    const fileUtils = await import('../lib/fileUtils.js');
    readJSONFile = fileUtils.readJSONFile;
    const cosEventsModule = await import('./cosEvents.js');
    cosEvents = cosEventsModule.cosEvents;
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
    vi.doMock('./cosEvents.js', () => ({
      cosEvents: { emit: vi.fn(), on: vi.fn() }
    }));
    vi.doMock('../lib/fileUtils.js', () => ({
      readJSONFile: vi.fn()
    }));

    // Re-import fresh module instances
    const fsPromises = await import('fs/promises');
    writeFile = fsPromises.writeFile;
    const fileUtils = await import('../lib/fileUtils.js');
    readJSONFile = fileUtils.readJSONFile;
    const cosEventsModule = await import('./cosEvents.js');
    cosEvents = cosEventsModule.cosEvents;
    const decisionLogModule = await import('./decisionLog.js');
    recordDecision = decisionLogModule.recordDecision;
    getRecentDecisions = decisionLogModule.getRecentDecisions;
    getDecisionSummary = decisionLogModule.getDecisionSummary;
    getDecisionPatterns = decisionLogModule.getDecisionPatterns;
    cleanupOldDecisions = decisionLogModule.cleanupOldDecisions;
    DECISION_TYPES = decisionLogModule.DECISION_TYPES;

    savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
    });
  });

  describe('DECISION_TYPES', () => {
    it('should define all decision types', () => {
      expect(DECISION_TYPES.TASK_SKIPPED).toBe('task_skipped');
      expect(DECISION_TYPES.TASK_SWITCHED).toBe('task_switched');
      expect(DECISION_TYPES.INTERVAL_ADJUSTED).toBe('interval_adjusted');
      expect(DECISION_TYPES.COOLDOWN_ACTIVE).toBe('cooldown_active');
      expect(DECISION_TYPES.NOT_DUE).toBe('not_due');
      expect(DECISION_TYPES.QUEUE_FULL).toBe('queue_full');
      expect(DECISION_TYPES.CAPACITY_FULL).toBe('capacity_full');
      expect(DECISION_TYPES.TASK_SELECTED).toBe('task_selected');
      expect(DECISION_TYPES.REHABILITATION).toBe('rehabilitation');
      expect(DECISION_TYPES.IDLE).toBe('idle');
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

    it('should update stats', async () => {
      readJSONFile.mockResolvedValue(makeDecisionData());

      await recordDecision(DECISION_TYPES.TASK_SKIPPED, 'Poor success rate', {});

      expect(savedData.stats.totalDecisions).toBe(1);
      expect(savedData.stats.byType[DECISION_TYPES.TASK_SKIPPED]).toBe(1);
    });

    it('should emit decision event', async () => {
      readJSONFile.mockResolvedValue(makeDecisionData());

      await recordDecision(DECISION_TYPES.TASK_SELECTED, 'Test', {});

      expect(cosEvents.emit).toHaveBeenCalledWith('decision', expect.objectContaining({
        type: DECISION_TYPES.TASK_SELECTED,
        reason: 'Test'
      }));
    });
  });

  describe('getRecentDecisions', () => {
    it('should return decisions up to limit', async () => {
      const decisions = Array(50).fill(null).map((_, i) => ({
        id: `dec-${i}`,
        type: DECISION_TYPES.IDLE,
        reason: `Decision ${i}`,
        timestamp: '2026-01-25T10:00:00.000Z'
      }));
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getRecentDecisions(10);

      expect(result).toHaveLength(10);
    });

    it('should filter by type', async () => {
      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.TASK_SELECTED, reason: 'A', timestamp: '2026-01-25T10:00:00.000Z' },
        { id: 'dec-2', type: DECISION_TYPES.IDLE, reason: 'B', timestamp: '2026-01-25T10:00:00.000Z' },
        { id: 'dec-3', type: DECISION_TYPES.TASK_SELECTED, reason: 'C', timestamp: '2026-01-25T10:00:00.000Z' }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getRecentDecisions(20, DECISION_TYPES.TASK_SELECTED);

      expect(result).toHaveLength(2);
      expect(result.every(d => d.type === DECISION_TYPES.TASK_SELECTED)).toBe(true);
    });

    it('should use default limit of 20', async () => {
      const decisions = Array(30).fill(null).map((_, i) => ({
        id: `dec-${i}`,
        type: DECISION_TYPES.IDLE,
        reason: `Decision ${i}`,
        timestamp: '2026-01-25T10:00:00.000Z'
      }));
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getRecentDecisions();

      expect(result).toHaveLength(20);
    });
  });

  describe('getDecisionSummary', () => {
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

  describe('getDecisionPatterns', () => {
    it('should identify frequently skipped task types', async () => {
      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.TASK_SKIPPED, reason: 'A', context: { taskType: 'self-improve:ui' }, timestamp: '2026-01-25T10:00:00.000Z' },
        { id: 'dec-2', type: DECISION_TYPES.TASK_SKIPPED, reason: 'B', context: { taskType: 'self-improve:ui' }, timestamp: '2026-01-25T10:00:00.000Z' },
        { id: 'dec-3', type: DECISION_TYPES.TASK_SKIPPED, reason: 'C', context: { taskType: 'user-task' }, timestamp: '2026-01-25T10:00:00.000Z' }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getDecisionPatterns();

      expect(result.frequentlySkipped[0].taskType).toBe('self-improve:ui');
      expect(result.frequentlySkipped[0].count).toBe(2);
      expect(result.totalSkips).toBe(3);
    });

    it('should track switched tasks', async () => {
      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.TASK_SWITCHED, reason: 'A', context: { fromTask: 'task-a' }, timestamp: '2026-01-25T10:00:00.000Z' },
        { id: 'dec-2', type: DECISION_TYPES.TASK_SWITCHED, reason: 'B', context: { fromTask: 'task-a' }, timestamp: '2026-01-25T10:00:00.000Z' }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await getDecisionPatterns();

      expect(result.totalSwitches).toBe(2);
    });

    it('should return empty patterns when no data', async () => {
      readJSONFile.mockResolvedValue(makeDecisionData());

      const result = await getDecisionPatterns();

      expect(result.frequentlySkipped).toHaveLength(0);
      expect(result.totalSkips).toBe(0);
      expect(result.totalSwitches).toBe(0);
    });
  });

  describe('cleanupOldDecisions', () => {
    it('should remove decisions older than specified days', async () => {
      const now = Date.now();
      const recentTimestamp = new Date(now - 1000 * 60 * 60 * 24).toISOString(); // 1 day ago
      const oldTimestamp = new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(); // 10 days ago

      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.IDLE, reason: 'Recent', timestamp: recentTimestamp },
        { id: 'dec-2', type: DECISION_TYPES.IDLE, reason: 'Old', timestamp: oldTimestamp }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await cleanupOldDecisions(7);

      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(1);
      expect(savedData.decisions).toHaveLength(1);
      expect(savedData.decisions[0].reason).toBe('Recent');
    });

    it('should not save when nothing to remove', async () => {
      const now = Date.now();
      const recentTimestamp = new Date(now - 1000 * 60 * 60).toISOString(); // 1 hour ago

      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.IDLE, reason: 'Recent', timestamp: recentTimestamp }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await cleanupOldDecisions(7);

      expect(result.removed).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should use default of 7 days', async () => {
      const now = Date.now();
      const recentTimestamp = new Date(now - 1000 * 60 * 60 * 24 * 5).toISOString(); // 5 days ago
      const oldTimestamp = new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(); // 10 days ago

      const decisions = [
        { id: 'dec-1', type: DECISION_TYPES.IDLE, reason: 'Recent', timestamp: recentTimestamp },
        { id: 'dec-2', type: DECISION_TYPES.IDLE, reason: 'Old', timestamp: oldTimestamp }
      ];
      readJSONFile.mockResolvedValue(makeDecisionData({ decisions }));

      const result = await cleanupOldDecisions();

      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(1);
    });
  });
});
