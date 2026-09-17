import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import EventEmitter from 'events';
import { ChildProcess } from 'child_process';

const IS_WIN32 = process.platform === 'win32';

/**
 * An external run's spawned handle. The prototype matters: killProcessTree
 * tells a spawned child from a node-pty session by `instanceof ChildProcess`,
 * and a plain object would silently exercise the pty branch.
 */
const externalChild = () =>
  Object.assign(Object.create(ChildProcess.prototype), { kill: vi.fn(), killed: false });

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

const { spawn } = await import('child_process');
const { createRunnerService } = await import('./runner.js');

describe('AI Toolkit runner service', () => {
  const tempDirs = [];

  afterEach(async () => {
    // Before restoreAllMocks: a spy restored while the clock is still faked is
    // reinstalled onto the faked globals, so the next test inherits a timer
    // that never fires. No-op when the test used real timers.
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes request capability requirements to proactive fallback selection', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const primary = { id: 'primary', name: 'Primary', type: 'api', enabled: true };
    const fallback = { id: 'fallback', name: 'Fallback', type: 'api', enabled: true, defaultModel: 'vision' };
    const providerService = {
      getAllProviders: vi.fn().mockResolvedValue({ providers: [primary, fallback] }),
      getProviderById: vi.fn(async (id) => (id === fallback.id ? fallback : primary)),
    };
    const providerStatusService = {
      isAvailable: vi.fn().mockReturnValue(false),
      getFallbackProvider: vi.fn().mockReturnValue({ provider: fallback, source: 'system', model: null }),
      getStatus: vi.fn().mockReturnValue({ reason: 'rate-limit' }),
      getTimeUntilRecovery: vi.fn().mockReturnValue('1m'),
    };
    const runner = createRunnerService({ dataDir, providerService, providerStatusService });
    const requestCapabilities = { hasImages: true, requiredContextTokens: 12_000 };

    const result = await runner.createRun({
      providerId: primary.id,
      prompt: 'describe',
      requestCapabilities,
    });

    expect(result.provider.id).toBe(fallback.id);
    expect(providerStatusService.getFallbackProvider).toHaveBeenCalledWith(
      primary.id, expect.any(Object), null, null, requestCapabilities,
    );
  });

  it('refuses proactive fallback when an exact provider is required', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const primary = { id: 'primary', name: 'Primary', type: 'api', enabled: true };
    const providerService = {
      getAllProviders: vi.fn().mockResolvedValue({ providers: [primary] }),
      getProviderById: vi.fn().mockResolvedValue(primary),
    };
    const providerStatusService = {
      isAvailable: vi.fn().mockReturnValue(false),
      getFallbackProvider: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ reason: 'rate-limit' }),
    };
    const runner = createRunnerService({ dataDir, providerService, providerStatusService });

    await expect(runner.createRun({
      providerId: primary.id,
      prompt: 'stay pinned',
      allowFallback: false,
    })).rejects.toThrow('fallback is disabled');
    expect(providerStatusService.getFallbackProvider).not.toHaveBeenCalled();
    expect(providerService.getAllProviders).not.toHaveBeenCalled();
  });

  it('derives request capabilities for direct and pre-created runs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const primary = { id: 'primary', name: 'Primary', type: 'api', enabled: true };
    const fallback = { id: 'fallback', name: 'Fallback', type: 'api', enabled: true };
    const providerService = {
      getAllProviders: vi.fn().mockResolvedValue({ providers: [primary, fallback] }),
      getProviderById: vi.fn(async (id) => (id === fallback.id ? fallback : primary)),
    };
    const providerStatusService = {
      isAvailable: vi.fn().mockReturnValue(false),
      getFallbackProvider: vi.fn().mockReturnValue({ provider: fallback, source: 'system', model: null }),
      getStatus: vi.fn().mockReturnValue({ reason: 'rate-limit' }),
      getTimeUntilRecovery: vi.fn().mockReturnValue('1m'),
    };
    const runner = createRunnerService({ dataDir, providerService, providerStatusService });

    await runner.createRun({
      providerId: primary.id,
      prompt: '12345678',
      screenshots: ['image.png'],
    });

    expect(providerStatusService.getFallbackProvider).toHaveBeenCalledWith(
      primary.id,
      expect.any(Object),
      null,
      null,
      { hasImages: true, requiredContextTokens: 8002 },
    );
  });

  it('checks provider readiness through the injected hook before API fetches', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    const provider = {
      id: 'ollama',
      name: 'Ollama',
      endpoint: 'http://localhost:11434/v1',
      defaultModel: 'llama3'
    };
    const ensureProviderReady = vi.fn(async () => ({
      success: false,
      error: "Ollama CLI is not installed or is not on PortOS's PATH. Install Ollama from https://ollama.com/download, then restart PortOS."
    }));
    const onComplete = vi.fn();
    const onRunFailed = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const runner = createRunnerService({
      dataDir,
      hooks: {
        ensureProviderReady,
        onRunFailed
      }
    });

    await runner.executeApiRun({
      runId: 'run-ready-hook',
      provider,
      model: null,
      prompt: 'hello',
      workspacePath: process.cwd(),
      screenshots: [],
      onData: undefined,
      onComplete
    });

    expect(ensureProviderReady).toHaveBeenCalledWith(provider);
    expect(fetch).not.toHaveBeenCalled();
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false }));

    const metadata = JSON.parse(
      await readFile(join(dataDir, 'runs', 'run-ready-hook', 'metadata.json'), 'utf8')
    );
    expect(metadata).toMatchObject({
      success: false,
      error: "Ollama CLI is not installed or is not on PortOS's PATH. Install Ollama from https://ollama.com/download, then restart PortOS.",
      errorCategory: 'spawn-error'
    });
  });

  it('classifies an injected missing-key prerequisite as an authentication failure', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const provider = {
      id: 'nvidia-kimi',
      name: 'NVIDIA Kimi K2.5',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'moonshotai/kimi-k2.5',
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const runner = createRunnerService({
      dataDir,
      hooks: {
        ensureProviderReady: async () => ({
          success: false,
          error: 'Authentication unavailable for NVIDIA Kimi K2.5: API key is not set.',
        }),
      },
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });

    await runner.executeApiRun({
      runId: 'run-missing-api-key',
      provider,
      model: null,
      prompt: 'hello',
      workspacePath: process.cwd(),
      screenshots: [],
      onData: undefined,
      onComplete: done,
    });

    await expect(completed).resolves.toMatchObject({
      success: false,
      errorCategory: 'auth-error',
      errorAnalysis: expect.objectContaining({
        actionable: true,
        requiresFallback: true,
      }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records the nested cause of a pre-header transport failure', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const socketError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 192.0.2.10:8000' },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(socketError));

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });

    await runner.executeApiRun({
      runId: 'run-transport-failure',
      provider: runReady({ endpoint: 'https://api.example.com/v1' }),
      model: null,
      prompt: 'hello',
      workspacePath: process.cwd(),
      screenshots: [],
      onData: undefined,
      onComplete: (metadata) => done(metadata)
    });

    await expect(completed).resolves.toMatchObject({
      success: false,
      errorCategory: 'network-error',
      error: expect.stringContaining('ECONNREFUSED')
    });
  });

  const stubStreamingFetch = () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n`),
      encoder.encode('data: [DONE]\n')
    ];
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined })
      })
    };
    const fetch = vi.fn(async () => ({ ok: true, body }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  const runReady = (overrides = {}) => ({
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    ...overrides
  });

  it('forwards normalized 429 headers to provider status', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'Retry-After': '15', 'X-RateLimit-Remaining': '0' }),
      text: async () => 'rate limited',
    })));
    const markRateLimited = vi.fn(async () => {});
    const runner = createRunnerService({
      dataDir,
      providerStatusService: { markRateLimited },
      hooks: { ensureProviderReady: async () => ({ success: true }) },
    });

    await runner.executeApiRun({
      runId: 'run-rate-limit-headers', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: vi.fn(),
    });

    expect(markRateLimited).toHaveBeenCalledWith('ollama', {
      rateLimitWindow: expect.objectContaining({ retryAfterMs: 15000, remaining: 0 }),
    });
    expect(JSON.stringify(markRateLimited.mock.calls)).not.toContain('Retry-After');
  });

  it('keeps a successful generation successful when telemetry clearing fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    stubStreamingFetch();
    const markApiSuccess = vi.fn(async () => { throw new Error('status disk unavailable'); });
    const runner = createRunnerService({
      dataDir,
      providerStatusService: { markApiSuccess },
      hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-telemetry-failure', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(markApiSuccess).toHaveBeenCalledWith('ollama');
    expect(metadata.success).toBe(true);
  });

  it('keeps a successful generation successful with a partial provider status service', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    stubStreamingFetch();
    const runner = createRunnerService({
      dataDir,
      providerStatusService: { markRateLimited: vi.fn(async () => {}) },
      hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-partial-status-service', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });

    expect(await completed).toMatchObject({ success: true });
  });

  it('keeps a rate-limit failure compatible with a partial provider status service', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'Retry-After': '5' }),
      text: async () => 'rate limited',
    })));
    const runner = createRunnerService({
      dataDir,
      providerStatusService: { markApiSuccess: vi.fn() },
      hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    const onComplete = vi.fn();

    await runner.executeApiRun({
      runId: 'run-partial-status-error', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete,
    });

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('sends num_ctx in the request body when the provider opts in', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({ runId: 'run-numctx', provider: runReady({ numCtx: 32768 }), model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done() });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).num_ctx).toBe(32768);
  });

  it('sends configured Ollama temperature and thinking mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();
    const runner = createRunnerService({ dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) } });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({ runId: 'run-ollama-options', provider: runReady({ temperature: 0.6, thinking: false }), model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done() });
    await completed;

    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ temperature: 0.6, think: false });
  });

  it('sends llama.cpp its temperature/top_p and routes thinking through the chat template', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();
    const runner = createRunnerService({ dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) } });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-llama-options',
      // A llama.cpp endpoint, so the ollama-shaped `think` flag would be dropped.
      provider: runReady({ id: 'llama', endpoint: 'http://127.0.0.1:5568/v1', llamaBacked: true, temperature: 0.2, topP: 0.9, thinking: true }),
      model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done(),
    });
    await completed;

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.9, chat_template_kwargs: { enable_thinking: true } });
    expect(body.think).toBeUndefined();
  });

  it('sends a vLLM endpoint its temperature/top_p and routes thinking through the chat template', async () => {
    // No vLLM `api` preset ships (the container is reached through the OpenCode
    // wrappers), but the guard here mirrors `generationControlsFor` on the
    // client — which now offers the controls — so a hand-built endpoint record
    // must not be the one place they are silently dropped again (#4765).
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();
    const runner = createRunnerService({ dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) } });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-vllm-options',
      provider: runReady({ id: 'vllm', endpoint: 'http://127.0.0.1:18020/v1', vllmBacked: true, temperature: 0.7, topP: 0.9, thinking: false }),
      model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done(),
    });
    await completed;

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ temperature: 0.7, top_p: 0.9, chat_template_kwargs: { enable_thinking: false } });
    expect(body.think).toBeUndefined();
  });

  it('sends a cloud provider no sampling fields at all', async () => {
    // Widening the editor must not start re-shaping hosted models' output.
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();
    const runner = createRunnerService({ dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) } });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-cloud-options',
      provider: runReady({ id: 'openai', endpoint: 'https://api.example.com/v1', temperature: 0.6, topP: 0.9, thinking: true }),
      model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done(),
    });
    await completed;

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.think).toBeUndefined();
  });

  it('omits num_ctx when the provider does not set it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({ runId: 'run-no-numctx', provider: runReady(), model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done() });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect('num_ctx' in JSON.parse(fetch.mock.calls[0][1].body)).toBe(false);
  });

  it('retries a transient gateway response before the API stream starts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const cancel = vi.fn(async () => {});
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n')];
    let index = 0;
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, body: { cancel } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true } }) },
      });
    vi.stubGlobal('fetch', fetch);

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-pre-header-retry', provider: runReady(), model: null,
      prompt: 'hi', workspacePath: process.cwd(), screenshots: [],
      onData: undefined, onComplete: (metadata) => done(metadata),
    });

    await expect(completed).resolves.toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('anchors relative screenshot refs under screenshotsDir so `../` traversal cannot escape it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    const screenshotsDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-shots-'));
    const secretsDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-secret-'));
    tempDirs.push(dataDir, screenshotsDir, secretsDir);

    // A legitimate in-dir screenshot, plus a secret sitting one level up that a
    // relative `../`-traversal would try to read off disk.
    await writeFile(join(screenshotsDir, 'valid.png'), 'PNGDATA');
    await writeFile(join(secretsDir, 'secret.png'), 'TOPSECRET');

    const fetch = stubStreamingFetch();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const runner = createRunnerService({
      dataDir,
      screenshotsDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });

    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-screenshot-guard',
      provider: runReady(),
      model: null,
      prompt: 'describe these',
      workspacePath: process.cwd(),
      // The loader applies basename() to relative refs, so this `../`-traversal
      // collapses to `secret.png` under screenshotsDir (absent there) instead of
      // reading the real sibling file it points at.
      screenshots: ['valid.png', `../${basename(secretsDir)}/secret.png`],
      onData: undefined,
      onComplete: () => done()
    });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    const sentContent = JSON.parse(fetch.mock.calls[0][1].body).messages[0].content;
    const imageParts = sentContent.filter((p) => p.type === 'image_url');
    // Only the valid in-dir screenshot is forwarded; the traversal entry
    // collapses to a basename that isn't present in screenshotsDir and is
    // skipped.
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0].image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    // The secret file's contents are never base64-encoded into the payload.
    const secretB64 = Buffer.from('TOPSECRET').toString('base64');
    expect(JSON.stringify(sentContent)).not.toContain(secretB64);

    errSpy.mockRestore();
  });

  it('times out a hung API run: aborts the fetch and releases activeRuns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    // Simulate a provider that opens the stream then stalls forever — the
    // reader only settles when the run's AbortController fires. Without the
    // wall-clock timeout this would hold `activeRuns` open indefinitely.
    const fetch = vi.fn(async (_url, opts) => {
      const { signal } = opts;
      const body = {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            if (signal.aborted) return fail();
            signal.addEventListener('abort', fail, { once: true });
          }),
          cancel: async () => {}
        })
      };
      return { ok: true, body };
    });
    vi.stubGlobal('fetch', fetch);

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });

    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-timeout',
      provider: runReady(),
      model: null,
      prompt: 'hi',
      workspacePath: process.cwd(),
      screenshots: [],
      timeout: 20,
      onData: undefined,
      onComplete: (m) => done(m)
    });

    // The stream is still hanging, so the run is active until the timer fires.
    expect(await runner.isRunActive('run-timeout')).toBe(true);

    const metadata = await completed;
    // Timeout aborted the run, and the slot is released — not leaked.
    expect(await runner.isRunActive('run-timeout')).toBe(false);
    // The failure is classified as a timeout, not the AbortError's UNKNOWN/HTTP 0.
    expect(metadata).toMatchObject({ success: false, errorCategory: 'timeout' });
    expect(metadata.error).toMatch(/timed out/i);
    // Hosts read `errorAnalysis`, not `errorCategory` — with only the latter set,
    // every API timeout reached the host's failure hook as an uncategorized
    // failure and was escalated for investigation instead of read as a timeout.
    expect(metadata.errorAnalysis).toMatchObject({ hasError: true, category: 'timeout' });
    // Which of the two ceilings ended it. A provider that went quiet is a
    // bench candidate; one that outran the absolute cap while producing is not,
    // so the host's classifier must be able to tell them apart without prose.
    expect(metadata.timeoutBound).toBe('stall');
    expect(metadata.error).toMatch(/no stream progress/i);
  });

  it('bounds a run whose provider-readiness hook never resolves (fetch never reached)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    // ensureProviderReady hangs forever — the run never reaches the abortable
    // fetch, so aborting the controller alone can't release the slot. The
    // wall-clock timer must finalize the run independently.
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: () => new Promise(() => {}) }
    });

    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    // Do NOT await the run promise — with a readiness hook that never resolves,
    // `executeApiRun` never returns. `activeRuns.set` runs synchronously before
    // the first await, so the slot is already occupied; completion comes only
    // from the wall-clock timer via onComplete.
    runner.executeApiRun({
      runId: 'run-hung-setup',
      provider: runReady(),
      model: null,
      prompt: 'hi',
      workspacePath: process.cwd(),
      screenshots: [],
      timeout: 20,
      onData: undefined,
      onComplete: (m) => done(m)
    }).catch(() => {});

    expect(await runner.isRunActive('run-hung-setup')).toBe(true);
    const metadata = await completed;
    expect(fetch).not.toHaveBeenCalled();
    expect(await runner.isRunActive('run-hung-setup')).toBe(false);
    expect(metadata).toMatchObject({ success: false, errorCategory: 'timeout' });
  });

  // A Stop of an API run reaches the finalizer as Node's bare
  // `AbortError: This operation was aborted` — a string no error pattern
  // matches. Classified as UNKNOWN it fired the host's failure hook, which
  // escalates to a tier-4 investigation task: a post-mortem over a human
  // pressing Stop. CLI/TUI runs already finalize a Stop as `canceled`.
  it('finalizes a mid-stream Stop as canceled, without firing the failure hook', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    const fetch = vi.fn(async (_url, opts) => {
      const { signal } = opts;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise((_resolve, reject) => {
              // Reject with the signal's own reason, exactly as undici does —
              // for a reason-less `abort()` that is Node's DOMException whose
              // message is "This operation was aborted".
              const fail = () => reject(signal.reason);
              if (signal.aborted) return fail();
              signal.addEventListener('abort', fail, { once: true });
            }),
            cancel: async () => {}
          })
        }
      };
    });
    vi.stubGlobal('fetch', fetch);

    const onRunFailed = vi.fn();
    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }), onRunFailed }
    });

    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-stopped',
      provider: runReady(),
      model: null,
      prompt: 'hi',
      workspacePath: process.cwd(),
      screenshots: [],
      // Far beyond the test's lifetime, so a timeout can't be what finalizes it.
      timeout: 600_000,
      onData: undefined,
      onComplete: (m) => done(m)
    });

    expect(await runner.stopRun('run-stopped')).toBe(true);

    const metadata = await completed;
    expect(metadata).toMatchObject({
      success: false,
      canceled: true,
      completionReason: 'canceled',
      errorCategory: 'canceled',
    });
    // A cancellation is evidence about the operator, not the provider: no
    // failure hook, so nothing benches the provider or escalates a task.
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(await runner.isRunActive('run-stopped')).toBe(false);
    // Persisted too — /runs replays the record, not the in-memory result.
    const persisted = JSON.parse(await readFile(join(dataDir, 'runs', 'run-stopped', 'metadata.json'), 'utf-8'));
    expect(persisted).toMatchObject({ canceled: true, errorCategory: 'canceled' });
  });

  it('finalizes a Stop that lands before the response headers as canceled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    // The provider never sends headers, so the abort rejects `fetch` itself and
    // the run finalizes through the non-OK branch rather than the stream reader.
    const fetch = vi.fn((_url, opts) => new Promise((_resolve, reject) => {
      const { signal } = opts;
      const fail = () => reject(signal.reason);
      if (signal.aborted) return fail();
      signal.addEventListener('abort', fail, { once: true });
    }));
    vi.stubGlobal('fetch', fetch);

    const onRunFailed = vi.fn();
    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }), onRunFailed }
    });

    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    // `fetch` never settles until the stop, so `executeApiRun` does not return
    // on its own — the run is registered synchronously before the first await.
    runner.executeApiRun({
      runId: 'run-stopped-early',
      provider: runReady(),
      model: null,
      prompt: 'hi',
      workspacePath: process.cwd(),
      screenshots: [],
      timeout: 600_000,
      onData: undefined,
      onComplete: (m) => done(m)
    }).catch(() => {});

    // Let the readiness hook resolve so the run is parked inside `fetch`.
    await Promise.resolve();
    expect(await runner.stopRun('run-stopped-early')).toBe(true);

    const metadata = await completed;
    expect(metadata).toMatchObject({
      success: false,
      canceled: true,
      errorCategory: 'canceled',
    });
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(await runner.isRunActive('run-stopped-early')).toBe(false);
  });

  // The stop marker is one-shot and describes only the run that was in flight
  // when Stop was pressed. A Stop that loses the race to the last chunk (it
  // lands while the final `read()` is still awaited, so the run is registered
  // but the success path has not released it yet) must neither retro-cancel
  // the answer that was delivered nor leak into a later run of the same id.
  it('drops a stop marker that lost the race to the final chunk', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    let runner;
    let stopDuringFinalRead = true;
    // Recorded, not asserted inline: a throw inside the reader would reject the
    // stream and be reported as a cancel/failure rather than a test failure.
    let stopAccepted = null;
    const frame = (text) => new TextEncoder()
      .encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`);
    vi.stubGlobal('fetch', vi.fn(async () => {
      let sent = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) {
                // Stop lands inside the await boundary that precedes the
                // success finalizer, while `activeRuns` still holds the run.
                if (stopDuringFinalRead) {
                  stopDuringFinalRead = false;
                  stopAccepted = await runner.stopRun('run-reused');
                }
                return { done: true };
              }
              sent = true;
              return { done: false, value: frame('answer') };
            },
            cancel: async () => {}
          })
        }
      };
    }));

    const onRunFailed = vi.fn();
    runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }), onRunFailed }
    });

    const runOnce = async () => {
      let done;
      const completed = new Promise((resolve) => { done = resolve; });
      await runner.executeApiRun({
        runId: 'run-reused', provider: runReady(), model: null, prompt: 'hi',
        workspacePath: process.cwd(), screenshots: [], timeout: 600_000,
        onData: undefined, onComplete: (m) => done(m)
      });
      return completed;
    };

    // The chunk was already delivered, so the run is a success despite the Stop.
    const first = await runOnce();
    // The Stop really did land on a registered run — otherwise no marker was
    // ever set and the rest of this test would pass vacuously.
    expect(stopAccepted).toBe(true);
    expect(first).toMatchObject({ success: true });
    expect(first.canceled).toBeUndefined();

    // The stale marker must not make the next run of this id report canceled.
    const second = await runOnce();
    expect(second).toMatchObject({ success: true });
    expect(second.canceled).toBeUndefined();
    expect(onRunFailed).not.toHaveBeenCalled();
  });
  // A `data:` frame is NOT guaranteed to arrive whole: the reader hands back
  // arbitrary byte-sized chunks (~8KB from undici), so a long frame — a
  // reasoning model's `delta.reasoning`, a big content burst — routinely
  // straddles two reads. Parsing per-chunk instead of per-LINE fed JSON.parse a
  // half frame and threw `Unterminated string in JSON at position 8064`,
  // failing a 220s NVIDIA NIM nemotron run with outputSize 0. Every other SSE
  // consumer in the tree already carries the remainder forward.
  it('reassembles a data frame split across two reads instead of failing the run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'split-across-reads' } }] })}\n`;
    const cut = frame.indexOf('split') + 5;
    const chunks = [
      encoder.encode(frame.slice(0, cut)),
      encoder.encode(frame.slice(cut)),
      encoder.encode('data: [DONE]\n'),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined }) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-split-frame', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata.success).toBe(true);
    expect(await readFile(join(dataDir, 'runs', 'run-split-frame', 'output.txt'), 'utf-8'))
      .toBe('split-across-reads');
  });

  // Same boundary, one layer down: a multi-byte character cut in half by the
  // read boundary needs the decoder's own streaming carry, or it lands as U+FFFD.
  it('decodes a multi-byte character split across two reads', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    const frame = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'café — 日本' } }] })}\n`);
    // Cut inside the 3-byte encoding of "—".
    const cut = frame.indexOf(0xe2) + 1;
    const chunks = [frame.slice(0, cut), frame.slice(cut), encoder.encode('data: [DONE]\n')];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined }) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-split-utf8', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    await completed;

    expect(await readFile(join(dataDir, 'runs', 'run-split-utf8', 'output.txt'), 'utf-8'))
      .toBe('café — 日本');
  });

  // A CRLF transport leaves `\r` on every line; `[DONE]\r` missed the terminal
  // check and reached JSON.parse, and a trailing `\r` rode into the output text.
  it('tolerates CRLF frame separators', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'crlf' } }] })}\r\n\r\n`),
      encoder.encode('data: [DONE]\r\n'),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined }) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-crlf', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata.success).toBe(true);
    expect(await readFile(join(dataDir, 'runs', 'run-crlf', 'output.txt'), 'utf-8')).toBe('crlf');
  });

  // One corrupt frame mid-stream must not throw away the tokens around it — the
  // old code let a single JSON.parse throw abort the whole run.
  it('skips an unparseable frame and keeps the surrounding output', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'before ' } }] })}\n`),
      encoder.encode('data: {"choices":[{"delta":{"content":"oops\n'),
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'after' } }] })}\n`),
      encoder.encode('data: [DONE]\n'),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined }) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-bad-frame', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata.success).toBe(true);
    expect(await readFile(join(dataDir, 'runs', 'run-bad-frame', 'output.txt'), 'utf-8'))
      .toBe('before after');
  });

  // `data: ` with an empty payload is a keep-alive on some providers. It is not
  // a frame, so it must not reach the parse-failure log — which would otherwise
  // emit one line per heartbeat for the life of the stream.
  it('treats an empty data payload as a heartbeat, not an unparseable frame', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('data: \n\n'),
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'beat' } }] })}\n`),
      encoder.encode('data: [DONE]\n'),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined }) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-heartbeat', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata.success).toBe(true);
    expect(await readFile(join(dataDir, 'runs', 'run-heartbeat', 'output.txt'), 'utf-8')).toBe('beat');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('unparseable stream frame');
    warn.mockRestore();
  });

  // A reasoning model streams `delta.reasoning` before any content, so a
  // mid-stream failure finds `output` empty and the real work sitting in
  // `reasoning`. The success path already falls back to it; the failure path
  // discarded it, which is how the NVIDIA NIM nemotron run lost 220s of
  // generation to `outputSize: 0`.
  it('salvages reasoning-only partial output when the stream fails mid-run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'thought so far' } }] })}\n`),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : Promise.reject(new Error('socket hang up'))) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-reasoning-salvage', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata.success).toBe(false);
    expect(metadata.outputSize).toBeGreaterThan(0);
    expect(await readFile(join(dataDir, 'runs', 'run-reasoning-salvage', 'output.txt'), 'utf-8'))
      .toBe('thought so far');
  });

  // The hidden channel is named `reasoning_content` by NVIDIA NIM, vLLM and the
  // DeepSeek-R1-compatible servers — only OpenRouter-style endpoints say
  // `reasoning`. Reading the one name discarded every reasoning token from NIM
  // (`nvidia/nemotron-3.5-lightning-30b-a3b` sends 126 of 128 frames that way),
  // so the salvage below never fired and a cut-off run reported `outputSize: 0`
  // — indistinguishable from a provider that answered nothing.
  it.each([
    ['reasoning', 'openrouter-style'],
    ['reasoning_content', 'nvidia-nim/vllm-style'],
    ['thinking', 'llama.cpp-style'],
  ])('salvages a %s-named reasoning channel (%s)', async (field) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { [field]: 'deliberating' } }] })}\n`),
      encoder.encode('data: [DONE]\n'),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true }) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: `run-reasoning-${field}`, provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata.outputSize).toBeGreaterThan(0);
    expect(await readFile(join(dataDir, 'runs', `run-reasoning-${field}`, 'output.txt'), 'utf-8'))
      .toBe('deliberating');
  });

  // The wall-clock ceiling is the THIRD terminal path, and the only one that
  // discarded the reasoning it cut off. A reasoning model spends its whole
  // budget in the hidden channel before the first content token, so a run the
  // timer ends has an empty `output` and minutes of generation in `reasoning`;
  // writing `output` alone stamped `outputSize: 0`, which reads downstream as
  // "the provider sent nothing" and escalates a healthy-but-slow model as dead.
  it('salvages streamed reasoning when the wall-clock timeout ends the run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    // One reasoning frame, then a read that never settles — the timer wins.
    const frame = encoder.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'partial thinking' } }] })}\n`);
    let sent = false;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => {
        if (sent) return new Promise(() => {});
        sent = true;
        return { done: false, value: frame };
      } }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-timeout-reasoning', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], timeout: 50,
      onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata).toMatchObject({ success: false, errorCategory: 'timeout' });
    // The salvage, not a zero-byte "provider said nothing" record.
    expect(metadata.outputSize).toBeGreaterThan(0);
    expect(metadata.hadReasoning).toBe(true);
    expect(metadata.usedReasoningAsFallback).toBe(true);
    expect(await readFile(join(dataDir, 'runs', 'run-timeout-reasoning', 'output.txt'), 'utf-8'))
      .toBe('partial thinking');
  });

  // The timeout closure is built before the stream reader that fills
  // `reasoning`, so a timer that fires before the response arrives must not
  // read it through the temporal dead zone — a ReferenceError there would
  // abandon the finalizer and leak the very run slot the ceiling reclaims.
  it('finalizes a timeout that fires before any response, with no reasoning to salvage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: () => new Promise(() => {}) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    runner.executeApiRun({
      runId: 'run-timeout-pre-response', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], timeout: 20,
      onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata).toMatchObject({ success: false, errorCategory: 'timeout' });
    expect(metadata.outputSize).toBe(0);
    expect(metadata.hadReasoning).toBe(false);
    expect(metadata.usedReasoningAsFallback).toBe(false);
    expect(await runner.isRunActive('run-timeout-pre-response')).toBe(false);
  });

  // A SSE reader whose chunks arrive on the (fake) clock, so a test can hold a
  // stream open across the timeout bounds without sleeping. Rejects on abort
  // the way a real reader does, so a timer that wins the race still unwinds
  // `processStream` instead of leaving it parked on a read forever.
  const clockDrivenReader = ({ intervalMs, frames = Infinity, signal }) => {
    const encoder = new TextEncoder();
    let sent = 0;
    return {
      read: () => new Promise((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (signal?.aborted) return fail();
        signal?.addEventListener('abort', fail, { once: true });
        setTimeout(() => {
          if (signal?.aborted) return fail();
          if (sent >= frames) return resolve({ done: true, value: undefined });
          sent += 1;
          resolve({
            done: false,
            value: encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tok' } }] })}\n`),
          });
        }, intervalMs);
      }),
      cancel: async () => {},
    };
  };

  // The regression #7560 reports. A single wall-clock ceiling cannot tell a
  // provider that opened the stream and STALLED from one that is actively
  // streaming and simply needs longer, so both died at the same 300s — an
  // NVIDIA NIM nemotron run spending its whole budget in the hidden reasoning
  // channel was killed mid-generation while healthy and producing. Every chunk
  // must push the no-progress bound out, so a run that keeps producing outlives
  // that bound by any multiple.
  it('lets a steadily streaming run outlive the configured no-progress bound', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    vi.useFakeTimers();

    const FRAMES = 20;
    const INTERVAL_MS = 400;
    const STALL_MS = 1000;
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => ({
      ok: true,
      body: { getReader: () => clockDrivenReader({ intervalMs: INTERVAL_MS, frames: FRAMES, signal: opts.signal }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-slow-stream', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], timeout: STALL_MS,
      onData: undefined, onComplete: complete,
    });

    // 8000ms of streaming against a 1000ms no-progress bound: the old single
    // ceiling ended this run at 1000ms with `success: false`.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * (FRAMES + 1));
    const metadata = await completed;

    expect(metadata).toMatchObject({ success: true, exitCode: 0 });
    expect(metadata.duration).toBeGreaterThan(STALL_MS);
    expect(await readFile(join(dataDir, 'runs', 'run-slow-stream', 'output.txt'), 'utf-8'))
      .toBe('tok'.repeat(FRAMES));
    expect(await runner.isRunActive('run-slow-stream')).toBe(false);
  });

  // The other half of the split: relaxing the no-progress bound must not let a
  // provider that trickles bytes forever hold its `activeRuns` slot for good.
  // The absolute cap never extends, and it says so — a run that outran its
  // total budget while producing is a different diagnosis from one that stalled.
  it('caps a run that never stops trickling, naming the absolute bound', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    vi.useFakeTimers();

    // 55s between frames keeps the 120s no-progress bound permanently re-armed
    // (and never lands on the same tick as the 30-minute cap).
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => ({
      ok: true,
      body: { getReader: () => clockDrivenReader({ intervalMs: 55_000, signal: opts.signal }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-trickle', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], timeout: 120_000,
      onData: undefined, onComplete: complete,
    });

    await vi.advanceTimersByTimeAsync(1_800_000);
    const metadata = await completed;

    expect(metadata).toMatchObject({ success: false, errorCategory: 'timeout', timeoutBound: 'absolute' });
    expect(metadata.error).toMatch(/absolute runtime cap/i);
    // The cap is a ceiling on total runtime, not on the no-progress bound: it
    // fired while the stream was still producing, so the partial output is
    // salvaged rather than reported as a zero-byte "provider said nothing".
    expect(metadata.outputSize).toBeGreaterThan(0);
    expect(await runner.isRunActive('run-trickle')).toBe(false);
  });

  // `Math.max` against the default cap: an install that deliberately raised
  // `provider.timeout` past 30 minutes keeps running exactly as long as it
  // asked to, rather than being silently clamped DOWN by the new ceiling.
  it('never caps a run below its configured no-progress bound', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    vi.useFakeTimers();

    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => ({
      ok: true,
      body: { getReader: () => clockDrivenReader({ intervalMs: 600_000, signal: opts.signal }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    // A 45-minute bound, past the 30-minute default cap.
    await runner.executeApiRun({
      runId: 'run-long-bound', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], timeout: 2_700_000,
      onData: undefined, onComplete: complete,
    });

    // Past the default cap, before the configured bound — still running.
    await vi.advanceTimersByTimeAsync(1_900_000);
    expect(await runner.isRunActive('run-long-bound')).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000_000);
    const metadata = await completed;
    expect(metadata).toMatchObject({ success: false, errorCategory: 'timeout', timeoutBound: 'absolute' });
    expect(metadata.error).toMatch(/2700000ms/);
  });

  // A stream that ends without [DONE] still has a complete frame sitting in the
  // carry buffer; dropping it silently truncates the tail of the answer.
  it('flushes a trailing frame left unterminated by the final read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'head ' } }] })}\n`),
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined }) }) },
    })));
    const runner = createRunnerService({
      dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) },
    });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });

    await runner.executeApiRun({
      runId: 'run-tail-frame', provider: runReady(), model: null, prompt: 'hi',
      workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: complete,
    });
    const metadata = await completed;

    expect(metadata.success).toBe(true);
    expect(await readFile(join(dataDir, 'runs', 'run-tail-frame', 'output.txt'), 'utf-8'))
      .toBe('head tail');
  });

});

