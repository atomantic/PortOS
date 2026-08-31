/**
 * FableLoom's shared scene-media surface.
 *
 * Used in both the graph node and selected-scene editor. A completed video is
 * always the final preview; otherwise the still image (or the current latent
 * frame while rendering) remains visible. Generation controls never disappear,
 * and queued/running/failed/canceled states stay visible after the POST returns.
 */

import { useState } from 'react';
import { AlertCircle, ExternalLink, ImagePlus, Loader2, Upload, Video } from 'lucide-react';
import MediaImage from '../MediaImage';
import GalleryVideoPicker from '../videoGen/GalleryVideoPicker';

const ACTIVE_STATUSES = new Set(['submitting', 'queued', 'running', 'unknown']);

const isActive = (job) => Boolean(job && ACTIVE_STATUSES.has(job.status));

const progressPercent = (job) => {
  if (!job) return null;
  if (Number.isFinite(job.totalSteps) && job.totalSteps > 0 && Number.isFinite(job.step)) {
    return Math.round((job.step / job.totalSteps) * 100);
  }
  return Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null;
};

const jobStateLabel = (kind, job) => {
  const noun = kind === 'video' ? 'video' : 'image';
  if (!job) return null;
  if (job.status === 'failed') return `${noun[0].toUpperCase()}${noun.slice(1)} failed`;
  if (job.status === 'canceled') return `${noun[0].toUpperCase()}${noun.slice(1)} canceled`;
  if (!isActive(job)) return null;
  const pct = progressPercent(job);
  return job.status === 'submitting'
    ? `Starting ${noun}…`
    : `Generating ${noun}${pct !== null ? ` ${pct}%` : '…'}`;
};

