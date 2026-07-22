import { lazy } from 'react';
import { isStaleChunkError, reloadOnceForStaleChunk } from './staleChunkReload';
import { sleep } from './sleep.js';

// How many times to re-attempt a failed dynamic import before giving up, and
// the base backoff between attempts (multiplied by the attempt number).
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 350;

// Retry a dynamic import a few times before treating the failure as terminal.
// On flaky mobile/cellular links a chunk fetch can fail on a transient blip
// ("Importing a module script failed" on Safari, "Failed to fetch dynamically
// imported module" on Chrome) even though the chunk still exists — a page
// reload wouldn't fix a network hiccup, so a short retry recovers silently
// without the jarring full-page reload. A genuinely stale chunk (renamed by a
// rebuild) just 404s on each quick retry and falls through to the reload path.
export const importWithRetry = (importFn, retriesLeft = MAX_RETRIES) =>
  importFn().catch(async (err) => {
    if (retriesLeft > 0) {
      await sleep(RETRY_BASE_DELAY_MS * (MAX_RETRIES - retriesLeft + 1));
      return importWithRetry(importFn, retriesLeft - 1);
    }
    throw err;
  });

// React.lazy() wrapper that recovers from stale-chunk errors after a rebuild
// changes Vite chunk hashes while a tab is still open. The import is retried a
// couple of times first (see importWithRetry) to ride out transient mobile
// network failures; if it still fails with a stale-chunk error, reload the page
// once to pick up the new bundle. Everything else re-throws so error boundaries
// can see it.
export const lazyWithReload = (importFn) => lazy(() =>
  importWithRetry(importFn).catch(err => {
    if (isStaleChunkError(err) && reloadOnceForStaleChunk()) {
      return new Promise(() => {});
    }
    throw err;
  })
);
