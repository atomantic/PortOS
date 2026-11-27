import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTempDataRoot } from '../../lib/mockPathsDataRoot.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { resolveFederatedMediaProvider } from '../federatedMediaConsumer.js';
import { getPeers } from '../instances.js';
import { createRemoteMediaExecutor } from './remoteExecutor.js';

vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn() }));
vi.mock('../instances.js', () => ({ getPeers: vi.fn() }));
vi.mock('../federatedMediaConsumer.js', () => ({ resolveFederatedMediaProvider: vi.fn() }));
vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { markCurrentUnsettled: vi.fn() } }));

const peer = { id: 'fixture-peer', host: 'example.fixture.ts.net', port: 5555 };
const jobId = '00000000-0000-4000-8000-000000000001';
const remoteId = '00000000-0000-4000-8000-000000000002';
const jobsUrl = `https://${peer.host}:${peer.port}/api/federation/media/v1/jobs`;
const resultUrl = `${jobsUrl}/${remoteId}/result`;
const filename = 'render.png';
const bytes = Buffer.from('verified result bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const headers = {
  'content-length': String(bytes.length),
  'content-type': 'image/png',
  'x-content-sha256': digest,
};

function job(status) {
  return Response.json({
    wireVersion: 1, id: remoteId, kind: 'image', status,
    queuedAt: '2026-01-01T00:00:00.000Z', startedAt: null, completedAt: null,
    position: null, progress: null, etaMs: null,
    ...(status === 'completed' ? { result: {
      available: true, mimeType: 'image/png', sizeBytes: bytes.length, sha256: digest,
      downloadUrl: '/unused', engine: null, modelId: null, durationSec: null,
    } } : {}),
  });
}

const request = { kind: 'image', engine: 'local', modelId: 'example-model', prompt: 'a blue square' };
let dir;
let executor;
let completed;
let failed;
let publishResult;
let finalize;
let resolveDestination;
const run = (marker = {}) => executor.run({ jobId, remoteMedia: { peerId: peer.id, ...marker } });

beforeEach(() => {
  dir = createTempDataRoot('remote-media-executor-');
  getPeers.mockReset().mockResolvedValue([peer]);
  resolveFederatedMediaProvider.mockReset().mockResolvedValue({});
  peerFetch.mockReset().mockImplementation(() => { throw new Error('Unexpected peer request'); });
  maintenance.markCurrentUnsettled.mockClear();
  completed = vi.fn();
  failed = vi.fn();
  const events = new EventEmitter().on('completed', completed).on('failed', failed);
  publishResult = vi.fn(work => work());
  finalize = vi.fn(async ({ filename }) => ({ filename }));
  resolveDestination = vi.fn(() => ({ dir, filename }));
  executor = createRemoteMediaExecutor({
    kind: 'image', label: 'image', events, markerSchema: z.object({ peerId: z.string() }).passthrough(),
    buildRequest: () => request, resolveDestination, publishResult, finalize,
  });
  executor.configureForTests({ pollDelayMs: 0, retryDelayMs: 0, requestTimeoutMs: 500 });
});

afterEach(async () => {
  executor.resetForTests();
  await rm(dir, { recursive: true, force: true });
});

describe.each([
  ['non-Tailnet', [{ ...peer, host: 'example.invalid' }], /no longer a Tailscale host/],
  ['missing', [], /no longer available/],
  ['disabled', [{ ...peer, enabled: false }], /no longer available/],
])('%s standing-route peer', (_name, changedPeers, error) => {
  it.each(['submit', 'poll', 'download'])('stops before %s after the peer record changes', async stage => {
    const changePeer = () => getPeers.mockResolvedValue(changedPeers);
    if (stage === 'submit') {
      resolveFederatedMediaProvider.mockImplementationOnce(changePeer);
    } else {
      peerFetch.mockImplementationOnce(() => {
        changePeer();
        return job(stage === 'poll' ? 'running' : 'completed');
      });
    }
    await run({ standingRoute: true });
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: expect.stringMatching(error) }));
    expect(peerFetch.mock.calls.map(([url]) => url)).toEqual(stage === 'submit' ? [] : [jobsUrl]);
    expect(publishResult).not.toHaveBeenCalled();
  });
});

it('replays each uncertain submission with the original key and body', async () => {
  const retryStatuses = [408, 425, 429, 503];
  peerFetch.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  for (const status of retryStatuses) peerFetch.mockResolvedValueOnce(Response.json({}, { status }));
  const chunks = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]);
  peerFetch.mockResolvedValueOnce(job('completed')).mockResolvedValueOnce(new Response(chunks, { headers }));
  publishResult.mockImplementationOnce(async (work, { stagedPath, path }) => {
    expect(await readFile(stagedPath)).toEqual(bytes);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    return work();
  });
  await run();
  expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ filename }));
  const calls = peerFetch.mock.calls.slice(0, -1);
  expect(calls).toHaveLength(2 + retryStatuses.length);
  for (const [url, options, target] of calls) {
    expect([url, target]).toEqual([jobsUrl, peer]);
    expect(options).toMatchObject({
      method: 'POST', headers: { 'Idempotency-Key': jobId }, body: JSON.stringify(request),
    });
  }
  expect(peerFetch.mock.lastCall[0]).toBe(resultUrl);
  expect(publishResult).toHaveBeenCalledOnce();
  expect(await readdir(dir)).toEqual([filename]);
  expect(await readFile(join(dir, filename))).toEqual(bytes);
});