describe('AI Toolkit runner — declared extension points', () => {
  it('setCliRunner delegates executeCliRun to the host runner and back to the built-in on null', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const builtin = runner.executeCliRun;

    const hostRunner = vi.fn(async (opts) => `host:${opts.runId}`);
    runner.setCliRunner(hostRunner);
    const result = await runner.executeCliRun({ runId: 'r1', provider: { command: 'noop' } });
    expect(result).toBe('host:r1');
    expect(hostRunner).toHaveBeenCalledTimes(1);
    // The override receives the full opts object verbatim.
    expect(hostRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }));

    // Reverting restores the built-in implementation.
    runner.setCliRunner(null);
    expect(runner.executeCliRun).toBe(builtin);
  });

  it('setCliRunner / setTuiRunner reject non-function, non-null values', () => {
    const runner = createRunnerService({ dataDir: './data' });
    expect(() => runner.setCliRunner(42)).toThrow(/expects a function/);
    expect(() => runner.setTuiRunner('nope')).toThrow(/expects a function/);
  });

  it('setTuiRunner attaches/detaches executeTuiRun so the runs-router gate stays honest', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    // No built-in TUI executor — the runs router gates on typeof === 'function'.
    expect(typeof runner.executeTuiRun).toBe('undefined');

    const tui = vi.fn(async () => 'tui-run');
    runner.setTuiRunner(tui);
    expect(typeof runner.executeTuiRun).toBe('function');
    await runner.executeTuiRun({ runId: 'tui-1' });
    expect(tui).toHaveBeenCalledTimes(1);

    runner.setTuiRunner(null);
    expect(typeof runner.executeTuiRun).toBe('undefined');
  });

  it('external-run registry drives isRunActive / stopRun and reports unknown ids as inactive', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    expect(await runner.isRunActive('x')).toBe(false);

    const child = externalChild();
    runner.registerExternalRun('x', child);
    expect(runner.hasExternalRun('x')).toBe(true);
    expect(await runner.isRunActive('x')).toBe(true);

    expect(await runner.stopRun('x')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runner.consumeExternalRunStop('x')).toBe(true);
    expect(runner.consumeExternalRunStop('x')).toBe(false);
    // stopRun drops the entry, so a follow-up reports inactive.
    expect(await runner.isRunActive('x')).toBe(false);
    expect(await runner.stopRun('x')).toBe(false);
  });

  // getActiveRunCount is the surface the host's system-idle gate reads — it
  // must count BOTH tracking maps (API runs and host-spawned CLI/TUI runs),
  // since a host runner never populates the other one for the same run.
  it('getActiveRunCount sums external and internally-tracked runs', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    expect(await runner.getActiveRunCount()).toBe(0);

    runner.registerExternalRun('external-1', externalChild());
    expect(await runner.getActiveRunCount()).toBe(1);

    await runner.stopRun('external-1');
    expect(await runner.getActiveRunCount()).toBe(0);
  });

  // registerExternalRun also holds node-pty sessions (the host's TUI runs). On
  // Windows node-pty throws "Signals not supported on windows." for any signal,
  // so a signalled kill there stopped nothing and threw past stopRun, leaving
  // the TUI running while the run reported itself stopped.
  it('stopRun kills a node-pty external run without a signal on Windows', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const pty = { pid: 4321, kill: vi.fn((signal) => { if (signal && IS_WIN32) throw new Error('Signals not supported on windows.'); }) };
    runner.registerExternalRun('tui-run', pty);

    expect(await runner.stopRun('tui-run')).toBe(true);
    expect(pty.kill).toHaveBeenCalledWith(...(IS_WIN32 ? [] : ['SIGTERM']));
  });

  it('stopRun aborts an AbortController-style external run', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const controller = { abort: vi.fn() };
    runner.registerExternalRun('api-run', controller);
    expect(await runner.stopRun('api-run')).toBe(true);
    expect(controller.abort).toHaveBeenCalledTimes(1);
    expect(runner.consumeExternalRunStop('api-run')).toBe(true);
  });

  it('unregisterExternalRun clears a stale explicit-stop marker', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const child = externalChild();
    runner.registerExternalRun('done', child);
    await runner.stopRun('done');
    runner.unregisterExternalRun('done');
    expect(runner.consumeExternalRunStop('done')).toBe(false);
  });

  it('deleteRun kills an in-flight external run before removing its dir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-del-'));
    const runner = createRunnerService({ dataDir });
    const child = externalChild();
    runner.registerExternalRun('live', child);

    // No on-disk dir for this run, but the live process must still be killed.
    const deleted = await runner.deleteRun('live');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runner.hasExternalRun('live')).toBe(false);
    // deleteRun returns false when the run dir doesn't exist on disk.
    expect(deleted).toBe(false);

    await rm(dataDir, { recursive: true, force: true });
  });
});

