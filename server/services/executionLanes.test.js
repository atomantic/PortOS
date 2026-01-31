import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LANES,
  determineLane,
  hasCapacity,
  getLaneStatus,
  acquire,
  release,
  waitForLane,
  promote,
  getStats,
  getAgentLane,
  clearLane,
  updateLaneConfig
} from './executionLanes.js';

// Mock the cosEvents
vi.mock('./cos.js', () => ({
  cosEvents: {
    emit: vi.fn()
  }
}));

describe('Execution Lanes Service', () => {
  beforeEach(() => {
    // Clear all lanes before each test
    clearLane('critical');
    clearLane('standard');
    clearLane('background');
  });

  describe('LANES', () => {
    it('should have all required lanes', () => {
      expect(LANES.critical).toBeDefined();
      expect(LANES.standard).toBeDefined();
      expect(LANES.background).toBeDefined();
    });

    it('should have correct max concurrent values', () => {
      expect(LANES.critical.maxConcurrent).toBe(1);
      expect(LANES.standard.maxConcurrent).toBe(2);
      expect(LANES.background.maxConcurrent).toBe(3);
    });

    it('should have priority ordering', () => {
      expect(LANES.critical.priority).toBeLessThan(LANES.standard.priority);
      expect(LANES.standard.priority).toBeLessThan(LANES.background.priority);
    });
  });

  describe('determineLane', () => {
    it('should return lane name when given string', () => {
      expect(determineLane('critical')).toBe('critical');
      expect(determineLane('standard')).toBe('standard');
      expect(determineLane('background')).toBe('background');
    });

    it('should default to standard for invalid lane name', () => {
      expect(determineLane('invalid')).toBe('standard');
    });

    it('should determine critical for URGENT/CRITICAL priority', () => {
      expect(determineLane({ priority: 'URGENT' })).toBe('critical');
      expect(determineLane({ priority: 'CRITICAL' })).toBe('critical');
    });

    it('should determine standard for HIGH/MEDIUM priority', () => {
      expect(determineLane({ priority: 'HIGH' })).toBe('standard');
      expect(determineLane({ priority: 'MEDIUM' })).toBe('standard');
    });

    it('should determine background for LOW/IDLE priority', () => {
      expect(determineLane({ priority: 'LOW' })).toBe('background');
      expect(determineLane({ priority: 'IDLE' })).toBe('background');
    });

    it('should use isUserTask for default priority', () => {
      expect(determineLane({ metadata: { isUserTask: true } })).toBe('standard');
      expect(determineLane({ metadata: { isUserTask: false } })).toBe('background');
      expect(determineLane({})).toBe('background');
    });
  });

  describe('hasCapacity', () => {
    it('should return true for empty lanes', () => {
      expect(hasCapacity('critical')).toBe(true);
      expect(hasCapacity('standard')).toBe(true);
      expect(hasCapacity('background')).toBe(true);
    });

    it('should return false for unknown lane', () => {
      expect(hasCapacity('unknown')).toBe(false);
    });

    it('should return false when lane is at capacity', () => {
      acquire('critical', 'agent-1');
      expect(hasCapacity('critical')).toBe(false);
    });

    it('should return true when lane has capacity', () => {
      acquire('standard', 'agent-1');
      expect(hasCapacity('standard')).toBe(true); // Can hold 2
    });
  });

  describe('getLaneStatus', () => {
    it('should return lane status', () => {
      const status = getLaneStatus('standard');

      expect(status.name).toBe('standard');
      expect(status.maxConcurrent).toBe(2);
      expect(status.currentOccupancy).toBe(0);
      expect(status.available).toBe(2);
    });

    it('should return null for unknown lane', () => {
      expect(getLaneStatus('unknown')).toBeNull();
    });

    it('should include occupant details', () => {
      acquire('standard', 'agent-1', { taskId: 'task-1' });
      const status = getLaneStatus('standard');

      expect(status.occupants.length).toBe(1);
      expect(status.occupants[0].agentId).toBe('agent-1');
      expect(status.occupants[0].taskId).toBe('task-1');
    });
  });

  describe('acquire', () => {
    it('should acquire a lane slot', () => {
      const result = acquire('standard', 'agent-1', { taskId: 'task-1' });

      expect(result.success).toBe(true);
      expect(result.lane).toBe('standard');
    });

    it('should fail for unknown lane', () => {
      const result = acquire('unknown', 'agent-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown lane');
    });

    it('should fail when lane is at capacity', () => {
      acquire('critical', 'agent-1');
      const result = acquire('critical', 'agent-2');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Lane at capacity');
    });

    it('should return success if already acquired', () => {
      acquire('standard', 'agent-1');
      const result = acquire('standard', 'agent-1');

      expect(result.success).toBe(true);
      expect(result.alreadyAcquired).toBe(true);
    });
  });

  describe('release', () => {
    it('should release a lane slot', () => {
      acquire('standard', 'agent-1');
      const result = release('agent-1');

      expect(result.success).toBe(true);
      expect(result.lane).toBe('standard');
      expect(result.runningMs).toBeGreaterThanOrEqual(0);
    });

    it('should fail for agent not in any lane', () => {
      const result = release('nonexistent-agent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not in any lane');
    });

    it('should free up capacity', () => {
      acquire('critical', 'agent-1');
      expect(hasCapacity('critical')).toBe(false);

      release('agent-1');
      expect(hasCapacity('critical')).toBe(true);
    });
  });

  describe('waitForLane', () => {
    it('should acquire immediately if capacity available', async () => {
      const result = await waitForLane('standard', 'agent-1', {
        metadata: { taskId: 'task-1' }
      });

      expect(result.success).toBe(true);
    });

    it('should timeout when lane stays at capacity', async () => {
      acquire('critical', 'agent-1');

      const result = await waitForLane('critical', 'agent-2', {
        timeoutMs: 100
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Lane wait timeout');
    });

    it('should acquire when slot becomes available', async () => {
      acquire('critical', 'agent-1');

      // Start waiting
      const waitPromise = waitForLane('critical', 'agent-2', {
        timeoutMs: 1000
      });

      // Release after short delay
      setTimeout(() => release('agent-1'), 50);

      const result = await waitPromise;
      expect(result.success).toBe(true);
      expect(result.waitedMs).toBeGreaterThan(0);
    });
  });

  describe('promote', () => {
    it('should promote agent to higher priority lane', () => {
      acquire('background', 'agent-1', { taskId: 'task-1' });
      const result = promote('agent-1', 'standard');

      expect(result.success).toBe(true);
      expect(result.fromLane).toBe('background');
      expect(result.toLane).toBe('standard');
    });

    it('should fail for unknown target lane', () => {
      acquire('standard', 'agent-1');
      const result = promote('agent-1', 'unknown');

      expect(result.success).toBe(false);
    });

    it('should fail if agent not in any lane', () => {
      const result = promote('nonexistent', 'critical');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not in any lane');
    });

    it('should fail if target is lower priority', () => {
      acquire('critical', 'agent-1');
      const result = promote('agent-1', 'background');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Target lane is not higher priority');
    });

    it('should fail if target lane at capacity', () => {
      acquire('critical', 'agent-1');
      acquire('standard', 'agent-2');
      const result = promote('agent-2', 'critical');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Target lane at capacity');
    });
  });

  describe('getStats', () => {
    it('should return overall statistics', () => {
      acquire('standard', 'agent-1');
      acquire('background', 'agent-2');

      const stats = getStats();

      expect(stats.totalOccupancy).toBe(2);
      expect(stats.totalCapacity).toBe(6); // 1 + 2 + 3
      expect(stats.lanes.standard.currentOccupancy).toBe(1);
      expect(stats.lanes.background.currentOccupancy).toBe(1);
    });

    it('should track acquired/released counts', () => {
      acquire('standard', 'agent-1');
      release('agent-1');

      const stats = getStats();
      expect(stats.acquired).toBeGreaterThan(0);
      expect(stats.released).toBeGreaterThan(0);
    });
  });

  describe('getAgentLane', () => {
    it('should return lane for agent', () => {
      acquire('standard', 'agent-1');
      expect(getAgentLane('agent-1')).toBe('standard');
    });

    it('should return null for unknown agent', () => {
      expect(getAgentLane('nonexistent')).toBeNull();
    });
  });

  describe('clearLane', () => {
    it('should clear all agents from lane', () => {
      acquire('standard', 'agent-1');
      acquire('standard', 'agent-2');

      const count = clearLane('standard');

      expect(count).toBe(2);
      expect(hasCapacity('standard')).toBe(true);
      expect(getLaneStatus('standard').currentOccupancy).toBe(0);
    });

    it('should return 0 for unknown lane', () => {
      expect(clearLane('unknown')).toBe(0);
    });
  });

  describe('updateLaneConfig', () => {
    it('should update lane max concurrent', () => {
      const originalMax = LANES.standard.maxConcurrent;
      updateLaneConfig('standard', { maxConcurrent: 5 });

      expect(LANES.standard.maxConcurrent).toBe(5);

      // Restore
      updateLaneConfig('standard', { maxConcurrent: originalMax });
    });

    it('should return null for unknown lane', () => {
      expect(updateLaneConfig('unknown', {})).toBeNull();
    });
  });
});
