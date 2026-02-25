import { describe, it, expect } from 'vitest';
import { createMutex } from './asyncMutex.js';

describe('asyncMutex.js', () => {
  describe('createMutex', () => {
    it('should serialize concurrent operations', async () => {
      const withLock = createMutex();
      const results = [];

      // Start multiple operations concurrently
      const p1 = withLock(async () => {
        await new Promise(r => setTimeout(r, 20));
        results.push('first');
        return 'first';
      });

      const p2 = withLock(async () => {
        results.push('second');
        return 'second';
      });

      const p3 = withLock(async () => {
        results.push('third');
        return 'third';
      });

      await Promise.all([p1, p2, p3]);

      // Operations should complete in order despite first one being slow
      expect(results).toEqual(['first', 'second', 'third']);
    });

    it('should return the result of the wrapped function', async () => {
      const withLock = createMutex();

      const result = await withLock(async () => {
        return { value: 42, message: 'success' };
      });

      expect(result).toEqual({ value: 42, message: 'success' });
    });

    it('should propagate errors from the wrapped function', async () => {
      const withLock = createMutex();

      await expect(
        withLock(async () => {
          throw new Error('test error');
        })
      ).rejects.toThrow('test error');
    });

    it('should release lock even when function throws', async () => {
      const withLock = createMutex();
      const results = [];

      // First operation throws
      await withLock(async () => {
        throw new Error('first fails');
      }).catch(() => {
        results.push('first caught');
      });

      // Second operation should still run
      await withLock(async () => {
        results.push('second succeeds');
      });

      expect(results).toEqual(['first caught', 'second succeeds']);
    });

    it('should allow synchronous functions', async () => {
      const withLock = createMutex();

      const result = await withLock(() => 'sync result');

      expect(result).toBe('sync result');
    });

    it('should handle rapid sequential calls', async () => {
      const withLock = createMutex();
      let counter = 0;

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(withLock(async () => {
          const current = counter;
          await new Promise(r => setTimeout(r, 1));
          counter = current + 1;
        }));
      }

      await Promise.all(promises);

      // Without serialization, counter would likely be less than 10
      // due to race conditions
      expect(counter).toBe(10);
    });

    it('should create independent mutexes', async () => {
      const withLock1 = createMutex();
      const withLock2 = createMutex();
      const results = [];

      // Both locks should run concurrently
      const p1 = withLock1(async () => {
        await new Promise(r => setTimeout(r, 20));
        results.push('lock1');
      });

      const p2 = withLock2(async () => {
        results.push('lock2');
      });

      await Promise.all([p1, p2]);

      // lock2 should finish first since locks are independent
      expect(results[0]).toBe('lock2');
      expect(results[1]).toBe('lock1');
    });
  });
});
