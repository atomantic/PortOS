import { describe, it, expect } from 'vitest';
import { summarizeToolInput, safeParse, createStreamJsonParser } from './streamJsonParser.js';

describe('lib/streamJsonParser', () => {
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

    describe('getFinalResult', () => {
      // Helper used by getFinalResult tests: feed a sequence of stream-json events then flush
      function runStream(parser, events) {
        for (const ev of events) {
          parser.processChunk(JSON.stringify(ev) + '\n');
        }
        parser.flush();
      }

      const textDelta = (text) => ({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
      });

      const toolStart = (index, name) => ({
        type: 'stream_event',
        event: { type: 'content_block_start', index, content_block: { type: 'tool_use', name } }
      });

      const toolStop = (index) => ({
        type: 'stream_event',
        event: { type: 'content_block_stop', index }
      });

      const resultEvent = (result) => ({ type: 'result', result });

      it('returns only the final wrap-up — interim narrations between tool calls are discarded', () => {
        const parser = createStreamJsonParser();
        runStream(parser, [
          textDelta('Now I have all the info I need. Let me make the changes:\n'),
          toolStart(1, 'Read'),
          toolStop(1),
          textDelta('Now let me run the relevant tests to verify nothing broke:\n'),
          toolStart(2, 'Bash'),
          toolStop(2),
          textDelta('Changes look clean. Now let me update the changelog and commit:\n'),
          toolStart(3, 'Edit'),
          toolStop(3),
          textDelta('## Summary\n\nAdded a `/do:replan` button to the Agent Operations section.'),
          resultEvent('## Summary\n\nAdded a `/do:replan` button to the Agent Operations section.')
        ]);

        const finalResult = parser.getFinalResult();
        expect(finalResult).toContain('## Summary');
        expect(finalResult).toContain('Added a `/do:replan` button');
        expect(finalResult).not.toContain('Now I have all the info');
        expect(finalResult).not.toContain('Now let me run the relevant tests');
        expect(finalResult).not.toContain('Changes look clean');
      });

      it('preserves both summaries across multiple result events (e.g., task + /simplify)', () => {
        const parser = createStreamJsonParser();
        runStream(parser, [
          textDelta('Investigating the bug.\n'),
          toolStart(1, 'Read'),
          toolStop(1),
          textDelta('Task summary: fixed the bug.'),
          resultEvent('Task summary: fixed the bug.'),
          textDelta('Now running /simplify.\n'),
          toolStart(2, 'Read'),
          toolStop(2),
          textDelta('Simplify summary: code is clean.'),
          resultEvent('Simplify summary: code is clean.')
        ]);

        const finalResult = parser.getFinalResult();
        expect(finalResult).toContain('Task summary: fixed the bug.');
        expect(finalResult).toContain('Simplify summary: code is clean.');
        expect(finalResult).not.toContain('Investigating the bug');
        expect(finalResult).not.toContain('Now running /simplify');
      });

      it('returns the CLI result field for a single-turn task with no interim narration', () => {
        const parser = createStreamJsonParser();
        runStream(parser, [
          toolStart(1, 'Read'),
          toolStop(1),
          textDelta('Done. All tests pass.'),
          resultEvent('Done. All tests pass.')
        ]);

        expect(parser.getFinalResult()).toBe('Done. All tests pass.');
      });
    });
  });
});
