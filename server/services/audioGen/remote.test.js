import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempMusicDir;
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
const federation = vi.hoisted(() => ({ resolve: vi.fn(), peers: [] }));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: new Proxy(actual.PATHS, {
      get(target, key) {
        if (key === 'music') return tempMusicDir;
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

import { audioGenEvents } from './events.js';
import {
  __configureRemoteAudioForTests,
  __resetRemoteAudioForTests,
  cancel,
  generateAudio,
} from './remote.js';

const LOCAL_JOB_ID = '00000000-0000-4000-8000-000000000010';
const REMOTE_JOB_ID = '00000000-0000-4000-8000-000000000020';
const PEER_ID = '00000000-0000-4000-8000-000000000030';
const SAFE_PROMPT = 'Instrumental cinematic music with a dreamy mood, slow tempo, medium energy, featuring strings and synthesizer. No vocals or spoken words.';
const peer = {
  id: PEER_ID,
  enabled: true,
  address: '192.0.2.10',
  port: 5555,
  mediaProvider: { enabled: true, audioModels: [{ engine: 'remote-audio', modelId: 'example/model' }] },
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function providerJob(status, overrides = {}) {
  return {
    wireVersion: 1,
    id: REMOTE_JOB_ID,
    kind: 'audio',
    status,
    queuedAt: '2026-08-17T12:00:00.000Z',
    startedAt: status === 'queued' ? null : '2026-08-17T12:00:01.000Z',
    completedAt: ['completed', 'failed', 'canceled'].includes(status) ? '2026-08-17T12:00:02.000Z' : null,
    position: status === 'queued' ? 1 : null,
    progress: status === 'running' ? 0.5 : null,
    etaMs: status === 'running' ? 5_000 : null,
    ...overrides,
  };
}

const params = (overrides = {}) => ({
  jobId: LOCAL_JOB_ID,
  prompt: '',
  lyrics: '',
  engine: 'remote-audio',
  modelId: 'example/model',
  durationSec: 30,
  remoteMedia: {
    wireVersion: 1,
    peerId: PEER_ID,
    profile: {
      style: 'cinematic',
      mood: 'dreamy',
      tempo: 'slow',
      energy: 'medium',
      instruments: ['strings', 'synthesizer'],
    },
    request: {
      engine: 'remote-audio',
      modelId: 'example/model',
      durationSec: 30,
    },
  },
  ...overrides,
});

function captureTerminal(jobId) {
  return new Promise((resolve) => {
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
    const cleanup = () => {
      audioGenEvents.off('completed', onCompleted);
      audioGenEvents.off('failed', onFailed);
    };
    audioGenEvents.on('completed', onCompleted);
    audioGenEvents.on('failed', onFailed);
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

beforeEach(() => {
  tempMusicDir = mkdtempSync(join(tmpdir(), 'remote-audio-test-'));
  federation.peers = [peer];
  federation.resolve.mockReset().mockResolvedValue({ peer, capability: { engine: 'remote-audio', modelId: 'example/model' } });
  transport.fetch.mockReset();
  __configureRemoteAudioForTests({ pollDelayMs: 0, retryDelayMs: 0, requestTimeoutMs: 1_000 });
});

afterEach(() => {
  __resetRemoteAudioForTests();
  rmSync(tempMusicDir, { recursive: true, force: true });
});

describe('federated audio consumer adapter', () => {
  it('reconciles a queued provider job and atomically imports a verified WAV', async () => {
    const wav = Buffer.from('RIFF-example-wave-bytes');
    const digest = sha256(wav);
    const metadata = {
      available: true,
      mimeType: 'audio/wav',
      sizeBytes: wav.length,
      sha256: digest,
      downloadUrl: `/api/federation/media/v1/jobs/${REMOTE_JOB_ID}/result`,
      engine: 'remote-audio',
      modelId: 'example/model',
      durationSec: 30,
    };
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') return jsonResponse(providerJob('queued'), 202);
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}`)) return jsonResponse(providerJob('completed', { result: metadata }));
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}/result`)) {
        return new Response(wav, {
          headers: {
            'Content-Length': String(wav.length),
            'Content-Type': 'audio/wav',
            'X-Content-SHA256': digest,
          },
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateAudio(params());
    const outcome = await terminal;

    expect(outcome).toMatchObject({
      type: 'completed',
      event: {
        generationId: LOCAL_JOB_ID,
        filename: `music-gen-${LOCAL_JOB_ID}.wav`,
        engine: 'remote-audio',
        modelId: 'example/model',
        federatedMedia: { wireVersion: 1, peerId: PEER_ID, remoteJobId: REMOTE_JOB_ID },
      },
    });
    expect(readFileSync(join(tempMusicDir, outcome.event.filename))).toEqual(wav);
    expect(transport.fetch).toHaveBeenCalledWith(
      'http://192.0.2.10:5555/api/federation/media/v1/jobs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': LOCAL_JOB_ID }),
      }),
      peer,
    );
    const submission = transport.fetch.mock.calls.find(([url, options]) =>
      url.endsWith('/jobs') && options.method === 'POST');
    expect(JSON.parse(submission[1].body)).toEqual({
      engine: 'remote-audio',
      modelId: 'example/model',
      prompt: SAFE_PROMPT,
      durationSec: 30,
    });
  });

  // ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 2. The
  // two text fields travel opposite ways on purpose: `prompt` is re-rendered
  // from the fixed profile so hand-edited queue state cannot smuggle prose onto
  // the wire, while `lyrics` are submitted verbatim because they ARE the
  // conditioning. A marker with no lyrics must omit the field entirely, so an
  // instrumental job hashes to what a pre-lyrics build submitted.
  it('submits marker lyrics verbatim while still rendering the prompt from the profile', async () => {
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') return jsonResponse(providerJob('canceled'), 202);
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}`)) return jsonResponse(providerJob('canceled'));
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    const base = params();
    await generateAudio({
      ...base,
      remoteMedia: { ...base.remoteMedia, lyrics: '[verse]\nremote words' },
    }).catch(() => {});
    await terminal;

    const submission = transport.fetch.mock.calls.find(([url, options]) =>
      url.endsWith('/jobs') && options.method === 'POST');
    expect(JSON.parse(submission[1].body)).toEqual({
      engine: 'remote-audio',
      modelId: 'example/model',
      prompt: SAFE_PROMPT,
      durationSec: 30,
      lyrics: '[verse]\nremote words',
    });
  });

  it('replays an uncertain submission with the same idempotency key', async () => {
    const wav = Buffer.from('RIFF-replayed');
    const digest = sha256(wav);
    const completed = providerJob('completed', {
      result: {
        available: true,
        mimeType: 'audio/wav',
        sizeBytes: wav.length,
        sha256: digest,
        downloadUrl: '/ignored/provider/url',
        engine: 'remote-audio',
        modelId: 'example/model',
        durationSec: 30,
      },
    });
    let submissions = 0;
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') {
        submissions += 1;
        if (submissions === 1) throw new TypeError('temporary connection loss');
        return jsonResponse(completed, 200);
      }
      return new Response(wav, {
        headers: {
          'Content-Length': String(wav.length),
          'Content-Type': 'audio/wav',
          'X-Content-SHA256': digest,
        },
      });
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateAudio(params({
      remoteMedia: {
        wireVersion: 1,
        peerId: PEER_ID,
        reconcile: true,
        profile: {
          style: 'cinematic',
          mood: 'dreamy',
          tempo: 'slow',
          energy: 'medium',
          instruments: ['strings', 'synthesizer'],
        },
        request: {
          engine: 'remote-audio',
          modelId: 'example/model',
          durationSec: 30,
        },
      },
    }));
    expect((await terminal).type).toBe('completed');

    const postCalls = transport.fetch.mock.calls.filter(([, options]) => options.method === 'POST');
    expect(postCalls).toHaveLength(2);
    expect(postCalls.map(([, options]) => options.headers['Idempotency-Key']))
      .toEqual([LOCAL_JOB_ID, LOCAL_JOB_ID]);
    expect(federation.resolve).not.toHaveBeenCalled();
  });

  it('fails closed and removes the partial file when result integrity is wrong', async () => {
    const expected = Buffer.from('RIFF-expected');
    const received = Buffer.from('RIFF-tampered');
    const digest = sha256(expected);
    const metadata = {
      available: true,
      mimeType: 'audio/wav',
      sizeBytes: received.length,
      sha256: digest,
      downloadUrl: '/ignored/provider/url',
      engine: 'remote-audio',
      modelId: 'example/model',
      durationSec: 30,
    };
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') {
        return jsonResponse(providerJob('completed', { result: metadata }), 202);
      }
      return new Response(received, {
        headers: {
          'Content-Length': String(received.length),
          'Content-Type': 'audio/wav',
          'X-Content-SHA256': digest,
        },
      });
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateAudio(params());
    const outcome = await terminal;

    expect(outcome.type).toBe('failed');
    expect(outcome.event.error).toMatch(/integrity/i);
    expect(existsSync(join(tempMusicDir, `music-gen-${LOCAL_JOB_ID}.wav`))).toBe(false);
    expect(existsSync(join(tempMusicDir, `.music-gen-${LOCAL_JOB_ID}.wav.partial`))).toBe(false);
  });

  it('delivers cancellation to the recovered provider job', async () => {
    let polling = false;
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') return jsonResponse(providerJob('queued'), 202);
      if (url.endsWith('/cancel')) return jsonResponse(providerJob('canceled'));
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}`)) {
        polling = true;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    const running = generateAudio(params());
    await waitFor(() => polling);
    cancel(LOCAL_JOB_ID);
    await running;
    const outcome = await terminal;

    expect(outcome.type).toBe('failed');
    expect(outcome.event.error).toMatch(/canceled/i);
    expect(transport.fetch.mock.calls.some(([url, options]) =>
      url.endsWith(`/jobs/${REMOTE_JOB_ID}/cancel`) && options.method === 'POST')).toBe(true);
  });
});
