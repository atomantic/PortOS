import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the provider registry shim so resolveLlmEndpoint can be exercised
// without warming the AI toolkit.
vi.mock('../provider/providers.js', () => ({ getProviderById: vi.fn() }));
import { getProviderById } from '../provider/providers.js';
vi.mock('./llmResidency.js', () => ({ probeVoiceLlmResidency: vi.fn() }));
import { probeVoiceLlmResidency } from './llmResidency.js';
vi.mock('../socketIo.js', () => ({ emitToOperators: vi.fn() }));
import { emitToOperators } from '../socketIo.js';
import { CONVERSATIONAL_GEMMA } from '../../lib/voiceModelCatalog.js';

import {
  extractInlineToolCalls, isToolCapable, isReasoningModel,
  TOOL_CAPABLE_PATTERNS, REASONING_PATTERNS, resolveLlmEndpoint,
  streamChat, VOICE_LLM_TIMEOUT_MS, VOICE_LLM_TIMEOUT_MESSAGE, VOICE_LLM_COLD_LOAD_TIMEOUT_MS,
  readVoiceLlmResidency, markVoiceLlmWarming,
} from './llm.js';

describe('extractInlineToolCalls', () => {
  it('returns empty when no tag is present', () => {
    const { text, toolCalls } = extractInlineToolCalls('Just plain prose.');
    expect(text).toBe('Just plain prose.');
    expect(toolCalls).toEqual([]);
  });

  it('extracts a single Granite-style tool call', () => {
    const raw = 'Let me check. <tool_call>[{"name": "time_now", "arguments": {}}]</tool_call>';
    const { text, toolCalls } = extractInlineToolCalls(raw);
    expect(text).toBe('Let me check.');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('time_now');
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({});
    expect(toolCalls[0].type).toBe('function');
  });

  it('extracts multiple tool calls from one array', () => {
    const raw = '<tool_call>[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":{"y":"z"}}]</tool_call>';
    const { text, toolCalls } = extractInlineToolCalls(raw);
    expect(text).toBe('');
    expect(toolCalls.map((t) => t.function.name)).toEqual(['a', 'b']);
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ x: 1 });
    expect(JSON.parse(toolCalls[1].function.arguments)).toEqual({ y: 'z' });
  });

  it('accepts `parameters` as an alias for `arguments`', () => {
    const raw = '<tool_call>[{"name":"foo","parameters":{"q":"test"}}]</tool_call>';
    const { toolCalls } = extractInlineToolCalls(raw);
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ q: 'test' });
  });

  it('survives malformed JSON inside the tag', () => {
    const raw = 'Prefix <tool_call>[not json]</tool_call> suffix.';
    const { text, toolCalls } = extractInlineToolCalls(raw);
    expect(toolCalls).toEqual([]);
    expect(text).toContain('Prefix');
    expect(text).toContain('suffix.');
  });

  it('skips array entries missing a name', () => {
    const raw = '<tool_call>[{"arguments":{"x":1}},{"name":"ok","arguments":{}}]</tool_call>';
    const { toolCalls } = extractInlineToolCalls(raw);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('ok');
  });

  it('handles the unclosed tag form Granite 3.2 actually emits', () => {
    const raw = '<tool_call>[{"name": "time_now", "arguments": {}}]';
    const { text, toolCalls } = extractInlineToolCalls(raw);
    expect(text).toBe('');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('time_now');
  });

  it('also handles <tool_request> spelling (Granite varies between requests)', () => {
    const raw = '<tool_request>[{"name": "time_now", "arguments": {}}]';
    const { text, toolCalls } = extractInlineToolCalls(raw);
    expect(text).toBe('');
    expect(toolCalls).toHaveLength(1);
  });

  it('handles closed <tool_request>...</tool_request> form', () => {
    const raw = 'OK. <tool_request>[{"name":"x","arguments":{}}]</tool_request>';
    const { text, toolCalls } = extractInlineToolCalls(raw);
    expect(text).toBe('OK.');
    expect(toolCalls).toHaveLength(1);
  });

  it('unclosed tag with prose prefix keeps the prose', () => {
    const raw = 'Sure, one sec. <tool_call>[{"name":"foo","arguments":{"a":1}}]';
    const { text, toolCalls } = extractInlineToolCalls(raw);
    expect(text).toBe('Sure, one sec.');
    expect(toolCalls).toHaveLength(1);
  });

  it('handles nested arrays / brackets inside arguments', () => {
    const raw = '<tool_call>[{"name":"q","arguments":{"xs":[1,2,3]}}]</tool_call>';
    const { toolCalls } = extractInlineToolCalls(raw);
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ xs: [1, 2, 3] });
  });

  it('handles brackets inside JSON strings without false-closing', () => {
    const raw = '<tool_call>[{"name":"q","arguments":{"note":"has ] bracket"}}]</tool_call>';
    const { toolCalls } = extractInlineToolCalls(raw);
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ note: 'has ] bracket' });
  });
});

