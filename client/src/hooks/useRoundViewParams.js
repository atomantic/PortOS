import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The Round editor's three URL-param-driven views (`/rounds/:id`). Every one of
 * them lives in the URL rather than local state so each surface is linkable —
 * per the project's "selection lives in the URL" convention:
 *
 *  - `?mode=edit`      → the editing workbench (absent/`read` = performance view)
 *  - `?stack=1`        → the round-stack (quodlibet) view of the partner rounds
 *  - `?analyze=<refId>`→ the reference-audio analysis workbench (#2106)
 *
 * All three setters `replace` so flipping views doesn't pile up history entries.
 *
 * @returns {{editing: boolean, setMode: (mode: string) => void,
 *            stackOpen: boolean, setStack: (open: boolean) => void,
 *            analyzeId: string|null, setAnalyze: (refId: string|null) => void}}
 */
export default function useRoundViewParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Replace one param on the existing query, keeping the others intact.
  const setParam = useCallback((key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const editing = searchParams.get('mode') === 'edit';
  const setMode = useCallback((mode) => setParam('mode', mode === 'edit' ? 'edit' : null), [setParam]);

  const stackOpen = searchParams.get('stack') === '1';
  const setStack = useCallback((open) => setParam('stack', open ? '1' : null), [setParam]);

  const analyzeId = searchParams.get('analyze');
  const setAnalyze = useCallback((refId) => setParam('analyze', refId || null), [setParam]);

  return { editing, setMode, stackOpen, setStack, analyzeId, setAnalyze };
}
