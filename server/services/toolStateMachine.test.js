import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STATES,
  TRANSITIONS,
  createToolExecution,
  transitionState,
  startExecution,
  updateExecution,
  completeExecution,
  errorExecution,
  recoverExecution,
  getExecution,
  getAgentExecutions,
  getExecutionHistory,
  getStats,
  cleanupStaleExecutions,
  wrapToolWithStateMachine
} from './toolStateMachine.js';

// Mock the cosEvents to prevent actual event emission
vi.mock('./cos.js', () => ({
  cosEvents: {
    emit: vi.fn()
  }
}));

describe('Tool State Machine', () => {
  describe('STATES', () => {
    it('should have all required states', () => {
      expect(STATES.IDLE).toBe('idle');
      expect(STATES.START).toBe('start');
      expect(STATES.RUNNING).toBe('running');
      expect(STATES.UPDATE).toBe('update');
      expect(STATES.END).toBe('end');
      expect(STATES.ERROR).toBe('error');
      expect(STATES.RECOVERED).toBe('recovered');
    });
  });

  describe('TRANSITIONS', () => {
    it('should define valid transitions from IDLE', () => {
      expect(TRANSITIONS[STATES.IDLE]).toContain(STATES.START);
    });

    it('should define valid transitions from START', () => {
      expect(TRANSITIONS[STATES.START]).toContain(STATES.RUNNING);
      expect(TRANSITIONS[STATES.START]).toContain(STATES.ERROR);
    });

    it('should define valid transitions from RUNNING', () => {
      expect(TRANSITIONS[STATES.RUNNING]).toContain(STATES.UPDATE);
      expect(TRANSITIONS[STATES.RUNNING]).toContain(STATES.END);
      expect(TRANSITIONS[STATES.RUNNING]).toContain(STATES.ERROR);
    });

    it('should have no transitions from END (terminal state)', () => {
      expect(TRANSITIONS[STATES.END]).toEqual([]);
    });

    it('should allow recovery from ERROR', () => {
      expect(TRANSITIONS[STATES.ERROR]).toContain(STATES.RECOVERED);
      expect(TRANSITIONS[STATES.ERROR]).toContain(STATES.END);
    });
  });

  describe('createToolExecution', () => {
    it('should create execution with correct initial state', () => {
      const execution = createToolExecution('tool-1', 'agent-1');

      expect(execution.toolId).toBe('tool-1');
      expect(execution.agentId).toBe('agent-1');
      expect(execution.state).toBe(STATES.IDLE);
      expect(execution.id).toBeDefined();
    });

    it('should include metadata when provided', () => {
      const metadata = { input: 'test input', custom: 'value' };
      const execution = createToolExecution('tool-1', 'agent-1', metadata);

      expect(execution.input).toBe('test input');
      expect(execution.metadata.custom).toBe('value');
    });

    it('should initialize state history', () => {
      const execution = createToolExecution('tool-1', 'agent-1');

      expect(execution.stateHistory).toBeDefined();
      expect(execution.stateHistory.length).toBe(1);
      expect(execution.stateHistory[0].state).toBe(STATES.IDLE);
    });
  });

  describe('transitionState', () => {
    it('should transition to valid next state', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      const result = transitionState(execution.id, STATES.START);

      expect(result).not.toBeNull();
      expect(result.state).toBe(STATES.START);
    });

    it('should reject invalid transitions', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      // IDLE cannot go directly to END
      const result = transitionState(execution.id, STATES.END);

      expect(result).toBeNull();
    });

    it('should update state history', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      transitionState(execution.id, STATES.START);

      const updated = getExecution(execution.id);
      expect(updated.stateHistory.length).toBe(2);
    });

    it('should return null for non-existent execution', () => {
      const result = transitionState('nonexistent', STATES.START);
      expect(result).toBeNull();
    });
  });

  describe('startExecution', () => {
    it('should transition through START to RUNNING', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      const result = startExecution(execution.id, { data: 'test' });

      expect(result).not.toBeNull();
      expect(result.state).toBe(STATES.RUNNING);
      expect(result.startedAt).toBeDefined();
    });

    it('should store input when provided', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      const result = startExecution(execution.id, { key: 'value' });

      expect(result.input).toEqual({ key: 'value' });
    });
  });

  describe('updateExecution', () => {
    it('should update progress during execution', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);
      const result = updateExecution(execution.id, { progress: 0.5 });

      expect(result.state).toBe(STATES.UPDATE);
      expect(result.progress).toBe(0.5);
    });

    it('should not update if not running', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      // Still in IDLE state
      const result = updateExecution(execution.id, { progress: 0.5 });

      expect(result.state).toBe(STATES.IDLE);
    });
  });

  describe('completeExecution', () => {
    it('should transition to END with output', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);
      const result = completeExecution(execution.id, { result: 'success' });

      expect(result.state).toBe(STATES.END);
      expect(result.output).toEqual({ result: 'success' });
      expect(result.completedAt).toBeDefined();
      expect(result.duration).toBeDefined();
    });

    it('should calculate duration', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);

      // Small delay to ensure measurable duration
      const result = completeExecution(execution.id, 'done');

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('errorExecution', () => {
    it('should transition to ERROR state', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);
      const result = errorExecution(execution.id, new Error('Test error'));

      expect(result.state).toBe(STATES.ERROR);
      expect(result.error.message).toBe('Test error');
    });

    it('should store error details', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);
      const error = { message: 'Custom error', code: 'ERR_TEST' };
      const result = errorExecution(execution.id, error);

      expect(result.error.code).toBe('ERR_TEST');
    });
  });

  describe('recoverExecution', () => {
    it('should recover from ERROR state', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);
      errorExecution(execution.id, new Error('Test'));
      const result = recoverExecution(execution.id, 'retry');

      expect(result).not.toBeNull();
      expect(result.recoveryAttempts).toBe(1);
    });

    it('should track recovery attempts', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);
      errorExecution(execution.id, new Error('Test'));
      recoverExecution(execution.id, 'retry');

      // Transition to running, then error again
      errorExecution(execution.id, new Error('Test 2'));
      const result = recoverExecution(execution.id, 'retry');

      expect(result.recoveryAttempts).toBe(2);
    });

    it('should fail after max recovery attempts', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);

      // Exhaust recovery attempts
      for (let i = 0; i < 3; i++) {
        errorExecution(execution.id, new Error('Test'));
        recoverExecution(execution.id, 'retry');
      }

      errorExecution(execution.id, new Error('Final'));
      const result = recoverExecution(execution.id, 'retry');

      expect(result).toBeNull();
    });

    it('should not recover from non-ERROR state', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      startExecution(execution.id);
      // Currently in RUNNING, not ERROR
      const result = recoverExecution(execution.id, 'retry');

      expect(result).toBeNull();
    });
  });

  describe('getExecution', () => {
    it('should return execution by id', () => {
      const execution = createToolExecution('tool-1', 'agent-1');
      const found = getExecution(execution.id);

      expect(found).not.toBeNull();
      expect(found.id).toBe(execution.id);
    });

    it('should return null for non-existent id', () => {
      const result = getExecution('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  describe('getAgentExecutions', () => {
    it('should return all executions for an agent', () => {
      createToolExecution('tool-1', 'agent-A');
      createToolExecution('tool-2', 'agent-A');
      createToolExecution('tool-3', 'agent-B');

      const agentAExecutions = getAgentExecutions('agent-A');
      expect(agentAExecutions.length).toBe(2);
    });

    it('should return empty array for unknown agent', () => {
      const result = getAgentExecutions('unknown-agent');
      expect(result).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return execution statistics', () => {
      const stats = getStats();

      expect(stats.activeExecutions).toBeDefined();
      expect(stats.byState).toBeDefined();
      expect(stats.historySize).toBeDefined();
      expect(stats.recentSuccessRate).toBeDefined();
      expect(stats.avgDurationMs).toBeDefined();
    });
  });

  describe('wrapToolWithStateMachine', () => {
    it('should wrap a function with state machine', async () => {
      const mockTool = vi.fn().mockResolvedValue('result');
      const wrapped = wrapToolWithStateMachine('test-tool', mockTool);

      const result = await wrapped('agent-1', 'input');

      expect(result.success).toBe(true);
      expect(result.output).toBe('result');
      expect(result.executionId).toBeDefined();
      expect(mockTool).toHaveBeenCalledWith('input');
    });

    it('should handle tool errors with retry', async () => {
      let callCount = 0;
      const mockTool = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 2) throw new Error('Retry me');
        return Promise.resolve('success after retry');
      });

      const wrapped = wrapToolWithStateMachine('test-tool', mockTool);
      const result = await wrapped('agent-1', 'input');

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
    });

    it('should return error after max retries', async () => {
      const mockTool = vi.fn().mockRejectedValue(new Error('Always fails'));
      const wrapped = wrapToolWithStateMachine('test-tool', mockTool);

      const result = await wrapped('agent-1', 'input');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Always fails');
    });
  });
});
