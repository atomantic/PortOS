import { describe, it, expect } from 'vitest';
import { extractInlineToolCalls, isToolCapable, isReasoningModel, TOOL_CAPABLE_PATTERNS, REASONING_PATTERNS } from './llm.js';

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
