import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempVideoDir;
const videoDirs = vi.hoisted(() => ({ current: undefined }));
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
const federation = vi.hoisted(() => ({ resolve: vi.fn(), peers: [] }));
const ffmpeg = vi.hoisted(() => ({ thumbnail: vi.fn(), faststart: vi.fn() }));
const historyState = vi.hoisted(() => ({ rows: [], gate: null, fail: false }));
const publication = vi.hoisted(() => ({ bypass: false, entered: null }));
vi.mock('../../lib/backupSnapshotBoundary.js', async original => {
  const actual = await original();
  return { ...actual, withBackupAssetPublication: work => {
    publication.entered?.resolve();
    return publication.bypass ? work() : actual.withBackupAssetPublication(work);
  } };
});
vi.mock('../../lib/databaseMaintenanceJournal.js', async original => ({ ...(await original()), assertDatabaseAdmission: () => {} }));

// Every data-rooted PATHS member (including the media-models registry's
// `PATHS.data`) lands in a disposable root; only the video dirs vary per test.
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('remote-video-data-'),
    extraOverrides: () => ({ videos: videoDirs.current, videoThumbnails: videoDirs.current }),
  });
});

vi.mock('../../lib/peerHttpClient.js', () => ({
  peerFetch: (...args) => transport.fetch(...args),
}));

vi.mock('../../lib/ffmpeg.js', () => ({
  generateThumbnail: (...args) => ffmpeg.thumbnail(...args),
  optimizeForStreaming: (...args) => ffmpeg.faststart(...args),
}));

vi.mock('./history.js', () => ({
  mutateVideoHistory: async (mutator) => {
    historyState.gate?.entered.resolve();
    if (historyState.gate) await historyState.gate.finish.promise;
    if (historyState.fail) throw new Error('history refused');
    historyState.rows = await mutator(structuredClone(historyState.rows));
    await writeFile(join(tempVideoDir, 'history.json'), JSON.stringify(historyState.rows));
  },
}));

vi.mock('../federatedMediaConsumer.js', () => ({
  resolveFederatedMediaProvider: (...args) => federation.resolve(...args),
}));

vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => federation.peers),
}));

