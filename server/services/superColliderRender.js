/**
 * Contained SuperCollider renders for the Music Designer (#9413, epic #9407).
 *
 * One render = one media-queue job of kind `supercollider`. The job's params
 * carry the frozen source text, so every job (a retry included) writes its own
 * snapshot into a job-private directory:
 *
 *   data/supercollider/jobs/<jobId>/in/   source.scd + the trusted wrapper (mounted read-only)
 *   data/supercollider/jobs/<jobId>/out/  the only writable mount
 *
 * The wrapper (`SUPERCOLLIDER_RENDER_WRAPPER_SOURCE`) scores the source's
 * pattern for the requested duration and renders it offline through
 * `runSuperColliderContainer`, i.e. under the same containment policy the
 * readiness probe proved. The container is force-removed on success, failure,
 * timeout and cancel. The host then reads back ONE regular file within a size
 * bound and judges it by its decoded samples (format, duration, finite,
 * non-silent) before anything is published. A passing render lands as a
 * preview — `data/supercollider/previews/<jobId>.wav` plus a provenance
 * sidecar — and the job directory is always removed. Previews never touch a
 * track; saving one as a take is a separate explicit action.
 *
 * Machine-local and ephemeral (docs/STORAGE.md): previews expire after
 * PREVIEW_TTL_MS, and each render first sweeps stale job scratch and orphaned
 * render containers (a server restart mid-render leaves both behind).
 *
 * Nothing here runs at boot or calls an AI provider: a render starts only from
 * the user's explicit Render request.
 */

import { createHash } from 'crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/paths.js';
import { measureWavAudio } from '../lib/wavAudioFile.js';
import {
  SUPERCOLLIDER_CONTAINER_LABEL,
  SUPERCOLLIDER_CONTAINER_LIMITS,
  SUPERCOLLIDER_CONTAINER_PATHS,
  SUPERCOLLIDER_POLICY_VERSION,
  SUPERCOLLIDER_RENDER,
  SUPERCOLLIDER_RENDER_FORMAT,
  SUPERCOLLIDER_RENDER_WRAPPER_SOURCE,
  SUPERCOLLIDER_RUNTIME_VERSION,
  classifySuperColliderRenderLog,
  isSuperColliderDiagnosticLine,
  parseDockerContainerList,
  superColliderSmokeFailure,
} from '../lib/superColliderRuntime.js';
import { getSuperColliderStatus, readContainedOutput, resolveDockerCli, runSuperColliderContainer } from './superColliderRuntime.js';
import { audioGenEvents } from './audioGen/events.js';

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
// A job directory older than the wall limit plus slack cannot belong to a live
// run (every run is killed at the wall limit), whichever process started it.
const STALE_SCRATCH_MS = SUPERCOLLIDER_CONTAINER_LIMITS.wallTimeoutMs + 5 * 60_000;
const QUOTA_CHECK_MS = 1_000;
const MAX_OUTPUT_ENTRIES = 32;
const MAX_DIAGNOSTIC_LINES = 50;
const MAX_ERROR_CHARS = 600;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;

