/** Provider dispatch, idle watchdog, and durable video execution receipts. */

import { ServerError } from '../../lib/errorHandler.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { assertMusicVideoMedia } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { VIDEO_GEN_MODE, CLOUD_VIDEO_GEN_MODES } from '../../lib/generationModes.js';
import { IMAGE_GEN_MODE, CLOUD_IMAGE_GEN_MODES } from '../imageGen/modes.js';
import { videoGenEvents } from '../videoGen/events.js';
import { setVideoExecutionRecorder } from '../videoGen/executionRecorder.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { trainingEvents } from '../loraTraining/events.js';
import { audioGenEvents } from '../audioGen/events.js';
import { getSettings } from '../settings.js';
import { REMOTE_MEDIA_MODULES, isRemoteMediaJob } from './remoteMediaJob.js';
import { canRequestCancellation, claimTerminalOutcome, createJobHandlers } from './jobLifecycle.js';
import { isCloudImageJob, isLocalFinishReplay, jobLane } from './limits.js';
import {
  dispatchOperations, findJob, isRemoteReconcile, isTopazUpscale, testLifecycleDisposals,
  trackOperation, trackTerminalOperation, workerState,
} from './state.js';
import {
  isUnderUploadsRoot, normalizeTempPaths, admitCompletion, stageTerminalTransition,
  persistTerminalTransition, persist, announceTerminalTransition, releaseStagedUploads,
} from './persistence.js';
import { ensureSseEntry, makeGenDispatcher } from './sse.js';
import {
  videoExecutionSchema, videoExecutionParentSchema, videoSegmentExecutionSchema, videoSegmentExecutionsSchema,
  mergeVideoExecutionDiagnostics,
} from './videoExecution.js';
import { createRecoveryEvidence, observeProviderTerminal, recordTerminalDurable, recordOwnedInputCleanup } from './recoverySettlement.js';

// Defaults (env-overridable). `Number(non-numeric)` → NaN, and
// `setTimeout(NaN)` fires immediately — that would fail every job at boot
// if MEDIA_JOB_WATCHDOG_*_MS were set to garbage. Fall back to the default
// when the parsed value isn't a positive finite number.
const watchdogMs = (envValue, defaultMs) => {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
};
const WATCHDOG_VIDEO_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS, 30 * 60 * 1000);
const WATCHDOG_IMAGE_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_IMAGE_MS, 5 * 60 * 1000);
// Silent Codex renders can exceed 5 minutes while sharing provider throughput.
const WATCHDOG_CODEX_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_CODEX_MS, 20 * 60 * 1000);
// Training step output and audio sidecar STAGE messages reset the idle clock.
const WATCHDOG_TRAINING_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_TRAINING_MS, 30 * 60 * 1000);
const WATCHDOG_AUDIO_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_AUDIO_MS, 10 * 60 * 1000);


// Upscale and SuperCollider stay local by omission from the closed federation kind maps.
const flatWatchdog = (ms) => () => ms;
const chunkScaledWatchdog = ({ chunks }) => WATCHDOG_VIDEO_MS * Math.max(1, Number(chunks) || 1);

