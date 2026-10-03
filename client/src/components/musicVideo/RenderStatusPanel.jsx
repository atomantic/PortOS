import Banner from '../ui/Banner.jsx';
import { useRef } from 'react';
import { Film, Download, Maximize2 } from 'lucide-react';

// The final-render surface: a progress bar while the assemble job runs, and the
// finished MP4 (inline player + download + Media History deep link) once the
// project carries a renderHistoryId.
//
// `finalVideo` is resolved by the page (`useVideoFileSrc`) so MusicVideo can
// also build the lightbox item from the real filename — the final render's
// history id is NOT its filename stem (`music-video-*.mp4`), so reconstructing
// `/data/videos/<id>.mp4` 404s. `onOpenPreview(key)` opens the page-level
// MediaLightbox; the expand control sits in the player corner so native
// play/pause keeps working. Opening the lightbox pauses this player first so
// the lightbox's autoplay unmute doesn't double-play the same audio. "Open in
// Media History →" stays — it goes to the full history grid, not the same-page
// lightbox.
export default function RenderStatusPanel({
  rendering, progress, renderHistoryId, finalVideo, onOpenPreview,
}) {
  const playerRef = useRef(null);
  if (rendering) {
    return (
      <div className="mt-2">
        <div className="h-1.5 bg-port-bg rounded overflow-hidden">
          <div className="h-full bg-port-accent transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-xs text-port-text-muted mt-1">Rendering music video — {progress}%</p>
      </div>
    );
  }
  if (!renderHistoryId) return null;
  return (
    <div className="mt-3 border border-port-success/40 bg-port-success/5 rounded-lg p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium flex items-center gap-1.5">
          <Film size={15} className="text-port-success" /> Final music video
        </span>
        <div className="flex items-center gap-2 text-xs">
          {finalVideo?.src && (
            <a
              href={finalVideo.src}
              download
              className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 hover:bg-port-border/40"
            >
              <Download size={13} /> Download MP4
            </a>
          )}
          <a href={`/media/history?preview=${encodeURIComponent(`video:${renderHistoryId}`)}`}
            className="text-port-accent">Open in Media History →</a>
        </div>
      </div>
      {finalVideo?.resolving && <p className="text-xs text-port-text-muted">Loading final video…</p>}
      {finalVideo?.src && (
        // aspect-video reserves the box before the video's intrinsic dimensions
        // resolve, so the actions above it don't jump — same as the scene
        // thumbnails below. The render inherits its first scene clip's
        // dimensions, which are not always 16:9, so object-contain is explicit:
        // a 3:2 cut letterboxes inside the reserved box (against the player's
        // own black) instead of being stretched to fill it.
        <div className="relative">
          <video
            ref={playerRef}
            src={finalVideo.src}
            controls
            playsInline
            preload="metadata"
            className="w-full aspect-video max-h-[65vh] object-contain rounded bg-black border border-port-border"
            aria-label="Play final music video"
          />
          <button
            type="button"
            onClick={() => {
              playerRef.current?.pause();
              onOpenPreview?.(`video:${renderHistoryId}`);
            }}
            aria-label="View final video full size"
            title="View final video full size"
            className="always-dark absolute top-2 right-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1.5 flex items-center justify-center rounded bg-black/50 text-white hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-port-accent"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Persisted failures survive reload; kickoff/SSE failures stay bound to their project. */
export function RenderFailure({ project, renderJob }) {
  if (renderJob?.active && renderJob.context === project.id) return null;
  const error = renderJob?.failure?.projectId === project.id ? renderJob.failure.message
    : project.status === 'failed' ? project.renderError : null;
  return error ? <Banner tone="error" title="Render failed" className="break-words">{error}</Banner> : null;
}
