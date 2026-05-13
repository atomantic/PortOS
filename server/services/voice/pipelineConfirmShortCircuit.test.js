import { describe, it, expect, vi } from 'vitest';

// Server-side enforcement of the destructive-action confirmation gate:
// when a tool result includes `confirmation_required: true`, the pipeline
// must (a) stop iterating the LLM in the same turn, (b) NOT execute any
// further queued tool calls, and (c) speak the deterministic `summary`
// prompt via the synthetic-reply path. Relying on the system prompt alone
// is brittle — the model can still chain another tool call in the same
// iteration that would overwrite `state.pendingDestructive` or fire an
// unrelated side effect. This test pins the server-side short-circuit so a
// future refactor can't silently regress.

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: {
      model: 'test-model',
      usePersonality: false,
      systemPrompt: 'sys',
      tools: { enabled: true, maxIterations: 3 },
    },
  })),
}));

vi.mock('./stt.js', () => ({
  transcribe: vi.fn(async () => ({ text: 'delete the account', latencyMs: 5 })),
}));

vi.mock('./tts.js', () => ({
  synthesize: vi.fn(async (text) => ({ wav: Buffer.alloc(8), latencyMs: 1, _text: text })),
}));

// Two-iteration LLM mock: first iteration emits a tool call, second iteration
// (which should NOT run when the gate fires) would emit text. If the
// short-circuit works, streamChat is only invoked once.
const streamChatMock = vi.fn();
vi.mock('./llm.js', () => ({
  streamChat: (...args) => streamChatMock(...args),
}));

// dispatchTool returns the confirmation_required result the real ui_click
// would. We also include a second tool call in the same LLM iteration to
// verify the short-circuit also stops executing siblings.
const dispatchToolMock = vi.fn();
vi.mock('./tools.js', () => ({
  getToolSpecsForIntent: () => ({ specs: [{ type: 'function', function: { name: 'ui_click' } }], activeGroups: new Set(['ui']) }),
  classifyIntent: () => new Set(),
  dispatchTool: (...args) => dispatchToolMock(...args),
  getAllToolNames: () => ['ui_click'],
  UI_KINDS: ['tab', 'button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'],
}));

vi.mock('./echo.js', () => ({
  isEchoOfRecentTts: () => false,
  rememberTtsSentence: () => {},
}));

vi.mock('../brainJournal.js', () => ({
  appendJournal: vi.fn(),
  getToday: vi.fn(async () => '2026-05-12'),
}));

const { runTurn } = await import('./pipeline.js');

describe('runTurn — destructive confirmation short-circuit', () => {
  it('stops further tool execution and skips the next LLM iteration when a tool returns confirmation_required', async () => {
    streamChatMock.mockReset();
    dispatchToolMock.mockReset();

    // First (and should be ONLY) LLM iteration returns two tool calls. The
    // first is a destructive ui_click that returns confirmation_required;
    // the second would be a stray tool call the gate must NOT execute.
    streamChatMock.mockImplementationOnce(async () => ({
      text: '',
      toolCalls: [
        { id: 'a', type: 'function', function: { name: 'ui_click', arguments: '{"label":"Delete account"}' }, index: 0 },
        { id: 'b', type: 'function', function: { name: 'ui_click', arguments: '{"label":"Some Other Button"}' }, index: 1 },
      ],
      model: 'test-model',
      ttfbMs: 10,
      totalMs: 20,
      finishReason: 'tool_calls',
    }));
    // If the short-circuit fails, streamChat would be called a second time
    // for a follow-up iteration. We make that throw to force a loud failure.
    streamChatMock.mockImplementationOnce(async () => {
      throw new Error('LLM iterated past confirmation_required — short-circuit broken');
    });

    // dispatchTool returns confirmation_required:true for the first call. If
    // the second sibling call ever executes, the test will see a second
    // dispatchTool invocation in the call list.
    dispatchToolMock.mockResolvedValueOnce({
      ok: true,
      confirmation_required: true,
      label: 'Delete account',
      kind: 'button',
      summary: 'That looks destructive — confirm by saying "yes" or "confirm" to Delete account, or "cancel" to skip.',
    });

    const events = [];
    const emit = (event, payload) => events.push({ event, payload });
    const state = {};

    const result = await runTurn({
      audio: Buffer.alloc(8),
      mimeType: 'audio/webm',
      history: [],
      emit,
      state,
    });

    // streamChat invoked exactly once — the second iteration was skipped.
    expect(streamChatMock).toHaveBeenCalledTimes(1);

    // Only the destructive tool ran. The sibling tool call in the same
    // assistant turn was NOT dispatched.
    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    expect(dispatchToolMock.mock.calls[0][0]).toBe('ui_click');
    expect(dispatchToolMock.mock.calls[0][1]).toEqual({ label: 'Delete account' });

    // The deterministic confirmation summary was spoken (via the synthetic
    // reply path), and the returned reply matches it.
    expect(result.reply).toContain('Delete account');
    expect(result.reply.toLowerCase()).toContain('confirm');

    const llmDone = events.find((e) => e.event === 'voice:llm:done');
    expect(llmDone).toBeTruthy();
    expect(llmDone.payload.text).toContain('Delete account');

    // Exactly one voice:idle (turn-complete) — the synthetic reply emits its
    // own idle and the main path does NOT emit a second one after returning.
    const idleEvents = events.filter((e) => e.event === 'voice:idle');
    expect(idleEvents.length).toBe(1);
    expect(idleEvents[0].payload.reason).toBe('turn-complete');
  });

  it('does NOT short-circuit when no tool result has confirmation_required (regression guard)', async () => {
    streamChatMock.mockReset();
    dispatchToolMock.mockReset();

    // Iter 1: one tool call (non-destructive). Iter 2: text only, no tool
    // calls, ending the loop normally.
    streamChatMock.mockImplementationOnce(async () => ({
      text: '',
      toolCalls: [
        { id: 'a', type: 'function', function: { name: 'ui_click', arguments: '{"label":"Save"}' }, index: 0 },
      ],
      model: 'test-model',
      ttfbMs: 10,
      totalMs: 20,
      finishReason: 'tool_calls',
    }));
    streamChatMock.mockImplementationOnce(async ({ onDelta } = {}) => {
      // No tool calls — natural loop termination.
      return {
        text: 'Done.',
        toolCalls: [],
        model: 'test-model',
        ttfbMs: 10,
        totalMs: 20,
        finishReason: 'stop',
      };
    });

    dispatchToolMock.mockResolvedValueOnce({ ok: true, label: 'Save', summary: 'Clicked Save.' });

    const events = [];
    const emit = (event, payload) => events.push({ event, payload });
    const state = {};

    const result = await runTurn({
      audio: Buffer.alloc(8),
      mimeType: 'audio/webm',
      history: [],
      emit,
      state,
    });

    // Both iterations ran — no short-circuit.
    expect(streamChatMock).toHaveBeenCalledTimes(2);
    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('Done.');
  });
});
