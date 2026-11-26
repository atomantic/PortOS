/**
 * `useVideoFileSrc(jobId, { enabled })` resolves the file URL and any stored playback timing from the same history entry.
 */

import { useCallback, useEffect, useState } from 'react';
import { getVideoHistoryItem } from '../services/apiImageVideo.js';

/**
 * Resolve a video-history id to the URL of the file it actually points at. A history entry's id and filename are NOT the same value: `videoGen/local.js` names a clip `<jobId>.mp4` (so `/data/videos/<id>.mp4` works for per-scene renders),
 * but the video-TIMELINE renderer (a Creative Director project's stitched final cut) mints `timeline-<project>-<ts>.mp4` alongside a `randomUUID()` id (`videoTimeline/local.js`), so a CD `finalVideoId` is a history id and the
 * reconstructed path 404s. The thumbnail is keyed the other way (`<jobId>.jpg`), so the poster renders while the mp4 behind it does not exist.
 *
 * So resolve through the stored `filename`, as the server (`stitchRunner.js`) and media UI (`components/media/normalize.js`) do, via a single-entry read (`GET /api/video-gen/history/:id`, #4165).
 *
 * Pass the resolved `src` to `<ScenePreview src=…>`, which falls back to its `<jobId>.mp4` reconstruction when this returns null. Gate on `resolving` before AUTOPLAYING, or the player races the lookup and
 * autoplays a nonexistent path; an idle `preload="none"` player can ignore it. `geometry: true` asks the read to measure missing source geometry; `fps` is null until a finite cadence is known.
 * `enabled` keeps this lazy: the list grid must not fetch history for N cards, so a card resolves only once the user presses play.
 */
export function useVideoFileSrc(jobId, { enabled = true, geometry = false } = {}) {
  // Keyed by the id + attempt it was resolved FOR, so `resolving` is derived synchronously: an effect-set flag would still be false for the first render after `enabled` flips true, long enough for an
  // autoplay-gating caller to mount a player against the unresolved fallback path and flash "media missing".
  const [attempt, setAttempt] = useState(0);
  const [resolved, setResolved] = useState({ jobId: null, attempt: -1, src: null });
  const active = Boolean(enabled && jobId);
  const settled = resolved.jobId === jobId && resolved.attempt === attempt && resolved.geometry === geometry;
  const resolving = active && !settled;

  useEffect(() => {
    if (!active || settled) return undefined;
    let cancelled = false;
    // Silent: a 404 or transient failure is covered by ScenePreview's reconstruction fallback and its own missing-media UI, so a toast would be noise. Both paths settle on THIS jobId+attempt so `resolving` can't latch on.
    getVideoHistoryItem(jobId, { silent: true, ...(geometry ? { geometry: true } : {}) })
      .then((entry) => {
        if (cancelled) return;
        const filename = typeof entry?.filename === 'string' ? entry.filename.trim() : '';
        setResolved({
          jobId, attempt, geometry, src: filename ? `/data/videos/${filename}` : null, fps: entry?.fps,
          songStartSec: entry?.songStartSec, songDurationSec: entry?.songDurationSec,
        });
      })
      .catch(() => { if (!cancelled) setResolved({ jobId, attempt, geometry, src: null }); });
    return () => { cancelled = true; };
  }, [jobId, active, settled, attempt, geometry]);

  // Redo a settled lookup: a transient 5xx would otherwise strand a timeline final (`src` null, fallback to a `<jobId>.mp4` that cannot exist, ScenePreview's Retry re-requesting that same URL). Wire it to
  // `<ScenePreview onRetry={retry}>` so one button recovers both layers.
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  return {
    src: settled ? resolved.src : null,
    fps: settled && Number.isFinite(resolved.fps) && resolved.fps > 0 ? resolved.fps : null,
    songStartSec: settled && Number.isFinite(resolved.songStartSec) && resolved.songStartSec >= 0 ? resolved.songStartSec : null,
    songDurationSec: settled && Number.isFinite(resolved.songDurationSec) && resolved.songDurationSec > 0 ? resolved.songDurationSec : null,
    resolving, retry,
  };
}
