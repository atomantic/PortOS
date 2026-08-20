import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempImageDir;
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
const federation = vi.hoisted(() => ({ resolve: vi.fn(), peers: [] }));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: new Proxy(actual.PATHS, {
      get(target, key) {
        if (key === 'images') return tempImageDir;
        return target[key];
      },
    }),
  };
});

vi.mock('../../lib/peerHttpClient.js', () => ({
  peerFetch: (...args) => transport.fetch(...args),
}));

vi.mock('../federatedMediaConsumer.js', () => ({
  resolveFederatedMediaProvider: (...args) => federation.resolve(...args),
}));

vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => federation.peers),
}));

import { imageGenEvents } from '../imageGenEvents.js';
import {
  __configureRemoteImageForTests,
  __resetRemoteImageForTests,
  generateImage,
} from './remote.js';

const LOCAL_JOB_ID = '00000000-0000-4000-8000-000000000110';
const REMOTE_JOB_ID = '00000000-0000-4000-8000-000000000120';
const PEER_ID = '00000000-0000-4000-8000-000000000130';
const peer = {
  id: PEER_ID,
  enabled: true,
  address: '192.0.2.10',
  port: 5555,
  mediaProvider: { enabled: true, imageModels: [{ engine: 'local', modelId: 'dev' }] },
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const providerJob = (status, overrides = {}) => ({
  wireVersion: 1,
  id: REMOTE_JOB_ID,
  kind: 'image',
  status,
  queuedAt: '2026-08-19T12:00:00.000Z',
  startedAt: status === 'queued' ? null : '2026-08-19T12:00:01.000Z',
  completedAt: ['completed', 'failed', 'canceled'].includes(status) ? '2026-08-19T12:00:02.000Z' : null,
  position: status === 'queued' ? 1 : null,
  progress: null,
  etaMs: null,
  ...overrides,
});

const params = (overrides = {}) => ({
  jobId: LOCAL_JOB_ID,
  prompt: '',
  remoteMedia: {
    wireVersion: 1,
    peerId: PEER_ID,
    request: {
      kind: 'image',
      engine: 'local',
      modelId: 'dev',
      prompt: 'a lighthouse at dusk',
      width: 512,
      height: 512,
      seed: 42,
    },
  },
  ...overrides,
});

function captureTerminal(jobId) {
  return new Promise((resolve) => {
    const cleanup = () => {
      imageGenEvents.off('completed', onCompleted);
      imageGenEvents.off('failed', onFailed);
    };
    const onCompleted = (event) => {
      if (event.generationId !== jobId) return;
      cleanup();
      resolve({ type: 'completed', event });
    };
    const onFailed = (event) => {
      if (event.generationId !== jobId) return;
      cleanup();
      resolve({ type: 'failed', event });
    };
    imageGenEvents.on('completed', onCompleted);
    imageGenEvents.on('failed', onFailed);
  });
}

beforeEach(() => {
  tempImageDir = mkdtempSync(join(tmpdir(), 'remote-image-test-'));
  federation.peers = [peer];
  federation.resolve.mockReset().mockResolvedValue({
    peer,
    capability: { kind: 'image', engine: 'local', modelId: 'dev' },
  });
  transport.fetch.mockReset();
  __configureRemoteImageForTests({ pollDelayMs: 0, retryDelayMs: 0, requestTimeoutMs: 1_000 });
});

afterEach(() => {
  __resetRemoteImageForTests();
  rmSync(tempImageDir, { recursive: true, force: true });
});

describe('federated image consumer adapter', () => {
  it('imports a verified PNG and writes the gallery sidecar the local renderer would have', async () => {
    const png = Buffer.from('\x89PNG-example-bytes');
    const digest = sha256(png);
    const metadata = {
      available: true,
      mimeType: 'image/png',
      sizeBytes: png.length,
      sha256: digest,
      downloadUrl: `/api/federation/media/v1/jobs/${REMOTE_JOB_ID}/result`,
      engine: 'local',
      modelId: 'dev',
      durationSec: null,
    };
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') return jsonResponse(providerJob('queued'), 202);
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}`)) return jsonResponse(providerJob('completed', { result: metadata }));
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}/result`)) {
        return new Response(png, {
          headers: {
            'Content-Length': String(png.length),
            'Content-Type': 'image/png',
            'X-Content-SHA256': digest,
          },
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateImage(params());
    const outcome = await terminal;

    expect(outcome).toMatchObject({
      type: 'completed',
      event: {
        generationId: LOCAL_JOB_ID,
        filename: `${LOCAL_JOB_ID}.png`,
        path: `/data/images/${LOCAL_JOB_ID}.png`,
        seed: 42,
        modelId: 'dev',
        federatedMedia: { wireVersion: 1, peerId: PEER_ID, remoteJobId: REMOTE_JOB_ID },
      },
    });
    expect(readFileSync(join(tempImageDir, `${LOCAL_JOB_ID}.png`))).toEqual(png);

    // The sidecar is what makes the render appear in the gallery at all — the
    // media index re-reads it from disk on the `completed` event.
    const sidecar = JSON.parse(readFileSync(join(tempImageDir, `${LOCAL_JOB_ID}.metadata.json`), 'utf8'));
    expect(sidecar).toMatchObject({
      id: LOCAL_JOB_ID,
      prompt: 'a lighthouse at dusk',
      modelId: 'dev',
      seed: 42,
      width: 512,
      height: 512,
      filename: `${LOCAL_JOB_ID}.png`,
      federatedPeerId: PEER_ID,
      federatedJobId: REMOTE_JOB_ID,
    });

    const submission = transport.fetch.mock.calls
      .find(([url, options]) => url.endsWith('/jobs') && options.method === 'POST');
    expect(JSON.parse(submission[1].body)).toEqual({
      kind: 'image',
      engine: 'local',
      modelId: 'dev',
      prompt: 'a lighthouse at dusk',
      width: 512,
      height: 512,
      seed: 42,
    });
    expect(submission[1].headers['Idempotency-Key']).toBe(LOCAL_JOB_ID);
  });

  it('rejects a provider response whose kind is not image', async () => {
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') {
        return jsonResponse({ ...providerJob('queued'), kind: 'audio' }, 202);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateImage(params());
    const outcome = await terminal;

    expect(outcome.type).toBe('failed');
    expect(outcome.event.error).toMatch(/invalid wire-v1 job projection/i);
    expect(existsSync(join(tempImageDir, `${LOCAL_JOB_ID}.png`))).toBe(false);
  });

  it('fails closed on a marker whose persisted request is not a valid wire submission', async () => {
    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateImage(params({
      remoteMedia: {
        wireVersion: 1,
        peerId: PEER_ID,
        // Hand-edited queue state: a video-shaped request under an image job.
        request: { kind: 'video', engine: 'local', modelId: 'dev', prompt: 'x' },
      },
    }));
    const outcome = await terminal;

    expect(outcome.type).toBe('failed');
    expect(outcome.event.error).toMatch(/invalid persisted routing metadata/i);
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});

// #4348 / ADR 2026-08-20-federated-visual-prompts rule 5. The enqueue-time
// tailnet gate checked the peer record as it looked THEN; a queued or
// reconciling job re-resolves its peer on every request, and that record can
// change underneath it. The fixture peer is a plain LAN address — and every
// OTHER test in this file drives that same peer with an interactive (no
// standing bit) marker and still passes, which is what pins the other half of
// this contract: interactive routing is explicitly out of scope for rule 5.
describe('standing-route tailnet boundary survives the enqueue', () => {
  it('refuses to submit when a standing route peer is no longer a tailnet host', async () => {
    const base = params();
    const settled = captureTerminal(LOCAL_JOB_ID);
    await generateImage({ ...base, remoteMedia: { ...base.remoteMedia, standingRoute: true } });
    const outcome = await settled;
    expect(outcome.type).toBe('failed');
    expect(outcome.event.error).toMatch(/no longer a Tailscale host/i);
  });
});
