import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.mock('./db.js', () => ({
  listRuns: vi.fn(async () => [...store.values()].filter((r) => !r.deleted)),
  getRun: vi.fn(async (id) => store.get(id) ?? null),
  createRun: vi.fn(async ({ backend, modelId, lora = null, route = null, pageCount, themes, prompts }) => {
    const run = {
      id: `run-${store.size + 1}`, backend, modelId, lora, route, pageCount, themes, prompts, status: 'queued',
      progress: { done: 0, total: pageCount }, pages: [], detail: null, error: null, deleted: false,
    };
    store.set(run.id, run);
    return run;
  }),
  mutateRun: vi.fn(async (id, mutate) => {
    const next = mutate(store.get(id));
    if (next) store.set(id, next);
    return store.get(id);
  }),
  deleteRun: vi.fn(async (id) => {
    store.set(id, { ...store.get(id), deleted: true });
    return { id, deleted: true };
  }),
}));
// llama.cpp is offline unless a test serves a model on it (and, through `fetch`, its loaded LoRA adapters).
const llama = { models: null };
vi.mock('../localModelAssessments.js', () => ({
  listRuntimeModels: vi.fn(async (runtime) => {
    if (runtime === 'ollama') return { models: [{ id: 'example-coder:7b' }, { id: 'nomic-embed-text' }], error: null };
    if (runtime === 'llama' && llama.models) return { models: llama.models, error: null };
    return { models: null, error: 'not reachable', offline: true };
  }),
  runtimeEndpoint: vi.fn(async (runtime) => (runtime === 'llama' ? 'http://127.0.0.1:5568/v1' : null)),
}));
vi.mock('../modelCapabilityTests.js', () => ({ generate: vi.fn() }));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({ ok: true, release: vi.fn(async () => {}) })),
}));

vi.mock('../mtplxServerManager.js', () => ({
  getMtplxServerStatus: vi.fn(async () => ({ running: true, config: { model: 'Example/Served-MTPLX' }, cachedModels: ['Example/Served-MTPLX', 'Example/Other-MTPLX'] })),
  runOnMtplxCheckpoint: vi.fn(async (_model, fn) => fn('mtplx-example-other')),
}));
vi.mock('../provider/providers.js', () => ({
  getProviderById: vi.fn(async (id) => (id === 'example-cli' ? { id, name: 'Example CLI', type: 'cli', enabled: true, defaultModel: 'example-default' } : null)),
}));
vi.mock('../promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('../runner.js', () => ({ stopRun: vi.fn(async () => {}) }));

import { generate } from '../modelCapabilityTests.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { listActiveRenders } from '../renderActivity.js';
import { runOnMtplxCheckpoint } from '../mtplxServerManager.js';
import { runPromptThroughProvider } from '../promptRunner.js';
import { listRuns, listSelectableModels, readRun, removeRun, resumeRun, startRuns } from './index.js';

const goodPage = `<!doctype html><html><head><style>body{margin:0}</style></head><body><canvas></canvas><script>${'let a=1;'.repeat(200)}</script></body></html>`;
const model = { backend: 'ollama', modelId: 'example-coder:7b' };
const PAGES = ['A lighthouse at dusk with a sweeping beam', 'A tide-pool you can poke'];
const settled = (id) => vi.waitFor(async () => {
  const run = await readRun(id);
  expect(['complete', 'failed']).toContain(run.status);
  return run;
});

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  llama.models = null;
});

describe('listSelectableModels', () => {
  it('offers installed chat models, hides embeddings, and reports a runtime it could not read', async () => {
    const result = await listSelectableModels();
    expect(result.models).toEqual([
      expect.objectContaining({ backend: 'ollama', modelId: 'example-coder:7b' }),
      // A downloaded MTPLX pack that is not serving is offered too; the serving one is not listed twice.
      expect.objectContaining({ backend: 'mtplx', modelId: 'Example/Other-MTPLX', switchesCheckpoint: true }),
    ]);
    expect(result.listErrors.some((e) => e.id === 'lmstudio')).toBe(true);
    expect(result.defaultPages).toHaveLength(result.pageCountMax);
    expect(result.defaultPages[0]).toBe('- look stunning\n- original\n- go full creative mode');
    // The fixed text around a brief ships with the picker so the form can show the exact prompt.
    expect(result.promptParts.before + result.defaultPages[0] + result.promptParts.after).toContain(result.defaultPages[0]);
  });
});

