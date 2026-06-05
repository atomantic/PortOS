import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./runner.js', () => ({ createRun: vi.fn(), finalizeRunRecord: vi.fn() }));
vi.mock('./localLlm.js', () => ({ ensureBackendProvider: vi.fn(() => Promise.resolve()) }));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./providerStatus.js', () => ({ markProviderAvailable: vi.fn(() => Promise.resolve()) }));
vi.mock('./ollamaManager.js', () => ({ ensureProviderReady: vi.fn(() => Promise.resolve({ success: true })) }));

import { buildPrompt, buildMessages, summarizeTimings, extractStreamDelta, resolvePartialOutput, runLocalLlmTest } from './localLlmPlayground.js';
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

describe('buildMessages', () => {
  it('omits the system message when blank', () => {
    expect(buildMessages({ systemPrompt: '  ', prompt: 'hi' })).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('includes a system message when present', () => {
    expect(buildMessages({ systemPrompt: 'Be terse', prompt: 'hi' })).toEqual([
      { role: 'system', content: 'Be terse' },
      { role: 'user', content: 'hi' },
    ]);
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
});

describe('extractStreamDelta', () => {
  it('parses an OpenAI-style content delta', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hi"}}]}';
    expect(extractStreamDelta(line)).toEqual({ content: 'Hi', reasoning: '' });
  });

  it('parses a reasoning delta', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}';
    expect(extractStreamDelta(line)).toEqual({ content: '', reasoning: 'thinking' });
  });

  it('skips non-data lines and the [DONE]/✅ sentinels', () => {
    expect(extractStreamDelta(': keep-alive')).toBeNull();
    expect(extractStreamDelta('data: [DONE]')).toBeNull();
    expect(extractStreamDelta('data: ✅')).toBeNull();
    expect(extractStreamDelta('')).toBeNull();
  });

  it('skips a malformed frame instead of throwing (one bad frame must not abort the stream)', () => {
    expect(extractStreamDelta('data: {not json')).toBeNull();
  });

  it('tolerates a frame with no delta', () => {
    expect(extractStreamDelta('data: {"choices":[{}]}')).toEqual({ content: '', reasoning: '' });
  });
});

describe('resolvePartialOutput', () => {
  it('prefers visible content over reasoning', () => {
    expect(resolvePartialOutput({ output: 'hello', reasoning: 'thinking' })).toBe('hello');
  });

  it('falls back to reasoning when no content streamed', () => {
    expect(resolvePartialOutput({ output: '   ', reasoning: 'partial thought' })).toBe('partial thought');
  });

  it('returns empty string when neither content nor reasoning streamed', () => {
    expect(resolvePartialOutput({ output: '', reasoning: '' })).toBe('');
    expect(resolvePartialOutput({})).toBe('');
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
