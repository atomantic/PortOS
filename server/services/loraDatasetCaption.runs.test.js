import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Run-lifecycle contract for caption batches: one run per dataset, discoverable
// by dataset id, cancellable by run id, and never double-booking an image.
// Dependencies are doubled at the module edge so the REAL createSseRunner-backed
// service drives the lifecycle (no provider, disk or settings access).

const state = vi.hoisted(() => ({ dataset: null, vision: [], capabilities: null, lmstudioModels: [], endpoint: 'http://localhost:11434/v1' }));

vi.mock('./loraDatasets.js', () => ({
  getDataset: vi.fn(async () => structuredClone(state.dataset)),
  datasetImagePath: (id, file) => `/nonexistent/${id}/${file}`,
  updateDataset: vi.fn(async (_id, mutate) => {
    state.dataset = mutate(state.dataset);
    return state.dataset;
  }),
}));
vi.mock('fs/promises', () => ({ readFile: vi.fn(async () => Buffer.from('png')) }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(async (id) => ({ id, type: 'api', endpoint: state.endpoint })),
}));
vi.mock('./ollamaManager.js', () => ({
  getBaseUrl: () => 'http://localhost:11434',
  getModelCapabilities: vi.fn(async () => state.capabilities),
}));
vi.mock('./lmStudioManager.js', () => ({
  getBaseUrl: () => 'http://localhost:1234',
  getAvailableModels: vi.fn(async () => state.lmstudioModels),
}));
vi.mock('./loraDatasetSubject.js', () => ({
  loadDatasetSubject: vi.fn(async () => { throw new Error('no subject'); }),
  extractSubjectSignaturePhrases: vi.fn(() => []),
}));
// Each vision call is a deferred the test resolves by hand.
vi.mock('./visionTest.js', () => ({
  describeImageDataUrlDetailed: vi.fn(() => new Promise((resolve, reject) => {
    state.vision.push({ resolve, reject });
  })),
}));

const { startCaptionRun, cancelCaptionRun, getActiveCaptionRun, attachCaptionSseClient, withCaptionVisionLock } = await import('./loraDatasetCaption.js');
const { describeImageDataUrlDetailed } = await import('./visionTest.js');

const REPLY = { text: 'standing, full body', finishReason: 'stop', usage: null, reasoning: '' };
const MODEL = { providerId: 'lmstudio', model: 'qwen2.5-vl-7b' };
const flush = () => new Promise((r) => setImmediate(r));
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await flush(); };

const makeDataset = (n = 3) => ({
  id: 'ds-1',
  triggerWord: 'example_trigger',
  images: Array.from({ length: n }, (_, i) => ({ id: `img-${i}`, status: 'ready', file: `${i}.png`, caption: '' })),
});

// Minimal SSE response double: records frames written to it.
const fakeRes = () => {
  const frames = [];
  return {
    frames,
    writeHead: vi.fn(),
    write: (msg) => frames.push(JSON.parse(msg.replace(/^data: /, ''))),
    end: vi.fn(),
    req: { on: vi.fn() },
  };
};