// The single declaration of how each kind runs: its lazily-loaded module (by
// `params.mode`, falling back to `default`), the event bus its progress rides,
// its idle-watchdog window, entry point and progress verb. Module loads stay
// thunks so no static import edge is added (server/AGENTS.md, "Import scoping").
const MEDIA_JOB_RUNTIME = Object.freeze({
  video: {
    events: videoGenEvents,
    verb: 'Rendering',
    watchdogMs: chunkScaledWatchdog,
    modules: {
      [IMAGE_GEN_MODE.GROK]: () => import('../videoGen/grok.js'),
      [VIDEO_GEN_MODE.FAL]: () => import('../videoGen/fal.js'),
      [VIDEO_GEN_MODE.REACTOR]: () => import('../videoGen/reactor.js'),
      [VIDEO_GEN_MODE.RUNWAY]: () => import('../videoGen/runway.js'),
      [VIDEO_GEN_MODE.GEMINI]: () => import('../videoGen/geminiWeb.js'),
      [VIDEO_GEN_MODE.HIGGSFIELD]: () => import('../videoGen/higgsfield.js'),
      [VIDEO_GEN_MODE.GOOGLE]: () => import('../videoGen/google.js'),
      default: () => import('../videoGen/local.js'),
    },
    invoke: (mod, request, { chunks }) => (chunks > 1 ? mod.generateChainedVideo(request) : mod.generateVideo(request)),
  },
  // An upscale is a single GPU render with no chunking, so it takes the video
  // idle window flat rather than the chunk-scaled one.
  'video-upscale': {
    events: videoGenEvents,
    verb: 'Upscaling',
    watchdogMs: flatWatchdog(WATCHDOG_VIDEO_MS),
    modules: { topaz: () => import('../videoGen/topazJob.js'), default: () => import('../videoGen/upscaleJob.js') },
    invoke: (mod, request) => mod.runVideoUpscale(request),
  },
  // Hand stitching (#13000): ffmpeg only, so it never touches the GPU lane's
  // render state, and local-only like the upscale (no peer map names it).
  'video-stitch': {
    events: videoGenEvents,
    verb: 'Stitching',
    watchdogMs: flatWatchdog(WATCHDOG_VIDEO_MS),
    modules: { default: () => import('../videoGen/stitchJob.js') },
    invoke: (mod, request) => mod.runVideoStitch(request),
  },
  // "Make it vertical": ffmpeg only, local-only, same lane rules as the stitch.
  'video-vertical': {
    events: videoGenEvents,
    verb: 'Reframing',
    watchdogMs: flatWatchdog(WATCHDOG_VIDEO_MS),
    modules: { default: () => import('../videoGen/verticalJob.js') },
    invoke: (mod, request) => mod.runVideoVertical(request),
  },
  'video-sharing': {
    events: videoGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_VIDEO_MS),
    modules: { default: () => import('../musicVideo/sharingCopy.js') },
    invoke: (mod, request) => mod.runSharingCopy(request),
  },
  // Window and verb are the values this kind inherited from the old default
  // arms, not a reviewed choice; changing them is a separate decision.
  'html-composition': {
    events: videoGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_IMAGE_MS),
    modules: { default: () => import('../htmlComposition/index.js') },
    invoke: (mod, request) => mod.renderComposition(request),
  },
  image: {
    events: imageGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_IMAGE_MS),
    modules: {
      [IMAGE_GEN_MODE.CODEX]: () => import('../imageGen/codex.js'),
      [IMAGE_GEN_MODE.GROK]: () => import('../imageGen/grok.js'),
      [IMAGE_GEN_MODE.AGY]: () => import('../imageGen/agy.js'),
      [IMAGE_GEN_MODE.FAL]: () => import('../imageGen/fal.js'),
      [IMAGE_GEN_MODE.RUNWAY]: () => import('../imageGen/runway.js'),
      [IMAGE_GEN_MODE.HIGGSFIELD]: () => import('../imageGen/higgsfield.js'),
      [IMAGE_GEN_MODE.GOOGLE]: () => import('../imageGen/google.js'),
      default: () => import('../imageGen/local.js'),
    },
    invoke: (mod, request) => mod.generateImage(request),
  },
  training: {
    events: trainingEvents,
    verb: 'Training',
    watchdogMs: flatWatchdog(WATCHDOG_TRAINING_MS),
    modules: { default: () => import('../loraTraining/index.js') },
    invoke: (mod, request) => mod.runTraining(request),
  },
  audio: {
    events: audioGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_AUDIO_MS),
    modules: { default: () => import('../audioGen/local.js') },
    invoke: (mod, request) => mod.generateAudio(request),
  },
  // Window and verb inherited from the old default arms (see html-composition).
  supercollider: {
    events: audioGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_IMAGE_MS),
    modules: { default: () => import('../superColliderRender.js') },
    invoke: (mod, request) => mod.renderSuperCollider(request),
  },
});

export const JOB_KINDS = Object.freeze(Object.keys(MEDIA_JOB_RUNTIME));

// Returns a Promise that resolves to the gen module for the given job's
// provider (video/local, imageGen/local, or imageGen/codex). Single source
// of provider-dispatch truth — used by the watchdog, runJob, and cancelJob
// so a new provider addition is one edit instead of three.
export function getGenModuleForJob(job) {
  // The remote check comes FIRST for every federatable kind: a remote job's
  // params deliberately carry no local runtime fields (mode, pythonPath), so a
  // later local branch would happily claim it and render a second time on this
  // machine.
  if (isRemoteMediaJob(job)) return REMOTE_MEDIA_MODULES[job.kind]();
  const runtime = MEDIA_JOB_RUNTIME[job.kind];
  if (!runtime) return Promise.resolve(null);
  return (runtime.modules[job.params?.mode] ?? runtime.modules.default)();
}

