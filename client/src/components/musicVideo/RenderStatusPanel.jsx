import Banner from '../ui/Banner.jsx';
import { useRef, useState } from 'react';
import { Film, Download, Maximize2, AlertTriangle } from 'lucide-react';
import { STALE_RENDER_MESSAGE } from '../../lib/musicVideoStages.js';
import { assetDownloadUrl } from '../../lib/standaloneDownload.js';

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
  rendering, progress, renderHistoryId, finalVideo, onOpenPreview, stale = false,
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
    <div className={`mt-3 border rounded-lg p-3 space-y-2 ${stale ? 'border-port-warning/40 bg-port-warning/5' : 'border-port-success/40 bg-port-success/5'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium flex items-center gap-1.5">
          <Film size={15} className={stale ? 'text-port-warning' : 'text-port-success'} /> Final music video
        </span>
        <div className="flex items-center gap-2 text-xs">
          {finalVideo?.src && (
            <a
              href={assetDownloadUrl(finalVideo.src)}
              download
              className="min-h-[44px] sm:min-h-0 flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 hover:bg-port-border/40"
            >
              <Download size={13} /> Download MP4
            </a>
          )}
          <a href={`/media/history?preview=${encodeURIComponent(`video:${renderHistoryId}`)}`}
            className="text-port-accent">Open in Media History →</a>
        </div>
      </div>
      {stale && (
        <p role="status" className="text-xs text-port-warning flex items-center gap-1.5">
          <AlertTriangle size={13} /> {STALE_RENDER_MESSAGE}
        </p>
      )}
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
            className="mx-auto block w-full aspect-video max-w-[calc(65vh*16/9)] object-contain rounded bg-black border border-port-border"
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

const STALE_TAKE_CODES = new Set(['STALE_PERFORMANCE_TAKES', 'MUSIC_VIDEO_STALE_SOURCE_AUDIO_TAKES']);

// The one-tap fix a render refusal names, for the shots it applies to: shots
// with no lip-sync take become cutaways (a lip-sync take would lose its
// in-point), and shots longer than their clip hold its last frame.
function refusalFix(failure) {
  const plural = (ids, one, many) => (ids.length === 1 ? one : many);
  if (STALE_TAKE_CODES.has(failure?.code)) {
    const ids = (failure.context?.stale || []).filter((entry) => entry.cutaway).map((entry) => entry.sceneId);
    return ids.length ? { ids, patch: { shotMode: 'cutaway' }, label: `Switch ${plural(ids, 'it', `these ${ids.length}`)} to Cutaway`,
      done: `Switched ${ids.length} shot${plural(ids, '', 's')} to Cutaway` } : null;
  }
  if (failure?.code === 'STALE_CLIP_DEPENDENCIES') {
    const ids = failure.context?.sceneIds || [];
    return ids.length ? { ids, render: true, label: plural(ids, 'Render a new clip', `Render ${ids.length} new clips`) } : null;
  }
  if (failure?.code === 'INSUFFICIENT_CLIP_COVERAGE') {
    const ids = (failure.context?.shortfalls || []).map((entry) => entry.sceneId);
    return ids.length ? { ids, patch: { holdLastFrame: true }, label: `Hold the last frame on ${plural(ids, 'it', `these ${ids.length}`)}`,
      done: `Holding the last frame on ${ids.length} shot${plural(ids, '', 's')}` } : null;
  }
  return null;
}

/**
 * Persisted failures survive reload; kickoff/SSE failures stay bound to their project.
 * A refusal with a one-tap fix offers it: `onPatchShots(sceneIds, patch, doneMessage)`,
 * or for clips made from since-changed frames `onRenderClips(sceneIds)`, which renders
 * each shot's clip again from its current frames and the video settings.
 */
export function RenderFailure({ project, renderJob, onPatchShots, onRenderClips }) {
  const [fixing, setFixing] = useState(false);
  if (renderJob?.active && renderJob.context === project.id) return null;
  const failure = renderJob?.failure?.projectId === project.id ? renderJob.failure : null;
  const error = failure ? failure.message : project.status === 'failed' ? project.renderError : null;
  if (!error) return null;
  const offered = refusalFix(failure);
  const fix = offered && (offered.render ? onRenderClips : onPatchShots) ? offered : null;
  const apply = () => {
    setFixing(true);
    Promise.resolve(fix.render ? onRenderClips(fix.ids) : onPatchShots(fix.ids, fix.patch, fix.done)).finally(() => setFixing(false));
  };
  return (
    <Banner tone="error" title="Render failed" className="break-words">
      {error}
      {fix && (
        <button type="button" onClick={apply} disabled={fixing}
          className="mt-2 block min-h-[44px] sm:min-h-0 rounded border border-port-border bg-port-bg px-2 py-1 text-xs text-port-text hover:bg-port-border/40 disabled:opacity-50">
          {fixing ? (fix.render ? 'Starting…' : 'Saving…') : fix.label}
        </button>
      )}
    </Banner>
  );
}
