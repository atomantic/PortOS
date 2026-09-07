import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

// The lifecycle really creates and removes files, so PATHS must point at a temp
// tree — the install's data/ is the developer's live gallery.
vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-upscale-job-') }));
afterAll(cleanupTempDataRoots);

const state = vi.hoisted(() => ({
  history: [],
  plan: null,
  adapter: null,
  enqueued: [],
  padResult: { ok: true },
  finalizeResult: { ok: true },
  measured: { width: 1536, height: 1024, fps: 24, frameCount: 121 },
  duration: 5.04,
  child: null,
  // Whether the fake runner writes the file it was told to produce.
  writesOutput: true,
  buildArgsCalls: [],
}));

vi.mock('./upscaleVideo.js', () => ({
  planUpscaleHistoryItem: vi.fn(async () => state.plan),
}));

vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn((job) => {
    state.enqueued.push(job);
    return { jobId: 'queued-job', position: 1, status: 'queued' };
  }),
}));

vi.mock('./history.js', () => ({
  getHistoryItem: vi.fn(async (id) => state.history.find((h) => h.id === id) || null),
  loadHistory: vi.fn(async () => state.history),
  mutateVideoHistory: vi.fn(async (mutator) => mutator(state.history)),
}));

vi.mock('../../lib/icLoraWeights.js', () => ({
  resolveIcLoraWeightByKey: vi.fn(async () => state.adapter),
}));

vi.mock('../../lib/ffmpeg.js', () => ({
  safeUnder: vi.fn((base, name) => (name ? join(base, name) : null)),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  probeVideoStreamInfo: vi.fn(async () => state.measured),
  probeVideoDuration: vi.fn(async () => state.duration),
}));

vi.mock('./upscaleFfmpeg.js', () => ({
  padSourceForUpscale: vi.fn(async (_src, out) => {
    if (state.padResult.ok) writeFileSync(out, 'aligned');
    return state.padResult;
  }),
  finalizeUpscaleOutput: vi.fn(async (_rendered, out) => {
    // A real ffmpeg run leaves a partial file behind on failure, which is
    // exactly what the cleanup contract has to remove.
    writeFileSync(out, 'final');
    return state.finalizeResult;
  }),
}));

vi.mock('./renderArgs.js', () => ({
  buildArgs: vi.fn((args) => {
    state.buildArgsCalls.push(args);
    return { bin: '/fixture/python3', args: ['/fixture/upscale.py'] };
  }),
}));

vi.mock('../../lib/detachedSpawn.js', () => ({
  spawnDetached: vi.fn(async () => state.child),
}));

vi.mock('../hfToken.js', () => ({ hfChildEnv: vi.fn(async () => ({})) }));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn((proc) => proc.kill('SIGTERM')) }));

const { enqueueLtxUpscale, runVideoUpscale, cancel } = await import('./upscaleJob.js');
const { enqueueJob } = await import('../mediaJobQueue/index.js');
const { mutateVideoHistory } = await import('./history.js');
const { padSourceForUpscale, finalizeUpscaleOutput } = await import('./upscaleFfmpeg.js');
const { videoGenEvents } = await import('./events.js');
const { PATHS } = await import('../../lib/fileUtils.js');
const { LTX_UPSCALE_JOB_KIND, LTX_PROVENANCE_FIELDS } = await import('./upscalePlan.js');

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = 'job-11112222-3333';
const SOURCE_FILE = `${SOURCE_ID}.mp4`;

// A source already on the 32px grid with a conforming frame count: no padding,
// so the plan is a no-op and the render reads the original clip in place.
const conformingPlan = () => ({
  id: SOURCE_ID,
  method: 'ltx',
  scale: 2,
  alreadyUpscaled: false,
  source: { width: 768, height: 512, fps: 24, frameCount: 121, durationSeconds: 5.04, hasAudio: true },
  target: { width: 1536, height: 1024, frameCount: 121 },
  alignment: {
    padWidth: 0, padHeight: 0, padFrames: 0, trimFrames: 0,
    paddedSource: { width: 768, height: 512, frameCount: 121 },
    conforming: true,
  },
  runtime: { id: 'ltx25', label: 'LTX-2.5 MLX', supported: true, installed: true, reason: null },
  adapter: { key: 'pixel-upscale', label: 'Pixel Spatial Upscaler', cached: true },
});

const sourceRow = (extra = {}) => ({
  id: SOURCE_ID, filename: SOURCE_FILE, prompt: 'a lighthouse',
  modelId: 'ltx2_unified', width: 768, height: 512, numFrames: 121, fps: 24, seed: 7,
  renderMs: 90_000, renderStartedAt: '2026-01-01T00:00:00.000Z', ...extra,
});

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { child.emit('close', null, 'SIGTERM'); return true; });
  return child;
};

