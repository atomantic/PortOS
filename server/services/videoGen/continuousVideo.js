/**
 * Continuous-video episode orchestrator (#6217's end-to-end generation slice).
 * Composes the script-to-beats compiler (#6225) and the prompt linter (#6226)
 * with sequential submission to a chosen video backend, then stitches the
 * completed clips into one episode.
 *
 * Sequence, per episode: compile the script into clips, lint every clip's
 * prompt BEFORE any generation starts (a lint failure never reaches a
 * backend), then submit clips one at a time in chain order — a 'continue'
 * clip conditions on the clip before it (a last-frame still for local/fal, or
 * `continue_from_clip_id` for reactor's native continuation); a 'fresh' clip
 * starts unconditioned. When a continuation submission or render fails, the
 * chain re-attempts that ONE clip unconditioned (a fresh re-establish) rather
 * than aborting the whole episode — a broken mid-chain link should degrade to
 * a visible cut, not sink everything rendered before it.
 *
 * No route/HTTP concerns here — `server/routes/continuousVideoEpisode.js`
 * exposes this over SSE progress, mirroring `chainedVideo.js`'s outer-job
 * pattern for its own multi-clip chain.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, closeJobAfterDelay, attachSseClient as attachSse } from '../../lib/sseUtils.js';
import { compileScriptToClips } from '../../lib/scriptVideoCompiler.js';
import { lintClips } from '../../lib/videoPromptLinter.js';
import { videoGenEvents } from './events.js';
import { extractLastFrame } from './frameExtraction.js';
import { getHistoryItem } from './history.js';
import { stitchVideos } from './stitchVideos.js';

export const CONTINUOUS_VIDEO_BACKENDS = Object.freeze(['local', 'reactor', 'fal']);

// Deferred rather than a static top-level import: each backend module (in
// particular the local runtime's model-registry/HF-cache closure) is heavy,
// and most callers of this file only ever exercise ONE of the three — see the
// "widely-reached module" import-scoping rule in server/AGENTS.md.
const BACKEND_MODULES = {
  local: () => import('./generateVideo.js'),
  reactor: () => import('./reactor.js'),
  fal: () => import('./fal.js'),
};

// Process-local outer-job registry for episode SSE progress — separate from
// videoJobState (local-lane only) and from reactor.js/fal.js's own per-backend
// job maps, because one episode's chain can run against any single backend.
const episodeJobs = new Map();

export const attachEpisodeSseClient = (jobId, res) => attachSse(episodeJobs, jobId, res);

/**
 * Compile a script against a bible and attach what the linter needs: the
 * `Hard cut to <framing>:` opener on every 'continue' clip that has a framing
 * assigned, and the bible references (cast + scene location) each clip's
 * prompt must carry verbatim. Deliberately does not invent a framing when the
 * caller omits one for a continuing clip — that surfaces as a lint failure
 * ("missing hard-cut opener") rather than silently passing an unmarked cut.
 *
 * @param {Array<{sceneId?: string, location?: string, lines: Array}>} scenes
 * @param {object} bible
 * @param {string[]} [framings] - camera framing/angle for clip i, parallel to
 *   the compiled clip array (`compileScriptToClips`'s emission order).
 * @param {object} [compilerOptions] - forwarded to compileScriptToClips.
 */
export function composeEpisodeClips({ scenes, bible, framings = [], compilerOptions = {} } = {}) {
  const clips = compileScriptToClips({ scenes, bible, ...compilerOptions });
  return clips.map((clip, index) => {
    const framing = framings[index] || null;
    const locationId = scenes?.[clip.sceneIndex]?.location ?? null;
    const references = [
      ...clip.speakers.map((id) => ({ kind: 'cast', id })),
      ...(locationId ? [{ kind: 'locations', id: locationId }] : []),
    ];
    const prompt = clip.cutType === 'continue' && framing
      ? `Hard cut to ${framing}: ${clip.prompt}`
      : clip.prompt;
    return {
      ...clip, framing, references, prompt,
    };
  });
}