describe('isToolCapable', () => {
  it('accepts known tool-use families', () => {
    for (const id of [
      'qwen2.5-7b-instruct',
      'Qwen2.5-14B-Instruct',
      'lmstudio-community/Qwen2.5-7B-Instruct-GGUF',
      'qwen/qwen3-4b-2507',
      'qwen/qwen3.5-9b',
      'qwen/qwen3.6-35b-a3b',
      'NousResearch/Hermes-3-Llama-3.1-8B',
      'hermes3', // bare Ollama registry tag for the Hermes 3 catalog card
      'lmstudio-community/Qwen2.5-3B-Instruct-GGUF', // Qwen2.5 3B catalog card
      // Bare Ollama registry tags (no "instruct" token) for tool-capable families.
      'qwen2.5:latest',
      'qwen2.5',
      'qwen3:30b',
      'llama3.1:8b',
      'llama3.2:latest',
      'llama3.3:70b',
      'mistralai/Mistral-Small-24B-Instruct',
      'mistralai/devstral-small-2-2512',
      'mistralai/ministral-3-14b-reasoning',
      'meta-llama/Llama-3.1-8B-Instruct',
    ]) {
      expect(isToolCapable(id), id).toBe(true);
    }
  });

  it('rejects non-tool-use families', () => {
    for (const id of [
      'ibm/granite-3.2-8b',
      'ibm/granite-3.1-2b-base',
      'gemma-3-270m-it',
      'l3.3-70b-euryale-v2.3-i1',
      'text-embedding-nomic-embed-text-v1.5',
      // Vision / embedding / reranker variants of the bare-tag families must NOT
      // match the broadened Ollama patterns — they can't chat or call tools, and
      // auto-selecting one as the voice brain would hard-fail every tool turn.
      'qwen2.5vl:32b',
      'llama3.2-vision',
      'qwen3-embedding',
      'dengcao/qwen3-embedding-8b:q4_k_m',
      'qwen3-reranker',
      'qwen2.5-omni',
    ]) {
      expect(isToolCapable(id), id).toBe(false);
    }
  });

  it('exports the pattern list for introspection', () => {
    expect(Array.isArray(TOOL_CAPABLE_PATTERNS)).toBe(true);
    expect(TOOL_CAPABLE_PATTERNS.every((p) => p instanceof RegExp)).toBe(true);
  });
});

describe('isReasoningModel', () => {
  it('flags reasoning models that pre-generate <think> tokens', () => {
    for (const id of [
      'mistralai/ministral-3-14b-reasoning',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
      'qwen/qwq-32b-preview',
      'openai/o1-mini',
      'qwen3-7b-thinking',
    ]) {
      expect(isReasoningModel(id), id).toBe(true);
    }
  });

  it('does not flag fast non-reasoning instruct models', () => {
    for (const id of [
      'qwen2.5-7b-instruct',
      'lmstudio-community/Qwen2.5-7B-Instruct-GGUF',
      'mistralai/Mistral-Small-24B-Instruct',
      'mistralai/devstral-small-2-2512',
      'NousResearch/Hermes-3-Llama-3.1-8B',
      'meta-llama/Llama-3.1-8B-Instruct',
    ]) {
      expect(isReasoningModel(id), id).toBe(false);
    }
  });

  it('exports the pattern list for introspection', () => {
    expect(Array.isArray(REASONING_PATTERNS)).toBe(true);
    expect(REASONING_PATTERNS.length).toBeGreaterThan(0);
    expect(REASONING_PATTERNS.every((p) => p instanceof RegExp)).toBe(true);
  });
});

