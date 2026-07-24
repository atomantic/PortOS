import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  rm: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { imageTo3d: '/mock/data/image-to-3d' },
  resolveGalleryImage: vi.fn((filename) => (
    filename === 'missing.png' ? null : `/mock/data/images/${filename}`
  )),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

vi.mock('./targets.js', () => ({
  DEFAULT_IMAGE_TO_3D_TARGET: 'trellis2',
  detectHostCapabilities: vi.fn(() => ({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false })),
  resolveTarget: vi.fn((id) => (
    id === 'trellis2'
      ? { targetId: 'trellis2', target: { id: 'trellis2', label: 'TRELLIS.2' }, available: true, reason: null }
      : { targetId: id, target: null, available: false, reason: 'unknown-target' }
  )),
}));

vi.mock('./trellis2.js', () => ({
  isTrellis2Installed: vi.fn(() => true),
  // The runner returns a { promise, kill } pair (see runTrellis2Generate).
  runTrellis2Generate: vi.fn(() => ({
    promise: Promise.resolve({ assetPath: '/mock/data/image-to-3d/x/model.glb' }),
    kill: vi.fn(),
  })),
}));

vi.mock('./db.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  mutateModel: vi.fn(),
  deleteModel: vi.fn(),
  recoverInterruptedModels: vi.fn(),
}));

import { rm } from 'node:fs/promises';
import { resolveTarget } from './targets.js';
import { isTrellis2Installed, runTrellis2Generate } from './trellis2.js';
import * as store from './db.js';
import {
  createModel, startGeneration, getModelAsset, recoverInterruptedModels, deleteModel,
} from './models.js';

const draftRecord = () => ({
  id: 'image3d-example',
  name: 'Beacon',
  target: 'trellis2',
  sourceImage: { filename: 'example.png', path: '/data/images/example.png' },
  status: 'draft',
  assetPath: null,
  generationOperationId: null,
  runs: [],
});

