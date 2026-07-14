import { useCallback, useEffect, useRef, useState } from 'react';
import { parseMidiFile } from '../lib/midiNotes.js';

// Fetch + parse a `.mid` file into the piano-roll view-model, with a
// module-level cache so re-mounting a visualization (tab switches, collapse)
// doesn't refetch or reparse. Fetches directly (static file URL, same as the
// <audio> elements beside it) — no api request() layer, so errors surface as
// the hook's inline `error` state, never a toast.

// url → parsed view-model. Parsed models are small (notes only, no raw bytes);
// null is never cached ("not fetched" and "cached-empty" must stay distinct).
// LRU-capped so a long session browsing many transcriptions doesn't
// accumulate unbounded parsed note lists on the heap.
const CACHE_MAX = 16;
const cache = new Map();
const cachePut = (url, data) => {
  cache.delete(url); // re-insert so Map iteration order is least-recent first
  cache.set(url, data);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
};
const cacheGet = (url) => {
  const data = cache.get(url);
  if (data !== undefined) cachePut(url, data); // refresh recency
  return data;
};

/** Test-only: clear the module-level parse cache between cases. */
export const __clearMidiNotesCache = () => cache.clear();

/**
 * @param {string|null} url — resolved URL of the .mid file (null/'' renders idle).
 * @returns {{ status:'idle'|'loading'|'ready'|'error', data:object|null,
 *   error:string|null, reload:()=>void }}
 */
export default function useMidiNotes(url) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });
  const generationRef = useRef(0);

  const load = useCallback((targetUrl, { force = false } = {}) => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!targetUrl) {
      setState({ status: 'idle', data: null, error: null });
      return;
    }
    const cached = force ? undefined : cacheGet(targetUrl);
    if (cached !== undefined) {
      setState({ status: 'ready', data: cached, error: null });
      return;
    }
    setState({ status: 'loading', data: null, error: null });
    fetch(targetUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load MIDI (${res.status})`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        const data = parseMidiFile(buf);
        cachePut(targetUrl, data);
        if (generationRef.current === generation) setState({ status: 'ready', data, error: null });
      })
      .catch((err) => {
        if (generationRef.current === generation) {
          setState({ status: 'error', data: null, error: err?.message || 'Failed to parse MIDI' });
        }
      });
  }, []);

  useEffect(() => {
    load(url);
    // Invalidate in-flight responses on unmount/url change so a stale parse
    // can't land on a different file's state.
    return () => { generationRef.current += 1; };
  }, [url, load]);

  const reload = useCallback(() => load(url, { force: true }), [url, load]);

  return { ...state, reload };
}
