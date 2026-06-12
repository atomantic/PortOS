import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMutex } from './asyncMutex.js';

describe('asyncMutex.js', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createMutex', () => {
    it('serializes concurrent operations — deterministic with fake timers', async () => {
      vi.useFakeTimers();
      const withLock = createMutex();
      const results = [];

      // First op awaits a 20ms delay before pushing.
      const p1 = withLock(async () => {
        await vi.advanceTimersByTimeAsync(20);
        results.push('first');
        return 'first';
      });

      // p2 and p3 are already queued behind p1.
      const p2 = withLock(async () => {
        results.push('second');
        return 'second';
      });

      const p3 = withLock(async () => {
        results.push('third');
        return 'third';
      });

      await Promise.all([p1, p2, p3]);

      // Operations must complete in order despite p1 being slower.
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

    it('serializes rapid sequential calls — counter reaches 10 without races', async () => {
      const withLock = createMutex();
      let counter = 0;

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(withLock(async () => {
          const current = counter;
          // Microtask yield — gives the event loop a chance to interleave.
          // Without serialization, concurrent readers would see the same
          // `current` and the final counter would be less than 10.
          await Promise.resolve();
          counter = current + 1;
        }));
      }

      await Promise.all(promises);

      expect(counter).toBe(10);
    });

    it('creates independent mutexes — separate queues run concurrently', async () => {
      vi.useFakeTimers();
      const withLock1 = createMutex();
      const withLock2 = createMutex();
      const results = [];

      // lock1's single op awaits a 20ms delay, lock2's op is instant.
      // Because the mutexes are independent, lock2 must finish first.
      const p1 = withLock1(async () => {
        await vi.advanceTimersByTimeAsync(20);
        results.push('lock1');
      });

      const p2 = withLock2(async () => {
        results.push('lock2');
      });

      await Promise.all([p1, p2]);

      // lock2 finishes first — independent queues don't block each other.
      expect(results[0]).toBe('lock2');
      expect(results[1]).toBe('lock1');
    });
  });
});
