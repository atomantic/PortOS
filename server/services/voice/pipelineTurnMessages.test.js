import { describe, it, expect, vi } from 'vitest';

// runTurn-level pin for the system-context assembly: the memory block is
// injected only for retrieval-shaped turns that actually find memories, and
// an empty lookup leaves the message list untouched. Per-turn blocks go after
// the history so the prompt prefix stays cacheable across turns.

const voiceTools = { enabled: false };
vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: { model: 'test-model', usePersonality: false, systemPrompt: 'sys', tools: voiceTools },
  })),
}));
vi.mock('./stt.js', () => ({ transcribe: vi.fn() }));
vi.mock('./tts.js', () => ({
  synthesize: vi.fn(async () => ({ wav: Buffer.alloc(8), latencyMs: 1 })),
}));
const streamChatMock = vi.fn();
const resolveLlmEndpointMock = vi.fn(async () => ({ apiBase: 'http://127.0.0.1:11434/v1' }));
const markWarmingMock = vi.fn();
vi.mock('./llm.js', () => ({
  streamChat: (...args) => streamChatMock(...args),
  resolveLlmEndpoint: (...args) => resolveLlmEndpointMock(...args),
  markVoiceLlmWarming: (...args) => markWarmingMock(...args),
}));
vi.mock('./echo.js', () => ({ isEchoOfRecentTts: () => false, rememberTtsSentence: () => {} }));
vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: vi.fn(async () => '2026-05-12') }));
const getRelevantMemories = vi.fn(async () => []);
vi.mock('../memoryRetriever.js', () => ({ getRelevantMemories: (...a) => getRelevantMemories(...a) }));

const { runTurn, warmPromptPrefix } = await import('./pipeline.js');

const sentRequest = async (text, { systemContext, history = [{ role: 'assistant', content: 'earlier' }], state = {} } = {}) => {
  streamChatMock.mockReset();
  streamChatMock.mockResolvedValueOnce({ text: 'ok', toolCalls: [], model: 'test-model', ttfbMs: 1, totalMs: 2 });
  await runTurn({ text, history, emit: () => {}, state, systemContext });
  const [messages, opts] = streamChatMock.mock.calls[0];
  return { messages, tools: opts.tools };
};
const sentMessages = async (text, systemContext) => (await sentRequest(text, { systemContext })).messages;

