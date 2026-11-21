/**
 * Image Gen — Local provider (mflux, diffusers, and platform-specific runners).
 *
 * Spawns a Python child process to generate the selected local image model. HF model weights
 * stream into the user's standard HF cache (`~/.cache/huggingface/`) — PortOS
 * doesn't override HF_HOME. Generated images land in `data/images/<jobId>.png`
 * with a sidecar metadata JSON so the gallery and Remix flow can recover
 * prompt/seed/steps.
 *
 * Progress comes back via the imageGenEvents bus (Socket.IO bridge) and over
 * a per-job SSE stream so EventSource consumers (the Imagine page) get the
 * raw status text mflux prints to stderr.
 */

import { readFile, readdir, stat, mkdtemp } from 'fs/promises';
import { existsSync, watch as fsWatch } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { spawn } from '../../lib/childProcess.js';
import { atomicWrite, ensureDir, PATHS, resolveImageInputPath, rmGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { assertFlux2InputsCompatible } from '../../lib/flux2Inputs.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, dispatchTerminalEvent } from '../../lib/sseUtils.js';
import { FLUX2_VENV_DEFAULT, isFlux2VenvHealthy, invalidateFlux2Health } from '../../lib/pythonSetup.js';
import { usesTorchVenv, usesMossSwift, usesFlux3, usesMinimaxH3Image } from '../../lib/imageRuntimeRemedies.js';
import { mossChildEnv, MOSS_MANIFEST } from './mossRuntime.js';
import { hfChildEnv } from '../hfToken.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import { createLineReader } from '../../lib/streamLines.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { IMAGE_GEN_MODE, LOCAL_IMAGEGEN_DEFAULT_MODEL } from './modes.js';
import { bufferChildExit } from '../videoGen/generateVideoHelpers.js';
import { getImageModels } from '../../lib/mediaModels.js';
import { hardwareUnavailableReason, isHardwareCompatible } from '../../lib/systemCapabilities.js';
import { assertFlux3Inputs, flux3Env } from './flux3Runtime.js';
import {
  assertMinimaxH3ImageInputs, minimaxH3ImageEnv, minimaxH3ImageWeightsCached, loadMinimaxH3Runtime,
} from './minimaxH3ImageRuntime.js';
import { readTriggerWordsByFilename, readLoraLicensesByFilename } from '../loras.js';
import { rejectDegenerateFrame } from './frameGuard.js';
import { buildArgs } from './localArgs.js';
import { classifyLocalRenderFailure, createLocalOutputParser } from './localOutputParser.js';
import { buildSidecarMeta, resolveOutputPlacement } from './localRenderMeta.js';

export { buildArgs } from './localArgs.js';
export { parseImageExecutionMarker } from './localOutputParser.js';
export { buildSidecarMeta, localSentPrompt, resolveOutputPlacement } from './localRenderMeta.js';
export {
  assertGalleryFilename, cacheImageSha256, deleteImage, fillImageSidecarFields, listGallery, listLoraFilenames,
  readImageSidecar, saveUploadedGalleryImage, setImageHidden, setImagePendingDelete, setImagePrimary, updateImagePrompt,
} from './localGallery.js';

// Read the registry lazily — callers below hit getImageModels() at request
// time. A prior `IMAGE_MODELS = Object.fromEntries(getImageModels()...)`
// snapshot lived here but fired loadMediaModels() at import time, breaking
// any test that mocks PATHS.data to a non-writable path.
export const listImageModels = () => getImageModels();

// Per-job clients: jobId -> { clients, status, meta, broadcast }
const jobs = new Map();
let activeProcess = null;
// Snapshot of the currently-running job for /api/image-gen/active so the UI
// can rehydrate prompt + settings + progress + last-rendered frame after
// navigating away. Cleared on completion / error / cancel.
let activeJob = null;

export const getActiveJob = () => activeJob;

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

// The job between stepwise-dir creation and a wired child. cancel() has no
// process to signal in that window (heavy-claim wait, model unload), so it flags
// the job and the pre-spawn gate aborts it.
let preparing = null;

export const cancel = () => {
  if (!activeProcess) {
    if (!preparing) return false;
    preparing.cancelRequested = true;
    return 'pending';
  }
  const proc = activeProcess;
  // KEEP activeProcess + activeJob set until proc.on('close') clears them.
  // Otherwise BUSY immediately allows a new generation while the SIGTERM'd
  // mflux child is still running, and we lose the handle for a follow-up
  // SIGKILL. The `activeProcess === proc` guard escalates only when this is
  // still the tracked child (mflux can ignore SIGTERM mid-tensor-op).
  killWithEscalation(proc, { label: 'image child', stillRunning: () => activeProcess === proc });
  return true;
};

async function preflightLocalModel({ modelId, pythonPath, negativePrompt, width, height, steps, initImagePath, referenceImagePaths, referenceImageStrengths, loraPaths, loraFilenames }) {
  // loadMediaModels memoizes — on-disk edits to data/media-models.json still
  // need a server restart to apply. Don't re-check model.broken here:
  // getImageModels() already filtered current-platform entries; an extra
  // check would also reject entries broken on the OTHER platform (e.g.
  // 'windows' on a macOS box).
  const model = getImageModels().find((m) => m.id === modelId);
  if (!model) throw new ServerError(`Unknown or unsupported model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  if (!isHardwareCompatible(model.hardwareCompatibility)) {
    throw new ServerError(
      hardwareUnavailableReason(`Image model "${modelId}"`, model.hardwareCompatibility),
      { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' },
    );
  }
  const assertRuntimeReady = async (code) => {
    const { diagnoseLocalRuntime } = await import('./localRuntime.js');
    const runtime = await diagnoseLocalRuntime({ modelId });
    if (runtime.readiness !== 'ready') throw new ServerError(runtime.reason, { status: 400, code });
  };
  if (usesFlux3(model)) {
    assertFlux3Inputs({ negativePrompt, width: Number(width), height: Number(height), initImagePath, referenceImagePaths, referenceImageStrengths,
      loraPaths: [...loraPaths, ...loraFilenames] });
    await assertRuntimeReady('FLUX3_NOT_READY');
  }
  let minimaxRuntime = null;
  if (usesMinimaxH3Image(model)) {
    assertMinimaxH3ImageInputs({ negativePrompt, width: Number(width), height: Number(height), steps: steps || null, hasInitImage: Boolean(initImagePath),
      referenceCount: referenceImagePaths.length, referenceImageStrengths, loraCount: loraPaths.length + loraFilenames.length });
    await assertRuntimeReady('MINIMAX_H3_IMAGE_NOT_READY');
    if (!await minimaxH3ImageWeightsCached(model)) {
      throw new ServerError('MiniMax H3-Image weights are not downloaded. Use Download beside the model in Image Gen, then retry.',
        { status: 400, code: 'MINIMAX_H3_IMAGE_WEIGHTS_NOT_CACHED' });
    }
    minimaxRuntime = await loadMinimaxH3Runtime();
  }
  assertFlux2InputsCompatible(model, {
    hasInitImage: Boolean(initImagePath), referenceCount: referenceImagePaths.length,
    loraCount: loraFilenames.length + loraPaths.length,
  });
  // Both flux2 and z-image runners resolve their own Python via the FLUX.2
  // venv — only the legacy mflux/imagine_win path needs the user-configured
  // Settings > Image Gen pythonPath.
  if (usesMossSwift(model)) {
    // Check raw requests before sidecar normalization can discard a missing input file or LoRA.
    if (loraFilenames.length || loraPaths.length || initImagePath || referenceImagePaths.length) {
      throw new ServerError('MOSS SFT supports text-to-image only; remove LoRAs and input images.', { status: 400, code: 'MOSS_INPUT_UNSUPPORTED' });
    }
    await assertRuntimeReady('MOSS_NOT_READY');
  }
  if (!usesTorchVenv(model) && !usesMossSwift(model) && !usesFlux3(model) && !usesMinimaxH3Image(model) && !pythonPath) {
    throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' });
  }
  // Health, not mere presence. buildArgs below only checks that the shared
  // torch venv's python BINARY exists, so a venv left half-installed (killed
  // mid-download, a hand-run pip upgrade that broke diffusers) spawned anyway
  // and died with an ImportError the caller saw as a bare "Exit code 1" — the
  // Decks page rendered that as an unexplained "Failed" badge. Refuse up front
  // with the same reason and one-button remedy the status probe reports.
  if (usesTorchVenv(model)) {
    const healthy = await isFlux2VenvHealthy(model.pipelineClass).catch(() => null);
    if (healthy === false) {
      throw new ServerError(
        `The shared torch image runtime is not installed or healthy (expected at ${FLUX2_VENV_DEFAULT}). Install it from Settings › Image Gen › Local, then retry. FLUX.2, Z-Image, ERNIE, HiDream and Qwen all render through it.`,
        // Same code buildArgs throws when the venv's python is missing outright:
        // "the shared torch runtime is not usable" is one state to a caller,
        // whether it is absent or broken.
        { status: 400, code: 'IMAGE_GEN_FLUX2_NOT_INSTALLED' },
      );
    }
  }
  return { model, minimaxRuntime };
}

async function prepareLocalRenderMeta(inputs) {
  const { model, jobId, loraFilenames, loraPaths, initImagePath, referenceImagePaths } = inputs;
  // Trigger words for the selected LoRAs (#4665). Read against the RAW request
  // (a superset of what survives the prefix-check inside buildSidecarMeta) so
  // the map is available before validation runs; an absent or legacy sidecar
  // simply contributes nothing and the render is unchanged. A no-LoRA render
  // short-circuits inside the helper, so the common case does zero extra I/O.
  const loraTriggerWords = await readTriggerWordsByFilename([...loraFilenames, ...loraPaths]);
  const loraLicenses = await readLoraLicensesByFilename([...loraFilenames, ...loraPaths]);
  const render = buildSidecarMeta({
    ...inputs, loraTriggerWords, loraLicenses, resolveInputPath: resolveImageInputPath, loraExists: existsSync,
  });
  const { meta, validInitImagePath, validReferenceImagePaths, addedTriggerWords } = render;
  if ((initImagePath && !validInitImagePath)
    || (Array.isArray(referenceImagePaths) && referenceImagePaths.length !== validReferenceImagePaths.length)) {
    throw new ServerError('A requested input image is unavailable or outside the allowed image roots', {
      status: 400, code: 'IMAGE_INPUT_UNAVAILABLE',
    });
  }
  if (usesFlux3(model)) {
    meta.quantize = model.quantization?.replace('q', '') || null;
    meta.quantization = model.quantization;
    meta.guidance = 0;
    meta.modelRepo = model.repo;
  }
  if (usesMinimaxH3Image(model)) {
    meta.quantize = null;
    meta.quantization = 'bf16';
    meta.guidance = 0;
    meta.modelRepo = model.repo;
    meta.modelRevision = model.revision;
  }
  if (usesMossSwift(model)) {
    meta.quantize = null;
    meta.quantization = 'bf16';
    meta.modelRepo = MOSS_MANIFEST.repo;
    meta.modelRevision = MOSS_MANIFEST.revision;
    meta.nativeRuntime = { runtime: 'moss-swift', sourceRevision: MOSS_MANIFEST.sourceRevision, adapterVersion: MOSS_MANIFEST.adapterVersion };
  }
  if (addedTriggerWords.length) {
    console.log(`🔤 LoRA trigger words woven [${jobId.slice(0, 8)}]: ${addedTriggerWords.join(', ')}`);
  }
  return render;
}

function recordProviderInputs({ meta, job, reviewedReferenceSnapshot, validInitImagePath, validReferenceImagePaths, validReferenceImageStrengths }, providerInputs) {
  // Record only inputs the selected runner actually receives. Unsupported
  // references and Windows mflux init images remain explicit request evidence.
  const requestedInputs = [
    ...(meta.initImageFilename ? [{ role: 'initImage', filename: meta.initImageFilename }] : []),
    ...meta.referenceImageFilenames.map(filename => ({ role: 'referenceImages', filename })),
  ];
  const omittedInputs = [
    ...(validInitImagePath && !providerInputs.initImagePath ? [{ role: 'initImage', filename: meta.initImageFilename }] : []),
    ...validReferenceImagePaths.filter(path => !providerInputs.referenceImagePaths.includes(path))
      .map(path => ({ role: 'referenceImages', filename: basename(path) })),
  ];
  if (omittedInputs.length) {
    meta.requestedInputImages = requestedInputs;
    meta.omittedInputImages = omittedInputs.map(input => ({ ...input, reason: 'unsupported-render-path' }));
  }
  meta.inputProvenance = 'provider-inputs';
  if (reviewedReferenceSnapshot && (providerInputs.referenceImagePaths.length !== validReferenceImagePaths.length || providerInputs.referenceImagePaths[0] !== validReferenceImagePaths[0])) {
    throw new ServerError('The selected local render path cannot apply every reference of this edit', { status: 400, code: 'REVIEWED_REFERENCE_UNSUPPORTED' });
  }
  meta.referenceImageFilenames = providerInputs.referenceImagePaths.map(path => basename(path));
  meta.referenceImageStrengths = validReferenceImageStrengths.filter((_, index) => providerInputs.referenceImagePaths.includes(validReferenceImagePaths[index]));
  if (!providerInputs.initImagePath) {
    meta.initImageFilename = null;
    meta.initImageStrength = null;
    for (const key of ['cleanedFrom', 'regenerated', 'regenMethod', 'regenStrength', 'regenSteps', 'regenModelId']) {
      delete meta[key];
      delete job[key];
    }
  }
  Object.assign(job, meta);
}

async function prepareLocalGpu(jobId) {
  const { prepareLocalMemory, gpuBlockersMessage } = await import('../localMemory.js');
  const memoryReport = await prepareLocalMemory();
  // Something the unload above cannot evict already owns the GPU (today: the
  // vLLM Qwen container). Refuse here rather than let mflux die inside its
  // model load with an OOM that names neither the tenant nor the fix (#4766).
  if (memoryReport.blockers.length) {
    throw new ServerError(gpuBlockersMessage(memoryReport.blockers), { status: 409, code: 'GPU_BLOCKED', context: { blockers: memoryReport.blockers } });
  }
  if (memoryReport.unloaded.length) console.log(`🧹 Image generation [${jobId.slice(0, 8)}] freed ${memoryReport.unloaded.length} resident model(s)`);
}

function assertRenderNotCanceled(preparation) {
  if (preparation.cancelRequested) {
    throw new ServerError('Canceled before the render started', { status: 409, code: 'IMAGE_GEN_CANCELED' });
  }
}

async function launchLocalChild(render, stepwiseDir) {
  const {
    jobId, model, modelId, meta, actualSteps, actualGuidance, actualSeed, width, height,
    pythonPath, renderPrompt, negativePrompt, quantize, outputPath, validLoras, loraScales,
    validInitImagePath, validInitImageStrength, validReferenceImagePaths, validReferenceImageStrengths,
    minimaxRuntime, reviewedReferenceSnapshot,
  } = render;
  const preparation = { cancelRequested: false };
  preparing = preparation;

  let heavyClaim = null;
  const releaseHeavyClaim = () => {
    if (!heavyClaim?.release) return Promise.resolve();
    return maintenance.continueSettlement(() => heavyClaim.release())
      .catch((err) => {
        maintenance.markCurrentUnsettled();
        console.error(`❌ Image generation claim release [${jobId.slice(0, 8)}]: ${err.message}`);
      });
  };
  const removeStepwise = () => maintenance.continueSettlement(
    () => rmGuarded(stepwiseDir, { recursive: true, force: true }),
  ).catch((err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Image generation scratch cleanup [${jobId.slice(0, 8)}]: ${err.message}`);
  });
  let proc;
  let startedEmitted = false;
  try {
    const { bin, args, providerInputs } = buildArgs({
      pythonPath, model, prompt: renderPrompt, negativePrompt, width: Number(width), height: Number(height),
      steps: actualSteps, guidance: actualGuidance, seed: actualSeed, quantize, outputPath, loraPaths: validLoras,
      loraScales, stepwiseDir, initImagePath: validInitImagePath, initImageStrength: validInitImageStrength,
      referenceImagePaths: validReferenceImagePaths, referenceImageStrengths: validReferenceImageStrengths, minimaxRuntime,
    });
    recordProviderInputs(render, providerInputs);
    heavyClaim = await claimHeavyLocalJob({ kind: 'local image generation', id: jobId });
    if (!heavyClaim.ok) {
      throw new ServerError(heavyClaim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: heavyClaim.holder } });
    }
    await prepareLocalGpu(jobId);

    const tokenEnv = usesMossSwift(model) || usesMinimaxH3Image(model) ? null : await hfChildEnv();
    const childEnv = usesMossSwift(model) ? mossChildEnv() : usesFlux3(model) ? flux3Env(tokenEnv)
      : usesMinimaxH3Image(model) ? minimaxH3ImageEnv() : tokenEnv;
    // A cancel() during GPU preparation found no child to signal.
    assertRenderNotCanceled(preparation);

    console.log(`🎨 Generating image [${jobId.slice(0, 8)}] local: ${modelId} ${width}x${height} steps=${actualSteps} references=${meta.referenceImageFilenames.length}`);
    imageGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps });
    startedEmitted = true;
    activeJob = { ...meta, generationId: jobId, totalSteps: actualSteps, step: 0, progress: 0, currentImage: null, mode: IMAGE_GEN_MODE.LOCAL };

    if (reviewedReferenceSnapshot || [validInitImagePath, ...validReferenceImagePaths].some(path => path?.startsWith(join(PATHS.imageRefs, 'snapshot-')))) {
      const { assertSnapshotForAdapter } = await import('./reviewedReference.js');
      await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, validInitImagePath, validReferenceImagePaths);
      assertRenderNotCanceled(preparation);
    }
    proc = spawn(bin, args, safeChildProcessOptions({ env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }));
    // Same tick as the spawn, before the claim handoff below awaits file I/O: a
    // child that dies inside that window would otherwise emit 'close' with no
    // listener, leaving the job running and the GPU lane held forever (#11761).
    const takeEarlyExit = bufferChildExit(proc, { bufferOutput: true });
    // Hold off idle/system sleep for the child's lifetime: a laptop that idles
    // to sleep mid-render (or mid first-run model download) wakes to an idle
    // watchdog kill. `-is` without `-d` lets the display sleep, as in video and
    // LoRA training — a forced-awake display contends with Metal. `-w` releases
    // the assertion when the child exits, including after a server crash.
    if (process.platform === 'darwin' && proc.pid) {
      spawn('caffeinate', ['-is', '-w', String(proc.pid)], { stdio: 'ignore' }).on('error', () => {});
    }
    activeProcess = proc;
    preparing = null;
    await heavyClaim.handoffTo?.(proc.pid);
    return { proc, bin, takeEarlyExit, releaseHeavyClaim, removeStepwise };
  } catch (err) {
    if (preparing === preparation) preparing = null;
    // An unwired render cannot settle itself.
    if (proc?.pid) {
      maintenance.markCurrentUnsettled();
      // No close handler is wired yet, so nothing else will ever reap this child.
      try {
        killWithEscalation(proc, { label: 'abandoned image child', stillRunning: () => true });
      } catch (killErr) {
        console.error(`❌ Abandoned image child would not stop [${jobId.slice(0, 8)}]: ${killErr.message}`);
      }
    }
    if (activeProcess === proc) activeProcess = null;
    if (activeJob?.generationId === jobId) activeJob = null;
    if (startedEmitted) {
      imageGenEvents.emit('failed', { mode: IMAGE_GEN_MODE.LOCAL, generationId: jobId, error: err.message, inputProcessSettled: !proc?.pid });
    }
    await releaseHeavyClaim();
    jobs.delete(jobId);
    await removeStepwise();
    throw err;
  }
}

