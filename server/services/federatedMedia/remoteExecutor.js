/**
 * Durable consumer-side execution core for federated media jobs, shared by
 * every kind (audio, image, video).
 *
 * The local media-job UUID is the provider Idempotency-Key. A worker restart
 * therefore replays the same submission, recovers the provider job, and keeps
 * polling instead of creating duplicate paid/GPU work. Provider URLs are never
 * accepted from the wire: every request derives the fixed v1 endpoint from the
 * locally configured peer.
 *
 * Everything kind-specific — which marker shape is persisted, how the wire
 * request is built from it, where the verified bytes land, and what a finished
 * render has to register locally (an image sidecar, a video-history row) — is
 * supplied by the caller. The retry/cancel/idempotency/integrity semantics are
 * NOT: they are the part that must stay identical across kinds, which is why
 * this module owns them instead of each adapter re-deriving them.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sha256File } from '../../lib/fileUtils.js';
import {
  FEDERATED_MEDIA_WIRE_VERSION,
  federatedMediaProviderJobSchema,
} from '../../lib/federatedMediaWire.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { readResponseJson } from '../../lib/readResponseJson.js';
import { resolveFederatedMediaProvider } from '../federatedMediaConsumer.js';
import { getPeers } from '../instances.js';
import { isTailnetPeer } from '../../lib/tailnetPeer.js';

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

export const remoteMediaError = (message, details = {}) => Object.assign(new Error(message), details);

const isRetryableStatus = (status) => RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
const isRetryableTransportError = (error) =>
  error?.retryable === true
  || error?.name === 'AbortError'
  || error?.name === 'TimeoutError'
  || error?.name === 'TypeError'
  || RETRYABLE_TRANSPORT_CODES.has(error?.code);

/**
 * Build a durable remote executor for one media kind.
 *
 * @param {object} config
 * @param {'audio'|'image'|'video'} config.kind - Wire kind this executor speaks.
 * @param {string} config.label - Human noun used in progress/failure messages.
 * @param {import('events').EventEmitter} config.events - The kind's gen event emitter.
 * @param {import('zod').ZodTypeAny} config.markerSchema - Schema for `params.remoteMedia`.
 * @param {(marker: object) => object} config.buildRequest - Wire submission body builder.
 * @param {(ctx: object) => {dir: string, filename: string}} config.resolveDestination -
 *   Where the verified result lands. Called per job so a PATHS proxy stays live.
 * @param {(ctx: object) => Promise<object>} config.finalize - Register the downloaded
 *   result locally; its return value is merged into the `completed` event payload.
 */