const backendJobParams = ({ backend, clip, conditioning, renderOptions, jobId }) => {
  if (backend === 'reactor') {
    return {
      settings: renderOptions.settings,
      prompt: clip.prompt,
      negativePrompt: renderOptions.negativePrompt,
      continueFromClipId: conditioning.continueFromClipId || undefined,
      sourceImagePath: conditioning.sourceImagePath || null,
      seconds: renderOptions.reactorSeconds ?? clip.durationSeconds,
      seed: renderOptions.seed,
      jobId,
    };
  }
  if (backend === 'fal') {
    return {
      settings: renderOptions.settings,
      modelId: renderOptions.falModelId,
      prompt: clip.prompt,
      negativePrompt: renderOptions.negativePrompt,
      duration: renderOptions.falDuration ?? clip.durationSeconds,
      aspectRatio: renderOptions.aspectRatio,
      width: renderOptions.width,
      height: renderOptions.height,
      sourceImagePath: conditioning.sourceImagePath || null,
      jobId,
    };
  }
  return {
    pythonPath: renderOptions.pythonPath,
    prompt: clip.prompt,
    negativePrompt: renderOptions.negativePrompt,
    modelId: renderOptions.modelId,
    width: renderOptions.width,
    height: renderOptions.height,
    fps: clip.fps,
    numFrames: clip.frames,
    sourceImagePath: conditioning.sourceImagePath || null,
    mode: conditioning.sourceImagePath ? 'image' : 'text',
    hidden: true,
    jobId,
  };
};

// Wait for the backend's own `completed`/`failed` videoGenEvents pair for one
// inner clip render — the same event contract chainedVideo.js's runChunk()
// consumes, shared by local/reactor/fal generateVideo(). Returns `detach`
// alongside the promise so a caller whose `generate()` call throws/rejects
// SYNCHRONOUSLY (before it ever gets to emit 'failed') can still unregister
// these listeners itself — otherwise they leak on videoGenEvents forever,
// each holding a promise nothing will ever settle.
function awaitClipCompletion(innerJobId) {
  let detach;
  const promise = new Promise((resolve, reject) => {
    detach = () => {
      videoGenEvents.off('completed', onCompleted);
      videoGenEvents.off('failed', onFailed);
    };
    const onCompleted = (e) => {
      if (e.generationId !== innerJobId) return;
      detach();
      resolve(e);
    };
    const onFailed = (e) => {
      if (e.generationId !== innerJobId) return;
      detach();
      reject(new Error(e.error || 'clip generation failed'));
    };
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);
  });
  return { promise, detach };
}

// Build the conditioning the NEXT clip needs from the clip that just
// completed. Reactor conditions natively via continue_from_clip_id (read back
// off the completed clip's history entry); every other backend conditions on
// a still extracted from the completed clip's last frame — the same 'frame'
// hop chainedVideo.js falls back to when no extend pipeline is available.
async function buildConditioning(backend, completedInnerJobId) {
  if (backend === 'reactor') {
    const entry = await getHistoryItem(completedInnerJobId);
    return { continueFromClipId: entry?.clipId || null };
  }
  const frame = await extractLastFrame(completedInnerJobId).catch(() => null);
  if (!frame?.filename) return { sourceImagePath: null };
  return { sourceImagePath: join(PATHS.images, frame.filename) };
}

/**
 * Generate one continuous-video episode: compile + lint the script, then
 * submit each clip in chain order to `backend`, stitching the completed
 * clips into a single episode video.
 *
 * @param {object} params
 * @param {Array} params.scenes
 * @param {object} params.bible
 * @param {string[]} [params.framings]
 * @param {'local'|'reactor'|'fal'} [params.backend]
 * @param {object} [params.renderOptions] - backend render knobs (modelId,
 *   width, height, negativePrompt, seed, pythonPath, falModelId, settings, …)
 *   — `settings`/`pythonPath` are server-resolved; never accept them from a
 *   client request.
 * @param {object} [params.compilerOptions] - forwarded to compileScriptToClips
 * @param {string} [params.jobId] - outer episode job id; minted when absent
 * @param {Array} [params.clips] - a caller-precomposed + already-linted clip
 *   array (`composeEpisodeClips` + a passing `lintClips`) — skips recompiling
 *   and re-linting the script, for a caller (the route) that already did both
 *   to fail fast before this async orchestration starts.
 */
