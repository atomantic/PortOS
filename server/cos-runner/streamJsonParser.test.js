import { describe, it, expect } from 'vitest';
import { summarizeToolInput, safeParse, createStreamJsonParser } from './streamJsonParser.js';

describe('cos-runner streamJsonParser', () => {
  describe('safeParse', () => {
    it('parses valid JSON', () => {
      expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    });
    it('returns null on invalid JSON', () => {
      expect(safeParse('not json')).toBeNull();
      expect(safeParse('')).toBeNull();
    });
  });

  describe('summarizeToolInput', () => {
    it('returns empty for non-object input', () => {
      expect(summarizeToolInput('Read', null)).toBe('');
      expect(summarizeToolInput('Read', 'str')).toBe('');
    });
    it('shortens long file paths to last two segments', () => {
      expect(summarizeToolInput('Read', { file_path: '/a/b/c/d/e.js' })).toBe('…/d/e.js');
    });
    it('keeps short paths intact', () => {
      expect(summarizeToolInput('Edit', { file_path: 'a/b.js' })).toBe('a/b.js');
    });
    it('summarizes Bash by command, truncated to 80 chars', () => {
      const long = 'x'.repeat(100);
      expect(summarizeToolInput('Bash', { command: long })).toBe('x'.repeat(80));
    });
    it('falls back to description for Bash without command', () => {
      expect(summarizeToolInput('Bash', { description: 'list files' })).toBe('list files');
    });
    it('summarizes Grep with pattern and path', () => {
      expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('"foo" in src');
    });
    it('summarizes TodoWrite with item count', () => {
      expect(summarizeToolInput('TodoWrite', { todos: [1, 2, 3] })).toBe('3 items');
    });
    it('returns empty for unknown tool', () => {
      expect(summarizeToolInput('Mystery', { foo: 1 })).toBe('');
    });
  });

  describe('createStreamJsonParser', () => {
    const evt = (obj) => JSON.stringify(obj) + '\n';

    it('extracts streamed text deltas as lines', () => {
      const p = createStreamJsonParser();
      const out = p.processChunk(
        evt({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello\nworld' } } })
      );
      expect(out).toEqual(['hello']);
      expect(p.flush()).toEqual(['world']);
    });

    it('emits a tool-use marker and detail summary', () => {
      const p = createStreamJsonParser();
      p.processChunk(evt({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read' } } }));
      p.processChunk(evt({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a/b/c/x.js"}' } } }));
      const out = p.processChunk(evt({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
      expect(out).toEqual(['  → …/c/x.js']);
    });

    it('returns the result field as final output for a single section', () => {
      const p = createStreamJsonParser();
      p.processChunk(evt({ type: 'result', result: 'final answer' }));
      expect(p.getFinalResult()).toBe('final answer');
    });

    it('joins multiple text turns for multi-section runs', () => {
      const p = createStreamJsonParser();
      // turn 1
      p.processChunk(evt({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'turn one' } } }));
      p.processChunk(evt({ type: 'result', result: 'r1' }));
      // turn 2
      p.processChunk(evt({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'turn two' } } }));
      p.processChunk(evt({ type: 'result', result: 'r2' }));
      expect(p.getFinalResult()).toBe('turn one\n\nturn two');
    });

    it('ignores non-JSON noise lines', () => {
      const p = createStreamJsonParser();
      expect(p.processChunk('garbage stderr line\n')).toEqual([]);
    });
  });
});
