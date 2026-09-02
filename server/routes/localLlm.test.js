import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import localLlmRoutes from './localLlm.js';
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js';
import { listModels, listVisionModels, listToolUseModels, installModel } from '../services/localLlm.js';
import { enrichCatalogWithVariants, applyMeasuredFit } from '../services/huggingFaceCatalog.js';
import { getMeasuredFits } from '../services/localModelAssessmentStore.js';
import { runAssessment } from '../services/localModelAssessments.js';
import { startSweep, getSweepStatus, cancelSweep } from '../services/localModelAssessmentSweep.js';
import { runOpenCodeAgentBenchmark } from '../services/localModelAgentBenchmark.js';
import { getLoadedModels, unloadModel } from '../services/ollamaManager.js';
import { getLoadedModels as getLoadedLmStudioModels, getLastLoadedModelsError as getLmStudioResidencyError } from '../services/lmStudioManager.js';
import { getSettings } from '../services/settings.js';
import { localLlmCompareSchema, localLlmTestSchema } from '../lib/validation.js';
import { errorEvents } from '../lib/errorHandler.js';

const getModelAbuseGuardStatus = vi.fn(async () => ({ ready: false, modelCached: false, runtimeReady: false }));
const installModelAbuseGuard = vi.fn(async () => ({ ok: true, ready: true }));
const cancelModelAbuseGuardInstall = vi.fn();

// asyncHandler emits to errorEvents on every route failure; with `io` set on
// the app it always fires. Swallow it so a validation-rejection test doesn't
// trip Node's "unhandled 'error' event" — assertions go through the response.
errorEvents.on('error', () => {});

vi.mock('../services/localLlm.js', () => ({
  getStatus: vi.fn(),
  listModels: vi.fn(async () => []),
  listVisionModels: vi.fn(async () => []),
  listToolUseModels: vi.fn(async () => []),
  installModel: vi.fn(),
  describeInstallProgress: vi.fn((p) => p?.status || null),
  deleteModel: vi.fn(),
  switchBackend: vi.fn(),
  migrateBackend: vi.fn(),
  installBackend: vi.fn(),
  upgradeBackend: vi.fn(),
  controlOllamaServer: vi.fn(),
}));

vi.mock('../services/modelAbuseGuard.js', () => ({
  getModelAbuseGuardStatus: (...args) => getModelAbuseGuardStatus(...args),
  installModelAbuseGuard: (...args) => installModelAbuseGuard(...args),
  cancelModelAbuseGuardInstall: (...args) => cancelModelAbuseGuardInstall(...args),
}));

vi.mock('../services/localLlmPlayground.js', () => ({
  runLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../services/ollamaManager.js', () => ({
  getLastLoadedModelsError: vi.fn(() => null),
  getLoadedModels: vi.fn(async () => []),
  unloadModel: vi.fn(),
}));

vi.mock('../services/lmStudioManager.js', () => ({
  getLastLoadedModelsError: vi.fn(() => null),
  getLoadedModels: vi.fn(async () => []),
}));

// Mock the HF catalog service so /catalog tests don't hit the network. The no-op
// enrichCatalogWithVariants simulates the offline/failed-enrichment case (it leaves
// the catalog's getCatalog overlay untouched), which is exactly when the route's
// raw-id installed overlay must be correct.
vi.mock('../services/huggingFaceCatalog.js', () => ({
  searchHuggingFaceModels: vi.fn(async () => []),
  enrichCatalogWithVariants: vi.fn(async (catalog) => catalog),
  applyMeasuredFit: vi.fn((models) => models),
}));

// Measured assessments are folded into the catalog fit badge. Disk-only in
// production; mocked here so a catalog listing test never touches the store.
vi.mock('../services/localModelAssessmentStore.js', () => ({
  getMeasuredFits: vi.fn(async () => ({})),
}));

vi.mock('../services/localModelAssessments.js', () => ({
  getAssessmentReport: vi.fn(async () => ({ ranked: [], excluded: [] })),
  runAssessment: vi.fn(async () => ({ verdict: 'fits' })),
  deleteAssessment: vi.fn(async () => ({ deleted: true })),
}));