function startStepwiseWatcher(stepwiseDir, jobId) {
  // Watch the stepwise output dir for new PNGs. When a new file appears,
  // base64-encode the latest one and emit it as `currentImage`. fs.watch
  // fires multiple times per write — keep a single in-flight read and a
  // pending flag so we always get the *latest* frame without piling up reads.
  let watcher = null;
  let reading = false;
  let pendingFrame = false;
  const processLatestFrame = async () => {
    if (reading) { pendingFrame = true; return; }
    reading = true;
    try {
      // Sort by mtime, not filename. mflux names files like `step_1.png` …
      // `step_20.png` (no zero-padding), so alphabetical sort puts `step_2`
      // *after* `step_19` and we'd render an early-step latent (mostly noise)
      // instead of the latest. Also drop mflux's `seed_*_composite.png` —
      // it writes that grid right after every step, so its mtime always wins
      // the "latest" race and the user would see a growing thumbnail strip
      // instead of the live diffusion frame.
      const names = (await readdir(stepwiseDir)).filter((f) => f.endsWith('.png') && !f.includes('composite'));
      const stats = await Promise.all(names.map(async (n) => {
        const s = await stat(join(stepwiseDir, n)).catch(() => null);
        return s ? { n, mtimeMs: s.mtimeMs } : null;
      }));
      const latest = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.n;
      if (latest) {
        const buf = await readFile(join(stepwiseDir, latest));
        const currentImage = buf.toString('base64');
        if (activeJob && activeJob.generationId === jobId) activeJob.currentImage = currentImage;
        imageGenEvents.emit('progress', { generationId: jobId, currentImage });
      }
    } catch (err) {
      // Partial PNG mid-write or stepwise dir gone after cancel — common,
      // don't spam, but surface the message so a stalled preview is debuggable.
      console.log(`⚠️ Frame read error [${jobId.slice(0, 8)}]: ${err?.message}`);
    }
    reading = false;
    if (pendingFrame) { pendingFrame = false; void processLatestFrame(); }
  };
  try {
    watcher = fsWatch(stepwiseDir, (event) => {
      if (event === 'rename') void processLatestFrame();
    });
    // Windows raises EPERM here when the watched dir is deleted; with no listener
    // that is an uncaught exception and the server exits.
    watcher.on?.('error', (err) => {
      console.warn(`⚠️ Stepwise watcher error [${jobId.slice(0, 8)}]: ${err?.message}`);
    });
  } catch { /* if watch fails, we still get final image — degrade gracefully */ }
  return () => { try { watcher?.close(); } catch { /* already closed */ } };
}

