import { useEffect, useState } from 'react';
import { AlertCircle, Ban, Loader2 } from 'lucide-react';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';

/**
 * Small thumbnail strip for a single mediaJobQueue job. Used by the
 * Pipeline ComicPages and Storyboards stages so each panel/scene shows its
 * render's live preview (currentImage during diffusion) and the final
 * artifact once the job completes.
 *
 * kind='image' — completed render served from /data/images/<filename>.
 * kind='video' — completed render served as <video> from /data/videos/<jobId>.mp4
 * with /data/video-thumbnails/<jobId>.jpg as poster (matches ScenePreview).
 *
 * Handles the same "media file deleted out from under us" case ScenePreview
 * does — flips to a "missing" badge with a Retry button (re-arms the
 * <video>/<img> via a cache-busting key) when the file 404s.
 */
export default function MediaJobThumb({
  jobId, label = 'Render', size = 'sm', kind = 'image',
  onPreview = null, onStatus = null, onFilename = null,
  // Saved filename on the parent record (e.g. comicPages page.filename).
  // When the parent already has the rendered filename, the job is done
  // by definition (the comic-pages filename hook only stamps on completion)
  // — skip the live media-job lookup and subscription entirely.
  fallbackFilename = null,
}) {
  // Short-circuit live progress when the parent has the final filename.
  // Re-renders clear `filename` server-side, so a truthy fallbackFilename
  // is an authoritative "this render is complete" signal. Pass null jobId
  // to the hook so it skips the fetch + socket subscriptions; the hook
  // tolerates null cleanly. Image-only — video fallback would also need
  // a poster, so keep the live subscription path for video.
  const hasStaticFallback = !!fallbackFilename && kind === 'image';
  const liveJobId = hasStaticFallback ? null : jobId;
  const { status, progress, step, totalSteps, currentImage, filename, error } =
    useMediaJobProgress(liveJobId, { kind });
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setMissing(false); setAttempt(0); }, [jobId]);

  const effectiveStatus = hasStaticFallback ? 'completed' : status;
  const effectiveFilename = hasStaticFallback ? fallbackFilename : filename;

  // Forward subscription state to the parent so callers (e.g. PageRow's
  // disable-while-rendering logic, lightbox nav builders) don't need a
  // duplicate useMediaJobProgress subscription on the same jobId.
  useEffect(() => { if (onStatus) onStatus(effectiveStatus); }, [effectiveStatus, onStatus]);
  useEffect(() => { if (onFilename && effectiveFilename) onFilename(effectiveFilename); }, [effectiveFilename, onFilename]);

  if (!jobId) return null;

  // `fill` fills the parent container's width with the image's natural
  // aspect (object-contain). State-only branches (spinner, missing, failed)
  // keep a fixed footprint so the row doesn't collapse mid-render.
  // `xs` (48x80, 3:5 portrait) matches the universe-builder avatar slot used
  // by variation and canon rows — portrait shape so the typical 1024x1536
  // universe render shows the full subject without aggressive center-crop.
  // The larger square sizes (`sm`/`md`/`lg`) are used by the pipeline
  // comic-pages / storyboard stages where 1:1 still reads best.
  const isFill = size === 'fill';
  const dims = isFill
    ? 'w-full'
    : size === 'lg' ? 'w-32 h-32'
    : size === 'md' ? 'w-24 h-24'
    : size === 'xs' ? 'w-12 h-20' : 'w-16 h-16';
  const stateDims = isFill ? 'w-full min-h-[200px]' : dims;
  const imgFit = isFill ? 'w-full h-auto max-h-[640px] object-contain' : 'w-full h-full object-cover';

  if (missing) {
    return (
      <div
        title="Media file missing (deleted from disk)"
        className={`${stateDims} bg-port-bg rounded border border-port-border flex flex-col items-center justify-center gap-1 text-[10px] text-port-text-muted`}
      >
        <span>missing</span>
        <button
          type="button"
          onClick={() => { setMissing(false); setAttempt((a) => a + 1); }}
          className="px-1.5 py-0 rounded border border-port-border hover:bg-port-card text-port-text"
        >
          Retry
        </button>
      </div>
    );
  }

  const cacheBust = attempt > 0 ? `?retry=${attempt}` : '';

  if (effectiveStatus === 'completed' && kind === 'video') {
    return (
      <video
        key={attempt}
        src={`/data/videos/${jobId}.mp4${cacheBust}`}
        poster={`/data/video-thumbnails/${jobId}.jpg${cacheBust}`}
        controls
        preload="none"
        playsInline
        aria-label={label}
        onError={() => setMissing(true)}
        className={isFill
          ? 'w-full h-auto max-h-[640px] bg-port-bg rounded border border-port-border'
          : `${dims} object-cover bg-port-bg rounded border border-port-border`}
      />
    );
  }
  if (effectiveStatus === 'completed' && effectiveFilename) {
    const imgEl = (
      <img
        key={attempt}
        src={`/data/images/${effectiveFilename}${cacheBust}`}
        alt={label}
        onError={() => setMissing(true)}
        className={imgFit}
        loading="lazy"
      />
    );
    const wrapperClass = `block ${dims} bg-port-bg rounded overflow-hidden border border-port-border hover:border-port-accent/50 transition-colors`;
    if (onPreview) {
      return (
        <button
          type="button"
          onClick={() => onPreview(effectiveFilename)}
          title="Open preview"
          className={`${wrapperClass} cursor-zoom-in p-0`}
        >
          {imgEl}
        </button>
      );
    }
    return (
      <a
        href={`/data/images/${effectiveFilename}${cacheBust}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Open full image in a new tab"
        className={wrapperClass}
      >
        {imgEl}
      </a>
    );
  }

  if (status === 'failed') {
    // No client-side retry — re-enqueue lives on the parent stage's button
    // since the job's params (mode, model, image source) are owned there.
    // Surface the error message so the user knows what to fix.
    return (
      <div
        title={error || 'Render failed'}
        className={`${stateDims} bg-port-bg rounded border border-port-error/40 flex flex-col items-center justify-center gap-1 text-[10px] text-port-error`}
      >
        <AlertCircle size={14} />
        <span>failed</span>
      </div>
    );
  }

  if (status === 'canceled') {
    // Canceled by the user via the queue cancel route. Without an explicit
    // branch the row would fall through to the running/queued spinner and
    // look stuck forever — re-enqueue lives on the parent stage button.
    return (
      <div
        title="Render canceled"
        className={`${stateDims} bg-port-bg rounded border border-port-border flex flex-col items-center justify-center gap-1 text-[10px] text-port-text-muted`}
      >
        <Ban size={14} />
        <span>canceled</span>
      </div>
    );
  }

  // running/queued/unknown — show currentImage preview if we have one,
  // otherwise a spinner with step counter. The base64 currentImage is the
  // freshly-decoded latent frame from the diffusion loop.
  const pct = totalSteps ? Math.round((step / totalSteps) * 100) : Math.round((progress || 0) * 100);
  return (
    <div className={`relative ${isFill ? 'w-full min-h-[200px]' : dims} bg-port-bg rounded overflow-hidden border border-port-border`}>
      {currentImage ? (
        <img
          src={`data:image/png;base64,${currentImage}`}
          alt={`${label} preview`}
          className={`${imgFit} opacity-70`}
        />
      ) : (
        <div className={`${isFill ? 'min-h-[200px]' : 'w-full h-full'} flex items-center justify-center`}>
          <Loader2 size={14} className="animate-spin text-port-accent" />
        </div>
      )}
      {pct > 0 && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white text-center py-0.5 font-mono">
          {pct}%
        </div>
      )}
    </div>
  );
}