// Drop the params snapshot of pythonPath; live settings always win for
// local-Python jobs so a stale persisted snapshot can't poison the spawn.
// Future live-resolved fields (e.g. model.runtime-aware overrides) belong
// here so the seam stays in one place instead of accreting into runJob.
// Mutates safeParams in place.
async function resolveLiveParams(job, safeParams) {
  // A remote job renders on the peer's runtime, so this machine's pythonPath is
  // neither used nor meaningful — resolving it would only emit a confusing
  // re-resolution log line for a render that never touches local Python.
  if (isRemoteMediaJob(job)) return;
  // mflux training runs in the same venv as local image renders, so the
  // live settings pythonPath wins there too. flux2 training resolves its
  // own venv (resolveFlux2Python) inside runTraining — skip it here.
  const usesLocalPython = (job.kind === 'video' && !CLOUD_VIDEO_GEN_MODES.includes(job.params?.mode))
    || (job.kind === 'image' && !CLOUD_IMAGE_GEN_MODES.includes(job.params?.mode))
    || (job.kind === 'training' && job.params?.runtime === 'mflux');
  if (!usesLocalPython) return;
  const live = await getSettings().catch(() => null);
  const livePythonPath = live?.imageGen?.local?.pythonPath || null;
  if (livePythonPath && livePythonPath !== safeParams.pythonPath) {
    console.log(`🐍 media-job [${job.id.slice(0, 8)}] pythonPath re-resolved from settings: ${safeParams.pythonPath} → ${livePythonPath}`);
  }
  safeParams.pythonPath = livePythonPath;
}

const boundedVideoChunks = value => Math.min(8, Math.max(1, Math.trunc(Number(value) || 1)));

// Await this receipt before spawning a local video child. A rejected snapshot
// must leave the generator unstarted, rather than lose its random seed on exit.
// Cancellation may settle while metadata resolves; retain that late receipt
// without changing the terminal state or making the job dispatchable again.
const segmentExecutionTarget = (childJobId, executionParent) => {
  const parent = videoExecutionParentSchema.parse(executionParent);
  const job = findJob(parent.jobId);
  if (!job || job.kind !== 'video' || isRemoteMediaJob(job) || jobLane(job) !== 'gpu'
    || !['running', 'failed', 'canceled'].includes(job.status)
    || boundedVideoChunks(job.params?.chunks) !== parent.segmentCount || childJobId === parent.jobId) {
    throw new Error('Queued video segment has no matching local parent');
  }
  return { job, parent };
};

export async function recordVideoExecution(jobId, meta) {
  const target = meta.executionParent == null ? null : segmentExecutionTarget(jobId, meta.executionParent);
  const job = target?.job || findJob(jobId);
  if (!job || job.kind !== 'video' || isRemoteMediaJob(job) || !['running', 'failed', 'canceled'].includes(job.status)) return false;
  const segments = target ? videoSegmentExecutionsSchema.parse(job.videoExecutions || []) : null;
  const previous = target ? segments.find(entry => entry.segmentIndex === target.parent.segmentIndex) : job.videoExecution;
  const receipt = videoExecutionSchema.parse({
    version: 1,
    preparedAt: previous?.preparedAt || new Date().toISOString(),
    seed: meta.seed,
    ...(meta.batchSeeds ? { batchSeeds: meta.batchSeeds } : {}),
    parameters: meta,
    ...(previous?.diagnostics ? { diagnostics: previous.diagnostics } : {}),
  });
  if (previous && (previous.seed !== receipt.seed || (target && (previous.childJobId !== jobId || previous.segmentCount !== target.parent.segmentCount)))) {
    throw new Error('Video execution receipt already belongs to a different seed or child');
  }
  if (target) {
    const { segmentIndex, segmentCount } = target.parent;
    const segment = videoSegmentExecutionSchema.parse({ ...receipt, childJobId: jobId, segmentIndex, segmentCount });
    job.videoExecutions = videoSegmentExecutionsSchema.parse([
      ...segments.filter(entry => entry.segmentIndex !== segmentIndex), segment,
    ].sort((a, b) => a.segmentIndex - b.segmentIndex));
    const requestedSeed = job.params?.seed;
    const segmentSeedBase = requestedSeed == null || requestedSeed === '' ? null : Number(requestedSeed);
    const previousSeeds = job.params?.segmentSeedBase === segmentSeedBase && Array.isArray(job.params?.segmentSeeds)
      ? job.params.segmentSeeds : [];
    const segmentSeeds = Array.from({ length: segmentCount }, (_, index) => {
      const prior = previousSeeds[index];
      const reusable = Number.isSafeInteger(prior) && prior >= 0 ? prior : null;
      return job.videoExecutions.find(entry => entry.segmentIndex === index)?.seed ?? reusable;
    });
    // Preserve known, not-yet-rerendered seeds; changing the outer seed starts
    // a new base so the next unchanged retry can reuse this attempt's seeds.
    job.params = { ...job.params, segmentSeeds, segmentSeedBase };
  } else {
    job.videoExecution = receipt;
    job.params = { ...job.params, seed: receipt.seed };
  }
  await persist();
  return true;
}

