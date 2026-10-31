import { describe, it, expect, vi } from 'vitest';

// runTurn-level pin for the system-context assembly: the memory block is
// injected only for retrieval-shaped turns that actually find memories, and
// an empty lookup leaves the message list untouched.

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: { model: 'test-model', usePersonality: false, systemPrompt: 'sys', tools: { enabled: false } },
  })),
}));
vi.mock('./stt.js', () => ({ transcribe: vi.fn() }));
vi.mock('./tts.js', () => ({
  synthesize: vi.fn(async () => ({ wav: Buffer.alloc(8), latencyMs: 1 })),
}));
const streamChatMock = vi.fn();
vi.mock('./llm.js', () => ({ streamChat: (...args) => streamChatMock(...args) }));
vi.mock('./echo.js', () => ({ isEchoOfRecentTts: () => false, rememberTtsSentence: () => {} }));
vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: vi.fn(async () => '2026-05-12') }));
const getRelevantMemories = vi.fn();
vi.mock('../memoryRetriever.js', () => ({ getRelevantMemories: (...a) => getRelevantMemories(...a) }));

const { runTurn } = await import('./pipeline.js');

const sentMessages = async (text, systemContext) => {
  streamChatMock.mockReset();
  streamChatMock.mockResolvedValueOnce({ text: 'ok', toolCalls: [], model: 'test-model', ttfbMs: 1, totalMs: 2 });
  await runTurn({ text, history: [{ role: 'assistant', content: 'earlier' }], emit: () => {}, state: {}, systemContext });
  return streamChatMock.mock.calls[0][0];
};

describe('runTurn — turn message assembly', () => {
  it('adds no memory block when a retrieval-shaped turn finds nothing', async () => {
    getRelevantMemories.mockResolvedValueOnce([]);
    const messages = await sentMessages('What did I say about the budget last week?');
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user']);
  });

  it('injects found memories after the persona and caller context, before history', async () => {
    getRelevantMemories.mockResolvedValueOnce([{ content: 'Prefers dark roast', type: 'fact' }]);
    const messages = await sentMessages('What did I say about coffee last week?', ' extra context ');
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'system', 'assistant', 'user']);
    expect(messages[1].content).toBe('extra context');
    expect(messages[2].content).toContain('Prefers dark roast');
  });

  it('skips the memory lookup entirely for non-retrieval turns', async () => {
    getRelevantMemories.mockClear();
    await sentMessages('turn on the lights');
    expect(getRelevantMemories).not.toHaveBeenCalled();
  });
});
