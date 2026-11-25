/**
 * `useModelInputPreview(fetchPreview, body, { enabled })` — the server's preview of what a render
 * would send to its model (#11317), refreshed 500 ms after the form stops changing.
 *
 * Superseded responses dropped, a refusal returned as `error`. Use when: Showing the exact prompt
 * and its additions beside a render form before Generate.
 */

import { useEffect, useRef, useState } from 'react';

const PREVIEW_DELAY_MS = 500;

/**
 * The server's preview of what a render would send to its model (#11317),
 * refreshed a moment after the form stops changing. `body` must be plain JSON
 * (uploads named by count); `fetchPreview(body, { silent })` is the route
 * wrapper. A superseded response is dropped, and a refusal comes back as
 * `error` so the form can show why the render would be refused. `revision`
 * invalidates previews when saved context changes outside the request body.
 * `retainOnContextChange` keeps a successful preview visible as `refreshing`
 * while that context is checked again, never across request-body changes.
 */
export function useModelInputPreview(fetchPreview, body, { enabled = true, revision, retainOnContextChange = false } = {}) {
  const [state, setState] = useState({ preview: null, error: null });
  const generation = useRef(0);
  const key = enabled ? JSON.stringify(body) : null;

  useEffect(() => {
    if (key === null) return undefined;
    const current = ++generation.current;
    const timer = setTimeout(() => {
      fetchPreview(JSON.parse(key), { silent: true })
        .then((preview) => { if (current === generation.current) setState({ key, fetchPreview, revision, preview, error: null }); })
        .catch((err) => { if (current === generation.current) setState({ key, fetchPreview, revision, preview: null, error: err?.message || 'Preview failed' }); });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [fetchPreview, key, revision]);

  if (enabled && state.key === key && state.fetchPreview === fetchPreview) {
    if (state.revision === revision) return { preview: state.preview, error: state.error };
    if (retainOnContextChange && state.preview) return { preview: state.preview, error: null, refreshing: true };
  }
  return { preview: null, error: null };
}

export default useModelInputPreview;