/** In-flight renders by job id: `{ controller, committing }`. */
const active = new Map();

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const clip = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}…` : flat;
};
const renderError = (message, code, status = 422) => new ServerError(clip(message), { status, code });

/** Bytes a valid float32 stereo render of `durationSec` occupies, plus header slack. */
const expectedWavBytes = (durationSec) => Math.ceil(durationSec * SUPERCOLLIDER_RENDER_FORMAT.sampleRate)
  * SUPERCOLLIDER_RENDER_FORMAT.channels * 4 + 64 * 1024;

export const superColliderSourceHash = (source) => sha256(String(source));

function resolveDirs(dataDir = PATHS.data) {
  const root = join(dataDir, 'supercollider');
  return { root, jobs: join(root, 'jobs'), previews: join(root, 'previews') };
}

const assertJobId = (jobId) => {
  if (!JOB_ID_RE.test(String(jobId ?? ''))) throw new ServerError('Invalid render id', { status: 400, code: 'VALIDATION_ERROR' });
};

/** Total bytes and entry count under `dir`, never following a symlink. */
async function measureTree(dir) {
  let bytes = 0;
  let entries = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    const names = await readdir(current).catch(() => []);
    for (const name of names) {
      entries += 1;
      if (entries > MAX_OUTPUT_ENTRIES) return { bytes, entries };
      const info = await lstat(join(current, name)).catch(() => null);
      if (info?.isDirectory()) pending.push(join(current, name));
      else if (info) bytes += info.size;
    }
  }
  return { bytes, entries };
}

/**
 * Remove render containers that outlived any possible run (a restart killed the
 * server mid-render, so nothing force-removed them). Age-gated, so a render or
 * setup probe started by another process on this machine is left alone.
 */
async function sweepOrphanContainers(docker, now = Date.now()) {
  const listed = await docker.capture(['ps', '--all', '--filter', `label=${SUPERCOLLIDER_CONTAINER_LABEL}=1`, '--format', '{{json .}}']);
  if (!listed.success) return 0;
  const orphans = parseDockerContainerList(listed.stdout)
    .filter(({ createdAtMs }) => createdAtMs !== null && now - createdAtMs > STALE_SCRATCH_MS);
  for (const { name } of orphans) {
    await docker.capture(['rm', '--force', name]);
    console.warn(`🧹 Removed orphaned SuperCollider render container ${name}`);
  }
  return orphans.length;
}

/** Drop job scratch no live render owns and previews past their TTL. */
async function sweepLocalArtifacts(dirs, now = Date.now()) {
  for (const name of await readdir(dirs.jobs).catch(() => [])) {
    if (active.has(name)) continue;
    const info = await lstat(join(dirs.jobs, name)).catch(() => null);
    if (info && now - info.mtimeMs > STALE_SCRATCH_MS) await rm(join(dirs.jobs, name), { recursive: true, force: true });
  }
  for (const name of await readdir(dirs.previews).catch(() => [])) {
    const info = await lstat(join(dirs.previews, name)).catch(() => null);
    if (info && now - info.mtimeMs > PREVIEW_TTL_MS) await rm(join(dirs.previews, name), { force: true });
  }
}

/**
 * Render one SuperCollider source to a preview WAV inside a disposable
 * container. Resolves the preview record; throws a ServerError (with a
 * `SUPERCOLLIDER_*` code) for an unavailable runtime, a source error, a
 * timeout, a cancellation or output that fails validation. Every path leaves
 * no job scratch behind, and only a passing render leaves a preview.
 *
 * @param {object} params
 * @param {string} params.jobId - names the job directory and the preview
 * @param {string} params.source - the frozen SuperCollider source
 * @param {number} params.durationSec - SUPERCOLLIDER_RENDER bounds
 * @param {number} params.seed
 * @param {AbortSignal} [params.signal]
 * @param {(event: {phase: string, message: string, progress?: number}) => void} [params.onPhase]
 * @param {object} [params.docker] - docker CLI adapter (tests); resolved when omitted
 * @param {string} [params.dataDir]
 * @param {number} [params.timeoutMs]
 */
export async function renderSuperColliderSource({
  jobId, source, durationSec, seed, signal, onPhase = () => {}, onActivity = () => {},
  docker: injectedDocker, dataDir = PATHS.data, timeoutMs = SUPERCOLLIDER_CONTAINER_LIMITS.wallTimeoutMs,
}) {
  assertJobId(jobId);
  if (typeof source !== 'string' || !source.trim()) throw renderError('The SuperCollider source is empty', 'VALIDATION_ERROR', 400);
  if (!Number.isFinite(durationSec) || durationSec < SUPERCOLLIDER_RENDER.minDurationSec || durationSec > SUPERCOLLIDER_RENDER.maxDurationSec) {
    throw renderError(`Duration must be ${SUPERCOLLIDER_RENDER.minDurationSec}–${SUPERCOLLIDER_RENDER.maxDurationSec} seconds`, 'VALIDATION_ERROR', 400);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > SUPERCOLLIDER_RENDER.maxSeed) throw renderError('Seed must be a non-negative 32-bit integer', 'VALIDATION_ERROR', 400);

  const docker = injectedDocker === undefined ? await resolveDockerCli() : injectedDocker;
  const status = await getSuperColliderStatus({ docker, dataDir });
  if (!status.ready) {
    throw new ServerError(`SuperCollider is not available: ${status.message}`, {
      status: 409, code: 'SUPERCOLLIDER_UNAVAILABLE', context: { state: status.state, action: status.action },
    });
  }

  const dirs = resolveDirs(dataDir);
  await sweepOrphanContainers(docker).catch((err) => console.warn(`⚠️ SuperCollider orphan sweep skipped: ${err.message}`));
  await sweepLocalArtifacts(dirs).catch((err) => console.warn(`⚠️ SuperCollider scratch sweep skipped: ${err.message}`));

  const jobDir = join(dirs.jobs, jobId);
  const inputDir = join(jobDir, 'in');
  const outputDir = join(jobDir, 'out');
  const sourceHash = superColliderSourceHash(source);
  const quota = {
    maxBytes: expectedWavBytes(durationSec) * 2 + 8 * 1024 * 1024,
    exceeded: null,
  };
  // One abort for both reasons the host stops a running container early: the
  // user canceled, or the output directory blew its quota.
  const stop = new AbortController();
  const forwardAbort = () => stop.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) stop.abort();
  const diagnostics = [];
  let quotaTimer = null;
  try {
    // Exclusive: two jobs can never share a directory, and a stale one with
    // this id (an earlier process's scratch) is replaced rather than reused.
    await rm(jobDir, { recursive: true, force: true });
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(inputDir, SUPERCOLLIDER_RENDER.source), source, { flag: 'wx' });
    await writeFile(join(inputDir, SUPERCOLLIDER_RENDER.wrapper), SUPERCOLLIDER_RENDER_WRAPPER_SOURCE, { flag: 'wx' });
    if (stop.signal.aborted) throw renderError('Render canceled', 'SUPERCOLLIDER_CANCELED', 409);

    // The per-file size ulimit bounds one file; this bounds the directory, so
    // source that writes many files cannot fill the host disk. Checked on a
    // timer because the container, not this process, does the writing.
    quotaTimer = setInterval(() => {
      measureTree(outputDir).then(({ bytes, entries }) => {
        if (bytes > quota.maxBytes || entries > MAX_OUTPUT_ENTRIES) {
          quota.exceeded = `the render wrote ${entries > MAX_OUTPUT_ENTRIES ? `more than ${MAX_OUTPUT_ENTRIES} files` : `${bytes} bytes`}, over its output limit`;
          stop.abort();
        }
      }).catch((err) => console.warn(`⚠️ SuperCollider output check failed: ${err.message}`));
    }, QUOTA_CHECK_MS);
    quotaTimer.unref?.();

    onPhase({ phase: 'starting', message: 'Starting the SuperCollider container', progress: 0.05 });
    const { input, output } = SUPERCOLLIDER_CONTAINER_PATHS;
    const run = await runSuperColliderContainer({
      docker,
      image: status.image.id,
      inputDir,
      outputDir,
      script: SUPERCOLLIDER_RENDER.wrapper,
      scriptArgs: [
        `${input}/${SUPERCOLLIDER_RENDER.source}`,
        `${output}/${SUPERCOLLIDER_RENDER.output}`,
        durationSec,
        SUPERCOLLIDER_RENDER_FORMAT.sampleRate,
        seed,
        60 / SUPERCOLLIDER_RENDER.tempoBpm,
      ],
      timeoutMs,
      signal: stop.signal,
      onLine: (line) => {
        onActivity();
        const phase = /^PORTOS_PHASE (\w+)$/.exec(line)?.[1];
        if (phase) {
          const progress = { compiling: 0.15, scoring: 0.3, rendering: 0.5 }[phase];
          onPhase({ phase, message: `${phase[0].toUpperCase()}${phase.slice(1)} the SuperCollider score`, ...(progress ? { progress } : {}) });
        } else if (isSuperColliderDiagnosticLine(line)) {
          diagnostics.push(line);
          if (diagnostics.length > MAX_DIAGNOSTIC_LINES) diagnostics.shift();
        }
      },
    });
    clearInterval(quotaTimer);
    quotaTimer = null;

    if (signal?.aborted || (run.cancelled && !quota.exceeded)) throw renderError('Render canceled', 'SUPERCOLLIDER_CANCELED', 409);
    if (quota.exceeded) throw renderError(`Render stopped: ${quota.exceeded}`, 'SUPERCOLLIDER_OUTPUT_QUOTA');
    if (run.timedOut) {
      throw renderError(`The SuperCollider render did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`, 'SUPERCOLLIDER_TIMEOUT', 504);
    }
    if (!run.ok) {
      const failure = classifySuperColliderRenderLog(diagnostics);
      if (failure) throw renderError(`${failure.message}${failure.detail ? ` (${failure.detail})` : ''}`, failure.code);
      throw renderError(`The SuperCollider render failed: ${run.error}`, 'SUPERCOLLIDER_RENDER_FAILED', 500);
    }

    onPhase({ phase: 'validating', message: 'Checking the rendered audio', progress: 0.9 });
    const tree = await measureTree(outputDir);
    if (tree.bytes > quota.maxBytes || tree.entries > MAX_OUTPUT_ENTRIES) {
      throw renderError('The render wrote more output than its limit allows', 'SUPERCOLLIDER_OUTPUT_QUOTA');
    }
    const wav = await readContainedOutput(outputDir, SUPERCOLLIDER_RENDER.output, { maxBytes: expectedWavBytes(durationSec) });
    const measurement = wav ? measureWavAudio(wav) : null;
    const invalid = superColliderSmokeFailure(measurement, { durationSec });
    if (invalid) throw renderError(`The rendered audio was rejected: ${invalid}`, 'SUPERCOLLIDER_OUTPUT_INVALID');

    if (stop.signal.aborted) throw renderError('Render canceled', 'SUPERCOLLIDER_CANCELED', 409);
    const job = active.get(jobId);
    if (job) job.committing = true;
    const preview = {
      jobId,
      createdAt: new Date().toISOString(),
      language: 'supercollider',
      source,
      sourceHash,
      seed,
      settings: {
        durationSec,
        sampleRate: SUPERCOLLIDER_RENDER_FORMAT.sampleRate,
        channels: SUPERCOLLIDER_RENDER_FORMAT.channels,
        tempoBpm: SUPERCOLLIDER_RENDER.tempoBpm,
      },
      runtime: { version: SUPERCOLLIDER_RUNTIME_VERSION, policyVersion: SUPERCOLLIDER_POLICY_VERSION, imageId: status.image.id },
      measurement: {
        durationMs: measurement.durationMs,
        channels: measurement.channels,
        sampleRate: measurement.sampleRate,
        peak: Number(measurement.peak.toFixed(4)),
        rms: Number(measurement.rms.toFixed(4)),
      },
    };
    await mkdir(dirs.previews, { recursive: true });
    // Audio first, sidecar last: a sidecar names a preview only once its audio is whole.
    const wavPath = join(dirs.previews, `${jobId}.wav`);
    await writeFile(`${wavPath}.partial`, wav);
    await rename(`${wavPath}.partial`, wavPath);
    const metaPath = join(dirs.previews, `${jobId}.json`);
    await writeFile(`${metaPath}.partial`, `${JSON.stringify(preview)}\n`);
    await rename(`${metaPath}.partial`, metaPath);
    console.log(`🎛️ SuperCollider render ${jobId.slice(0, 8)} passed (${measurement.durationMs} ms, peak ${preview.measurement.peak})`);
    return preview;
  } finally {
    if (quotaTimer) clearInterval(quotaTimer);
    signal?.removeEventListener('abort', forwardAbort);
    await rm(jobDir, { recursive: true, force: true })
      .catch((err) => console.error(`❌ SuperCollider job scratch ${jobId.slice(0, 8)} not removed: ${err.message}`));
  }
}

/** The public projection of a preview record (no source text: the client already holds it). */
export function presentSuperColliderPreview(preview) {
  const { source: _source, ...rest } = preview;
  return { ...rest, audioUrl: `/api/music/supercollider/renders/${encodeURIComponent(preview.jobId)}/audio` };
}

/**
 * Media-queue entry point for `kind: 'supercollider'` jobs: renders, then
 * announces the outcome on the audio event bus the queue listens to. Throws
 * on failure (the queue turns that into failed, or canceled after a cancel).
 */
export async function renderSuperCollider({ jobId, source, durationSec, seed }) {
  const job = { controller: new AbortController(), committing: false };
  active.set(jobId, job);
  let preview;
  try {
    preview = await renderSuperColliderSource({
      jobId,
      source,
      durationSec,
      seed,
      signal: job.controller.signal,
      onActivity: () => audioGenEvents.emit('activity', { generationId: jobId }),
      onPhase: ({ phase, message, progress }) => {
        if (typeof progress === 'number') audioGenEvents.emit('progress', { generationId: jobId, progress, message, phase });
        else audioGenEvents.emit('status', { generationId: jobId, message, phase });
      },
    });
  } finally {
    active.delete(jobId);
  }
  const result = { generationId: jobId, ...presentSuperColliderPreview(preview) };
  audioGenEvents.emit('completed', result);
  return result;
}

/** Cancel a running render; the container is force-removed by the runner. False once it is publishing. */
export function cancel(jobId) {
  const job = active.get(jobId);
  if (!job || job.committing) return false;
  job.controller.abort();
  return true;
}

/**
 * A finished preview: `{ wavPath, preview }`, or null when it never passed,
 * expired or the id is not one. The audio is only ever read back from the
 * host-written preview directory, never from a container's output.
 */
export async function readSuperColliderPreview(jobId, { dataDir = PATHS.data } = {}) {
  if (!JOB_ID_RE.test(String(jobId ?? ''))) return null;
  const { previews } = resolveDirs(dataDir);
  const wavPath = join(previews, `${jobId}.wav`);
  const [wavInfo, metaText] = await Promise.all([
    lstat(wavPath).catch(() => null),
    readFile(join(previews, `${jobId}.json`), 'utf8').catch(() => null),
  ]);
  if (!wavInfo?.isFile() || !metaText) return null;
  let preview;
  try { preview = JSON.parse(metaText); } catch { return null; }
  return preview?.jobId === jobId ? { wavPath, preview } : null;
}
