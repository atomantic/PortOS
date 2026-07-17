import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripCodeFences, parseLLMJSON, callProviderAISimple } from './aiProvider.js';

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
