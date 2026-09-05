/** Reactor FastH3 renders one bounded SDK/WebRTC session per job. */
import { randomUUID } from 'crypto';
import { stat, rm } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { finalizeGeneratedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';

export const REACTOR_API_BASE = 'https://api.reactor.inc';
export const REACTOR_MODEL_ID = 'fast-h3';
export const REACTOR_MAX_PROMPT_LENGTH = 800;

const REACTOR_TOKEN_TIMEOUT_MS = 15_000;
const REACTOR_RENDER_TIMEOUT_MS = (() => {
  const n = Number(process.env.REACTOR_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();

// Per-job state uses the common cloud-lane SSE contract.
const jobs = new Map();
// Cancellation terminates the SDK session process and its remote connection.
const activeRequests = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

/**
 * Resolve the reactor.inc API key: settings override, else the
 * `REACTOR_API_KEY` env var (same settings-wins-over-env precedence as
 * `videoGen/fal.js`'s `resolveFalApiKey`).
 */
export function resolveReactorApiKey(settings) {
  const fromSettings = (settings?.videoGen?.reactor?.apiKey || '').trim();
  if (fromSettings) return fromSettings;
  const fromEnv = (process.env.REACTOR_API_KEY || '').trim();
  return fromEnv || null;
}

/**
 * Mint a short-lived session JWT scoped to `reactor/fast-h3`, bounded to one
 * concurrent session. Called by the `/api/video-gen/reactor/token` route AND
 * internally before every submit — the raw API key never leaves this module.
 */
export async function mintReactorToken(apiKey) {
  if (!apiKey) {
    throw new ServerError('No reactor.inc API key configured — set it in Settings > Video Gen or the REACTOR_API_KEY env var', { status: 400, code: 'REACTOR_NOT_CONFIGURED' });
  }
  const res = await fetchWithTimeout(`${REACTOR_API_BASE}/tokens`, {
    method: 'POST',
    headers: { 'Reactor-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authorization_details: [{ type: 'session', resources: { models: { match: [`reactor/${REACTOR_MODEL_ID}`] } }, constraints: { max_sessions: 1 } }],
    }),
  }, REACTOR_TOKEN_TIMEOUT_MS);
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.jwt) {
    const reason = `HTTP ${res.status}`;
    throw new ServerError(`reactor.inc token minting failed: ${reason}`, { status: 502, code: 'REACTOR_TOKEN_FAILED' });
  }
  return { jwt: payload.jwt, expiresAt: payload.expires_at || null };
}

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("videoGen/reactor.cancel requires a jobId — use cancelAll() to terminate every in-flight render");
  }
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.stop?.('Canceled');
  return true;
};

