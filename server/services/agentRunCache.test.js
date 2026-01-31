import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  cacheOutput,
  getOutput,
  cacheToolResult,
  getToolResult,
  cacheContext,
  getContext,
  invalidateOutput,
  invalidateToolResult,
  invalidateContext,
  clearAll,
  cleanExpired,
  getStats,
  getOrComputeOutput,
  getOrComputeToolResult,
  resetStats,
  DEFAULT_TTL_MS
} from './agentRunCache.js';

describe('Agent Run Cache Service', () => {
  beforeEach(() => {
    clearAll();
    resetStats();
  });

  describe('DEFAULT_TTL_MS', () => {
    it('should be 10 minutes', () => {
      expect(DEFAULT_TTL_MS).toBe(10 * 60 * 1000);
    });
  });

  describe('cacheOutput / getOutput', () => {
    it('should cache and retrieve output', () => {
      const output = { result: 'test output' };
      cacheOutput('agent-1', output);

      const cached = getOutput('agent-1');
      expect(cached).toEqual(output);
    });

    it('should return null for non-existent key', () => {
      expect(getOutput('nonexistent')).toBeNull();
    });

    it('should track hits and misses', () => {
      cacheOutput('agent-1', 'output');
      getOutput('agent-1'); // hit
      getOutput('agent-2'); // miss

      const stats = getStats();
      expect(stats.outputs.hits).toBe(1);
      expect(stats.outputs.misses).toBe(1);
    });

    it('should expire after TTL', async () => {
      cacheOutput('agent-1', 'output', { ttlMs: 50 });

      expect(getOutput('agent-1')).toBe('output');

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(getOutput('agent-1')).toBeNull();
    });
  });

  describe('cacheToolResult / getToolResult', () => {
    it('should cache and retrieve tool results', () => {
      const result = { data: [1, 2, 3] };
      cacheToolResult('tool-1', { input: 'test' }, result);

      const cached = getToolResult('tool-1', { input: 'test' });
      expect(cached).toEqual(result);
    });

    it('should differentiate based on params', () => {
      cacheToolResult('tool-1', { a: 1 }, 'result-a');
      cacheToolResult('tool-1', { b: 2 }, 'result-b');

      expect(getToolResult('tool-1', { a: 1 })).toBe('result-a');
      expect(getToolResult('tool-1', { b: 2 })).toBe('result-b');
    });

    it('should handle same params in different order', () => {
      cacheToolResult('tool-1', { a: 1, b: 2 }, 'result');

      // Same params but different order
      const cached = getToolResult('tool-1', { b: 2, a: 1 });
      expect(cached).toBe('result');
    });

    it('should return null for non-existent key', () => {
      expect(getToolResult('tool-1', { unknown: true })).toBeNull();
    });

    it('should track hits and misses', () => {
      cacheToolResult('tool-1', { x: 1 }, 'result');
      getToolResult('tool-1', { x: 1 }); // hit
      getToolResult('tool-1', { x: 2 }); // miss

      const stats = getStats();
      expect(stats.toolResults.hits).toBe(1);
      expect(stats.toolResults.misses).toBe(1);
    });
  });

  describe('cacheContext / getContext', () => {
    it('should cache and retrieve context', () => {
      cacheContext('task-1', 'Relevant memory context');

      const cached = getContext('task-1');
      expect(cached).toBe('Relevant memory context');
    });

    it('should return null for non-existent key', () => {
      expect(getContext('nonexistent')).toBeNull();
    });

    it('should track hits and misses', () => {
      cacheContext('task-1', 'context');
      getContext('task-1'); // hit
      getContext('task-2'); // miss

      const stats = getStats();
      expect(stats.contexts.hits).toBe(1);
      expect(stats.contexts.misses).toBe(1);
    });
  });

  describe('invalidateOutput', () => {
    it('should remove cached output', () => {
      cacheOutput('agent-1', 'output');
      expect(getOutput('agent-1')).toBe('output');

      invalidateOutput('agent-1');
      expect(getOutput('agent-1')).toBeNull();
    });

    it('should return true when entry existed', () => {
      cacheOutput('agent-1', 'output');
      expect(invalidateOutput('agent-1')).toBe(true);
    });

    it('should return false when entry did not exist', () => {
      expect(invalidateOutput('nonexistent')).toBe(false);
    });
  });

  describe('invalidateToolResult', () => {
    it('should remove specific cached tool result', () => {
      cacheToolResult('tool-1', { a: 1 }, 'result-a');
      cacheToolResult('tool-1', { b: 2 }, 'result-b');

      invalidateToolResult('tool-1', { a: 1 });

      expect(getToolResult('tool-1', { a: 1 })).toBeNull();
      expect(getToolResult('tool-1', { b: 2 })).toBe('result-b');
    });

    it('should remove all results for tool when params is null', () => {
      cacheToolResult('tool-1', { a: 1 }, 'result-a');
      cacheToolResult('tool-1', { b: 2 }, 'result-b');
      cacheToolResult('tool-2', { c: 3 }, 'result-c');

      const count = invalidateToolResult('tool-1', null);

      expect(count).toBe(2);
      expect(getToolResult('tool-1', { a: 1 })).toBeNull();
      expect(getToolResult('tool-1', { b: 2 })).toBeNull();
      expect(getToolResult('tool-2', { c: 3 })).toBe('result-c');
    });

    it('should return count of entries invalidated', () => {
      cacheToolResult('tool-1', { a: 1 }, 'result');
      expect(invalidateToolResult('tool-1', { a: 1 })).toBe(1);
      expect(invalidateToolResult('tool-1', { unknown: true })).toBe(0);
    });
  });

  describe('invalidateContext', () => {
    it('should remove cached context', () => {
      cacheContext('task-1', 'context');
      expect(getContext('task-1')).toBe('context');

      invalidateContext('task-1');
      expect(getContext('task-1')).toBeNull();
    });
  });

  describe('clearAll', () => {
    it('should clear all caches', () => {
      cacheOutput('agent-1', 'output');
      cacheToolResult('tool-1', { x: 1 }, 'result');
      cacheContext('task-1', 'context');

      const counts = clearAll();

      expect(counts.outputs).toBe(1);
      expect(counts.toolResults).toBe(1);
      expect(counts.contexts).toBe(1);

      expect(getOutput('agent-1')).toBeNull();
      expect(getToolResult('tool-1', { x: 1 })).toBeNull();
      expect(getContext('task-1')).toBeNull();
    });
  });

  describe('cleanExpired', () => {
    it('should remove expired entries', async () => {
      cacheOutput('agent-1', 'output', { ttlMs: 50 });
      cacheOutput('agent-2', 'output', { ttlMs: 5000 });

      await new Promise(resolve => setTimeout(resolve, 60));

      const cleaned = cleanExpired();

      expect(cleaned).toBe(1);
      expect(getOutput('agent-1')).toBeNull();
      expect(getOutput('agent-2')).toBe('output');
    });
  });

  describe('getStats', () => {
    it('should return cache statistics', () => {
      cacheOutput('agent-1', 'output');
      cacheToolResult('tool-1', {}, 'result');
      cacheContext('task-1', 'context');

      getOutput('agent-1');
      getToolResult('tool-1', {});
      getContext('task-1');

      const stats = getStats();

      expect(stats.outputs.size).toBe(1);
      expect(stats.outputs.hits).toBe(1);
      expect(stats.toolResults.size).toBe(1);
      expect(stats.toolResults.hits).toBe(1);
      expect(stats.contexts.size).toBe(1);
      expect(stats.contexts.hits).toBe(1);
      expect(stats.totalSize).toBe(3);
    });

    it('should calculate hit rates', () => {
      cacheOutput('agent-1', 'output');
      getOutput('agent-1'); // hit
      getOutput('agent-2'); // miss

      const stats = getStats();
      expect(stats.outputs.hitRate).toBe('50.0%');
    });

    it('should handle zero hits/misses', () => {
      const stats = getStats();
      expect(stats.outputs.hitRate).toBe('0%');
    });
  });

  describe('getOrComputeOutput', () => {
    it('should return cached value if available', async () => {
      cacheOutput('agent-1', 'cached-output');
      const computeFn = vi.fn(() => 'computed-output');

      const result = await getOrComputeOutput('agent-1', computeFn);

      expect(result.value).toBe('cached-output');
      expect(result.fromCache).toBe(true);
      expect(computeFn).not.toHaveBeenCalled();
    });

    it('should compute and cache if not available', async () => {
      const computeFn = vi.fn(() => 'computed-output');

      const result = await getOrComputeOutput('agent-new', computeFn);

      expect(result.value).toBe('computed-output');
      expect(result.fromCache).toBe(false);
      expect(computeFn).toHaveBeenCalledOnce();

      // Verify it was cached
      expect(getOutput('agent-new')).toBe('computed-output');
    });

    it('should handle async compute function', async () => {
      const computeFn = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'async-result';
      });

      const result = await getOrComputeOutput('agent-async', computeFn);

      expect(result.value).toBe('async-result');
      expect(result.fromCache).toBe(false);
    });
  });

  describe('getOrComputeToolResult', () => {
    it('should return cached value if available', async () => {
      cacheToolResult('tool-1', { x: 1 }, 'cached-result');
      const computeFn = vi.fn(() => 'computed-result');

      const result = await getOrComputeToolResult('tool-1', { x: 1 }, computeFn);

      expect(result.value).toBe('cached-result');
      expect(result.fromCache).toBe(true);
      expect(computeFn).not.toHaveBeenCalled();
    });

    it('should compute and cache if not available', async () => {
      const computeFn = vi.fn(() => 'computed-result');

      const result = await getOrComputeToolResult('tool-new', { x: 1 }, computeFn);

      expect(result.value).toBe('computed-result');
      expect(result.fromCache).toBe(false);
      expect(computeFn).toHaveBeenCalledOnce();

      // Verify it was cached
      expect(getToolResult('tool-new', { x: 1 })).toBe('computed-result');
    });
  });

  describe('resetStats', () => {
    it('should reset all statistics', () => {
      cacheOutput('agent-1', 'output');
      getOutput('agent-1');
      getOutput('nonexistent');

      resetStats();

      const stats = getStats();
      expect(stats.outputs.hits).toBe(0);
      expect(stats.outputs.misses).toBe(0);
      expect(stats.totalEvictions).toBe(0);
    });
  });
});
