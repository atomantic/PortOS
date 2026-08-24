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
export const VIDEO_GEN_MODE = Object.freeze({
  LOCAL: IMAGE_GEN_MODE.LOCAL,
  GROK: IMAGE_GEN_MODE.GROK,
});

export const VIDEO_GEN_MODES = Object.freeze(Object.values(VIDEO_GEN_MODE));
export const CLOUD_VIDEO_GEN_MODES = Object.freeze([VIDEO_GEN_MODE.GROK]);