describe('resolveLlmEndpoint', () => {
  const ORIG_ENV = process.env.LM_STUDIO_URL;
  beforeEach(() => {
    getProviderById.mockReset();
    delete process.env.LM_STUDIO_URL;
  });
  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.LM_STUDIO_URL;
    else process.env.LM_STUDIO_URL = ORIG_ENV;
  });

  it('uses an API provider endpoint, apiKey, and default model', async () => {
    getProviderById.mockResolvedValue({
      id: 'nvidia-nim', type: 'api', endpoint: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'secret', defaultModel: 'poolside/laguna-xs-2.1', name: 'NVIDIA NIM',
    });
    const ep = await resolveLlmEndpoint('nvidia-nim');
    expect(ep.apiBase).toBe('https://integrate.api.nvidia.com/v1');
    expect(ep.apiKey).toBe('secret');
    expect(ep.defaultModel).toBe('poolside/laguna-xs-2.1');
    expect(ep.providerName).toBe('NVIDIA NIM');
  });

  it('strips trailing slashes from the provider endpoint', async () => {
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1/', apiKey: '' });
    const ep = await resolveLlmEndpoint('ollama');
    expect(ep.apiBase).toBe('http://localhost:11434/v1');
  });

  it('falls back to the default local backend for CLI/TUI providers', async () => {
    getProviderById.mockResolvedValue({ id: 'claude-code', type: 'cli', command: 'claude' });
    const ep = await resolveLlmEndpoint('claude-code');
    expect(ep.apiBase).toBe('http://localhost:11434/v1');
    expect(ep.providerName).toBe('Ollama');
    expect(ep.apiKey).toBe('');
    expect(ep.defaultModel).toBeNull();
  });

  // A named local backend must not be silently redirected to the default one:
  // an install that pinned lmstudio and whose provider record went missing has
  // to keep landing on LM Studio, or voice quietly talks to the wrong daemon.
  it('falls back to the NAMED local backend rather than the default one', async () => {
    getProviderById.mockResolvedValue(null);
    const ep = await resolveLlmEndpoint('lmstudio');
    expect(ep.apiBase).toBe('http://localhost:1234/v1');
    expect(ep.providerName).toBe('LM Studio');
  });

  it('falls back when the provider is missing or the lookup throws', async () => {
    getProviderById.mockRejectedValue(Object.assign(new Error('not ready'), { code: 'AI_TOOLKIT_NOT_INITIALIZED' }));
    const ep = await resolveLlmEndpoint('lmstudio');
    expect(ep.apiBase).toBe('http://localhost:1234/v1');
  });

  it('honors LM_STUDIO_URL env override for the built-in lmstudio provider', async () => {
    process.env.LM_STUDIO_URL = 'http://10.0.0.5:1234';
    getProviderById.mockResolvedValue({ id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1', apiKey: 'lm-studio' });
    const ep = await resolveLlmEndpoint('lmstudio');
    // Env override wins over the registry endpoint for back-compat.
    expect(ep.apiBase).toBe('http://10.0.0.5:1234/v1');
  });

  it('blocks a key-bearing lmstudio provider pointed at a cloud-metadata host', async () => {
    getProviderById.mockResolvedValue({
      id: 'lmstudio', type: 'api', endpoint: 'http://169.254.169.254/v1', apiKey: 'leaked',
    });
    await expect(resolveLlmEndpoint('lmstudio')).rejects.toThrow(/Blocked outbound API-key request/);
  });

  it('allows a keyless lmstudio provider at any host (guard no-ops without a key)', async () => {
    getProviderById.mockResolvedValue({
      id: 'lmstudio', type: 'api', endpoint: 'http://192.0.2.10:1234/v1', apiKey: '',
    });
    const ep = await resolveLlmEndpoint('lmstudio');
    expect(ep.apiBase).toBe('http://192.0.2.10:1234/v1');
  });

  it('does NOT apply the env override to non-lmstudio providers', async () => {
    process.env.LM_STUDIO_URL = 'http://10.0.0.5:1234';
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', apiKey: '' });
    const ep = await resolveLlmEndpoint('ollama');
    expect(ep.apiBase).toBe('http://localhost:11434/v1');
  });

  it('defaults to ollama when no provider id is passed', async () => {
    getProviderById.mockResolvedValue(null);
    const ep = await resolveLlmEndpoint();
    expect(getProviderById).toHaveBeenCalledWith('ollama');
    expect(ep.apiBase).toBe('http://localhost:11434/v1');
  });
});

