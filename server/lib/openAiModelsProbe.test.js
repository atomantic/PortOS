import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fetchWithTimeoutModule from './fetchWithTimeout.js';
import { probeOpenAiModels } from './openAiModelsProbe.js';

const jsonResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

const mockFetch = (impl) => vi.spyOn(fetchWithTimeoutModule, 'fetchWithTimeout').mockImplementation(impl);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeOpenAiModels', () => {
  it('asks {base}/models with the caller bound, tolerating a trailing slash', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ data: [] }));

    await probeOpenAiModels('http://127.0.0.1:8080/v1/', { timeoutMs: 1234 });

    // The bound is fetchWithTimeout's THIRD argument — passing it inside the
    // init object (the bug this module consolidated away) silently kept the 15s
    // default.
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/models', { method: 'GET' }, 1234);
  });

  it('reads both the OpenAI `data` shape and a bare `models` array', async () => {
    mockFetch(async () => jsonResponse({ data: [{ id: 'dflash' }, { name: 'qwen' }, 'bare-string', { id: '' }] }));
    await expect(probeOpenAiModels('http://x/v1')).resolves.toMatchObject({
      reachable: true,
      models: ['dflash', 'qwen', 'bare-string'],
      error: null,
    });

    mockFetch(async () => jsonResponse({ models: ['a'] }));
    await expect(probeOpenAiModels('http://x/v1')).resolves.toMatchObject({ reachable: true, models: ['a'] });
  });

  it('keeps each served model\'s declared context window, whatever the daemon calls it', async () => {
    // vLLM says `max_model_len`, llama-server `n_ctx`, LM Studio
    // `loaded_context_length`. Throwing these away is what let an oversized
    // prompt reach an endpoint that could never serve it (#7441).
    mockFetch(async () => jsonResponse({
      data: [
        { id: 'qwen3.8-27b', max_model_len: 32768 },
        { id: 'dflash', n_ctx: 8192 },
        { id: 'lmstudio-model', loaded_context_length: 16384 },
        { id: 'silent' },
      ],
    }));

    await expect(probeOpenAiModels('http://x/v1')).resolves.toMatchObject({
      reachable: true,
      models: ['qwen3.8-27b', 'dflash', 'lmstudio-model', 'silent'],
      // `silent` is ABSENT, not zero: a row that declares no window says
      // nothing about that model, and a caller must read it as unknown.
      contextWindows: { 'qwen3.8-27b': 32768, dflash: 8192, 'lmstudio-model': 16384 },
    });
  });

  it('takes the SMALLEST window a row declares', async () => {
    // A row that reports both a trained maximum and the narrower window the
    // process was actually loaded at means the loaded one. Budgeting to the
    // wider number builds a prompt the running server rejects.
    mockFetch(async () => jsonResponse({
      data: [
        { id: 'loaded-small', max_model_len: 131072, n_ctx: 8192 },
        { id: 'routed', context_length: 1_000_000, top_provider: { context_length: 128_000 } },
        { id: 'nonsense', max_model_len: 0, n_ctx: 'lots' },
      ],
    }));

    await expect(probeOpenAiModels('http://x/v1')).resolves.toMatchObject({
      contextWindows: { 'loaded-small': 8192, routed: 128_000 },
    });
  });

  it('tells a server with nothing loaded from one whose listing is unreadable', async () => {
    mockFetch(async () => jsonResponse({ data: [] }));
    // Up and serving nothing — an actionable "load a model", not a connection problem.
    await expect(probeOpenAiModels('http://x/v1')).resolves.toMatchObject({ reachable: true, models: [] });

    mockFetch(async () => ({ ok: true, status: 200, text: async () => 'not json at all' }));
    const unreadable = await probeOpenAiModels('http://x/v1');
    expect(unreadable).toMatchObject({ reachable: true, models: null });
    expect(unreadable.error).toMatch(/not readable/i);
  });

  it('survives a body that rejects mid-read', async () => {
    // A daemon that accepts the connection and then drops it rejects in
    // res.text(), not at the fetch. Escaping here would fail the whole
    // readiness request and blank the checklist for every provider.
    mockFetch(async () => ({ ok: true, status: 200, text: async () => { throw new Error('terminated'); } }));

    await expect(probeOpenAiModels('http://x/v1')).resolves.toMatchObject({ reachable: true, models: null });
  });

  it('names the real transport failure instead of undici bare "fetch failed"', async () => {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' });
    mockFetch(async () => { throw err; });

    await expect(probeOpenAiModels('http://127.0.0.1:8080/v1')).resolves.toEqual({
      reachable: false,
      models: null,
      contextWindows: null,
      error: 'ECONNREFUSED',
    });
  });

  it('collapses the timeout spellings to one phrase', async () => {
    mockFetch(async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); });
    await expect(probeOpenAiModels('http://x/v1')).resolves.toMatchObject({ reachable: false, error: 'timed out' });
  });

  it('reports a non-OK response as unreachable and releases its body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    mockFetch(async () => ({ ok: false, status: 404, body: { cancel } }));

    await expect(probeOpenAiModels('http://x/v1')).resolves.toEqual({
      reachable: false,
      models: null,
      contextWindows: null,
      error: 'HTTP 404',
    });
    // Undici holds the socket until an unread body is consumed; this path runs
    // on a poll loop.
    expect(cancel).toHaveBeenCalled();
  });
it('attaches a Bearer header only when a key is supplied', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ data: [] }));

    await probeOpenAiModels('http://127.0.0.1:18020/v1', { timeoutMs: 500, apiKey: 'vllm-key' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18020/v1/models',
      { method: 'GET', headers: { Authorization: 'Bearer vllm-key' } },
      500,
    );

    fetchMock.mockClear();
    await probeOpenAiModels('http://127.0.0.1:18020/v1', { timeoutMs: 500 });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18020/v1/models', { method: 'GET' }, 500);
  });

  it('treats 401/403 as REACHABLE-but-unlistable, not as nothing answering', async () => {
    // A key-gated daemon (vLLM's compose stack sets VLLM_API_KEY) refuses an
    // unauthenticated probe. Reporting that as unreachable would tell the user
    // to start a container that is already up.
    for (const status of [401, 403]) {
      const cancel = vi.fn().mockResolvedValue(undefined);
      mockFetch(async () => ({ ok: false, status, body: { cancel } }));
      await expect(probeOpenAiModels('http://x/v1')).resolves.toEqual({
        reachable: true,
        models: null,
        contextWindows: null,
        error: 'authentication required',
      });
      expect(cancel).toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
});
