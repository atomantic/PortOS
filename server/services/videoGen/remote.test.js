import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempVideoDir;
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
const federation = vi.hoisted(() => ({ resolve: vi.fn(), peers: [] }));
const ffmpeg = vi.hoisted(() => ({ thumbnail: vi.fn(), faststart: vi.fn() }));
const historyState = vi.hoisted(() => ({ rows: [] }));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: new Proxy(actual.PATHS, {
      get(target, key) {
        if (key === 'videos') return tempVideoDir;
        return target[key];
      },
    }),
  };
});

vi.mock('../../lib/peerHttpClient.js', () => ({
  peerFetch: (...args) => transport.fetch(...args),
}));

vi.mock('../../lib/ffmpeg.js', () => ({
  generateThumbnail: (...args) => ffmpeg.thumbnail(...args),
  optimizeForStreaming: (...args) => ffmpeg.faststart(...args),
}));

vi.mock('./history.js', () => ({
  mutateVideoHistory: async (mutator) => { historyState.rows = await mutator(historyState.rows); },
}));

vi.mock('../federatedMediaConsumer.js', () => ({
  resolveFederatedMediaProvider: (...args) => federation.resolve(...args),
}));

vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => federation.peers),
  // Used to derive the consumer's own half of a content-addressed asset id, so it
  // can ask the peer whether bytes are already staged before re-sending them.
  getInstanceId: vi.fn(async () => 'consumer-instance'),
}));

import { videoGenEvents } from './events.js';
import {
  __configureRemoteVideoForTests,
  __resetRemoteVideoForTests,
  generateChainedVideo,
  generateVideo,
} from './remote.js';

const LOCAL_JOB_ID = '00000000-0000-4000-8000-000000000210';
const REMOTE_JOB_ID = '00000000-0000-4000-8000-000000000220';
const PEER_ID = '00000000-0000-4000-8000-000000000230';
const peer = {
  id: PEER_ID,
  enabled: true,
  address: '192.0.2.10',
  port: 5555,
  mediaProvider: { enabled: true, videoModels: [{ engine: 'local', modelId: 'ltx2' }] },
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const providerJob = (status, overrides = {}) => ({
  wireVersion: 1,
  id: REMOTE_JOB_ID,
  kind: 'video',
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
      kind: 'video',
      engine: 'local',
      modelId: 'ltx2',
      prompt: 'a slow pan across a harbour',
      width: 704,
      height: 480,
      numFrames: 121,
      fps: 24,
    },
  },
  ...overrides,
});

function captureTerminal(jobId) {
  return new Promise((resolve) => {
    const cleanup = () => {
      videoGenEvents.off('completed', onCompleted);
      videoGenEvents.off('failed', onFailed);
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
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);
  });
}

beforeEach(() => {
  tempVideoDir = mkdtempSync(join(tmpdir(), 'remote-video-test-'));
  historyState.rows = [];
  federation.peers = [peer];
  federation.resolve.mockReset().mockResolvedValue({
    peer,
    capability: { kind: 'video', engine: 'local', modelId: 'ltx2' },
  });
  transport.fetch.mockReset();
  ffmpeg.faststart.mockReset().mockResolvedValue(undefined);
  ffmpeg.thumbnail.mockReset().mockResolvedValue(`${LOCAL_JOB_ID}.jpg`);
  __configureRemoteVideoForTests({ pollDelayMs: 0, retryDelayMs: 0, requestTimeoutMs: 1_000 });
});

afterEach(() => {
  __resetRemoteVideoForTests();
  rmSync(tempVideoDir, { recursive: true, force: true });
});

describe('federated video consumer adapter', () => {
  it('imports a verified MP4 and registers the history row the local renderer would have', async () => {
    const mp4 = Buffer.from('ftyp-example-mp4-bytes');
    const digest = sha256(mp4);
    const metadata = {
      available: true,
      mimeType: 'video/mp4',
      sizeBytes: mp4.length,
      sha256: digest,
      downloadUrl: `/api/federation/media/v1/jobs/${REMOTE_JOB_ID}/result`,
      engine: 'local',
      modelId: 'ltx2',
      durationSec: 5,
    };
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') return jsonResponse(providerJob('queued'), 202);
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}`)) return jsonResponse(providerJob('completed', { result: metadata }));
      if (url.endsWith(`/jobs/${REMOTE_JOB_ID}/result`)) {
        return new Response(mp4, {
          headers: {
            'Content-Length': String(mp4.length),
            'Content-Type': 'video/mp4',
            'X-Content-SHA256': digest,
          },
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateVideo(params());
    const outcome = await terminal;

    expect(outcome).toMatchObject({
      type: 'completed',
      event: {
        generationId: LOCAL_JOB_ID,
        filename: `${LOCAL_JOB_ID}.mp4`,
        path: `/data/videos/${LOCAL_JOB_ID}.mp4`,
        thumbnail: `${LOCAL_JOB_ID}.jpg`,
        federatedMedia: { wireVersion: 1, peerId: PEER_ID, remoteJobId: REMOTE_JOB_ID },
      },
    });
    expect(readFileSync(join(tempVideoDir, `${LOCAL_JOB_ID}.mp4`))).toEqual(mp4);

    // The history row is what makes the clip visible: the media index looks the
    // render up by job id there, and the Video Gen page lists from it.
    expect(historyState.rows).toHaveLength(1);
    expect(historyState.rows[0]).toMatchObject({
      id: LOCAL_JOB_ID,
      prompt: 'a slow pan across a harbour',
      modelId: 'ltx2',
      filename: `${LOCAL_JOB_ID}.mp4`,
      thumbnail: `${LOCAL_JOB_ID}.jpg`,
      numFrames: 121,
      fps: 24,
      federatedPeerId: PEER_ID,
      federatedJobId: REMOTE_JOB_ID,
    });

    const submission = transport.fetch.mock.calls
      .find(([url, options]) => url.endsWith('/jobs') && options.method === 'POST');
    expect(JSON.parse(submission[1].body)).toEqual({
      kind: 'video',
      engine: 'local',
      modelId: 'ltx2',
      prompt: 'a slow pan across a harbour',
      width: 704,
      height: 480,
      numFrames: 121,
      fps: 24,
    });
  });

  it('still registers the render when ffmpeg is unavailable for a thumbnail', async () => {
    ffmpeg.thumbnail.mockResolvedValue(null);
    const mp4 = Buffer.from('ftyp-no-ffmpeg');
    const digest = sha256(mp4);
    transport.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') {
        return jsonResponse(providerJob('completed', {
          result: {
            available: true,
            mimeType: 'video/mp4',
            sizeBytes: mp4.length,
            sha256: digest,
            downloadUrl: '/ignored/provider/url',
            engine: 'local',
            modelId: 'ltx2',
            durationSec: 5,
          },
        }), 202);
      }
      return new Response(mp4, {
        headers: {
          'Content-Length': String(mp4.length),
          'Content-Type': 'video/mp4',
          'X-Content-SHA256': digest,
        },
      });
    });

    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateVideo(params());
    const outcome = await terminal;

    expect(outcome.type).toBe('completed');
    expect(outcome.event.thumbnail).toBeNull();
    expect(historyState.rows[0].thumbnail).toBeNull();
  });

  it('fails a chained render instead of silently producing one unchained clip', async () => {
    const terminal = captureTerminal(LOCAL_JOB_ID);
    generateChainedVideo({ jobId: LOCAL_JOB_ID });
    const outcome = await terminal;

    expect(outcome.type).toBe('failed');
    expect(outcome.event.error).toMatch(/chained video renders cannot run on a federated media provider/i);
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});