export function createRemoteMediaExecutor({
  kind,
  label,
  events,
  markerSchema,
  buildRequest,
  resolveDestination,
  finalize,
}) {
  let pollDelayMs = 1_000;
  let retryDelayMs = 2_000;
  let requestTimeoutMs = 30_000;
  const activeJobs = new Map();

  const canceledError = () => remoteMediaError(`Remote ${label} generation canceled`, { canceled: true });

  function emitActivity(jobId) {
    events.emit('activity', { generationId: jobId });
  }

  function emitStatus(jobId, message) {
    emitActivity(jobId);
    events.emit('status', { generationId: jobId, message });
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

  async function findPeer(peerId, { standingRoute = false } = {}) {
    const peers = await getPeers();
    const peer = peers.find((candidate) => candidate.id === peerId);
    if (!peer || peer.enabled === false) {
      throw remoteMediaError('Selected media provider peer is no longer available', {
        code: 'MEDIA_PROVIDER_PEER_UNAVAILABLE',
      });
    }
    // A standing route's tailnet gate is checked at enqueue, but the peer record
    // it checked can change while the job sits queued or reconciles across a
    // restart — a host edited from a .ts.net name to a LAN address would
    // otherwise carry the visual prompt over an unauthenticated hop on the very
    // next request. Every request path (submit, poll, cancel, result) resolves
    // its peer here, so re-checking at this one chokepoint covers all of them.
    // ADR docs/decisions/2026-08-20-federated-visual-prompts.md, rule 5.
    if (standingRoute && !isTailnetPeer(peer)) {
      throw remoteMediaError('Media provider peer is no longer a Tailscale host', {
        code: 'MEDIA_ROUTING_PEER_NOT_TAILNET',
      });
    }
    return peer;
  }

  async function requestJson(state, path, options = {}, requestOptions = {}) {
    const peer = await findPeer(state.peerId, { standingRoute: state.standingRoute });
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
      throw remoteMediaError(`Remote media provider rejected the request (${code})`, {
        code,
        status: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }
    return body;
  }

  function parseProviderJob(body, expectedId) {
    const parsed = federatedMediaProviderJobSchema.safeParse(body);
    if (!parsed.success || parsed.data.kind !== kind || (expectedId && parsed.data.id !== expectedId)) {
      throw remoteMediaError('Remote media provider returned an invalid wire-v1 job projection', {
        code: 'MEDIA_PROVIDER_INVALID_JOB_RESPONSE',
      });
    }
    return parsed.data;
  }

  async function preflight(state, selection) {
    while (true) {
      if (state.cancelRequested) throw canceledError();
      const peer = await findPeer(state.peerId, { standingRoute: state.standingRoute });
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
      events.emit('progress', {
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
          throw remoteMediaError('Remote provider completed without result metadata', {
            code: 'MEDIA_PROVIDER_RESULT_MISSING',
          });
        }
        return current;
      }
      if (current.status === 'failed') {
        throw remoteMediaError(`Remote provider job failed (${current.failure?.code || 'MEDIA_PROVIDER_JOB_FAILED'})`, {
          code: current.failure?.code || 'MEDIA_PROVIDER_JOB_FAILED',
        });
      }
      if (current.status === 'canceled') {
        throw remoteMediaError('Remote provider canceled the job', { code: 'MEDIA_PROVIDER_JOB_CANCELED' });
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
    if (!body) throw remoteMediaError('Remote provider returned an empty result body');
    return typeof body.getReader === 'function' ? Readable.fromWeb(body) : Readable.from(body);
  }

  async function downloadOnce(state, remoteJob) {
    const metadata = remoteJob.result;
    const { dir, filename } = resolveDestination({ jobId: state.jobId, remoteJob });
    const finalPath = join(dir, filename);
    const partialPath = join(dir, `.${filename}.partial`);
    await mkdir(dir, { recursive: true });
    if (await existingResultMatches(finalPath, metadata)) return { filename, dir, path: finalPath };
    await unlink(partialPath).catch(() => {});

    const peer = await findPeer(state.peerId, { standingRoute: state.standingRoute });
    // Keep the controller live for the body stream so cancel()/the queue
    // watchdog can interrupt a stalled transfer. There is intentionally no
    // fixed wall-clock timeout: large renders over a slow Tailnet are valid
    // work, and chunk activity keeps the queue's idle watchdog fresh.
    return withRequest(state, async (signal) => {
      const response = await peerFetch(
        `${peerBaseUrl(peer)}/api/federation/media/v1/jobs/${remoteJob.id}/result`,
        { redirect: 'error', signal },
        peer,
      );
      if (!response.ok) {
        throw remoteMediaError(`Remote result download failed (HTTP_${response.status})`, {
          status: response.status,
          retryable: isRetryableStatus(response.status),
        });
      }

      const contentLength = Number(response.headers.get('content-length'));
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
      const advertisedHash = response.headers.get('x-content-sha256')?.toLowerCase();
      if (!Number.isInteger(contentLength) || contentLength !== metadata.sizeBytes
        || contentType !== metadata.mimeType || advertisedHash !== metadata.sha256) {
        throw remoteMediaError('Remote result headers did not match the validated metadata', {
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
            callback(remoteMediaError('Remote result exceeded its advertised size'));
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
          throw remoteMediaError('Remote result failed byte-integrity verification', {
            code: 'MEDIA_PROVIDER_RESULT_INTEGRITY_FAILED',
          });
        }
        // POSIX rename replaces an existing file atomically. Do not unlink the
        // destination first: consumers should never observe a missing final path
        // between integrity verification and promotion.
        await rename(partialPath, finalPath);
        return { filename, dir, path: finalPath };
      } finally {
        await unlink(partialPath).catch(() => {});
      }
    }, { timeoutMs: null });
  }

  async function downloadResult(state, remoteJob) {
    while (true) {
      if (state.cancelRequested) throw canceledError();
      emitStatus(state.jobId, `Downloading verified remote ${label}`);
      try {
        return await downloadOnce(state, remoteJob);
      } catch (error) {
        if (state.cancelRequested) throw canceledError();
        const retryable = !NON_RETRYABLE_FILE_CODES.has(error?.code)
          && !error?.code?.startsWith('MEDIA_PROVIDER_RESULT_')
          && isRetryableTransportError(error);
        if (!retryable) throw error;
        emitStatus(state.jobId, `Remote ${label} transfer interrupted; retrying`);
        await waitForRetry(state, retryDelayMs);
      }
    }
  }

  async function runRemote(state, marker) {
    const request = buildRequest(marker);
    const selection = { kind, engine: request.engine, modelId: request.modelId };
    if (!marker.reconcile) await preflight(state, selection);
    if (state.cancelRequested && !marker.reconcile && !state.submissionMayExist) throw canceledError();

    const submitted = await submitOrRecover(state, request);
    const completed = await pollProviderJob(state, submitted);
    const downloaded = await downloadResult(state, completed);
    const local = await finalize({
      jobId: state.jobId,
      peerId: state.peerId,
      request,
      remoteJob: completed,
      ...downloaded,
    });
    return {
      ...local,
      federatedMedia: {
        wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
        peerId: state.peerId,
        remoteJobId: completed.id,
      },
    };
  }

  /** Queue entry point — mirrors the local generator's `generateX(params)` shape. */
  async function run(params) {
    const marker = markerSchema.safeParse(params?.remoteMedia);
    if (!marker.success) {
      events.emit('failed', {
        generationId: params?.jobId,
        error: `Remote ${label} job has invalid persisted routing metadata`,
      });
      return;
    }

    const state = {
      jobId: params.jobId,
      peerId: marker.data.peerId,
      cancelRequested: marker.data.cancelRequested === true,
      cancelSent: false,
      submissionMayExist: marker.data.reconcile === true,
      // Absent on an interactive marker (and on any marker queued before this
      // shipped), which reads correctly as "not a standing route".
      standingRoute: marker.data.standingRoute === true,
      requestController: null,
      wake: null,
    };
    activeJobs.set(params.jobId, state);
    try {
      const result = await runRemote(state, marker.data);
      events.emit('completed', { generationId: params.jobId, ...result });
    } catch (error) {
      events.emit('failed', {
        generationId: params.jobId,
        error: error?.canceled
          ? `Remote ${label} generation canceled`
          : (error?.message || `Remote ${label} generation failed`),
      });
    } finally {
      activeJobs.delete(params.jobId);
    }
  }

  function cancel(jobId) {
    const state = activeJobs.get(jobId);
    if (!state) return;
    state.cancelRequested = true;
    state.requestController?.abort();
    state.wake?.();
  }

  function configureForTests(options = {}) {
    pollDelayMs = options.pollDelayMs ?? 0;
    retryDelayMs = options.retryDelayMs ?? 0;
    requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
  }

  function resetForTests() {
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

  return { run, cancel, configureForTests, resetForTests };
}