vi.mock('../instanceIdentity.js', () => ({
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

afterAll(cleanupTempDataRoots);

beforeEach(() => {
  tempVideoDir = mkdtempSync(join(tmpdir(), 'remote-video-test-'));
  videoDirs.current = tempVideoDir;
  historyState.rows = [];
  historyState.gate = null; historyState.fail = false;
  publication.bypass = false; publication.entered = null;
  writeFileSync(join(tempVideoDir, 'history.json'), '[]');
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
        remoteInputsDisposable: true,
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

  it.each(['failed', 'canceled'])('marks inputs disposable only after a known provider %s outcome', async (status) => {
    transport.fetch.mockResolvedValue(jsonResponse(providerJob(status), 200));
    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateVideo(params());
    const outcome = await terminal;
    expect(outcome).toMatchObject({ type: 'failed', event: { remoteInputsDisposable: true } });
    expect(outcome.event).not.toHaveProperty('remoteRecoverySettlement');
  });

  it.each(['failed', 'canceled'])('certifies original-key reconciliation after a known provider %s outcome and teardown', async (status) => {
    transport.fetch.mockResolvedValue(jsonResponse(providerJob(status), 200));
    const input = params(); input.remoteMedia.reconcile = true;
    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateVideo(input);
    expect(await terminal).toMatchObject({ type: 'failed', event: { remoteInputsDisposable: true,
      remoteRecoverySettlement: { jobId: LOCAL_JOB_ID, peerId: PEER_ID, remoteJobId: REMOTE_JOB_ID, status, executorSettled: true },
    } });
    expect(transport.fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(LOCAL_JOB_ID);
  });

  it('does not certify prior termination from a never-submitted disposable-input verdict', async () => {
    federation.resolve.mockRejectedValueOnce(Object.assign(new Error('No eligible model'), { code: 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED' }));
    const terminal = captureTerminal(LOCAL_JOB_ID);
    await generateVideo(params());
    const outcome = await terminal;
    expect(outcome.event.remoteInputsDisposable).toBe(true);
    expect(outcome.event).not.toHaveProperty('remoteRecoverySettlement');
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('serializes executor attempts for one original idempotency key', async () => {
    let release;
    transport.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const input = params(); input.remoteMedia.reconcile = true;
    const first = generateVideo(input);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1));
    await expect(generateVideo(input)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_RECONCILIATION_ACTIVE' });
    release(jsonResponse(providerJob('failed'), 200));
    await first;
  });

  it('retains replay inputs after an uncertain submission or malformed recovery metadata', async () => {
    transport.fetch.mockRejectedValue(new Error('Uncertain transport response'));
    let terminal = captureTerminal(LOCAL_JOB_ID);
    await generateVideo(params());
    expect(await terminal).toMatchObject({ type: 'failed', event: { remoteInputsDisposable: false } });
    terminal = captureTerminal(LOCAL_JOB_ID);
    await generateVideo(params({ remoteMedia: { reconcile: true } }));
    expect((await terminal).event.remoteInputsDisposable).not.toBe(true);
  });

  it('retains inputs when local finalization fails after downloading a verified remote result', async () => {
    const mp4 = Buffer.from('fixture verified video');
    const digest = sha256(mp4);
    transport.fetch.mockImplementation(async (url) => url.endsWith('/jobs')
      ? jsonResponse(providerJob('completed', { result: { available: true, mimeType: 'video/mp4', sizeBytes: mp4.length,
        sha256: digest, downloadUrl: '/ignored', engine: 'local', modelId: 'ltx2', durationSec: 5 } }))
      : new Response(mp4, { headers: { 'Content-Length': String(mp4.length), 'Content-Type': 'video/mp4', 'X-Content-SHA256': digest } }));
    ffmpeg.faststart.mockRejectedValueOnce(new Error('fixture finalization failed'));
    const terminal = captureTerminal(LOCAL_JOB_ID);
    const input = params(); input.remoteMedia.reconcile = true;
    await generateVideo(input);
    const outcome = await terminal;
    expect(outcome).toMatchObject({ type: 'failed', event: { remoteInputsDisposable: false } });
    expect(outcome.event).not.toHaveProperty('remoteRecoverySettlement');
  });
});


describe('federated video replacement backup cut', () => {
  const bytes = Buffer.from('verified replacement');
  const video = () => join(tempVideoDir, `${LOCAL_JOB_ID}.mp4`);
  const poster = () => join(tempVideoDir, `${LOCAL_JOB_ID}.jpg`);
  async function prepare() {
    await writeFile(video(), 'original video');
    await writeFile(poster(), 'original poster');
    historyState.rows = [{ id: LOCAL_JOB_ID, filename: `${LOCAL_JOB_ID}.mp4`, thumbnail: `${LOCAL_JOB_ID}.jpg`, prompt: 'Original' }];
    await writeFile(join(tempVideoDir, 'history.json'), JSON.stringify(historyState.rows));
    ffmpeg.thumbnail.mockImplementation(async () => { await writeFile(poster(), 'replacement poster'); return `${LOCAL_JOB_ID}.jpg`; });
    transport.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/result')) return new Response(bytes, { headers: {
        'Content-Length': String(bytes.length), 'Content-Type': 'video/mp4', 'X-Content-SHA256': sha256(bytes),
      } });
      return jsonResponse(providerJob('completed', { result: {
        available: true, mimeType: 'video/mp4', sizeBytes: bytes.length, sha256: sha256(bytes),
        downloadUrl: '/unused', engine: 'local', modelId: 'ltx2', durationSec: 1,
      } }), 202);
    });
  }
  async function copyAssets() {
    const target = join(tempVideoDir, 'copied');
    await mkdir(target, { recursive: true });
    await cp(video(), join(target, 'clip.mp4'));
    await cp(poster(), join(target, 'poster.jpg'));
    return target;
  }
  async function copyRows(target) {
    await cp(join(tempVideoDir, 'history.json'), join(target, 'history.json'));
    return JSON.parse(await readFile(join(target, 'history.json'), 'utf8'));
  }
  const turn = () => new Promise(resolve => setImmediate(resolve));

  it('holds same-name replacement outside a cut and proves a mismatched copied pair when bypassed', async () => {
    const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
    await prepare();
    const cut = await acquireBackupSnapshotCut();
    let run;
    try {
      const copied = await copyAssets();
      publication.entered = Promise.withResolvers();
      run = generateVideo(params());
      await publication.entered.promise; await turn();
      expect(await readFile(video(), 'utf8')).toBe('original video');
      expect((await copyRows(copied))[0].prompt).toBe('Original');
    } finally { cut(); await run; }
    await prepare();
    const copied = await copyAssets();
    publication.bypass = true;
    await generateVideo(params());
    expect((await copyRows(copied))[0].prompt).not.toBe('Original');
    expect(await readFile(join(copied, 'clip.mp4'), 'utf8')).toBe('original video');
  });

  for (const fail of [false, true]) it(`drains replacement ${fail ? 'rollback' : 'commit'} before copying`, async () => {
    const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
    await prepare();
    historyState.fail = fail;
    const gate = { entered: Promise.withResolvers(), finish: Promise.withResolvers() };
    historyState.gate = gate;
    const run = generateVideo(params());
    await gate.entered.promise;
    let acquired = false;
    const cutting = acquireBackupSnapshotCut().then(cut => { acquired = true; return cut; });
    try {
      await turn(); expect(acquired).toBe(false);
      gate.finish.resolve(); await run;
      const cut = await cutting;
      try {
        const copied = await copyAssets();
        const rows = await copyRows(copied);
        expect(rows).toHaveLength(1);
        expect(await readFile(join(copied, 'clip.mp4'), 'utf8')).toBe(fail ? 'original video' : bytes.toString());
        expect(await readFile(join(copied, 'poster.jpg'), 'utf8')).toBe(fail ? 'original poster' : 'replacement poster');
        expect(rows[0].prompt === 'Original').toBe(fail);
      } finally { cut(); }
    } finally { gate.finish.resolve(); }
  });

  it('retains originals and a durable blocker when restoring the previous video fails', async () => {
    const { acquireBackupSnapshotCut, backupPublicationAdmissionStatus } = await import('../../lib/backupSnapshotBoundary.js');
    await prepare();
    ffmpeg.faststart.mockImplementationOnce(async () => {
      // Force a real restore-copy error after replacement installed, while the
      // poster restore remains possible and must still be attempted.
      await rm(video());
      await mkdir(video());
      throw new Error('finalizer failed');
    });
    const terminal = captureTerminal(LOCAL_JOB_ID);
    let scratch;
    try {
      await generateVideo(params());
      const outcome = await terminal;
      expect(outcome.type).toBe('failed');
      scratch = outcome.event.error.split('originals retained at ')[1];
      expect(scratch).toContain('portos-video-replay-');
      expect(await readFile(join(scratch, '0'), 'utf8')).toBe('original video');
      expect(await readFile(poster(), 'utf8')).toBe('original poster');
      await expect(acquireBackupSnapshotCut({ timeoutMs: 10 })).rejects.toMatchObject({
        code: 'BACKUP_SNAPSHOT_BUSY', blockers: [expect.objectContaining({ uncertain: true })],
      });
    } finally {
      for (const owner of backupPublicationAdmissionStatus().publications) rmSync(owner.path, { recursive: true });
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  });

  it('replays a matching completed result without duplicate history or another transfer', async () => {
    await prepare();
    await generateVideo(params());
    const calls = transport.fetch.mock.calls.filter(([url]) => url.endsWith('/result')).length;
    await generateVideo(params());
    expect(historyState.rows).toHaveLength(1);
    expect(transport.fetch.mock.calls.filter(([url]) => url.endsWith('/result'))).toHaveLength(calls);
  });
});