it.each([400, 403, 422])('ends the submission on HTTP %i', async status => {
  peerFetch.mockResolvedValueOnce(Response.json({ code: 'SUBMISSION_REFUSED' }, { status }));
  await run();
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: expect.stringContaining('SUBMISSION_REFUSED') }));
  expect(peerFetch).toHaveBeenCalledTimes(1);
});

it.each([
  'MEDIA_PROVIDER_PEER_DISABLED', 'MEDIA_PROVIDER_NOT_CONFIGURED',
  'MEDIA_PROVIDER_SELECTION_INVALID', 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED',
])('ends preflight on %s', async code => {
  resolveFederatedMediaProvider.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
  await run();
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: code, remoteInputsDisposable: true }));
  expect(resolveFederatedMediaProvider).toHaveBeenCalledTimes(1);
  expect(peerFetch).not.toHaveBeenCalled();
});

it('cancels during preflight without submitting a job', async () => {
  resolveFederatedMediaProvider.mockImplementationOnce(() => executor.cancel(jobId));
  await run();
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    error: expect.stringMatching(/canceled/), remoteInputsDisposable: true,
  }));
  expect(peerFetch).not.toHaveBeenCalled();
});

it('recovers an ambiguous submission to cancel it and skips import on a terminal race', async () => {
  peerFetch.mockImplementationOnce((_url, { signal }) => {
    executor.cancel(jobId);
    signal.throwIfAborted();
  }).mockResolvedValueOnce(job('running'))
    .mockResolvedValueOnce(Response.json({}, { status: 409 }));
  await run();
  expect(peerFetch.mock.calls.map(([url, { method }]) => [method, url])).toEqual([
    ['POST', jobsUrl], ['POST', jobsUrl], ['POST', `${jobsUrl}/${remoteId}/cancel`],
  ]);
  for (const [, options] of peerFetch.mock.calls.slice(0, 2)) {
    expect(options.headers['Idempotency-Key']).toBe(jobId);
    expect(options.body).toBe(JSON.stringify(request));
  }
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: expect.stringMatching(/canceled/) }));
  expect(publishResult).not.toHaveBeenCalled();
  expect(await readdir(dir)).toEqual([]);
});

describe('result publication', () => {
  it.each([
    ['wrong length header', bytes, { 'content-length': '1' }, /headers/],
    ['wrong type header', bytes, { 'content-type': 'image/jpeg' }, /headers/],
    ['wrong digest header', bytes, { 'x-content-sha256': '0'.repeat(64) }, /headers/],
    ['truncated stream', bytes.subarray(1), {}, /integrity/],
    ['oversized stream', Buffer.concat([bytes, bytes]), {}, /exceeded/],
    ['corrupt stream', Buffer.alloc(bytes.length), {}, /integrity/],
  ])('preserves the old result and removes staging on a %s', async (_name, body, overrides, error) => {
    await writeFile(join(dir, filename), 'earlier render');
    peerFetch.mockResolvedValueOnce(job('completed'))
      .mockResolvedValueOnce(new Response(body, { headers: { ...headers, ...overrides } }));
    await run();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: expect.stringMatching(error) }));
    expect(peerFetch).toHaveBeenCalledTimes(2);
    expect(publishResult).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([filename]);
    expect(await readFile(join(dir, filename), 'utf8')).toBe('earlier render');
  });

  it.each(['ENOSPC', 'EACCES'])('fails once on local destination error %s', async code => {
    peerFetch.mockResolvedValueOnce(job('completed'));
    // Exercise the local-error veto even if an adapter classifies its error as transient.
    resolveDestination.mockImplementationOnce(() => { throw Object.assign(new Error(code), { code, retryable: true }); });
    await run();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: code }));
    expect(resolveDestination).toHaveBeenCalledTimes(1);
    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(publishResult).not.toHaveBeenCalled();
  });

  it('marks a reconciled render unsettled if the peer verdict is unknown', async () => {
    peerFetch.mockResolvedValueOnce(job('running')).mockResolvedValueOnce(Response.json({}, { status: 403 }));
    await run({ reconcile: true });
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ remoteInputsDisposable: false }));
    expect(failed.mock.lastCall[0]).not.toHaveProperty('remoteRecoverySettlement');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledOnce();
  });

  it('finalizes an existing verified file without download and keeps a failed finalization unsettled', async () => {
    await writeFile(join(dir, filename), bytes);
    peerFetch.mockResolvedValueOnce(job('completed'));
    finalize.mockRejectedValueOnce(new Error('registration failed'));
    await run({ reconcile: true });
    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(publishResult).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ renderStartedAtMs: null, path: join(dir, filename) }));
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: 'registration failed', remoteInputsDisposable: false }));
    expect(failed.mock.lastCall[0]).not.toHaveProperty('remoteRecoverySettlement');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledOnce();
  });
});
