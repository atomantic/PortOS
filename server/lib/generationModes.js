/**
 * Shared image/video render-backend alphabets.
 *
 * These constants sit below both validation and the generation services so a
 * schema can enumerate a backend without importing service-layer orchestration.
 * The service mode modules re-export the same bindings for compatibility.
 */

export const IMAGE_GEN_MODE = Object.freeze({
  EXTERNAL: 'external',
  LOCAL: 'local',
  CODEX: 'codex',
  GROK: 'grok',
  AGY: 'agy',
});

export const IMAGE_GEN_MODES = Object.freeze(Object.values(IMAGE_GEN_MODE));

// Cloud-CLI image backends spend remote quota and run through the media queue's
// parallel cloud lane rather than the local accelerator lane.
export const CLOUD_IMAGE_GEN_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.GROK,
  IMAGE_GEN_MODE.AGY,
]);

// The external SD-API backend remains synchronous; every other image backend
// can be queued through mediaJobQueue.
export const QUEUEABLE_IMAGE_MODES = Object.freeze([
  IMAGE_GEN_MODE.LOCAL,
  ...CLOUD_IMAGE_GEN_MODES,
]);

// Video deliberately shares the image backend discriminator namespace. Local
// video's text/image/fflf modes are a separate semantic value carried elsewhere.
// FAL and REACTOR have no image-gen counterpart (issues #6213/#6214 are
// video-only), so they are video-only literals rather than re-exports of an
// IMAGE_GEN_MODE entry.
export const VIDEO_GEN_MODE = Object.freeze({
  LOCAL: IMAGE_GEN_MODE.LOCAL,
  GROK: IMAGE_GEN_MODE.GROK,
  FAL: 'fal',
  REACTOR: 'reactor',
});

export const VIDEO_GEN_MODES = Object.freeze(Object.values(VIDEO_GEN_MODE));
export const CLOUD_VIDEO_GEN_MODES = Object.freeze([
  VIDEO_GEN_MODE.GROK, VIDEO_GEN_MODE.FAL, VIDEO_GEN_MODE.REACTOR,
]);

/**
 * THE media-queue execution-lane rule, shared by the scheduler and the public
 * job projection so the UI can never drift from how a job is actually run.
 *
 * `remote` wins outright — a federated job is executed by a peer whatever
 * backend it names. Otherwise the cloud alphabets above decide: a cloud-CLI
 * image or video backend shells out to an external provider and runs in the
 * parallel cloud lane, while everything else (local video's text/image/fflf
 * semantic modes included) serializes on the local accelerator.
 *
 * Kept here rather than in mediaJobQueue so a light consumer — sanitizeJob, a
 * route handler, a client mirror's counterpart test — can classify a job
 * without importing the queue.
 */
export const MEDIA_JOB_EXECUTION_LANES = Object.freeze(['gpu', 'cloud', 'remote']);

export const mediaJobExecutionLane = ({ kind, mode, remote } = {}) => {
  if (remote) return 'remote';
  if (kind === 'image' && CLOUD_IMAGE_GEN_MODES.includes(mode)) return 'cloud';
  if (kind === 'video' && CLOUD_VIDEO_GEN_MODES.includes(mode)) return 'cloud';
  return 'gpu';
};