describe('streamChat request lifecycle', () => {
  let fetchMock;
  let chatSignal;

  const provider = {
    id: 'test-provider',
    type: 'api',
    endpoint: 'https://example.com/v1',
    apiKey: '',
    defaultModel: 'test-model',
    name: 'Test Provider',
  };

  const modelResponse = () => Promise.resolve({
    ok: true,
    json: async () => ({ data: [{ id: 'test-model' }] }),
  });

  const pendingUntilAbort = (signal) => new Promise((_, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

  const installFetch = (chatFetch) => {
    fetchMock.mockImplementation((url, options = {}) => {
      if (url.endsWith('/models')) return modelResponse();
      chatSignal = options.signal;
      return chatFetch(options);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    getProviderById.mockReset();
    getProviderById.mockResolvedValue(provider);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ['inkling-2-mini:26b-a5b-nvfp4', undefined],
    ['inkling-2-mini:26b-a5b-nvfp4', 240],
    ['qwen3.6:35b', undefined],
  ])('sets Ollama thinking off for %s and preserves only an explicit maxTokens (%s)', async (model, maxTokens) => {
    const messages = [{ role: 'system', content: 'Keep replies short.' }];
    const tools = [{ type: 'function', function: { name: 'read_clock' } }];
    getProviderById.mockResolvedValue({ ...provider, id: 'ollama', defaultModel: model });
    installFetch(() => Promise.resolve(new Response(
      'data: {"choices":[{"delta":{"content":"Hello."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )));

    await expect(streamChat(messages, { provider: 'ollama', model: 'auto', tools, maxTokens }))
      .resolves.toMatchObject({ text: 'Hello.', finishReason: 'stop' });
    const body = JSON.parse(fetchMock.mock.lastCall[1].body);
    expect(body).toMatchObject({ model, messages, reasoning_effort: 'none', tools, tool_choice: 'auto' });
    if (maxTokens === undefined) expect(body).not.toHaveProperty('max_tokens');
    else expect(body.max_tokens).toBe(maxTokens);
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });

  it('streams a structured tool call and speaks the tool result through the exact Conversational Gemma pin', async () => {
    const requested = CONVERSATIONAL_GEMMA.id;
    const served = requested.toLowerCase();
    const messages = [{ role: 'user', content: 'Is ticket B42 ready?' }];
    const tools = [{ type: 'function', function: { name: 'lookup_repair', parameters: {
      type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'],
    } } }];
    const toolCall = {
      id: 'call-1', type: 'function', function: { name: 'lookup_repair', arguments: JSON.stringify({ ticket: 'B42' }) },
    };
    const trace = [];
    fetchMock.mockImplementation(async (url, options = {}) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gemma4:31b' }, { id: served }] });
      const body = JSON.parse(options.body);
      trace.push(body);
      const choice = body.messages.at(-1)?.role === 'tool'
        ? { delta: { content: 'Your bike is ready to pick up.' }, finish_reason: 'stop' }
        : { delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: 'tool_calls' };
      return new Response('data: ' + JSON.stringify({ choices: [choice] }) + '\n\ndata: [DONE]\n\n');
    });

    const first = await streamChat(messages, { provider: 'test-provider', model: requested, tools });
    expect(first.finishReason).toBe('tool_calls');
    expect(first.toolCalls[0]).toMatchObject(toolCall);
    const replay = [...messages, { role: 'assistant', content: '', tool_calls: [toolCall] },
      { role: 'tool', tool_call_id: toolCall.id, content: '{"status":"ready"}' }];
    const onDelta = vi.fn();
    const second = await streamChat(replay, { provider: 'test-provider', model: requested, tools, onDelta });
    expect(second).toMatchObject({ model: served, text: 'Your bike is ready to pick up.' });
    expect(onDelta).toHaveBeenCalledWith('Your bike is ready to pick up.');
    expect(trace[0]).toMatchObject({ model: served, messages, tools, tool_choice: 'auto',
      chat_template_kwargs: { enable_thinking: false } });
    expect(trace[0]).not.toHaveProperty('max_tokens');
    expect(trace[1]).toMatchObject({ model: served, messages: replay, tools });
  });

  it('does not silently send a Conversational Gemma request to the base Gemma', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 'gemma4:31b' }] }));
    await expect(streamChat([], { provider: 'test-provider', model: CONVERSATIONAL_GEMMA.id }))
      .rejects.toThrow('does not serve Conversational Gemma 4 31B');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pins /no_think to the persona so per-turn system blocks never change the cached prefix', async () => {
    const model = 'qwen3-7b-thinking';
    fetchMock.mockImplementation(async (url) => (url.endsWith('/models')
      ? Response.json({ data: [{ id: model }] })
      : new Response('data: [DONE]\n\n')));
    const persona = { role: 'system', content: 'Keep replies short.' };
    const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const sent = async (messages) => {
      await streamChat(messages, { provider: 'test-provider', model });
      return JSON.parse(fetchMock.mock.lastCall[1].body).messages;
    };

    const plain = await sent([persona, ...history, { role: 'user', content: 'what time is it' }]);
    const withUi = await sent([persona, ...history, { role: 'system', content: 'Current UI state: Tasks' }, { role: 'user', content: 'click new task' }]);
    expect(plain[0].content).toBe('Keep replies short.\n/no_think');
    expect(withUi.slice(0, 3)).toEqual(plain.slice(0, 3));
    expect(withUi[3].content).toBe('Current UI state: Tasks');
  });

  it('lets other providers choose their output budget without sending the Ollama-only effort', async () => {
    installFetch(() => Promise.resolve(new Response('data: [DONE]\n\n')));
    await streamChat([], { provider: 'test-provider', model: 'test-model' });
    expect(JSON.parse(fetchMock.mock.lastCall[1].body)).not.toHaveProperty('max_tokens');
    expect(JSON.parse(fetchMock.mock.lastCall[1].body)).not.toHaveProperty('reasoning_effort');
  });

  it('aborts a provider request that never returns headers', async () => {
    installFetch(({ signal }) => pendingUntilAbort(signal));
    const onTimeout = vi.fn();

    const result = streamChat([], {
      provider: 'test-provider', model: 'test-model', onTimeout,
    });
    const rejection = expect(result).rejects.toThrow(VOICE_LLM_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);

    await rejection;
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(chatSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('announces a cold model before the request and gives the load the longer budget', async () => {
    probeVoiceLlmResidency.mockResolvedValue({ state: 'unloaded', runtime: 'ollama', model: 'test-model' });
    const order = [];
    installFetch(({ signal }) => {
      order.push('request');
      return pendingUntilAbort(signal);
    });
    const onModelLoading = vi.fn(() => order.push('loading'));

    const result = streamChat([], { provider: 'test-provider', model: 'test-model', onModelLoading });
    const rejection = expect(result).rejects.toThrow(VOICE_LLM_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);
    expect(chatSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_COLD_LOAD_TIMEOUT_MS - VOICE_LLM_TIMEOUT_MS);

    await rejection;
    expect(onModelLoading).toHaveBeenCalledWith({ model: 'test-model' });
    expect(order).toEqual(['loading', 'request']);
  });

  it('stays quiet and keeps the normal budget for a resident model', async () => {
    probeVoiceLlmResidency.mockResolvedValue({ state: 'loaded', runtime: 'ollama', model: 'test-model' });
    installFetch(() => Promise.resolve(new Response('data: [DONE]\n\n')));
    const onModelLoading = vi.fn();
    await streamChat([], { provider: 'test-provider', model: 'test-model', onModelLoading });
    expect(onModelLoading).not.toHaveBeenCalled();
  });

  it('aborts a provider stream that stops yielding SSE data', async () => {
    let releaseRead;
    const reader = {
      read: vi.fn(() => new Promise((resolve) => { releaseRead = resolve; })),
      cancel: vi.fn(() => {
        releaseRead?.({ value: undefined, done: true });
        return Promise.resolve();
      }),
    };
    installFetch(({ signal }) => Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    }));

    const result = streamChat([], { provider: 'test-provider', model: 'test-model' });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(1));
    const rejection = expect(result).rejects.toThrow(VOICE_LLM_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);

    await rejection;
    expect(chatSignal.aborted).toBe(true);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds a stream that keeps yielding without completing', async () => {
    let releaseRead;
    let reads = 0;
    const reader = {
      read: vi.fn(() => {
        reads++;
        if (reads === 1) {
          return Promise.resolve({
            value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Still working"}}]}\n\n'),
            done: false,
          });
        }
        return new Promise((resolve) => { releaseRead = resolve; });
      }),
      cancel: vi.fn(() => {
        releaseRead?.({ value: undefined, done: true });
        return Promise.resolve();
      }),
    };
    installFetch(() => Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    }));

    const result = streamChat([], { provider: 'test-provider', model: 'test-model' });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    const rejection = expect(result).rejects.toThrow(VOICE_LLM_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);

    await rejection;
    expect(chatSignal.aborted).toBe(true);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit cancellation when an active reader closes as done', async () => {
    let releaseRead;
    const reader = {
      read: vi.fn(() => new Promise((resolve) => { releaseRead = resolve; })),
      cancel: vi.fn(() => {
        releaseRead?.({ value: undefined, done: true });
        return Promise.resolve();
      }),
    };
    installFetch(() => Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    }));

    const external = new AbortController();
    const result = streamChat([], {
      provider: 'test-provider', model: 'test-model', signal: external.signal,
    });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(1));
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    external.abort();

    await rejection;
    expect(chatSignal.aborted).toBe(true);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);
  });

  it('clears the deadline and external abort listener after a successful stream', async () => {
    const external = new AbortController();
    const chunks = [
      { value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'), done: false },
      { value: new TextEncoder().encode('data: [DONE]\n\n'), done: false },
    ];
    const reader = { read: vi.fn(async () => chunks.shift() || { value: undefined, done: true }) };
    installFetch(() => Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } }));

    await expect(streamChat([], {
      provider: 'test-provider', model: 'test-model', signal: external.signal,
    })).resolves.toMatchObject({ text: 'Hello', model: 'test-model' });

    expect(chatSignal.aborted).toBe(false);
    external.abort();
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);
    expect(chatSignal.aborted).toBe(false);
  });

  it('clears the deadline after a provider failure', async () => {
    const providerError = new Error('provider unavailable');
    installFetch(() => Promise.reject(providerError));

    await expect(streamChat([], { provider: 'test-provider', model: 'test-model' }))
      .rejects.toBe(providerError);

    expect(chatSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);
    expect(chatSignal.aborted).toBe(false);
  });

  it('preserves an explicit caller cancellation instead of reporting a timeout', async () => {
    const external = new AbortController();
    installFetch(({ signal }) => pendingUntilAbort(signal));

    const result = streamChat([], {
      provider: 'test-provider', model: 'test-model', signal: external.signal,
    });
    await vi.waitFor(() => expect(chatSignal).toBeInstanceOf(AbortSignal));
    external.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(chatSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(VOICE_LLM_TIMEOUT_MS);
  });
});

