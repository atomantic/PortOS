import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

// Seed a root before the dynamic import below: peerSyncAssets transitively
// pulls in modules that read PATHS.data at module-evaluation time, so the
// proxy's dataRoot getter must already resolve to a string.
let tempRoot = mkdtempSync(join(tmpdir(), 'portos-mv-assets-boot-'));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const peers = [];
vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => peers),
}));

vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn() }));

// Tracks are db-primary; stub the dispatcher so the manifest builder never
// touches Postgres. trackAudioFilename mirrors the real basename sanitizer.
vi.mock('../tracks/index.js', async () => ({
  getTrack: vi.fn(),
  trackAudioFilename: vi.fn((name) =>
    (typeof name === 'string' && name.trim() && !/[\\/]|\.\./.test(name) ? name.trim() : null)),
}));

const { getTrack } = await import('../tracks/index.js');
const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { peerSyncEvents } = await import('./peerSyncShared.js');
const {
  assetWriteQueue,
  buildMusicVideoAssetManifest,
  buildProjectAssetManifest,
  buildBoardAssetManifest,
  buildFableLoomAssetManifest,
  inflightPulls,
  pullMissingAssetsFromPeer,
} = await import('./peerSyncAssets.js');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function writeMusic(filename, bytes) {
  const dir = join(tempRoot, 'music');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

function writeImage(filename, bytes) {
  const dir = join(tempRoot, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

function writeVideo(filename, bytes) {
  const dir = join(tempRoot, 'videos');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

const mkAssetResponse = (body, contentLength = body.length) => ({
  ok: true,
  headers: {
    has: (name) => name === 'content-length',
    get: (name) => (name === 'content-length' ? String(contentLength) : null),
  },
  arrayBuffer: async () => body,
});

async function captureAssetArrivals(run) {
  const arrivals = [];
  const onArrival = (entry) => arrivals.push(entry);
  peerSyncEvents.on('asset-arrived', onArrival);
  try {
    await run();
  } finally {
    peerSyncEvents.off('asset-arrived', onArrival);
  }
  return arrivals;
}

function listAssetFiles(kind) {
  const dir = join(tempRoot, kind);
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('buildMusicVideoAssetManifest — master audio', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-mv-assets-'));
    vi.mocked(getTrack).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('bundles the uploaded audio basename (no track)', async () => {
    const bytes = Buffer.from('uploaded-audio');
    writeMusic('upload.mp3', bytes);
    const manifest = await buildMusicVideoAssetManifest({
      trackId: null, uploadedAudioFilename: 'upload.mp3', scenes: [],
    });
    expect(manifest).toContainEqual({ filename: 'upload.mp3', kind: 'music', sha256: sha(bytes) });
    expect(getTrack).not.toHaveBeenCalled();
  });

  it('resolves and bundles the linked track audio when uploadedAudioFilename is null (#1858)', async () => {
    const bytes = Buffer.from('track-audio');
    writeMusic('track-1.wav', bytes);
    vi.mocked(getTrack).mockResolvedValue({ id: 'trk-1', audioFilename: 'track-1.wav' });
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'trk-1', uploadedAudioFilename: null, scenes: [],
    });
    expect(getTrack).toHaveBeenCalledWith('trk-1');
    expect(manifest).toContainEqual({ filename: 'track-1.wav', kind: 'music', sha256: sha(bytes) });
  });

  it('skips a missing/deleted track without throwing', async () => {
    vi.mocked(getTrack).mockResolvedValue(null);
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'gone', uploadedAudioFilename: null, scenes: [],
    });
    expect(manifest).toEqual([]);
  });

  it('skips a track whose audio file is absent on disk (never ships a null hash)', async () => {
    vi.mocked(getTrack).mockResolvedValue({ id: 'trk-2', audioFilename: 'nope.wav' });
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'trk-2', uploadedAudioFilename: null, scenes: [],
    });
    expect(manifest).toEqual([]);
  });

  it('bundles the MuScriptor MIDI transcription alongside the master audio', async () => {
    const audioBytes = Buffer.from('uploaded-audio');
    const midiBytes = Buffer.from('MThd-midi-bytes');
    writeMusic('upload.mp3', audioBytes);
    writeMusic('neon-midi.mid', midiBytes);
    const manifest = await buildMusicVideoAssetManifest({
      trackId: null, uploadedAudioFilename: 'upload.mp3', scenes: [],
      midiTranscription: { filename: 'neon-midi.mid', model: 'medium' },
    });
    expect(manifest).toContainEqual({ filename: 'upload.mp3', kind: 'music', sha256: sha(audioBytes) });
    expect(manifest).toContainEqual({ filename: 'neon-midi.mid', kind: 'music', sha256: sha(midiBytes) });
  });

  it('dedups when the upload basename and the linked track point at the same file', async () => {
    const bytes = Buffer.from('shared');
    writeMusic('shared.mp3', bytes);
    vi.mocked(getTrack).mockResolvedValue({ id: 'trk-3', audioFilename: 'shared.mp3' });
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'trk-3', uploadedAudioFilename: 'shared.mp3', scenes: [],
    });
    const audio = manifest.filter((m) => m.kind === 'music');
    expect(audio).toHaveLength(1);
    expect(audio[0]).toEqual({ filename: 'shared.mp3', kind: 'music', sha256: sha(bytes) });
  });
});

