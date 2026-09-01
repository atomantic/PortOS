import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripCodeFences, parseLLMJSON, callProviderAISimple } from './aiProvider.js';
import { CREATIVE_LATITUDE_HEADING } from '../lib/creativeLatitude.js';

// `statusOp` is hoisted with the mock factories so the ai:status spy is in scope
// when vitest lifts vi.mock above the imports.
const { statusOp } = vi.hoisted(() => ({
  statusOp: { update: vi.fn(), complete: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/providers.js', () => ({ getAllProviders: vi.fn() }));
vi.mock('../services/aiStatusEvents.js', () => ({ startAIOp: vi.fn(() => statusOp) }));
vi.mock('../services/ollamaManager.js', () => ({
  ensureProviderReady: vi.fn(),
  isOllamaProvider: vi.fn(() => false),
}));

describe('aiProvider pure helpers', () => {
  describe('stripCodeFences', () => {
    it('strips a leading ```json fence and trailing fence', () => {
      const raw = '```json\n{"a":1}\n```';
      expect(stripCodeFences(raw)).toBe('{"a":1}');
    });

    it('strips a bare ``` fence (no language tag)', () => {
      const raw = '```\n{"a":1}\n```';
      expect(stripCodeFences(raw)).toBe('{"a":1}');
    });

    it('leaves un-fenced text untouched (modulo trim)', () => {
      expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
      expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
    });

    it('strips a leading fence even without a trailing fence', () => {
      expect(stripCodeFences('```json\n{"a":1}')).toBe('{"a":1}');
    });

    it('strips a trailing fence even without a leading fence', () => {
      expect(stripCodeFences('{"a":1}\n```')).toBe('{"a":1}');
    });

    it('does not strip mid-string backticks', () => {
      const raw = '{"src":"```foo```"}';
      expect(stripCodeFences(raw)).toBe('{"src":"```foo```"}');
    });

    it('strips fences with surrounding whitespace (real LLM output shape)', () => {
      // LLMs commonly emit a trailing newline after the closing fence — the
      // strip helper must tolerate it so the closing ``` still goes away.
      expect(stripCodeFences('```json\n{"a":1}\n```\n')).toBe('{"a":1}');
      expect(stripCodeFences('```json\n{"a":1}\n```  ')).toBe('{"a":1}');
      expect(stripCodeFences('  ```json\n{"a":1}\n```  ')).toBe('{"a":1}');
      expect(stripCodeFences('\n\n```\n{"a":1}\n```\n\n')).toBe('{"a":1}');
    });
  });

  describe('parseLLMJSON', () => {
    it('parses fenced JSON', () => {
      expect(parseLLMJSON('```json\n{"a":1,"b":[2,3]}\n```')).toEqual({ a: 1, b: [2, 3] });
    });

    it('parses bare JSON', () => {
      expect(parseLLMJSON('{"a":1}')).toEqual({ a: 1 });
    });

    it('throws a descriptive error on malformed JSON', () => {
      expect(() => parseLLMJSON('not json at all')).toThrow(/Invalid JSON from AI/);
    });

    it('error message includes the underlying parser detail', () => {
      let err;
      try { parseLLMJSON('{"a":1,'); } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect(err.message).toMatch(/Invalid JSON from AI:/);
    });

    it('handles arrays and primitives at the top level', () => {
      expect(parseLLMJSON('[1,2,3]')).toEqual([1, 2, 3]);
      expect(parseLLMJSON('```\nnull\n```')).toBeNull();
      expect(parseLLMJSON('"hello"')).toBe('hello');
    });
  });
});

describe('callProviderAISimple completion classification', () => {
  // Keyless so the endpoint guard (which only gates API-key calls) stays out of the way.
  const provider = { id: 'provider-1', name: 'Example Provider', type: 'api', endpoint: 'https://api.example.com/v1' };

  const respondWith = (body) => vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  })));

  const call = () => callProviderAISimple(provider, 'model-1', 'a prompt', { op: 'test-op', opLabel: 'Testing' });

  beforeEach(() => {
    statusOp.update.mockClear();
    statusOp.complete.mockClear();
    statusOp.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sentPrompt = () => JSON.parse(globalThis.fetch.mock.calls[0][1].body).messages[0].content;

  it('stamps the IP-latitude clause when the caller declares the prompt creative', async () => {
    // This helper posts to /chat/completions itself, so neither buildPrompt nor
    // runPromptThroughProvider can stamp it — the opt-in flag is the only route.
    respondWith({ choices: [{ message: { content: 'prose' } }] });

    await callProviderAISimple(provider, 'model-1', 'Write the scene.', { creative: true });

    expect(sentPrompt().startsWith(CREATIVE_LATITUDE_HEADING)).toBe(true);
    expect(sentPrompt().endsWith('Write the scene.')).toBe(true);
  });

  it('leaves a non-creative prompt untouched', async () => {
    respondWith({ choices: [{ message: { content: 'ok' } }] });

    await callProviderAISimple(provider, 'model-1', 'Summarize CPU load.', {});

    expect(sentPrompt()).toBe('Summarize CPU load.');
  });

  it('classifies a whitespace-only completion as a provider error, not a successful call', async () => {
    respondWith({ choices: [{ message: { content: '   \n  ' } }] });

    const result = await call();

    expect(result.error).toMatch(/empty completion/i);
    expect(result.text).toBeUndefined();
    // `ai:status` phase error is the single voice for provider failures, so a call
    // that produced nothing usable must reach it rather than reporting "done" (#2733).
    expect(statusOp.error).toHaveBeenCalledTimes(1);
    expect(statusOp.complete).not.toHaveBeenCalled();
  });

  it('reports a usable completion as success', async () => {
    respondWith({ choices: [{ message: { content: 'a real answer' } }] });

    const result = await call();

    expect(result).toMatchObject({ text: 'a real answer' });
    expect(result.error).toBeUndefined();
    expect(statusOp.complete).toHaveBeenCalledTimes(1);
    expect(statusOp.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Codex ChatGPT subscription as a text transport (#5590)
// ---------------------------------------------------------------------------

const { getAllProviders } = await import('./providers.js');
const { resolveTextProvider, resolveAPIProvider } = await import('./aiProvider.js');
const { ERROR_CATEGORIES } = await import('../lib/aiToolkit/errorDetection.js');
const codexAppServer = await import('./codexAppServer.js');

const CODEX_ENABLED = {
  id: 'codex',
  name: 'Codex CLI',
  type: 'cli',
  command: 'codex',
  textTransport: 'codex-app-server',
  textTransportEnabled: true,
  defaultModel: 'model-alpha',
};
const CODEX_ADVERTISED_ONLY = { ...CODEX_ENABLED, textTransportEnabled: undefined };
const OPENAI_API = {
  id: 'openai', name: 'OpenAI', type: 'api', endpoint: 'https://api.example.com/v1',
};

describe('resolveTextProvider', () => {
  const withProviders = (providers, activeProvider = null) =>
    getAllProviders.mockResolvedValue({ activeProvider, providers });

  it('accepts the subscription when the caller or the user named it', async () => {
    withProviders([CODEX_ENABLED, OPENAI_API], 'codex');

    await expect(resolveTextProvider('codex')).resolves.toMatchObject({ id: 'codex' });
    await expect(resolveTextProvider(null)).resolves.toMatchObject({ id: 'codex' });
  });

  it('never lands on a subscription through the blind sweep', async () => {
    // Step 3 is "whatever happens to be configured". Letting it choose the
    // subscription would move a background feature's billing onto the user's
    // ChatGPT plan without them ever choosing it.
    withProviders([CODEX_ENABLED, OPENAI_API], null);

    await expect(resolveTextProvider('does-not-exist')).resolves.toMatchObject({ id: 'openai' });
  });

  it('ignores a record that only advertises the transport', async () => {
    withProviders([CODEX_ADVERTISED_ONLY, OPENAI_API], 'codex');

    await expect(resolveTextProvider('codex')).resolves.toMatchObject({ id: 'openai' });
  });

  it('is still reachable under its original name', () => {
    expect(resolveAPIProvider).toBe(resolveTextProvider);
  });
});

describe('callProviderAISimple through the ChatGPT subscription', () => {
  const runTurn = vi.spyOn(codexAppServer, 'runCodexTextTurn');
  const bench = vi.spyOn(codexAppServer, 'benchCodexTextTransport');
  const peekBench = vi.spyOn(codexAppServer, 'getCodexTextTransportBench');
  const peekAccount = vi.spyOn(codexAppServer, 'peekCodexAccountReadiness');

  beforeEach(() => {
    statusOp.update.mockClear();
    statusOp.complete.mockClear();
    statusOp.error.mockClear();
    runTurn.mockReset();
    bench.mockReset();
    peekBench.mockReset().mockReturnValue(null);
    peekAccount.mockReset().mockReturnValue(null);
    getAllProviders.mockResolvedValue({ activeProvider: 'codex', providers: [CODEX_ENABLED, OPENAI_API] });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('runs the prompt as a turn and returns its text and usage', async () => {
    runTurn.mockResolvedValue({
      text: 'a subscription answer',
      usage: { outputTokens: 12, source: 'chatgpt-subscription' },
    });

    const result = await callProviderAISimple(CODEX_ENABLED, 'model-alpha', 'Summarize this.', {});

    expect(result).toMatchObject({ text: 'a subscription answer' });
    expect(result.usage.source).toBe('chatgpt-subscription');
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Summarize this.', model: 'model-alpha',
    }));
    expect(statusOp.complete).toHaveBeenCalledTimes(1);
  });

  it('refuses a codex record whose transport the user has not enabled', async () => {
    const result = await callProviderAISimple(CODEX_ADVERTISED_ONLY, 'model-alpha', 'hi', {});

    expect(result.error).toMatch(/requires an API-based provider/i);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('benches only the transport on quota exhaustion, using the reset time Codex reported', async () => {
    const resetsAt = new Date(Date.now() + 90 * 60_000).toISOString();
    peekAccount.mockReturnValue({ rateLimits: { primary: { usedPercent: 100, resetsAt }, secondary: null } });
    runTurn.mockRejectedValue(Object.assign(new Error('You have hit your usage limit.'), {
      code: 'CODEX_TURN_FAILED',
      context: { category: ERROR_CATEGORIES.USAGE_LIMIT },
    }));

    await callProviderAISimple(CODEX_ENABLED, 'model-alpha', 'hi', {});

    expect(bench).toHaveBeenCalledWith(expect.objectContaining({
      category: ERROR_CATEGORIES.USAGE_LIMIT,
      // Codex's own reset window, not the category's estimate.
      waitMs: expect.any(Number),
    }));
    expect(bench.mock.calls[0][0].waitMs).toBeGreaterThan(80 * 60_000);
  });

  it('retries on the EXPLICIT fallback provider, and only that one', async () => {
    runTurn.mockRejectedValue(Object.assign(new Error('quota'), {
      context: { category: ERROR_CATEGORIES.USAGE_LIMIT },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] }),
    })));

    const result = await callProviderAISimple(
      { ...CODEX_ENABLED, fallbackProvider: 'openai', fallbackModel: 'fallback-model' },
      'model-alpha', 'hi', {},
    );

    expect(result).toMatchObject({ text: 'fallback answer' });
    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).model).toBe('fallback-model');
  });

  it('fails closed when the provider named no fallback — never picks an API key on its own', async () => {
    runTurn.mockRejectedValue(Object.assign(new Error('quota'), {
      context: { category: ERROR_CATEGORIES.USAGE_LIMIT },
    }));
    vi.stubGlobal('fetch', vi.fn());

    const result = await callProviderAISimple(CODEX_ENABLED, 'model-alpha', 'hi', {});

    expect(result.error).toMatch(/quota/);
    expect(result.text).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not bench or fall back when the CALLER cancelled', async () => {
    runTurn.mockRejectedValue(Object.assign(new Error('The Codex turn was cancelled.'), {
      code: 'CODEX_TURN_INTERRUPTED',
    }));
    vi.stubGlobal('fetch', vi.fn());

    const result = await callProviderAISimple(
      { ...CODEX_ENABLED, fallbackProvider: 'openai' }, 'model-alpha', 'hi', {},
    );

    expect(result).toMatchObject({ canceled: true });
    expect(bench).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('skips the turn entirely while the transport is benched and goes straight to the fallback', async () => {
    peekBench.mockReturnValue({ until: Date.now() + 60_000, category: ERROR_CATEGORIES.USAGE_LIMIT, message: 'plan spent' });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] }),
    })));

    const result = await callProviderAISimple(
      { ...CODEX_ENABLED, fallbackProvider: 'openai' }, 'model-alpha', 'hi', {},
    );

    expect(runTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: 'fallback answer' });
  });
});
