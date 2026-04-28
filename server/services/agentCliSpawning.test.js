import { describe, it, expect } from 'vitest';
import { createStreamJsonParser } from './agentCliSpawning.js';

// Helper: feed the parser a sequence of stream-json lines
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

describe('createStreamJsonParser.getFinalResult', () => {
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
