import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./runner.js', () => ({ createRun: vi.fn(), finalizeRunRecord: vi.fn() }));
vi.mock('./localLlm.js', () => ({ ensureBackendProvider: vi.fn(() => Promise.resolve()) }));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./providerStatus.js', () => ({ markProviderAvailable: vi.fn(() => Promise.resolve()) }));
vi.mock('./ollamaManager.js', () => ({ ensureProviderReady: vi.fn(() => Promise.resolve({ success: true })) }));

import { buildPrompt, summarizeTimings, runLocalLlmTest } from './localLlmPlayground.js';
import { __resetUsageSupport } from '../lib/openAiChatStream.js';
import { createRun, finalizeRunRecord } from './runner.js';
import { getProviderById } from './providers.js';

describe('buildPrompt', () => {
  it('returns the bare prompt when no system instructions', () => {
    expect(buildPrompt({ systemPrompt: '', prompt: 'hi' })).toBe('hi');
    expect(buildPrompt({ systemPrompt: '   ', prompt: 'hi' })).toBe('hi');
  });

  it('prefixes a labeled system block when present (display format, not wire)', () => {
    expect(buildPrompt({ systemPrompt: 'Be terse', prompt: 'hi' }))
      .toBe('System instructions:\nBe terse\n\nUser prompt:\nhi');
  });
});

describe('summarizeTimings', () => {
  it('computes ttft, total, and rate', () => {
    const t = summarizeTimings({ startedAt: 1000, firstChunkAt: 1200, endedAt: 3000, text: 'abcdefghij' });
    expect(t.ttftMs).toBe(200);
    expect(t.totalMs).toBe(2000);
    expect(t.chars).toBe(10);
    expect(t.charsPerSecond).toBe(5); // 10 chars / 2s
  });

  it('reports null ttft when no chunk ever arrived', () => {
    const t = summarizeTimings({ startedAt: 1000, firstChunkAt: null, endedAt: 2000, text: '' });
    expect(t.ttftMs).toBeNull();
  });

  it('reports null rate (not a char count) for a zero-duration run', () => {
    const t = summarizeTimings({ startedAt: 1000, firstChunkAt: 1000, endedAt: 1000, text: 'hello' });
    expect(t.totalMs).toBe(0);
    expect(t.charsPerSecond).toBeNull();
  });

  // tokens/s is DECODE throughput — completion tokens over the time after the
  // first token — matching what llama.cpp and Ollama report. Dividing by the
  // full wall clock would make the same model look slower purely because its
  // prompt was longer, which is what TTFT and the prefill rate are for.
  it('measures tokens/s over the decode window, not the whole wall clock', () => {
    const t = summarizeTimings({
      startedAt: 0, firstChunkAt: 1000, endedAt: 3000, text: 'abc',
      usage: { completionTokens: 100, promptTokens: 4000, estimated: false },
    });
    expect(t.completionTokens).toBe(100);
    expect(t.tokensPerSecond).toBe(50); // 100 tokens / 2s of decode, not / 3s
    expect(t.promptTokensPerSecond).toBe(4000); // 4000 prompt tokens / 1s of prefill
    expect(t.tokensEstimated).toBe(false);
  });

  it('uses wall clock for a one-chunk response when no runtime decode duration exists', () => {
    const t = summarizeTimings({
      startedAt: 0, firstChunkAt: 1000, endedAt: 3000, text: 'abc', streamChunks: 1,
      usage: { completionTokens: 100, promptTokens: 4000, estimated: false },
    });
    expect(t.tokensPerSecond).toBe(33.33);
    expect(t.timingSource).toBe('wall-clock');
  });

  it('prefers native decode and prefill durations when the runtime reports them', () => {
    const t = summarizeTimings({
      startedAt: 0, firstChunkAt: 1000, endedAt: 3000, text: 'abc',
      usage: {
        completionTokens: 100, promptTokens: 4000, completionMs: 500, promptMs: 250, estimated: false,
      },
    });
    expect(t.decodeMs).toBe(500);
    expect(t.promptMs).toBe(250);
    expect(t.tokensPerSecond).toBe(200);
    expect(t.promptTokensPerSecond).toBe(16000);
  });

  it('marks a frame-counted token figure as an estimate', () => {
    const t = summarizeTimings({
      startedAt: 0, firstChunkAt: 500, endedAt: 1500, text: 'abc',
      usage: { completionTokens: 20, promptTokens: null, estimated: true },
    });
    expect(t.tokensEstimated).toBe(true);
    expect(t.tokensPerSecond).toBe(20);
    // No prompt count reported → no prefill rate invented from the char count.
    expect(t.promptTokensPerSecond).toBeNull();
  });

  // The sentinel rule: a caller that tracks no usage records "not measured",
  // never a tokens/s figure derived from characters.
  it('reports null token fields when the daemon reported no usage', () => {
    const t = summarizeTimings({ startedAt: 0, firstChunkAt: 100, endedAt: 1100, text: 'abcdefgh' });
    expect(t.completionTokens).toBeNull();
    expect(t.promptTokens).toBeNull();
    expect(t.tokensPerSecond).toBeNull();
    expect(t.tokensEstimated).toBeNull();
    // ...while the chars/s figure it CAN measure is unaffected.
    expect(t.charsPerSecond).toBe(7.27); // 8 chars / 1.1s wall clock
  });
});

