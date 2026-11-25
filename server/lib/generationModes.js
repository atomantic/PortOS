/**
 * Shared generation backend alphabets and labels, music engine readiness, and media-queue routing rules.
 *
 * Covers `IMAGE_GEN_MODE[S]`, `QUEUEABLE_IMAGE_MODES`,
 * `VIDEO_GEN_MODE[S]`, cloud subsets, plus `mediaJobExecutionLane(...)` / `MEDIA_JOB_EXECUTION_LANES`
 * (THE media-queue lane rule) and `mediaJobSwimlane(...)`, the per-provider / per-peer / local
 * swim-lane key, kept below validation and generation services so schemas never import orchestration.
 */

const LOCAL = 'local';
const EXTERNAL = 'external';

// One row per backend, ordered so each lane and the shared labels retain their
// published order. Local and external participate only in the mode alphabets.
const GENERATION_BACKENDS = Object.freeze([
  { id: LOCAL, label: 'Local', hosted: false },
  { id: 'codex', label: 'Codex', image: true },
  { id: 'grok', label: 'Grok', image: true, video: true, enabledSetting: 'imageGen.grok.enabled' },
  { id: 'agy', label: 'Agy', image: true },
  { id: EXTERNAL, label: 'External', hosted: false },
  { id: 'fal', label: 'fal.ai', image: true, video: true, credentialId: 'fal', metered: true },
  { id: 'reactor', label: 'Reactor.inc', video: true, credentialId: 'reactor', metered: true },
  { id: 'runway', label: 'Runway', image: true, video: true, credentialId: 'runway', metered: true },
  // Only the render can check whether the PortOS Browser is signed in.
  { id: 'gemini', label: 'Gemini', video: true, alwaysUsable: true },
  { id: 'higgsfield', label: 'Higgsfield', image: true, video: true, credentialId: 'higgsfield', metered: true },
  { id: 'google', label: 'Google', image: true, video: true, credentialId: 'google-cloud', metered: true },
].map(Object.freeze));

export const HOSTED_MEDIA_BACKENDS = Object.freeze(GENERATION_BACKENDS.filter(({ hosted }) => hosted !== false));

export const CLOUD_IMAGE_GEN_MODES = Object.freeze(HOSTED_MEDIA_BACKENDS.filter(({ image }) => image).map(({ id }) => id));
export const CLOUD_VIDEO_GEN_MODES = Object.freeze(HOSTED_MEDIA_BACKENDS.filter(({ video }) => video).map(({ id }) => id));
export const METERED_IMAGE_GEN_MODES = Object.freeze(HOSTED_MEDIA_BACKENDS.filter(({ image, metered }) => image && metered).map(({ id }) => id));

const modeEnum = (ids) => Object.freeze(Object.fromEntries(ids.map(id => [id.toUpperCase(), id])));

// External SD-API remains synchronous; every other image backend is queueable.
export const QUEUEABLE_IMAGE_MODES = Object.freeze([LOCAL, ...CLOUD_IMAGE_GEN_MODES]);
export const IMAGE_GEN_MODES = Object.freeze([EXTERNAL, ...QUEUEABLE_IMAGE_MODES]);
export const IMAGE_GEN_MODE = modeEnum(IMAGE_GEN_MODES);

// Local video's text/image/fflf modes are a separate semantic value.
export const VIDEO_GEN_MODES = Object.freeze([LOCAL, ...CLOUD_VIDEO_GEN_MODES]);
export const VIDEO_GEN_MODE = modeEnum(VIDEO_GEN_MODES);

export const GENERATION_MODE_LABELS = Object.freeze(Object.fromEntries(GENERATION_BACKENDS.map(({ id, label }) => [id, label])));

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

/** Check a music engine's capabilities for the chosen checkpoint (or the aggregate in the Music catalog). */
export function musicEngineReadinessReason(engine, modelReady) {
  if (!engine.platformSupported) return 'platform-unsupported';
  if (!engine.runtimeReady) return 'runtime-unavailable';
  if (engine.cudaRequired && engine.cudaState !== 'available') {
    return engine.cudaState === 'unknown' ? 'cuda-unknown' : 'cuda-absent';
  }
  // Older capabilities omit vramState. Local probes always set it and fail
  // closed when a CUDA engine's execution profile cannot be measured.
  if (engine.cudaRequired && engine.vramState != null && engine.vramState !== 'sufficient') {
    return engine.vramState === 'unknown-size' ? 'vram-unknown-size' : 'vram-insufficient';
  }
  return modelReady ? null : 'model-unavailable';
}

export function musicEngineReadinessMessage(engine, reason) {
  switch (reason) {
    case 'platform-unsupported':
      return `${engine.name} requires ${engine.platformLabel || 'a different platform'}.`;
    case 'runtime-unavailable':
      return `${engine.name} runtime is unavailable.`;
    case 'cuda-unknown':
      return `CUDA availability for ${engine.name} could not be determined.`;
    case 'cuda-absent':
      return `${engine.name} requires an available NVIDIA CUDA GPU.`;
    case 'vram-unknown-size':
      return `The GPU VRAM requirement for ${engine.name} has not been measured for the ${engine.vramProfileLabel || 'selected'} execution profile.`;
    case 'vram-insufficient':
      return `${engine.name} requires at least ${engine.minVramGb} GB of VRAM for the ${engine.vramProfileLabel || 'selected'} profile. This host reports ${engine.maxVramGb} GB.`;
    case 'model-unavailable':
      return `The selected ${engine.name} model weights are not installed. Install them from Music → Generate.`;
    case 'unknown-engine':
      return 'The configured music engine is no longer available.';
    default:
      return null;
  }
}
