import { describe, expect, it } from 'vitest';
import {
  eventText,
  formatAgentEvent,
  isToolEvent,
  parseAgentEvents,
  parseAgentLine,
  summarizeOpenCodeEvents,
} from './opencodeStream.js';

describe('formatAgentEvent', () => {
  it('renders a tool call with the path it acted on', () => {
    expect(formatAgentEvent({ type: 'tool', part: { type: 'tool', tool: 'read', input: { filePath: 'cart-totals.mjs' } } }))
      .toEqual({ line: '● read cart-totals.mjs', toolCall: true });
  });

  it('accepts the nested envelope OpenCode also emits', () => {
    expect(formatAgentEvent({ type: 'message.part.updated', properties: { part: { type: 'text', text: 'Fixing the fallback.' } } }))
      .toEqual({ line: 'Fixing the fallback.', toolCall: false });
  });

  it('drops a frame with nothing a reader would want', () => {
    expect(formatAgentEvent({ type: 'heartbeat' })).toBeNull();
    expect(formatAgentEvent({ type: 'text', part: { type: 'text', text: '   ' } })).toBeNull();
  });
});

describe('parsing the stream', () => {
  const stream = [
    JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'read', input: { filePath: 'a.mjs' } } }),
    '',
    'not json at all',
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Thinking.' } }),
    JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'bash', input: { command: 'node a.test.mjs' } } }),
  ].join('\n');

  it('skips blank and unparsable lines rather than throwing on them', () => {
    expect(parseAgentLine('   ')).toBeNull();
    expect(parseAgentLine('not json at all')).toBeNull();
    expect(parseAgentEvents(stream)).toHaveLength(3);
  });

  it('renders the frames a reader would want, in order', () => {
    expect(parseAgentEvents(stream).map(formatAgentEvent).filter(Boolean).map((r) => r.line))
      .toEqual(['● read a.mjs', 'Thinking.', '● bash node a.test.mjs']);
  });

  it('reads assistant text without counting tool arguments as answer text', () => {
    expect(eventText({ type: 'text', part: { type: 'text', text: 'hello' } })).toBe('hello');
    expect(eventText({ type: 'tool', part: { type: 'tool', tool: 'bash', input: 'a long command' } })).toBe('');
  });

  it('recognises a tool call across every envelope version', () => {
    expect(isToolEvent({ type: 'tool_use', part: { type: 'tool' } })).toBe(true);
    expect(isToolEvent({ type: 'message.part.updated', properties: { part: { type: 'tool-call' } } })).toBe(true);
    expect(isToolEvent({ type: 'text', part: { type: 'text', text: 'x' } })).toBe(false);
  });

  it('returns an empty summary rather than throwing on no output', () => {
    expect(summarizeOpenCodeEvents('')).toEqual({ assistantChars: 0, toolCalls: 0, outputTokens: null });
    expect(summarizeOpenCodeEvents(undefined)).toEqual({ assistantChars: 0, toolCalls: 0, outputTokens: null });
  });

  it('keeps "no usage reported" distinct from a measured zero', () => {
    expect(summarizeOpenCodeEvents(JSON.stringify({ type: 'text', text: 'done' })).outputTokens).toBeNull();
    expect(summarizeOpenCodeEvents(JSON.stringify({ type: 'step_finish', part: { tokens: { output: 0 } } })).outputTokens).toBe(0);
  });
});
