import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getVoiceConfig: vi.fn(),
  streamChat: vi.fn(),
  dispatchTool: vi.fn(),
  transcribe: vi.fn(),
  synthesize: vi.fn(),
  appendJournal: vi.fn(),
  getToday: vi.fn(),
}));

vi.mock('./config.js', () => ({ getVoiceConfig: mocks.getVoiceConfig }));
vi.mock('./llm.js', () => ({ streamChat: mocks.streamChat }));
vi.mock('./stt.js', () => ({ transcribe: mocks.transcribe }));
vi.mock('./tts.js', () => ({ synthesize: mocks.synthesize }));
vi.mock('../brainJournal.js', () => ({ appendJournal: mocks.appendJournal, getToday: mocks.getToday }));
vi.mock('./echo.js', () => ({ isEchoOfRecentTts: () => false, rememberTtsSentence: vi.fn() }));
vi.mock('./tools.js', () => ({
  dispatchTool: mocks.dispatchTool,
  getToolSpecsForIntent: () => ({ specs: [], activeGroups: new Set(['ui']) }),
  classifyIntent: () => new Set(),
  getAllToolNames: () => [],
  UI_KINDS: ['tab', 'button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'],
}));

const { runTurn } = await import('./pipeline.js');

const toolCall = (name, args, extra = {}) => ({
  type: 'function', function: { name, arguments: args }, ...extra,
});
const completion = (text, toolCalls = []) => ({
  text, toolCalls, model: 'test-model', ttfbMs: 1, totalMs: 2, finishReason: 'stop',
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.getVoiceConfig.mockResolvedValue({
    llm: { model: 'test-model', systemPrompt: 'sys', usePersonality: false, tools: { enabled: true, maxIterations: 3 } },
  });
  mocks.synthesize.mockResolvedValue({ wav: Buffer.alloc(8), latencyMs: 7 });
  mocks.getToday.mockResolvedValue('2026-01-02');
  mocks.streamChat.mockResolvedValue(completion('Ready.'));
});

afterEach(() => vi.useRealTimers());

describe('runTurn tool execution', () => {
  it('refreshes UI before continuing, pairs missing call IDs, and applies dictation effects in order', async () => {
    const seenMessages = [];
    mocks.streamChat.mockImplementation(async (messages, { onDelta }) => {
      seenMessages.push(structuredClone(messages));
      if (seenMessages.length === 1) {
        onDelta('Opening. ');
        return completion('Opening.', [
          toolCall('ui_navigate', '{"path":"/example"}', { index: 4 }),
          toolCall('daily_log_stop_dictation', '{}'),
        ]);
      }
      return completion('Ready.');
    });
    mocks.dispatchTool.mockImplementation(async (name, _args, ctx) => {
      if (name === 'ui_navigate') ctx.sideEffects.push({ type: 'navigate', path: '/example' });
      else ctx.sideEffects.push({ type: 'dictation', enabled: false });
      return { ok: true };
    });
    const state = { dictation: { enabled: true, date: '2026-01-01' } };
    const signal = new AbortController().signal;
    const hasHostControl = () => true;
    const events = [];
    const turn = runTurn({ text: 'open the example', state, signal, hasHostControl,
      emit: (event, payload) => events.push({ event, payload }) });

    await vi.waitFor(() => expect(state.uiWaiters).toHaveLength(1));
    expect(mocks.dispatchTool).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ event: 'voice:navigate', payload: { path: '/example' } });
    const refreshed = { title: 'Example page', elements: [{ kind: 'button', label: 'Save example' }] };
    state.ui = refreshed;
    for (const waiter of [...state.uiWaiters]) waiter(refreshed);

    await expect(turn).resolves.toEqual({ transcript: 'open the example', reply: 'Opening. Ready.' });
    const assistant = seenMessages[1].find(message => message.role === 'assistant');
    expect(assistant.tool_calls.map(call => call.id)).toEqual(['call_0_4', 'call_0_1']);
    const results = seenMessages[1].filter(message => message.role === 'tool');
    expect(results.map(message => message.tool_call_id)).toEqual(['call_0_4', 'call_0_1']);
    expect(JSON.parse(results[0].content)).toEqual({ ok: true, ui: 'Page: Example page. Buttons: Save example.' });
    expect(JSON.parse(results[1].content)).toEqual({ ok: true });
    expect(state.dictation).toEqual({ enabled: false, date: null });
    expect(state.uiWaiters).toEqual([]);
    expect(mocks.dispatchTool.mock.calls.every(([, , ctx]) => ctx.hasHostControl === hasHostControl && ctx.signal === signal && ctx.state === state)).toBe(true);
    expect(events.filter(({ event }) => ['voice:navigate', 'voice:dictation', 'voice:tool'].includes(event)).map(({ event }) => event))
      .toEqual(['voice:navigate', 'voice:tool', 'voice:dictation', 'voice:tool']);
  });

  it('returns argument and host-authority failures to the model and continues with the next tool', async () => {
    const seenMessages = [];
    mocks.streamChat.mockImplementation(async messages => {
      seenMessages.push(structuredClone(messages));
      return seenMessages.length === 1 ? completion('', [
        toolCall('invalid_arguments', '{', { id: 'invalid' }),
        toolCall('pm2_restart', '{"name":"example-app"}', { id: 'denied' }),
        toolCall('time_now', '', { id: 'allowed' }),
      ]) : completion('Reported.');
    });
    mocks.dispatchTool.mockImplementation(async name => {
      if (name === 'pm2_restart') throw Object.assign(new Error('Operator authority required'), { code: 'HOST_CONTROL_FORBIDDEN' });
      return { ok: true, time: '12:00' };
    });
    const events = [];
    await runTurn({ text: 'restart the example', state: {}, hasHostControl: () => false,
      emit: (event, payload) => events.push({ event, payload }) });

    expect(mocks.dispatchTool.mock.calls.map(([name]) => name)).toEqual(['pm2_restart', 'time_now']);
    const results = seenMessages[1].filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    expect(results).toEqual([
      { ok: false, error: expect.any(String) },
      { ok: false, error: 'Operator authority required' },
      { ok: true, time: '12:00' },
    ]);
    expect(events).toContainEqual({ event: 'voice:error', payload: {
      stage: 'tool', code: 'HOST_CONTROL_FORBIDDEN', message: 'Operator authority required',
    } });
    expect(events.filter(({ event }) => event === 'voice:tool')).toHaveLength(3);
  });

  it('skips UI refresh, sibling tools and further model calls when dispatch aborts the turn', async () => {
    const controller = new AbortController();
    mocks.streamChat.mockResolvedValue(completion('', [
      toolCall('ui_navigate', '{}', { id: 'first' }), toolCall('time_now', '{}', { id: 'second' }),
    ]));
    mocks.dispatchTool.mockImplementation(async (_name, _args, ctx) => {
      ctx.sideEffects.push({ type: 'navigate', path: '/example' });
      controller.abort();
      return { ok: true };
    });
    const state = {};
    await runTurn({ text: 'open the example', state, signal: controller.signal, emit: vi.fn() });
    expect(mocks.dispatchTool).toHaveBeenCalledTimes(1);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(state.uiWaiters).toBeUndefined();
  });
});

