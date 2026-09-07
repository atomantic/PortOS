import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

// The Lanczos path really copies a file, so PATHS.data must point at a temp
// tree — the install's data/ is the developer's live gallery.
vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-upscale-') }));
afterAll(cleanupTempDataRoots);

// The method contract (#6509): an absent options bag is exactly the historical
// Lanczos pass, `ltx` is accepted by the contract but has no dispatch path
// until #6511, and the plan endpoint is read-only.

const state = vi.hoisted(() => ({
  history: [],
  stream: { width: 768, height: 512, fps: 24, frameCount: 121 },
  frameCountFallback: null,
  duration: 5.04,
  hasAudio: false,
  runtimeInstalled: true,
  adapterCached: true,
}));

const mutated = vi.hoisted(() => ({ calls: 0 }));

vi.mock('./history.js', () => ({
  loadHistory: vi.fn(async () => state.history),
  mutateVideoHistory: vi.fn(async (mutator) => { mutated.calls += 1; return mutator([...state.history]); }),
}));

vi.mock('../../lib/ffmpeg.js', () => ({
  safeUnder: vi.fn((base, file) => (file ? `${base}/${file}` : null)),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  upscaleVideo2x: vi.fn(async () => ({ ok: true })),
  probeVideoStreamInfo: vi.fn(async () => state.stream),
  probeFrameCount: vi.fn(async () => state.frameCountFallback),
  probeVideoDuration: vi.fn(async () => state.duration),
  hasAudioStream: vi.fn(async () => state.hasAudio),
}));

vi.mock('./runtimes.js', () => ({
  BYOV_RUNTIME_INFO: { ltx25: { label: 'LTX-2.5 MLX' }, ltx25_cuda: { label: 'LTX-2.5 CUDA' } },
  isByovRuntimeInstalled: vi.fn(() => state.runtimeInstalled),
}));

vi.mock('../../lib/icLoraWeights.js', () => ({
  icLoraSpecByKey: vi.fn(() => ({
    id: 'pixel-upscale', label: 'Pixel Spatial Upscaler',
    repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler',
    filename: 'ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors',
    sizeBytes: 327_322_640, gated: true,
  })),
  icLoraWeightKey: vi.fn((spec) => spec?.id ?? null),
  resolveIcLoraWeightByKey: vi.fn(async () => ({ path: state.adapterCached ? '/cache/weight.safetensors' : null, cached: state.adapterCached })),
}));

const { upscaleHistoryItem, planUpscaleHistoryItem } = await import('./upscaleVideo.js');
const { PATHS } = await import('../../lib/fileUtils.js');
const { LANCZOS_PROVENANCE_FIELDS } = await import('./upscalePlan.js');
const ffmpeg = await import('../../lib/ffmpeg.js');
const { mutateVideoHistory } = await import('./history.js');

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const sourceRow = (extra = {}) => ({
  id: SOURCE_ID, filename: `${SOURCE_ID}.mp4`, prompt: 'a lighthouse',
  modelId: 'ltx2_unified', width: 768, height: 512, numFrames: 121, fps: 24, seed: 7, ...extra,
});

beforeEach(() => {
  // A real (tiny) source clip on disk: the copy-then-transform contract is the
  // thing under test, and stubbing the filesystem out would hide it.
  mkdirSync(PATHS.videos, { recursive: true });
  writeFileSync(join(PATHS.videos, `${SOURCE_ID}.mp4`), 'not really a video');
  state.history = [sourceRow()];
  state.stream = { width: 768, height: 512, fps: 24, frameCount: 121 };
  state.frameCountFallback = null;
  state.duration = 5.04;
  state.hasAudio = false;
  state.runtimeInstalled = true;
  state.adapterCached = true;
  mutated.calls = 0;
  vi.clearAllMocks();
});