describe('image-to-3D model orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTrellis2Installed.mockReturnValue(true);
    resolveTarget.mockImplementation((id) => (
      id === 'trellis2'
        ? { targetId: 'trellis2', target: { id: 'trellis2', label: 'TRELLIS.2' }, available: true, reason: null }
        : { targetId: id, target: null, available: false, reason: 'unknown-target' }
    ));
    runTrellis2Generate.mockReturnValue({
      promise: Promise.resolve({ assetPath: '/mock/data/image-to-3d/x/model.glb' }),
      kill: vi.fn(),
    });
  });

  it('rejects a source that is no longer in the gallery', async () => {
    await expect(createModel({ name: 'Missing', filename: 'missing.png' }))
      .rejects.toMatchObject({ status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
    expect(store.createModel).not.toHaveBeenCalled();
  });

  it('refuses to persist a record when the target is not installed', async () => {
    isTrellis2Installed.mockReturnValue(false);
    await expect(createModel({ name: 'Beacon', filename: 'example.png' }))
      .rejects.toMatchObject({ status: 409, code: 'TARGET_NOT_INSTALLED' });
    expect(store.createModel).not.toHaveBeenCalled();
    expect(runTrellis2Generate).not.toHaveBeenCalled();
  });

  it('refuses when the host cannot run the target', async () => {
    resolveTarget.mockReturnValue({ targetId: 'trellis2', target: { id: 'trellis2', label: 'TRELLIS.2' }, available: false, reason: 'insufficient-memory' });
    await expect(createModel({ name: 'Beacon', filename: 'example.png' }))
      .rejects.toMatchObject({ status: 409, code: 'TARGET_UNAVAILABLE', context: { reason: 'insufficient-memory' } });
    expect(store.createModel).not.toHaveBeenCalled();
  });

  it('rejects an unknown target', async () => {
    await expect(createModel({ name: 'Beacon', filename: 'example.png', target: 'nope' }))
      .rejects.toMatchObject({ status: 400, code: 'UNKNOWN_TARGET' });
  });

  it('rejects a duplicate generate while already generating', async () => {
    store.getModel.mockResolvedValue({ ...draftRecord(), status: 'generating', generationOperationId: 'op-1' });
    await expect(startGeneration('image3d-example'))
      .rejects.toMatchObject({ status: 409, code: 'MODEL_BUSY' });
    expect(runTrellis2Generate).not.toHaveBeenCalled();
  });

  it('creates the record, renders, and lands a ready mesh with an assetPath', async () => {
    let current = draftRecord();
    store.createModel.mockImplementation(async () => current);
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });

    const started = await createModel({ name: 'Beacon', filename: 'example.png' });
    expect(started.status).toBe('generating');

    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(runTrellis2Generate).toHaveBeenCalledWith(expect.objectContaining({
      imagePath: '/mock/data/images/example.png',
      outputPath: expect.stringMatching(/image-to-3d\/image3d-example\/model\.glb$/),
    }));
    expect(current.assetPath).toBe('/data/image-to-3d/image3d-example/model.glb');
    expect(current.generationOperationId).toBeNull();
    expect(current.runs.at(-1)).toMatchObject({ status: 'completed', percent: 100 });
  });

  it('marks the record failed when the render throws', async () => {
    let current = draftRecord();
    store.createModel.mockImplementation(async () => current);
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runTrellis2Generate.mockImplementation(() => ({
      promise: Promise.reject(new Error('TRELLIS.2 generate exited 1')),
      kill: vi.fn(),
    }));

    await createModel({ name: 'Beacon', filename: 'example.png' });
    await vi.waitFor(() => expect(current.status).toBe('failed'));
    expect(current.error).toMatch(/exited 1/);
    expect(current.runs.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('recoverInterruptedModels never launches a render (no cold-bootstrap)', async () => {
    store.recoverInterruptedModels.mockResolvedValue({ recovered: 2 });
    const result = await recoverInterruptedModels();
    expect(result).toEqual({ recovered: 2 });
    // The whole point of boot recovery: mark interrupted renders failed-retryable
    // WITHOUT relaunching any GPU work (CLAUDE.md no-cold-bootstrap policy).
    expect(runTrellis2Generate).not.toHaveBeenCalled();
  });

  it('deleting a record mid-render kills the child and leaves no orphaned GLB', async () => {
    let current = draftRecord();
    const killSpy = vi.fn();
    let rejectRender;
    runTrellis2Generate.mockReturnValue({
      promise: new Promise((_, reject) => { rejectRender = reject; }),
      kill: killSpy,
    });
    store.createModel.mockImplementation(async () => current);
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    store.deleteModel.mockImplementation(async () => {
      current = {
        ...current,
        status: current.status === 'generating' ? 'canceled' : current.status,
        deleted: true,
      };
      return { ok: true };
    });

    await createModel({ name: 'Beacon', filename: 'example.png' });
    // The render subprocess spawns inside executeRender (setImmediate) — wait until the
    // kill handle is registered before deleting.
    await vi.waitFor(() => expect(runTrellis2Generate).toHaveBeenCalled());
    expect(current.status).toBe('generating');

    await deleteModel('image3d-example');
    // The in-flight subprocess is SIGTERM'd promptly.
    expect(killSpy).toHaveBeenCalled();
    expect(current.deleted).toBe(true);

    // The killed child settles; executeRender's finally then removes the orphaned dir.
    rejectRender(Object.assign(new Error('killed'), { code: 'TRELLIS2_GENERATE_FAILED' }));
    await vi.waitFor(() => expect(rm).toHaveBeenCalledWith(
      '/mock/data/image-to-3d/image3d-example',
      expect.objectContaining({ recursive: true, force: true }),
    ));
  });

  it('getModelAsset 409s until a mesh is rendered, then returns the download path', async () => {
    store.getModel.mockResolvedValueOnce({ ...draftRecord(), status: 'generating' });
    await expect(getModelAsset('image3d-example'))
      .rejects.toMatchObject({ status: 409, code: 'MODEL_NOT_READY' });

    store.getModel.mockResolvedValueOnce({
      ...draftRecord(), status: 'ready', name: 'My Beacon', assetPath: '/data/image-to-3d/image3d-example/model.glb',
    });
    const asset = await getModelAsset('image3d-example');
    expect(asset).toMatchObject({
      path: expect.stringMatching(/image-to-3d\/image3d-example\/model\.glb$/),
      filename: 'my-beacon.glb',
    });
  });
});
