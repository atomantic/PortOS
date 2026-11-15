/**
 * The image-to-3D target registry (`GET /api/image-to-3d/targets`), fetched once
 * per mount.
 *
 * The image-to-3D target registry (`GET /api/image-to-3d/targets`), fetched once per mount. Returns `{
 * targets, loading, error, reload }` — `error` is first-class, because a failed registry read is NOT
 * an empty registry and both call sites render that distinction. Use when: The `/3d` render flow
 * (target picker + readiness summary) and Models → 3D (install/repair). Don't re-roll the fetch in a
 * third surface.
 *
 * Two surfaces read the same list and neither can be derived from the other:
 * `/3d` needs it to pick a render target and report how many runtimes are ready,
 * and Models → 3D needs it to install/repair them (#4728). The descriptor is
 * still growing (`degraded`, `repairable`, `gatedRepos`, `installNotes` all
 * landed recently), so the fetch lives here rather than inline in both — a shape
 * change is one edit, not two that can drift.
 *
 * `error` is a first-class return, not a swallowed catch: a failed registry read
 * is NOT an empty registry, and both call sites render the distinction (a Retry
 * affordance / "could not check" rather than "no models registered").
 *
 * @returns {{ targets: object[], loading: boolean, error: string|null, reload: () => void }}
 */
import { useCallback, useEffect, useState } from 'react';
import { getImageTo3dTargets } from '../services/api';

export function useImageTo3dTargets() {
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    getImageTo3dTargets()
      .then((data) => { setTargets(data?.targets || []); setError(null); })
      .catch((err) => setError(err?.message || 'Failed to load 3D targets'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { targets, loading, error, reload };
}

export default useImageTo3dTargets;