describe('buildProjectAssetManifest — first-pass music bed (#1928)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-cd-assets-'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns an empty manifest for a bare project (no image, no music bed)', async () => {
    const manifest = await buildProjectAssetManifest({ startingImageFile: null, musicBed: null });
    expect(manifest).toEqual([]);
  });

  it('bundles the music bed so a subscribed peer does not get a dangling reference', async () => {
    const bytes = Buffer.from('music-bed-bytes');
    writeMusic('music-gen-abc.wav', bytes);
    const manifest = await buildProjectAssetManifest({
      startingImageFile: null,
      musicBed: { filename: 'music-gen-abc.wav', durationSec: 12, engine: 'musicgen' },
    });
    expect(manifest).toEqual([{ filename: 'music-gen-abc.wav', kind: 'music', sha256: sha(bytes) }]);
  });

  it('skips a music bed whose file is absent on disk (never ships a null hash)', async () => {
    const manifest = await buildProjectAssetManifest({
      startingImageFile: null,
      musicBed: { filename: 'never-written.wav' },
    });
    expect(manifest).toEqual([]);
  });

  it('bundles both the starting image and the music bed together', async () => {
    const imageBytes = Buffer.from('starting-image-bytes');
    const musicBytes = Buffer.from('music-bed-bytes-2');
    writeImage('start.png', imageBytes);
    writeMusic('music-gen-def.wav', musicBytes);
    const manifest = await buildProjectAssetManifest({
      startingImageFile: 'start.png',
      musicBed: { filename: 'music-gen-def.wav' },
    });
    expect(manifest).toContainEqual({ filename: 'start.png', kind: 'image', sha256: sha(imageBytes) });
    expect(manifest).toContainEqual(expect.objectContaining({ filename: 'music-gen-def.wav', kind: 'music', sha256: sha(musicBytes) }));
    expect(manifest).toHaveLength(2);
  });

  it('bundles completed directive-plan image and video renders that have no collection channel (#4159)', async () => {
    const imageBytes = Buffer.from('directive-image');
    const videoBytes = Buffer.from('directive-video');
    writeImage('plan-image.png', imageBytes);
    writeVideo('plan-video.mp4', videoBytes);
    const manifest = await buildProjectAssetManifest({
      plan: {
        steps: [
          { toolName: 'media_enqueueImageJob', status: 'done', result: { jobId: 'plan-image' } },
          { toolName: 'media_enqueueVideoJob', status: 'done', result: { jobId: 'plan-video' } },
        ],
      },
    });
    expect(manifest).toContainEqual(expect.objectContaining({
      filename: 'plan-image.png', kind: 'image', sha256: sha(imageBytes),
    }));
    expect(manifest).toContainEqual({ filename: 'plan-video.mp4', kind: 'video', sha256: sha(videoBytes) });
  });

  it('ignores unfinished, non-render, missing, and duplicate directive-plan results', async () => {
    const imageBytes = Buffer.from('one-render');
    writeImage('done-image.png', imageBytes);
    const manifest = await buildProjectAssetManifest({
      plan: {
        steps: [
          { toolName: 'media_enqueueImageJob', status: 'done', result: { jobId: 'done-image' } },
          { toolName: 'media_enqueueImageJob', status: 'done', result: { jobId: 'done-image' } },
          { toolName: 'media_enqueueImageJob', status: 'done', result: { jobId: '   ' } },
          { toolName: 'media_enqueueImageJob', status: 'running', result: { jobId: 'still-running' } },
          { toolName: 'pipeline_createSeries', status: 'done', result: { jobId: 'not-media' } },
          { toolName: 'media_enqueueVideoJob', status: 'done', result: { jobId: 'missing-video' } },
        ],
      },
    });
    expect(manifest).toEqual([expect.objectContaining({
      filename: 'done-image.png', kind: 'image', sha256: sha(imageBytes),
    })]);
  });
});