const jobParams = (overrides = {}) => ({
  jobId: JOB_ID,
  historyId: SOURCE_ID,
  sourceFilename: SOURCE_FILE,
  runtime: 'ltx25',
  adapterPath: '/cache/pixel-upscale.safetensors',
  adapterKey: 'pixel-upscale',
  icMinReferences: 1,
  icMaxReferences: 1,
  seed: 4242,
  source: conformingPlan().source,
  alignment: conformingPlan().alignment,
  target: conformingPlan().target,
  ...overrides,
});

const renderOutputPath = join(tmpdir(), `portos-upscale-out-${JOB_ID}.mp4`);
const alignedSourcePath = join(tmpdir(), `portos-upscale-src-${JOB_ID}.mp4`);
const sourcePath = () => join(PATHS.videos, SOURCE_FILE);

// Drive the fake runner: it writes the file the real one would, then exits.
const finishChild = (code = 0, signal = null) => {
  if (state.writesOutput && code === 0) writeFileSync(renderOutputPath, 'rendered');
  state.child.emit('close', code, signal);
};

// Run the job and settle the child once the spawn has happened.
const runWith = async (drive, params = {}) => {
  const run = runVideoUpscale(jobParams(params));
  await vi.waitFor(() => expect(state.child.listenerCount('close')).toBeGreaterThan(0));
  drive();
  return run;
};

beforeEach(() => {
  mkdirSync(PATHS.videos, { recursive: true });
  writeFileSync(sourcePath(), 'source-bytes');
  state.history = [sourceRow()];
  state.plan = conformingPlan();
  state.adapter = { path: '/cache/pixel-upscale.safetensors', cached: true, spec: { minReferences: 1, maxReferences: 1 } };
  state.enqueued = [];
  state.padResult = { ok: true };
  state.finalizeResult = { ok: true };
  state.measured = { width: 1536, height: 1024, fps: 24, frameCount: 121 };
  state.writesOutput = true;
  state.buildArgsCalls = [];
  state.child = makeChild();
  vi.clearAllMocks();
});