export default function LoomSceneMedia({
  node,
  jobs = {},
  onGenerateImage,
  onGenerateVideo,
  onOpenFalVideo,
  onAttachVideo,
  compact = false,
  generationDisabled = false,
  generationDisabledReason = '',
  falDisabled,
  falDisabledReason,
}) {
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  const imageJob = jobs.image || null;
  const freeToolDisabled = falDisabled ?? generationDisabled;
  const freeToolDisabledReason = falDisabledReason ?? generationDisabledReason;
  const videoJob = jobs.video || null;
  const imageActive = isActive(imageJob);
  const videoActive = isActive(videoJob);
  const activeJob = videoActive ? videoJob : imageActive ? imageJob : null;
  const activeKind = videoActive ? 'video' : imageActive ? 'image' : null;
  const failedJob = videoJob?.status === 'failed'
    ? { kind: 'video', ...videoJob }
    : imageJob?.status === 'failed'
      ? { kind: 'image', ...imageJob }
      : null;
  const canceledJob = !failedJob && (videoJob?.status === 'canceled'
    ? { kind: 'video', ...videoJob }
    : imageJob?.status === 'canceled'
      ? { kind: 'image', ...imageJob }
      : null);
  const noticeJob = failedJob || canceledJob;
  const noticeLabel = noticeJob && jobStateLabel(noticeJob.kind, noticeJob);
  const activeLabel = activeKind && jobStateLabel(activeKind, activeJob);
  const title = node.title || 'Scene';

  // The final video wins. During a new video render its live frame wins; when
  // no live frame exists, retain the still rather than replacing useful visual
  // context with an empty spinner.
  const showFinalVideo = Boolean(node.videoHistoryId) && !videoActive;
  const liveFrame = activeJob?.currentImage || null;
  const showStill = !showFinalVideo && !liveFrame && Boolean(node.image);
  const showSpinner = !showFinalVideo && !liveFrame && !showStill && Boolean(activeJob);

  const stopNodeActivation = (event) => event.stopPropagation();
  const buttonClass = compact
    ? 'inline-flex min-w-0 items-center justify-center gap-1 rounded border border-port-border bg-port-bg/80 px-1.5 py-1 text-[9px] text-port-text hover:border-port-accent hover:text-port-accent disabled:opacity-45'
    : 'inline-flex items-center justify-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs text-port-text hover:border-port-accent hover:text-port-accent disabled:opacity-45';
  // Compact media still lives inside an SVG foreignObject. Keep its overlapping
  // preview/status layers in one grid cell: WebKit handles that more reliably
  // than positioned HTML descendants, while the canvas owns card coordinates.
  const previewClass = compact
    ? 'grid flex-1 min-h-0 min-w-0 overflow-hidden rounded border border-port-border bg-port-bg'
    : 'relative min-h-0 overflow-hidden rounded border border-port-border bg-port-bg aspect-video max-h-56';
  const previewItemClass = compact ? 'col-start-1 row-start-1 min-h-0 min-w-0' : '';
  const noticePositionClass = compact
    ? 'col-start-1 row-start-1 self-end'
    : 'absolute inset-x-0 bottom-0';

  return (
    <div className={compact ? 'flex h-full w-full min-h-0 min-w-0 flex-col gap-1' : 'space-y-2'}>
      <div className={previewClass}>
        {showFinalVideo ? (
          <video
            src={`/data/videos/${encodeURIComponent(node.videoHistoryId)}.mp4`}
            aria-label={`${title} video preview`}
            className={`${previewItemClass} block h-full w-full object-cover`}
            controls={!compact}
            autoPlay={compact}
            muted={compact}
            loop={compact}
            playsInline
            preload={compact ? 'metadata' : 'none'}
            onPointerDown={stopNodeActivation}
            onClick={stopNodeActivation}
          />
        ) : liveFrame ? (
          <img
            src={`data:image/png;base64,${liveFrame}`}
            alt={`${title} ${activeKind} generation preview`}
            className={`${previewItemClass} block h-full w-full object-cover`}
          />
        ) : showStill ? (
          <MediaImage
            src={`/data/images/${node.image}`}
            alt={`${title} image preview`}
            className={`${previewItemClass} block h-full w-full object-cover`}
          />
        ) : showSpinner ? (
          <div className={`${previewItemClass} grid h-full min-h-16 place-items-center text-port-accent`}>
            <Loader2 size={compact ? 16 : 22} className="animate-spin" aria-hidden="true" />
          </div>
        ) : (
          <div className={`${previewItemClass} flex h-full min-h-16 flex-col items-center justify-center gap-1 text-port-text-muted`}>
            <ImagePlus size={compact ? 15 : 22} aria-hidden="true" />
            <span className={compact ? 'text-[9px]' : 'text-xs'}>No scene media yet</span>
          </div>
        )}

        {activeLabel && (
          <div className={`port-media-overlay ${noticePositionClass} px-2 py-1 text-center text-[9px] font-medium`} role="status">
            {activeLabel}
          </div>
        )}
        {noticeLabel && (
          <div
            className={`port-media-overlay-strong ${noticePositionClass} flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-port-error`}
            role={compact ? 'alert' : undefined}
            title={noticeJob.error || noticeLabel}
          >
            <AlertCircle size={10} aria-hidden="true" /> {noticeLabel}
          </div>
        )}
      </div>

      <div
        className={`grid shrink-0 gap-1 ${compact ? 'grid-cols-3' : 'grid-cols-2'}`}
        onPointerDown={stopNodeActivation}
        onClick={stopNodeActivation}
        onKeyDown={stopNodeActivation}
      >
        <button
          type="button"
          onClick={() => onGenerateImage?.(node)}
          disabled={imageActive || generationDisabled || !onGenerateImage}
          title={generationDisabledReason || (node.image ? 'Regenerate scene image' : 'Generate scene image')}
          className={buttonClass}
        >
          {imageActive ? <Loader2 size={compact ? 10 : 12} className="animate-spin" /> : <ImagePlus size={compact ? 10 : 12} />}
          <span className="truncate">{imageActive ? 'Generating image' : node.image ? 'Regenerate image' : 'Generate image'}</span>
        </button>
        <button
          type="button"
          onClick={() => onGenerateVideo?.(node)}
          disabled={videoActive || generationDisabled || !onGenerateVideo}
          title={generationDisabledReason || (node.videoHistoryId ? 'Regenerate scene video' : 'Generate scene video')}
          className={buttonClass}
        >
          {videoActive ? <Loader2 size={compact ? 10 : 12} className="animate-spin" /> : <Video size={compact ? 10 : 12} />}
          <span className="truncate">{videoActive ? 'Generating video' : node.videoHistoryId ? 'Regenerate video' : 'Generate video'}</span>
        </button>
        <button
          type="button"
          onClick={() => onOpenFalVideo?.(node)}
          disabled={freeToolDisabled || !onOpenFalVideo}
          title={freeToolDisabledReason || 'Copy this scene prompt and open fal H3 Max (up to 15 free browser renders per day with an account)'}
          className={buttonClass}
        >
          <ExternalLink size={compact ? 10 : 12} aria-hidden="true" />
          <span className="truncate">fal.ai free</span>
        </button>
        {!compact && (
          <button
            type="button"
            onClick={() => setVideoPickerOpen(true)}
            disabled={!onAttachVideo}
            title="Attach a downloaded fal MP4 or another video from Media History"
            className={buttonClass}
          >
            <Upload size={12} aria-hidden="true" />
            <span className="truncate">Attach video</span>
          </button>
        )}
      </div>

      {noticeLabel && !compact && (
        <p className="flex items-start gap-1 text-xs text-port-error" role="alert">
          <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{noticeLabel}{noticeJob.error ? `: ${noticeJob.error}` : ''}</span>
        </p>
      )}
      {generationDisabledReason && !noticeLabel && !compact && (
        <p className="text-xs text-port-text-muted" role="status">{generationDisabledReason}</p>
      )}
      {!compact && (
        <GalleryVideoPicker
          open={videoPickerOpen}
          onClose={() => setVideoPickerOpen(false)}
          onSelect={(item) => onAttachVideo?.(node, item)}
          allowUpload
          uploadToGallery
          accept="video/mp4,.mp4"
        />
      )}
    </div>
  );
}