vi.mock('../services/localModelAssessmentSweep.js', () => ({
  startSweep: vi.fn(async () => ({ status: 'running', total: 3, completed: 0 })),
  getSweepStatus: vi.fn(() => ({ status: 'idle', total: 0, completed: 0, results: [] })),
  cancelSweep: vi.fn(() => ({ status: 'cancelled', total: 3, completed: 1, results: [] })),
}));

vi.mock('../services/localModelAgentBenchmark.js', () => ({
  runOpenCodeAgentBenchmark: vi.fn(async ({ backend, modelId, timeoutMs }) => ({
    backend, modelId, timeoutMs, completed: true, taskCharsPerSecond: 100,
  })),
}));

vi.mock('../services/llamaServerManager.js', () => ({
  getLlamaServerStatus: vi.fn(async () => ({ installed: true, running: false })),
  getLlamaServerUpdateStatus: vi.fn(async () => ({
    version: null,
    latestVersion: null,
    updateAvailable: false,
    canUpgrade: false,
    downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases',
  })),
  startLlamaServer: vi.fn(async () => ({ success: true, pid: 123 })),
  stopLlamaServer: vi.fn(async () => ({ success: true })),
  installLlamaServer: vi.fn(async () => ({ success: true, message: 'installed' })),
  upgradeLlamaServer: vi.fn(async () => ({ success: true, note: 'updated' })),
}));

// The launcher's curated presets (and their weights' on-disk state) ride along
// on the status response so the card can offer a Download button per GGUF.
vi.mock('../services/specDecodeModels.js', () => ({
  getSpecDecodePresetStatus: vi.fn(async () => ([{ id: 'test-preset', label: 'Test', specType: 'draft-dspark', model: null, draftModel: null }])),
  downloadSpecDecodeModel: vi.fn(async () => ({ success: true, path: 'models/base.gguf', file: 'base.gguf' })),
  cancelSpecDecodeModelDownload: vi.fn(() => true),
}));

// /loaded reads getSettings() to honor a user's intentionally-disabled backends,
// so mock it (defaults to no backends disabled; the disabled-case test flips it).
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.set('io', { emit: vi.fn() });
  app.use('/api/local-llm', localLlmRoutes);
  return app;
}