describe('enqueueLtxUpscale', () => {
  it('queues the generative pass as its own job kind with the resolved render inputs', async () => {
    const result = await enqueueLtxUpscale(SOURCE_ID);
    expect(result).toEqual({ jobId: 'queued-job', position: 1, status: 'queued' });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const [job] = state.enqueued;
    expect(job.kind).toBe(LTX_UPSCALE_JOB_KIND);
    expect(job.params).toEqual({
      historyId: SOURCE_ID,
      sourceFilename: SOURCE_FILE,
      method: 'ltx',
      runtime: 'ltx25',
      adapterKey: 'pixel-upscale',
      adapterPath: '/cache/pixel-upscale.safetensors',
      icMinReferences: 1,
      icMaxReferences: 1,
      seed: expect.any(Number),
      source: conformingPlan().source,
      alignment: conformingPlan().alignment,
      target: conformingPlan().target,
      prompt: 'a lighthouse (2×)',
      width: 1536,
      height: 1024,
      numFrames: 121,
      fps: 24,
    });
  });

  it('records a seed so the pass is reproducible', async () => {
    await enqueueLtxUpscale(SOURCE_ID);
    const { seed } = state.enqueued[0].params;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(2 ** 32 - 1);
  });

  // Every refusal below has to happen BEFORE a GPU is committed — that is the
  // whole reason the plan endpoint exists.
  it('refuses a source that cannot be aligned without losing duration', async () => {
    state.plan.alignment.trimFrames = 3;
    await expect(enqueueLtxUpscale(SOURCE_ID))
      .rejects.toMatchObject({ status: 400, code: 'UPSCALE_SOURCE_UNALIGNABLE' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses a source whose geometry could not be measured rather than guessing', async () => {
    state.plan.alignment.padFrames = null;
    await expect(enqueueLtxUpscale(SOURCE_ID))
      .rejects.toMatchObject({ status: 400, code: 'UPSCALE_SOURCE_UNALIGNABLE' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses a source whose frame rate could not be measured', async () => {
    state.plan.source.fps = null;
    await expect(enqueueLtxUpscale(SOURCE_ID))
      .rejects.toMatchObject({ status: 400, code: 'UPSCALE_SOURCE_UNALIGNABLE' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses when this machine has no installed generative backend', async () => {
    state.plan.runtime = { id: 'ltx25', label: 'LTX-2.5 MLX', supported: true, installed: false, reason: 'The LTX-2.5 MLX runtime is not installed on this machine.' };
    await expect(enqueueLtxUpscale(SOURCE_ID))
      .rejects.toMatchObject({ status: 501, code: 'UNSUPPORTED_RUNTIME' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  // #6508: the adapter is `requiresPreDownload`, so an un-cached weight has no
  // repo-id fallback — queueing would strand the render on a 401 or a 708 GB pull.
  it('refuses when the upscale adapter is not downloaded', async () => {
    state.adapter = { path: null, cached: false, spec: { minReferences: 1, maxReferences: 1 } };
    await expect(enqueueLtxUpscale(SOURCE_ID))
      .rejects.toMatchObject({ status: 400, code: 'IC_LORA_WEIGHT_UNRESOLVED' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('keeps the already-upscaled guard, matching the inline path', async () => {
    state.plan.alreadyUpscaled = true;
    await expect(enqueueLtxUpscale(SOURCE_ID))
      .rejects.toMatchObject({ status: 400, code: 'ALREADY_UPSCALED' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('local-only (#6511 item 7)', () => {
  // The privacy rule in AGENTS.md is enforced structurally: the federation
  // layer's kind maps are closed lists, so a source video can only cross to a
  // peer if someone adds this kind to one of them.
  it('is absent from every federation kind map', async () => {
    const { REMOTE_MEDIA_MODULES, isRemoteMediaJob } = await import('../mediaJobQueue/remoteMediaJob.js');
    const { ROUTABLE_MEDIA_KINDS } = await import('../federatedMedia/routingPolicy.js');
    const { KNOWN_MEDIA_KINDS } = await import('../../lib/federatedMediaWire.js');
    expect(Object.keys(REMOTE_MEDIA_MODULES)).not.toContain(LTX_UPSCALE_JOB_KIND);
    expect(ROUTABLE_MEDIA_KINDS).not.toContain(LTX_UPSCALE_JOB_KIND);
    expect(KNOWN_MEDIA_KINDS).not.toContain(LTX_UPSCALE_JOB_KIND);
    // Even a hand-planted marker cannot make it routed — the predicate gates on
    // the kind map, not on the marker alone.
    expect(isRemoteMediaJob({ kind: LTX_UPSCALE_JOB_KIND, params: { remoteMedia: {} } })).toBe(false);
  });
});

describe('runVideoUpscale — success', () => {
  it('writes a new history row carrying the full provenance contract', async () => {
    const completed = [];
    videoGenEvents.on('completed', (e) => completed.push(e));
    const entry = await runWith(() => finishChild(0));
    videoGenEvents.removeAllListeners('completed');

    for (const field of LTX_PROVENANCE_FIELDS) expect(entry[field]).toBeDefined();
    expect(entry).toMatchObject({
      upscaledFrom: SOURCE_ID,
      upscaleMethod: 'ltx',
      upscaleRuntime: 'ltx25',
      upscaleAdapter: 'pixel-upscale',
      // MEASURED off the deliverable, not assumed from the plan.
      width: 1536,
      height: 1024,
      fps: 24,
      numFrames: 121,
      duration: 5.04,
      seed: 4242,
      prompt: 'a lighthouse (2×)',
      hidden: false,
    });
    expect(entry.renderMs).toBeGreaterThanOrEqual(0);
    // The source render's timing must not ride along on a row that only paid
    // for the upscale.
    expect(entry.renderStartedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(mutateVideoHistory).toHaveBeenCalledTimes(1);
    expect(state.history[0].id).toBe(entry.id);
    expect(completed).toHaveLength(1);
  });

  it('leaves the source clip and its history row untouched', async () => {
    const entry = await runWith(() => finishChild(0));
    expect(existsSync(sourcePath())).toBe(true);
    const source = state.history.find((h) => h.id === SOURCE_ID);
    expect(source).toEqual(sourceRow());
    expect(entry.filename).not.toBe(SOURCE_FILE);
  });

  it('removes every scratch file it created', async () => {
    await runWith(() => finishChild(0));
    expect(existsSync(renderOutputPath)).toBe(false);
    expect(existsSync(alignedSourcePath)).toBe(false);
  });

  it('reads a conforming source in place instead of writing a padded copy', async () => {
    await runWith(() => finishChild(0));
    expect(padSourceForUpscale).not.toHaveBeenCalled();
    expect(state.buildArgsCalls[0].upscale.sourceVideoPath).toBe(sourcePath());
  });

  // The plan is APPLIED, not approximated: the render sees the padded geometry
  // and the deliverable is cropped back to 2x the SOURCE, so no duration or
  // framing is silently lost.
  it('pads a non-conforming source to exactly the plan and crops back to 2x the source', async () => {
    const alignment = {
      padWidth: 16, padHeight: 0, padFrames: 4, trimFrames: 0,
      paddedSource: { width: 864, height: 512, frameCount: 121 },
      conforming: false,
    };
    await runWith(() => finishChild(0), {
      source: { width: 848, height: 512, fps: 24, frameCount: 117, durationSeconds: 4.875, hasAudio: true },
      alignment,
      target: { width: 1728, height: 1024, frameCount: 121 },
    });
    expect(padSourceForUpscale).toHaveBeenCalledWith(sourcePath(), alignedSourcePath, {
      width: 864, height: 512, padFrames: 4, fps: 24, signal: expect.anything(),
    });
    expect(state.buildArgsCalls[0].upscale).toMatchObject({
      sourceVideoPath: alignedSourcePath, width: 1728, height: 1024, numFrames: 121,
    });
    expect(finalizeUpscaleOutput).toHaveBeenCalledWith(renderOutputPath, expect.any(String), {
      width: 1696, height: 1024, frameCount: 117, audioSourcePath: sourcePath(), signal: expect.anything(),
    });
  });

  // The adapter is a spatial upscaler, so the source's own track is re-muxed
  // at offset zero either way — a silent source takes the identical path and
  // yields a silent deliverable rather than a failure.
  it.each([true, false])('takes the identical path for a source with audio=%s', async (hasAudio) => {
    const entry = await runWith(() => finishChild(0), {
      source: { ...conformingPlan().source, hasAudio },
    });
    expect(entry.upscaleMethod).toBe('ltx');
    expect(finalizeUpscaleOutput).toHaveBeenCalledWith(renderOutputPath, expect.any(String), {
      width: 1536, height: 1024, frameCount: 121, audioSourcePath: sourcePath(), signal: expect.anything(),
    });
  });
});

describe('runVideoUpscale — failure and cancellation leave the source alone', () => {
  const expectSourceIntact = () => {
    expect(existsSync(sourcePath())).toBe(true);
    expect(state.history).toEqual([sourceRow()]);
    expect(mutateVideoHistory).not.toHaveBeenCalled();
  };
  const deliverables = () => state.history.filter((h) => h.upscaledFrom);

  it('reports a non-zero runner exit and orphans no history entry', async () => {
    const failures = [];
    videoGenEvents.on('failed', (e) => failures.push(e));
    state.writesOutput = false;
    await runWith(() => finishChild(3));
    videoGenEvents.removeAllListeners('failed');
    expectSourceIntact();
    expect(deliverables()).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/exit 3/);
  });

  it('fails when the runner exits clean but writes nothing', async () => {
    state.writesOutput = false;
    await runWith(() => finishChild(0));
    expectSourceIntact();
    expect(finalizeUpscaleOutput).not.toHaveBeenCalled();
  });

  it('removes the partial deliverable when the audio mux fails', async () => {
    state.finalizeResult = { ok: false, reason: 'ffmpeg exit 1' };
    const failures = [];
    videoGenEvents.on('failed', (e) => failures.push(e));
    await runWith(() => finishChild(0));
    videoGenEvents.removeAllListeners('failed');
    expectSourceIntact();
    // finalizeUpscaleOutput wrote a partial file; nothing may survive it.
    const written = finalizeUpscaleOutput.mock.calls[0][1];
    expect(existsSync(written)).toBe(false);
    expect(failures[0].error).toMatch(/ffmpeg exit 1/);
  });

  it('fails before spawning when the source cannot be aligned on disk', async () => {
    state.padResult = { ok: false, reason: 'ffmpeg not found' };
    await runVideoUpscale(jobParams({
      alignment: { ...conformingPlan().alignment, padWidth: 16, paddedSource: { width: 784, height: 512, frameCount: 121 }, conforming: false },
    }));
    expectSourceIntact();
    expect(state.buildArgsCalls).toHaveLength(0);
  });

  it('leaves the source and every row untouched when the job is cancelled mid-render', async () => {
    const failures = [];
    videoGenEvents.on('failed', (e) => failures.push(e));
    const run = runVideoUpscale(jobParams());
    await vi.waitFor(() => expect(state.child.listenerCount('close')).toBeGreaterThan(0));
    expect(cancel(JOB_ID)).toBe(true);
    await run;
    videoGenEvents.removeAllListeners('failed');
    expectSourceIntact();
    expect(deliverables()).toHaveLength(0);
    expect(existsSync(renderOutputPath)).toBe(false);
    expect(failures[0].error).toBe('Canceled while running');
  });

  it('reports no cancel handle once the run has settled', async () => {
    await runWith(() => finishChild(0));
    expect(cancel(JOB_ID)).toBe(false);
  });

  it('refuses to re-upscale a source that was already upscaled while queued', async () => {
    state.history = [sourceRow({ upscaledFrom: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1' })];
    await runVideoUpscale(jobParams());
    expect(mutateVideoHistory).not.toHaveBeenCalled();
    expect(state.buildArgsCalls).toHaveLength(0);
  });

  it('refuses when the source row was replaced under the queued job', async () => {
    state.history = [sourceRow({ filename: 'something-else.mp4' })];
    await runVideoUpscale(jobParams());
    expect(mutateVideoHistory).not.toHaveBeenCalled();
    expect(state.buildArgsCalls).toHaveLength(0);
  });
});
