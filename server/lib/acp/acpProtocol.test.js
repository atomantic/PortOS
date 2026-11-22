import { describe, expect, it, vi } from 'vitest';
import {
  JSON_RPC_ERRORS,
  buildInitializeResult,
  createLineDecoder,
  createSseParser,
  encodeAcpMessage,
  listSessionPage,
  mindHistoryUpdates,
  normalizeSessionRecords,
  parseAcpLine,
  promptToText,
  sessionTitle,
  translateAskEvent,
  translateMindEvent,
  upsertSessionRecord,
} from './acpProtocol.js';

describe('JSON-RPC framing', () => {
  it('encodes one message per line even when strings carry newlines', () => {
    const line = encodeAcpMessage({ jsonrpc: '2.0', id: 1, result: { text: 'a\nb' } });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line).result.text).toBe('a\nb');
  });

  it('reassembles lines split across chunks and strips CR', () => {
    const lines = [];
    const decoder = createLineDecoder({ onLine: (line) => lines.push(line) });
    decoder.push('{"a":');
    decoder.push('1}\r\n{"b":2}\n{"c"');
    decoder.push(Buffer.from(':3}'));
    decoder.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('keeps a multi-byte character split across chunks intact', () => {
    const lines = [];
    const decoder = createLineDecoder({ onLine: (line) => lines.push(line) });
    const bytes = Buffer.from('{"text":"café ☕"}\n');
    decoder.push(bytes.subarray(0, 13));
    decoder.push(bytes.subarray(13));
    expect(lines).toEqual(['{"text":"café ☕"}']);
    const frames = [];
    const parser = createSseParser((frame) => frames.push(frame));
    const sseBytes = Buffer.from('data: {"text":"☕"}\n\n');
    parser.push(sseBytes.subarray(0, 16));
    parser.push(sseBytes.subarray(16));
    expect(frames).toEqual([{ event: 'message', data: { text: '☕' } }]);
  });

  it('refuses an over-long line once and resumes at the next newline', () => {
    const lines = [];
    const onOverflow = vi.fn();
    const decoder = createLineDecoder({ onLine: (line) => lines.push(line), onOverflow, maxChars: 8 });
    decoder.push('0123456789');
    decoder.push('abc\n{"ok":1}\n');
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['{"ok":1}']);
  });

  it('classifies requests, notifications, responses and malformed input', () => {
    expect(parseAcpLine('')).toEqual({ kind: 'empty' });
    expect(parseAcpLine('{not json')).toMatchObject({ kind: 'invalid', id: null, error: { code: JSON_RPC_ERRORS.PARSE_ERROR } });
    expect(parseAcpLine('{"id":1,"method":"x"}')).toMatchObject({ kind: 'invalid', id: 1, error: { code: JSON_RPC_ERRORS.INVALID_REQUEST } });
    expect(parseAcpLine('{"jsonrpc":"2.0","id":2,"method":"x","params":[1]}')).toMatchObject({ kind: 'invalid', id: 2, error: { code: JSON_RPC_ERRORS.INVALID_PARAMS } });
    expect(parseAcpLine('{"jsonrpc":"2.0","id":{},"method":"x"}')).toMatchObject({ kind: 'invalid', error: { code: JSON_RPC_ERRORS.INVALID_REQUEST } });
    expect(parseAcpLine('{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"/w"}}'))
      .toEqual({ kind: 'request', id: 3, method: 'session/new', params: { cwd: '/w' } });
    expect(parseAcpLine('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}'))
      .toEqual({ kind: 'notification', method: 'session/cancel', params: { sessionId: 's' } });
    expect(parseAcpLine('{"jsonrpc":"2.0","id":"r1","result":{}}')).toEqual({ kind: 'response', id: 'r1' });
    expect(parseAcpLine('{"jsonrpc":"2.0","id":4,"method":"initialize"}')).toMatchObject({ kind: 'request', params: {} });
  });

  it('advertises load and list but no auth methods or client MCP transports', () => {
    const result = buildInitializeResult({ version: '9.9.9' });
    expect(result).toMatchObject({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: false, audio: false } },
      agentInfo: { name: 'portos', version: '9.9.9' },
    });
  });
});

