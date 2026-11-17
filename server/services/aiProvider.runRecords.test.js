/**
 * `callProviderAISimple` as a tracked run (#16560): the real adapter, the real
 * shared runner and a real run store in a temp directory, with only the HTTP
 * transport stubbed. `aiProvider.test.js` covers the same exchange with no
 * toolkit loaded, which is the untracked leg.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { mockJsonResponse, mockTextResponse } from '../lib/testHelper.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-completion-runs-' });
const { statusOp, usage } = vi.hoisted(() => ({
  statusOp: { update: vi.fn(), complete: vi.fn(), error: vi.fn() },
  usage: { recordSession: vi.fn(async () => {}), recordRunUsage: vi.fn(async () => {}) },
}));

vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('./aiStatusEvents.js', () => ({ startAIOp: vi.fn(() => statusOp) }));
// Readiness is a managed-daemon concern; these providers are plain endpoints.
vi.mock('./providerExecutionReadiness.js', () => ({
  ensureManagedRuntimeReady: vi.fn(async () => ({ success: true })),
  ensureProviderReadyForExecution: vi.fn(async () => ({ success: true })),
}));
vi.mock('./usage.js', async (importOriginal) => ({
  ...await importOriginal(),
  recordSession: usage.recordSession,
  recordRunUsage: usage.recordRunUsage,
  getRecentCodexUsageClaims: async () => [],
}));

const { callProviderAISimple } = await import('./aiProvider.js');
const { runPromptThroughProvider } = await import('./promptRunner.js');
const { setAIToolkit, stopRun, serializeRunDeletion } = await import('./runner.js');
const { setAIToolkitInstance } = await import('../lib/aiToolkitState.js');
const { createRunnerService } = await import('../lib/aiToolkit/runner.js');
const { analyzeError, ERROR_CATEGORIES } = await import('../lib/aiToolkit/errorDetection.js');
const { recordCompletedRunUsage } = await import('./usageReconciler.js');
const { getDirectProviderCallCount } = await import('../lib/providerCallActivity.js');
const { attachLlmActivityHooks, drainActivityNotesForTests } = await import('./systemActivityNotify.js');
const { CREATIVE_LATITUDE_CLAUSE, CREATIVE_LATITUDE_HEADING } = await import('../lib/creativeLatitude.js');

const runsDir = join(tempRoot, 'runs');
// The same wiring `services/bootstrap.js` gives the toolkit: a usage session on
// create, the usage ledger on completion, activity notes on every edge.
const spies = {
  onRunCreated: vi.fn((metadata) => usage.recordSession(metadata.providerId, metadata.providerName, metadata.model)),
  onRunStarted: vi.fn(),
  // `home` is where CLI transcripts would be looked for; never the real one.
  onRunCompleted: vi.fn((metadata, output) => recordCompletedRunUsage(metadata, output, { home: tempRoot })),
  onRunFailed: vi.fn(),
  onRunCanceled: vi.fn(),
};
const hooks = attachLlmActivityHooks(spies);
// A store that knows no provider and a status service that calls every provider
// benched: a bounded completion must reach neither to decide what to send.
const providerService = { getProviderById: vi.fn(async () => null), getAllProviders: vi.fn(async () => ({ providers: [] })) };
const providerStatusService = {
  isAvailable: vi.fn(() => false),
  getStatus: vi.fn(() => ({ reason: 'rate-limit' })),
  markUnavailable: vi.fn(async () => {}),
  markUsageLimit: vi.fn(async () => {}),
  markRateLimited: vi.fn(async () => {}),
  markApiSuccess: vi.fn(async () => {}),
};
let runnerService;
const loadToolkit = () => {
  runnerService = createRunnerService({ dataDir: tempRoot, providerService, providerStatusService, hooks });
  setAIToolkit({ services: { providers: providerService, runner: runnerService, providerStatus: providerStatusService, errorDetection: { analyzeError } } }, { dataDir: tempRoot, hooks });
};

const provider = { id: 'example-api', name: 'Example API', type: 'api', endpoint: 'https://api.example.com/v1', enabled: false };
const completion = (content, extra = {}) => mockJsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }], ...extra });
const respondWith = (...replies) => {
  const fetch = vi.fn();
  for (const reply of replies) fetch.mockImplementationOnce(typeof reply === 'function' ? reply : async () => reply);
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
const runIds = async () => readdir(runsDir).catch(() => []);
const record = async () => {
  const ids = await runIds();
  expect(ids).toHaveLength(1);
  const dir = join(runsDir, ids[0]);
  return {
    id: ids[0],
    metadata: JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')),
    prompt: await readFile(join(dir, 'prompt.txt'), 'utf8'),
    output: await readFile(join(dir, 'output.txt'), 'utf8'),
  };
};
const sent = (fetch, call = 0) => {
  const [url, init] = fetch.mock.calls[call];
  return { url, method: init.method, headers: init.headers, body: init.body };
};

beforeEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  vi.clearAllMocks();
  drainActivityNotesForTests();
  loadToolkit();
});
// The completion hook stamps the record after the call has returned; let it
// finish before the next test removes the run store from under it.
const usageSettled = async () => {
  for (const id of await runIds()) {
    const metadata = JSON.parse(await readFile(join(runsDir, id, 'metadata.json'), 'utf8'));
    if (metadata.success === true) expect(metadata.usageReconciled).toBe(true);
  }
};
afterEach(async () => {
  await vi.waitFor(usageSettled);
  vi.unstubAllGlobals();
  setAIToolkitInstance(null);
});
afterAll(cleanup);

describe('the request a tracked call sends', () => {
  it.each([
    ['operational', { source: 'goal-check-in', temperature: 0.4, max_tokens: 2000 }, 'Summarize the week.'],
    ['creative', { source: 'taste-summary', temperature: 0.8, max_tokens: 200 }, `${CREATIVE_LATITUDE_CLAUSE}\n\n---\n\nSummarize the week.`],
    ['default sampling', {}, 'Summarize the week.'],
  ])('is byte-identical to the untracked request (%s)', async (_label, options, content) => {
    // Before: no toolkit, so the exchange goes out exactly as the hand-rolled
    // transport sent it. After: the same call through the shared runner.
    setAIToolkitInstance(null);
    const before = respondWith(completion('ok'));
    await callProviderAISimple({ ...provider, apiKey: 'example-key', allowCustomEndpoint: true }, 'model-1', 'Summarize the week.', options);
    loadToolkit();
    const after = respondWith(completion('ok'));
    await callProviderAISimple({ ...provider, apiKey: 'example-key', allowCustomEndpoint: true }, 'model-1', 'Summarize the week.', options);

    expect(sent(after)).toEqual(sent(before));
    expect(sent(after).url).toBe('https://api.example.com/v1/chat/completions');
    expect(sent(after).headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer example-key' });
    expect(sent(after).body).toBe(JSON.stringify({
      model: 'model-1',
      messages: [{ role: 'user', content }],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.max_tokens ?? 1000,
    }));
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('carries the latitude clause exactly once and records the prompt that was sent', async () => {
    const fetch = respondWith(completion('prose'));

    await callProviderAISimple(provider, 'model-1', 'Write the scene.', { source: 'autobiography-weave' });

    const content = JSON.parse(sent(fetch).body).messages[0].content;
    expect(content.split(CREATIVE_LATITUDE_HEADING)).toHaveLength(2);
    expect(content.endsWith('Write the scene.')).toBe(true);
    expect((await record()).prompt).toBe(content);
  });
});

describe('run record and usage for one call', () => {
  it('writes one run record, one usage session and the provider-reported counts once', async () => {
    respondWith(completion('a real answer', { usage: { prompt_tokens: 40, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 6 } } }));

    const result = await callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in', op: 'test-op', opLabel: 'Testing' });

    expect(result).toEqual({ text: 'a real answer', finishReason: 'stop', usage: { inputTokens: 34, outputTokens: 9, cacheReadTokens: 6, source: 'measured' } });
    const run = await record();
    expect(run.output).toBe('a real answer');
    expect(run.metadata).toMatchObject({
      providerId: 'example-api', providerName: 'Example API', model: 'model-1', source: 'goal-check-in',
      success: true, exitCode: 0, executionKind: 'api', finishReason: 'stop', selfContainedUsage: true,
      outputSize: Buffer.byteLength('a real answer'), promptLength: 'a prompt'.length,
    });
    expect(usage.recordSession).toHaveBeenCalledTimes(1);
    expect(usage.recordSession).toHaveBeenCalledWith('example-api', 'Example API', 'model-1');
    await vi.waitFor(() => expect(usage.recordRunUsage).toHaveBeenCalledTimes(1));
    expect(usage.recordRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'example-api', model: 'model-1', messages: 1, tokensIn: 34, tokensOut: 9, cacheReadTokens: 6, source: 'measured' }),
      expect.objectContaining({ reconciledRunId: run.id }),
    );
    expect(statusOp.complete).toHaveBeenCalledTimes(1);
    expect(statusOp.error).not.toHaveBeenCalled();
    // Exactly one of each lifecycle edge, and the run is no longer live.
    expect(spies.onRunCreated).toHaveBeenCalledTimes(1);
    expect(spies.onRunStarted).toHaveBeenCalledTimes(1);
    expect(spies.onRunCompleted).toHaveBeenCalledTimes(1);
    expect(await runnerService.getActiveRunCount()).toBe(0);
  });

  it('records an estimate, not a measured zero, when the provider reports no counts', async () => {
    respondWith(completion('a real answer'));

    const result = await callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in' });

    expect(result.usage).toBeUndefined();
    // Still stamped: a run with no counts must not go looking for CLI sessions.
    expect((await record()).metadata).toMatchObject({ selfContainedUsage: true });
    expect((await record()).metadata.reportedUsage).toBeUndefined();
    await vi.waitFor(() => expect(usage.recordRunUsage).toHaveBeenCalledTimes(1));
    expect(usage.recordRunUsage.mock.calls[0][0]).toMatchObject({ providerId: 'example-api', source: 'estimate', messages: 1 });
    expect(usage.recordRunUsage.mock.calls[0][0].tokensOut).toBeGreaterThan(0);
  });

  it('runs on the provider it was handed: no store lookup, no bench refusal, no enabled check', async () => {
    const fetch = respondWith(completion('ok'));

    const result = await callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in' });

    expect(result.text).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(providerService.getProviderById).not.toHaveBeenCalled();
    expect(providerStatusService.isAvailable).not.toHaveBeenCalled();
  });

  it('counts a live call once: as a run, not as a run plus a direct call', async () => {
    let release;
    respondWith(() => new Promise((resolve) => { release = () => resolve(completion('ok')); }));

    const pending = callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    expect(await runnerService.getActiveRunCount()).toBe(1);
    expect(getDirectProviderCallCount()).toBe(0);
    release();
    await pending;
    expect(await runnerService.getActiveRunCount()).toBe(0);
    expect(getDirectProviderCallCount()).toBe(0);
  });
});

describe('failures keep their contract', () => {
  it('returns the provider status and body unchanged, and reports the failure nowhere new', async () => {
    respondWith(mockTextResponse('boom', { ok: false, status: 500 }));

    const result = await callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in', allowModelRecovery: false });

    expect(result).toEqual({ error: 'Provider returned 500: boom', status: 500 });
    const run = await record();
    expect(run.metadata).toMatchObject({ success: false, exitCode: 1, error: 'Provider returned 500: boom', httpStatus: 500 });
    expect(run.metadata.canceled).toBeUndefined();
    expect(statusOp.error).toHaveBeenCalledTimes(1);
    expect(statusOp.error).toHaveBeenCalledWith('Provider returned 500: boom');
    // No provider-failure hook (it queues an auto-fix investigation and a second
    // error toast) and no bench: the call site reports its own failure.
    expect(spies.onRunFailed).not.toHaveBeenCalled();
    expect(providerStatusService.markUnavailable).not.toHaveBeenCalled();
    expect(providerStatusService.markRateLimited).not.toHaveBeenCalled();
    expect(usage.recordSession).toHaveBeenCalledTimes(1);
    expect(usage.recordRunUsage).not.toHaveBeenCalled();
    // The activity snapshot still learns the run ended.
    expect(drainActivityNotesForTests()).toContainEqual({ source: 'llm', phase: 'failure' });
  });

  it.each([
    ['a non-JSON 200 body', mockTextResponse('<html>502 Bad Gateway</html>'), 'Provider returned a malformed (non-JSON or unexpected) response body'],
    ['a whitespace-only completion', completion('  \n '), 'Provider returned an empty completion'],
  ])('classifies %s as an error with its original text', async (_label, reply, error) => {
    respondWith(reply);

    const result = await callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in' });

    expect(result).toEqual({ error });
    expect((await record()).metadata).toMatchObject({ success: false, error });
  });

  it('reports a deadline as the same stall message and phase', async () => {
    respondWith((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
    }));

    const result = await callProviderAISimple({ ...provider, timeout: 25 }, 'model-1', 'a prompt', { source: 'goal-check-in', allowModelRecovery: false });

    expect(result).toEqual({
      error: 'Provider request failed: This operation was aborted — timed out after 25ms before the provider sent response headers (connect or first byte)',
      stallPhase: 'no-response',
    });
    const run = await record();
    expect(run.metadata).toMatchObject({ success: false, stallPhase: 'no-response', errorCategory: ERROR_CATEGORIES.TIMEOUT });
    expect(run.metadata.canceled).toBeUndefined();
    expect(spies.onRunCanceled).not.toHaveBeenCalled();
  });

  it('refuses an endpoint the API key must not reach without sending anything', async () => {
    const fetch = respondWith(completion('ok'));

    const result = await callProviderAISimple({ ...provider, apiKey: 'example-key', endpoint: 'https://not-an-allowlisted-host.example' }, 'model-1', 'a prompt', { source: 'goal-check-in' });

    expect(result.error).toMatch(/^Provider endpoint blocked: /);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('recovery stays inside the one run', () => {
  it('loads an LM Studio model and retries without opening a second run or session', async () => {
    const fetch = vi.fn(async (url) => {
      if (url.endsWith('/chat/completions')) {
        return fetch.mock.calls.filter(([called]) => called.endsWith('/chat/completions')).length === 1
          ? mockTextResponse('No models loaded', { ok: false, status: 400 })
          : completion('recovered');
      }
      if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ type: 'llm', id: 'loaded-model', state: 'not-loaded' }] }) };
      return mockTextResponse('');
    });
    vi.stubGlobal('fetch', fetch);

    const result = await callProviderAISimple({ ...provider, defaultModel: 'loaded-model' }, 'asked-model', 'a prompt', { source: 'goal-check-in' });

    expect(result).toMatchObject({ text: 'recovered' });
    const completions = fetch.mock.calls.filter(([url]) => url.endsWith('/chat/completions'));
    expect(completions.map(([, init]) => JSON.parse(init.body).model)).toEqual(['asked-model', 'loaded-model']);
    const run = await record();
    expect(run.metadata).toMatchObject({ success: true, model: 'loaded-model' });
    expect(usage.recordSession).toHaveBeenCalledTimes(1);
    expect(spies.onRunCompleted).toHaveBeenCalledTimes(1);
    expect(statusOp.complete).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: 'loaded-model' }));
  });
});

describe('cancellation', () => {
  const hangUntilAborted = () => {
    let requestSignal;
    const fetch = respondWith((_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
      });
    });
    return { fetch, signal: () => requestSignal };
  };

  it('stops the in-flight request when the caller aborts, and records a cancel', async () => {
    const request = hangUntilAborted();
    const caller = new AbortController();

    const pending = callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'code-review', signal: caller.signal, allowModelRecovery: false });
    await vi.waitFor(() => expect(request.signal()).toBeDefined());
    expect(request.signal().aborted).toBe(false);
    caller.abort();
    const result = await pending;

    expect(request.signal().aborted).toBe(true);
    expect(result).toEqual({ error: 'Provider request failed: This operation was aborted', canceled: true });
    const run = await record();
    expect(run.metadata).toMatchObject({ success: false, canceled: true, completionReason: 'canceled', errorCategory: ERROR_CATEGORIES.CANCELED });
    await vi.waitFor(() => expect(spies.onRunCanceled).toHaveBeenCalledWith({ runId: run.id }));
    expect(spies.onRunFailed).not.toHaveBeenCalled();
    expect(await runnerService.getActiveRunCount()).toBe(0);
  });

  it('stops from the Runs page: stopRun aborts the same request', async () => {
    const request = hangUntilAborted();

    const pending = callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in', allowModelRecovery: false });
    await vi.waitFor(() => expect(request.signal()).toBeDefined());
    const [runId] = await runIds();
    expect(await stopRun(runId)).toBe(true);
    const result = await pending;

    expect(request.signal().aborted).toBe(true);
    // No caller signal fired here, so `canceled` is the only way a caller can
    // tell an operator Stop from a provider failure.
    expect(result).toEqual({ error: 'Provider request failed: This operation was aborted', canceled: true });
    expect((await record()).metadata).toMatchObject({ canceled: true });
  });

  it('deleting a live run stops it and leaves it deleted', async () => {
    const request = hangUntilAborted();

    const pending = callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in', allowModelRecovery: false });
    await vi.waitFor(() => expect(request.signal()).toBeDefined());
    const [runId] = await runIds();
    // Deletion shares the finalizer's per-run turn, as `services/bootstrap.js` wires it.
    const deleteRun = serializeRunDeletion(runnerService.deleteRun.bind(runnerService));
    expect(await deleteRun(runId)).toBe(true);
    const result = await pending;

    expect(request.signal().aborted).toBe(true);
    expect(result).toMatchObject({ canceled: true });
    // The aborted request finalizes after the directory is gone; it must not
    // write an anonymous record back.
    expect(await runIds()).toEqual([]);
  });

  it('stops a model load in progress and sends no retry', async () => {
    let loadSignal;
    const fetch = vi.fn(async (url, init) => {
      if (url.endsWith('/chat/completions')) return mockTextResponse('No models loaded', { ok: false, status: 400 });
      if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ type: 'llm', id: 'loaded-model', state: 'not-loaded' }] }) };
      loadSignal = init.signal;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetch);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pending = callProviderAISimple({ ...provider, defaultModel: 'loaded-model' }, 'asked-model', 'a prompt', { source: 'goal-check-in' });
    await vi.waitFor(() => expect(loadSignal).toBeDefined());
    const [runId] = await runIds();
    expect(await stopRun(runId)).toBe(true);
    const result = await pending;

    expect(loadSignal.aborted).toBe(true);
    expect(result).toEqual({ error: 'Provider returned 400: No models loaded', status: 400, canceled: true });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/chat/completions'))).toHaveLength(1);
    expect((await record()).metadata).toMatchObject({ canceled: true, success: false });
    // A Stop is not a failed load: nothing on stderr to investigate.
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('sends nothing and opens no run when the signal is already aborted', async () => {
    const fetch = respondWith(completion('ok'));
    const caller = new AbortController();
    caller.abort();

    const result = await callProviderAISimple(provider, 'model-1', 'a prompt', { source: 'goal-check-in', signal: caller.signal });

    expect(result).toEqual({ error: 'Provider request deadline expired.' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await runIds()).toEqual([]);
  });
});

describe('runPromptThroughProvider completion requests', () => {
  it('refuses a non-API provider before any run is created', async () => {
    await expect(runPromptThroughProvider({
      provider: { id: 'example-cli', type: 'cli' }, prompt: 'a prompt', source: 'goal-check-in', completion: {},
    })).rejects.toThrow('a completion request needs an API provider');
    expect(await runIds()).toEqual([]);
  });

  it('refuses options only the streamed path implements instead of dropping them', async () => {
    const fetch = respondWith(completion('ok'));

    await expect(runPromptThroughProvider({
      provider, prompt: 'a prompt', source: 'goal-check-in', completion: {},
      beforeExecute: async () => { throw new Error('budget spent'); }, callerPolicy: 'example-policy', screenshots: ['example.png'],
      allowFallback: false,
    })).rejects.toThrow('a completion request does not support beforeExecute, callerPolicy, screenshots, allowFallback');
    expect(fetch).not.toHaveBeenCalled();
    expect(await runIds()).toEqual([]);
  });

  it('refuses a signal on a streamed run rather than ignoring it', async () => {
    await expect(runPromptThroughProvider({
      provider, prompt: 'a prompt', source: 'goal-check-in', signal: new AbortController().signal,
    })).rejects.toThrow('signal is honoured only for completion requests');
    expect(await runIds()).toEqual([]);
  });

  it('resolves with the run id and rejects with the reply detail a caller needs', async () => {
    respondWith(completion('ok'), mockTextResponse('slow down', { ok: false, status: 429 }));

    const ok = await runPromptThroughProvider({ provider, prompt: 'a prompt', source: 'goal-check-in', model: 'model-1', completion: { temperature: 0, maxTokens: 32 } });
    expect(ok).toMatchObject({ text: 'ok', model: 'model-1', retried: false, runId: expect.any(String) });

    const failure = await runPromptThroughProvider({ provider, prompt: 'a prompt', source: 'goal-check-in', model: 'model-1', completion: { temperature: 0, maxTokens: 32 } }).catch((err) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Provider returned 429: slow down');
    expect(failure.completionFailure).toEqual({ error: 'Provider returned 429: slow down', status: 429, body: 'slow down', model: 'model-1', retried: false });
    expect(failure.runId).not.toBe(ok.runId);
  });
});


describe('tracked ChatGPT subscription calls', () => {
  const subscription = { id: 'codex', name: 'Codex', type: 'cli', command: 'codex', enabled: true,
    textTransport: 'codex-app-server', textTransportEnabled: true, textTransportReadRiskAcknowledged: true,
    defaultModel: 'example-codex', effort: 'high' };
  let transport;
  beforeEach(async () => {
    transport = await import('./codexAppServer.js');
    vi.spyOn(transport, 'getCodexTextTransportBench').mockReturnValue(null);
    vi.spyOn(transport, 'runCodexTextTurn');
    vi.spyOn(transport, 'benchCodexTextTransport');
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['api', 'subscription'])('honors Stop as soon as the %s record is published, before dispatch', async (kind) => {
    let stopped;
    spies.onRunCreated.mockImplementationOnce(metadata => {
      void usage.recordSession(metadata.providerId, metadata.providerName, metadata.model);
      stopped = stopRun(metadata.id);
    });
    const fetch = respondWith(completion('unexpected answer'));
    transport.runCodexTextTurn.mockImplementation(({ signal }) => {
      if (signal.aborted) throw Object.assign(new Error('The Codex turn was cancelled.'), { code: 'CODEX_TURN_INTERRUPTED' });
      return Promise.resolve({ text: 'unexpected answer' });
    });
    const result = await callProviderAISimple(kind === 'api' ? provider : subscription, 'example-model', 'Summarize.');
    expect(await stopped).toBe(true);
    expect(result).toMatchObject({ canceled: true });
    expect(fetch).not.toHaveBeenCalled();
    expect((await record()).metadata).toMatchObject({ canceled: true, success: false });
    expect(spies.onRunFailed).not.toHaveBeenCalled();
  });

  it('records the exact stamped prompt and effective effort, opens one session and bills ephemeral tokens once', async () => {
    transport.runCodexTextTurn.mockImplementation(async () => {
      expect(await runnerService.getActiveRunCount()).toBe(1);
      expect(getDirectProviderCallCount()).toBe(0);
      return { text: 'subscription answer', model: 'effective-codex', effort: 'medium', effortClamped: true,
        clampReason: 'example clamp', usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3 } };
    });
    const result = await callProviderAISimple(subscription, subscription.defaultModel, 'Describe a landscape.', { source: 'taste-summary' });
    expect(result).toMatchObject({ text: 'subscription answer', effort: 'medium', effortClamped: true });
    const run = await record();
    expect(run.prompt).toBe(transport.runCodexTextTurn.mock.calls[0][0].prompt);
    expect(run.prompt.split(CREATIVE_LATITUDE_HEADING)).toHaveLength(2);
    expect(run.output).toBe(result.text);
    expect(run.metadata).toMatchObject({ success: true, source: 'taste-summary', model: 'effective-codex', effort: 'medium',
      selfContainedUsage: true, nativeUsageUnpersisted: true, reportedUsage: { tokensIn: 8, tokensOut: 3, cacheReadTokens: 4 } });
    expect(usage.recordSession).toHaveBeenCalledTimes(1);
    expect(spies.onRunCompleted).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(usage.recordRunUsage).toHaveBeenCalledTimes(1));
    expect(usage.recordRunUsage.mock.calls[0][0]).toMatchObject({ tokensIn: 8, tokensOut: 3, cacheReadTokens: 4, nativeUsageUnpersisted: true, source: 'measured' });
  });

  it('finalizes a failed subscription attempt before an explicit API fallback opens its own run', async () => {
    const fallback = { ...provider, enabled: true };
    providerService.getAllProviders.mockResolvedValueOnce({ providers: [subscription, fallback] });
    transport.runCodexTextTurn.mockRejectedValue(Object.assign(new Error('Subscription limit reached.'), { code: 'CODEX_TURN_RATE_LIMIT' }));
    respondWith(completion('fallback answer', { usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    const result = await callProviderAISimple({ ...subscription, fallbackProvider: fallback.id }, 'example-codex', 'Summarize.', { source: 'goal-check-in' });
    expect(result).toMatchObject({ text: 'fallback answer' });
    const ids = await runIds();
    expect(ids).toHaveLength(2);
    const records = await Promise.all(ids.map(async id => JSON.parse(await readFile(join(runsDir, id, 'metadata.json'), 'utf8'))));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'codex', success: false, error: 'Subscription limit reached.' }),
      expect.objectContaining({ providerId: fallback.id, success: true }),
    ]));
    expect(usage.recordSession).toHaveBeenCalledTimes(2);
    expect(spies.onRunFailed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(usage.recordRunUsage).toHaveBeenCalledTimes(1));
  });

  it.each(['Stop', 'caller abort', 'delete'])('interrupts the turn for %s and records cancellation without benching or fallback', async (action) => {
    const caller = new AbortController();
    transport.runCodexTextTurn.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('The Codex turn was cancelled.'), { code: 'CODEX_TURN_INTERRUPTED' })), { once: true });
    }));
    const pending = callProviderAISimple({ ...subscription, fallbackProvider: 'example-api' }, 'example-codex', 'Summarize.', { signal: caller.signal });
    await vi.waitFor(() => expect(transport.runCodexTextTurn).toHaveBeenCalledTimes(1));
    const [id] = await runIds();
    if (action === 'caller abort') caller.abort();
    else if (action === 'delete') await serializeRunDeletion(runnerService.deleteRun.bind(runnerService))(id);
    else await stopRun(id);
    expect(await pending).toEqual({ error: 'The Codex turn was cancelled.', canceled: true });
    if (action === 'delete') expect(await runIds()).toEqual([]);
    else expect((await record()).metadata).toMatchObject({ success: false, canceled: true, completionReason: 'canceled', errorCategory: ERROR_CATEGORIES.CANCELED });
    expect(transport.benchCodexTextTransport).not.toHaveBeenCalled();
    expect(spies.onRunFailed).not.toHaveBeenCalled();
  });
});
