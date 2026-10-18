import { useCallback, useEffect, useRef, useState } from 'react';

const LOADING = Object.freeze({ items: [], state: 'loading', error: null });

/**
 * A list read that never collapses "failed" into "empty".
 *
 * Returns `{ items, state, error, retry, setItems }` where `state` is
 * `'loading' | 'ready' | 'error'`. `items` is `[]` while loading and after a
 * failure so consumers that only read the array keep working, but a picker
 * gates its "you have none" copy on `state === 'ready'` and renders
 * `<ListLoadError onRetry={retry}>` on `'error'` — the client side of the
 * root AGENTS.md sentinel rule (absent vs failed vs legitimately empty).
 *
 * `fetcher` must be referentially stable (a module-level function or a
 * `useCallback`); it re-runs when its identity changes and on `retry()`, and
 * a response from a superseded run is dropped. `enabled: false` holds the
 * resource at `'loading'` without a request. `setItems` applies a local
 * mutation (an import appending a row) without a refetch.
 */
export default function useListResource(fetcher, { enabled = true } = {}) {
  const [resource, setResource] = useState(LOADING);
  const [attempt, setAttempt] = useState(0);
  // Each run owns a generation: a retry issued while a request is in flight,
  // or a changed fetcher, supersedes it and its late answer is ignored.
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    generation.current += 1;
    const current = generation.current;
    setResource(LOADING);
    Promise.resolve()
      .then(() => fetcher())
      .then((list) => {
        if (generation.current !== current) return;
        setResource({ items: Array.isArray(list) ? list : [], state: 'ready', error: null });
      })
      .catch((error) => {
        if (generation.current !== current) return;
        setResource({ items: [], state: 'error', error: error instanceof Error ? error : new Error('Request failed') });
      });
    return () => { generation.current += 1; };
  }, [fetcher, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const setItems = useCallback((update) => setResource((prev) => ({
    ...prev,
    items: typeof update === 'function' ? update(prev.items) : update,
  })), []);

  return { ...resource, retry, setItems };
}