describe('readVoiceLlmResidency while a warm-up loads the model', () => {
  beforeEach(() => {
    getProviderById.mockReset();
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', apiKey: '' });
    probeVoiceLlmResidency.mockReset();
    probeVoiceLlmResidency.mockResolvedValue({ state: 'unloaded', runtime: 'ollama', model: 'model-a' });
    emitToOperators.mockClear();
  });

  it('reports loading until the warm-up releases, and tells open views each time', async () => {
    const release = markVoiceLlmWarming('ollama', 'model-a');
    expect(emitToOperators).toHaveBeenCalledWith('voice:llm:residency:changed');
    expect(await readVoiceLlmResidency({ provider: 'ollama', model: 'model-a' })).toMatchObject({ state: 'loading' });
    expect(await readVoiceLlmResidency({ provider: 'ollama', model: 'model-b' })).toMatchObject({ state: 'unloaded' });

    release();
    release();
    expect(emitToOperators).toHaveBeenCalledTimes(2);
    expect(await readVoiceLlmResidency({ provider: 'ollama', model: 'model-a' })).toMatchObject({ state: 'unloaded' });
  });

  it('keeps a resident or offline answer from the runtime', async () => {
    const release = markVoiceLlmWarming('ollama', 'model-a');
    probeVoiceLlmResidency.mockResolvedValueOnce({ state: 'loaded', runtime: 'ollama', model: 'model-a' });
    expect(await readVoiceLlmResidency({ provider: 'ollama', model: 'model-a' })).toMatchObject({ state: 'loaded' });
    probeVoiceLlmResidency.mockResolvedValueOnce({ state: 'offline', runtime: 'ollama', model: 'model-a' });
    expect(await readVoiceLlmResidency({ provider: 'ollama', model: 'model-a' })).toMatchObject({ state: 'offline' });
    release();
  });
});