describe('local LLM playground routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /catalog?variants=1 keeps an installed LM Studio recommendation installed (raw-id overlay)', async () => {
    // The route appends LM Studio's quantization to the enrichment installed list,
    // but getCatalog's normalizer can't parse `@quant` — so the overlay must get the
    // RAW ids, or an already-installed model wrongly shows Install. (Enrichment is
    // mocked to a no-op, simulating HF being unreachable.)
    listModels.mockResolvedValue([{ id: 'lmstudio-community/gemma-4-12B-it-GGUF', quantization: 'Q4_K_M' }]);

    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=lmstudio&variants=1');

    expect(res.status).toBe(200);
    expect(enrichCatalogWithVariants).toHaveBeenCalled();
    const entry = res.body.models.find((m) => m.id === 'lmstudio-community/gemma-4-12B-it-GGUF');
    expect(entry).toBeTruthy();
    expect(entry.installed).toBe(true);
  });

  it('GET /catalog skips HF enrichment unless variants=1 (fast local path for the playground)', async () => {
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
    // The playground only needs catalog metadata — it must not pay for HF probes.
    expect(enrichCatalogWithVariants).not.toHaveBeenCalled();
  });

  it('GET /catalog exposes the managed security classifier separately from chat models', async () => {
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');

    expect(res.status).toBe(200);
    expect(res.body.securityGuards).toEqual([expect.objectContaining({
      id: 'llama-prompt-guard-2-86m',
      pipelineTag: 'text-classification',
      runtime: 'python-transformers',
    })]);
    expect(res.body.models.some((model) => model.id === 'llama-prompt-guard-2-86m')).toBe(false);
  });

  it('keeps the Prompt Guard lifecycle out of the general model installer', async () => {
    const status = await request(makeApp()).get('/api/local-llm/security-guard/status');
    expect(status.status).toBe(200);
    expect(getModelAbuseGuardStatus).toHaveBeenCalled();

    const install = await request(makeApp()).post('/api/local-llm/security-guard/install').send({});
    expect(install.status).toBe(200);
    expect(installModelAbuseGuard).toHaveBeenCalledWith({ onEvent: expect.any(Function) });
    expect(installModel).not.toHaveBeenCalled();

    const cancel = await request(makeApp()).post('/api/local-llm/security-guard/install/cancel').send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ cancelled: true });
    expect(cancelModelAbuseGuardInstall).toHaveBeenCalled();
  });

  it('returns actionable Prompt Guard access prerequisites from the install route', async () => {
    installModelAbuseGuard.mockResolvedValueOnce({
      ok: false,
      code: 'security-guard-huggingface-token-required',
    });
    const missingToken = await request(makeApp()).post('/api/local-llm/security-guard/install').send({});
    expect(missingToken.status).toBe(502);
    expect(missingToken.body).toMatchObject({
      code: 'security-guard-huggingface-token-required',
      error: 'Add a Hugging Face read token before installing Prompt Guard.',
    });

    installModelAbuseGuard.mockResolvedValueOnce({
      ok: false,
      code: 'security-guard-huggingface-access-required',
    });
    const missingAccess = await request(makeApp()).post('/api/local-llm/security-guard/install').send({});
    expect(missingAccess.status).toBe(502);
    expect(missingAccess.body).toMatchObject({
      code: 'security-guard-huggingface-access-required',
      error: 'Hugging Face has not granted Prompt Guard access yet. Submit the usage request on its model card, then retry.',
    });
  });

  it('POST /install forwards force so a redownload can replace on-disk weights', async () => {
    installModel.mockResolvedValue({ success: true, modelId: 'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M' });

    const res = await request(makeApp())
      .post('/api/local-llm/install')
      .send({ backend: 'lmstudio', modelId: 'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M', force: true });

    expect(res.status).toBe(200);
    expect(installModel).toHaveBeenCalledWith(
      'lmstudio',
      'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M',
      expect.any(Function),
      { force: true }
    );
  });

  it('POST /install without force still pulls as a regular install', async () => {
    installModel.mockResolvedValue({ success: true, modelId: 'llama3.2' });

    const res = await request(makeApp())
      .post('/api/local-llm/install')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(200);
    expect(installModel).toHaveBeenCalledWith('ollama', 'llama3.2', expect.any(Function), { force: false });
  });

  it('runs a single local model test with validated defaults', async () => {
    runLocalLlmTest.mockResolvedValue({
      backend: 'ollama',
      modelId: 'llama3.2',
      text: 'hello',
      runId: 'run-1',
      timings: { totalMs: 25, ttftMs: 10, chars: 5, charsPerSecond: 200 },
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hello');
    expect(runLocalLlmTest).toHaveBeenCalledWith({
      backend: 'ollama',
      modelId: 'llama3.2',
      prompt: 'Say hello',
      systemPrompt: '',
      temperature: 0.3,
      maxTokens: 1000,
      timeoutMs: 300000,
      // Derived from res — lets a client disconnect tear down the upstream stream.
      signal: expect.any(AbortSignal),
    });
  });

  it('streams tokens then a terminal result frame as NDJSON', async () => {
    runLocalLlmTest.mockImplementation(async ({ onToken }) => {
      onToken('Hel');
      onToken('lo');
      return { backend: 'ollama', modelId: 'llama3.2', text: 'Hello', runId: 'run-1' };
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toEqual([
      { type: 'token', delta: 'Hel', kind: 'content' },
      { type: 'token', delta: 'lo', kind: 'content' },
      { type: 'result', result: { backend: 'ollama', modelId: 'llama3.2', text: 'Hello', runId: 'run-1' } },
    ]);
  });

  it('tags reasoning tokens with kind:reasoning so the client can render them separately', async () => {
    runLocalLlmTest.mockImplementation(async ({ onToken }) => {
      onToken('thinking…', 'reasoning');
      onToken('Answer.', 'content');
      return { backend: 'ollama', modelId: 'deepseek-r1', text: 'Answer.', runId: 'run-2' };
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'deepseek-r1', prompt: 'Think then answer' });

    expect(res.status).toBe(200);
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toEqual([
      { type: 'token', delta: 'thinking…', kind: 'reasoning' },
      { type: 'token', delta: 'Answer.', kind: 'content' },
      { type: 'result', result: { backend: 'ollama', modelId: 'deepseek-r1', text: 'Answer.', runId: 'run-2' } },
    ]);
  });

  it('emits exactly one terminal result frame (no extra 500) when the run resolves an in-stream error', async () => {
    // A timed-out/aborted run resolves an { error, text } result rather than
    // throwing — the route must surface it as the single terminal frame.
    runLocalLlmTest.mockResolvedValue({
      backend: 'ollama', modelId: 'llama3.2', error: 'Timed out after 5000ms', text: 'partial',
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200);
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toEqual([
      { type: 'result', result: { backend: 'ollama', modelId: 'llama3.2', error: 'Timed out after 5000ms', text: 'partial' } },
    ]);
  });

  it('converts a pre-stream provider throw into a terminal error result frame (no 500 after headers)', async () => {
    runLocalLlmTest.mockRejectedValue(new Error('Local provider "ollama" is not configured'));

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200); // headers flushed before the throw — never a JSON 500
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'result', result: { error: 'Local provider "ollama" is not configured', text: '' } });
  });

  it('compares models in the requested execution mode', async () => {
    compareLocalLlmModels.mockResolvedValue({
      mode: 'parallel',
      results: [
        { backend: 'ollama', modelId: 'a', text: 'A' },
        { backend: 'lmstudio', modelId: 'b', text: 'B' },
      ],
    });

    const targets = [
      { backend: 'ollama', modelId: 'a' },
      { backend: 'lmstudio', modelId: 'b' },
    ];
    const res = await request(makeApp())
      .post('/api/local-llm/compare')
      .send({ mode: 'parallel', targets, prompt: 'Compare this', options: { maxTokens: 64 } });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(compareLocalLlmModels).toHaveBeenCalledWith({
      mode: 'parallel',
      targets,
      prompt: 'Compare this',
      options: {
        systemPrompt: '',
        temperature: 0.3,
        maxTokens: 64,
        timeoutMs: 300000,
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects empty prompts before running a model', () => {
    const parsed = localLlmTestSchema.safeParse({ backend: 'ollama', modelId: 'llama3.2', prompt: '   ' });

    expect(parsed.success).toBe(false);
  });

  it('limits comparisons to six targets', () => {
    const targets = Array.from({ length: 7 }, (_, i) => ({ backend: 'ollama', modelId: `model-${i}` }));
    const parsed = localLlmCompareSchema.safeParse({ targets, prompt: 'too many' });

    expect(parsed.success).toBe(false);
  });
});

describe('local LLM memory-management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /loaded reports models both local backends currently have resident', async () => {
      // Mirror the real getLoadedModels() field set so the fixture documents the
      // pass-through contract and would catch any future field-stripping.
    const resident = { id: 'llama3.2', name: 'llama3.2', size: 4096, sizeVram: 4096, expiresAt: null };
    const lmStudioResident = { id: 'example/lmstudio', state: 'loaded' };
    getLoadedModels.mockResolvedValue([resident]);
    getLoadedLmStudioModels.mockResolvedValue([lmStudioResident]);

    const res = await request(makeApp()).get('/api/local-llm/loaded');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ollama: [resident], lmstudio: [lmStudioResident], sourceErrors: [], disabled: [] });
    expect(getLoadedModels).toHaveBeenCalledTimes(1);
    expect(getLoadedLmStudioModels).toHaveBeenCalledWith(true);
     });

  it('GET /loaded keeps a failed disabled backend in sourceErrors but names it disabled', async () => {
      // "Mark disabled" only silences the availability NAG — it is not evidence the
      // backend holds no memory. So /loaded must still probe a disabled backend AND
      // still surface its failed residency in sourceErrors (the panel's
      // "Free everything" guard keys off that), while separately naming it in
      // `disabled` so the banner can stay quiet about it.
    getSettings.mockResolvedValueOnce({ localLlm: { lmstudio: { disabled: true } } });
    getLmStudioResidencyError.mockReturnValueOnce('LM Studio is unavailable');
    getLoadedLmStudioModels.mockResolvedValue([{ id: 'example/lmstudio', state: 'loaded' }]);

    const res = await request(makeApp()).get('/api/local-llm/loaded');

    expect(res.status).toBe(200);
       // Residency is honored — the backend is still probed…
    expect(getLoadedLmStudioModels).toHaveBeenCalledWith(true);
    expect(res.body.lmstudio).toEqual([{ id: 'example/lmstudio', state: 'loaded' }]);
       // …and its failed probe keeps the "unknown residency" status sourceErrors so
       // "Free everything" can't claim it freed a model it never saw.
    expect(res.body.sourceErrors).toContain('lmstudio');
       // The disabled flag is the signal the panel uses to hold the banner.
    expect(res.body.disabled).toEqual(['lmstudio']);
    expect(getSettings).toHaveBeenCalled();
      });

  it('GET /loaded still reports an enabled backend whose residency probe fails', async () => {
      // An enabled backend that fails its residency probe surfaces in sourceErrors
      // and is NOT in `disabled`, so the panel both shows the nag and keeps its
      // "excluded from Free everything" guard.
    getSettings.mockResolvedValueOnce({});
    getLmStudioResidencyError.mockReturnValueOnce('LM Studio is unavailable');

    const res = await request(makeApp()).get('/api/local-llm/loaded');

    expect(res.status).toBe(200);
    expect(res.body.sourceErrors).toContain('lmstudio');
       // An enabled backend is not in the disabled list.
    expect(res.body.disabled).not.toContain('lmstudio');
    expect(getLoadedLmStudioModels).toHaveBeenCalledWith(true);
      });

  it('POST /unload evicts a resident model and echoes the service result', async () => {
    // Real unloadModel() success shape is { unloaded: true, model } — NOT modelId
    // (ollamaManager.js); the handler spreads it into the response verbatim.
    unloadModel.mockResolvedValue({ unloaded: true, model: 'llama3.2' });

    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, unloaded: true, model: 'llama3.2' });
    expect(unloadModel).toHaveBeenCalledWith('llama3.2');
  });

  it('POST /unload treats an already-evicted model as an idempotent 200 no-op', async () => {
    unloadModel.mockResolvedValue({ unloaded: false, reason: 'not loaded' });

    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, unloaded: false, reason: 'not loaded', modelId: 'llama3.2' });
  });

  it('POST /unload surfaces a genuine unload failure as 502', async () => {
    unloadModel.mockResolvedValue({ unloaded: false, reason: 'Ollama unreachable' });

    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(502);
    // Standard error envelope (errorHandler): message in `error`, machine code
    // derived from status, the modelId carried in `context` for diagnostics.
    expect(res.body.error).toBe('Ollama unreachable');
    expect(res.body.code).toBe('BAD_GATEWAY');
    expect(res.body.context).toEqual({ modelId: 'llama3.2' });
    expect(unloadModel).toHaveBeenCalledWith('llama3.2');
  });

  it('POST /unload refuses a non-ollama backend before calling the service', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'lmstudio', modelId: 'some-model' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/use \/api\/lmstudio\/unload/);
    expect(unloadModel).not.toHaveBeenCalled();
  });

  it('POST /unload rejects a flag-like modelId via Zod validation', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: '-rf' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(unloadModel).not.toHaveBeenCalled();
  });
});