describe('runTurn dictation routing', () => {
  it('defaults the journal date and emits only the appended segment without calling the model', async () => {
    const segment = { text: 'Example journal entry', source: 'voice' };
    mocks.appendJournal.mockResolvedValue({ content: 'Earlier entry\nExample journal entry',
      segments: [{ text: 'Earlier entry' }, segment], updatedAt: '2026-01-02T12:00:00Z' });
    const state = { dictation: { enabled: true, date: null } };
    const events = [];
    const result = await runTurn({ text: '  Example journal entry  ', source: 'voice', state,
      emit: (event, payload) => events.push({ event, payload }) });

    expect(result).toEqual({ transcript: '  Example journal entry  ', reply: '' });
    expect(mocks.appendJournal).toHaveBeenCalledWith('2026-01-02', 'Example journal entry', { source: 'voice' });
    expect(state.dictation.date).toBe('2026-01-02');
    expect(events).toContainEqual({ event: 'voice:dictation', payload: { enabled: true, date: '2026-01-02' } });
    expect(events).toContainEqual({ event: 'voice:dailyLog:appended', payload: {
      date: '2026-01-02', text: 'Example journal entry', segment, segmentCount: 2, updatedAt: '2026-01-02T12:00:00Z',
    } });
    expect(events.at(-1)).toEqual({ event: 'voice:idle', payload: { reason: 'dictation-appended' } });
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('stops spoken dictation and speaks its canonical reply without appending or calling the model', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'stop dictation', latencyMs: 3 });
    const state = { dictation: { enabled: true, date: '2026-01-01' } };
    const events = [];
    await expect(runTurn({ audio: Buffer.alloc(8), mimeType: 'audio/wav', state,
      emit: (event, payload) => events.push({ event, payload }) }))
      .resolves.toEqual({ transcript: 'stop dictation', reply: 'Dictation off.' });
    expect(state.dictation).toEqual({ enabled: false, date: null });
    expect(events.map(({ event }) => event)).toEqual([
      'voice:transcript', 'voice:dictation', 'voice:tts:audio', 'voice:llm:delta', 'voice:llm:done', 'voice:idle',
    ]);
    expect(events[2].payload).toEqual({ sentence: 'Dictation off.', wav: Buffer.alloc(8), latencyMs: 7 });
    expect(mocks.appendJournal).not.toHaveBeenCalled();
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });

  it('keeps typed requests on the conversational path while dictation is enabled', async () => {
    const state = { dictation: { enabled: true, date: '2026-01-01' } };
    await expect(runTurn({ text: 'stop dictation', source: 'text', state, emit: vi.fn() }))
      .resolves.toEqual({ transcript: 'stop dictation', reply: 'Ready.' });
    expect(state.dictation).toEqual({ enabled: true, date: '2026-01-01' });
    expect(mocks.appendJournal).not.toHaveBeenCalled();
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
  });

  it('leaves blank spoken dictation idle without writing a journal segment', async () => {
    const events = [];
    await runTurn({ text: '   ', source: 'voice', state: { dictation: { enabled: true } },
      emit: (event, payload) => events.push({ event, payload }) });
    expect(events.at(-1)).toEqual({ event: 'voice:idle', payload: { reason: 'empty-transcript' } });
    expect(mocks.appendJournal).not.toHaveBeenCalled();
    expect(mocks.getToday).not.toHaveBeenCalled();
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });
});
