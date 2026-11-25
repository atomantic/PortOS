import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.mock('./db.js', () => ({
  listRuns: vi.fn(async () => [...store.values()].filter((r) => !r.deleted)),
  getRun: vi.fn(async (id) => store.get(id) ?? null),
  createRun: vi.fn(async ({ backend, modelId, route = null, pageCount, themes, planPrompts, prompts }) => {
    const run = {
      id: `run-${store.size + 1}`, backend, modelId, route, pageCount, themes, planPrompts, prompts, status: 'queued',
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
vi.mock('./pageFiles.js', () => ({
  writePageFile: vi.fn(async (id, index) => `/files/${id}/${index + 1}.html`),
  ensurePageFile: vi.fn(async (run, index) => (run.pages[index]?.html ? `/files/${run.id}/${index + 1}.html` : null)),
  pageFileName: vi.fn((index) => `${index + 1}-page.html`),
  removeRunFiles: vi.fn(async () => {}),
}));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({ ok: true, release: vi.fn(async () => {}) })),
}));

vi.mock('../mtplxServerManager.js', () => ({
  getMtplxServerStatus: vi.fn(async () => ({ running: true, config: { model: 'Example/Served-MTPLX' }, cachedModels: ['Example/Served-MTPLX', 'Example/Other-MTPLX'] })),
  runOnMtplxCheckpoint: vi.fn(async (_model, fn) => fn('mtplx-example-other')),
  isMtplxProvider: vi.fn(() => false),
}));
const providers = {
  'example-api': { name: 'Example API', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' },
  'example-cli': { name: 'Example CLI', type: 'cli', command: 'claude' },
  'example-splash': {
    name: 'Example Splash', type: 'cli', command: 'claude', splashBacked: true, defaultModel: 'inkling2-mini',
    envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8001' },
  },
  'example-tui': { name: 'Example TUI', type: 'tui', command: 'claude' },
  'example-sandbox': { name: 'Example Sandbox', type: 'cli', command: 'codex' },
  'opencode-mtplx': {
    name: 'Example OpenCode MTPLX', type: 'cli', command: 'opencode', mtplxBacked: true,
    endpoint: 'http://127.0.0.1:8000/v1', models: ['mtplx-inkling-2-mini-optimized-speed'],
    args: ['run', '--model', 'some-other-model', '--variant', 'low'],
  },
};
vi.mock('../provider/providers.js', () => ({
  getProviderById: vi.fn(async (id) => (Object.hasOwn(providers, id) ? { id, enabled: true, defaultModel: 'example-default', ...providers[id] } : null)),
}));
vi.mock('../promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('../runner.js', () => ({ stopRun: vi.fn(async () => {}) }));

import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { generate } from '../modelCapabilityTests.js';
import { listActiveRenders } from '../renderActivity.js';
import { ensurePageFile, removeRunFiles, writePageFile } from './pageFiles.js';
import { getMtplxServerStatus, isMtplxProvider, runOnMtplxCheckpoint } from '../mtplxServerManager.js';
import { runPromptThroughProvider } from '../promptRunner.js';
import { getProviderById } from '../provider/providers.js';
import { htmlPagePromptParts, htmlPagePrompt } from '../../lib/htmlPageBench.js';
import { createRun, mutateRun } from './db.js';
import { listRuns, listSelectableModels, pageFile, readRun, removeRun, resumeRun, startRuns } from './index.js';

const goodPage = `<!doctype html><html><head><style>body{margin:0}</style></head><body><canvas></canvas><script>${'let a=1;'.repeat(200)}</script></body></html>`;
const model = { backend: 'ollama', modelId: 'example-coder:7b' };
const PAGES = ['A lighthouse at dusk with a sweeping beam', 'A tide-pool you can poke'];
const PLAN = 'A detailed plan for the page.';
const { planBefore } = htmlPagePromptParts();
const isPlanRequest = (prompt) => String(prompt).startsWith(planBefore);
// Every planning request answers with PLAN; page requests take the given replies in order, the last one repeating.
const replyWith = (...replies) => {
  let n = 0;
  generate.mockImplementation(async ({ prompt }) => (isPlanRequest(prompt) ? { text: PLAN } : replies[Math.min(n++, replies.length - 1)]));
};
const pagePrompts = () => generate.mock.calls.map(([args]) => args.prompt).filter((prompt) => !isPlanRequest(prompt));
const settled = (id) => vi.waitFor(async () => {
  const run = await readRun(id);
  expect(['complete', 'failed']).toContain(run.status);
  return run;
}, { timeout: 10_000 });

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  claimHeavyLocalJob.mockImplementation(async () => ({ ok: true, release: vi.fn(async () => {}) }));
  runOnMtplxCheckpoint.mockImplementation(async (_model, fn) => fn('mtplx-example-other'));
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

  it.each([
    [[{ repo: 'Example/Valid-MTPLX', valid: true }, { repo: 'Example/Partial-MTPLX', valid: false }], ['Example/Valid-MTPLX']],
    [[], []],
  ])('uses cache rows as authoritative when they are present (%j)', async (cachedModelRows, expected) => {
    getMtplxServerStatus.mockResolvedValueOnce({ cachedModelRows, cachedModels: ['Example/Partial-MTPLX'] });

    const result = await listSelectableModels();
    expect(result.models.filter(({ backend }) => backend === 'mtplx').map(({ modelId }) => modelId)).toEqual(expected);
  });
});

describe('startRuns', () => {
  it('refuses a model that is not installed before queueing anything', async () => {
    await expect(startRuns({ models: [{ backend: 'ollama', modelId: 'missing:1b' }], pages: PAGES }))
      .rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_MODEL_UNAVAILABLE' });
    expect(store.size).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('plans each page from its brief first, then sends the brief and that plan, records every prompt, and stores a scored complete run', async () => {
    replyWith({ text: `Here you go:\n\`\`\`html\n${goodPage}\n\`\`\``, timings: { tokensPerSecond: 40, completionTokens: 5200 } });
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    expect(queued.themes).toEqual(PAGES);
    expect(queued.planPrompts[0]).toContain(PAGES[0]);

    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(generate.mock.calls.map(([args]) => args.prompt)).toEqual([
      queued.planPrompts[0], htmlPagePrompt(PAGES[0], PLAN), queued.planPrompts[1], htmlPagePrompt(PAGES[1], PLAN),
    ]);
    expect(run.pages[1]).toMatchObject({ planPrompt: queued.planPrompts[1], plan: PLAN, planError: null, prompt: htmlPagePrompt(PAGES[1], PLAN) });
    expect(run.pages.map((p) => p.html)).toEqual([goodPage, goodPage]);
    expect(run.detail).toMatchObject({ verdict: 'passed', complete: 2, pageCount: 2 });
    expect(run.progress).toEqual({ done: 2, total: 2 });
    // What the gallery shows per page: when it finished, how fast, and how much the model wrote.
    expect(run.pages[0]).toMatchObject({ tokensPerSecond: 40, completionTokens: 5200, finishedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(run.pages[0].finishedAt))).toBe(false);
    // Each page is also a file, written as it is saved.
    expect(writePageFile.mock.calls).toEqual([[queued.id, 0, PAGES[0], goodPage], [queued.id, 1, PAGES[1], goodPage]]);
  });

  it('keeps a page in the record when its file cannot be written', async () => {
    replyWith({ text: goodPage, timings: null });
    writePageFile.mockRejectedValueOnce(new Error('disk full'));
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(run.pages.map((p) => p.html)).toEqual([goodPage, goodPage]);
  });

  it('keeps a page the model truncated as returned and scores the run partial', async () => {
    replyWith({ text: goodPage }, { text: goodPage.replace('</html>', '') });
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
    expect(run.pages[0]).toMatchObject({ html: '', error: 'Model returned no HTML', hitTokenLimit: true });
    expect(run.detail.verdict).toBe('failed');
  });

  it('builds the page from the brief alone when the plan step fails, and records why', async () => {
    generate.mockImplementation(async ({ prompt }) => (isPlanRequest(prompt) ? { text: 'A partial pl', error: 'plan timed out' } : { text: goodPage }));
    const [queued] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    const run = await settled(queued.id);
    expect(run.pages[0]).toMatchObject({ html: goodPage, plan: null, planError: 'plan timed out', prompt: htmlPagePrompt(PAGES[0]) });
    expect(pagePrompts()).toEqual([htmlPagePrompt(PAGES[0])]);
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

  it('drains runs already created when a later createRun fails, then clears live activity', async () => {
    generate.mockResolvedValue({ text: goodPage });
    const persist = createRun.getMockImplementation();
    createRun.mockImplementationOnce(persist).mockRejectedValueOnce(new Error('db write failed'));
    await expect(startRuns({
      models: [model, { ...model, modelId: 'example-coder:7b' }],
      pages: PAGES.slice(0, 1),
    })).rejects.toThrow('db write failed');
    expect(store.size).toBe(1);
    const [id] = [...store.keys()];
    await settled(id);
    await vi.waitFor(() => expect(listActiveRenders().filter((r) => r.kind === 'html-pages')).toHaveLength(0));
  });
});

describe('other targets', () => {
  it('switches MTPLX to a downloaded pack for the run and names the served id in each request', async () => {
    generate.mockResolvedValue({ text: goodPage });
    const [queued] = await startRuns({ models: [{ backend: 'mtplx', modelId: 'Example/Other-MTPLX' }], pages: PAGES.slice(0, 1) });
    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(runOnMtplxCheckpoint).toHaveBeenCalledWith('Example/Other-MTPLX', expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(generate.mock.calls[0][0]).toMatchObject({ backend: 'mtplx', modelId: 'mtplx-example-other' });
  });

  it.each(['example-cli', 'example-api'])('runs %s with its model and effort, no fallback, and the prompts exactly as recorded', async (providerId) => {
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => ({ text: `${prompt}\n${isPlanRequest(prompt) ? PLAN : goodPage}` }));
    const [queued] = await startRuns({ routes: [{ providerId, model: null, effort: 'high' }], pages: PAGES.slice(0, 1) });
    expect(queued).toMatchObject({ backend: 'provider', modelId: 'example-default', route: { providerId, providerName: providers[providerId].name, model: 'example-default', effort: 'high' } });
    const run = await settled(queued.id);
    expect(run.pages[0]).toMatchObject({ html: goodPage, plan: PLAN });
    expect(run).toMatchObject({ status: 'complete', error: null, detail: { verdict: 'passed', rendered: 1 } });
    // A provider route reports no token count; null, never a made-up zero.
    expect(run.pages[0]).toMatchObject({ completionTokens: null, tokensPerSecond: null });
    expect(runPromptThroughProvider.mock.calls.map(([args]) => args.prompt)).toEqual([queued.planPrompts[0], htmlPagePrompt(PAGES[0], PLAN)]);
    expect(runPromptThroughProvider.mock.calls[1][0]).toMatchObject({
      provider: expect.objectContaining({ id: providerId, type: providers[providerId].type }),
      prompt: run.pages[0].prompt, model: 'example-default', effort: 'high', allowFallback: false, toolFree: true, source: 'html-pages-bench',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['', 'I cannot generate that page.'])('fails a provider run whose page reply has no HTML (%j)', async (reply) => {
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => ({ text: isPlanRequest(prompt) ? PLAN : reply }));
    const [queued] = await startRuns({ routes: [{ providerId: 'example-api' }], pages: [PAGES[0]] });
    const run = await settled(queued.id);
    const failure = { error: 'Model returned no HTML', passed: 0, total: 6, bytes: 0 };
    expect(run).toMatchObject({
      status: 'failed',
      error: failure.error,
      pages: [{ ...failure, html: '' }],
      detail: { verdict: 'failed', rendered: 0, pages: [failure] },
    });
    expect(writePageFile).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'an exhausted first turn explains the missing page', reply: 'No page was generated.', matched: true },
    { name: 'valid HTML wins after an exhausted first turn', reply: goodPage, matched: true },
    { name: 'an unsupported response keeps the generic error', reply: 'I reached the token limit while thinking.', matched: false },
  ])('uses the selected Splash route and preserves prompts when $name', async ({ reply, matched }) => {
    const reasoningOutputLimit = matched ? { stopReason: 'max_tokens', outputTokens: 48000, thinkingTokens: 47998 } : undefined;
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => (
      isPlanRequest(prompt) ? { text: PLAN } : { text: reply, reasoningOutputLimit }
    ));
    const [queued] = await startRuns({ routes: [{ providerId: 'example-splash', effort: 'xhigh' }], pages: [PAGES[0]] });
    const run = await settled(queued.id);
    const recovered = reply === goodPage;
    const error = recovered ? null : matched
      ? 'Model returned no HTML. The first turn reached the 48000-token output limit, using 47998 tokens on thinking and returning no answer text.'
      : 'Model returned no HTML';
    expect(run).toMatchObject({
      status: recovered ? 'complete' : 'failed',
      error,
      pages: [{
        html: recovered ? goodPage : '', plan: PLAN, error,
        hitTokenLimit: matched && !recovered ? true : null,
        completionTokens: matched && !recovered ? 48000 : null,
      }],
    });
    const [[plan], [page]] = runPromptThroughProvider.mock.calls;
    const routeOptions = {
      provider: expect.objectContaining({ id: 'example-splash' }),
      model: 'inkling2-mini', effort: 'xhigh', maxTokens: 128_000, toolFree: true, allowFallback: false,
    };
    expect(plan).toMatchObject({ ...routeOptions, prompt: queued.planPrompts[0] });
    expect(plan).not.toHaveProperty('captureClaudeOutputLimit');
    expect(page).toMatchObject({ ...routeOptions, prompt: htmlPagePrompt(PAGES[0], PLAN), captureClaudeOutputLimit: true });
    expect(writePageFile).toHaveBeenCalledTimes(recovered ? 1 : 0);
  });

  it('keeps the successful page when another provider reply contains no HTML', async () => {
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => ({
      text: isPlanRequest(prompt) ? PLAN : prompt === htmlPagePrompt(PAGES[1], PLAN) ? goodPage : 'No page today.',
    }));
    const [queued] = await startRuns({ routes: [{ providerId: 'example-api' }], pages: PAGES });
    const run = await settled(queued.id);
    expect(run).toMatchObject({
      status: 'complete',
      error: null,
      pages: [{ html: '', error: 'Model returned no HTML', passed: 0 }, { html: goodPage, error: null, passed: 6 }],
      detail: { verdict: 'partial', rendered: 1, complete: 1 },
    });
    expect(writePageFile.mock.calls).toEqual([[queued.id, 1, PAGES[1], goodPage]]);
  });

  it('starts and resumes the restricted OpenCode route with the recorded selection', async () => {
    const route = { providerId: 'opencode-mtplx', model: providers['opencode-mtplx'].models[0], effort: 'xhigh' };
    runPromptThroughProvider.mockRejectedValue(new Error('CLI run timed out'));
    const [queued] = await startRuns({ routes: [route], pages: [PAGES[0]] });
    expect(await settled(queued.id)).toMatchObject({ status: 'failed', error: 'CLI run timed out', pages: [{ error: 'CLI run timed out', passed: 0 }] });
    expect(queued.route).toMatchObject(route);
    runPromptThroughProvider.mockImplementation(async ({ beforeExecute, prompt }) => {
      await beforeExecute();
      return { text: isPlanRequest(prompt) ? PLAN : goodPage };
    });
    await resumeRun(queued.id);
    const run = await settled(queued.id);
    expect(run.status).toBe('complete');
    expect(run.pages[0]).toMatchObject({ html: goodPage, plan: PLAN });
    expect(runPromptThroughProvider.mock.lastCall[0]).toMatchObject({
      provider: expect.objectContaining({ id: route.providerId, args: [] }),
      model: route.model, effort: route.effort, prompt: htmlPagePrompt(PAGES[0], PLAN),
      toolFree: true, allowFallback: false, isolateMtplxOpenCode: true,
    });
  });

  it.each([
    { type: 'tui' },
    { endpoint: 'https://example.com/v1' },
    { envVars: { OPENCODE_CONFIG_CONTENT: '{"provider":{"mtplx":{"npm":"example-adapter"}}}' } },
    { credentialBootstrap: { launchCommand: 'example-wrapper' } },
  ])('refuses an unsupported OpenCode configuration (%j)', async (override) => {
    const provider = providers['opencode-mtplx'];
    getProviderById.mockResolvedValueOnce({ ...provider, ...override });
    await expect(startRuns({ routes: [{ providerId: 'opencode-mtplx', model: provider.models[0] }], pages: [PAGES[0]] }))
      .rejects.toMatchObject({ code: 'HTML_PAGES_PROVIDER_NOT_TOOL_FREE' });
    expect(createRun).not.toHaveBeenCalled();
  });

  it('refuses an unconfigured OpenCode model before queueing', async () => {
    await expect(startRuns({ routes: [{ providerId: 'opencode-mtplx', model: 'other/unknown' }], pages: [PAGES[0]] }))
      .rejects.toMatchObject({ code: 'HTML_PAGES_PROVIDER_NOT_TOOL_FREE' });
    expect(createRun).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'tui' }, 'cannot run HTML Pages without tools'],
    [{ endpoint: 'http://127.0.0.1:8001/v1' }, 'provider changed during dispatch'],
  ])('rechecks the OpenCode route when it changes during preparation (%j)', async (change, message) => {
    const spawnHarness = vi.fn();
    runPromptThroughProvider.mockImplementation(async ({ beforeExecute }) => {
      getProviderById.mockResolvedValueOnce({ ...providers['opencode-mtplx'], enabled: true, defaultModel: 'example-default', id: 'opencode-mtplx', ...change });
      await beforeExecute();
      spawnHarness();
    });
    const [queued] = await startRuns({ routes: [{ providerId: 'opencode-mtplx', model: providers['opencode-mtplx'].models[0] }], pages: [PAGES[0]] });
    const run = await settled(queued.id);
    expect(run.status).toBe('failed');
    expect(run.pages[0].error).toContain(message);
    expect(spawnHarness).not.toHaveBeenCalled();
  });

  describe('a local MTPLX route that times out', () => {
    let home;
    const timeoutError = () => runPromptThroughProvider.mockRejectedValue(new Error('CLI run timed out after 1200s'));
    const logLine = (offsetMs, extra = {}) => JSON.stringify({ request_id: `req-${offsetMs}`, logged_at_s: (Date.now() + offsetMs) / 1000, request_model: 'example-default', request_cancelled: true, request_elapsed_s: 5, completion_tokens: 52256, request_last_user_preview: 'PRIVATE-PROMPT', ...extra });
    const runRoute = async (route = { providerId: 'example-api' }) => {
      const [queued] = await startRuns({ routes: [{ ...route, effort: 'xhigh' }], pages: PAGES.slice(0, 1) });
      return (await settled(queued.id)).pages[0];
    };
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'mtplx-home-'));
      await mkdir(join(home, 'logs'));
      vi.stubEnv('MTPLX_HOME', home);
      isMtplxProvider.mockReturnValue(true);
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      isMtplxProvider.mockReturnValue(false);
      await rm(home, { recursive: true, force: true });
    });

    it('reports reasoning with no answer when one logged request is attributable to the run', async () => {
      timeoutError();
      await writeFile(join(home, 'logs', 'request-log-8000.jsonl'), `${logLine(-3_600_000)}\n${logLine(10_000)}\n`);
      const page = await runRoute();
      expect(page.error).toBe('CLI run timed out after 1200s The run ended reasoning-only: MTPLX generated 52256 completion tokens before the deadline and no answer text was received.');
      expect(page.html).toBe('');
      expect(JSON.stringify(page)).not.toContain('PRIVATE-PROMPT');
      expect(runPromptThroughProvider.mock.calls[0][0]).toMatchObject({ model: 'example-default', effort: 'xhigh', allowFallback: false });
    });

    it('matches the served model in an OpenCode timeout even when the route model is prefixed', async () => {
      timeoutError();
      isMtplxProvider.mockReturnValue(false);
      const model = providers['opencode-mtplx'].models[0];
      await writeFile(join(home, 'logs', 'request-log-8000.jsonl'), `${logLine(10_000, { request_model: model })}\n`);
      const page = await runRoute({ providerId: 'opencode-mtplx', model: `mtplx/${model}` });
      expect(page.error).toContain('MTPLX generated 52256 completion tokens');
      expect(page.html).toBe('');
    });

    it('attributes one OpenCode request that MTPLX logs as both a cancellation and a final summary', async () => {
      timeoutError();
      const model = providers['opencode-mtplx'].models[0];
      const shared = { request_id: 'chatcmpl-cancelled', request_model: model };
      await writeFile(join(home, 'logs', 'request-log-8000.jsonl'), [
        // The just-finished plan's end timestamp is inside the clock slack,
        // but its earlier start proves it isn't the timed-out page.
        logLine(0, { request_model: model, request_cancelled: undefined, request_elapsed_s: 240 }),
        logLine(10_000, { ...shared, stream_cancelled_by_client: true, completion_tokens: 52738 }),
        logLine(10_050, { ...shared, request_cancelled: undefined, completion_tokens: 52738 }),
      ].join('\n'));
      const page = await runRoute({ providerId: 'opencode-mtplx', model });
      expect(page.error).toContain('MTPLX generated 52738 completion tokens');
      expect(page.html).toBe('');
    });

    it.each([
      ['concurrent requests', (l) => `${l(10_000)}\n${l(20_000, { request_id: 'other' })}\n`],
      ['a request another client finished normally', (l) => `${l(10_000, { request_cancelled: false })}\n`],
      ['a request that began before the run', (l) => `${l(10_000, { request_elapsed_s: 7_200 })}\n`],
      ['another model', (l) => `${l(10_000, { request_model: 'someone-else' })}\n`],
      ['no request in the window', (l) => `${l(-3_600_000)}\n`],
      ['a request that produced no tokens', (l) => `${l(10_000, { completion_tokens: 0 })}\n`],
    ])('keeps the generic timeout for %s', async (_name, log) => {
      timeoutError();
      await writeFile(join(home, 'logs', 'request-log-8000.jsonl'), log(logLine));
      expect((await runRoute()).error).toBe('CLI run timed out after 1200s');
    });

    it('keeps the generic timeout when the log is missing or the failure is not a timeout', async () => {
      timeoutError();
      expect((await runRoute()).error).toBe('CLI run timed out after 1200s');
      runPromptThroughProvider.mockRejectedValue(new Error('boom'));
      await writeFile(join(home, 'logs', 'request-log-8000.jsonl'), `${logLine(10_000)}\n`);
      expect((await runRoute()).error).toBe('boom');
    });
  });

  it('refuses a provider that is not configured before queueing anything', async () => {
    await expect(startRuns({ routes: [{ providerId: 'gone' }], pages: PAGES })).rejects.toMatchObject({ status: 409, code: 'HTML_PAGES_PROVIDER_UNAVAILABLE' });
    expect(store.size).toBe(0);
  });

  it.each(['example-tui', 'example-sandbox'])('refuses %s before queueing any target in the batch', async (providerId) => {
    await expect(startRuns({ models: [model], routes: [{ providerId }], pages: PAGES })).rejects.toMatchObject({
      status: 409, code: 'HTML_PAGES_PROVIDER_NOT_TOOL_FREE', message: expect.stringContaining('Start a new run with an API provider'),
    });
    expect(createRun).not.toHaveBeenCalled();
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('fails the saved route before dispatch if the provider becomes ineligible after admission', async () => {
    getProviderById.mockResolvedValueOnce({ id: 'example-tui', ...providers['example-cli'] });
    const [queued] = await startRuns({ routes: [{ providerId: 'example-tui' }], pages: PAGES });
    await expect(settled(queued.id)).resolves.toMatchObject({
      status: 'failed', pages: [], error: expect.stringContaining('Start a new run with an API provider'),
    });
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });
});

describe('pageFile', () => {
  it('answers a page file and its download name, written from the record if missing, and 404s a page with no HTML', async () => {
    replyWith({ text: goodPage, timings: null }, { text: 'sorry, no page', timings: null });
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    await settled(queued.id);
    await expect(pageFile(queued.id, 0)).resolves.toEqual({ path: `/files/${queued.id}/1.html`, fileName: '1-page.html' });
    expect(ensurePageFile).toHaveBeenCalledWith(expect.objectContaining({ id: queued.id }), 0);
    await expect(pageFile(queued.id, 1)).rejects.toMatchObject({ status: 404, code: 'HTML_PAGES_PAGE_NOT_FOUND' });
    await expect(pageFile('htmlpages-missing', 0)).rejects.toMatchObject({ status: 404 });
  });

  it('removes a deleted run\'s page files', async () => {
    generate.mockResolvedValue({ text: goodPage, timings: null });
    const [queued] = await startRuns({ models: [model], pages: [PAGES[0]] });
    await settled(queued.id);
    await removeRun(queued.id);
    expect(removeRunFiles).toHaveBeenCalledWith(queued.id);
  });
});

describe('listRuns', () => {
  it('returns summaries without the generated HTML, plans or prompts, while a single run read keeps them', async () => {
    replyWith({ text: goodPage });
    const [queued] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    await settled(queued.id);
    const [summary] = await listRuns();
    for (const key of ['html', 'plan', 'planPrompt', 'prompt']) expect(summary.pages[0]).not.toHaveProperty(key);
    expect(summary).not.toHaveProperty('planPrompts');
    expect(summary.pages[0]).toMatchObject({ theme: PAGES[0], passed: 6, total: 6 });
    expect((await readRun(queued.id)).pages[0]).toMatchObject({ html: goodPage, plan: PLAN });
  });
});

describe('interrupted and deleted runs', () => {
  it('reports a run left active by a previous process as failed, not as still running', async () => {
    store.set('stale', { id: 'stale', status: 'generating', deleted: false, pages: [] });
    const runs = await listRuns();
    expect(runs.find((r) => r.id === 'stale')).toMatchObject({ status: 'failed', error: expect.stringContaining('restart') });
    expect(generate).not.toHaveBeenCalled();
  });

  it('omits a cut-off run deleted before markInterrupted and still returns the rest', async () => {
    store.set('gone', { id: 'gone', status: 'queued', deleted: false, pages: [] });
    store.set('kept', { id: 'kept', status: 'complete', deleted: false, pages: [{ theme: 'kept theme', passed: 1, total: 1 }] });
    mutateRun.mockImplementationOnce(async () => {
      const err = new Error('HTML pages run not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      throw err;
    });
    const runs = await listRuns();
    expect(runs.map((r) => r.id)).toEqual(['kept']);
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

  it('drops a deleted run that is waiting on the accelerator and lets the next queued run start', async () => {
    let calls = 0;
    claimHeavyLocalJob.mockImplementation(({ signal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          const finish = () => resolve({ ok: false, aborted: true, message: 'cancelled', release: vi.fn(async () => {}) });
          if (signal?.aborted) finish();
          else signal.addEventListener('abort', finish, { once: true });
        });
      }
      return { ok: true, release: vi.fn(async () => {}) };
    });
    generate.mockResolvedValue({ text: goodPage });
    const [waiting, next] = await startRuns({ models: [model, { backend: 'ollama', modelId: 'example-coder:7b' }], pages: [PAGES[0]] });
    await vi.waitFor(() => expect(claimHeavyLocalJob).toHaveBeenCalled());
    expect(claimHeavyLocalJob.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    await removeRun(waiting.id);
    const run = await settled(next.id);
    expect(run.status).toBe('complete');
    expect(store.get(waiting.id).deleted).toBe(true);
    expect(store.get(waiting.id).status).not.toBe('failed');
    await vi.waitFor(() => expect(listActiveRenders().filter((item) => item.kind === 'html-pages')).toHaveLength(0));
  });

  it('forwards the run abort signal into an MTPLX checkpoint switch so a delete unblocks the queue', async () => {
    runOnMtplxCheckpoint.mockImplementation((_model, _fn, options) => new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('The MTPLX checkpoint switch was aborted'), { name: 'AbortError' }));
      if (options?.signal?.aborted) fail();
      else options?.signal?.addEventListener('abort', fail, { once: true });
    }));
    generate.mockResolvedValue({ text: goodPage });
    const [switching, next] = await startRuns({
      models: [{ backend: 'mtplx', modelId: 'Example/Other-MTPLX' }, model],
      pages: [PAGES[0]],
    });
    await vi.waitFor(() => expect(runOnMtplxCheckpoint).toHaveBeenCalled());
    expect(runOnMtplxCheckpoint.mock.calls[0][2]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await removeRun(switching.id);
    expect((await settled(next.id)).status).toBe('complete');
    await vi.waitFor(() => expect(listActiveRenders().filter((item) => item.kind === 'html-pages')).toHaveLength(0));
  });

  it('shows a queued or generating run in Live activity until it settles, so the updater waits for it', async () => {
    let release;
    generate.mockImplementation(({ prompt }) => (isPlanRequest(prompt)
      ? Promise.resolve({ text: PLAN })
      : new Promise((resolve) => { release = () => resolve({ text: goodPage }); })));
    const [queued] = await startRuns({ models: [model], pages: PAGES.slice(0, 1) });
    expect(listActiveRenders()).toEqual([expect.objectContaining({ kind: 'html-pages', noun: 'HTML pages run', to: '/html-pages' })]);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
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

  it('refuses to requeue a saved TUI route and keeps its stored result', async () => {
    cutOff([{ theme: PAGES[0], html: goodPage }]);
    const saved = { ...store.get('cut'), status: 'failed', route: { providerId: 'example-tui', model: 'example-default', effort: 'high' } };
    store.set('cut', saved);
    await expect(resumeRun('cut')).rejects.toMatchObject({
      status: 409, code: 'HTML_PAGES_PROVIDER_NOT_TOOL_FREE', message: expect.stringContaining('Start a new run with an API provider'),
    });
    expect(store.get('cut')).toEqual(saved);
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(listActiveRenders().filter((r) => r.kind === 'html-pages')).toHaveLength(0);
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
    replyWith({ text: goodPage }, { text: goodPage.replace('</html>', '') });
    const [queued] = await startRuns({ models: [model], pages: PAGES });
    expect((await settled(queued.id)).detail.verdict).toBe('partial');
    await vi.waitFor(() => expect(listActiveRenders().filter((r) => r.kind === 'html-pages')).toHaveLength(0));
    generate.mockClear();
    replyWith({ text: goodPage });
    await expect(resumeRun(queued.id)).resolves.toMatchObject({ status: 'queued', progress: { done: 1, total: 2 } });
    const run = await vi.waitFor(async () => {
      const current = await readRun(queued.id);
      expect(current.detail?.verdict).toBe('passed');
      return current;
    });
    expect(generate.mock.calls.map(([args]) => args.prompt)).toEqual([queued.planPrompts[1], htmlPagePrompt(PAGES[1], PLAN)]);
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
