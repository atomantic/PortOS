/**
 * Video Gen: Gemini Omni 1.2 Flash through the Gemini web app.
 *
 * A cloud lane with the same job-map/SSE contract as `videoGen/runway.js`, so
 * `mediaJobQueue` dispatches here on `params.mode === 'gemini'`. There is no
 * Gemini API on this route: geminiWebDriver.js works the signed-in PortOS
 * Browser, and the render counts against that Google account's plan. The prompt
 * reaches Gemini as written, with the start frame first and references after it.
 */
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { GEMINI_OMNI_WEB_MODEL, geminiWebAspectChoice } from '../../lib/geminiWebVideo.js';
import { carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';
import { formatRetryWait, isTransientProviderError, runWithTransientRetry, TRANSIENT_RETRY_DELAYS_MS } from '../../lib/providerTransientRetry.js';
import { videoGenEvents } from './events.js';
import { CLOUD_RENDER_PHASE, discardUnpublishedVideo, emitCloudRenderStatus, finalizeGeneratedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { renderOnGeminiWeb } from './geminiWebDriver.js';

const GEMINI_WEB_TIMEOUT_MS = 20 * 60 * 1000;
// The page reports no render progress, so the meter's render stretch is an estimate that
// approaches, but never reaches, its ceiling; it rests near it if a render runs long.
const RENDER_METER_FLOOR = 0.2;
const RENDER_METER_SPAN = 0.7;
const RENDER_METER_SCALE_MS = 2 * 60 * 1000;

const jobs = new Map();
const activeRequests = new Map();
const activeJobs = new Map();
const preparations = createMediaJobPreparation();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export const cancel = (jobId) => {
  if (!jobId) throw new Error('videoGen/geminiWeb.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  return true;
};

export const cancelAll = () => {
  const ids = [...preparations.ids(), ...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

const isStagedUpload = (path) => {
  const rel = relative(PATHS.uploads, resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

export const generateVideo = (params) => preparations.run(params, generateVideoPrepared);

async function generateVideoPrepared({
  prompt = '', aspectRatio, width, height, sourceImagePath = null, castReferences = [],
  jobId: providedJobId = null, uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null,
  shotInstruction = null, promptAdditions = [],
}) {
  await ensureDir(PATHS.videos);
  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const aspectChoice = geminiWebAspectChoice(frameAspect || aspectRatio, width, height);
  const meta = {
    id: jobId,
    prompt: (prompt || '').trim(),
    negativePrompt: '',
    modelId: `gemini:${GEMINI_OMNI_WEB_MODEL.id}`,
    duration: GEMINI_OMNI_WEB_MODEL.clipSeconds,
    ...sentPromptRecord({ sentPrompt: prompt, sentNegativePrompt: null, carried: carriedPromptAdditions({ promptAdditions }), added: [] }),
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
    ...(shotInstruction?.audioWindow ? { audioWindow: shotInstruction.audioWindow } : {}),
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs: Date.now() };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] gemini web (${GEMINI_OMNI_WEB_MODEL.id}, ${(castReferences.length + (sourceImagePath ? 1 : 0))} images)`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Waiting for the PortOS Browser…');

  runGeminiWebVideo(job, jobId, {
    prompt, aspectChoice, filename, meta, uploadedTempPath, uploadedTempPaths,
    files: [sourceImagePath, ...castReferences.map((ref) => ref.path)].filter(Boolean),
  }).catch((err) => {
    console.error(`❌ Gemini web video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return { jobId, filename, path: `/data/videos/${filename}`, generationId: jobId, mode: 'gemini', status: 'running' };
}

// Each driver phase's place on the job's meter and the line the queue shows beside it.
const PHASE_STATUS = {
  open: { phase: CLOUD_RENDER_PHASE.SUBMIT, progress: 0.03, message: 'Opening Gemini in the PortOS Browser…' },
  attach: { phase: CLOUD_RENDER_PHASE.SUBMIT, progress: 0.08, message: 'Uploading the start frame and references…' },
  send: { phase: CLOUD_RENDER_PHASE.SUBMIT, progress: 0.15, message: 'Sending the prompt to Gemini…' },
  fetch: { phase: CLOUD_RENDER_PHASE.FETCH, progress: 0.95, message: 'Downloading video…' },
};

// Only an answer in the chat with no clip is safe to resend: a timeout may still render and charge.
const isBusyRefusal = (err) => err?.code === 'GEMINI_WEB_REFUSED' && isTransientProviderError(err);

/** The wait between busy answers, on the card (structured `retry`) and in the queue (the line). */
function reportRetryWait(job, jobId, { retry, retries, remainingMs }) {
  const message = `Gemini is busy. Trying again in ${formatRetryWait(remainingMs)} (retry ${retry} of ${retries})…`;
  videoGenEvents.emit('progress', {
    generationId: jobId, progress: PHASE_STATUS.open.progress, step: 0, totalSteps: 1, message,
    retry: { attempt: retry, of: retries, inMs: remainingMs, reason: 'busy' },
  });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, message);
}

/** The job's error once Gemini stayed busy through every retry: what it said and that Retry is the next step. */
export function busyExhaustedMessage(err) {
  const retries = err?.transientRetriesExhausted;
  if (!retries || !isBusyRefusal(err)) return err?.message || String(err);
  const minutes = Math.round(TRANSIENT_RETRY_DELAYS_MS.slice(0, retries).reduce((sum, ms) => sum + ms, 0) / 60_000);
  return `${err.message} (still busy after ${retries} retries over ${minutes} min; tap Retry to try again)`;
}

function reportPhase(job, jobId, name, sentAtMs) {
  const status = PHASE_STATUS[name] || {
    phase: CLOUD_RENDER_PHASE.RENDER,
    message: 'Gemini is rendering…',
    progress: RENDER_METER_FLOOR + RENDER_METER_SPAN * (1 - Math.exp(-(Date.now() - sentAtMs) / RENDER_METER_SCALE_MS)),
  };
  videoGenEvents.emit('progress', { generationId: jobId, progress: status.progress, step: 0, totalSteps: 1 });
  emitCloudRenderStatus(job, jobId, status.phase, status.message);
}

async function runGeminiWebVideo(job, jobId, { prompt, aspectChoice, files, filename, meta, uploadedTempPath, uploadedTempPaths }) {
  const outputPath = join(PATHS.videos, filename);
  const entry = { controller: new AbortController(), aborted: preparations.take(jobId) };
  const publication = {};
  let inputCleanup;
  const settleInputs = () => (inputCleanup ??= (async () => {
    const inputs = new Set([uploadedTempPath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])]);
    for (const path of inputs) {
      if (!path || !isStagedUpload(path)) continue;
      await unlink(path).catch((error) => {
        if (error.code === 'ENOENT') return;
        maintenance.markCurrentUnsettled();
        maintenance.markResourceUnsettled('media', jobId);
        console.error(`❌ Gemini staged-input cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
      });
    }
  })());
  const finishFailure = async (reason) => {
    await settleInputs();
    if (entry.aborted) return finalizeCanceled(job, jobId);
    return finalizeJobFailure(job, jobId, null, reason, { force: true });
  };
  activeRequests.set(jobId, entry);
  try {
    if (entry.aborted) return finishFailure('Canceled');
    let sentAtMs = Date.now();
    const signal = entry.controller.signal;
    // Gemini answers "at capacity" in the chat without rendering; each resend opens a fresh chat.
    const { chatUrl } = await runWithTransientRetry(() => renderOnGeminiWeb({
      prompt, files, aspectChoice, outputPath,
      deadline: Date.now() + GEMINI_WEB_TIMEOUT_MS,
      signal,
      onPhase: (name) => {
        if (name === 'send') sentAtMs = Date.now();
        reportPhase(job, jobId, name, sentAtMs);
      },
    }), {
      signal,
      isTransient: isBusyRefusal,
      onRetryWait: (wait) => {
        if (wait.remainingMs === TRANSIENT_RETRY_DELAYS_MS[wait.retry - 1]) {
          console.log(`🔁 Gemini busy [${jobId.slice(0, 8)}]: retry ${wait.retry} of ${wait.retries} in ${formatRetryWait(wait.remainingMs)}`);
        }
        reportRetryWait(job, jobId, wait);
      },
    });
    if (entry.aborted) {
      await unlink(outputPath);
      return finishFailure('Canceled');
    }
    // The Music Video renderer trims every clip by its measured length.
    const measured = (await probeVideoGeometry(outputPath)) || {};
    activeRequests.delete(jobId);
    await settleInputs();
    activeJobs.delete(jobId);
    await finalizeGeneratedVideo({
      job, jobId, outputPath, filename, actualSeed: null, mutateHistory: mutateVideoHistory, publication,
      meta: { ...meta, ...measured, geminiChatUrl: chatUrl },
    });
    closeJobAfterDelay(jobs, jobId);
  } catch (err) {
    if (!publication.committed) await discardUnpublishedVideo({ jobId, outputPath }).catch((error) => {
      maintenance.markCurrentUnsettled();
      maintenance.markResourceUnsettled('media', jobId);
      console.error(`❌ Gemini video publication cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
    });
    return finishFailure(busyExhaustedMessage(err));
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'Gemini video generation',
  events: videoGenEvents,
});
const finalizeCanceled = finalizeJobFailure.canceled;