describe('buildBoardAssetManifest — video items (#4188)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-board-assets-'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('bundles a video item by its filename-as-ref mediaKey', async () => {
    const bytes = Buffer.from('video-bytes');
    writeVideo('upload-ab12cd34.mp4', bytes);
    const manifest = await buildBoardAssetManifest({
      items: [{ id: 'i1', type: 'video', mediaKey: 'video:upload-ab12cd34.mp4', imageUrl: null }],
    });
    expect(manifest).toContainEqual(expect.objectContaining({
      filename: 'upload-ab12cd34.mp4', kind: 'video', sha256: sha(bytes),
    }));
  });

  it('passes a non-mp4 extension through untouched (no `.mp4` guess)', async () => {
    const bytes = Buffer.from('webm-bytes');
    writeVideo('upload-ff00aa11.webm', bytes);
    const manifest = await buildBoardAssetManifest({
      items: [{ id: 'i1', type: 'video', mediaKey: 'video:upload-ff00aa11.webm', imageUrl: null }],
    });
    expect(manifest).toContainEqual(expect.objectContaining({
      filename: 'upload-ff00aa11.webm', kind: 'video', sha256: sha(bytes),
    }));
  });

  it('skips a video item whose bytes are missing, and never bundles the poster thumbnail', async () => {
    const manifest = await buildBoardAssetManifest({
      items: [
        { id: 'i1', type: 'video', mediaKey: 'video:never-written.mp4', imageUrl: '/data/video-thumbnails/never-written.jpg' },
        { id: 'i2', type: 'text', text: 'note' },
      ],
    });
    expect(manifest).toEqual([]);
  });

  it('still bundles image items alongside video items', async () => {
    const imageBytes = Buffer.from('img-bytes');
    const videoBytes = Buffer.from('vid-bytes');
    writeImage('render.png', imageBytes);
    writeVideo('clip.mp4', videoBytes);
    const manifest = await buildBoardAssetManifest({
      items: [
        { id: 'i1', type: 'image', mediaKey: 'image:render.png', imageUrl: null },
        { id: 'i2', type: 'video', mediaKey: 'video:clip.mp4', imageUrl: null },
      ],
    });
    expect(manifest).toContainEqual(expect.objectContaining({ filename: 'render.png', kind: 'image', sha256: sha(imageBytes) }));
    expect(manifest).toContainEqual(expect.objectContaining({ filename: 'clip.mp4', kind: 'video', sha256: sha(videoBytes) }));
    expect(manifest).toHaveLength(2);
  });
});

describe('buildFableLoomAssetManifest — scene renders', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-fableloom-assets-'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('bundles and deduplicates scene stills plus managed video-history clips', async () => {
    const imageBytes = Buffer.from('scene-image');
    const videoBytes = Buffer.from('scene-video');
    writeImage('scene.png', imageBytes);
    writeVideo('video-1.mp4', videoBytes);

    const manifest = await buildFableLoomAssetManifest({
      episodes: [
        { nodes: [{ id: 'node-1', image: 'scene.png', videoHistoryId: 'video-1' }] },
        { nodes: [{ id: 'node-2', image: 'scene.png', videoHistoryId: 'video-1' }] },
      ],
    });

    expect(manifest).toContainEqual(expect.objectContaining({
      filename: 'scene.png', kind: 'image', sha256: sha(imageBytes),
    }));
    expect(manifest).toContainEqual({
      filename: 'video-1.mp4', kind: 'video', sha256: sha(videoBytes),
    });
    expect(manifest).toHaveLength(2);
  });
});