// Call once at admission and once on termination, after accumulating numeric
// maxima in memory; never persist a snapshot for every subprocess output line.
export async function recordVideoExecutionDiagnostics(jobId, diagnostics, executionParent) {
  const target = executionParent == null ? null : segmentExecutionTarget(jobId, executionParent);
  const job = target?.job || findJob(jobId);
  if (!job || job.kind !== 'video' || isRemoteMediaJob(job)) return false;
  if (target) {
    const segments = videoSegmentExecutionsSchema.parse(job.videoExecutions || []);
    const index = segments.findIndex(entry => entry.childJobId === jobId && entry.segmentIndex === target.parent.segmentIndex && entry.segmentCount === target.parent.segmentCount);
    if (index < 0) return false;
    const previous = segments[index];
    segments[index] = videoSegmentExecutionSchema.parse({
      ...mergeVideoExecutionDiagnostics(previous, diagnostics),
      childJobId: previous.childJobId, segmentIndex: previous.segmentIndex, segmentCount: previous.segmentCount,
    });
    job.videoExecutions = segments;
  } else {
    if (!job.videoExecution) return false;
    job.videoExecution = mergeVideoExecutionDiagnostics(job.videoExecution, diagnostics);
  }
  await persist();
  return true;
}

export const installVideoExecutionRecorder = () => setVideoExecutionRecorder({
  recordExecution: recordVideoExecution, recordDiagnostics: recordVideoExecutionDiagnostics,
});

export async function assertMusicVideoJobPolicy(kind, params) {
  // Release cover art is not footage in the video, so the media mode (what the
  // video itself may contain) does not govern it.
  if (params?.musicVideo?.projectId && !params.musicVideo.coverArt && ['image', 'video'].includes(kind)) {
    const { getProject } = await import('../musicVideo/projects.js');
    const project = await getProject(params.musicVideo.projectId);
    if (!project) throw new Error('Music Video project not found');
    assertMusicVideoMedia(project, kind, 'generation');
    if (project.castAndSets?.source === 'catalog') {
      const { assertCatalogRenderParams } = await import('../musicVideo/clipCastReferences.js');
      await assertCatalogRenderParams(params, project);
    }
  }
}

// The dispatch window closes once the provider has been invoked (not settled —
// a provider kickoff may legitimately stay pending) or the job failed before
// reaching it. The finally covers a throw anywhere before that point.
export async function runJob(job, permit, finalizeLane, enqueueJob) {
  let markDispatched;
  trackOperation(dispatchOperations, new Promise((resolve) => { markDispatched = resolve; }));
  try {
    return await runJobLifecycle(job, markDispatched, permit, finalizeLane, enqueueJob);
  } finally {
    markDispatched();
  }
}

