import { useCallback, useEffect, useState } from 'react';
import { getVideoHistoryItem } from '../services/apiImageVideo.js';

/**
 * Resolve a video-history id to the URL of the file it actually points at.
 *
 * WHY THIS EXISTS: a history entry's id and its filename are NOT the same value,
 * and only some writers make them look like they are. `videoGen/local.js` names
 * a clip `<jobId>.mp4`, so reconstructing `/data/videos/<id>.mp4` happens to work
 * for per-scene renders. The video-TIMELINE renderer — which produces a Creative
 * Director project's stitched final cut — mints an independent
 * `timeline-<project>-<ts>.mp4` alongside a `randomUUID()` id
 * (`videoTimeline/local.js`), so a CD `finalVideoId` is a *history id*, not a
 * filename stem, and the reconstructed path 404s. The thumbnail is keyed the
 * other way (`generateThumbnail` always writes `<jobId>.jpg`), which is what
 * makes the mismatch so easy to miss: the poster renders perfectly while the mp4
 * behind it does not exist.
 *
 * So: resolve through the stored `filename` — the same thing the server does
 * (`stitchRunner.js` joins `PATHS.videos` with `finalEntry.filename`) and the
 * media UI does (`components/media/normalize.js` → `/data/videos/${v.filename}`).
 *
 * The lookup is a single-entry read (`GET /api/video-gen/history/:id`, #4165).
 * It used to pull the WHOLE history list and scan it client-side, because no
 * by-id endpoint existed — so three surfaces (CD cards, CD Overview,
 * EpisodeVideoStage) each downloaded every render the install has ever produced
 * to learn one filename.
 *
 * Usage: pass the resolved `src` to `<ScenePreview src=…>`, which falls back to
 * its `<jobId>.mp4` reconstruction when this returns null. Callers should gate
 * on `resolving` before AUTOPLAYING, or the player would race the lookup and
 * autoplay the wrong (nonexistent) path. A caller that only renders an idle
 * `preload="none"` player can ignore `resolving` — nothing is fetched until the
 * user hits Play, by which time the lookup has long settled.
 *
 * `enabled` keeps this lazy: the list grid must not fetch history for N cards,
 * so a card resolves only once the user actually presses play.
 */
export function useVideoFileSrc(jobId, { enabled = true } = {}) {
  // Keyed by the id + attempt it was resolved FOR, so `resolving` can be derived
  // synchronously rather than set from an effect. An effect-set flag would
  // still be false for the first render after `enabled` flips true (effects run
  // after commit) — long enough for a caller gating autoplay to mount a player
  // against the unresolved fallback path, fire a doomed request, and flash
  // "media missing" before the real src lands.
  const [attempt, setAttempt] = useState(0);
  const [resolved, setResolved] = useState({ jobId: null, attempt: -1, src: null });
  const active = Boolean(enabled && jobId);
  const settled = resolved.jobId === jobId && resolved.attempt === attempt;
  const resolving = active && !settled;

  useEffect(() => {
    if (!active || settled) return undefined;
    let cancelled = false;
    // Silent: neither a 404 (media deleted out from under the record) nor a
    // transient failure is a user-facing error here — ScenePreview's
    // reconstruction fallback (and its own missing-media UI) covers both, so a
    // toast would be noise on a page that already degrades gracefully.
    // Both paths settle on THIS jobId+attempt so `resolving` can never latch on.
    getVideoHistoryItem(jobId, { silent: true })
      .then((entry) => {
        if (cancelled) return;
        const filename = typeof entry?.filename === 'string' ? entry.filename.trim() : '';
        setResolved({ jobId, attempt, src: filename ? `/data/videos/${filename}` : null });
      })
      .catch(() => { if (!cancelled) setResolved({ jobId, attempt, src: null }); });
    return () => { cancelled = true; };
  }, [jobId, active, settled, attempt]);

  // Redo a settled lookup. A transient 5xx on the history call would otherwise
  // strand a timeline final forever: `src` stays null, the caller falls back to
  // the reconstructed `<jobId>.mp4` that cannot exist for it, and ScenePreview's
  // own Retry only re-requests that same wrong URL. Wire this to that Retry
  // (`<ScenePreview onRetry={retry}>`) so one button recovers both layers.
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  return { src: settled ? resolved.src : null, resolving, retry };
}
