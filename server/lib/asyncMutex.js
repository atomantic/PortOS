/**
 * Creates a simple async mutex (promise-based lock).
 * Returns a `withLock(fn)` function that serializes async operations.
 * Uses try/finally to guarantee the lock is always released, even on error.
 */
export function createMutex() {
  let lock = Promise.resolve();
  return async function withLock(fn) {
    const release = lock;
    let resolve;
    lock = new Promise(r => { resolve = r; });
    await release;
    try {
      return await fn();
    } finally {
      resolve();
    }
  };
}
