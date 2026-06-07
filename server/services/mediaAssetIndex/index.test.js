/**
 * Boot wiring + live-hook tests for the media asset index. No live DB — the DB
 * layer (db.js) and the disk readers are mocked, so we assert the orchestration:
 * escape-hatch no-op, reconcile-on-init, and the completed-event hooks turning a
 * generated asset into one upsert with the right key/shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertAsset = vi.fn(async () => {});
const reconcileMediaAssets = vi.fn(async () => ({ ok: true, indexed: 0, pruned: 0 }));
const checkHealth = vi.fn(async () => ({ connected: true }));
const ensureSchema = vi.fn(async () => {});
const readImageSidecar = vi.fn(async () => ({ metadata: { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z' } }));
const loadHistory = vi.fn(async () => ([{ id: 'job-1', filename: 'job-1.mp4', createdAt: '2026-01-02T00:00:00.000Z' }]));

vi.mock('./db.js', () => ({ upsertAsset, reconcileMediaAssets, removeAsset: vi.fn() }));
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
