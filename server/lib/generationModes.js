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
  // fal.ai's metered queue REST API (services/imageGen/fal.js) — the same
  // literal as VIDEO_GEN_MODE.FAL below: one provider, one key, one id.
  FAL: 'fal',
  RUNWAY: 'runway',
});

export const IMAGE_GEN_MODES = Object.freeze(Object.values(IMAGE_GEN_MODE));

// Cloud image backends spend remote quota or metered credit and run
// through the media queue's parallel cloud lane rather than the local
// accelerator lane.
export const CLOUD_IMAGE_GEN_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.GROK,
  IMAGE_GEN_MODE.AGY,
  IMAGE_GEN_MODE.FAL,
  IMAGE_GEN_MODE.RUNWAY,
]);

// The external SD-API backend remains synchronous; every other image backend
// can be queued through mediaJobQueue.
export const QUEUEABLE_IMAGE_MODES = Object.freeze([
  IMAGE_GEN_MODE.LOCAL,
  ...CLOUD_IMAGE_GEN_MODES,
]);

// Video deliberately shares the image backend discriminator namespace. Local
// video's text/image/fflf modes are a separate semantic value carried elsewhere.
// REACTOR has no image-gen counterpart.
export const VIDEO_GEN_MODE = Object.freeze({
  LOCAL: IMAGE_GEN_MODE.LOCAL,
  GROK: IMAGE_GEN_MODE.GROK,
  FAL: IMAGE_GEN_MODE.FAL,
  REACTOR: 'reactor',
  // Runway's developer API (services/videoGen/runway.js).
  RUNWAY: IMAGE_GEN_MODE.RUNWAY,
});

export const VIDEO_GEN_MODES = Object.freeze(Object.values(VIDEO_GEN_MODE));
export const CLOUD_VIDEO_GEN_MODES = Object.freeze([
  VIDEO_GEN_MODE.GROK, VIDEO_GEN_MODE.FAL, VIDEO_GEN_MODE.REACTOR, VIDEO_GEN_MODE.RUNWAY,
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
 * route handler, the client's re-export — can classify a job
 * without importing the queue.
 */
export const MEDIA_JOB_EXECUTION_LANES = Object.freeze(['gpu', 'cloud', 'remote']);

export const mediaJobExecutionLane = ({ kind, mode, remote } = {}) => {
  if (remote) return 'remote';
  if (kind === 'video-upscale' && mode === 'topaz') return 'cloud';
  if (kind === 'image' && CLOUD_IMAGE_GEN_MODES.includes(mode)) return 'cloud';
  if (kind === 'video' && CLOUD_VIDEO_GEN_MODES.includes(mode)) return 'cloud';
  return 'gpu';
};

/**
 * THE media-queue swim lane: the unit that owns its own slots and its own
 * queue positions, so one provider's backlog never holds another's work.
 *
 * Within the cloud lane every provider (codex, grok, fal, …) is its own swim
 * lane; each federated peer is its own swim lane; this machine's accelerator is
 * one swim lane because local image and video renders share the MLX runtime.
 * The execution lane still decides HOW a job runs; the swim lane decides WHO it
 * waits behind.
 *
 * @returns {string} `<lane>:<owner>`, e.g. `cloud:grok`, `remote:<peerId>`, `gpu:local`
 */
export const mediaJobSwimlane = ({ kind, mode, remote, peerId } = {}) => {
  const lane = mediaJobExecutionLane({ kind, mode, remote });
  if (lane === 'cloud') return `cloud:${mode}`;
  if (lane === 'remote') return `remote:${peerId || 'unknown'}`;
  return 'gpu:local';
};