describe('createSseParser', () => {
  it('dispatches named and unnamed frames across chunk splits, skipping comments', () => {
    const frames = [];
    const parser = createSseParser((frame) => frames.push(frame));
    parser.push(': open\n\nevent: delta\nda');
    parser.push('ta: {"text":"hi"}\n\n');
    parser.push('data: {"kind":"mind.reply"}\r\n\r\n');
    parser.push('data: line one\ndata: line two\n\n');
    parser.push(': keep-alive\n\n');
    parser.end();
    expect(frames).toEqual([
      { event: 'delta', data: { text: 'hi' } },
      { event: 'message', data: { kind: 'mind.reply' } },
      { event: 'message', data: 'line one\nline two' },
    ]);
  });
});

describe('promptToText', () => {
  it('keeps the typed text verbatim and labels embedded context', () => {
    expect(promptToText([
      { type: 'text', text: 'What did I decide about  the roof?' },
      { type: 'resource_link', uri: 'file:///w/notes.md', name: 'notes.md' },
      { type: 'resource', resource: { uri: 'file:///w/a.txt', text: 'alpha' } },
    ])).toEqual({
      text: 'What did I decide about  the roof?\n\n[notes.md](file:///w/notes.md)\n\nContext from file:///w/a.txt:\nalpha',
      unsupported: [],
    });
  });

  it('reports content it cannot forward instead of dropping it', () => {
    expect(promptToText([{ type: 'text', text: 'look' }, { type: 'image', data: 'x' }]).unsupported).toEqual(['image']);
    expect(promptToText(null)).toEqual({ text: '', unsupported: [] });
  });
});

describe('translateAskEvent', () => {
  it('maps the Ask Yourself stream onto ACP updates and terminals', () => {
    expect(translateAskEvent({ event: 'open', data: { conversationId: 'ask_1' } })).toEqual({ updates: [], conversationId: 'ask_1' });
    const sources = translateAskEvent({ event: 'sources', data: { sources: [{ kind: 'goal', title: 'Run a marathon' }, { title: 'Note' }] } }, { toolCallId: 't1' });
    expect(sources.updates[0]).toMatchObject({
      sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'search', status: 'completed', title: 'Retrieved 2 sources from PortOS',
    });
    expect(sources.updates[0].content[0].content.text).toBe('- goal: Run a marathon\n- Note');
    expect(translateAskEvent({ event: 'delta', data: { text: 'Hello' } }).updates)
      .toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } }]);
    expect(translateAskEvent({ event: 'done', data: {} }).terminal).toEqual({ stopReason: 'end_turn' });
    expect(translateAskEvent({ event: 'error', data: { error: 'provider down' } }).terminal).toEqual({ error: 'provider down' });
    expect(translateAskEvent({ event: 'mystery', data: {} })).toEqual({ updates: [] });
  });
});