describe('startRuns', () => {
  it('refuses a model that is not installed before queueing anything', async () => {
    await expect(startRuns({ models: [{ backend: 'ollama', modelId: 'missing:1b' }], pages: PAGES }))
      .rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_MODEL_UNAVAILABLE' });
    expect(store.size).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends each page its own brief verbatim inside the fixed rules, records the prompts, and stores a scored complete run', async () => {
    generate.mockResolvedValue({ text: `Here you go:\n\`\`\`html\n${goodPage}\n\`\`\``, timings: { tokensPerSecond: 40 } });
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    expect(queued.themes).toEqual(PAGES);
    expect(queued.prompts[0]).toContain(PAGES[0]);

    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0].prompt).toBe(queued.prompts[0]);
    expect(generate.mock.calls[1][0].prompt).toBe(queued.prompts[1]);
    expect(generate.mock.calls[1][0].prompt).toContain(`\n\n${PAGES[1]}\n\n`);
    expect(run.pages.map((p) => p.html)).toEqual([goodPage, goodPage]);
    expect(run.detail).toMatchObject({ verdict: 'passed', complete: 2, pageCount: 2 });
    expect(run.progress).toEqual({ done: 2, total: 2 });
  });

  it('keeps a page the model truncated as returned and scores the run partial', async () => {
    generate
      .mockResolvedValueOnce({ text: goodPage })
      .mockResolvedValueOnce({ text: goodPage.replace('</html>', '') });
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(run.pages[1].html.endsWith('</html>')).toBe(false);
    expect(run.detail.verdict).toBe('partial');
  });

  it('flags a page the runtime cut off at the token limit, and does not call reasoning prose a page', async () => {
    generate.mockResolvedValue({ text: 'Let me think about the <svg> and the <div> first. Then I will write the code.', timings: { completionTokens: 48_000 } });
    const [queued] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    const run = await settled(queued.id);
    expect(run.pages[0]).toMatchObject({ html: '', hitTokenLimit: true });
    expect(run.detail.verdict).toBe('failed');
  });

  it('marks the run failed with the runtime error when no page ever came back', async () => {
    generate.mockResolvedValue({ text: '', error: 'model server went away' });
    const [queued] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    const run = await settled(queued.id);
    expect(run).toMatchObject({ status: 'failed', error: 'model server went away' });
  });

  it('queues several models and runs them one at a time', async () => {
    let concurrent = 0;
    let peak = 0;
    generate.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return { text: goodPage };
    });
    const runs = await startRuns({ models: [model, { ...model, modelId: 'example-coder:7b' }], pages: PAGES.slice(0, 1) });
    await Promise.all(runs.map((r) => settled(r.id)));
    expect(peak).toBe(1);
  });
});

