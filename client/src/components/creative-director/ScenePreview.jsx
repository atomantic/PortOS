import { useState, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';

/**
 * Inline <video> preview for a single rendered scene. Used by SegmentsTab
 * (CD detail page) and by EpisodeVideoStage (Pipeline issue page).
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
 */
export default function ScenePreview({ jobId, label }) {
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setMissing(false);
    setAttempt(0);
  }, [jobId]);

  if (!jobId) {
    return <div className="bg-port-bg aspect-video flex items-center justify-center text-port-text-muted text-xs">no render yet</div>;
  }
  const cacheBust = attempt > 0 ? `?retry=${attempt}` : '';
  const videoSrc = `/data/videos/${jobId}.mp4${cacheBust}`;
  const posterSrc = `/data/video-thumbnails/${jobId}.jpg${cacheBust}`;
  if (missing) {
    return (
      <div className="bg-port-bg aspect-video flex flex-col items-center justify-center text-port-text-muted text-xs gap-2">
        <span>media missing</span>
        <button
          type="button"
          onClick={() => { setMissing(false); setAttempt((a) => a + 1); }}
          className="px-2 py-0.5 rounded border border-port-border hover:bg-port-card text-port-text"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="relative bg-port-bg aspect-video">
      <video
        key={attempt}
        src={videoSrc}
        poster={posterSrc}
        controls
        preload="none"
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
