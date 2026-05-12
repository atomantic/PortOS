import { useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
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
export default function MediaJobThumb({ jobId, label = 'Render', size = 'sm', kind = 'image' }) {
  const { status, progress, step, totalSteps, currentImage, filename, error } =
    useMediaJobProgress(jobId, { kind });
  // Local missing-media state. Reset when jobId changes so a fresh render
  // doesn't inherit the prior render's failure flag.
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setMissing(false); setAttempt(0); }, [jobId]);

  if (!jobId) return null;

  const dims = size === 'lg'
    ? 'w-32 h-32'
    : size === 'md' ? 'w-24 h-24' : 'w-16 h-16';

  if (missing) {
    return (
      <div
        title="Media file missing (deleted from disk)"
        className={`${dims} bg-port-bg rounded border border-port-border flex flex-col items-center justify-center gap-1 text-[10px] text-port-text-muted`}
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

  if (status === 'completed' && kind === 'video') {
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
        className={`${dims} object-cover bg-port-bg rounded border border-port-border`}
      />
    );
  }
  if (status === 'completed' && filename) {
    return (
      <a
        href={`/data/images/${filename}${cacheBust}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Open full image in a new tab"
        className={`block ${dims} bg-port-bg rounded overflow-hidden border border-port-border hover:border-port-accent/50 transition-colors`}
      >
        <img
          key={attempt}
          src={`/data/images/${filename}${cacheBust}`}
          alt={label}
          onError={() => setMissing(true)}
          className="w-full h-full object-cover"
          loading="lazy"
        />
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
        className={`${dims} bg-port-bg rounded border border-port-error/40 flex flex-col items-center justify-center gap-1 text-[10px] text-port-error`}
      >
        <AlertCircle size={14} />
        <span>failed</span>
      </div>
    );
  }

  // running/queued/unknown — show currentImage preview if we have one,
  // otherwise a spinner with step counter. The base64 currentImage is the
  // freshly-decoded latent frame from the diffusion loop.
  const pct = totalSteps ? Math.round((step / totalSteps) * 100) : Math.round((progress || 0) * 100);
  return (
    <div className={`relative ${dims} bg-port-bg rounded overflow-hidden border border-port-border`}>
      {currentImage ? (
        <img
          src={`data:image/png;base64,${currentImage}`}
          alt={`${label} preview`}
          className="w-full h-full object-cover opacity-70"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
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
