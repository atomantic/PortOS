import { Film, Download } from 'lucide-react';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';

// The final-render surface: a progress bar while the assemble job runs, and the
// finished MP4 (inline player + download + Media History deep link) once the
// project carries a renderHistoryId.
export default function RenderStatusPanel({ rendering, progress, renderHistoryId }) {
  const finalVideo = useVideoFileSrc(renderHistoryId, { enabled: !!renderHistoryId });
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
          {finalVideo.src && (
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
      {finalVideo.resolving && <p className="text-xs text-port-text-muted">Loading final video…</p>}
      {finalVideo.src && (
        // aspect-video reserves the box before the video's intrinsic dimensions
        // resolve, so the actions above it don't jump — same as the scene
        // thumbnails below. The render inherits its first scene clip's
        // dimensions, which are not always 16:9, so object-contain is explicit:
        // a 3:2 cut letterboxes inside the reserved box (against the player's
        // own black) instead of being stretched to fill it.
        <video
          src={finalVideo.src}
          controls
          playsInline
          preload="metadata"
          className="w-full aspect-video max-h-[65vh] object-contain rounded bg-black border border-port-border"
          aria-label="Play final music video"
        />
      )}
    </div>
  );
}