// The provider-dispatch copy of job.params; the retained job stays unchanged.
// Thread #1 (pre-gen sanitizer): even though safeUnlinkUpload guards the
// *delete* path, the gen module receives this spread and could itself act on a
// corrupted path from a hand-edited media-jobs.json. Null any upload path that
// doesn't resolve under PATHS.uploads so the constraint holds end-to-end.
function buildDispatchParams(job) {
  const safeParams = { ...job.params };
  if (job.params?.reviewedReferenceRequest) {
    const request = job.params.reviewedReferenceRequest;
    // JSON drops undefined properties. Restore those absences explicitly so
    // the top-level downgrade placeholders do not override provider defaults.
    Object.assign(safeParams, request, { prompt: request.prompt, modelId: request.modelId, pythonPath: request.pythonPath });
  }
  // Freeze only the dispatch copy to the default whose cohort passed the hold
  // check. The retained job's original parameters stay unchanged.
  if (job.videoCohort && (safeParams.modelId === undefined || safeParams.modelId === '')) {
    safeParams.modelId = job.videoCohort.modelId;
  }
  for (const key of ['uploadedTempPath', 'audioFilePath']) {
    const value = safeParams[key];
    if (value && (typeof value !== 'string' || !isUnderUploadsRoot(value))) {
      console.log(`⚠️ media-job [${job.id.slice(0, 8)}] ${key} outside PATHS.uploads — nulled before gen invoke: ${value}`);
      safeParams[key] = null;
    }
  }
  safeParams.uploadedTempPaths = normalizeTempPaths(safeParams.uploadedTempPaths).filter((p) => {
    if (isUnderUploadsRoot(p)) return true;
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] uploadedTempPaths entry outside PATHS.uploads — rejected before gen invoke: ${p}`);
    return false;
  });
  // Clamp chunks to the same 1-8 bound the route enforces on new submissions.
  // Replayed jobs read params from media-jobs.json which could be hand-edited
  // to an out-of-range value, bypassing the route-layer Zod validation.
  safeParams.chunks = boundedVideoChunks(safeParams.chunks);
  return safeParams;
}

// The dispatch must carry the exact snapshot admitted for this job, and claim
// it (reserved → invoked) before the provider starts. Only a reconciling remote
// recovery may re-dispatch an already-invoked snapshot.
async function assertReviewedReferenceDispatch(job, safeParams) {
  if (safeParams.reviewedReferenceRequest && !safeParams.reviewedReferenceSnapshot) {
    throw new ServerError('Reviewed reference ownership is missing', { status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
  }
  if (!safeParams.reviewedReferenceSnapshot) return;
  const { readOwnedSnapshot, markSnapshotState, withReviewedSnapshotLock, isReviewedReferenceList } = await import('../imageGen/reviewedReference.js');
  const snapshot = safeParams.reviewedReferenceSnapshot;
  const { path, record } = await readOwnedSnapshot(snapshot);
  const remoteAssets = safeParams.remoteMedia?.inputAssets;
  const remoteMismatch = isRemoteMediaJob(job) && (safeParams.remoteMedia?.wireVersion !== 2
    || JSON.stringify(safeParams.remoteMedia.reviewedReferenceSnapshot) !== JSON.stringify(snapshot)
    || !Array.isArray(remoteAssets) || remoteAssets.some(asset => asset?.role !== 'referenceImages')
    || !isReviewedReferenceList(remoteAssets.map(asset => asset.path), path));
  if (snapshot.jobId !== job.id || safeParams.initImagePath || !isReviewedReferenceList(safeParams.referenceImagePaths, path) || remoteMismatch) {
    throw new ServerError('Reviewed reference ownership does not match the queued job', { status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
  }
  if (record.state === 'reserved') await withReviewedSnapshotLock(() => markSnapshotState(snapshot, 'invoked'));
  else if (!(record.state === 'invoked' && isRemoteMediaJob(job) && safeParams.remoteMedia?.reconcile === true)) {
    throw new ServerError('Reviewed reference is not available for dispatch', { status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
  }
}

async function runJobLifecycle(job, markDispatched, permit, finalizeLane, enqueueJob) {
  const sseEntry = ensureSseEntry(job.id);
  let resolveTerminalState;
  const terminalState = new Promise((resolve) => { resolveTerminalState = resolve; });
  let resolveProviderSettlement;
  const providerSettlement = new Promise(resolve => { resolveProviderSettlement = resolve; });
  let resolveDeferredCompletion;
  const deferredCompletion = new Promise(resolve => { resolveDeferredCompletion = resolve; });
  let watchdogNeedsProviderSettlement = false;
  // Transient: returned to the lane finalizer, never persisted or projected.
  const recovery = createRecoveryEvidence();
  let inputCleanupAttempted = false;
  let watchdogTimer;
  async function releaseRemoteAudioInputs(disposable) {
    if (!disposable || !isRemoteMediaJob(job)) return;
    if (job.params?.remotePeerReservation === true) {
      job.params = { ...job.params, remotePeerReservation: false };
      try { await persist(); }
      catch (_error) {
        job.params = { ...job.params, remotePeerReservation: true };
        maintenance.markResourceUnsettled('media', job.id);
        return;
      }
    }
    if (inputCleanupAttempted) return;
    inputCleanupAttempted = true;
    try {
      // withResource deliberately skips unsettled operations. Cleanup must
      // execute under this exact captured permit so a new error stamps it.
      await permit.run(async () => {
        const { discardSourceAudioWindow } = await import('../federatedMedia/sourceAudio.js');
        const owned = normalizeTempPaths(job.params?.uploadedTempPaths);
        const cleaned = new Set();
        for (const asset of job.params?.remoteMedia?.inputAssets || []) {
          if (asset.role === 'sourceAudio') {
            if (!owned.includes(asset.path) || !(await discardSourceAudioWindow(asset.path)).ok) {
              throw new Error('Remote source audio has no verified owned cleanup binding');
            }
            cleaned.add(asset.path);
          }
        }
        // This recovery certifies the feature's owned WAV windows. Other
        // staged multipart inputs have no equivalent cleanup receipt here.
        recordOwnedInputCleanup(recovery, [...owned, job.params?.uploadedTempPath, job.params?.audioFilePath]
          .filter(Boolean).every(path => cleaned.has(path)));
      });
    } catch (error) {
      maintenance.markResourceUnsettled('media', job.id);
      console.error(`❌ Remote video input cleanup needs recovery for ${job.id}: ${error.message}`);
    }
  }
  // All terminal paths compete for one outcome. claimTerminalOutcome sets the
  // transient job.terminating flag synchronously, so cancelJob also sees the
  // claim while the terminal transition is awaiting durable publication.
  async function terminate(state, apply, remoteInputsDisposable = false) {
    if (!claimTerminalOutcome(job)) return;
    clearInterval(watchdogTimer);
    emitter.off?.('activity', onActivity);
    emitter.off?.('progress', onActivity);
    let publicationStarted = false;
    try {
      await admitCompletion(state, () => {
        publicationStarted = true;
        return publishTerminalTransition(state, apply, remoteInputsDisposable);
      });
    } catch (error) {
      if (publicationStarted || state !== 'completed') throw error;
      console.warn(`⏸️ media-job [${job.id.slice(0, 8)}] completion retained for publication recovery: ${error.message}`);
      // The provider finished, but admission never opened. Persist a pending
      // receipt without publishing completion, so recovery can finish it even
      // after a restart. Do not replay a callback that already started.
      try {
        await publishTerminalTransition(state, apply, remoteInputsDisposable);
      } finally {
        resolveDeferredCompletion();
      }
    }
  }

  async function publishTerminalTransition(state, apply, remoteInputsDisposable) {
    if (remoteInputsDisposable === true && isRemoteMediaJob(job)) {
      job.params = { ...job.params, remotePeerReservation: false };
    }
    stageTerminalTransition(job, (job) => {
      apply(job);
      job.status = state;
      if (state === 'completed') {
        job.progress = 1;
        job.statusMsg = 'Completed';
      }
      // failed/canceled retain progress and any status message supplied by apply
      // (for example, a retained image after finishing fails). Consumers gate
      // the progress UI on status === 'running'.
      job.completedAt = new Date().toISOString();
    }, async () => {
      // The terminal snapshot is durable now; a restart no longer rebuilds
      // this request. Absence of the executor verdict retains all inputs.
      recordTerminalDurable(recovery);
      // A shared persist can acknowledge another job: restore THAT job's
      // maintenance context, and never let cleanup failure lose this callback.
      await releaseRemoteAudioInputs(remoteInputsDisposable);
      await announceTerminalTransition(job, resolveTerminalState);
    });
    await persistTerminalTransition(job);
  }

  const handlers = createJobHandlers(job, {
    sseEntry, permit, terminate, enqueueJob, stopWatchdog: () => clearInterval(watchdogTimer),
  });

  const safeParams = buildDispatchParams(job);

  await resolveLiveParams(job, safeParams);

  const runtime = MEDIA_JOB_RUNTIME[job.kind];
  const emitter = runtime?.events ?? imageGenEvents;
  // A watchdog outcome records why the job failed; it does not prove that
  // cancellation has reached physical exit and provider cleanup. Only a real
  // provider terminal event can release that additional wait.
  const observeProviderSettlement = payload => {
    observeProviderTerminal(recovery, job, payload);
    if (payload.inputProcessSettled === true || (isRemoteMediaJob(job) && payload.remoteInputsDisposable === true)) recovery.snapshotProcessSettled = true;
    resolveProviderSettlement();
  };
  const dispatcher = makeGenDispatcher(emitter, job, {
    ...handlers,
    completed: payload => { observeProviderSettlement(payload); handlers.completed(payload); },
    failed: payload => { observeProviderSettlement(payload); handlers.failed(payload); },
  }, runtime?.verb ?? 'Generating');
  dispatcher.attach();

  // Model downloads can exceed any useful wall deadline. Runner output
  // resets the idle window, and cloud jobs (including Grok video) use the
  // cloud timeout even when the local video timeout would be chunk-scaled.
  const idleTimeoutMs = isCloudImageJob(job) ? WATCHDOG_CODEX_MS : (runtime?.watchdogMs ?? flatWatchdog(WATCHDOG_IMAGE_MS))(safeParams);
  let lastActivityAt = Date.now();
  const onActivity = (e) => {
    if (e?.generationId === job.id) lastActivityAt = Date.now();
  };
  emitter.on('activity', onActivity);
  // Treat real progress events as activity too — covers the (rare) case
  // where a runner emits structured progress without going through
  // handleLine (e.g. a future direct emit).
  emitter.on('progress', onActivity);
  // setInterval with an async tick can overlap if the await
  // (getGenModuleForJob → dynamic import) takes longer than the interval.
  // Without this guard, two ticks could both pass the post-await
  // status check and both call mod.cancel() + handlers.failed(). The
  // terminal sink in terminate() is idempotent, but mod.cancel() being
  // called twice racing with the SIGKILL escalation is messy. Track an
  // inFlight flag so only one tick is ever past the await at a time.
  let watchdogInFlight = false;
  const watchdogTickMs = Math.min(30_000, Math.max(25, Math.floor(idleTimeoutMs / 4)));
  // Timers run on a monotonic clock that stops while the host sleeps, but
  // Date.now() keeps going — a laptop that slept mid-render woke to a kill for
  // "no runner output" the runner never had a chance to produce. A tick that
  // lands far later than scheduled means the process was suspended, so that
  // gap is not counted as runner idleness.
  let lastWatchdogTickAt = Date.now();
  watchdogTimer = setInterval(async () => {
    const tickAt = Date.now();
    const tickGap = tickAt - lastWatchdogTickAt;
    lastWatchdogTickAt = tickAt;
    if (tickGap > Math.max(watchdogTickMs * 3, 60_000)) {
      lastActivityAt = Math.min(tickAt, lastActivityAt + tickGap - watchdogTickMs);
      console.log(`💤 media-job [${job.id.slice(0, 8)}] host was suspended ~${Math.round(tickGap / 1000)}s — not counted as runner idle time`);
    }
    if (watchdogInFlight) return;
    if (!canRequestCancellation(job)) return;
    const idleFor = Date.now() - lastActivityAt;
    if (idleFor < idleTimeoutMs) return;
    watchdogInFlight = true;
    // try/catch is mandatory here: this body is the listener for an
    // EventEmitter-like setInterval — a rejected await inside an async
    // callback escapes as an unhandled promise rejection (process-killing
    // on Node ≥15). getGenModuleForJob does a dynamic import and can
    // realistically reject under disk pressure / hot-reload / a stale
    // module cache. Route any failure through handlers.failed so the
    // queue still settles, and reset inFlight in finally.
    try {
      const mod = await getGenModuleForJob(job);
      // Re-check after the await — terminate() may have started (and is
      // draining to disk with job.status still 'running') during the import.
      if (!canRequestCancellation(job)) return;
      console.log(`⏱️ media-job [${job.id.slice(0, 8)}] watchdog fired after ${idleFor}ms idle (limit ${idleTimeoutMs}ms) — marking failed`);
      watchdogNeedsProviderSettlement ||= job.providerInvoked === true;
      if (mod?.cancel) await mod.cancel(job.id);
      handlers.failed({ error: `watchdog timeout: no runner output for ${Math.round(idleFor / 1000)}s (limit ${Math.round(idleTimeoutMs / 1000)}s)` });
    } catch (err) {
      // Don't take down the server over a watchdog tick that couldn't
      // resolve the gen module. Log and let the next tick retry — if
      // job.status is still 'running', the next idle check will fire
      // again (and may succeed once the import cache stabilizes).
      console.log(`⚠️ media-job [${job.id.slice(0, 8)}] watchdog tick errored: ${err?.message || err}`);
    } finally {
      watchdogInFlight = false;
    }
  }, watchdogTickMs);
  watchdogTimer.unref?.();

  let abandonForTests;
  const abandoned = new Promise(resolve => { abandonForTests = () => {
    job.terminating = true;
    resolve();
  }; });
  testLifecycleDisposals.add(abandonForTests);
  try {
    try {
      // A restored remote submission must reach its adapter to deliver an
      // already-recorded cancellation, even after its project narrows or is deleted.
      const recoveringRemoteCancellation = isRemoteMediaJob(job) && job.cancelRequested
        && job.params?.remoteMedia?.reconcile === true && job.params.remoteMedia.cancelRequested === true;
      if (!recoveringRemoteCancellation) await assertMusicVideoJobPolicy(job.kind, job.params);
      const mod = await getGenModuleForJob(job);
      if (job.params?.videoProduction) {
        const { assertVideoAttemptDispatch } = await import('../creativeDirector/videoExecution.js');
        await assertVideoAttemptDispatch(job.params.videoProduction.projectId, job.params.videoProduction.attemptId, { jobId: job.id });
      }
      if (job.params?.shotInstruction?.repair && job.params?.musicVideo) {
        const { assertPerformanceRepairDispatch } = await import('../musicVideo/revisionService.js');
        await assertPerformanceRepairDispatch(job.params.musicVideo);
      }
      if (!mod) throw new Error(`Unknown job kind: ${job.kind}`);
      // A cancel that arrived while this job was still queued lives on the
      // persisted marker, not on any in-memory adapter state. Re-stamp it for
      // every remote kind so the adapter starts already knowing it must recover
      // the provider job and cancel it rather than import its result.
      if (isRemoteMediaJob(job)) {
        safeParams.remoteMedia = {
          ...(safeParams.remoteMedia && typeof safeParams.remoteMedia === 'object'
            ? safeParams.remoteMedia : {}),
          cancelRequested: job.params?.remoteMedia?.cancelRequested === true,
        };
      }
      if (job.params?.musicVideo?.sceneId && !(job.cancelRequested && isRemoteMediaJob(job))) {
        const { assertMusicVideoSceneReview } = await import('../musicVideo/productionReviewService.js');
        await assertMusicVideoSceneReview(job.params.musicVideo, job.kind);
      }
      // The user may edit a referenced file while this job waits in the queue.
      // Recheck the captured bytes and request at the last provider boundary;
      // recovery/finish replays must not start another render.
      if (job.kind === 'image' && safeParams.fableLoom && !isLocalFinishReplay(job)
        && !isRemoteReconcile(job)) {
        const { assertFableLoomDispatchInputs } = await import('../fableLoom/requestInputs.js');
        await assertFableLoomDispatchInputs(safeParams);
      }
      await assertReviewedReferenceDispatch(job, safeParams);
      // Remote recovery must still reach its adapter to cancel an existing render.
      // Local cancellation before dispatch owns no provider process to stop.
      if (job.cancelRequested && !isRemoteMediaJob(job) && !(isTopazUpscale(job) && job.params?.topazRecovery)) {
        throw new Error('Canceled before provider dispatch');
      }
      // A watchdog can win during the awaited policy/module preparation above.
      // Its terminal outcome must prevent that delayed provider from starting.
      if (!canRequestCancellation(job)) throw new Error('Provider dispatch stopped after the job reached a terminal outcome');
      if (isLocalFinishReplay(job)) {
        handlers.completed(safeParams.visualProfileSource);
        markDispatched();
      } else {
        // Transient, like terminating: no await between this flag and invocation.
        job.providerInvoked = true;
        const request = { ...safeParams, jobId: job.id,
          ...(isTopazUpscale(job) ? { topazCancelRequested: job.cancelRequested === true } : {}),
          ...(job.kind === 'video' && jobLane(job) === 'gpu' && Number(safeParams.chunks) > 1 ? { executionQueueJobId: job.id } : {}) };
        const kickoff = (runtime?.invoke ?? MEDIA_JOB_RUNTIME.image.invoke)(mod, request, safeParams);
        markDispatched();
        const launched = await Promise.race([kickoff, abandoned]);
        if (Array.isArray(launched?.referenceImageFilenames) && canRequestCancellation(job)) {
          job.referenceImageFilenames = launched.referenceImageFilenames;
        }
      }
      if (workerState.resettingForTests) return null;
    } catch (err) {
      // Policy/auth refusal still stands, but it cannot prove a previously
      // admitted peer render finished before this recovery attempt.
      if (isRemoteReconcile(job)) maintenance.markCurrentUnsettled();
      // generateVideo / generateChainedVideo / generateImage threw before
      // reaching their proc.on cleanup hooks (e.g. PYTHON not configured,
      // validation fail). Clean up multipart upload temp files the route
      // handed us so they don't leak under data/uploads.
      // safeUnlinkUpload constrains the delete to PATHS.uploads as
      // defense-in-depth against corrupted persisted params. audioFilePath
      // is the same kind of staged upload (a2v jobs) — clean it up too.
      // Tracked from the first microtask of the rejection, so a drain that saw
      // the dispatch window close cannot miss this failure (#9029).
      await trackTerminalOperation((async () => {
        if (!isRemoteReconcile(job)) await releaseStagedUploads(job.params);
        handlers.failed({ error: err.message, code: err.code,
          remoteInputsDisposable: isRemoteMediaJob(job) && job.providerInvoked !== true && job.params?.remoteMedia?.reconcile !== true });
      })());
    }

    // The gen modules emit completed/failed asynchronously after kickoff. Await
    // the explicit terminal signal rather than polling every 100ms; this makes
    // lane release immediate and gives tests a deterministic lifecycle to drain.
    // Only release the execution lane after the provider invocation has settled.
    // Keep maintenance ownership until the admitted completion is durable.
    await Promise.race([terminalState, deferredCompletion, abandoned]);
    if (workerState.resettingForTests) return null;
    if (job.durabilityPending) finalizeLane();
    await Promise.race([terminalState, abandoned]);
    if (workerState.resettingForTests) return null;
    if (watchdogNeedsProviderSettlement) await Promise.race([providerSettlement, abandoned]);
    if (workerState.resettingForTests) return null;
    // A watchdog can win the terminal row before the real provider responds.
    // Keep its later trusted verdict through physical settlement, then release
    // inputs under the still-owned lane after that row is durable.
    await releaseRemoteAudioInputs(recovery.inputsDisposable);
    // The lane finalizer combines this with its final flush before releasing.
    return recovery;
  } finally {
    testLifecycleDisposals.delete(abandonForTests);
    clearInterval(watchdogTimer);
    emitter.off('activity', onActivity);
    emitter.off('progress', onActivity);
    dispatcher.detach();
  }
}