// Build a fake stream reader: yields each SSE line as a chunk, then either
// finishes cleanly (done) or throws an AbortError to simulate a timeout.
function makeReader(lines, { abort = false } = {}) {
  let i = 0;
  return {
    read: vi.fn(async () => {
      if (i < lines.length) return { done: false, value: new TextEncoder().encode(lines[i++]) };
      if (abort) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { done: true, value: undefined };
    }),
    cancel: vi.fn(async () => {}),
  };
}

const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;

describe('runLocalLlmTest timeout/abort contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderById.mockResolvedValue({ id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1' });
    createRun.mockResolvedValue({ runId: 'run-1', provider: { id: 'lmstudio' } });
    finalizeRunRecord.mockResolvedValue(undefined);
  });

  afterEach(() => { delete global.fetch; });

  const stubStream = (reader) => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } });
  };

  it('returns the content streamed before an abort as text and persists it on the failed run', async () => {
    stubStream(makeReader([sse({ content: 'Hello ' }), sse({ content: 'world' })], { abort: true }));

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });

    expect(result.error).toContain('Timed out');
    expect(result.text).toBe('Hello world');
    expect(finalizeRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', output: 'Hello world', success: false, exitCode: 1 }),
    );
  });

  it('surfaces a reasoning-only partial when no visible content streamed before the abort', async () => {
    stubStream(makeReader([sse({ reasoning: 'thinking hard…' })], { abort: true }));

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });

    expect(result.error).toContain('Timed out');
    expect(result.text).toBe('thinking hard…');
    expect(finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({ output: 'thinking hard…', success: false }));
  });

  it('returns the full text and a success record when the stream finishes normally', async () => {
    stubStream(makeReader([sse({ content: 'Done.' })], { abort: false }));

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });

    expect(result.error).toBeUndefined();
    expect(result.text).toBe('Done.');
    expect(finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({ output: 'Done.', success: true, exitCode: 0 }));
  });

  it('forwards each content delta to onToken as it streams (streaming route)', async () => {
    stubStream(makeReader([sse({ content: 'Hel' }), sse({ content: 'lo' })], { abort: false }));
    const tokens = [];

    const result = await runLocalLlmTest({
      backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000,
      onToken: (delta, kind) => tokens.push([delta, kind]),
    });

    expect(tokens).toEqual([['Hel', 'content'], ['lo', 'content']]);
    expect(result.text).toBe('Hello');
  });

  it('forwards reasoning deltas live on the reasoning channel, content on the content channel', async () => {
    stubStream(makeReader([
      sse({ reasoning: 'let me ' }),
      sse({ reasoning: 'think…' }),
      sse({ content: 'Answer.' }),
    ], { abort: false }));
    const tokens = [];

    const result = await runLocalLlmTest({
      backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000,
      onToken: (delta, kind) => tokens.push([delta, kind]),
    });

    expect(tokens).toEqual([
      ['let me ', 'reasoning'],
      ['think…', 'reasoning'],
      ['Answer.', 'content'],
    ]);
    // The final text is content-only — reasoning streamed live but doesn't pollute the answer.
    expect(result.text).toBe('Answer.');
  });

  it('does NOT re-emit a reasoning-only stream at the end (no double output)', async () => {
    stubStream(makeReader([sse({ reasoning: 'thinking ' }), sse({ reasoning: 'aloud' })], { abort: false }));
    const tokens = [];

    const result = await runLocalLlmTest({
      backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000,
      onToken: (delta, kind) => tokens.push([delta, kind]),
    });

    // Exactly two reasoning tokens — the old end-of-stream onChunk(resolved) re-emit
    // would have appended the whole joined reasoning a third time.
    expect(tokens).toEqual([['thinking ', 'reasoning'], ['aloud', 'reasoning']]);
    // The reasoning-only run still resolves its text from reasoning for the record.
    expect(result.text).toBe('thinking aloud');
  });

  it('records TTFT for a reasoning-only run (reasoning marks first-chunk timing)', async () => {
    stubStream(makeReader([sse({ reasoning: 'hmm' })], { abort: false }));

    const result = await runLocalLlmTest({
      backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000,
      onToken: () => {},
    });

    expect(result.timings.ttftMs).not.toBeNull();
    expect(result.timings.ttftMs).toBeGreaterThanOrEqual(0);
  });

  it('awaits onToken before reading the next upstream chunk (honours backpressure)', async () => {
    const reader = makeReader([sse({ content: 'a' }), sse({ content: 'b' })], { abort: false });
    stubStream(reader);

    // A slow consumer (e.g. the streaming route awaiting a socket `drain`): hold
    // the first token's promise open and assert the read loop has NOT pulled the
    // next chunk until we let it settle. This is what makes the route's drain-await
    // actually pause upstream reading instead of buffering unbounded.
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let firstSeen;
    const firstArrived = new Promise((resolve) => { firstSeen = resolve; });
    const tokens = [];
    const onToken = vi.fn((delta) => {
      tokens.push(delta);
      if (tokens.length === 1) { firstSeen(); return firstHeld; }
      return undefined;
    });

    const promise = runLocalLlmTest({
      backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000, onToken,
    });

    // Wait until the first token is being handled (it's held open below). At that
    // point only one read has resolved a line — the second chunk must NOT have been
    // requested yet, since the loop is parked awaiting our held onToken. This is what
    // makes the route's drain-await actually pause upstream reading.
    await firstArrived;
    expect(tokens).toEqual(['a']);
    expect(reader.read).toHaveBeenCalledTimes(1);

    releaseFirst();
    const result = await promise;
    expect(tokens).toEqual(['a', 'b']);
    expect(result.text).toBe('ab');
  });

  it('forwards a client cancel onto the upstream fetch so the reader tears down early', async () => {
    let capturedSignal = null;
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      capturedSignal = init.signal;
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => makeReader([sse({ content: 'partial' })], { abort: true }) } });
    });

    // A client that hung up before the run even started is the worst case — the
    // upstream signal must already be aborted, not run on to the 5s timeout.
    const clientController = new AbortController();
    clientController.abort();

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000, signal: clientController.signal });

    expect(capturedSignal.aborted).toBe(true);
    // The cancel surfaces as the same partial-output-on-abort contract.
    expect(result.text).toBe('partial');
  });

  it('aborts the upstream fetch when the client signal fires mid-run', async () => {
    let capturedSignal = null;
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      capturedSignal = init.signal;
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => makeReader([sse({ content: 'partial' })], { abort: true }) } });
    });

    const clientController = new AbortController();
    const promise = runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000, signal: clientController.signal });
    clientController.abort();
    await promise;

    expect(capturedSignal.aborted).toBe(true);
  });
});