export async function generateContinuousVideoEpisode({
  scenes, bible, framings = [], backend = 'local', renderOptions = {}, compilerOptions = {}, jobId, clips: precomposedClips,
} = {}) {
  if (!CONTINUOUS_VIDEO_BACKENDS.includes(backend)) {
    throw new ServerError(`Unknown continuous-video backend: ${backend}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const outerJobId = jobId || randomUUID();
  const clips = precomposedClips || composeEpisodeClips({
    scenes, bible, framings, compilerOptions,
  });
  if (!precomposedClips) {
    const lint = lintClips(clips, { bible });
    if (!lint.pass) {
      return {
        ok: false, jobId: outerJobId, stage: 'lint', lint, clips,
      };
    }
  }
  if (clips.length === 0) {
    return {
      ok: false, jobId: outerJobId, stage: 'lint', error: 'Script compiled to zero clips',
    };
  }

  const { generateVideo: generate } = await BACKEND_MODULES[backend]();
  const outerJob = { id: outerJobId, clients: [], status: 'running' };
  episodeJobs.set(outerJobId, outerJob);

  // `progress` is CLIPS COMPLETED / total — index/clips.length while clip
  // `index` is still in flight, so the fraction only reaches 1.0 once every
  // clip has completed and stitching is what's left (see the pre-stitch call
  // below).
  const emitProgress = (index, message) => {
    const progress = index / clips.length;
    const fullMessage = `Clip ${index + 1}/${clips.length}${message ? ` — ${message}` : ''}`;
    videoGenEvents.emit('progress', { generationId: outerJobId, progress, message: fullMessage });
    broadcastSse(outerJob, { type: 'progress', progress, message: fullMessage });
  };

  const runOneClip = async (clip, conditioning) => {
    const innerJobId = randomUUID();
    const params = backendJobParams({
      backend, clip, conditioning, renderOptions, jobId: innerJobId,
    });
    // Listeners are registered BEFORE `generate` is even invoked, so no
    // completion event it emits can fire before we're listening for it. If
    // `generate` itself throws/rejects (a synchronous validation error, never
    // reaching its own 'failed' emit), detach here — otherwise these
    // listeners would leak on videoGenEvents forever.
    const { promise: completion, detach } = awaitClipCompletion(innerJobId);
    await generate(params).catch((err) => {
      detach();
      throw err;
    });
    await completion;
    return { innerJobId };
  };

  const clipIds = [];
  let previousClip = null;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    emitProgress(i, clip.cutType === 'continue' ? 'continuing' : 'establishing');
    const wantsContinuation = clip.cutType === 'continue' && previousClip;
    const conditioning = wantsContinuation
      // eslint-disable-next-line no-await-in-loop
      ? await buildConditioning(backend, previousClip)
      : {};

    // eslint-disable-next-line no-await-in-loop
    let outcome = await runOneClip(clip, conditioning).catch((err) => ({ error: err.message }));
    if (outcome.error && wantsContinuation) {
      console.log(`⚠️ Continuous video [${outerJobId.slice(0, 8)}] clip ${i + 1}/${clips.length} continuation failed (${outcome.error}) — re-establishing fresh`);
      // eslint-disable-next-line no-await-in-loop
      outcome = await runOneClip(clip, {}).catch((err) => ({ error: err.message }));
    }
    if (outcome.error) {
      videoGenEvents.emit('failed', { generationId: outerJobId, error: outcome.error });
      broadcastSse(outerJob, { type: 'error', error: outcome.error });
      closeJobAfterDelay(episodeJobs, outerJobId);
      return {
        ok: false, jobId: outerJobId, stage: 'generation', failedClipIndex: i, error: outcome.error, clipIds,
      };
    }
    clipIds.push(outcome.innerJobId);
    previousClip = outcome.innerJobId;
  }

  videoGenEvents.emit('progress', { generationId: outerJobId, progress: 1, message: 'Stitching episode' });
  broadcastSse(outerJob, { type: 'progress', progress: 1, message: 'Stitching episode' });

  const stitched = await stitchVideos(clipIds, {
    id: outerJobId,
    filenamePrefix: 'episode',
    historyKey: 'chainedFrom',
  }).catch((err) => ({ error: err.message }));
  if (stitched?.error) {
    videoGenEvents.emit('failed', { generationId: outerJobId, error: `Stitch failed: ${stitched.error}` });
    broadcastSse(outerJob, { type: 'error', error: `Stitch failed: ${stitched.error}` });
    closeJobAfterDelay(episodeJobs, outerJobId);
    return {
      ok: false, jobId: outerJobId, stage: 'stitch', error: stitched.error, clipIds,
    };
  }

  const result = {
    ok: true,
    jobId: outerJobId,
    filename: stitched.filename,
    thumbnail: stitched.thumbnail,
    path: `/data/videos/${stitched.filename}`,
    clipIds,
  };
  videoGenEvents.emit('completed', { generationId: outerJobId, ...result });
  broadcastSse(outerJob, { type: 'complete', result });
  closeJobAfterDelay(episodeJobs, outerJobId);
  return result;
}
