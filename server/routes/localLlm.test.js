import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import localLlmRoutes from './localLlm.js';
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js';
import { listModels } from '../services/localLlm.js';
import { enrichCatalogWithVariants } from '../services/huggingFaceCatalog.js';
import { getLoadedModels, unloadModel } from '../services/ollamaManager.js';
import { localLlmCompareSchema, localLlmTestSchema } from '../lib/validation.js';
import { errorEvents } from '../lib/errorHandler.js';

// asyncHandler emits to errorEvents on every route failure; with `io` set on
// the app it always fires. Swallow it so a validation-rejection test doesn't
// trip Node's "unhandled 'error' event" — assertions go through the response.
errorEvents.on('error', () => {});

vi.mock('../services/localLlm.js', () => ({
  getStatus: vi.fn(),
  listModels: vi.fn(async () => []),
  installModel: vi.fn(),
  deleteModel: vi.fn(),
  switchBackend: vi.fn(),
  migrateBackend: vi.fn(),
  installBackend: vi.fn(),
  upgradeBackend: vi.fn(),
  controlOllamaServer: vi.fn(),
}));

vi.mock('../services/localLlmPlayground.js', () => ({
  runLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../services/ollamaManager.js', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadModel: vi.fn(),
}));

// Mock the HF catalog service so /catalog tests don't hit the network. The no-op
// enrichCatalogWithVariants simulates the offline/failed-enrichment case (it leaves
// the catalog's getCatalog overlay untouched), which is exactly when the route's
// raw-id installed overlay must be correct.
vi.mock('../services/huggingFaceCatalog.js', () => ({
  searchHuggingFaceModels: vi.fn(async () => []),
  enrichCatalogWithVariants: vi.fn(async (catalog) => catalog),
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
    listModels.mockResolvedValue([{ id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF', quantization: 'Q4_K_M' }]);

    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=lmstudio&variants=1');

    expect(res.status).toBe(200);
    expect(enrichCatalogWithVariants).toHaveBeenCalled();
    const entry = res.body.models.find((m) => m.id === 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF');
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

  it('GET /loaded reports the models Ollama currently has resident', async () => {
    // Mirror the real getLoadedModels() field set so the fixture documents the
    // pass-through contract and would catch any future field-stripping.
    const resident = { id: 'llama3.2', name: 'llama3.2', size: 4096, sizeVram: 4096, expiresAt: null };
    getLoadedModels.mockResolvedValue([resident]);

    const res = await request(makeApp()).get('/api/local-llm/loaded');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ollama: [resident] });
    expect(getLoadedModels).toHaveBeenCalledTimes(1);
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