describe('local LLM capability routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('GET /tool-use-models returns the service list under `models`', async () => {
    listToolUseModels.mockResolvedValueOnce([
      { providerId: 'ollama', backend: 'ollama', id: 'phi4-mini:latest', name: 'phi4-mini:latest', toolUse: true },
    ]);

    const res = await request(makeApp()).get('/api/local-llm/tool-use-models');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      models: [
        { providerId: 'ollama', backend: 'ollama', id: 'phi4-mini:latest', name: 'phi4-mini:latest', toolUse: true },
      ],
    });
    expect(listToolUseModels).toHaveBeenCalledTimes(1);
  });

  it('GET /tool-use-models is a distinct list from /vision-models', async () => {
    // The two endpoints answer different questions; folding tool-use rows into
    // /vision-models would break its "every row is vision-capable" contract,
    // which the LoRA caption picker lists verbatim.
    listVisionModels.mockResolvedValueOnce([
      { providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl:7b', name: 'qwen2.5-vl:7b', vision: true },
    ]);
    listToolUseModels.mockResolvedValueOnce([
      { providerId: 'ollama', backend: 'ollama', id: 'phi4-mini:latest', name: 'phi4-mini:latest', toolUse: true },
    ]);
    const app = makeApp();

    const vision = await request(app).get('/api/local-llm/vision-models');
    const tools = await request(app).get('/api/local-llm/tool-use-models');

    expect(vision.body.models.map((m) => m.id)).toEqual(['qwen2.5-vl:7b']);
    expect(tools.body.models.map((m) => m.id)).toEqual(['phi4-mini:latest']);
  });
});