function wireLocalOutput(proc, { jobId, job, meta }) {
  // Keep only the recent stderr tail needed by the failure classifier.
  const stderrTailLimit = 64 * 1024;
  let stderrBuffer = '';
  const handleLine = createLocalOutputParser({
    onActivity: () => imageGenEvents.emit('activity', { generationId: jobId }),
    onExecution: (execution) => {
      meta.executionProvenance = execution;
      job.executionProvenance = execution;
      if (activeJob?.generationId === jobId) activeJob.executionProvenance = execution;
    },
    onFrame: (frame) => broadcastSse(job, frame),
    onInferenceProgress: (progress) => {
      imageGenEvents.emit('progress', { generationId: jobId, ...progress });
      if (activeJob?.generationId === jobId) Object.assign(activeJob, progress);
    },
  });
  const shortId = jobId.slice(0, 8);
  // Route marker parsing through per-stream line readers so a STAGE:/STATUS:/
  // DOWNLOAD: marker (or a multibyte char) split across a pipe chunk boundary
  // can't tear a progress event. Each reader carries the partial trailing line
  // across chunks and is flushed on 'close'.
  const runnerLineReader = (prefix) => createLineReader((line) => {
    const trimmed = line.trim();
    try {
      if (!handleLine(trimmed)) console.log(`${prefix} [${shortId}] ${trimmed}`);
    } catch (err) {
      // A progress subscriber must not interrupt stream draining or exit cleanup.
      console.error(`❌ Image generation output dispatch failed [${shortId}]: ${err?.message || err}`);
    }
  }, { splitRe: /[\n\r]+/ });
  const stderrReader = runnerLineReader('🐍');
  const stdoutReader = runnerLineReader('🐍-out');
  proc.stderr.on('data', (chunk) => {
    // Keep the raw diagnostics independently of which lines drive progress.
    const text = chunk.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > stderrTailLimit) {
      stderrBuffer = stderrBuffer.slice(-stderrTailLimit);
    }
    stderrReader.push(chunk);
  });
  proc.stdout.on('data', (chunk) => {
    stdoutReader.push(chunk);
  });
  return {
    flush() {
      stderrReader.flush();
      stdoutReader.flush();
    },
    failureLines: () => stderrBuffer.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

function finalizeLocalFailure({ jobId, job, model }, { code, signal, processError, lines }) {
  job.status = 'error';
  const reason = processError?.message || (signal ? `Killed by signal ${signal}` : `Exit code ${code}`);
  const { userMessage, userKind, userRepo, invalidateTorchHealth } = classifyLocalRenderFailure({
    lines, usesTorchVenv: usesTorchVenv(model),
  });
  // The preflight's cached health verdict can be stale after a broken import.
  if (invalidateTorchHealth) invalidateFlux2Health();
  const tail = lines.slice(-10).join('\n');
  const errorText = userMessage
    ? `${userMessage}\n\n(diagnostic) ${reason}`
    : `Generation failed: ${reason}\n${tail}`;
  console.error(`❌ Image generation failed [${jobId.slice(0, 8)}]: ${userMessage || reason}`);
  job.error = userMessage || errorText;
  job.errorKind = userKind;
  job.errorRepo = userRepo;
  // Propagate the friendly message (not the raw "Exit code 1") to the
  // job queue so its `failed` log line and future SSE replays carry it.
  dispatchTerminalEvent(
    jobId,
    () => broadcastSse(job, { type: 'error', error: errorText, kind: userKind, repo: userRepo }),
    () => imageGenEvents.emit('failed', { mode: IMAGE_GEN_MODE.LOCAL, generationId: jobId, inputProcessSettled: true, error: job.error }),
  );
}

async function finalizeLocalSuccess(render) {
  const { job, jobId, meta, upscaleTo, filename, outputPath, regenOf, validInitImagePath,
    outputDir, skipSidecar, cleanC2PA, denoise, actualSeed, publicPath } = render;
  job.status = 'complete';
  // Large-source regen (issue #912): the render ran at a clamped FLUX-sane
  // resolution. Upscale the result back to the requested delivery size so
  // the watermark-free copy matches the original's resolution. `meta.width/
  // height` currently hold the render dims; record those as render* and
  // promote the delivered dims so the gallery shows the real file size.
  const targetW = Math.round(Number(upscaleTo?.width));
  const targetH = Math.round(Number(upscaleTo?.height));
  if (targetW > 0 && targetH > 0 && (targetW !== meta.width || targetH !== meta.height)) {
    const { default: sharp } = await import('sharp');
    const resized = await sharp(outputPath)
      .resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' })
      // compressionLevel 6 (sharp default) — near-identical size to 9 but
      // markedly faster, and this re-encode is on the render-completion path.
      .png({ compressionLevel: 6 })
      .toBuffer()
      .catch((err) => { console.warn(`⚠️ Regen upscale failed for ${filename}: ${err?.message || err}`); return null; });
    if (resized) {
      await atomicWrite(outputPath, resized);
      meta.renderWidth = meta.width;
      meta.renderHeight = meta.height;
      meta.width = targetW;
      meta.height = targetH;
      console.log(`🔍 Upscaled regen [${jobId.slice(0, 8)}] ${meta.renderWidth}x${meta.renderHeight} → ${targetW}x${targetH}`);
    }
  }
  // Regen fidelity (issue #912): for a regen pass, measure how much the
  // delivered image actually changed vs. the source so the sidecar records
  // the *realized* delta, not just the requested strength. Catches the
  // mflux strength-0.0 footgun, silent txt2img fallbacks, and over-mutation.
  // Best-effort — a decode failure just skips the stamp.
  if (regenOf && validInitImagePath) {
    const delta = await import('./regen.js')
      .then(({ computePixelDelta }) => computePixelDelta(validInitImagePath, outputPath))
      .catch(() => null);
    if (delta) {
      meta.regenPixelDeltaPct = delta.pixelDeltaPct;
      meta.regenPsnr = delta.psnr;
      console.log(`📐 Regen fidelity [${jobId.slice(0, 8)}]: ${delta.pixelDeltaPct}% changed, PSNR ${delta.psnr}dB`);
    }
  }
  // Sidecar: persist a metadata record next to the PNG so the gallery
  // and Remix flow can recover prompt/seed/steps even if mflux's own
  // --metadata sidecar lives at a slightly different filename shape.
  // A non-gallery target (issue #2264, the Image Cleaner's temp render)
  // skips this write entirely — the temp bytes are consumed by an explicit
  // result-fetch, so there's no gallery record to hydrate.
  const sidecar = join(outputDir, `${jobId}.metadata.json`);
  if (!skipSidecar) {
    // Render timing is stamped onto `meta` (not spread at the write) so the
    // sidecar and the `autoCleanGeneratedImage` rewrite below agree on it.
    Object.assign(meta, renderTimingFields(job.renderStartedAtMs));
    await atomicWrite(sidecar, meta);
    // Cleaners run BEFORE the SSE complete + completed events so subscribers
    // see the cleaned bytes. Local FLUX renders never carry C2PA chunks so
    // cleanC2PA is a no-op on local — denoise is the only mode that does
    // anything here.
    await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode: IMAGE_GEN_MODE.LOCAL });
  }
  console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename}${skipSidecar ? ' (temp, no sidecar)' : ''}`);
  // A non-gallery render has no `/data/images` mount — carry the absolute
  // `outputPath` so the queue/route can read the finished bytes; `path`
  // stays null so nothing treats it as a gallery URL.
  const result = { filename, seed: actualSeed, path: publicPath, outputPath, ...(meta.executionProvenance ? { executionProvenance: meta.executionProvenance } : {}) };
  // Include `seed` so /sdapi/v1/txt2img can surface the actual seed used
  // (mflux generates a random one if the client didn't pass one). Emit the
  // gallery `completed` (which drives the media-asset index + peer-sync
  // hooks) ONLY for a gallery target — a temp render must not be indexed or
  // federated. The queue's own `completed` handler still fires off the
  // return value below, so the job settles either way.
  dispatchTerminalEvent(
    jobId,
    () => broadcastSse(job, { type: 'complete', result }),
    () => {
      if (!skipSidecar) {
        imageGenEvents.emit('completed', { mode: IMAGE_GEN_MODE.LOCAL, generationId: jobId, inputProcessSettled: true, path: publicPath, filename, seed: actualSeed, ...(meta.executionProvenance ? { executionProvenance: meta.executionProvenance } : {}) });
      } else {
        // `temp: true` tells the media-asset-index + peer-sync hooks to
        // ignore this render — there's no gallery file or sidecar to
        // index/federate.
        imageGenEvents.emit('completed', { mode: IMAGE_GEN_MODE.LOCAL, generationId: jobId, inputProcessSettled: true, path: null, filename, seed: actualSeed, outputPath, temp: true, ...(meta.executionProvenance ? { executionProvenance: meta.executionProvenance } : {}) });
      }
    },
  );
}

function reportLocalError({ job, jobId }, reason, lifecycleFields = {}) {
  job.status = 'error';
  job.error = reason;
  dispatchTerminalEvent(
    jobId,
    () => broadcastSse(job, { type: 'error', error: reason }),
    () => imageGenEvents.emit('failed', { mode: IMAGE_GEN_MODE.LOCAL, generationId: jobId, ...lifecycleFields, error: reason }),
  );
}

async function finalizeLocalExit(render, exit) {
  const { jobId, outputPath, outputDir } = render;
  try {
    // A successful exit can still leave an empty frame. Reject it before publishing.
    const emptyFrame = exit.code === 0 ? await rejectDegenerateFrame(outputPath) : null;
    if (emptyFrame) {
      console.error(`❌ Image generation failed [${jobId.slice(0, 8)}]: ${emptyFrame}`);
      reportLocalError(render, emptyFrame, { inputProcessSettled: true });
    } else if (exit.code !== 0 || exit.processError) {
      finalizeLocalFailure(render, { ...exit, lines: exit.readFailureLines() });
    } else {
      await finalizeLocalSuccess(render);
    }
  } catch (err) {
    const reason = err?.message || String(err);
    console.error(`❌ Image generation post-exit handler failed [${jobId.slice(0, 8)}]: ${reason}`);
    await Promise.all([outputPath, join(outputDir, `${jobId}.metadata.json`)].map(path => unlinkGuarded(path).catch(() => {})));
    reportLocalError(render, reason, { inputProcessSettled: true });
  } finally {
    closeJobAfterDelay(jobs, jobId);
  }
}

function wireLocalChild(render, child, stepwiseDir) {
  const { jobId, job } = render;
  const { proc, bin, takeEarlyExit, releaseHeavyClaim, removeStepwise } = child;
  // Node can emit both 'error' and 'close' for a spawn ENOENT.
  let finalized = false;
  let processError;
  proc.on('error', (err) => {
    processError = err;
    if (finalized || proc.pid) return;
    finalized = true;
    job.status = 'error';
    const reason = `Failed to spawn ${bin}: ${err.message}`;
    console.error(`❌ Image generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    void releaseHeavyClaim();
    stopWatching();
    void removeStepwise();
    dispatchTerminalEvent(
      jobId,
      () => broadcastSse(job, { type: 'error', error: reason }),
      () => imageGenEvents.emit('failed', { mode: IMAGE_GEN_MODE.LOCAL, generationId: jobId, error: reason }),
    );
    activeProcess = null;
    activeJob = null;
    closeJobAfterDelay(jobs, jobId);
  });

  const stopWatching = startStepwiseWatcher(stepwiseDir, jobId);
  const output = wireLocalOutput(proc, render);
  proc.on('close', (code, signal) => {
    void withBackupAssetPublication(async () => {
      if (finalized) return;
      finalized = true;
      // An unterminated final line can still update the active job.
      output.flush();
      activeProcess = null;
      activeJob = null;
      void releaseHeavyClaim();
      stopWatching();
      void removeStepwise();
      await finalizeLocalExit(render, { code, signal, processError, readFailureLines: output.failureLines });
    }).catch(async (err) => {
      // Admission refused before the finalizer ran. Settle without touching
      // gallery bytes outside the backup publication boundary.
      if (finalized) return;
      finalized = true;
      activeProcess = null;
      activeJob = null;
      stopWatching();
      await Promise.all([releaseHeavyClaim(), removeStepwise()]);
      reportLocalError(render, err?.message || String(err), { inputProcessSettled: true });
      closeJobAfterDelay(jobs, jobId);
    });
  });

  const shortId = jobId.slice(0, 8);
  // Every real listener is on and nothing has awaited since: hand over whatever
  // the child emitted during the claim handoff so a fast-dying render still
  // reaches its terminal handlers and releases the claim.
  const earlyExit = takeEarlyExit();
  if (earlyExit) {
    console.warn(`⚠️ Image render child exited before it was wired [${shortId}]`);
    for (const { stream, chunk } of earlyExit.output || []) proc[stream].emit('data', chunk);
    if (earlyExit.type === 'error') proc.emit('error', earlyExit.error);
    else if (earlyExit.type === 'close') proc.emit('close', earlyExit.code, earlyExit.signal);
  }
}