describe('token counting through the stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUsageSupport();
    getProviderById.mockResolvedValue({ id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1' });
    createRun.mockResolvedValue({ runId: 'run-1', provider: { id: 'lmstudio' } });
    finalizeRunRecord.mockResolvedValue(undefined);
  });

  afterEach(() => { delete global.fetch; __resetUsageSupport(); });

  const stubStream = (reader) => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } });
    return global.fetch;
  };

  const usageFrame = (usage) => `data: ${JSON.stringify({ choices: [], usage })}\n`;

  it('asks for usage and records the count the daemon reported', async () => {
    const fetchMock = stubStream(makeReader([
      sse({ content: 'Hi' }),
      usageFrame({ completion_tokens: 40, prompt_tokens: 900 }),
    ]));

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream_options).toEqual({ include_usage: true });
    expect(result.timings.completionTokens).toBe(40);
    expect(result.timings.promptTokens).toBe(900);
    expect(result.timings.tokensEstimated).toBe(false);
  });

  // No usage block: the streamed CONTENT frames are the only token-shaped
  // evidence there is, and the figure must be labelled as the estimate it is.
  it('falls back to counting content frames, marked as an estimate', async () => {
    stubStream(makeReader([sse({ content: 'a' }), sse({ content: 'b' }), sse({ content: 'c' })]));

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });

    expect(result.timings.completionTokens).toBe(3);
    expect(result.timings.tokensEstimated).toBe(true);
  });

  // The text this reports chars/s from is content-only, so counting reasoning
  // frames too would make the two throughput numbers describe different outputs.
  it('does not count reasoning frames toward the estimate', async () => {
    stubStream(makeReader([
      sse({ reasoning: 'thinking' }),
      sse({ reasoning: 'harder' }),
      sse({ content: 'Answer.' }),
    ]));

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });
    expect(result.timings.completionTokens).toBe(1);
  });

  it('reports no token count at all when nothing streamed', async () => {
    stubStream(makeReader([]));
    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });
    // Never 0 — that would read as a measured standstill.
    expect(result.timings.completionTokens).toBeNull();
    expect(result.timings.tokensEstimated).toBeNull();
  });

  it('retries without stream_options when the daemon rejects it, and remembers', async () => {
    const reject = { ok: false, status: 400, text: async () => 'unknown field stream_options' };
    const stream = { ok: true, status: 200, body: { getReader: () => makeReader([sse({ content: 'Hi' })]) } };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(reject)
      .mockResolvedValue(stream);

    const first = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });
    expect(first.text).toBe('Hi');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).stream_options).toBeUndefined();

    // The SECOND run must not re-discover the same incompatibility: a sweep runs
    // hundreds of samples against one daemon, and each rediscovery costs a whole
    // extra prefill.
    global.fetch.mockClear();
    global.fetch.mockResolvedValue({ ok: true, status: 200, body: { getReader: () => makeReader([sse({ content: 'Hi' })]) } });
    await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).stream_options).toBeUndefined();
  });

  it('does not cache an unrelated 400 as stream_options incompatibility', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid model name' });

    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });

    expect(result.error).toContain('invalid model name');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // A 401 says nothing about the body. Retrying it would double every real
  // auth failure against a key-gated vLLM.
  it('does not retry an auth failure as though it were a body rejection', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const result = await runLocalLlmTest({ backend: 'lmstudio', modelId: 'm1', prompt: 'hi', timeoutMs: 5000 });
    expect(result.error).toContain('401');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
