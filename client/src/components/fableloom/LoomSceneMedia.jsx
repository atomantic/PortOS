import { useState } from 'react';
import { AlertCircle, ImagePlus, Loader2, Sparkles, Upload, Video, XCircle } from 'lucide-react';
import { FAL_H3_MAX_FREE_ALLOWANCE_NOTE } from '../../lib/falVideoHandoff.js';
import GalleryVideoPicker from '../videoGen/GalleryVideoPicker';
import LoomSceneVideoSlot from './LoomSceneVideoSlot';
import LoomSceneStillSlot from './LoomSceneStillSlot';

/**
 * FableLoom's shared scene-media surface.
 *
 * Used in both the graph node and selected-scene editor. A completed video is
 * always the final preview; otherwise the still image (or the current latent
 * frame while rendering) remains visible. Generation controls never disappear,
 * and queued/running/failed/canceled states stay visible after the POST returns.
 */

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
  if (job.source === 'fal-browser' && job.statusMsg) return job.statusMsg;
  const pct = progressPercent(job);
  return job.status === 'submitting'
    ? `Starting ${noun}…`
    : `Generating ${noun}${pct !== null ? ` ${pct}%` : '…'}`;
};

function getSceneMediaNotice(imageJob, videoJob) {
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
  return failedJob || canceledJob;
}

const stopNodeActivation = (event) => event.stopPropagation();

export default function LoomSceneMedia({
  node,
  jobs = {},
  onGenerateImage,
  onGenerateVideo,
  onAutomateFalVideo,
  onAttachVideo,
  onCancelFalVideo,
  compact = false,
  generationDisabled = false,
  generationDisabledReason = '',
  falDisabled,
  falDisabledReason,
}) {
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  const imageJob = jobs.image || null;
  const videoJob = jobs.video || null;
  const imageActive = isActive(imageJob);
  const videoActive = isActive(videoJob);
  const falActive = videoActive && videoJob?.source === 'fal-browser';
  const falRequiresImage = !node.image;
  const freeToolDisabled = (falDisabled ?? generationDisabled) || videoActive || falRequiresImage;
  const configuredFalDisabledReason = falDisabledReason ?? generationDisabledReason;
  const freeToolDisabledReason = configuredFalDisabledReason
    || (falRequiresImage ? 'Generate a scene image first so fal.ai has a starting frame' : '')
    || (videoActive ? 'A scene video is already rendering' : '');
  const activeJob = videoActive ? videoJob : imageActive ? imageJob : null;
  const activeKind = videoActive ? 'video' : imageActive ? 'image' : null;
  const noticeJob = getSceneMediaNotice(imageJob, videoJob);
  const noticeLabel = noticeJob && jobStateLabel(noticeJob.kind, noticeJob);
  const activeLabel = activeKind && jobStateLabel(activeKind, activeJob);
  const title = node.title || 'Scene';

  // The final video wins. During a new video render its live frame wins; when
  // no live frame exists, retain the still rather than replacing useful visual
  // context with an empty spinner.
  const showFinalVideo = Boolean(node.videoHistoryId) && !videoActive;
  const liveFrame = activeJob?.currentImage || null;

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
          <LoomSceneVideoSlot
            node={node}
            compact={compact}
            title={title}
            previewItemClass={previewItemClass}
            onInteract={stopNodeActivation}
          />
        ) : (
          <LoomSceneStillSlot
            node={node}
            title={title}
            activeKind={activeKind}
            liveFrame={liveFrame}
            generating={Boolean(activeJob)}
            compact={compact}
            previewItemClass={previewItemClass}
          />
        )}
        <SceneMediaPreviewStatus
          compact={compact}
          activeLabel={activeLabel}
          noticeJob={noticeJob}
          noticeLabel={noticeLabel}
          noticePositionClass={noticePositionClass}
        />
      </div>

      <SceneMediaActions
        node={node}
        compact={compact}
        imageActive={imageActive}
        videoActive={videoActive}
        videoJob={videoJob}
        generationDisabled={generationDisabled}
        generationDisabledReason={generationDisabledReason}
        onGenerateImage={onGenerateImage}
        onGenerateVideo={onGenerateVideo}
        onAutomateFalVideo={onAutomateFalVideo}
        falActive={falActive}
        freeToolDisabled={freeToolDisabled}
        freeToolDisabledReason={freeToolDisabledReason}
        onCancelFalVideo={onCancelFalVideo}
        onAttachVideo={onAttachVideo}
        setVideoPickerOpen={setVideoPickerOpen}
      />

      <SceneMediaNotices
        node={node}
        compact={compact}
        noticeJob={noticeJob}
        noticeLabel={noticeLabel}
        generationDisabledReason={generationDisabledReason}
        onAutomateFalVideo={onAutomateFalVideo}
        falRequiresImage={falRequiresImage}
        onAttachVideo={onAttachVideo}
        setVideoPickerOpen={setVideoPickerOpen}
        videoPickerOpen={videoPickerOpen}
      />
    </div>
  );
}

