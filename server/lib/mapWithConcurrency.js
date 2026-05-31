/**
 * Map items with a bounded number of in-flight async operations while
 * preserving input order in the returned array.
 */
export async function mapWithConcurrency(items, concurrency, fn) {
  if (!Array.isArray(items)) {
    throw new TypeError('mapWithConcurrency: items must be an array');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('mapWithConcurrency: fn must be a function');
  }

  const requestedConcurrency = Number(concurrency);
  const normalizedConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : 1;
  const workerCount = Math.min(items.length, normalizedConcurrency);
  const results = new Array(items.length);
  let cursor = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }));

  return results;
}