describe('runTurn — turn message assembly', () => {
  it('adds no memory block when a retrieval-shaped turn finds nothing', async () => {
    getRelevantMemories.mockResolvedValueOnce([]);
    const messages = await sentMessages('What did I say about the budget last week?');
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user']);
  });

  it('injects found memories after the history, keeping the persona and caller context first', async () => {
    getRelevantMemories.mockResolvedValueOnce([{ content: 'Prefers dark roast', type: 'fact' }]);
    const messages = await sentMessages('What did I say about coffee last week?', ' extra context ');
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'assistant', 'system', 'user']);
    expect(messages[1].content).toBe('extra context');
    expect(messages[3].content).toContain('Prefers dark roast');
  });

  it('skips the memory lookup entirely for non-retrieval turns', async () => {
    getRelevantMemories.mockClear();
    await sentMessages('turn on the lights');
    expect(getRelevantMemories).not.toHaveBeenCalled();
  });

  describe('with tools enabled', () => {
    const ui = { title: 'Tasks', path: '/tasks', elements: [{ kind: 'button', label: 'New task' }] };
    const prefix = ({ messages, tools }, historyLength) => JSON.stringify({ tools, messages: messages.slice(0, 1 + historyLength) });

    it('keeps tools and the history prefix identical across turns with different intents', async () => {
      voiceTools.enabled = true;
      voiceTools.trimByIntent = false;
      const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
      const a = await sentRequest('what time is it', { history, state: { ui } });
      const b = await sentRequest('click the new task button', { history, state: { ui } });
      expect(a.tools.length).toBeGreaterThan(20);
      expect(prefix(b, history.length)).toBe(prefix(a, history.length));
      // The UI snapshot rides after the history, right before the new message.
      expect(b.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'system', 'user']);
      expect(b.messages[3].content).toContain('Current UI state');
    });

    it('keeps capture tools on form-fill turns and steers with a hint after the history', async () => {
      voiceTools.enabled = true;
      voiceTools.trimByIntent = false;
      const { messages, tools } = await sentRequest('fill the description with remember to buy milk');
      expect(tools.map((t) => t.function.name)).toContain('brain_capture');
      expect(messages.at(-2).content).toContain('call ui_fill');
      expect(messages.at(-1)).toEqual({ role: 'user', content: 'fill the description with remember to buy milk' });
    });

    it('trims tools per utterance when trimByIntent is on', async () => {
      voiceTools.enabled = true;
      voiceTools.trimByIntent = true;
      const { messages, tools } = await sentRequest('fill the description with remember to buy milk');
      const names = tools.map((t) => t.function.name);
      expect(names).toContain('ui_fill');
      expect(names).not.toContain('brain_capture');
      expect(messages.some((m) => m.content?.includes?.('call ui_fill with the field label'))).toBe(false);
      voiceTools.enabled = false;
      voiceTools.trimByIntent = false;
    });
  });

  describe('warmPromptPrefix', () => {
    it('prefills exactly the persona and the full tool list a turn will start with, then dedupes', async () => {
      voiceTools.enabled = true;
      voiceTools.trimByIntent = false;
      streamChatMock.mockReset();
      streamChatMock.mockResolvedValue({ text: '', toolCalls: [] });
      const first = await warmPromptPrefix({ reason: 'test' });
      expect(first.warmed).toBe(true);
      const [warmMessages, warmOpts] = streamChatMock.mock.calls[0];
      expect(warmOpts.maxTokens).toBe(1);

      const turn = await sentRequest('what time is it', { history: [] });
      expect(turn.messages[0]).toEqual(warmMessages[0]);
      expect(warmMessages).toHaveLength(1);
      expect(JSON.stringify(warmOpts.tools)).toBe(JSON.stringify(turn.tools));

      streamChatMock.mockReset();
      streamChatMock.mockResolvedValue({ text: '', toolCalls: [] });
      expect(await warmPromptPrefix({ reason: 'test' })).toMatchObject({ warmed: false, reason: 'recent' });
      expect(streamChatMock).not.toHaveBeenCalled();
      voiceTools.enabled = false;
    });

    it('shows a cold model as loading for the length of the warm-up, even when it fails', async () => {
      const release = vi.fn();
      markWarmingMock.mockReset();
      markWarmingMock.mockReturnValue(release);
      streamChatMock.mockReset();
      streamChatMock.mockImplementation(async (_messages, opts) => {
        opts.onModelLoading({ model: 'model-a' });
        expect(release).not.toHaveBeenCalled();
        throw new Error('model server offline');
      });
      await expect(warmPromptPrefix({ reason: 'cold-test' })).rejects.toThrow('model server offline');
      expect(markWarmingMock).toHaveBeenCalledTimes(1);
      expect(markWarmingMock.mock.calls[0][1]).toBe('model-a');
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('still loads the model when tool lists are chosen per turn', async () => {
      voiceTools.enabled = true;
      voiceTools.trimByIntent = true;
      streamChatMock.mockReset();
      streamChatMock.mockResolvedValue({ text: '', toolCalls: [] });
      // Step past the dedupe window of the earlier warm-up of the same prompt.
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
      expect(await warmPromptPrefix({ reason: 'per-turn-test' })).toMatchObject({ warmed: true });
      now.mockRestore();
      expect(streamChatMock.mock.calls[0][1].tools).toBeUndefined();
      voiceTools.enabled = false;
      voiceTools.trimByIntent = false;
    });

    it('skips hosted providers so a warm-up is never billed', async () => {
      resolveLlmEndpointMock.mockResolvedValueOnce({ apiBase: 'https://api.example.com/v1' });
      streamChatMock.mockReset();
      expect(await warmPromptPrefix({ reason: 'test' })).toMatchObject({ warmed: false, reason: 'not-local' });
      expect(streamChatMock).not.toHaveBeenCalled();
    });
  });
});