describe('pullMissingAssetsFromPeer — unsafe and incomplete downloads (#5230)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-peer-pull-safety-'));
    peers.length = 0;
    peers.push({
      instanceId: 'peer-a',
      name: 'peer-a',
      address: '192.0.2.10',
      port: 5555,
    });
    assetWriteQueue.clear();
    inflightPulls.clear();
    vi.mocked(peerFetch).mockReset();
  });

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rejects traversal-shaped filenames before fetching or touching disk', async () => {
    const unsafeNames = ['..', '../../secret.json', '/etc/passwd', 'folder\\secret.json'];

    const arrivals = await captureAssetArrivals(() => pullMissingAssetsFromPeer(
      'peer-a',
      unsafeNames.map((filename) => ({ filename, kind: 'audio', sha256: 'unused' })),
    ));

    expect(peerFetch).not.toHaveBeenCalled();
    expect(arrivals).toEqual([]);
    expect(listAssetFiles('audio')).toEqual([]);
  });

  it('discards a truncated response without leaving destination or temporary files', async () => {
    const body = Buffer.from('partial');
    vi.mocked(peerFetch).mockResolvedValue(mkAssetResponse(body, body.length + 10));

    const arrivals = await captureAssetArrivals(() => pullMissingAssetsFromPeer('peer-a', [
      { filename: 'truncated.mp3', kind: 'audio', sha256: sha(body) },
    ]));

    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(arrivals).toEqual([]);
    expect(listAssetFiles('audio')).toEqual([]);
  });

  it('cleans up when the response stream terminates before producing a body', async () => {
    vi.mocked(peerFetch).mockResolvedValue({
      ...mkAssetResponse(Buffer.alloc(0), 20),
      arrayBuffer: vi.fn(async () => { throw new Error('stream terminated early'); }),
    });

    const arrivals = await captureAssetArrivals(() => pullMissingAssetsFromPeer('peer-a', [
      { filename: 'dropped.mp3', kind: 'audio', sha256: 'unused' },
    ]));

    expect(arrivals).toEqual([]);
    expect(listAssetFiles('audio')).toEqual([]);

    const retryBody = Buffer.from('complete retry');
    vi.mocked(peerFetch).mockResolvedValue(mkAssetResponse(retryBody));
    await pullMissingAssetsFromPeer('peer-a', [
      { filename: 'dropped.mp3', kind: 'audio', sha256: sha(retryBody) },
    ]);

    expect(peerFetch).toHaveBeenCalledTimes(2);
    expect(listAssetFiles('audio')).toEqual(['dropped.mp3']);
  });

  it('rejects a zero-byte asset without registering or writing it', async () => {
    vi.mocked(peerFetch).mockResolvedValue(mkAssetResponse(Buffer.alloc(0)));

    const arrivals = await captureAssetArrivals(() => pullMissingAssetsFromPeer('peer-a', [
      { filename: 'empty.mp3', kind: 'audio', sha256: sha(Buffer.alloc(0)) },
    ]));

    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(arrivals).toEqual([]);
    expect(listAssetFiles('audio')).toEqual([]);
  });

  it('coalesces concurrent same-peer pulls for one asset into one HTTP request', async () => {
    const body = Buffer.from('single-flight');
    let markFetchStarted;
    let releaseFetch;
    const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
    const fetchRelease = new Promise((resolve) => { releaseFetch = resolve; });
    vi.mocked(peerFetch).mockImplementation(async () => {
      markFetchStarted();
      await fetchRelease;
      return mkAssetResponse(body);
    });
    const entry = { filename: 'shared.mp3', kind: 'audio', sha256: sha(body) };

    const first = pullMissingAssetsFromPeer('peer-a', [entry]);
    await fetchStarted;
    const second = pullMissingAssetsFromPeer('peer-a', [entry]);
    releaseFetch();
    await Promise.all([first, second]);

    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(listAssetFiles('audio')).toEqual(['shared.mp3']);
  });
});
