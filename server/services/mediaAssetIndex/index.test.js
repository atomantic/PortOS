/**
 * Boot wiring + live-hook tests for the media asset index. No live DB — the DB
 * layer (db.js) and the disk readers are mocked, so we assert the orchestration:
 * escape-hatch no-op, reconcile-on-init, and the completed-event hooks turning a
 * generated asset into one upsert with the right key/shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const upsertAsset = vi.fn(async () => {});
const removeAsset = vi.fn(async () => {});
const reconcileMediaAssets = vi.fn(async () => ({ ok: true, indexed: 0, pruned: 0 }));
const checkHealth = vi.fn(async () => ({ connected: true }));
const ensureSchema = vi.fn(async () => {});
const readImageSidecar = vi.fn(async () => ({ metadata: { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z' } }));
const loadHistory = vi.fn(async () => ([{ id: 'job-1', filename: 'job-1.mp4', createdAt: '2026-01-02T00:00:00.000Z' }]));

vi.mock('./db.js', async () => ({ upsertAsset, reconcileMediaAssets, removeAsset,
  queueMediaIndexRefresh: (await import('../../lib/fileWriteQueue.js')).createFileWriteQueue() }));
vi.mock('../../lib/db.js', () => ({ checkHealth, ensureSchema }));
vi.mock('../imageGen/local.js', () => ({ readImageSidecar, listGallery: vi.fn(async () => []) }));
vi.mock('../videoGen/local.js', () => ({ loadHistory }));

import { imageGenEvents } from '../imageGenEvents.js';
import { videoGenEvents } from '../videoGen/events.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITEST', undefined);
  checkHealth.mockResolvedValue({ connected: true });
});

afterEach(() => vi.unstubAllEnvs());

// A tiny tick helper so the fire-and-forget event handlers settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('initMediaAssetIndex', () => {
  it.each([['test', undefined], [undefined, '1'], ['development', '1']])('no-ops with NODE_ENV=%s and VITEST=%s', async (nodeEnv, vitest) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('VITEST', vitest);
    const { initMediaAssetIndex } = await import('./index.js');
    const res = await initMediaAssetIndex();
    expect(res.reason).toBe('escape-hatch');
    expect(reconcileMediaAssets).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('bails when Postgres is unreachable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    checkHealth.mockResolvedValue({ connected: false, error: 'down' });
    const { initMediaAssetIndex } = await import('./index.js');
    const res = await initMediaAssetIndex();
    expect(res.reason).toBe('db-unreachable');
    expect(reconcileMediaAssets).not.toHaveBeenCalled();
  });

  it('ensures schema + reconciles, and indexes a completed image/video via the hooks', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { initMediaAssetIndex } = await import('./index.js');
    await initMediaAssetIndex();
    expect(ensureSchema).toHaveBeenCalled();
    expect(reconcileMediaAssets).toHaveBeenCalled();

    // A finished image render → one upsert keyed image:<filename>, sidecar merged.
    imageGenEvents.emit('completed', { generationId: 'g1', filename: 'img-1.png' });
    await flush();
    expect(upsertAsset).toHaveBeenCalledWith(expect.objectContaining({
      mediaKey: 'image:img-1.png', kind: 'image', ref: 'img-1.png',
      data: expect.objectContaining({ filename: 'img-1.png', prompt: 'p' }),
    }));

    // A finished video render → one upsert keyed video:<id>, history entry merged.
    upsertAsset.mockClear();
    videoGenEvents.emit('completed', { generationId: 'job-1', filename: 'job-1.mp4' });
    await flush();
    expect(upsertAsset).toHaveBeenCalledWith(expect.objectContaining({
      mediaKey: 'video:job-1', kind: 'video', ref: 'job-1',
    }));
    // A multi-format composition (#8960) lists one history entry per format;
    // none of them is keyed by the job id, so each is indexed from `videos`.
    upsertAsset.mockClear();
    loadHistory.mockResolvedValueOnce([
      { id: 'job-2-landscape', filename: 'a.mp4', createdAt: '2026-01-03T00:00:00.000Z' },
      { id: 'job-2-vertical', filename: 'b.mp4', createdAt: '2026-01-03T00:00:00.000Z' },
    ]);
    videoGenEvents.emit('completed', { generationId: 'job-2', videos: [{ id: 'job-2-landscape' }, { id: 'job-2-vertical' }] });
    await flush();
    expect(upsertAsset.mock.calls.map(([row]) => row.mediaKey)).toEqual(['video:job-2-landscape', 'video:job-2-vertical']);
  });
});

describe('completed hooks across a queued restore refresh', () => {
  it.each(['image', 'video'])('reads %s metadata only when its queued publication starts', async kind => {
    vi.stubEnv('NODE_ENV', 'production');
    const { initMediaAssetIndex } = await import('./index.js');
    const { queueMediaIndexRefresh } = await import('./db.js');
    await initMediaAssetIndex();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const reader = kind === 'image' ? readImageSidecar : loadHistory;
    const originalReader = reader.getMockImplementation();
    const originalUpsert = upsertAsset.getMockImplementation();
    let sourcePrompt = 'before restore';
    let mirroredPrompt;
    const written = [];
    reader.mockImplementation(async () => {
      const metadata = { prompt: sourcePrompt, createdAt: '2026-01-01T00:00:00.000Z' };
      return kind === 'image' ? { metadata } : [{ id: 'job-1', filename: 'job-1.mp4', ...metadata }];
    });
    upsertAsset.mockImplementation(async row => {
      if (!written.length) {
        entered.resolve();
        await release.promise;
      }
      written.push(row.data.prompt);
      mirroredPrompt = row.data.prompt;
    });
    const emit = () => kind === 'image'
      ? imageGenEvents.emit('completed', { filename: 'img-1.png' })
      : videoGenEvents.emit('completed', { generationId: 'job-1' });
    let rebuild;
    try {
      emit();
      await entered.promise;
      // This occupies the same queue as the real transactional rebuild (whose
      // persistence is covered by db.test). A later completion must not read
      // its source until that replacement has finished.
      rebuild = queueMediaIndexRefresh(() => {
        sourcePrompt = 'restored metadata';
        mirroredPrompt = sourcePrompt;
      });
      emit();
      await flush();
      expect(reader).toHaveBeenCalledTimes(1);
      expect(mirroredPrompt).toBeUndefined();
      release.resolve();
      await queueMediaIndexRefresh(() => {});
      expect(written).toEqual(['before restore', 'restored metadata']);
      expect(mirroredPrompt).toBe('restored metadata');
    } finally {
      release.resolve();
      await rebuild;
      await queueMediaIndexRefresh(() => {});
      reader.mockImplementation(originalReader);
      upsertAsset.mockImplementation(originalUpsert);
    }
  });
});

describe('unindexImage / unindexVideo (delete hooks, #2738)', () => {
  // The whole point of the hook: the key it deletes must be the key the upsert
  // hook wrote, or the delete silently misses and the row lingers to the next
  // boot. Pin both halves against the SAME asset rather than a hardcoded string.
  it('removes exactly the key the completed hook indexed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { initMediaAssetIndex, unindexImage, unindexVideo } = await import('./index.js');
    await initMediaAssetIndex();

    imageGenEvents.emit('completed', { generationId: 'g1', filename: 'img-1.png' });
    videoGenEvents.emit('completed', { generationId: 'job-1', filename: 'job-1.mp4' });
    await flush();
    const indexedKeys = upsertAsset.mock.calls.map(([row]) => row.mediaKey);

    await unindexImage('img-1.png');
    await unindexVideo('job-1');
    expect(removeAsset.mock.calls.map(([key]) => key)).toEqual(indexedKeys);
    // A video is keyed by job id, NOT its filename — the easy derivation to get wrong.
    expect(removeAsset).toHaveBeenCalledWith('video:job-1');
  });

  it('is non-fatal: a failing removal does not reject the caller (the delete already happened)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    removeAsset.mockRejectedValueOnce(new Error('db down'));
    const { unindexImage } = await import('./index.js');

    await expect(unindexImage('img-1.png')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    errSpy.mockRestore();
  });

  it('no-ops under the escape hatch and on an unusable ref', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { unindexImage } = await import('./index.js');
    await unindexImage('img-1.png');
    expect(removeAsset).not.toHaveBeenCalled();

    // A ref-less asset never produced a row, so there's nothing to delete.
    vi.stubEnv('NODE_ENV', 'production');
    const { unindexImage: liveUnindex, unindexVideo: liveUnindexVideo } = await import('./index.js');
    await liveUnindex(undefined);
    await liveUnindexVideo('');
    expect(removeAsset).not.toHaveBeenCalled();
  });
});
