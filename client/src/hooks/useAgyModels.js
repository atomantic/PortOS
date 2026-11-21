// Agy (Antigravity CLI) session-model list.
//
// Live `agy models` probe (the AGENT models `--model` accepts) with
// `models`/`error`/`loading`/`refresh`; opt-in via an `enabled` flag so it never spawns for a disabled
// backend. Use when: Any Agy model picker — the Settings default or the per-render override. Don't
// hardcode a model list: agy exits non-zero on an id outside this catalog.
//
// `agy models` enumerates the AGENT models the CLI's `--model` flag accepts —
// the model that drives the session and calls the built-in `generate_image`
// tool. Agy exposes no knob for the underlying *image* model (its
// `generate_image` tool takes Prompt / ImageName / AspectRatio / ImagePaths and
// nothing else), so this list is the only model selection PortOS can make for
// an Agy render. Handing `--model` anything outside this list makes agy exit
// non-zero before it generates, which is why both the Settings default and the
// per-render override are driven off the live probe rather than a baked-in
// list that can drift when Google rotates the catalog.
//
// The probe spawns a child process server-side, so it is opt-in via `enabled`
// and never runs on mount for a backend the user hasn't turned on.

import { useCallback, useEffect, useState } from 'react';
import { listAgyImageModels } from '../services/apiImageVideo.js';

/**
 * @param {boolean} enabled - only probe while the Agy backend is in play
 * @returns {{ models: string[], error: string|null, loading: boolean, refresh: () => void }}
 */
export function useAgyModels(enabled) {
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    // `silent: true` — the callers below render the error inline next to the
    // field, so the shared request() helper must not also toast it.
    listAgyImageModels({ silent: true })
      .then((result) => {
        setModels(Array.isArray(result?.models) ? result.models : []);
        setError(result?.error || null);
      })
      .catch((err) => {
        setModels([]);
        setError(err.message || 'Failed to list Agy models');
      })
      .finally(() => setLoading(false));
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  return { models, error, loading, refresh };
}

export default useAgyModels;