describe('other targets', () => {
  it('switches MTPLX to a downloaded pack for the run and names the served id in each request', async () => {
    generate.mockResolvedValue({ text: goodPage });
    const [queued] = await startRuns({ models: [{ backend: 'mtplx', modelId: 'Example/Other-MTPLX' }], pages: PAGES.slice(0, 1) });
    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(runOnMtplxCheckpoint).toHaveBeenCalledWith('Example/Other-MTPLX', expect.any(Function));
    expect(generate.mock.calls[0][0]).toMatchObject({ backend: 'mtplx', modelId: 'mtplx-example-other' });
  });

  it('runs a provider route with its model and effort, no fallback, and the prompt exactly as recorded', async () => {
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => ({ text: `${prompt}\n${goodPage}` }));
    const [queued] = await startRuns({ routes: [{ providerId: 'example-cli', model: null, effort: 'high' }], pages: PAGES.slice(0, 1) });
    expect(queued).toMatchObject({ backend: 'provider', modelId: 'example-default', route: { providerId: 'example-cli', providerName: 'Example CLI', model: 'example-default', effort: 'high' } });
    const run = await settled(queued.id);
    expect(run.pages[0].html).toBe(goodPage);
    expect(runPromptThroughProvider.mock.calls[0][0]).toMatchObject({
      prompt: queued.prompts[0], model: 'example-default', effort: 'high', allowFallback: false, toolFree: true, source: 'html-pages-bench',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('refuses a provider that is not configured before queueing anything', async () => {
    await expect(startRuns({ routes: [{ providerId: 'gone' }], pages: PAGES })).rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_PROVIDER_UNAVAILABLE' });
    expect(store.size).toBe(0);
  });
});

describe('llama.cpp LoRA adapters', () => {
  const llamaModel = { backend: 'llama', modelId: 'example-27b' };
  const adapters = [{ id: 0, path: 'models/example-lora-F16.gguf', scale: 0 }];
  const serveAdapters = (list) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    expect(String(url)).toBe('http://127.0.0.1:5568/lora-adapters');
    return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  beforeEach(() => { llama.models = [{ id: 'example-27b' }]; });
  afterEach(() => vi.restoreAllMocks());

  it('offers the adapters the server loaded on its model, and none when it reports none', async () => {
    serveAdapters(adapters);
    const listed = (await listSelectableModels()).models.find((m) => m.backend === 'llama');
    expect(listed.loraAdapters).toEqual([{ id: 0, name: 'example-lora-F16', path: 'models/example-lora-F16.gguf' }]);

    serveAdapters([]);
    expect((await listSelectableModels()).models.find((m) => m.backend === 'llama')).not.toHaveProperty('loraAdapters');
  });

  it('runs the same model with and without the adapter, naming every adapter scale on each request', async () => {
    serveAdapters(adapters);
    generate.mockResolvedValue({ text: goodPage, timings: null });
    const [withAdapter, base] = await startRuns({ models: [{ ...llamaModel, lora: { id: 0, scale: 1 } }, llamaModel], pages: [PAGES[0]] });
    expect(withAdapter.lora).toEqual({ id: 0, name: 'example-lora-F16', scale: 1 });
    expect(base.lora).toBeNull();
    await settled(withAdapter.id);
    await settled(base.id);
    expect(generate.mock.calls.map(([args]) => args.extraBody)).toEqual([
      { lora: [{ id: 0, scale: 1 }] },
      // The base pick turns the adapter off explicitly rather than trusting the server's global scale.
      { lora: [{ id: 0, scale: 0 }] },
    ]);
  });

  it('refuses an adapter the server has not loaded before queueing anything', async () => {
    serveAdapters([]);
    await expect(startRuns({ models: [{ ...llamaModel, lora: { id: 0, scale: 1 } }], pages: PAGES }))
      .rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_LORA_UNAVAILABLE' });
    expect(store.size).toBe(0);
  });

  it('fails a queued adapter run whose adapter is gone by the time it starts, instead of running the base model under its name', async () => {
    serveAdapters(adapters);
    // Held at the heavy-job claim, which comes before the run reads the adapters.
    let admit;
    claimHeavyLocalJob.mockImplementationOnce(() => new Promise((resolve) => { admit = () => resolve({ ok: true, release: vi.fn(async () => {}) }); }));
    const [queued] = await startRuns({ models: [{ ...llamaModel, lora: { id: 0, scale: 1 } }], pages: PAGES });
    await vi.waitFor(() => expect(admit).toBeTypeOf('function'));
    serveAdapters([]);
    admit();
    const run = await settled(queued.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/no longer loaded/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends no lora field to a llama.cpp server with no adapters, or to another runtime', async () => {
    serveAdapters([]);
    generate.mockResolvedValue({ text: goodPage, timings: null });
    const [run] = await startRuns({ models: [llamaModel, model], pages: [PAGES[0]] });
    await settled(run.id);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls.map(([args]) => args.extraBody)).toEqual([undefined, undefined]);
  });
});

describe('listRuns', () => {
  it('returns summaries without the generated HTML, while a single run read keeps it', async () => {
    generate.mockResolvedValue({ text: goodPage });
    const [queued] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    await settled(queued.id);
    const [summary] = await listRuns();
    expect(summary.pages[0]).not.toHaveProperty('html');
    expect(summary.pages[0]).toMatchObject({ theme: PAGES[0], passed: 6, total: 6 });
    expect((await readRun(queued.id)).pages[0].html).toBe(goodPage);
  });
});

describe('interrupted and deleted runs', () => {
  it('reports a run left active by a previous process as failed, not as still running', async () => {
    store.set('stale', { id: 'stale', status: 'generating', deleted: false, pages: [] });
    const runs = await listRuns();
    expect(runs.find((r) => r.id === 'stale')).toMatchObject({ status: 'failed', error: expect.stringContaining('restart') });
    expect(generate).not.toHaveBeenCalled();
  });

  it('stops a generating run when it is deleted and never stores its late page', async () => {
    let release;
    generate.mockImplementation(({ signal }) => new Promise((resolve) => {
      release = () => resolve({ text: goodPage });
      signal.addEventListener('abort', release);
    }));
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await removeRun(queued.id);
    release();
    await vi.waitFor(() => expect(store.get(queued.id).deleted).toBe(true));
    expect(store.get(queued.id).pages).toHaveLength(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('shows a queued or generating run in Live activity until it settles, so the updater waits for it', async () => {
    let release;
    generate.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ text: goodPage }); }));
    const [queued] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    expect(listActiveRenders()).toEqual([expect.objectContaining({ kind: 'html-pages', noun: 'HTML pages run', to: '/html-pages' })]);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect((await readRun(queued.id)).status).toBe('generating');
    release();
    await settled(queued.id);
    await vi.waitFor(() => expect(listActiveRenders().filter((r) => r.kind === 'html-pages')).toHaveLength(0));
  });
});

describe('resumeRun', () => {
  const cutOff = (pages) => store.set('cut', {
    id: 'cut', ...model, pageCount: 2, themes: PAGES, prompts: ['first prompt', 'second prompt'], status: 'generating',
    progress: { done: pages.length, total: 2 }, pages, detail: null, error: null, deleted: false,
  });

  it('re-queues a run a restart cut off from its first unfinished page, with the prompts it recorded', async () => {
    cutOff([{ theme: PAGES[0], html: goodPage }]);
    expect((await readRun('cut')).status).toBe('failed');
    generate.mockResolvedValue({ text: goodPage });
    const resumed = await resumeRun('cut');
    expect(resumed).toMatchObject({ status: 'queued', error: null, progress: { done: 1, total: 2 } });
    const run = await settled('cut');
    expect(run.status).toBe('complete');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].prompt).toBe('second prompt');
    expect(run.pages.map((p) => p.theme)).toEqual(PAGES);
  });

  it('redoes a page that came back without HTML and every page after it', async () => {
    cutOff([{ theme: PAGES[0], html: '', error: 'model server went away' }, { theme: PAGES[1], html: goodPage }]);
    generate.mockResolvedValue({ text: goodPage });
    await resumeRun('cut');
    const run = await settled('cut');
    expect(generate.mock.calls.map(([args]) => args.prompt)).toEqual(['first prompt', 'second prompt']);
    expect(run.pages.every((p) => p.html === goodPage)).toBe(true);
  });

  it('retries a finished run from its first page that failed a check, keeping the passing pages before it', async () => {
    generate.mockResolvedValueOnce({ text: goodPage }).mockResolvedValueOnce({ text: goodPage.replace('</html>', '') });
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    expect((await settled(queued.id)).detail.verdict).toBe('partial');
    await vi.waitFor(() => expect(listActiveRenders().filter((r) => r.kind === 'html-pages')).toHaveLength(0));
    generate.mockClear();
    generate.mockResolvedValue({ text: goodPage });
    await expect(resumeRun(queued.id)).resolves.toMatchObject({ status: 'queued', progress: { done: 1, total: 2 } });
    const run = await vi.waitFor(async () => {
      const current = await readRun(queued.id);
      expect(current.detail?.verdict).toBe('passed');
      return current;
    });
    expect(generate.mock.calls.map(([args]) => args.prompt)).toEqual([queued.prompts[1]]);
    expect(run.pages.map((p) => p.html)).toEqual([goodPage, goodPage]);
  });

  it('refuses a run whose every page passed and a run that is still live', async () => {
    generate.mockResolvedValue({ text: goodPage });
    const [done] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    await expect(resumeRun(done.id)).rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_RUN_ACTIVE' });
    await settled(done.id);
    await vi.waitFor(() => expect(listActiveRenders().filter((r) => r.kind === 'html-pages')).toHaveLength(0));
    await expect(resumeRun(done.id)).rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_RUN_NOT_RESUMABLE' });
    expect(listActiveRenders().filter((r) => r.kind === 'html-pages')).toHaveLength(0);
  });
});
