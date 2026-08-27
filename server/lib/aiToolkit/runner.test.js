import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import EventEmitter from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

const { spawn } = await import('child_process');
const { createRunnerService } = await import('./runner.js');

describe('AI Toolkit runner service', () => {
  const tempDirs = [];

  afterEach(async () => {
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
    const ensureProviderReady = vi.fn(async () => ({ success: false, error: 'service offline' }));
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
      errorCategory: 'unknown'
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

    const child = { kill: vi.fn(), killed: false };
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
    const child = { kill: vi.fn(), killed: false };
    runner.registerExternalRun('done', child);
    await runner.stopRun('done');
    runner.unregisterExternalRun('done');
    expect(runner.consumeExternalRunStop('done')).toBe(false);
  });

  it('deleteRun kills an in-flight external run before removing its dir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-del-'));
    const runner = createRunnerService({ dataDir });
    const child = { kill: vi.fn(), killed: false };
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