describe('measured assessments wiring', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('folds measured evidence into the catalog fit badge', async () => {
    getMeasuredFits.mockResolvedValue({ 'example-model:14b': { fit: 'too-large', verdict: 'does-not-fit', stale: false } });
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');

    expect(res.status).toBe(200);
    expect(getMeasuredFits).toHaveBeenCalledWith('ollama');
    // The overlay runs against the SAME backend the listing was built for —
    // an LM Studio measurement must never decorate an Ollama card.
    expect(applyMeasuredFit).toHaveBeenCalledWith(res.body.models, {
      backend: 'ollama',
      measured: { 'example-model:14b': { fit: 'too-large', verdict: 'does-not-fit', stale: false } },
    });
  });

  it('still serves the catalog when the assessments store cannot be read', async () => {
    // A broken measurement file must not take the install picker down with it.
    getMeasuredFits.mockRejectedValue(new Error('disk on fire'));
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');
    expect(res.status).toBe(200);
    expect(applyMeasuredFit).toHaveBeenCalledWith(expect.anything(), { backend: 'ollama', measured: {} });
  });

  it('forwards assessment progress to the shared localLlm:progress socket event', async () => {
    runAssessment.mockImplementation(async ({ onProgress }) => {
      onProgress({ scope: 'assessment', backend: 'ollama', modelId: 'example-model:14b', event: 'start', sampleIndex: 1, sampleCount: 3 });
      return { verdict: 'fits' };
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/local-llm/assessments/run')
      .send({ backend: 'ollama', modelId: 'example-model:14b' });

    expect(res.status).toBe(200);
    expect(app.get('io').emit).toHaveBeenCalledWith('localLlm:progress', {
      scope: 'assessment', backend: 'ollama', modelId: 'example-model:14b', event: 'start', sampleIndex: 1, sampleCount: 3,
    });
  });

  it('runs the explicit OpenCode agent benchmark with a bounded timeout', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/agent-benchmark')
      .send({ backend: 'ollama', modelId: 'qwen3.8:27b-mlx', timeoutMs: 120000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      backend: 'ollama', modelId: 'qwen3.8:27b-mlx', timeoutMs: 120000, completed: true,
    });
    expect(runOpenCodeAgentBenchmark).toHaveBeenCalledWith({
      backend: 'ollama', modelId: 'qwen3.8:27b-mlx', timeoutMs: 120000,
    });
  });

  it('rejects an agent benchmark backend outside the configured local targets', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/agent-benchmark')
      .send({ backend: 'vllm', modelId: 'qwen3.8-27b-dflash2' });

    expect(res.status).toBe(400);
    expect(runOpenCodeAgentBenchmark).not.toHaveBeenCalled();
  });

  // The sweep is the overnight path: it must return as soon as the queue exists,
  // because the run outlives the request that started it.
  it('POST /assessments/sweep starts a queue and returns its snapshot', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ scope: 'all' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'running', total: 3 });
    expect(startSweep).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all' }));
  });

  it('POST /assessments/sweep defaults to the unmeasured scope', async () => {
    const res = await request(makeApp()).post('/api/local-llm/assessments/sweep').send({});
    expect(res.status).toBe(200);
    expect(startSweep).toHaveBeenCalledWith(expect.objectContaining({ scope: 'unmeasured' }));
  });

  it('POST /assessments/sweep rejects an unknown scope rather than silently narrowing it', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ scope: 'everything-please' });

    expect(res.status).toBe(400);
    expect(startSweep).not.toHaveBeenCalled();
  });

  // A refused start has to be visible: a 200 with no queue behind it would leave
  // the page waiting on progress that never comes.
  it('POST /assessments/sweep 409s when the service refuses to start', async () => {
    startSweep.mockResolvedValueOnce({ status: 'running', rejected: 'a sweep is already running' });
    const res = await request(makeApp()).post('/api/local-llm/assessments/sweep').send({ scope: 'all' });
    expect(res.status).toBe(409);
  });

  it('forwards sweep progress to the shared localLlm:progress socket event', async () => {
    startSweep.mockImplementation(async ({ onProgress }) => {
      onProgress({ scope: 'assessment-sweep', event: 'start', total: 2, completed: 0 });
      return { status: 'running', total: 2, completed: 0 };
    });
    const app = makeApp();
    await request(app).post('/api/local-llm/assessments/sweep').send({ scope: 'unmeasured' });

    expect(app.get('io').emit).toHaveBeenCalledWith('localLlm:progress', {
      scope: 'assessment-sweep', event: 'start', total: 2, completed: 0,
    });
  });

  // `tunings` is the ASK, not the grid — the service decides which knob sets a
  // "tuning sweep of this model" means. A client that could post the grid could
  // ask for an arbitrary batch of provider calls.
  it('POST /assessments/sweep forwards a tuning-sweep request without a grid', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ backend: 'llama', modelId: 'example-model.gguf', tunings: true });

    expect(res.status).toBe(200);
    expect(startSweep).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'llama', modelId: 'example-model.gguf', tunings: true,
    }));
  });

  // The service's refusals ride the existing rejected → 409 path rather than a
  // second, hand-rolled one in the handler.
  it('POST /assessments/sweep 409s when the service refuses the tuning grid', async () => {
    startSweep.mockResolvedValueOnce({ status: 'idle', rejected: 'mtplx has no tuning knobs PortOS can sweep' });
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ backend: 'mtplx', modelId: 'example-model', tunings: true });

    expect(res.status).toBe(409);
  });

  // Half a model reference would fall through to the scope and measure every
  // installed model — hours of work nobody asked for.
  it('POST /assessments/sweep rejects a backend with no modelId', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ backend: 'llama', tunings: true });

    expect(res.status).toBe(400);
    expect(startSweep).not.toHaveBeenCalled();
  });

  // No wire knob shrinks the grid: the consent gate names its count from the
  // report's grid, so a request that could shrink it would run a different
  // number than the user agreed to.
  it('POST /assessments/sweep rejects an attempt to size the grid from the wire', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ backend: 'llama', modelId: 'example-model.gguf', tunings: true, maxVariants: 2 });

    expect(res.status).toBe(200);
    expect(startSweep.mock.calls[0][0].maxVariants).toBeUndefined();
  });

  it('POST /assessments/sweep leaves a plain model sweep untuned', async () => {
    await request(makeApp()).post('/api/local-llm/assessments/sweep').send({ scope: 'all' });
    expect(startSweep.mock.calls[0][0].tunings).toBe(false);
  });

  it('GET /assessments/sweep reports the queue without touching a provider', async () => {
    const res = await request(makeApp()).get('/api/local-llm/assessments/sweep');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'idle' });
    expect(getSweepStatus).toHaveBeenCalled();
    expect(startSweep).not.toHaveBeenCalled();
  });

  it('POST /assessments/sweep/cancel stops the queue', async () => {
    const res = await request(makeApp()).post('/api/local-llm/assessments/sweep/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', completed: 1 });
    expect(cancelSweep).toHaveBeenCalled();
  });
});

