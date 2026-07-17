/**
 * Boot wiring + live-hook tests for the media asset index. No live DB — the DB
 * layer (db.js) and the disk readers are mocked, so we assert the orchestration:
 * escape-hatch no-op, reconcile-on-init, and the completed-event hooks turning a
 * generated asset into one upsert with the right key/shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertAsset = vi.fn(async () => {});
const removeAsset = vi.fn(async () => {});
const reconcileMediaAssets = vi.fn(async () => ({ ok: true, indexed: 0, pruned: 0 }));
const checkHealth = vi.fn(async () => ({ connected: true }));
const ensureSchema = vi.fn(async () => {});
const readImageSidecar = vi.fn(async () => ({ metadata: { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z' } }));
const loadHistory = vi.fn(async () => ([{ id: 'job-1', filename: 'job-1.mp4', createdAt: '2026-01-02T00:00:00.000Z' }]));

vi.mock('./db.js', () => ({ upsertAsset, reconcileMediaAssets, removeAsset }));
vi.mock('../../lib/db.js', () => ({ checkHealth, ensureSchema }));
vi.mock('../imageGen/local.js', () => ({ readImageSidecar, listGallery: vi.fn(async () => []) }));
vi.mock('../videoGen/local.js', () => ({ loadHistory }));

import { imageGenEvents } from '../imageGenEvents.js';
import { videoGenEvents } from '../videoGen/events.js';

beforeEach(() => {
  vi.clearAllMocks();
  checkHealth.mockResolvedValue({ connected: true });
});

// A tiny tick helper so the fire-and-forget event handlers settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('initMediaAssetIndex', () => {
  it('no-ops under the escape hatch (no DB, no reconcile)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { initMediaAssetIndex } = await import('./index.js');
    const res = await initMediaAssetIndex();
    expect(res.reason).toBe('escape-hatch');
    expect(reconcileMediaAssets).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('bails when Postgres is unreachable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    checkHealth.mockResolvedValue({ connected: false, error: 'down' });
    const { initMediaAssetIndex } = await import('./index.js');
    const res = await initMediaAssetIndex();
    expect(res.reason).toBe('db-unreachable');
    expect(reconcileMediaAssets).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
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
    vi.unstubAllEnvs();
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
    vi.unstubAllEnvs();
  });

  it('is non-fatal: a failing removal does not reject the caller (the delete already happened)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    removeAsset.mockRejectedValueOnce(new Error('db down'));
    const { unindexImage } = await import('./index.js');

    await expect(unindexImage('img-1.png')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('no-ops under the escape hatch and on an unusable ref', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { unindexImage } = await import('./index.js');
    await unindexImage('img-1.png');
    expect(removeAsset).not.toHaveBeenCalled();
    vi.unstubAllEnvs();

    // A ref-less asset never produced a row, so there's nothing to delete.
    vi.stubEnv('NODE_ENV', 'production');
    const { unindexImage: liveUnindex, unindexVideo: liveUnindexVideo } = await import('./index.js');
    await liveUnindex(undefined);
    await liveUnindexVideo('');
    expect(removeAsset).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
