/**
 * Durable consumer-side adapter for federated audio jobs.
 *
 * The local media-job UUID is the provider Idempotency-Key. A worker restart
 * therefore replays the same submission, recovers the provider job, and keeps
 * polling instead of creating duplicate paid/GPU work. Provider URLs are never
 * accepted from the wire: every request derives the fixed v1 endpoint from the
 * locally configured peer.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { PATHS, sha256File } from '../../lib/fileUtils.js';
import {
  FEDERATED_MEDIA_WIRE_VERSION,
  federatedMediaAudioProfileSchema,
  federatedMediaProviderJobSchema,
  renderFederatedMediaAudioPrompt,
} from '../../lib/federatedMediaWire.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { readResponseJson } from '../../lib/readResponseJson.js';
import { federatedMediaJobRoutingSchema } from '../../lib/validation.js';
import { resolveFederatedMediaProvider } from '../federatedMediaConsumer.js';
import { getPeers } from '../instances.js';
import { audioGenEvents } from './events.js';

const remoteMediaMarkerSchema = z.object({
  wireVersion: z.literal(FEDERATED_MEDIA_WIRE_VERSION),
  peerId: z.string().uuid(),
  reconcile: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  profile: federatedMediaAudioProfileSchema,
  // Free-form prompt/lyrics are deliberately absent from persisted routing
  // state. The adapter renders a fixed-vocabulary instrumental prompt from the
  // profile immediately before submission, so hand-edited queue state cannot
  // smuggle personal text onto the federation wire.
  request: federatedMediaJobRoutingSchema,
}).passthrough();

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
const PERMANENT_SELECTION_CODES = new Set([
  'MEDIA_PROVIDER_PEER_DISABLED',
  'MEDIA_PROVIDER_NOT_CONFIGURED',
  'MEDIA_PROVIDER_SELECTION_INVALID',
  'MEDIA_PROVIDER_MODEL_NOT_ALLOWED',
]);
const NON_RETRYABLE_FILE_CODES = new Set(['EACCES', 'ENOSPC', 'EPERM', 'EROFS']);
const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

let pollDelayMs = 1_000;
let retryDelayMs = 2_000;
let requestTimeoutMs = 30_000;
const activeJobs = new Map();

const remoteError = (message, details = {}) => Object.assign(new Error(message), details);
const canceledError = () => remoteError('Remote audio generation canceled', { canceled: true });
const isRetryableStatus = (status) => RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
const isRetryableTransportError = (error) =>
  error?.retryable === true
  || error?.name === 'AbortError'
  || error?.name === 'TimeoutError'
  || error?.name === 'TypeError'
  || RETRYABLE_TRANSPORT_CODES.has(error?.code);

function emitActivity(jobId) {
  audioGenEvents.emit('activity', { generationId: jobId });
}

function emitStatus(jobId, message) {
  emitActivity(jobId);
  audioGenEvents.emit('status', { generationId: jobId, message });
}

async function waitForRetry(state, delayMs) {
  emitActivity(state.jobId);
  if (delayMs <= 0) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (state.wake === finish) state.wake = null;
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    state.wake = finish;
  });
}

async function withRequest(state, fn, { respectCancel = true, timeoutMs = requestTimeoutMs } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs === null ? null : setTimeout(() => controller.abort(), timeoutMs);
  timer?.unref?.();
  state.requestController = controller;
  if (respectCancel && state.cancelRequested) controller.abort();
  try {
    return await fn(controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
    if (state.requestController === controller) state.requestController = null;
  }
}

async function findPeer(peerId) {
  const peers = await getPeers();
  const peer = peers.find((candidate) => candidate.id === peerId);
  if (!peer || peer.enabled === false) {
    throw remoteError('Selected media provider peer is no longer available', {
      code: 'MEDIA_PROVIDER_PEER_UNAVAILABLE',
    });
  }
  return peer;
}

async function requestJson(state, path, options = {}, requestOptions = {}) {
  const peer = await findPeer(state.peerId);
  const { response, body } = await withRequest(
    state,
    async (signal) => {
      const response = await peerFetch(`${peerBaseUrl(peer)}${path}`, {
        redirect: 'error',
        ...options,
        signal,
      }, peer);
      const body = await readResponseJson(response, { fallback: null, emptyValue: null });
      return { response, body };
    },
    requestOptions,
  );
  if (!response.ok) {
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
    throw remoteError(`Remote media provider rejected the request (${code})`, {
      code,
      status: response.status,
      retryable: isRetryableStatus(response.status),
    });
  }
  return body;
}

function parseProviderJob(body, expectedId) {
  const parsed = federatedMediaProviderJobSchema.safeParse(body);
  if (!parsed.success || parsed.data.kind !== 'audio' || (expectedId && parsed.data.id !== expectedId)) {
    throw remoteError('Remote media provider returned an invalid wire-v1 job projection', {
      code: 'MEDIA_PROVIDER_INVALID_JOB_RESPONSE',
    });
  }
  return parsed.data;
}

async function preflight(state, selection) {
  while (true) {
    if (state.cancelRequested) throw canceledError();
    const peer = await findPeer(state.peerId);
    try {
      await withRequest(
        state,
        (signal) => resolveFederatedMediaProvider(peer, selection, { signal }),
      );
      return;
    } catch (error) {
      if (state.cancelRequested) throw canceledError();
      if (PERMANENT_SELECTION_CODES.has(error?.code)) throw error;
      emitStatus(state.jobId, 'Waiting for remote provider readiness');
      await waitForRetry(state, retryDelayMs);
    }
  }
}

async function submitOrRecover(state, request) {
  const path = '/api/federation/media/v1/jobs';
  while (true) {
    // Once an attempt begins, an abort is ambiguous: the provider may have
    // accepted the body before the connection broke. Keep replaying with the
    // same key (even after local cancellation) until its job id is recovered.
    state.submissionMayExist = true;
    try {
      const body = await requestJson(state, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': state.jobId,
        },
        body: JSON.stringify(request),
      }, { respectCancel: !state.cancelRequested });
      return parseProviderJob(body);
    } catch (error) {
      if (!isRetryableTransportError(error)) throw error;
      emitStatus(state.jobId, state.cancelRequested
        ? 'Recovering remote job before cancellation'
        : 'Waiting to submit to the remote provider');
      // Cancellation must still recover the possibly-accepted submission before
      // it can target the provider job. Keep the normal backoff while doing so:
      // a disconnected peer must not turn a durable cancel into a hot loop.
      await waitForRetry(state, retryDelayMs);
    }
  }
}

async function sendRemoteCancel(state, remoteJobId) {
  while (true) {
    try {
      const body = await requestJson(
        state,
        `/api/federation/media/v1/jobs/${remoteJobId}/cancel`,
        { method: 'POST' },
        { respectCancel: false },
      );
      state.cancelSent = true;
      return parseProviderJob(body, remoteJobId);
    } catch (error) {
      // A terminal provider job returns 409. The local user still asked to
      // cancel, so do not import a result that won the race.
      if (error?.status === 409) throw canceledError();
      if (!isRetryableTransportError(error)) throw error;
      emitStatus(state.jobId, 'Waiting to cancel the remote job');
      await waitForRetry(state, retryDelayMs);
    }
  }
}

function emitProviderProgress(state, job) {
  emitActivity(state.jobId);
  if (typeof job.progress === 'number') {
    audioGenEvents.emit('progress', {
      generationId: state.jobId,
      progress: job.progress,
      message: 'Rendering on remote provider',
      ...(typeof job.etaMs === 'number' ? { etaMs: job.etaMs } : {}),
    });
    return;
  }
  const position = typeof job.position === 'number' ? ` (position ${job.position})` : '';
  emitStatus(state.jobId, job.status === 'queued'
    ? `Queued on remote provider${position}`
    : 'Rendering on remote provider');
}

async function pollProviderJob(state, initial) {
  let current = initial;
  while (true) {
    if (state.cancelRequested && !state.cancelSent) {
      current = await sendRemoteCancel(state, current.id);
    }
    if (state.cancelRequested && ['completed', 'failed', 'canceled'].includes(current.status)) {
      throw canceledError();
    }
    if (current.status === 'completed') {
      if (!current.result) {
        throw remoteError('Remote provider completed without result metadata', {
          code: 'MEDIA_PROVIDER_RESULT_MISSING',
        });
      }
      return current;
    }
    if (current.status === 'failed') {
      throw remoteError(`Remote provider job failed (${current.failure?.code || 'MEDIA_PROVIDER_JOB_FAILED'})`, {
        code: current.failure?.code || 'MEDIA_PROVIDER_JOB_FAILED',
      });
    }
    if (current.status === 'canceled') {
      throw remoteError('Remote provider canceled the job', { code: 'MEDIA_PROVIDER_JOB_CANCELED' });
    }

    emitProviderProgress(state, current);
    await waitForRetry(state, pollDelayMs);
    try {
      const body = await requestJson(
        state,
        `/api/federation/media/v1/jobs/${current.id}`,
        {},
        { respectCancel: true },
      );
      current = parseProviderJob(body, current.id);
    } catch (error) {
      if (state.cancelRequested && error?.name === 'AbortError') continue;
      if (!isRetryableTransportError(error)) throw error;
      emitStatus(state.jobId, 'Remote provider temporarily unavailable');
      await waitForRetry(state, retryDelayMs);
    }
  }
}

async function existingResultMatches(path, metadata) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== metadata.sizeBytes) return false;
  const digest = await sha256File(path).catch(() => null);
  return digest === metadata.sha256;
}

function responseStream(body) {
  if (!body) throw remoteError('Remote provider returned an empty result body');
  return typeof body.getReader === 'function' ? Readable.fromWeb(body) : Readable.from(body);
}

async function downloadOnce(state, remoteJob) {
  const metadata = remoteJob.result;
  const filename = `music-gen-${state.jobId}.wav`;
  const finalPath = join(PATHS.music, filename);
  const partialPath = join(PATHS.music, `.${filename}.partial`);
  await mkdir(PATHS.music, { recursive: true });
  if (await existingResultMatches(finalPath, metadata)) return filename;
  await unlink(partialPath).catch(() => {});

  const peer = await findPeer(state.peerId);
  // Keep the controller live for the body stream so cancel()/the queue
  // watchdog can interrupt a stalled transfer. There is intentionally no
  // fixed wall-clock timeout: large WAVs over a slow Tailnet are valid work,
  // and chunk activity keeps the queue's idle watchdog fresh.
  return withRequest(state, async (signal) => {
    const response = await peerFetch(
      `${peerBaseUrl(peer)}/api/federation/media/v1/jobs/${remoteJob.id}/result`,
      { redirect: 'error', signal },
      peer,
    );
    if (!response.ok) {
      throw remoteError(`Remote result download failed (HTTP_${response.status})`, {
        status: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }

    const contentLength = Number(response.headers.get('content-length'));
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    const advertisedHash = response.headers.get('x-content-sha256')?.toLowerCase();
    if (!Number.isInteger(contentLength) || contentLength !== metadata.sizeBytes
      || contentType !== metadata.mimeType || advertisedHash !== metadata.sha256) {
      throw remoteError('Remote result headers did not match the validated metadata', {
        code: 'MEDIA_PROVIDER_RESULT_HEADERS_INVALID',
      });
    }

    let sizeBytes = 0;
    let lastActivityAt = 0;
    const hasher = createHash('sha256');
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > metadata.sizeBytes) {
          callback(remoteError('Remote result exceeded its advertised size'));
          return;
        }
        hasher.update(chunk);
        const now = Date.now();
        if (now - lastActivityAt >= 1_000) {
          lastActivityAt = now;
          emitActivity(state.jobId);
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(responseStream(response.body), meter, createWriteStream(partialPath, { flags: 'wx' }));
      const digest = hasher.digest('hex');
      if (sizeBytes !== metadata.sizeBytes || digest !== metadata.sha256) {
        throw remoteError('Remote result failed byte-integrity verification', {
          code: 'MEDIA_PROVIDER_RESULT_INTEGRITY_FAILED',
        });
      }
      // POSIX rename replaces an existing file atomically. Do not unlink the
      // destination first: consumers should never observe a missing final path
      // between integrity verification and promotion.
      await rename(partialPath, finalPath);
      return filename;
    } finally {
      await unlink(partialPath).catch(() => {});
    }
  }, { timeoutMs: null });
}

async function downloadResult(state, remoteJob) {
  while (true) {
    if (state.cancelRequested) throw canceledError();
    emitStatus(state.jobId, 'Downloading verified remote audio');
    try {
      return await downloadOnce(state, remoteJob);
    } catch (error) {
      if (state.cancelRequested) throw canceledError();
      const retryable = !NON_RETRYABLE_FILE_CODES.has(error?.code)
        && !error?.code?.startsWith('MEDIA_PROVIDER_RESULT_')
        && isRetryableTransportError(error);
      if (!retryable) throw error;
      emitStatus(state.jobId, 'Remote audio transfer interrupted; retrying');
      await waitForRetry(state, retryDelayMs);
    }
  }
}

async function runRemoteAudio(state, routingRequest, profile, marker) {
  const prompt = renderFederatedMediaAudioPrompt(profile);
  if (!prompt) {
    throw remoteError('Remote audio job has an invalid privacy-safe profile', {
      code: 'MEDIA_PROVIDER_AUDIO_PROFILE_INVALID',
    });
  }
  const request = { ...routingRequest, prompt };
  const selection = { kind: 'audio', engine: request.engine, modelId: request.modelId };
  if (!marker.reconcile) await preflight(state, selection);
  if (state.cancelRequested && !marker.reconcile && !state.submissionMayExist) throw canceledError();

  const submitted = await submitOrRecover(state, request);
  const completed = await pollProviderJob(state, submitted);
  const filename = await downloadResult(state, completed);
  return {
    filename,
    durationSec: completed.result.durationSec ?? request.durationSec ?? null,
    engine: completed.result.engine ?? request.engine,
    modelId: completed.result.modelId ?? request.modelId,
    federatedMedia: {
      wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
      peerId: state.peerId,
      remoteJobId: completed.id,
    },
  };
}

export async function generateAudio(params) {
  const marker = remoteMediaMarkerSchema.safeParse(params?.remoteMedia);
  if (!marker.success) {
    audioGenEvents.emit('failed', {
      generationId: params?.jobId,
      error: 'Remote audio job has invalid persisted routing metadata',
    });
    return;
  }

  const state = {
    jobId: params.jobId,
    peerId: marker.data.peerId,
    cancelRequested: marker.data.cancelRequested === true,
    cancelSent: false,
    submissionMayExist: marker.data.reconcile === true,
    requestController: null,
    wake: null,
  };
  activeJobs.set(params.jobId, state);
  try {
    const result = await runRemoteAudio(state, marker.data.request, marker.data.profile, marker.data);
    audioGenEvents.emit('completed', { generationId: params.jobId, ...result });
  } catch (error) {
    audioGenEvents.emit('failed', {
      generationId: params.jobId,
      error: error?.canceled ? 'Remote audio generation canceled' : (error?.message || 'Remote audio generation failed'),
    });
  } finally {
    activeJobs.delete(params.jobId);
  }
}

export function cancel(jobId) {
  const state = activeJobs.get(jobId);
  if (!state) return;
  state.cancelRequested = true;
  state.requestController?.abort();
  state.wake?.();
}

export function __configureRemoteAudioForTests(options = {}) {
  pollDelayMs = options.pollDelayMs ?? 0;
  retryDelayMs = options.retryDelayMs ?? 0;
  requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
}

export function __resetRemoteAudioForTests() {
  for (const state of activeJobs.values()) {
    state.cancelRequested = true;
    state.requestController?.abort();
    state.wake?.();
  }
  activeJobs.clear();
  pollDelayMs = 1_000;
  retryDelayMs = 2_000;
  requestTimeoutMs = 30_000;
}