describe('llama-server routes', () => {
  it('GET /api/local-llm/llama-server/status returns status with the weight presets', async () => {
    const res = await request(makeApp()).get('/api/local-llm/llama-server/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      installed: true,
      running: false,
      presets: [{ id: 'test-preset', label: 'Test', specType: 'draft-dspark', model: null, draftModel: null }],
    });
  });

  it('GET /api/local-llm/llama-server/status keeps Homebrew probes out of lifecycle status', async () => {
    const { getLlamaServerUpdateStatus } = await import('../services/llamaServerManager.js');
    const res = await request(makeApp()).get('/api/local-llm/llama-server/status');

    expect(res.status).toBe(200);
    expect(getLlamaServerUpdateStatus).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('updateAvailable');
  });

  it('GET /api/local-llm/llama-server/update-status returns llama.cpp update metadata', async () => {
    const { getLlamaServerUpdateStatus } = await import('../services/llamaServerManager.js');
    getLlamaServerUpdateStatus.mockResolvedValueOnce({
      version: '0.1.1-dev',
      latestVersion: '0.3.0',
      updateAvailable: true,
      canUpgrade: true,
      downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases',
    });

    const res = await request(makeApp()).get('/api/local-llm/llama-server/update-status');

    expect(res.body).toMatchObject({
      version: '0.1.1-dev',
      latestVersion: '0.3.0',
      updateAvailable: true,
      canUpgrade: true,
    });
  });

  it('GET /api/local-llm/llama-server/status publishes the drafter-free spec types', async () => {
    // The card renders the picker from this list, so a launch with no drafter
    // GGUF (`ngram-map-k`) has to be reachable without the user knowing the
    // llama.cpp vocabulary by heart.
    const res = await request(makeApp()).get('/api/local-llm/llama-server/status');
    expect(res.body.specTypes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['ngram-map-k', 'draft-dflash', 'none']),
    );
  });

  it('POST /api/local-llm/llama-server/download-model fetches one preset GGUF', async () => {
    const { downloadSpecDecodeModel } = await import('../services/specDecodeModels.js');
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model')
      .send({ presetId: 'test-preset', role: 'model' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, path: 'models/base.gguf' });
    expect(downloadSpecDecodeModel).toHaveBeenCalledWith(expect.objectContaining({ presetId: 'test-preset', role: 'model' }));
  });

  it('POST /api/local-llm/llama-server/download-model rejects an unknown role', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model')
      .send({ presetId: 'test-preset', role: 'sneaky' });

    expect(res.status).toBe(400);
  });

  it('POST /api/local-llm/llama-server/download-model/cancel cancels one active preset download', async () => {
    const { cancelSpecDecodeModelDownload } = await import('../services/specDecodeModels.js');
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model/cancel')
      .send({ presetId: 'test-preset', role: 'model' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, cancelled: true });
    expect(cancelSpecDecodeModelDownload).toHaveBeenCalledWith({ presetId: 'test-preset', role: 'model' });
  });

  it('POST /api/local-llm/llama-server/start launches server with valid payload', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/start')
      .send({ model: 'models/Qwen3.8-27B.gguf', draftModel: 'models/DFlash.gguf' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, pid: 123 });
  });

  it('POST /api/local-llm/llama-server/start rejects invalid payload', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/start')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/local-llm/llama-server/stop stops server', async () => {
    const res = await request(makeApp()).post('/api/local-llm/llama-server/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('POST /api/local-llm/llama-server/install triggers install', async () => {
    const res = await request(makeApp()).post('/api/local-llm/llama-server/install');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'installed' });
  });

  it('POST /api/local-llm/llama-server/upgrade emits progress and returns the result', async () => {
    const { upgradeLlamaServer } = await import('../services/llamaServerManager.js');
    upgradeLlamaServer.mockResolvedValueOnce({ success: true, note: 'updated and restarted' });
    const app = makeApp();

    const res = await request(app).post('/api/local-llm/llama-server/upgrade');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, note: 'updated and restarted' });
    expect(upgradeLlamaServer).toHaveBeenCalledWith({ onProgress: expect.any(Function) });
    expect(app.get('io').emit).toHaveBeenCalledWith(
      'localLlm:progress',
      { event: 'complete', message: 'llama.cpp updated — updated and restarted' },
    );
  });
});