export async function generateImage({ pythonPath, prompt = '', negativePrompt = '', modelId = LOCAL_IMAGEGEN_DEFAULT_MODEL, width = 1024, height = 1024, steps, guidance, seed, quantize = '8', loraFilenames = [], loraPaths = [], loraScales = [], initImagePath = null, initImageStrength = null, referenceImagePaths = [], referenceImageStrengths = [], visualConditioning = null, jobId: providedJobId = null, reviewedReferenceSnapshot = null, cleanC2PA = false, denoise = false, regenOf = null, upscaleTo = null, outputTarget = null, promptAdditions = [] }) {
  // The ingestion instant `renderTimingFields` measures from — the queue calls
  // generateImage the moment it picks this job up. See lib/renderTiming.js.
  const renderStartedAtMs = Date.now();
  // Empty prompt is allowed: img2img / edit / unconditional renders are driven
  // by the init image (or run unconditionally), so text isn't required. The
  // mflux/diffusers runners accept an empty `--prompt` — the regen pass (#912)
  // has always relied on this for minimal-mutation, watermark-overwriting img2img.
  // Single-flight is enforced by the mediaJobQueue worker upstream. Direct
  // callers that bypass the queue must not run two concurrent renders — the
  // activeProcess handle below would be clobbered and cancel() would orphan
  // the first child.
  const { model, minimaxRuntime } = await preflightLocalModel({
    modelId, pythonPath, negativePrompt, width, height, steps, initImagePath,
    referenceImagePaths, referenceImageStrengths, loraPaths, loraFilenames,
  });
  // Non-gallery render target (issue #2264): the Image Cleaner's GPU FLUX
  // round-trip renders to a temp dir with NO sidecar, so a clean pass never
  // pollutes the gallery by default. See `resolveOutputPlacement` for the exact
  // branch logic (unit-tested in local.test.js).
  const { outputDir, skipSidecar } = resolveOutputPlacement(outputTarget);

  await ensureDir(outputDir);
  await ensureDir(PATHS.loras);

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(outputDir, filename);
  // The public path a gallery render mounts at (`/data/images/<f>`). A
  // non-gallery render has no static mount, so the queue reads the finished
  // bytes off `outputPath` directly (surfaced as `outputPath` in the result).
  const publicPath = outputDir === PATHS.images ? `/data/images/${filename}` : null;
  const metadata = await prepareLocalRenderMeta({
    jobId, model, modelId, prompt, negativePrompt, width, height, steps, guidance, seed, quantize,
    loraFilenames, loraPaths, loraScales, initImagePath, initImageStrength, referenceImagePaths,
    referenceImageStrengths, visualConditioning, regenOf, promptAdditions,
  });
  const { meta, actualSeed } = metadata;
  // Publish the running entry once its stepwise scratch directory exists.
  const stepwiseDir = await mkdtemp(join(tmpdir(), 'portos-stepwise-'));
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);
  const render = {
    ...metadata, job, jobId, model, modelId, pythonPath, negativePrompt, width, height, quantize, loraScales,
    outputPath, filename, outputDir, publicPath, skipSidecar, cleanC2PA, denoise, regenOf,
    upscaleTo, reviewedReferenceSnapshot, minimaxRuntime,
  };
  const child = await launchLocalChild(render, stepwiseDir);
  wireLocalChild(render, child, stepwiseDir);

  return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode: IMAGE_GEN_MODE.LOCAL, model: modelId, seed: actualSeed };
}
