/**
 * The OpenAI-compatible chat-stream helpers, extracted from
 * `services/localLlmPlayground.js` so a bare loopback daemon (llama.cpp, MTPLX,
 * vLLM) can be measured without a provider record.
 *
 * `streamOpenAiChat` itself is exercised end-to-end through its two callers'
 * suites; what is worth pinning here are the pure decisions inside the read
 * loop — a malformed frame must SKIP rather than abort the stream, and a
 * reasoning-only model must still surface its output.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildMessages,
  normalizeUsage,
  normalizeRuntimeTiming,
  parseOllamaStreamFrame,
  parseStreamFrame,
  resolvePartialOutput,
  streamOpenAiChat,
  streamOllamaChat,
  toOllamaMessages,
} from './openAiChatStream.js';

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

describe('toOllamaMessages', () => {
  it('converts OpenAI image parts to Ollama text plus bare base64 images', () => {
    expect(toOllamaMessages([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        { type: 'text', text: 'Describe this.' },
      ],
    }])).toEqual([{
      role: 'user',
      content: 'Describe this.',
      images: ['abc123'],
    }]);
  });
});

describe('parseStreamFrame — deltas', () => {
  it('parses an OpenAI-style content delta', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hi"}}]}';
    expect(parseStreamFrame(line)).toEqual({ content: 'Hi', reasoning: '', usage: null });
  });

  it('parses a reasoning delta', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}';
    expect(parseStreamFrame(line)).toEqual({ content: '', reasoning: 'thinking', usage: null });
  });

  it('normalizes llama.cpp reasoning_content deltas', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}';
    expect(parseStreamFrame(line)).toEqual({ content: '', reasoning: 'thinking', usage: null });
  });

  it('skips non-data lines and the [DONE]/✅ sentinels', () => {
    expect(parseStreamFrame(': keep-alive')).toBeNull();
    expect(parseStreamFrame('data: [DONE]')).toBeNull();
    expect(parseStreamFrame('data: ✅')).toBeNull();
    expect(parseStreamFrame('')).toBeNull();
  });

  it('skips a malformed frame instead of throwing (one bad frame must not abort the stream)', () => {
    expect(parseStreamFrame('data: {not json')).toBeNull();
  });

  it('tolerates a frame with no delta', () => {
    expect(parseStreamFrame('data: {"choices":[{}]}')).toEqual({ content: '', reasoning: '', usage: null });
  });

  it('preserves llama.cpp timing blocks from the terminal frame', () => {
    expect(parseStreamFrame('data: {"choices":[],"timings":{"prompt_n":20,"predicted_n":10,"prompt_ms":100,"predicted_ms":250}}'))
      .toMatchObject({
        content: '', reasoning: '', usage: null,
        timings: { prompt_n: 20, predicted_n: 10, prompt_ms: 100, predicted_ms: 250 },
      });
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

describe('streamOpenAiChat — pre-header retries', () => {
  it('retries an allowlisted gateway response before reading the stream', async () => {
    const cancel = vi.fn(async () => {});
    const chunk = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
    let read = false;
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, body: { cancel } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: vi.fn(async () => read
              ? { done: true }
              : (read = true, { done: false, value: chunk })),
            cancel: vi.fn(async () => {}),
          }),
        },
      });

    await expect(streamOpenAiChat({
      endpoint: 'http://127.0.0.1:11434/v1', model: 'example-model', messages: [],
    })).resolves.toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    delete global.fetch;
  });

  it('never replays a response after streamed output has begun', async () => {
    const chunk = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n');
    let reads = 0;
    const reader = {
      read: vi.fn(async () => {
        reads += 1;
        if (reads === 1) return { done: false, value: chunk };
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      }),
      cancel: vi.fn(async () => {}),
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, body: { getReader: () => reader },
    });

    const error = await streamOpenAiChat({
      endpoint: 'http://127.0.0.1:11434/v1', model: 'example-model', messages: [],
    }).catch((err) => err);
    expect(error).toMatchObject({ message: 'socket reset', partialOutput: 'partial' });
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    delete global.fetch;
  });
});

describe('parseStreamFrame', () => {
  it('carries the usage block off the terminal frame (which has no choices)', () => {
    const line = 'data: {"choices":[],"usage":{"completion_tokens":42,"prompt_tokens":900}}';
    expect(parseStreamFrame(line)).toEqual({
      content: '', reasoning: '', usage: { completion_tokens: 42, prompt_tokens: 900 },
    });
  });

  it('reports usage null on an ordinary delta frame', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hi"}}]}';
    expect(parseStreamFrame(line)).toEqual({ content: 'Hi', reasoning: '', usage: null });
  });
});

describe('normalizeUsage', () => {
  it('reads the OpenAI snake_case keys', () => {
    expect(normalizeUsage({ completion_tokens: 12, prompt_tokens: 500 }))
      .toEqual({ completionTokens: 12, promptTokens: 500 });
  });

  it('accepts camelCase and Ollama eval counts', () => {
    expect(normalizeUsage({ completionTokens: 7, promptTokens: 8 }))
      .toEqual({ completionTokens: 7, promptTokens: 8 });
    expect(normalizeUsage({ eval_count: 30, prompt_eval_count: 1200 }))
      .toEqual({ completionTokens: 30, promptTokens: 1200 });
  });

  // The sentinel contract: an absent count must stay distinguishable from a
  // reported zero, or a daemon that reports nothing looks like one that
  // generated nothing.
  it('reports null for an absent count and keeps a reported zero', () => {
    expect(normalizeUsage(null)).toEqual({ completionTokens: null, promptTokens: null });
    expect(normalizeUsage({ completion_tokens: 0 }).completionTokens).toBe(0);
  });

  it('ignores non-numeric and negative values rather than recording them', () => {
    expect(normalizeUsage({ completion_tokens: 'lots', prompt_tokens: -3 }))
      .toEqual({ completionTokens: null, promptTokens: null });
  });
});

describe('normalizeRuntimeTiming', () => {
  it('converts llama.cpp millisecond timings', () => {
    expect(normalizeRuntimeTiming({ prompt_n: 20, predicted_n: 10, prompt_ms: 100, predicted_ms: 250 }))
      .toEqual({ promptTokens: 20, completionTokens: 10, promptMs: 100, completionMs: 250 });
  });

  it('converts MTPLX seconds without falling back to TTFT subtraction', () => {
    expect(normalizeRuntimeTiming(null, { prompt_tokens: 20, generated_tokens: 10, prompt_eval_time_s: 0.1, decode_elapsed_s: 0.25 }))
      .toEqual({ promptTokens: 20, completionTokens: 10, promptMs: 100, completionMs: 250 });
  });
});

describe('parseOllamaStreamFrame', () => {
  it('reads native content and thinking deltas', () => {
    expect(parseOllamaStreamFrame(JSON.stringify({ message: { content: 'answer', thinking: 'hmm' } })))
      .toEqual({ content: 'answer', reasoning: 'hmm', usage: { message: { content: 'answer', thinking: 'hmm' } }, done: false });
  });

  it('skips malformed native lines and preserves terminal usage', () => {
    expect(parseOllamaStreamFrame('{nope')).toBeNull();
    expect(parseOllamaStreamFrame(JSON.stringify({
      done: true,
      eval_count: 42,
      prompt_eval_count: 900,
      eval_duration: 250000000,
      prompt_eval_duration: 50000000,
    }))).toMatchObject({ content: '', reasoning: '', done: true, usage: { eval_count: 42 } });
  });
});

describe('streamOllamaChat', () => {
  it('uses native options and reports exact counts plus durations', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Done.' }, done: false }),
      JSON.stringify({ done: true, eval_count: 42, prompt_eval_count: 900, eval_duration: 250000000, prompt_eval_duration: 50000000 }),
    ];
    let index = 0;
    const reader = {
      read: vi.fn(async () => index < lines.length
        ? { done: false, value: new TextEncoder().encode(`${lines[index++]}\n`) }
        : { done: true, value: undefined }),
      cancel: vi.fn(async () => {}),
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } });
    const stats = [];
    const result = await streamOllamaChat({
      endpoint: 'http://localhost:11434/v1',
      model: 'qwen3.8:27b-mlx',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      maxTokens: 96,
      extraBody: { num_ctx: 4096 },
      onStats: (value) => stats.push(value),
    });

    expect(result).toBe('Done.');
    expect(global.fetch).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.objectContaining({
      body: expect.stringContaining('"num_ctx":4096'),
    }));
    expect(stats).toEqual([{
      completionTokens: 42,
      promptTokens: 900,
      completionMs: 250,
      promptMs: 50,
      estimated: false,
    }]);
    delete global.fetch;
  });
});
