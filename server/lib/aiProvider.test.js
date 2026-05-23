import { describe, it, expect } from 'vitest';
import { stripCodeFences, parseLLMJSON } from './aiProvider.js';

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
