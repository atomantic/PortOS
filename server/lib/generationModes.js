/**
 * Shared immutable image/video render-backend alphabets, display labels, and the media-queue lane and swim-lane rules.
 *
 * Covers `IMAGE_GEN_MODE[S]`, `QUEUEABLE_IMAGE_MODES`,
 * `VIDEO_GEN_MODE[S]`, cloud subsets, plus `mediaJobExecutionLane(...)` / `MEDIA_JOB_EXECUTION_LANES`
 * (THE media-queue lane rule) and `mediaJobSwimlane(...)`, the per-provider / per-peer / local
 * swim-lane key, kept below validation and generation services so schemas never import orchestration.
 */

export const IMAGE_GEN_MODE = Object.freeze({
  EXTERNAL: 'external',
  LOCAL: 'local',
  CODEX: 'codex',
  GROK: 'grok',
  AGY: 'agy',
  // fal.ai's metered queue REST API; same literal as VIDEO_GEN_MODE.FAL (one provider, one key, one id).
  FAL: 'fal',
  RUNWAY: 'runway',
  HIGGSFIELD: 'higgsfield',
  GOOGLE: 'google',
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
  IMAGE_GEN_MODE.HIGGSFIELD,
  IMAGE_GEN_MODE.GOOGLE,
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
  RUNWAY: IMAGE_GEN_MODE.RUNWAY,
  // Gemini Omni through the Gemini web app in the PortOS Browser.
  GEMINI: 'gemini',
  HIGGSFIELD: IMAGE_GEN_MODE.HIGGSFIELD,
  GOOGLE: IMAGE_GEN_MODE.GOOGLE,
});

export const VIDEO_GEN_MODES = Object.freeze(Object.values(VIDEO_GEN_MODE));
export const CLOUD_VIDEO_GEN_MODES = Object.freeze([
  VIDEO_GEN_MODE.GROK, VIDEO_GEN_MODE.FAL, VIDEO_GEN_MODE.REACTOR, VIDEO_GEN_MODE.RUNWAY, VIDEO_GEN_MODE.GEMINI, VIDEO_GEN_MODE.HIGGSFIELD, VIDEO_GEN_MODE.GOOGLE,
]);

export const GENERATION_MODE_LABELS = Object.freeze({
  [IMAGE_GEN_MODE.LOCAL]: 'Local',
  [IMAGE_GEN_MODE.CODEX]: 'Codex',
  [IMAGE_GEN_MODE.GROK]: 'Grok',
  [IMAGE_GEN_MODE.AGY]: 'Agy',
  [IMAGE_GEN_MODE.EXTERNAL]: 'External',
  [VIDEO_GEN_MODE.FAL]: 'fal.ai',
  [VIDEO_GEN_MODE.REACTOR]: 'Reactor.inc',
  [VIDEO_GEN_MODE.RUNWAY]: 'Runway',
  [VIDEO_GEN_MODE.GEMINI]: 'Gemini',
  [VIDEO_GEN_MODE.HIGGSFIELD]: 'Higgsfield',
  [VIDEO_GEN_MODE.GOOGLE]: 'Google',
});

/**
 * THE media-queue execution-lane rule, shared by the scheduler and the public job projection so the UI
 * can't drift from how a job runs. `remote` wins outright (a peer executes it whatever backend it
 * names); otherwise the cloud alphabets decide, and everything else (local video's text/image/fflf
 * modes included) serializes on the local accelerator. Lives here, not in mediaJobQueue, so light
 * consumers can classify a job without importing the queue.
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
 * THE media-queue swim lane: the unit owning its own slots and queue positions, so one provider's
 * backlog never holds another's work. Each cloud provider and each federated peer is its own lane; this
 * machine's accelerator is one lane (local image and video share the MLX runtime). The execution lane
 * decides HOW a job runs, the swim lane WHO it waits behind.
 *
 * @returns {string} `<lane>:<owner>`, e.g. `cloud:grok`, `remote:<peerId>`, `gpu:local`
 */
export const mediaJobSwimlane = ({ kind, mode, remote, peerId } = {}) => {
  const lane = mediaJobExecutionLane({ kind, mode, remote });
  if (lane === 'cloud') return kind ? `cloud:${kind}:${mode}` : `cloud:${mode}`;
  if (lane === 'remote') return `remote:${peerId || 'unknown'}`;
  return 'gpu:local';
};