describe('caption run lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    state.dataset = makeDataset();
    state.vision = [];
    state.capabilities = null;
    state.lmstudioModels = [];
    state.endpoint = 'http://localhost:11434/v1';
    vi.clearAllMocks();
  });
  afterEach(async () => {
    // Drain any run left active by a failing assertion so cases stay isolated.
    const live = getActiveCaptionRun('ds-1');
    if (live) {
      cancelCaptionRun('ds-1', live.runId);
      state.vision.forEach((v) => v.resolve(REPLY));
      await settle();
    }
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('rejects a text-only heuristic match before creating a run or sending images', async () => {
    state.capabilities = ['completion'];
    await expect(startCaptionRun('ds-1', { providerId: 'ollama', model: 'gemma3:1b' }))
      .rejects.toMatchObject({ status: 409, code: 'LORA_CAPTION_NOT_VISION' });
    expect(getActiveCaptionRun('ds-1')).toBeNull();
    expect(describeImageDataUrlDetailed).not.toHaveBeenCalled();
  });

  it('rejects a text-only LM Studio model despite its vision-family name', async () => {
    state.endpoint = 'http://127.0.0.1:1234/v1';
    state.lmstudioModels = [{ id: 'gemma3:1b', type: 'llm' }];
    await expect(startCaptionRun('ds-1', { providerId: 'lmstudio', model: 'gemma3:1b' }))
      .rejects.toMatchObject({ status: 409, code: 'LORA_CAPTION_NOT_VISION' });
    expect(describeImageDataUrlDetailed).not.toHaveBeenCalled();
  });

  it('accepts an opaque LM Studio VLM without switching its provider or model', async () => {
    state.endpoint = 'http://localhost:1234/v1';
    state.lmstudioModels = [{ id: 'opaque-id', type: 'vlm' }];
    await startCaptionRun('ds-1', { providerId: 'lmstudio', model: 'opaque-id' });
    await settle();
    expect(describeImageDataUrlDetailed).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'lmstudio', model: 'opaque-id' }));
  });

  it.each([
    { model: 'opaque-id', capabilities: ['completion', 'vision'] },
    { model: 'gemma3:4b', capabilities: [] },
    { model: 'gemma3:4b', capabilities: null },
    { model: 'gemma3:4b', capabilities: ['completion'], endpoint: 'http://example.invalid:11434/v1' },
    { model: 'gemma3:4b', capabilities: ['completion'], endpoint: 'http://localhost:11435/v1' },
  ])('keeps the explicit caption selection with compatible or unknown support: %j', async ({ model, capabilities, endpoint }) => {
    state.capabilities = capabilities;
    if (endpoint) state.endpoint = endpoint;
    await startCaptionRun('ds-1', { providerId: 'ollama', model });
    await settle();
    expect(getActiveCaptionRun('ds-1')).toMatchObject({ model });
    expect(describeImageDataUrlDetailed).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'ollama', model }));
    const { getModelCapabilities } = await import('./ollamaManager.js');
    if (endpoint) expect(getModelCapabilities).not.toHaveBeenCalled();
  });

  it('exposes the active run by dataset id and adopts an identical second start', async () => {
    const first = await startCaptionRun('ds-1', MODEL);
    const second = await startCaptionRun('ds-1', MODEL);
    expect(second).toMatchObject({ runId: first.runId, alreadyRunning: true });
    expect(second.conflict).toBeUndefined();
    await settle();
    expect(getActiveCaptionRun('ds-1')).toMatchObject({
      runId: first.runId, datasetId: 'ds-1', status: 'running', total: 3, done: 0, model: MODEL.model,
    });
    // One coordinator → one in-flight vision call for the first target only.
    expect(describeImageDataUrlDetailed).toHaveBeenCalledTimes(1);
  });

  it('reports different work as a conflict carrying the holder id, without a second run', async () => {
    const first = await startCaptionRun('ds-1', MODEL);
    const single = await startCaptionRun('ds-1', { ...MODEL, imageIds: ['img-1'], overwrite: true });
    expect(single).toMatchObject({ runId: first.runId, alreadyRunning: true, conflict: true, total: 3 });
    await settle();
    expect(describeImageDataUrlDetailed).toHaveBeenCalledTimes(1);
  });

  it('keeps run identity out of reach of a different run id (attach and cancel)', async () => {
    const run = await startCaptionRun('ds-1', MODEL);
    expect(attachCaptionSseClient('ds-1', 'stale-run-id', fakeRes())).toBe(false);
    expect(attachCaptionSseClient('other-dataset', run.runId, fakeRes())).toBe(false);
    expect(() => cancelCaptionRun('ds-1', 'stale-run-id')).toThrow(/not found/i);
    expect(() => cancelCaptionRun('other-dataset', run.runId)).toThrow(/not found/i);
    expect(getActiveCaptionRun('ds-1').status).toBe('running');
    expect(attachCaptionSseClient('ds-1', run.runId, fakeRes())).toBe(true);
  });

  it('cancel during an active call discards its late result and launches no next image', async () => {
    const run = await startCaptionRun('ds-1', MODEL);
    await settle();
    const res = fakeRes();
    attachCaptionSseClient('ds-1', run.runId, res);
    expect(cancelCaptionRun('ds-1', run.runId)).toMatchObject({ canceled: true, run: { status: 'canceling' } });
    await settle();
    // Terminal canceled frame is emitted without waiting for the in-flight call…
    expect(res.frames.at(-1)).toMatchObject({ type: 'canceled', done: 0, total: 3, settling: true });
    // …and the late result is discarded: nothing persisted, no next image.
    state.vision[0].resolve(REPLY);
    await settle();
    expect(state.dataset.images.every((i) => !i.caption)).toBe(true);
    expect(describeImageDataUrlDetailed).toHaveBeenCalledTimes(1);
    expect(getActiveCaptionRun('ds-1')).toBeNull();
  });

  it('cancel while queued behind another run never invokes the provider', async () => {
    // Another dataset's vision call holds the shared mutex.
    let releaseOther;
    const other = withCaptionVisionLock(() => new Promise((r) => { releaseOther = r; }));
    const run = await startCaptionRun('ds-1', MODEL);
    await settle();
    expect(describeImageDataUrlDetailed).not.toHaveBeenCalled();
    const res = fakeRes();
    attachCaptionSseClient('ds-1', run.runId, res);
    cancelCaptionRun('ds-1', run.runId);
    await settle();
    expect(res.frames.at(-1)).toMatchObject({ type: 'canceled', settling: false });
    releaseOther();
    await other;
    await settle();
    expect(describeImageDataUrlDetailed).not.toHaveBeenCalled();
  });

  it('completes, keeps finished captions, and a later start retries only unfinished images', async () => {
    const run = await startCaptionRun('ds-1', MODEL);
    await settle();
    state.vision[0].resolve(REPLY); // img-0 captioned
    await settle();
    cancelCaptionRun('ds-1', run.runId);
    await settle();
    expect(state.dataset.images[0].caption).toMatch(/standing, full body/);
    expect(state.dataset.images.slice(1).every((i) => !i.caption)).toBe(true);
    // Settled → an immediate restart is a NEW run over just the two unfinished images.
    const retry = await startCaptionRun('ds-1', MODEL);
    expect(retry.alreadyRunning).toBe(false);
    expect(retry.runId).not.toBe(run.runId);
    expect(retry.total).toBe(2);
  });

  it('replays the terminal frame to a late attach and reports per-image errors', async () => {
    state.dataset = makeDataset(1);
    const run = await startCaptionRun('ds-1', MODEL);
    await settle();
    state.vision[0].reject(new Error('refused'));
    await settle();
    const res = fakeRes();
    expect(attachCaptionSseClient('ds-1', run.runId, res)).toBe(true);
    expect(res.frames).toEqual([expect.objectContaining({ type: 'error', runId: run.runId })]);
    expect(getActiveCaptionRun('ds-1')).toBeNull();
  });
});
