/**
 * The reactor.inc clips a new render can continue from, and the reset of a continuation the picker no longer offers.
 *
 * Use when: VideoGen's reactor lane builds its "continue from clip" picker. Every completed
 * reactor render stamps its fast-h3 clip id on the history record; those ids are the only thing
 * `continue_from_clip_id` can address, so the picker is built from them.
 */

import { useEffect, useMemo } from 'react';
import { timeAgo } from '../utils/formatters';

/** `reactor` is the `useVideoGenForm()` reactor group. */
export function useReactorContinuableClips({ visibleHistory, reactor, mode }) {
  const { reactorClipId, setReactorClipId } = reactor;
  const reactorContinuableClips = useMemo(() => visibleHistory
    .filter((v) => v.clipId && String(v.modelId || '').startsWith('reactor:'))
    .slice(0, 50)
    .map((v) => ({
      clipId: v.clipId,
      label: `${(v.prompt || v.filename || v.clipId).slice(0, 60)} · ${timeAgo(v.createdAt, 'unknown')}`,
    })), [visibleHistory]);

  // A selection the picker no longer offers must not survive in state: the
  // deleted clip's option is gone, so the select falls back to displaying
  // "Start a fresh shot" while the submission would still carry the stale id.
  // Image mode clears it for the same reason — a continuation and a starting
  // frame are exclusive, and the field is disabled there.
  useEffect(() => {
    if (!reactorClipId) return;
    if (mode === 'image' || !reactorContinuableClips.some((clip) => clip.clipId === reactorClipId)) {
      setReactorClipId('');
    }
  }, [reactorClipId, mode, reactorContinuableClips, setReactorClipId]);

  return reactorContinuableClips;
}

export default useReactorContinuableClips;