describe('upscaleHistoryItem — method selection', () => {
  it('treats an absent options bag as the historical lanczos pass', async () => {
    const entry = await upscaleHistoryItem(SOURCE_ID);
    expect(ffmpeg.upscaleVideo2x).toHaveBeenCalledTimes(1);
    expect(entry).toMatchObject({
      upscaledFrom: SOURCE_ID, upscaleMethod: 'lanczos', upscaleRuntime: 'ffmpeg',
      width: 1536, height: 1024, hidden: false,
    });
  });

  it('produces the same row for an explicit lanczos request', async () => {
    const implicit = await upscaleHistoryItem(SOURCE_ID);
    const explicit = await upscaleHistoryItem(SOURCE_ID, { method: 'lanczos' });
    // Ids, filenames and timing are minted per call; everything describing the
    // PASS must match, or the default was not preserved.
    const shape = ({ id, filename, thumbnail, createdAt, renderStartedAt, renderCompletedAt, renderMs, ...rest }) => rest;
    expect(shape(explicit)).toEqual(shape(implicit));
  });

  it('writes every provenance field lanczos owns', async () => {
    const entry = await upscaleHistoryItem(SOURCE_ID);
    for (const field of LANCZOS_PROVENANCE_FIELDS) {
      expect(entry[field], `missing provenance field ${field}`).toBeDefined();
    }
  });

  it('leaves the source render seed on the row rather than nulling it', async () => {
    // The upscaled row inherits the SOURCE's fields by design; `upscaleMethod`
    // is what tells a reader the seed did not drive this pass.
    const entry = await upscaleHistoryItem(SOURCE_ID);
    expect(entry.seed).toBe(7);
  });

  it('rejects an unknown method before reading the history file', async () => {
    const { loadHistory } = await import('./history.js');
    await expect(upscaleHistoryItem(SOURCE_ID, { method: 'realesrgan' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it('fails the generative method with a capability error naming the runtime', async () => {
    await expect(upscaleHistoryItem(SOURCE_ID, { method: 'ltx' }))
      .rejects.toMatchObject({ status: 501, code: 'UNSUPPORTED_RUNTIME' });
  });

  it('queues nothing and writes nothing when the generative method is refused', async () => {
    await upscaleHistoryItem(SOURCE_ID, { method: 'ltx' }).catch(() => {});
    expect(ffmpeg.upscaleVideo2x).not.toHaveBeenCalled();
    expect(mutateVideoHistory).not.toHaveBeenCalled();
  });

  it('keeps the already-upscaled guard ahead of the capability error', async () => {
    // Otherwise adding a method would change the status code an existing client
    // sees for a source it must not re-upscale.
    state.history = [sourceRow({ upscaledFrom: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1' })];
    for (const options of [undefined, { method: 'ltx' }]) {
      await expect(upscaleHistoryItem(SOURCE_ID, options))
        .rejects.toMatchObject({ status: 400, code: 'ALREADY_UPSCALED' });
    }
  });

it('keeps the missing-id, missing-row and missing-file statuses', async () => {
    await expect(upscaleHistoryItem('not-a-uuid')).rejects.toMatchObject({ status: 400 });
    state.history = [];
    await expect(upscaleHistoryItem(SOURCE_ID)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    state.history = [sourceRow({ filename: 'never-written.mp4' })];
    await expect(upscaleHistoryItem(SOURCE_ID)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('planUpscaleHistoryItem', () => {
  it('reports the source geometry and a plain 2x target for lanczos', async () => {
    const plan = await planUpscaleHistoryItem(SOURCE_ID);
    expect(plan).toMatchObject({
      id: SOURCE_ID, method: 'lanczos', scale: 2, alreadyUpscaled: false, alignment: null, adapter: null,
    });
    expect(plan.source).toEqual({ width: 768, height: 512, fps: 24, frameCount: 121, durationSeconds: 5.04, hasAudio: false });
    expect(plan.target).toEqual({ width: 1536, height: 1024, frameCount: 121 });
  });

  it('reports zero padding for a generative source that already conforms', async () => {
    const plan = await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    expect(plan.alignment).toMatchObject({ padWidth: 0, padHeight: 0, padFrames: 0, trimFrames: 0, conforming: true });
    expect(plan.target).toEqual({ width: 1536, height: 1024, frameCount: 121 });
  });

  it('reports the padding a non-conforming source needs BEFORE submit', async () => {
    state.stream = { width: 848, height: 480, fps: 24, frameCount: 100 };
    const plan = await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    expect(plan.alignment).toMatchObject({ padWidth: 16, padHeight: 0, padFrames: 5, trimFrames: 0, conforming: false });
    expect(plan.target).toEqual({ width: 1728, height: 960, frameCount: 105 });
  });

  it('falls back to the decode-counting probe when the container header has no frame count', async () => {
    state.stream = { width: 768, height: 512, fps: 24, frameCount: null };
    state.frameCountFallback = 121;
    const plan = await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    expect(plan.source.frameCount).toBe(121);
    expect(plan.alignment.conforming).toBe(true);
  });

  it('reports an unmeasurable frame count as unknown rather than conforming', async () => {
    state.stream = { width: 768, height: 512, fps: 24, frameCount: null };
    state.frameCountFallback = null;
    const plan = await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    expect(plan.source.frameCount).toBeNull();
    expect(plan.alignment.conforming).toBeNull();
  });

  it('reports an already-upscaled source instead of throwing', async () => {
    state.history = [sourceRow({ upscaledFrom: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1' })];
    const plan = await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    expect(plan.alreadyUpscaled).toBe(true);
  });

  it('reports audio presence so the caller can disclose what happens to the track', async () => {
    state.hasAudio = true;
    const plan = await planUpscaleHistoryItem(SOURCE_ID);
    expect(plan.source.hasAudio).toBe(true);
  });

  it('reports runtime and adapter readiness for the generative method', async () => {
    const ready = await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    expect(ready.runtime).toMatchObject({ supported: true, installed: true, reason: null });
    expect(ready.adapter).toMatchObject({ key: 'pixel-upscale', cached: true, gated: true });

    state.runtimeInstalled = false;
    state.adapterCached = false;
    const unready = await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    expect(unready.runtime.installed).toBe(false);
    expect(unready.runtime.reason).toMatch(/not installed/i);
    expect(unready.adapter.cached).toBe(false);
  });

  it('queues no job, runs no ffmpeg pass and writes no history row', async () => {
    await planUpscaleHistoryItem(SOURCE_ID, { method: 'ltx' });
    await planUpscaleHistoryItem(SOURCE_ID, { method: 'lanczos' });
    expect(ffmpeg.upscaleVideo2x).not.toHaveBeenCalled();
    expect(ffmpeg.generateThumbnail).not.toHaveBeenCalled();
    expect(mutateVideoHistory).not.toHaveBeenCalled();
    expect(mutated.calls).toBe(0);
  });

  it('rejects an unknown method and the same bad-id statuses as the action', async () => {
    await expect(planUpscaleHistoryItem(SOURCE_ID, { method: 'realesrgan' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(planUpscaleHistoryItem('not-a-uuid')).rejects.toMatchObject({ status: 400 });
    state.history = [];
    await expect(planUpscaleHistoryItem(SOURCE_ID)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
