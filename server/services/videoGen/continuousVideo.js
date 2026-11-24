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
 * starts unconditioned. Local callers can explicitly select a verified bounded
 * temporal window instead. When a legacy continuation submission or render fails, the
 * chain re-attempts that ONE clip unconditioned (a fresh re-establish) rather
 * than aborting the whole episode — a broken mid-chain link should degrade to
 * a visible cut, not sink everything rendered before it. Explicit temporal
 * requests fail rather than delivering an unconditioned substitute.
 *
 * No route/HTTP concerns here — `server/routes/continuousVideoEpisode.js`
 * exposes this over SSE progress, mirroring `chainedVideo.js`'s outer-job
 * pattern for its own multi-clip chain.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { probeFrameCount, trimVideoFromFrame } from '../../lib/ffmpeg.js';
import { resolveContinuityRequest, continuationContract, contextPrefixFrames, extendLatentFrames, tailWindowStartFrame } from '../../lib/videoContinuity.js';
import { broadcastSse, closeJobAfterDelay, attachSseClient as attachSse } from '../../lib/sseUtils.js';
import { compileScriptToClips } from '../../lib/scriptVideoCompiler.js';
import { lintClips } from '../../lib/videoPromptLinter.js';
import { trackedRenderMap } from '../renderActivity.js';
import { videoGenEvents } from './events.js';
import { extractLastFrame } from './frameExtraction.js';
import { getHistoryItem } from './history.js';
import { stitchVideos } from './stitchVideos.js';
import { videoContinuityContractError } from './modeContract.js';

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

// Local clips run through mediaJobQueue so they serialize on the single-flight
// GPU lane instead of colliding with queued local renders via direct generateVideo().
const loadMediaJobQueue = () => import('../mediaJobQueue/index.js');

// Live in-flight episodes tracked in renderActivity so Live Activity and the
// unattended updater observe active episodes and clear immediately on settlement.
const activeEpisodes = trackedRenderMap('continuous-video', {
  noun: 'continuous-video episode',
  link: () => '/video-gen?episode=1',
});

// Process-local outer-job SSE replay registry — kept separate from activeEpisodes
// so closeJobAfterDelay can linger terminal frames for late subscribers without
// keeping renderActivity busy after settlement.
const episodeJobs = new Map();

const createAbortError = () => {
  const err = new Error('Episode canceled');
  err.name = 'AbortError';
  err.code = 'EPISODE_CANCELED';
  return err;
};

const isAbortError = (err) => err?.name === 'AbortError' || err?.code === 'EPISODE_CANCELED';

export const attachEpisodeSseClient = (jobId, res) => attachSse(episodeJobs, jobId, res);

export function listActiveContinuousVideoEpisodes() {
  return [...activeEpisodes.values()].map((ep) => ({
    jobId: ep.id,
    generationId: ep.id,
    backend: ep.backend,
    status: ep.cancelRequested ? 'canceling' : 'running',
    totalClips: ep.totalClips,
    startedAt: ep.startedAt,
    progress: typeof ep.outerJob.lastPayload?.progress === 'number' ? ep.outerJob.lastPayload.progress : 0,
    message: ep.outerJob.lastPayload?.message || null,
  }));
}

export async function cancelContinuousVideoEpisode(jobId) {
  const episode = activeEpisodes.get(jobId);
  if (!episode) {
    const existing = episodeJobs.get(jobId);
    if (existing && existing.status !== 'running') {
      return { ok: false, code: 'ALREADY_TERMINAL', status: existing.status, error: `Episode is already ${existing.status}` };
    }
    return { ok: false, code: 'NOT_FOUND', error: 'Episode job not found' };
  }
  episode.cancelRequested = true;
  episode.outerJob.status = 'canceling';
  episode.abortController.abort(createAbortError());
  if (episode.activeInner?.cancel) {
    try {
      await episode.activeInner.cancel();
    } catch (err) {
      console.log(`⚠️ Continuous video [${jobId.slice(0, 8)}] inner cancel reported error: ${err?.message || err}`);
    }
  }
  return { ok: true, jobId, status: 'canceling' };
}

// The route awaits this before returning a running descriptor; direct callers
// recheck it before any clip can reach a backend.
export async function resolveEpisodeContinuity({ backend = 'local', renderOptions = {} } = {}) {
  const { continuityStrategy, contextFrames } = renderOptions;
  if (backend !== 'local') {
    if (continuityStrategy === 'window') {
      throw new ServerError('Temporal window continuation is unavailable on this episode backend.', { status: 400, code: 'VIDEO_TEMPORAL_UNAVAILABLE' });
    }
    return null;
  }
  // Existing episode submissions always used stills, including on LTX. Do not
  // silently change that contract when the caller did not select a strategy.
  if (continuityStrategy == null) return null;
  const { resolveVideoModel, defaultVideoModelId } = await BACKEND_MODULES.local();
  const model = resolveVideoModel(renderOptions.modelId || defaultVideoModelId());
  const error = videoContinuityContractError({ model, continuityStrategy, contextFrames });
  if (error) throw error;
  return resolveContinuityRequest({ model, continuityStrategy, contextFrames });
}

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

