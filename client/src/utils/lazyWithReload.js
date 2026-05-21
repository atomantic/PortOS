import { lazy } from 'react';
import { isStaleChunkError, reloadOnceForStaleChunk } from './staleChunkReload';

// React.lazy() wrapper that recovers from stale-chunk errors after a rebuild
// changes Vite chunk hashes while a tab is still open. When such an error
// fires, reload the page once to pick up the new bundle; everything else
// re-throws so error boundaries can see it.
export const lazyWithReload = (importFn) => lazy(() =>
  importFn().catch(err => {
    if (isStaleChunkError(err) && reloadOnceForStaleChunk()) {
      return new Promise(() => {});
    }
    throw err;
  })
);
