/** Classify native video callbacks before the scheduler publishes a preview frame. */
export function classifyPreviewPlaybackFrame(owner, item, metadata, at, sourceTarget, fps) {
  const video = owner.video;
  const mediaTime = metadata?.mediaTime, frames = metadata?.presentedFrames;
  if (!Number.isFinite(mediaTime) || mediaTime < 0 || !Number.isSafeInteger(frames) || frames < 0
    || (owner.mediaTime != null && (mediaTime < owner.mediaTime || frames < owner.presentedFrames))) return { status: 'resync', drift: 0.1 };
  const duplicate = owner.mediaTime != null && (mediaTime === owner.mediaTime || frames === owner.presentedFrames);
  owner.presentedFrames = frames;
  // Duplicates never extend the freshness deadline.
  if (duplicate) return { status: 'skip' };
  const drift = mediaTime - sourceTarget(item);
  if (video.readyState < 2 || video.seeking || video.paused || Math.abs(drift) >= 0.1) return { status: 'resync', drift };
  owner.mediaTime = mediaTime; owner.lastFreshAt = at;
  // A <=30 fps source publishes every fresh callback, independent of
  // audio/RAF phase. Faster sources share source-time-relative bins.
  if (owner.origin == null) owner.origin = mediaTime;
  const bucket = Math.floor((mediaTime - owner.origin) * fps + 1e-6);
  if (item.scene.media.fps > fps && bucket === owner.bucket) return { status: 'skip' };
  owner.bucket = bucket;
  return { status: 'ready' };
}
