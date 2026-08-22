import { beforeEach, describe, expect, it, vi } from 'vitest';
import { posixPath } from '../../lib/testHelper.js';

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
  renderOptionSupportFor: vi.fn(() => null),
}));

vi.mock('./trellis2.js', () => ({
  isTrellis2Installed: vi.fn(() => true),
  // The runner returns a { promise, kill } pair (see runTrellis2Generate).
  runTrellis2Generate: vi.fn(() => ({
    promise: Promise.resolve({ assetPath: '/mock/data/image-to-3d/x/model.glb' }),
    kill: vi.fn(),
  })),
}));

// The render spawns with the central HF child env (#3032). Mock the resolver
// so the suite doesn't pull in the real settings store (which needs PATHS.data, and
// this suite mocks fileUtils down to `imageTo3d` alone).
vi.mock('../../lib/hfToken.js', () => ({
  hfChildEnv: vi.fn(async () => ({ HF_TOKEN: 'hf_from_store', HUGGINGFACE_HUB_TOKEN: 'hf_from_store' })),
}));

// Background keying reads the source with sharp — mock it so the suite never
// touches real files. Default: null = pass-through (no solid background).
vi.mock('./sourceKeying.js', () => ({
  prepareSourceImage: vi.fn(async () => null),
}));

const { claimRelease } = vi.hoisted(() => ({ claimRelease: vi.fn(async () => {}) }));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({ ok: true, holder: {}, release: claimRelease })),
}));
vi.mock('../../lib/localMemory.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareLocalMemory: vi.fn(async () => ({ unloaded: [], availableGb: 64, totalGb: 64, budgetGb: 64, blockers: [] })),
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
import { ensureDir } from '../../lib/fileUtils.js';
import { resolveTarget, renderOptionSupportFor } from './targets.js';
import { isTrellis2Installed, runTrellis2Generate } from './trellis2.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { prepareSourceImage } from './sourceKeying.js';
import * as store from './db.js';
import {
  createModel, startGeneration, getModelAsset, getModelFullMesh, recoverInterruptedModels, deleteModel,
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
    claimHeavyLocalJob.mockResolvedValue({ ok: true, holder: {}, release: claimRelease });
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
    // Read the call back and normalize its paths — matchers compare the raw
    // received value, which is backslash-separated on Windows.
    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(posixPath(generateArgs.imagePath)).toBe('/mock/data/images/example.png');
    expect(posixPath(generateArgs.outputPath)).toMatch(/image-to-3d\/image3d-example\/model\.glb$/);
    // #3032: the resolved HF token (settings-stored included) rides into the child,
    // merged over process.env — without it, gated DINOv3/RMBG-2.0 pulls 401.
    expect(generateArgs.env).toMatchObject({ HF_TOKEN: 'hf_from_store', HUGGINGFACE_HUB_TOKEN: 'hf_from_store' });
    expect(claimHeavyLocalJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image-to-3D generation' }));
    expect(claimRelease).toHaveBeenCalled();
    expect(posixPath(current.assetPath)).toBe('/data/image-to-3d/image3d-example/model.glb');
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
    await vi.waitFor(() => {
      expect(rm).toHaveBeenCalled();
      const [target, opts] = rm.mock.calls.at(-1);
      expect(posixPath(target)).toBe('/mock/data/image-to-3d/image3d-example');
      expect(opts).toMatchObject({ recursive: true, force: true });
    });
  });

  it('terminates a render whose delete landed before the kill handle was registered', async () => {
    // The pre-registration window: beginRender flips the record to `generating` and
    // schedules executeRender, but the kill handle isn't in activeRenders until the
    // render actually spawns. A delete arriving in that window must still stop the
    // render once it spawns — executeRender re-checks `deleted` after registering.
    let current = draftRecord();
    let rejectRender;
    const renderPromise = new Promise((_, reject) => { rejectRender = reject; });
    const killSpy = vi.fn(() => rejectRender(
      Object.assign(new Error('killed'), { code: 'TRELLIS2_GENERATE_FAILED' }),
    ));
    runTrellis2Generate.mockReturnValue({ promise: renderPromise, kill: killSpy });

    // Pause executeRender at `await ensureDir`, before it spawns/registers the handle.
    let releaseEnsureDir;
    ensureDir.mockImplementationOnce(() => new Promise((resolve) => { releaseEnsureDir = resolve; }));

    store.createModel.mockImplementation(async () => current);
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    store.deleteModel.mockImplementation(async () => {
      current = { ...current, status: 'canceled', deleted: true };
      return { ok: true };
    });

    await createModel({ name: 'Beacon', filename: 'example.png' });
    await vi.waitFor(() => expect(ensureDir).toHaveBeenCalled());
    expect(runTrellis2Generate).not.toHaveBeenCalled(); // spawn hasn't happened yet

    // Delete lands in the window — no live handle, so deleteModel can't kill directly.
    await deleteModel('image3d-example');
    expect(killSpy).not.toHaveBeenCalled();

    // Render spawns; executeRender registers the handle, re-checks deleted, and kills it.
    releaseEnsureDir();
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());
  });

  it('getModelAsset 409s until a mesh is rendered, then returns the download path', async () => {
    store.getModel.mockResolvedValueOnce({ ...draftRecord(), status: 'generating' });
    await expect(getModelAsset('image3d-example'))
      .rejects.toMatchObject({ status: 409, code: 'MODEL_NOT_READY' });

    store.getModel.mockResolvedValueOnce({
      ...draftRecord(), status: 'ready', name: 'My Beacon', assetPath: '/data/image-to-3d/image3d-example/model.glb',
    });
    const asset = await getModelAsset('image3d-example');
    expect(posixPath(asset.path)).toMatch(/image-to-3d\/image3d-example\/model\.glb$/);
    expect(asset.filename).toBe('my-beacon.glb');
  });

  describe('getModelFullMesh', () => {
    const ready = () => ({
      ...draftRecord(),
      status: 'ready',
      name: 'My Beacon',
      assetPath: '/data/image-to-3d/image3d-example/model.glb',
    });

    it('returns the OBJ sidecar when it is on disk', async () => {
      store.getModel.mockResolvedValueOnce(ready());
      const mesh = await getModelFullMesh('image3d-example', { exists: async () => true });
      expect(posixPath(mesh.path)).toMatch(/image-to-3d\/image3d-example\/model\.obj$/);
      expect(mesh.filename).toBe('my-beacon-full.obj');
    });

    it('404s when the sidecar was never written, rather than claiming the record is broken', async () => {
      // Every readiness check the GLB passes can pass while the OBJ is absent — it
      // is an upstream side-effect file, not something the pipeline guarantees. So
      // this has to be its own probe rather than a read of `status`.
      store.getModel.mockResolvedValueOnce(ready());
      await expect(getModelFullMesh('image3d-example', { exists: async () => false }))
        .rejects.toMatchObject({ status: 404, code: 'FULL_MESH_MISSING' });
    });

    it('409s before a render has produced anything, without probing disk', async () => {
      store.getModel.mockResolvedValueOnce({ ...draftRecord(), status: 'generating' });
      const exists = vi.fn(async () => true);
      await expect(getModelFullMesh('image3d-example', { exists }))
        .rejects.toMatchObject({ status: 409, code: 'MODEL_NOT_READY' });
      expect(exists).not.toHaveBeenCalled();
    });

    it('404s on an unknown record', async () => {
      store.getModel.mockResolvedValueOnce(null);
      await expect(getModelFullMesh('nope', { exists: async () => true }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });
});

describe('render options and source keying', () => {
  // The standard live-record store harness: mutations apply to `current`.
  let current;
  const wireStore = (record) => {
    current = record;
    store.createModel.mockImplementation(async () => current);
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claimHeavyLocalJob.mockResolvedValue({ ok: true, holder: {}, release: claimRelease });
    isTrellis2Installed.mockReturnValue(true);
    resolveTarget.mockImplementation(() => (
      { targetId: 'trellis2', target: { id: 'trellis2', label: 'TRELLIS.2' }, available: true, reason: null }
    ));
    runTrellis2Generate.mockReturnValue({
      promise: Promise.resolve({ assetPath: '/mock/data/image-to-3d/x/model.glb' }),
      kill: vi.fn(),
    });
    prepareSourceImage.mockResolvedValue(null);
    wireStore(draftRecord());
  });

  it('rolls a fresh random seed per unpinned run and records it on the run entry', async () => {
    await createModel({ name: 'Beacon', filename: 'example.png' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(generateArgs.steps).toBeNull();
    expect(Number.isInteger(generateArgs.seed)).toBe(true);
    expect(generateArgs.seed).toBeGreaterThanOrEqual(0);
    expect(generateArgs.seed).toBeLessThanOrEqual(2147483647);
    // The run entry records the concrete values the subprocess received.
    expect(current.runs.at(-1)).toMatchObject({
      seed: generateArgs.seed, steps: null, keyBackground: false,
    });
  });

  it('per-run options reach the runner and the run entry, and do not persist on the record', async () => {
    await createModel({ name: 'Beacon', filename: 'example.png', steps: 24, seed: 7 });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(generateArgs).toMatchObject({ steps: 24, seed: 7 });
    expect(current.runs.at(-1)).toMatchObject({ steps: 24, seed: 7 });
    // Options are per-run parameters, not a stored record preference.
    expect(current.renderOptions).toBeUndefined();
  });

  // The run entry is the reproducible record of what the subprocess RECEIVED. A target
  // whose runner drops a knob (Pixal3D has no per-phase step override) must therefore
  // record it as unset AND not hand it to the runner — logging the requested value
  // would make the ledger lie about a setting that never applied.
  it('drops an unsupported render option from BOTH the runner call and the run entry', async () => {
    renderOptionSupportFor.mockReturnValueOnce({ steps: false });
    await createModel({ name: 'Beacon', filename: 'example.png', steps: 48, seed: 7 });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(generateArgs.steps).toBeNull();
    expect(current.runs.at(-1)).toMatchObject({ steps: null, seed: 7 });
  });

  it('a re-generate without options gets defaults, not the previous run’s values', async () => {
    wireStore({
      ...draftRecord(),
      runs: [{ operationId: 'op-old', status: 'completed', steps: 24, seed: 7 }],
    });

    await startGeneration('image3d-example', { options: {} });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(generateArgs.steps).toBeNull();
    expect(Number.isInteger(generateArgs.seed)).toBe(true);
  });

  it('a keyed source image is what the render consumes', async () => {
    prepareSourceImage.mockImplementation(async ({ targetPath }) => targetPath);

    await createModel({ name: 'Beacon', filename: 'example.png', keyBackground: true });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(posixPath(generateArgs.imagePath))
      .toBe('/mock/data/image-to-3d/image3d-example/source-keyed.png');
    expect(current.runs.at(-1).sourceKeyed).toBe(true);
  });

  // Keying writes an alpha channel, which makes TRELLIS.2 skip RMBG-2.0 — so the
  // DEFAULT has to leave the source alone, or a cast shadow the flood fill can't
  // reach survives into the mesh as geometry (#4684).
  it.each([
    ['omitted', {}],
    ['explicitly false', { keyBackground: false }],
  ])('keyBackground %s skips keying entirely', async (_label, options) => {
    await createModel({ name: 'Beacon', filename: 'example.png', ...options });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    expect(prepareSourceImage).not.toHaveBeenCalled();
    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(posixPath(generateArgs.imagePath)).toBe('/mock/data/images/example.png');
    expect(current.runs.at(-1).keyBackground).toBe(false);
    // `sourceKeyed` stays truthful in BOTH directions — it records what the render
    // consumed, not what was asked for.
    expect(current.runs.at(-1).sourceKeyed).toBe(false);
  });

  it('a keying failure falls back to the raw source instead of failing the render', async () => {
    prepareSourceImage.mockRejectedValue(new Error('unreadable image'));

    await createModel({ name: 'Beacon', filename: 'example.png', keyBackground: true });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    const [generateArgs] = runTrellis2Generate.mock.calls[0];
    expect(posixPath(generateArgs.imagePath)).toBe('/mock/data/images/example.png');
    expect(current.runs.at(-1).sourceKeyed).toBe(false);
  });
});
