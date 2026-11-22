import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.mock('./db.js', () => ({
  listRuns: vi.fn(async () => [...store.values()].filter((r) => !r.deleted)),
  getRun: vi.fn(async (id) => store.get(id) ?? null),
  createRun: vi.fn(async ({ backend, modelId, pageCount, themes }) => {
    const run = {
      id: `run-${store.size + 1}`, backend, modelId, pageCount, themes, status: 'queued',
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
vi.mock('../localModelAssessments.js', () => ({
  listRuntimeModels: vi.fn(async (runtime) => (runtime === 'ollama'
    ? { models: [{ id: 'example-coder:7b' }, { id: 'nomic-embed-text' }], error: null }
    : { models: null, error: 'not reachable', offline: true })),
}));
vi.mock('../modelCapabilityTests.js', () => ({ generate: vi.fn() }));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({ ok: true, release: vi.fn(async () => {}) })),
}));

import { generate } from '../modelCapabilityTests.js';
import { listRuns, listSelectableModels, readRun, removeRun, startRuns } from './index.js';

const goodPage = `<!doctype html><html><head><style>body{margin:0}</style></head><body><canvas></canvas><script>${'let a=1;'.repeat(200)}</script></body></html>`;
const model = { backend: 'ollama', modelId: 'example-coder:7b' };
const settled = (id) => vi.waitFor(async () => {
  const run = await readRun(id);
  expect(['complete', 'failed']).toContain(run.status);
  return run;
});

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('listSelectableModels', () => {
  it('offers installed chat models, hides embeddings, and reports a runtime it could not read', async () => {
    const result = await listSelectableModels();
    expect(result.models).toEqual([expect.objectContaining({ backend: 'ollama', modelId: 'example-coder:7b' })]);
    expect(result.listErrors.some((e) => e.id === 'lmstudio')).toBe(true);
    expect(result.themes.length).toBeGreaterThanOrEqual(result.pageCountMax);
    expect(result.promptExample).toContain(result.themes[0]);
  });
});

describe('startRuns', () => {
  it('refuses a model that is not installed before queueing anything', async () => {
    await expect(startRuns({ models: [{ backend: 'ollama', modelId: 'missing:1b' }], pageCount: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_MODEL_UNAVAILABLE' });
    expect(store.size).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('runs one request per page with its own theme, extracts the HTML, and stores a scored complete run', async () => {
    generate.mockResolvedValue({ text: `Here you go:\n\`\`\`html\n${goodPage}\n\`\`\``, timings: { tokensPerSecond: 40 } });
    const [queued] = await startRuns({ models: [model], pageCount: 2 });
    expect(queued.themes).toHaveLength(2);

    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0].prompt).toContain(queued.themes[0]);
    expect(generate.mock.calls[1][0].prompt).toContain(queued.themes[1]);
    expect(run.pages.map((p) => p.html)).toEqual([goodPage, goodPage]);
    expect(run.detail).toMatchObject({ verdict: 'passed', complete: 2, pageCount: 2 });
    expect(run.progress).toEqual({ done: 2, total: 2 });
  });

  it('keeps a page the model truncated as returned and scores the run partial', async () => {
    generate
      .mockResolvedValueOnce({ text: goodPage })
      .mockResolvedValueOnce({ text: goodPage.replace('</html>', '') });
    const [queued] = await startRuns({ models: [model], pageCount: 2 });
    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(run.pages[1].html.endsWith('</html>')).toBe(false);
    expect(run.detail.verdict).toBe('partial');
  });

  it('marks the run failed with the runtime error when no page ever came back', async () => {
    generate.mockResolvedValue({ text: '', error: 'model server went away' });
    const [queued] = await startRuns({ models: [model], pageCount: 1 });
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
    const runs = await startRuns({ models: [model, { ...model, modelId: 'example-coder:7b' }], pageCount: 1 });
    await Promise.all(runs.map((r) => settled(r.id)));
    expect(peak).toBe(1);
  });
});

describe('listRuns', () => {
  it('returns summaries without the generated HTML, while a single run read keeps it', async () => {
    generate.mockResolvedValue({ text: goodPage });
    const [queued] = await startRuns({ models: [model], pageCount: 1 });
    await settled(queued.id);
    const [summary] = await listRuns();
    expect(summary.pages[0]).not.toHaveProperty('html');
    expect(summary.pages[0]).toMatchObject({ theme: queued.themes[0], passed: 5, total: 5 });
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
    const [queued] = await startRuns({ models: [model], pageCount: 2 });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await removeRun(queued.id);
    release();
    await vi.waitFor(() => expect(store.get(queued.id).deleted).toBe(true));
    expect(store.get(queued.id).pages).toHaveLength(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
