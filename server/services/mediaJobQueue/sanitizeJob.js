import { effectiveJobPrompt } from '../../lib/federatedMediaWire.js';
import { isRemoteMediaJob } from './remoteMediaJob.js';

// Public projection of a media job. Keep worker-only paths and subprocess
// details out of both the queue API and the processing dashboard.
const PARAM_ALLOWLIST = new Set([
  'prompt', 'negativePrompt', 'modelId', 'model', 'effort',
  'width', 'height', 'numFrames', 'fps', 'steps', 'guidanceScale',
  'seed', 'tiling', 'disableAudio', 'mode', 'imageStrength',
  'textEncoderId', 'chunks', 'chunkPrompts', 'contextFrames', 'loras',
  'cfgScale', 'guidance', 'quantize',
  'runId', 'runtime', 'datasetId', 'characterId', 'characterName',
  'triggerWord', 'rank', 'baseModelId', 'spriteRef', 'spriteWalk',
]);

const MUSIC_STUDIO_KEYS = new Set([
  'trackId', 'title', 'artistId', 'artist', 'albumId', 'lyricsEnabled', 'lyricsProvided', 'instrumentalOnly',
]);

export function sanitizeJob(job) {
  if (!job) return job;
  const safeParams = job.params
    ? Object.fromEntries(Object.entries(job.params)
      .filter(([key]) => PARAM_ALLOWLIST.has(key) || key === 'musicStudio')
      .map(([key, value]) => [
        key,
        key === 'musicStudio' && value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).filter(([nestedKey]) => MUSIC_STUDIO_KEYS.has(nestedKey)))
          : value,
      ]))
    : undefined;
  // A remote job's conditioning text lives inside its versioned marker, never
  // in top-level params — that is what makes an older build (which cannot route
  // the marker) fail closed instead of quietly re-rendering the job locally.
  // Rebuild the prompt for the public projection without exposing private peer
  // routing state.
  const remotePrompt = effectiveJobPrompt(job);
  // The model id is nulled in top-level params for the same reason (#4683), so
  // rebuild it from the marker too — the Render Queue's model badge reads
  // `params.modelId`, and every routed kind (audio included: routes/music.js
  // requires an explicit `modelId` for a peer render) carries it on the wire
  // request. This branch is now the ONLY source of a routed job's model id.
  const routed = isRemoteMediaJob(job);
  const remoteModelId = job.params?.remoteMedia?.request?.modelId;
  if (safeParams && routed) {
    if (remotePrompt) safeParams.prompt = remotePrompt;
    if (typeof remoteModelId === 'string' && remoteModelId) safeParams.modelId = remoteModelId;
  }
  return {
    id: job.id,
    kind: job.kind,
    // Where this job renders. Job metadata, not a render input, so it rides on
    // the envelope rather than inside `params` — the PARAM_ALLOWLIST above stays
    // an exact description of what a projected `params` can contain. The UI
    // needs it because a peer render must not wear the local model badge.
    renderer: routed ? 'remote' : 'local',
    owner: job.owner,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    position: job.position,
    progress: job.progress,
    statusMsg: job.statusMsg,
    // Geometry the gen module resolved to (#4588) — the render's own edges after
    // any model-grid snapping, NOT the requested `params.width/height`. Lives on
    // the envelope rather than in `params` because it is an OUTPUT of the run.
    // Absent until the gen run reports it; `undefined` means "not reported",
    // which a preview stage must not read as a geometry.
    render: job.render,
    etaMs: job.etaMs,
    error: job.error,
    result: job.result,
    params: safeParams,
  };
}
