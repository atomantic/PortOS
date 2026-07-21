import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the provider registry shim so resolveLlmEndpoint can be exercised
// without warming the AI toolkit.
vi.mock('../providers.js', () => ({ getProviderById: vi.fn() }));
import { getProviderById } from '../providers.js';

import {
  extractInlineToolCalls, isToolCapable, isReasoningModel,
  TOOL_CAPABLE_PATTERNS, REASONING_PATTERNS, resolveLlmEndpoint,
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
      id: 'nvidia-kimi', type: 'api', endpoint: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'secret', defaultModel: 'moonshotai/kimi-k2-5', name: 'NVIDIA Kimi',
      allowCustomEndpoint: true,
    });
    const ep = await resolveLlmEndpoint('nvidia-kimi');
    expect(ep.apiBase).toBe('https://integrate.api.nvidia.com/v1');
    expect(ep.apiKey).toBe('secret');
    expect(ep.defaultModel).toBe('moonshotai/kimi-k2-5');
    expect(ep.providerName).toBe('NVIDIA Kimi');
  });

  it('strips trailing slashes from the provider endpoint', async () => {
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1/', apiKey: '' });
    const ep = await resolveLlmEndpoint('ollama');
    expect(ep.apiBase).toBe('http://localhost:11434/v1');
  });

  it('falls back to the env LM Studio default for CLI/TUI providers', async () => {
    getProviderById.mockResolvedValue({ id: 'claude-code', type: 'cli', command: 'claude' });
    const ep = await resolveLlmEndpoint('claude-code');
    expect(ep.apiBase).toBe('http://localhost:1234/v1');
    expect(ep.apiKey).toBe('');
    expect(ep.defaultModel).toBeNull();
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

  it('does NOT apply the env override to non-lmstudio providers', async () => {
    process.env.LM_STUDIO_URL = 'http://10.0.0.5:1234';
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', apiKey: '' });
    const ep = await resolveLlmEndpoint('ollama');
    expect(ep.apiBase).toBe('http://localhost:11434/v1');
  });

  it('defaults to lmstudio when no provider id is passed', async () => {
    getProviderById.mockResolvedValue(null);
    const ep = await resolveLlmEndpoint();
    expect(getProviderById).toHaveBeenCalledWith('lmstudio');
    expect(ep.apiBase).toBe('http://localhost:1234/v1');
  });
});