const backendJobParams = ({ backend, clip, conditioning, renderOptions, continuation, jobId }) => {
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
    extendFromVideoPath: conditioning.extendFromVideoPath || null,
    historyContext: conditioning.historyContext || null,
    keepExtendSource: false,
    continuityStrategy: renderOptions.continuityStrategy,
    contextFrames: renderOptions.contextFrames,
    continuation: continuation ? { ...continuation, actualHistoryFrames: conditioning.extendFromVideoPath || conditioning.historyContext ? continuation.actualHistoryFrames : 0 } : null,
    mode: conditioning.extendFromVideoPath ? 'extend' : (conditioning.sourceImagePath ? 'image' : 'text'),
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
function awaitClipCompletion(innerJobId, signal) {
  let detach;
  const promise = new Promise((resolve, reject) => {
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
    const onAbort = () => {
      detach();
      reject(createAbortError());
    };
    detach = () => {
      videoGenEvents.off('completed', onCompleted);
      videoGenEvents.off('failed', onFailed);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, detach };
}

// Run one local-backend clip through mediaJobQueue so it serializes on the
// single-flight GPU lane instead of bypassing queue admission with a direct
// generateVideo() call (which collides with active local renders on 409
// HEAVY_LOCAL_JOB_BUSY).
async function runLocalClipViaQueue({ params, outerJobId, episode, queueMod, signal }) {
  if (signal.aborted) throw createAbortError();
  const { enqueueJob, cancelJob, mediaJobEvents } = queueMod;
  const { jobId: _unusedJobId, ...queueParams } = params;

  let innerJobId = null;
  let settled = false;
  let cancelPromise = null;
  const earlyTerminal = new Map();

  const triggerCancel = () => {
    if (!innerJobId) return Promise.resolve();
    if (!cancelPromise) {
      cancelPromise = Promise.resolve()
        .then(() => cancelJob(innerJobId))
        .catch((err) => {
          console.log(`⚠️ Continuous video [${outerJobId.slice(0, 8)}] local queue cancel warning: ${err?.message || err}`);
        });
    }
    return cancelPromise;
  };

  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      for (const [state, listener] of listeners) mediaJobEvents.off(state, listener);
      signal.removeEventListener('abort', onAbort);
      if (episode.activeInner?.jobId === innerJobId) episode.activeInner = null;
      earlyTerminal.clear();
      fn(value);
    };

    const handleTerminal = (state, job) => {
      if (state === 'completed') {
        finish(resolve, { innerJobId: job.id });
        return;
      }
      if (state === 'canceled' || signal.aborted) {
        finish(reject, createAbortError());
        return;
      }
      finish(reject, new Error(job?.error || 'clip generation failed'));
    };

    const listeners = ['completed', 'failed', 'canceled'].map((state) => [state, (job) => {
      if (!job?.id) return;
      if (innerJobId === null) {
        earlyTerminal.set(job.id, { state, job });
        return;
      }
      if (job.id !== innerJobId) return;
      handleTerminal(state, job);
    }]);

    const onAbort = () => {
      const cancel = triggerCancel();
      void cancel.finally(() => finish(reject, createAbortError()));
    };

    for (const [state, listener] of listeners) mediaJobEvents.on(state, listener);
    signal.addEventListener('abort', onAbort, { once: true });

    enqueueJob({ kind: 'video', owner: `continuous-video:${outerJobId}`, params: queueParams }).then(
      (queued) => {
        innerJobId = queued.jobId;
        if (signal.aborted) {
          void triggerCancel();
          finish(reject, createAbortError());
          return;
        }
        episode.activeInner = { backend: 'local', jobId: innerJobId, cancel: triggerCancel };
        const early = earlyTerminal.get(innerJobId);
        earlyTerminal.clear();
        if (early) {
          handleTerminal(early.state, early.job);
          return;
        }
        if (queued.status === 'canceled') {
          handleTerminal('canceled', { id: innerJobId, status: 'canceled' });
        } else if (queued.status === 'failed') {
          handleTerminal('failed', { id: innerJobId, status: 'failed', error: queued.error });
        }
      },
      (err) => finish(reject, signal.aborted ? createAbortError() : err),
    );
  });
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

  // Register before the first await so an immediate SSE attach after POST
  // returns 200 never 404s during cold backend import or continuity checks,
  // Live Activity / update preflight observe the episode immediately, and
  // pre-loop setup throws reach the SSE error broadcast below.
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();
  const { signal } = abortController;
  const outerJob = { id: outerJobId, clients: [], status: 'running', backend, totalClips: clips.length, startedAt };
  const episode = {
    id: outerJobId,
    outerJob,
    backend,
    totalClips: clips.length,
    startedAt,
    abortController,
    cancelRequested: false,
    activeInner: null,
  };
  episodeJobs.set(outerJobId, outerJob);
  activeEpisodes.set(outerJobId, episode);

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

  const clipIds = [];
  const scratchPaths = [];
  const trims = new Map();
  let previousClip = null;

  const cleanupScratch = async () => {
    const paths = scratchPaths.splice(0, scratchPaths.length);
    if (paths.length) {
      await Promise.all(paths.map((path) => unlinkGuarded(path).catch(() => {})));
    }
  };

  const settleCanceled = async () => {
    activeEpisodes.delete(outerJobId);
    await cleanupScratch();
    outerJob.status = 'canceled';
    videoGenEvents.emit('canceled', { generationId: outerJobId });
    broadcastSse(outerJob, { type: 'canceled', jobId: outerJobId, message: 'Episode canceled' });
    closeJobAfterDelay(episodeJobs, outerJobId);
    return {
      ok: false, canceled: true, jobId: outerJobId, stage: 'canceled', clipIds,
    };
  };

  const settleError = async (stage, eventMessage, { returnError = eventMessage, ...extra } = {}) => {
    activeEpisodes.delete(outerJobId);
    await cleanupScratch();
    outerJob.status = 'error';
    videoGenEvents.emit('failed', { generationId: outerJobId, error: eventMessage });
    broadcastSse(outerJob, { type: 'error', error: eventMessage });
    closeJobAfterDelay(episodeJobs, outerJobId);
    return {
      ok: false, jobId: outerJobId, stage, error: returnError, clipIds, ...extra,
    };
  };

  try {
    const continuation = await resolveEpisodeContinuity({ backend, renderOptions });
    if (signal.aborted) return await settleCanceled();
    const runtimeContract = continuationContract(continuation?.runtime);
    const queueMod = backend === 'local' ? await loadMediaJobQueue() : null;
    const backendMod = backend === 'local' ? null : await BACKEND_MODULES[backend]();
    if (signal.aborted) return await settleCanceled();

    const runOneClip = async (clip, conditioning) => {
      if (signal.aborted) throw createAbortError();
      if (backend === 'local') {
        const params = backendJobParams({
          backend, clip, conditioning, renderOptions, continuation,
        });
        return runLocalClipViaQueue({ params, outerJobId, episode, queueMod, signal });
      }
      const innerJobId = randomUUID();
      const params = backendJobParams({
        backend, clip, conditioning, renderOptions, continuation, jobId: innerJobId,
      });
      let innerCancelState = 'idle';
      let innerCancelPromise = null;
      const cancelInner = () => {
        if (innerCancelState === 'done') return Promise.resolve(true);
        if (innerCancelPromise) return innerCancelPromise;
        innerCancelState = 'pending';
        innerCancelPromise = Promise.resolve()
          .then(() => backendMod.cancel?.(innerJobId))
          .then((res) => {
            innerCancelState = res === false ? 'idle' : 'done';
            return res;
          })
          .finally(() => {
            innerCancelPromise = null;
          });
        return innerCancelPromise;
      };
      episode.activeInner = { backend, jobId: innerJobId, cancel: cancelInner };
      // Listeners are registered BEFORE `generateVideo` is even invoked, so no
      // completion event it emits can fire before we're listening for it. If
      // `generateVideo` itself throws/rejects (a synchronous validation error, never
      // reaching its own 'failed' emit), detach here — otherwise these
      // listeners would leak on videoGenEvents forever.
      const { promise: completion, detach } = awaitClipCompletion(innerJobId, signal);
      try {
        await backendMod.generateVideo(params).catch((err) => {
          detach();
          throw err;
        });
        // If cancel arrived before generateVideo registered innerJobId, re-signal now.
        if (signal.aborted) {
          detach();
          await cancelInner().catch(() => {});
          throw createAbortError();
        }
        await completion;
        return { innerJobId };
      } catch (err) {
        if (signal.aborted && innerCancelState === 'idle') {
          await cancelInner().catch(() => {});
        }
        throw err;
      } finally {
        detach();
        if (episode.activeInner?.jobId === innerJobId) episode.activeInner = null;
      }
    };

    for (let i = 0; i < clips.length; i++) {
      if (signal.aborted) return await settleCanceled();
      const clip = clips[i];
      emitProgress(i, clip.cutType === 'continue' ? 'continuing' : 'establishing');
      const wantsContinuation = clip.cutType === 'continue' && previousClip;
      let conditioning = wantsContinuation && continuation?.effectiveStrategy !== 'window'
        ? await buildConditioning(backend, previousClip)
        : {};
      if (signal.aborted) return await settleCanceled();

      if (wantsContinuation && continuation?.effectiveStrategy === 'window') {
        const sourcePath = join(PATHS.videos, `${previousClip}.mp4`);
        const previousTrim = trims.get(previousClip);
        const frames = previousTrim.startFrame + previousTrim.frames;
        if (runtimeContract.outputLayout === 'new-output-only') {
          const historyFrames = runtimeContract.historyFrames;
          if (frames < historyFrames) throw new ServerError('The prior clip is too short for temporal history.', { status: 400, code: 'VIDEO_CONTINUITY_HISTORY_FAILED' });
          conditioning = { historyContext: { sourceVideoPath: sourcePath, endFrame: frames, frames: historyFrames } };
          continuation.actualHistoryFrames = historyFrames;
        } else {
          const startFrame = Math.max(trims.get(previousClip)?.startFrame || 0, tailWindowStartFrame({ totalFrames: frames, frames: continuation.contextFrames }));
          const contextPath = join(tmpdir(), `episode-context-${outerJobId}-${randomUUID()}.mp4`);
          // Own the destination before ffmpeg writes: partial failures also clean up.
          scratchPaths.push(contextPath);
          const cut = await trimVideoFromFrame(sourcePath, contextPath, { startFrame, fps: clips[i - 1].fps });
          if (signal.aborted) return await settleCanceled();
          if (!cut.ok) throw new ServerError(`Failed to prepare temporal episode history: ${cut.reason}`, { status: 400, code: 'VIDEO_CONTINUITY_HISTORY_FAILED' });
          conditioning = { extendFromVideoPath: contextPath };
          continuation.actualHistoryFrames = frames - startFrame;
        }
      }

      let outcome = await runOneClip(clip, conditioning).catch((err) => ({ error: err.message, aborted: isAbortError(err) }));
      if (signal.aborted || outcome.aborted) return await settleCanceled();
      if (outcome.error && wantsContinuation && continuation?.effectiveStrategy !== 'window') {
        console.log(`⚠️ Continuous video [${outerJobId.slice(0, 8)}] clip ${i + 1}/${clips.length} continuation failed (${outcome.error}) — re-establishing fresh`);
        outcome = await runOneClip(clip, {}).catch((err) => ({ error: err.message, aborted: isAbortError(err) }));
        if (signal.aborted || outcome.aborted) return await settleCanceled();
      }
      if (outcome.error) {
        return await settleError('generation', outcome.error, { failedClipIndex: i });
      }
      clipIds.push(outcome.innerJobId);
      if (continuation?.effectiveStrategy === 'window') {
        const frames = await probeFrameCount(join(PATHS.videos, `${outcome.innerJobId}.mp4`));
        if (signal.aborted) return await settleCanceled();
        if (!Number.isInteger(frames) || frames <= 0) {
          throw new ServerError('Cannot measure the temporal episode output.', { status: 400, code: 'VIDEO_CONTINUITY_OUTPUT_UNMEASURABLE' });
        }
        const hasEcho = wantsContinuation && runtimeContract.outputLayout === 'echoed-history-prefix';
        const prefix = hasEcho
          ? contextPrefixFrames({ runtime: continuation.runtime, totalFrames: frames, extendLatents: extendLatentFrames(clip.frames, continuation.runtime) })
          : 0;
        if (hasEcho && (prefix <= 0 || prefix >= frames)) {
          throw new ServerError('Cannot measure the temporal episode output prefix.', { status: 400, code: 'VIDEO_CONTINUITY_OUTPUT_UNMEASURABLE' });
        }
        trims.set(outcome.innerJobId, { startFrame: prefix, frames: frames - prefix });
      }
      previousClip = outcome.innerJobId;
    }

    if (signal.aborted) return await settleCanceled();
    videoGenEvents.emit('progress', { generationId: outerJobId, progress: 1, message: 'Stitching episode' });
    broadcastSse(outerJob, { type: 'progress', progress: 1, message: 'Stitching episode' });

    const stitched = await stitchVideos(clipIds, {
      id: outerJobId,
      filenamePrefix: 'episode',
      historyKey: 'chainedFrom',
      trims: trims.size ? trims : null,
      requireExactTrims: continuation?.effectiveStrategy === 'window',
      continuation,
    }).catch((err) => ({ error: err.message }));
    if (signal.aborted) return await settleCanceled();
    if (stitched?.error) {
      return await settleError('stitch', `Stitch failed: ${stitched.error}`, { returnError: stitched.error });
    }

    activeEpisodes.delete(outerJobId);
    await cleanupScratch();
    outerJob.status = 'complete';
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
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return await settleCanceled();
    return await settleError('generation', error.message);
  } finally {
    activeEpisodes.delete(outerJobId);
    await cleanupScratch();
  }
}
