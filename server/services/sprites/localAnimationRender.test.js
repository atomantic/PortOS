/**
 * The LOCAL (MiniMax H3) sprite-animation render lane (#4876).
 *
 * The behaviors under test are the ones that decide whether a local render is
 * USABLE, not merely started: the frame count has to land on H3's fixed grid,
 * the canvas has to match the anchor's aspect (or videoGen center-crops the
 * character's head off before rendering), an unready install has to say which
 * one thing to fix, and a run's liveness has to survive a multi-hour render
 * without being mistaken for a dead one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-local-render-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    videos: join(TEST_ROOT, 'videos'),
  });
  return actual;
});

// The catalog, the runtime probes, and the HF cache are all environment facts;
// each test states the environment it is about rather than depending on what
// this machine happens to have installed.
let videoModels = [];
// Only the CATALOG accessor is stubbed; the pure row-shape helpers stay real so
// "what must be cached" is exercised rather than restated in a mock.
vi.mock('../../lib/mediaModels.js', async (importOriginal) => ({
  ...await importOriginal(),
  getVideoModels: () => videoModels,
}));

let runtimeReady = true;
vi.mock('../videoGen/runtimes.js', () => ({
  BYOV_RUNTIME_INFO: { minimax_h3: { label: 'MiniMax H3 MLX' } },
  isByovRuntimeReady: async () => runtimeReady,
}));

let cacheState = { cached: true };
let cachedFiles = ['/cache/a.safetensors'];
vi.mock('../../lib/hfCache.js', () => ({
  inspectModelCache: async () => cacheState,
  findCachedRepoFiles: async () => cachedFiles,
}));

const enqueued = [];
let queueJobs = new Map();
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: async (job) => {
    enqueued.push(job);
    return { jobId: `job-${enqueued.length}` };
  },
  getJob: (id) => queueJobs.get(id) || null,
}));

const {
  resolveLocalVideoModel, resolveLocalFrameCount, pickLocalRenderCanvas, localRenderFps,
  getLocalAnimationProviderStatus, listAnimationProviders, planLocalAnimationRender,
  localRenderManifest, enqueueLocalAnimationRender, collectLocalAnimationClip,
  localRunLiveness, spriteAnimationJobTag, normalizeStaleAnimationRun,
} = await import('./localAnimationRender.js');
// The lane VOCABULARY (ids, the request normalizer, the run-record predicate)
// lives in animationWorkflow.js so lib/spriteValidation.js can build its enum
// without pulling the media-job queue into the validation layer.
const {
  isLocalProviderRun, resolveAnimationProvider, LOCAL_VIDEO_PROVIDER_ID,
} = await import('./animationWorkflow.js');

// A stand-in for the shipped MLX row, carrying only the fields this lane reads.
// Frame options are H3's real 17n+5 grid so the snapping assertions are about
// the actual contract rather than a convenient synthetic one.
const H3_MLX = Object.freeze({
  id: 'minimax_h3_8bit',
  name: 'MiniMax H3 MLX 8-bit',
  repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
  revision: 'abc123',
  runtime: 'minimax_h3',
  defaultFrames: 124,
  frameOptions: [107, 124, 141, 158, 175],
  fpsOptions: [24],
  defaultWidth: 1344,
  defaultHeight: 768,
  resolutionOptions: [
    { label: '1536x672', w: 1536, h: 672 },
    { label: '1344x768', w: 1344, h: 768 },
    { label: '1024x768', w: 1024, h: 768 },
    { label: '768x768', w: 768, h: 768 },
    { label: '768x1024', w: 768, h: 1024 },
    { label: '768x1344', w: 768, h: 1344 },
  ],
  requiredWeights: [{ repo: 'MiniMaxAI/MiniMax-H3', revision: 'def456', files: ['FL2VA/model_index.json'] }],
});

beforeEach(() => {
  videoModels = [{ id: 'ltx', runtime: 'ltx2' }, H3_MLX];
  runtimeReady = true;
  cacheState = { cached: true };
  cachedFiles = ['/cache/a.safetensors'];
  enqueued.length = 0;
  queueJobs = new Map();
});

describe('resolveLocalVideoModel', () => {
  it('picks the H3 row out of the platform bucket, ignoring other runtimes', () => {
    expect(resolveLocalVideoModel()?.id).toBe('minimax_h3_8bit');
  });

  it('finds the CUDA row on a bucket that ships that one instead', () => {
    videoModels = [{ id: 'minimax_h3_cuda', runtime: 'minimax_h3_cuda' }];
    expect(resolveLocalVideoModel()?.id).toBe('minimax_h3_cuda');
  });

  it('is null when this platform has no H3 build at all', () => {
    videoModels = [{ id: 'ltx', runtime: 'ltx2' }];
    expect(resolveLocalVideoModel()).toBeNull();
  });
});

describe('resolveLocalFrameCount', () => {
  it('snaps a requested clip length onto the model grid', () => {
    // 6s * 24fps = 144 frames requested; 141 is the closest legal count.
    expect(resolveLocalFrameCount(H3_MLX, 6)).toBe(141);
    // 5s = 120 → 124 is closer than 107.
    expect(resolveLocalFrameCount(H3_MLX, 5)).toBe(124);
  });

  it('snaps DOWN when the closest legal count is shorter than requested', () => {
    // Rounding up unconditionally would pick 124 and render ~15% longer for
    // footage the packer discards.
    expect(resolveLocalFrameCount(H3_MLX, 4.6)).toBe(107);
  });

  it('clamps a request beyond the grid to its nearest end', () => {
    expect(resolveLocalFrameCount(H3_MLX, 60)).toBe(175);
    expect(resolveLocalFrameCount(H3_MLX, 0.5)).toBe(107);
  });

  it('breaks an exact tie toward the SHORTER (cheaper) render', () => {
    const model = { frameOptions: [100, 200], fpsOptions: [1], defaultFrames: 100 };
    expect(resolveLocalFrameCount(model, 150)).toBe(100);
  });

  it('falls back to the row default when no duration is given', () => {
    expect(resolveLocalFrameCount(H3_MLX, undefined)).toBe(124);
    expect(resolveLocalFrameCount(H3_MLX, 0)).toBe(124);
  });

  it('uses defaultFrames when the row declares no grid, and null when it declares neither', () => {
    expect(resolveLocalFrameCount({ defaultFrames: 90 }, 6)).toBe(90);
    expect(resolveLocalFrameCount({}, 6)).toBeNull();
  });
});

describe('pickLocalRenderCanvas', () => {
  it('gives a PORTRAIT anchor a portrait canvas', () => {
    // The whole point: H3's default is 1344x768, and conforming a tall sprite to
    // it center-crops the character's head and feet away before the render.
    expect(pickLocalRenderCanvas(H3_MLX, { width: 512, height: 896 })).toEqual({ width: 768, height: 1344 });
  });

  it('gives a square anchor the square canvas', () => {
    expect(pickLocalRenderCanvas(H3_MLX, { width: 1024, height: 1024 })).toEqual({ width: 768, height: 768 });
  });

  it('gives a wide anchor the widest canvas', () => {
    expect(pickLocalRenderCanvas(H3_MLX, { width: 2100, height: 900 })).toEqual({ width: 1536, height: 672 });
  });

  it('scores aspect error symmetrically, so a 3:4 anchor is not pulled landscape', () => {
    // In LINEAR ratio space 1344/768 (1.75) sits 0.75 from 1.0 while 768/1024
    // (0.75) sits only 0.25 below — a naive difference would still favour the
    // portrait one here, but for 3:4 vs 4:3 the linear metric flips the answer.
    expect(pickLocalRenderCanvas(H3_MLX, { width: 750, height: 1000 })).toEqual({ width: 768, height: 1024 });
    expect(pickLocalRenderCanvas(H3_MLX, { width: 1000, height: 750 })).toEqual({ width: 1024, height: 768 });
  });

  it('falls back to the row default when the anchor could not be measured', () => {
    expect(pickLocalRenderCanvas(H3_MLX, {})).toEqual({ width: 1344, height: 768 });
    expect(pickLocalRenderCanvas(H3_MLX, { width: 0, height: 0 })).toEqual({ width: 1344, height: 768 });
  });

  it('is null for a row that declares neither presets nor a default', () => {
    expect(pickLocalRenderCanvas({}, { width: 10, height: 10 })).toBeNull();
  });
});

describe('localRenderFps', () => {
  it('reads the row, and falls back to H3 24 when it declares none', () => {
    expect(localRenderFps(H3_MLX)).toBe(24);
    expect(localRenderFps({ fpsOptions: [30] })).toBe(30);
    expect(localRenderFps({})).toBe(24);
  });
});

describe('resolveAnimationProvider', () => {
  it('defaults to grok so an older client renders exactly where it used to', () => {
    expect(resolveAnimationProvider(undefined)).toBe('grok');
    expect(resolveAnimationProvider(null)).toBe('grok');
    expect(resolveAnimationProvider('')).toBe('grok');
  });

  it('passes a known provider through', () => {
    expect(resolveAnimationProvider('local')).toBe('local');
    expect(resolveAnimationProvider('grok')).toBe('grok');
  });

  it('REFUSES an unknown provider rather than silently billing the cloud lane', () => {
    expect(() => resolveAnimationProvider('minimax')).toThrow(/Unknown animation provider/);
    try {
      resolveAnimationProvider('minimax');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('ANIMATION_PROVIDER_INVALID');
    }
  });
});

describe('getLocalAnimationProviderStatus', () => {
  it('is ready, with the model named, when runtime and weights are both present', async () => {
    const status = await getLocalAnimationProviderStatus();
    expect(status).toMatchObject({
      id: 'local', ready: true, reason: null, modelId: 'minimax_h3_8bit', runtime: 'minimax_h3', fps: 24,
    });
  });

  it('reports an unsupported PLATFORM distinctly from an uninstalled runtime', async () => {
    videoModels = [{ id: 'ltx', runtime: 'ltx2' }];
    const status = await getLocalAnimationProviderStatus();
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/no local MiniMax H3 video build/);
    // No model id to offer, so the client cannot mislabel it as installable.
    expect(status.modelId).toBeUndefined();
  });

  it('names the RUNTIME when the venv is missing', async () => {
    runtimeReady = false;
    const status = await getLocalAnimationProviderStatus();
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/MiniMax H3 MLX runtime is not installed/);
  });

  it('names the MODEL when the runtime is installed but the weights are not', async () => {
    cacheState = { cached: false };
    const status = await getLocalAnimationProviderStatus();
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/is not downloaded/);
  });

  it('is not ready when a required dependency repo is only partially cached', async () => {
    // findCachedRepoFiles resolves null when ANY pinned file is missing — the
    // base snapshot being present must not be enough on its own.
    cachedFiles = null;
    expect((await getLocalAnimationProviderStatus()).ready).toBe(false);
  });
});

// The CUDA row is what a Windows or Linux install renders on. It differs from
// the MLX row in exactly two ways this lane can see — a NARROWER frame window,
// and no `requiredWeights` (its download is an explicit file list against the
// base repo) — so both are asserted rather than assumed to fall out.
describe('the CUDA bucket (Windows / Linux installs)', () => {
  const H3_CUDA = {
    id: 'minimax_h3_cuda',
    name: 'MiniMax H3 CUDA int8',
    repo: 'MiniMaxAI/MiniMax-H3',
    revision: 'cuda-rev',
    runtime: 'minimax_h3_cuda',
    defaultFrames: 124,
    // The diffusers integration refuses 107 (under its 5s floor) and anything
    // past 345, so the same 6s request must land inside a different window.
    frameOptions: [124, 141, 158, 175],
    fpsOptions: [24],
    defaultWidth: 1344,
    defaultHeight: 768,
    resolutionOptions: [{ w: 1344, h: 768 }, { w: 768, h: 1024 }],
  };

  beforeEach(() => {
    videoModels = [H3_CUDA];
  });

  it('is ready without any requiredWeights to resolve', async () => {
    // findCachedRepoFiles is never consulted for this row; a stubbed-null result
    // must not drag it to unready the way it does for the MLX row.
    cachedFiles = null;
    const status = await getLocalAnimationProviderStatus();
    expect(status).toMatchObject({ ready: true, modelId: 'minimax_h3_cuda', runtime: 'minimax_h3_cuda' });
  });

  it('honours its own narrower frame window rather than the MLX grid', async () => {
    const plan = await planLocalAnimationRender({ durationSeconds: 6 });
    expect(plan.numFrames).toBe(141);
    // 4.5s is legal on MLX (107) but below this row's floor.
    expect(resolveLocalFrameCount(H3_CUDA, 4.5)).toBe(124);
  });

  it('names its own runtime in the not-installed reason', async () => {
    runtimeReady = false;
    const status = await getLocalAnimationProviderStatus();
    // No BYOV_RUNTIME_INFO label is stubbed for this runtime, so the id itself
    // is the fallback — an unlabeled runtime must still name something.
    expect(status.reason).toContain('minimax_h3_cuda');
  });
});

describe('listAnimationProviders', () => {
  it('offers grok unconditionally alongside the probed local lane', async () => {
    const providers = await listAnimationProviders();
    expect(providers.map((p) => p.id)).toEqual(['grok', 'local']);
    expect(providers[0]).toMatchObject({ ready: true });
    expect(providers[1]).toMatchObject({ ready: true });
  });

  it('still lists grok when the local lane is unusable', async () => {
    runtimeReady = false;
    const providers = await listAnimationProviders();
    expect(providers[0].ready).toBe(true);
    expect(providers[1].ready).toBe(false);
  });
});

describe('planLocalAnimationRender', () => {
  it('resolves the model and frame count for a ready install', async () => {
    const plan = await planLocalAnimationRender({ durationSeconds: 6 });
    expect(plan.model.id).toBe('minimax_h3_8bit');
    expect(plan.numFrames).toBe(141);
    expect(plan.fps).toBe(24);
    expect(plan.chooseCanvas({ width: 512, height: 896 })).toEqual({ width: 768, height: 1344 });
  });

  it('409s with the readiness reason instead of queueing an impossible render', async () => {
    runtimeReady = false;
    await expect(planLocalAnimationRender({ durationSeconds: 6 })).rejects.toMatchObject({
      status: 409,
      code: 'LOCAL_VIDEO_PROVIDER_NOT_READY',
    });
  });
});

describe('localRenderManifest', () => {
  it('stamps the lane, model, runtime, and resolved geometry', () => {
    const plan = { model: H3_MLX, numFrames: 141, fps: 24 };
    expect(localRenderManifest(plan, { width: 768, height: 1344 })).toEqual({
      provider: LOCAL_VIDEO_PROVIDER_ID,
      videoModelId: 'minimax_h3_8bit',
      videoRuntime: 'minimax_h3',
      renderFrames: 141,
      renderFps: 24,
      renderSeconds: 5.88,
      renderWidth: 768,
      renderHeight: 1344,
    });
  });

  it('omits the canvas keys entirely when none was chosen', () => {
    const manifest = localRenderManifest({ model: H3_MLX, numFrames: 124, fps: 24 }, null);
    expect(manifest).not.toHaveProperty('renderWidth');
    expect(manifest).not.toHaveProperty('renderHeight');
  });
});

describe('enqueueLocalAnimationRender', () => {
  const enqueueWalk = () => enqueueLocalAnimationRender({
    plan: { model: H3_MLX, numFrames: 141, fps: 24 },
    canvas: { width: 768, height: 1344 },
    prompt: 'walk east',
    inputAbs: '/in.png',
    recordId: 'hero',
    runId: 'walk-east-abc12345',
    track: 'walk',
    direction: 'east',
  });

  it('queues an image-conditioned, hidden render at the planned geometry', async () => {
    expect(await enqueueWalk()).toBe('job-1');
    expect(enqueued[0]).toMatchObject({ kind: 'video', owner: 'sprites' });
    expect(enqueued[0].params).toMatchObject({
      modelId: 'minimax_h3_8bit',
      prompt: 'walk east',
      mode: 'image',
      sourceImagePath: '/in.png',
      width: 768,
      height: 1344,
      numFrames: 141,
      fps: 24,
      // The clip is a pipeline intermediate, not a video the user asked to keep.
      hidden: true,
    });
  });

  it('tags the job so the completion hook can file it with no in-memory state', async () => {
    await enqueueWalk();
    expect(enqueued[0].params.spriteAnimation).toEqual({
      recordId: 'hero', runId: 'walk-east-abc12345', track: 'walk', direction: 'east',
    });
  });

  it('also carries the shipped spriteWalk tag the client rehydrate keys off', async () => {
    // owner 'sprites' + params.spriteWalk.direction is what
    // useSpritePendingRenders reads, so a browser reload mid-render still shows
    // the direction in flight instead of re-enabling its Generate button.
    await enqueueWalk();
    expect(enqueued[0].params.spriteWalk).toEqual({ recordId: 'hero', direction: 'east' });
  });

  it('leaves spriteWalk OFF a non-walk track, whose cards do not use that map', () => {
    expect(spriteAnimationJobTag({
      recordId: 'hero', runId: 'scanner-east-abc', track: 'scanner', direction: 'east',
    })).toEqual({
      spriteAnimation: { recordId: 'hero', runId: 'scanner-east-abc', track: 'scanner', direction: 'east' },
    });
  });
});

describe('collectLocalAnimationClip', () => {
  const videosDir = join(TEST_ROOT, 'videos');

  it('stages the rendered clip where the postprocess reads it', async () => {
    await mkdir(videosDir, { recursive: true });
    await writeFile(join(videosDir, 'job-ok.mp4'), 'clip-bytes');
    const dest = join(TEST_ROOT, 'run', 'source-video.mp4');
    await mkdir(join(TEST_ROOT, 'run'), { recursive: true });
    await expect(collectLocalAnimationClip({ jobId: 'job-ok', videoAbs: dest, label: 'walk east' }))
      .resolves.toBe(true);
    expect(await readFile(dest, 'utf8')).toBe('clip-bytes');
  });

  it('reports false — never throws — when the render wrote no MP4', async () => {
    const dest = join(TEST_ROOT, 'run2', 'source-video.mp4');
    await mkdir(join(TEST_ROOT, 'run2'), { recursive: true });
    await expect(collectLocalAnimationClip({ jobId: 'job-empty', videoAbs: dest, label: 'walk east' }))
      .resolves.toBe(false);
    await expect(readFile(dest, 'utf8')).rejects.toThrow();
  });

  it('reports false — never throws — when the COPY itself fails', async () => {
    // A throw here would skip the caller's attach, and the attach is the only
    // thing that moves a run out of 'rendering'. On the track lane (no staleness
    // normalization) that wedges the facing behind TRACK_RENDER_IN_PROGRESS
    // forever.
    await mkdir(videosDir, { recursive: true });
    await writeFile(join(videosDir, 'job-nodir.mp4'), 'clip-bytes');
    const dest = join(TEST_ROOT, 'no-such-dir', 'source-video.mp4');
    await expect(collectLocalAnimationClip({ jobId: 'job-nodir', videoAbs: dest, label: 'walk east' }))
      .resolves.toBe(false);
  });
});

describe('normalizeStaleAnimationRun — a run stranded mid-PACKAGING', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const packing = (overrides = {}) => ({
    status: 'postprocessing',
    createdAt: ago(60_000),
    postprocessingStartedAt: ago(60_000),
    ...overrides,
  });

  it('leaves a run that is genuinely still packaging alone', () => {
    const run = packing({ postprocessingStartedAt: ago(2 * 60_000) });
    expect(normalizeStaleAnimationRun(run, 'boom')).toBe(run);
  });

  it('leaves a LOCAL run alone that packed just now after rendering for HOURS', () => {
    // The regression this window is easiest to get wrong: anchoring it on
    // `createdAt` reports every healthy local run as interrupted the instant it
    // starts packing — and, because the in-flight guards read the normalized
    // status, releases them and invites a second multi-hour render for a facing
    // that already has a good candidate.
    const run = packing({
      provider: LOCAL_VIDEO_PROVIDER_ID,
      jobId: 'j',
      createdAt: ago(3 * 60 * 60_000),
      postprocessingStartedAt: ago(30_000),
    });
    expect(normalizeStaleAnimationRun(run, 'boom')).toBe(run);
  });

  it('errors a run still packaging long after packaging began, on EITHER lane', () => {
    // Packaging is bounded local CPU work (decode, align, despill, pack). Still
    // in it half an hour later means the process doing it died — and both
    // in-flight guards count `postprocessing` as busy, so without this the
    // facing is permanently unrenderable.
    for (const provider of ['grok-tui', LOCAL_VIDEO_PROVIDER_ID]) {
      const normalized = normalizeStaleAnimationRun(
        packing({ provider, postprocessingStartedAt: ago(40 * 60_000) }), 'boom',
      );
      expect(normalized.status).toBe('error');
      expect(normalized.postprocessError).toBe('boom');
    }
  });

  it('falls back to createdAt for a record written before the field existed', () => {
    // Which is what such a record was already measured against, so this changes
    // nothing for it either way.
    const legacy = { status: 'postprocessing', createdAt: ago(40 * 60_000) };
    expect(normalizeStaleAnimationRun(legacy, 'boom').status).toBe('error');
    const fresh = { status: 'postprocessing', createdAt: ago(60_000) };
    expect(normalizeStaleAnimationRun(fresh, 'boom')).toBe(fresh);
  });

  it('never touches a run that already reached a terminal state', () => {
    for (const status of ['candidate', 'error', 'approved']) {
      const run = { status, createdAt: ago(10 * 24 * 60 * 60_000) };
      expect(normalizeStaleAnimationRun(run, 'boom')).toBe(run);
    }
  });
});

describe('localRunLiveness', () => {
  it('reports a queued or running job as live', () => {
    queueJobs.set('j', { id: 'j', status: 'running' });
    expect(localRunLiveness({ jobId: 'j' })).toBe('live');
    queueJobs.set('j', { id: 'j', status: 'queued' });
    expect(localRunLiveness({ jobId: 'j' })).toBe('live');
  });

  it('reports a failed or canceled job as DEAD', () => {
    for (const status of ['failed', 'canceled']) {
      queueJobs.set('j', { id: 'j', status });
      expect(localRunLiveness({ jobId: 'j' })).toBe('dead');
    }
  });

  it('reports a COMPLETED job as settling, not dead', () => {
    // The attach spends a second or two copying and hashing a 20-80 MB clip
    // after the job completes. Calling that window dead would report a
    // SUCCESSFUL render as interrupted — and unblock the in-flight guard, so a
    // poll landing there could start a second multi-hour render.
    queueJobs.set('j', { id: 'j', status: 'completed' });
    expect(localRunLiveness({ jobId: 'j' })).toBe('settling');
  });

  it('reports UNKNOWN — not dead — for a job the queue has forgotten', () => {
    // Collapsing this into 'dead' would flip a live run to error the moment its
    // job aged out of the archive.
    expect(localRunLiveness({ jobId: 'gone' })).toBe('unknown');
    expect(localRunLiveness({})).toBe('unknown');
    expect(localRunLiveness(null)).toBe('unknown');
  });
});

describe('isLocalProviderRun', () => {
  it('distinguishes the two lanes by the run record alone', () => {
    expect(isLocalProviderRun({ provider: LOCAL_VIDEO_PROVIDER_ID })).toBe(true);
    expect(isLocalProviderRun({ provider: 'grok-tui' })).toBe(false);
    expect(isLocalProviderRun({})).toBe(false);
  });
});
