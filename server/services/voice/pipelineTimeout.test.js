import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: {
      model: 'test-model',
      provider: 'test-provider',
      usePersonality: false,
      systemPrompt: 'sys',
      tools: { enabled: false, maxIterations: 1 },
    },
  })),
  synthesize: vi.fn(async (text) => ({ wav: Buffer.alloc(8), latencyMs: 1, _text: text })),
  streamChat: vi.fn(),
}));

vi.mock('./config.js', () => ({ getVoiceConfig: mocks.getVoiceConfig }));
vi.mock('./stt.js', () => ({ transcribe: vi.fn() }));
vi.mock('./tts.js', () => ({ synthesize: (...args) => mocks.synthesize(...args) }));
vi.mock('./llm.js', () => ({ streamChat: (...args) => mocks.streamChat(...args) }));
vi.mock('./tools.js', () => ({
  getToolSpecsForIntent: () => ({ specs: undefined, activeGroups: new Set() }),
  classifyIntent: () => new Set(),
  dispatchTool: vi.fn(),
  getAllToolNames: () => [],
  UI_KINDS: ['tab', 'button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'],
}));
vi.mock('./echo.js', () => ({
  isEchoOfRecentTts: () => false,
  rememberTtsSentence: vi.fn(),
}));
vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: vi.fn() }));
vi.mock('./confirmGate.js', () => ({ resolvePending: vi.fn(), isExpired: vi.fn() }));

const { runTurn } = await import('./pipeline.js');

describe('runTurn LLM timeout recovery', () => {
  it('cancels queued TTS without converting the timeout into user cancellation', async () => {
    mocks.synthesize.mockClear();
    mocks.streamChat.mockImplementationOnce(async (_messages, { onDelta, onTimeout }) => {
      onDelta('The provider stalled.');
      onTimeout();
      throw new Error('Voice LLM request timed out');
    });

    const events = [];
    const signal = new AbortController().signal;
    const turn = runTurn({
      text: 'hello',
      history: [],
      emit: (event, payload) => events.push({ event, payload }),
      signal,
      state: {},
    });

    await expect(turn).rejects.toThrow('Voice LLM request timed out');
    await vi.waitFor(() => expect(mocks.synthesize).not.toHaveBeenCalled());
    expect(signal.aborted).toBe(false);
    expect(events).toContainEqual({
      event: 'voice:tts:cancel',
      payload: { reason: 'timeout' },
    });
    expect(events.some(({ event }) => event === 'voice:tts:audio')).toBe(false);
  });
});
