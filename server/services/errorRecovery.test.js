import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STRATEGIES,
  ERROR_PATTERNS,
  analyzeError,
  selectRecoveryStrategy,
  executeRecovery,
  recordAttempt,
  getAttemptCount,
  getStats,
  getHistory,
  resetAttempts,
  clearAllAttempts
} from './errorRecovery.js';

// Mock the cosEvents
vi.mock('./cos.js', () => ({
  cosEvents: {
    emit: vi.fn()
  }
}));

describe('Error Recovery Service', () => {
  beforeEach(() => {
    clearAllAttempts();
  });

  describe('STRATEGIES', () => {
    it('should have all required strategies', () => {
      expect(STRATEGIES.RETRY).toBe('retry');
      expect(STRATEGIES.ESCALATE).toBe('escalate');
      expect(STRATEGIES.FALLBACK).toBe('fallback');
      expect(STRATEGIES.DECOMPOSE).toBe('decompose');
      expect(STRATEGIES.DEFER).toBe('defer');
      expect(STRATEGIES.INVESTIGATE).toBe('investigate');
      expect(STRATEGIES.SKIP).toBe('skip');
      expect(STRATEGIES.MANUAL).toBe('manual');
    });
  });

  describe('ERROR_PATTERNS', () => {
    it('should have patterns for rate limiting', () => {
      expect(ERROR_PATTERNS.rateLimit).toBeDefined();
      expect(ERROR_PATTERNS.rateLimit.patterns.length).toBeGreaterThan(0);
    });

    it('should have patterns for auth errors', () => {
      expect(ERROR_PATTERNS.auth).toBeDefined();
      expect(ERROR_PATTERNS.auth.strategies).toContain(STRATEGIES.FALLBACK);
    });

    it('should have patterns for network errors', () => {
      expect(ERROR_PATTERNS.network).toBeDefined();
      expect(ERROR_PATTERNS.network.cooldownMs).toBe(5000);
    });
  });

  describe('analyzeError', () => {
    it('should categorize rate limit errors', () => {
      const result = analyzeError({ message: 'Rate limit exceeded' });

      expect(result.category).toBe('rateLimit');
      expect(result.suggestedStrategies).toContain(STRATEGIES.DEFER);
    });

    it('should categorize auth errors', () => {
      const result = analyzeError({ message: 'Unauthorized access' });

      expect(result.category).toBe('auth');
      expect(result.severity).toBe('high');
    });

    it('should categorize model unavailable errors', () => {
      const result = analyzeError({ message: 'Model not found', code: 503 });

      expect(result.category).toBe('modelUnavailable');
      expect(result.suggestedStrategies).toContain(STRATEGIES.FALLBACK);
    });

    it('should categorize context length errors', () => {
      const result = analyzeError({ message: 'Token limit exceeded' });

      expect(result.category).toBe('contextLength');
      expect(result.suggestedStrategies).toContain(STRATEGIES.DECOMPOSE);
    });

    it('should categorize network errors', () => {
      const result = analyzeError({ message: 'ECONNREFUSED' });

      expect(result.category).toBe('network');
      expect(result.suggestedStrategies).toContain(STRATEGIES.RETRY);
    });

    it('should return unknown for unrecognized errors', () => {
      const result = analyzeError({ message: 'Some random error' });

      expect(result.category).toBe('unknown');
      expect(result.suggestedStrategies).toContain(STRATEGIES.RETRY);
    });

    it('should include context when provided', () => {
      const result = analyzeError(
        { message: 'Error' },
        { taskId: 'task-1', agentId: 'agent-1' }
      );

      expect(result.context.taskId).toBe('task-1');
      expect(result.context.agentId).toBe('agent-1');
    });

    it('should truncate long error messages', () => {
      const longMessage = 'x'.repeat(1000);
      const result = analyzeError({ message: longMessage });

      expect(result.message.length).toBeLessThanOrEqual(500);
    });

    it('should mark manual strategies as not recoverable', () => {
      const result = analyzeError({ message: 'Unknown critical failure' });
      // Most errors should be recoverable by default
      expect(result.recoverable).toBe(true);
    });
  });

  describe('selectRecoveryStrategy', () => {
    it('should select first suggested strategy', () => {
      const analysis = {
        suggestedStrategies: [STRATEGIES.FALLBACK, STRATEGIES.DEFER],
        cooldownMs: 5000
      };

      const result = selectRecoveryStrategy(analysis);

      expect(result.strategy).toBe(STRATEGIES.FALLBACK);
    });

    it('should calculate backoff delay for retry', () => {
      const analysis = {
        suggestedStrategies: [STRATEGIES.RETRY],
        cooldownMs: 1000
      };

      const result = selectRecoveryStrategy(analysis);

      expect(result.params.delayMs).toBeDefined();
      expect(result.params.delayMs).toBeGreaterThanOrEqual(1000);
    });

    it('should increase delay for subsequent attempts', () => {
      const analysis = {
        suggestedStrategies: [STRATEGIES.RETRY],
        cooldownMs: 1000
      };

      recordAttempt('test-task');
      recordAttempt('test-task');

      const result = selectRecoveryStrategy(analysis, { taskId: 'test-task' });

      // Delay should be exponentially higher
      expect(result.params.delayMs).toBeGreaterThan(1000);
    });

    it('should return MANUAL when max attempts exceeded', () => {
      // Exhaust attempts
      for (let i = 0; i < 3; i++) {
        recordAttempt('exhausted-task');
      }

      const analysis = { suggestedStrategies: [STRATEGIES.RETRY] };
      const result = selectRecoveryStrategy(analysis, { taskId: 'exhausted-task' });

      expect(result.strategy).toBe(STRATEGIES.MANUAL);
      expect(result.reason).toContain('Maximum recovery attempts');
    });

    it('should set params for escalate strategy', () => {
      const analysis = { suggestedStrategies: [STRATEGIES.ESCALATE] };
      const result = selectRecoveryStrategy(analysis);

      expect(result.params.suggestHeavyModel).toBe(true);
    });

    it('should set params for decompose strategy', () => {
      const analysis = { suggestedStrategies: [STRATEGIES.DECOMPOSE] };
      const result = selectRecoveryStrategy(analysis);

      expect(result.params.suggestSmallerContext).toBe(true);
      expect(result.params.maxChunkSize).toBeDefined();
    });
  });

  describe('executeRecovery', () => {
    it('should execute retry strategy', async () => {
      const result = await executeRecovery(
        STRATEGIES.RETRY,
        { id: 'task-1' },
        { message: 'Error' },
        { delayMs: 10 }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('retry_now');
    });

    it('should execute defer strategy', async () => {
      const result = await executeRecovery(
        STRATEGIES.DEFER,
        { id: 'task-1' },
        { message: 'Error' },
        { delayMs: 1000 }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('reschedule');
      expect(result.rescheduleAfterMs).toBe(1000);
    });

    it('should execute fallback strategy', async () => {
      const result = await executeRecovery(
        STRATEGIES.FALLBACK,
        { id: 'task-1' },
        { message: 'Error' }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('use_fallback');
      expect(result.useFallback).toBe(true);
    });

    it('should execute escalate strategy', async () => {
      const result = await executeRecovery(
        STRATEGIES.ESCALATE,
        { id: 'task-1' },
        { message: 'Error' }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('escalate_model');
      expect(result.useHeavyModel).toBe(true);
    });

    it('should execute decompose strategy', async () => {
      const result = await executeRecovery(
        STRATEGIES.DECOMPOSE,
        { id: 'task-1' },
        { message: 'Error' },
        { maxChunkSize: 1000 }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('decompose_task');
      expect(result.maxChunkSize).toBe(1000);
    });

    it('should execute investigate strategy', async () => {
      const result = await executeRecovery(
        STRATEGIES.INVESTIGATE,
        { id: 'task-1' },
        { message: 'Weird error' }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('create_investigation');
      expect(result.createInvestigationTask).toBe(true);
    });

    it('should execute skip strategy', async () => {
      const result = await executeRecovery(
        STRATEGIES.SKIP,
        { id: 'task-1' },
        { message: 'Error' }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('skip_task');
      expect(result.skipped).toBe(true);
    });

    it('should execute manual strategy as unsuccessful', async () => {
      const result = await executeRecovery(
        STRATEGIES.MANUAL,
        { id: 'task-1' },
        { message: 'Error' }
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe('require_manual');
      expect(result.requiresManualIntervention).toBe(true);
    });

    it('should handle unknown strategy', async () => {
      const result = await executeRecovery(
        'unknown',
        { id: 'task-1' },
        { message: 'Error' }
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe('unknown_strategy');
    });
  });

  describe('recordAttempt', () => {
    it('should increment attempt count', () => {
      expect(getAttemptCount('test-key')).toBe(0);

      recordAttempt('test-key');
      expect(getAttemptCount('test-key')).toBe(1);

      recordAttempt('test-key');
      expect(getAttemptCount('test-key')).toBe(2);
    });

    it('should track different keys separately', () => {
      recordAttempt('key-1');
      recordAttempt('key-2');
      recordAttempt('key-2');

      expect(getAttemptCount('key-1')).toBe(1);
      expect(getAttemptCount('key-2')).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return recovery statistics', async () => {
      await executeRecovery(STRATEGIES.RETRY, { id: 'task-1' }, {}, { delayMs: 1 });
      await executeRecovery(STRATEGIES.FALLBACK, { id: 'task-2' }, {});

      const stats = getStats();

      expect(stats.totalAttempts).toBeGreaterThan(0);
      expect(stats.byStrategy[STRATEGIES.RETRY]).toBeDefined();
      expect(stats.successRate).toBeDefined();
    });
  });

  describe('getHistory', () => {
    it('should return recovery history', async () => {
      await executeRecovery(STRATEGIES.RETRY, { id: 'task-1' }, {}, { delayMs: 1 });

      const history = getHistory();

      expect(history.length).toBeGreaterThan(0);
      expect(history[0].strategy).toBe(STRATEGIES.RETRY);
    });

    it('should filter by strategy', async () => {
      await executeRecovery(STRATEGIES.RETRY, { id: 'task-1' }, {}, { delayMs: 1 });
      await executeRecovery(STRATEGIES.FALLBACK, { id: 'task-2' }, {});

      const retryOnly = getHistory({ strategy: STRATEGIES.RETRY });

      expect(retryOnly.every(r => r.strategy === STRATEGIES.RETRY)).toBe(true);
    });

    it('should respect limit', async () => {
      for (let i = 0; i < 5; i++) {
        await executeRecovery(STRATEGIES.RETRY, { id: `task-${i}` }, {}, { delayMs: 1 });
      }

      const limited = getHistory({ limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  describe('resetAttempts', () => {
    it('should reset attempt counter for specific key', () => {
      recordAttempt('test-key');
      recordAttempt('test-key');
      expect(getAttemptCount('test-key')).toBe(2);

      resetAttempts('test-key');
      expect(getAttemptCount('test-key')).toBe(0);
    });
  });

  describe('clearAllAttempts', () => {
    it('should clear all attempt counters', () => {
      recordAttempt('key-1');
      recordAttempt('key-2');

      clearAllAttempts();

      expect(getAttemptCount('key-1')).toBe(0);
      expect(getAttemptCount('key-2')).toBe(0);
    });
  });
});