describe('AI Toolkit runner — built-in executeCliRun spawn (#1865)', () => {
  // Mirrors server/services/runner.test.js's equivalent assertion — this is
  // the toolkit's OWN spawn path (inert in PortOS, which always registers a
  // host CLI runner via setCliRunner, but must stay behaviorally in sync per
  // the override-consistency contract in ./AGENTS.md).
  function makeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    child.killed = false;
    return child;
  }

  it('never enables shell:true — resolveWindowsExecutable (not a shell) is the Windows fix', async () => {
    // resolveWindowsExecutable is module-private here, and its IS_WIN32 default
    // is bound once at module load like the rest of the codebase's win32-gated
    // logic (see bufferedSpawn.test.js) — it can't be faked by mutating
    // process.platform mid-test. The resolution ALGORITHM itself is exhaustively
    // covered by server/lib/bufferedSpawn.test.js's injectable-isWin32 tests
    // (this file's copy is a byte-for-byte mirror); this test only pins the
    // wiring — that the built-in spawn never falls back to shell:true (the
    // DEP0190-unsafe approach this directory rejected — see resolveWindowsExecutable
    // docstring above) regardless of platform.
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-spawn-'));
    const runner = createRunnerService({ dataDir });
    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = { id: 'opencode', command: 'opencode', args: [], timeout: 5000, defaultModel: null };
    let resolveComplete;
    const completed = new Promise((resolve) => { resolveComplete = resolve; });

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await runner.executeCliRun({
      runId: 'builtin-run', provider, prompt: 'test prompt', onComplete: resolveComplete,
    });

    const [command, , options] = spawn.mock.calls.at(-1);
    expect(options.shell).toBeFalsy();
    // Off win32 (the host actually running this suite), resolution is a no-op
    // and the bare command is spawned unchanged.
    if (process.platform !== 'win32') expect(command).toBe('opencode');

    // The 'close' handler's atomicWrite calls run after executeCliRun returns
    // — wait for completion before removing dataDir, or rm races the writes.
    await completed;
    await rm(dataDir, { recursive: true, force: true });
  });
});