function SceneMediaPreviewStatus({ compact, activeLabel, noticeJob, noticeLabel, noticePositionClass }) {
  return (
    <>
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
    </>
  );
}

function SceneMediaActions({
  node, compact, imageActive, videoActive, videoJob, generationDisabled,
  generationDisabledReason, onGenerateImage, onGenerateVideo, onAutomateFalVideo, falActive,
  freeToolDisabled, freeToolDisabledReason, onCancelFalVideo, onAttachVideo,
  setVideoPickerOpen,
}) {
  // Scene cards are too narrow for three worded chips ("Regen…", "Gener…"),
  // so compact actions are icon buttons; the label stays as the accessible
  // name and the `title` tooltip explains the action.
  const labelClass = compact ? 'sr-only' : 'truncate';
  const buttonClass = compact
    ? 'inline-flex min-h-[26px] min-w-0 items-center justify-center rounded border border-port-border bg-port-bg/80 px-1.5 py-1 text-[9px] text-port-text hover:border-port-accent hover:text-port-accent disabled:opacity-45'
    : 'inline-flex items-center justify-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs text-port-text hover:border-port-accent hover:text-port-accent disabled:opacity-45';
  return (
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
        {imageActive ? <Loader2 size={compact ? 13 : 12} className="animate-spin" /> : <ImagePlus size={compact ? 13 : 12} />}
        <span className={labelClass}>{imageActive ? 'Generating image' : node.image ? 'Regenerate image' : 'Generate image'}</span>
      </button>
      <button
        type="button"
        onClick={() => onGenerateVideo?.(node)}
        disabled={videoActive || generationDisabled || !onGenerateVideo}
        title={generationDisabledReason || (node.videoHistoryId ? 'Regenerate scene video' : 'Generate scene video')}
        className={buttonClass}
      >
        {videoActive ? <Loader2 size={compact ? 13 : 12} className="animate-spin" /> : <Video size={compact ? 13 : 12} />}
        <span className={labelClass}>{videoActive ? 'Generating video' : node.videoHistoryId ? 'Regenerate video' : 'Generate video'}</span>
      </button>
      <button
        type="button"
        onClick={() => onAutomateFalVideo?.(node)}
        disabled={freeToolDisabled || !onAutomateFalVideo}
        title={freeToolDisabledReason || 'Upload the scene image and prompt to fal.ai H3 Max, then save the finished video here'}
        className={buttonClass}
      >
        {falActive
          ? <Loader2 size={compact ? 13 : 12} className="animate-spin" aria-hidden="true" />
          : <Sparkles size={compact ? 13 : 12} aria-hidden="true" />}
        <span className={labelClass}>{falActive ? 'Running fal.ai' : 'Automate fal.ai'}</span>
      </button>
      {!compact && falActive && videoJob?.jobId && onCancelFalVideo && (
        <button
          type="button"
          onClick={() => onCancelFalVideo(node, videoJob)}
          title="Stop this fal.ai render and free the browser queue"
          className={buttonClass}
        >
          <XCircle size={12} aria-hidden="true" />
          <span className="truncate">Cancel fal.ai</span>
        </button>
      )}
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
  );
}

function SceneMediaNotices({
  node, compact, noticeJob, noticeLabel, generationDisabledReason, onAutomateFalVideo,
  falRequiresImage, onAttachVideo, setVideoPickerOpen, videoPickerOpen,
}) {
  return (
    <>
      {noticeLabel && !compact && (
        <p className="flex items-start gap-1 text-xs text-port-error" role="alert">
          <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{noticeLabel}{noticeJob.error ? `: ${noticeJob.error}` : ''}</span>
        </p>
      )}
      {generationDisabledReason && !noticeLabel && !compact && (
        <p className="text-xs text-port-text-muted" role="status">{generationDisabledReason}</p>
      )}
      {!generationDisabledReason && falRequiresImage && !noticeLabel && !compact && (
        <p className="text-xs text-port-text-muted" role="status">
          Generate a scene image first to use it as fal.ai&apos;s starting frame.
        </p>
      )}
      {onAutomateFalVideo && !compact && (
        <p className="text-xs text-port-text-muted" role="note">
          {FAL_H3_MAX_FREE_ALLOWANCE_NOTE}
        </p>
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
    </>
  );
}