export const cancelAll = () => {
  const ids = [...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

export function validateReactorRequest({ prompt, continueFromClipId, seconds = 6, seed }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > REACTOR_MAX_PROMPT_LENGTH) {
    throw new ServerError('Reactor prompts must contain 1–800 characters; shorten the shot prompt before rendering', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (continueFromClipId) throw new ServerError('Reactor clip continuity requires the same active session; use a starting image for independent renders', { status: 400, code: 'REACTOR_SESSION_CONTINUITY_UNSUPPORTED' });
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 5.167 || Number(seconds) > 14.375) {
    throw new ServerError('Reactor duration must be between 5.167 and 14.375 seconds', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (seed != null && seed !== '' && (!Number.isSafeInteger(Number(seed)) || Number(seed) < 0)) {
    throw new ServerError('Reactor seed must be a non-negative integer', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return { prompt: prompt.trim(), seconds: Number(seconds), ...(seed != null && seed !== '' ? { seed: Number(seed) } : {}) };
}

function captureClip(entry, input, pythonPath, job, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [join(PATHS.root, 'scripts', 'reactor-render.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let outputBytes = 0;
    let complete = null;
    let failure = null;
    let killTimer;
    let stopping = false;
    const stop = (reason) => {
      if (stopping) return;
      stopping = true;
      failure ||= new Error(reason);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    };
    entry.stop = stop;
    const timeout = setTimeout(() => stop('Reactor render timed out'), REACTOR_RENDER_TIMEOUT_MS);
    timeout.unref?.();
    const countOutput = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1024 * 1024) stop('Reactor renderer exceeded its output limit');
    };
    child.stdout.on('data', (chunk) => {
      countOutput(chunk);
      if (failure) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'complete' && typeof message.clipId === 'string' && Number.isFinite(message.seconds)) complete = message;
          if (message.type === 'error' && /^[a-z]+$/.test(message.phase) && /^[A-Za-z]+$/.test(message.errorType)) failure = new Error(`Reactor ${message.phase} failed (${message.errorType})`);
          if (message.type === 'status') {
            if (typeof message.message === 'string' && /^Captured [0-9.]+ of [0-9.]+ frames; audio=(True|False)$/.test(message.message)) console.log(`🎬 ${message.message}`);
            broadcastSse(job, { type: 'status', message: 'Reactor session rendering…' });
            videoGenEvents.emit('activity', { generationId: jobId });
          }
        } catch {
          stop('Reactor renderer returned malformed output');
        }
      }
    });
    // SDK diagnostics can contain credentials or local paths. Bound and discard them.
    child.stderr.on('data', countOutput);
    child.stdin.on('error', () => stop('Could not send request to Reactor renderer'));
    child.on('error', () => {
      failure ||= new Error('Could not start Reactor renderer; run the Reactor runtime setup');
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      entry.stop = null;
      if (failure || code !== 0 || !complete) reject(failure || new Error('Reactor renderer failed before completing a clip; check the installed SDK runtime'));
      else resolve(complete);
    });
    child.stdin.end(JSON.stringify(input));
    if (entry.aborted) stop('Canceled');
  });
}

export async function generateVideo({
  settings, prompt = '', negativePrompt,
  continueFromClipId, seconds, seed,
  sourceImagePath = null, jobId: providedJobId = null,
}) {
  const request = validateReactorRequest({ prompt, continueFromClipId, seconds, seed });
  const pythonPath = process.env.REACTOR_PYTHON_PATH || join(PATHS.data, 'venvs', 'reactor', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const runtime = await stat(pythonPath).catch(() => null);
  if (!runtime?.isFile()) { throw new ServerError('Reactor runtime is missing. Run npm run setup:reactor, or set REACTOR_PYTHON_PATH', { status: 400, code: 'REACTOR_RUNTIME_MISSING' }); }
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();

  if (!prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // The reactor API key stays server-side: re-resolve live settings here
  // (mirrors videoGen/fal.js's precedent) rather than threading the secret
  // through job.params, where it would sit in plaintext in media-jobs.json.
  const effectiveSettings = settings || await getSettings().catch(() => null);
  const apiKey = resolveReactorApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError('No reactor.inc API key configured — set it in Settings > Video Gen or the REACTOR_API_KEY env var', { status: 400, code: 'REACTOR_NOT_CONFIGURED' });
  }

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);

  const meta = {
    id: jobId,
    prompt: prompt.trim(),
    negativePrompt: negativePrompt || '',
    modelId: `reactor:${REACTOR_MODEL_ID}`,
    ...(continueFromClipId ? { continueFromClipId } : {}),
    ...(seconds ? { seconds } : {}),
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] reactor (${REACTOR_MODEL_ID}): ${prompt.slice(0, 60)}…`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  broadcastSse(job, { type: 'status', message: 'Minting reactor.inc session…' });

  runReactorVideo(job, jobId, {
    apiKey, ...request, pythonPath, sourceImagePath, outputPath, filename, meta,
  }).catch((err) => {
    console.log(`❌ reactor video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/videos/${filename}`, generationId: jobId,
    mode: 'reactor',
    status: 'running',
  };
}

async function runReactorVideo(job, jobId, {
  apiKey, prompt, seconds, seed, pythonPath, sourceImagePath, outputPath, filename, meta,
}) {
  const entry = { aborted: false, stop: null };
  activeRequests.set(jobId, entry);
  try {
    const { jwt } = await mintReactorToken(apiKey);
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const result = await captureClip(entry, { jwt, prompt, seconds, seed, sourceImagePath, outputPath }, pythonPath, job, jobId);
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const output = await stat(outputPath).catch(() => null);
    if (!output?.isFile() || !output.size) throw new Error('Reactor completed without a playable output file');
    await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta: { ...meta, clipId: result.clipId, seconds: result.seconds }, actualSeed: seed ?? null, mutateHistory: mutateVideoHistory });
    closeJobAfterDelay(jobs, jobId);
  } catch (err) {
    await rm(outputPath, { force: true }).catch(() => {});
    finalizeError(job, jobId, entry.aborted ? 'Canceled' : `Reactor video generation failed: ${err?.message || 'unknown error'}`, { force: true });
  } finally {
    if (entry.aborted) await rm(outputPath, { force: true }).catch(() => {});
    activeRequests.delete(jobId);
    activeJobs.delete(jobId);
  }
}

const finalizeCanceled = (job, jobId) => finalizeError(job, jobId, 'Canceled', { force: true });

const finalizeError = (job, jobId, reason, { force = false } = {}) => {
  if (!force && (job.status === 'error' || job.status === 'complete')) return;
  activeRequests.delete(jobId);
  activeJobs.delete(jobId);
  job.status = 'error';
  console.log(`❌ reactor video generation failed [${jobId.slice(0, 8)}]: ${reason.split('\n')[0]}`);
  broadcastSse(job, { type: 'error', error: reason });
  videoGenEvents.emit('failed', { generationId: jobId, error: reason });
  closeJobAfterDelay(jobs, jobId);
};

// Test-only handles.
export const _internals = { validateRequest: validateReactorRequest };