describe('translateMindEvent', () => {
  const wake = (messageId, turnId) => ({ kind: 'mind.wake', turnId, data: { messageId } });

  it('binds to the wake for its own message and ignores every other turn', () => {
    const binding = { messageId: 'm1', turnId: null };
    expect(translateMindEvent(wake('other', 't0'), binding)).toEqual({ updates: [] });
    expect(translateMindEvent({ kind: 'mind.reply', turnId: 't0', data: { displayText: 'not ours' } }, binding)).toEqual({ updates: [] });
    const bound = translateMindEvent(wake('m1', 't1'), binding);
    expect(bound.turnId).toBe('t1');
    binding.turnId = bound.turnId;
    expect(translateMindEvent({ kind: 'mind.reply', turnId: 't0', data: { displayText: 'late other turn' } }, binding)).toEqual({ updates: [] });
  });

  it('streams thoughts, governed tool activity, the reply and the terminal of the bound turn', () => {
    const binding = { messageId: 'm1', turnId: 't1' };
    expect(translateMindEvent({ kind: 'mind.thought', turnId: 't1', data: { displayText: 'Checking tasks' } }, binding).updates[0])
      .toMatchObject({ sessionUpdate: 'agent_thought_chunk', content: { text: 'Checking tasks\n' } });
    expect(translateMindEvent({ kind: 'mind.capability.request', turnId: 't1', data: { capabilityId: 'tool-request:r9', tool: 'cos.list-tasks', displayText: 'Requested PortOS tool cos.list-tasks' } }, binding).updates[0])
      .toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'r9', status: 'in_progress', rawInput: { tool: 'cos.list-tasks' } });
    expect(translateMindEvent({ kind: 'mind.capability.result', turnId: 't1', data: { capabilityId: 'tool-result:r9', tool: 'cos.list-tasks', success: false, displayText: 'cos.list-tasks failed' } }, binding).updates[0])
      .toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'r9', status: 'failed' });
    expect(translateMindEvent({ kind: 'mind.reply', turnId: 't1', data: { displayText: 'Done.' } }, binding).updates)
      .toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }]);
    expect(translateMindEvent({ kind: 'mind.turn.completed', turnId: 't1', data: {} }, binding).terminal).toEqual({ stopReason: 'end_turn' });
    expect(translateMindEvent({ kind: 'mind.failed', turnId: 't1', data: { error: 'quota' } }, binding).terminal).toEqual({ error: 'quota' });
    const paused = translateMindEvent({ kind: 'mind.paused', turnId: 't1', data: { error: 'usage limit' } }, binding);
    expect(paused.terminal).toEqual({ stopReason: 'end_turn' });
    expect(paused.updates[0].content.text).toContain('usage limit');
  });

  it('replays only the exchanges that belong to the session', () => {
    const replay = mindHistoryUpdates([
      { kind: 'mind.message.accepted', data: { messageId: 'm1', displayText: 'hi' } },
      { kind: 'mind.message.accepted', data: { messageId: 'x', displayText: 'someone else' } },
      { kind: 'mind.reply', data: { replyToMessageId: 'm1', displayText: 'hello' } },
      { kind: 'mind.reply', data: { replyToMessageId: null, displayText: 'self-wake reply' } },
    ], ['m1', 'm0']);
    expect(replay.updates.map((update) => [update.sessionUpdate, update.content.text])).toEqual([
      ['user_message_chunk', 'hi'],
      ['agent_message_chunk', 'hello'],
    ]);
    expect(replay.missingMessageIds).toEqual(['m0']);
  });
});

describe('session records', () => {
  const record = (sessionId, updatedAt, cwd = '/w') => ({ sessionId, mode: 'ask', cwd, title: '', conversationId: null, messageIds: [], createdAt: updatedAt, updatedAt });

  it('normalizes a stored index and drops malformed rows', () => {
    expect(normalizeSessionRecords({ sessions: [record('a', '2026-01-01T00:00:00.000Z'), { sessionId: 'b', mode: 'shell' }, null] }))
      .toEqual([record('a', '2026-01-01T00:00:00.000Z')]);
    expect(normalizeSessionRecords(null)).toEqual([]);
  });

  it('upserts newest first within the cap', () => {
    let records = [];
    records = upsertSessionRecord(records, record('a', '2026-01-01T00:00:00.000Z'), 2);
    records = upsertSessionRecord(records, record('b', '2026-01-02T00:00:00.000Z'), 2);
    records = upsertSessionRecord(records, record('a', '2026-01-03T00:00:00.000Z'), 2);
    records = upsertSessionRecord(records, record('c', '2026-01-04T00:00:00.000Z'), 2);
    expect(records.map((r) => r.sessionId)).toEqual(['c', 'a']);
  });

  it('pages by cwd with an opaque cursor', () => {
    const records = [record('a', '3', '/w'), record('b', '2', '/other'), record('c', '1', '/w')];
    const first = listSessionPage(records, { cwd: '/w' }, 1);
    expect(first.sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(first.sessions[0]._meta).toEqual({ portos: { mode: 'ask' } });
    const second = listSessionPage(records, { cwd: '/w', cursor: first.nextCursor }, 1);
    expect(second).toEqual({ sessions: [expect.objectContaining({ sessionId: 'c' })] });
    expect(listSessionPage(records, {}).sessions).toHaveLength(3);
  });

  it('titles a session from its first prompt on one line', () => {
    expect(sessionTitle('  What\nshould I\tdo  ')).toBe('What should I do');
    expect(sessionTitle('x'.repeat(200))).toHaveLength(80);
  });
});
