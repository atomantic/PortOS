import { useState, useEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { videoSrcForJob, videoPosterForJob } from '../../lib/creativeDirectorPreview.js';

/**
 * Inline <video> preview for a single rendered scene. Used by SegmentsTab
 * (CD detail page), EpisodeVideoStage (Pipeline issue page), the CD list
 * cards (via ProjectPreview) and the CD Overview tab (#2702).
 *
 * Behavior notes:
 * - `renderedJobId` survives even after the underlying mp4 is deleted from
 *   history, so the <video> can fail to load. We track that with onError
 *   and fall back to a "missing media" placeholder + Retry button.
 * - `attempt` bumps via the Retry button and via the `jobId` reset effect
 *   (a re-render with the same jobId would otherwise leave a transient
 *   load error stuck for the rest of the session). The `?retry=N` cache
 *   buster forces the browser to re-fetch instead of using the cached
 *   error response.
 * - `controls` + `preload="none"` keeps the thumbnail-driven idle state
 *   without ever fetching the full mp4 until the user hits Play.
 *
 * Props:
 *   jobId, label
 *   aspectClass? — Tailwind aspect class for the frame (default `aspect-video`).
 *                  Lets a caller honor a project's locked 9:16 / 1:1 ratio.
 *                  Applied to the empty + missing states too, so the box never
 *                  changes shape as the media resolves.
 *   autoPlay?    — start playing on mount. Used by the list card's play
 *                  affordance, which swaps this in on click: the user already
 *                  expressed intent, so a second click on the native controls
 *                  would be redundant. Off by default — the grid must never
 *                  fetch mp4s on its own (`preload="none"` only holds while
 *                  this is false). Autoplay follows the same mobile contract as
 *                  MediaLightbox: `muted` is the BASELINE (iOS/Android block
 *                  unmuted autoplay not fired from a direct gesture — and the
 *                  card's src resolution is async, so the click's transient
 *                  activation may well have expired by mount), then the effect
 *                  below upgrades to audible when allowed and falls back to
 *                  muted playback rather than a dead paused player.
 *   onRetry?     — invoked by the Retry button alongside the cache-bust, so a
 *                  caller whose `src` came from a FAILED async lookup can redo
 *                  it. Without this, Retry would only re-request the same wrong
 *                  URL forever (the reconstructed guess) and the video would
 *                  stay unreachable until a remount/reload.
 *   src?         — explicit video URL, overriding the `<jobId>.mp4` guess below.
 *                  Required whenever the id is NOT the filename stem: the
 *                  timeline renderer (a CD project's stitched final cut) mints
 *                  `timeline-<project>-<ts>.mp4` beside a `randomUUID()` id, so
 *                  reconstructing the path 404s. Resolve one with
 *                  `useVideoFileSrc(jobId)`. The POSTER is deliberately still
 *                  derived from `jobId` — `generateThumbnail` always writes
 *                  `<jobId>.jpg`, on both the clip and timeline paths.
 */
export default function ScenePreview({ jobId, label, aspectClass = 'aspect-video', autoPlay = false, src = null, onRetry = null }) {
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const videoRef = useRef(null);
  // A new target starts over completely.
  useEffect(() => {
    setMissing(false);
    setAttempt(0);
  }, [jobId]);
  // A `src` change for the SAME target clears the error but deliberately keeps
  // `attempt`. Two reasons this is split from the reset above. (1) A caller
  // resolving the real filename asynchronously renders once with src=null (the
  // reconstructed guess) then again once it lands — without clearing `missing`,
  // an error recorded against the guess would pin "media missing" over the
  // correct URL that arrived a tick later. (2) But zeroing `attempt` here would
  // defeat the cache-buster on the exact path it exists for: Retry bumps
  // `attempt` AND re-arms the caller's lookup, so `src` round-trips
  // null→resolved on every retry, and a reset would strip `?retry=N` back off
  // the URL — re-requesting the identical URL whose error response the browser
  // may still have cached.
  useEffect(() => {
    setMissing(false);
  }, [src]);

  // Upgrade the muted autoplay baseline to audible when the browser allows it
  // (mirrors MediaLightbox). Re-runs per `attempt` because the Retry button
  // remounts the element via `key`. Promise.resolve() normalizes both a real
  // play() promise and the undefined some environments return.
  useEffect(() => {
    if (!autoPlay) return;
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    Promise.resolve(v.play()).catch(() => {
      v.muted = true;
      Promise.resolve(v.play()).catch(() => {});
    });
  }, [autoPlay, src, jobId, attempt]);

  if (!jobId) {
    return <div className={`bg-port-bg ${aspectClass} flex items-center justify-center text-port-text-muted text-xs`}>no render yet</div>;
  }
  const cacheBust = attempt > 0 ? `?retry=${attempt}` : '';
  const videoSrc = `${src || videoSrcForJob(jobId)}${cacheBust}`;
  const posterSrc = `${videoPosterForJob(jobId)}${cacheBust}`;
  if (missing) {
    return (
      <div className={`bg-port-bg ${aspectClass} flex flex-col items-center justify-center text-port-text-muted text-xs gap-2`}>
        <span>media missing</span>
        <button
          type="button"
          onClick={() => { setMissing(false); setAttempt((a) => a + 1); onRetry?.(); }}
          className="px-2 py-0.5 rounded border border-port-border hover:bg-port-card text-port-text"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className={`relative bg-port-bg ${aspectClass}`}>
      <video
        key={attempt}
        ref={videoRef}
        src={videoSrc}
        poster={posterSrc}
        controls
        preload={autoPlay ? 'metadata' : 'none'}
        autoPlay={autoPlay}
        muted={autoPlay}
        playsInline
        aria-label={label}
        onError={() => setMissing(true)}
        className="w-full h-full object-cover"
      />
      <a
        href={videoSrc}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} in new tab`}
        title="Open video in new tab"
        className="absolute top-1 right-1 p-1 rounded bg-black/50 text-white hover:bg-black/80"
      >
        <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}
