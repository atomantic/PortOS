import { describe, it, expect, vi, beforeEach } from 'vitest';

// runTurn-level pin for images the user shows the agent: a shared-tab frame
// captured at turn time and an upload queued before the turn are described by a
// vision model and appended to the user's message, the chip events carry the
// exact added text, and an unchanged screen is not described twice.

vi.mock('./channelAgent.js', () => ({
  getAgentVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: { provider: 'ollama', model: 'voice-model', visionModel: 'auto', usePersonality: false, systemPrompt: 'sys', tools: { enabled: false } },
  })),
  synthesizeAgentSpeech: vi.fn(),
}));
vi.mock('./stt.js', () => ({ transcribe: vi.fn() }));
vi.mock('./tts.js', () => ({ synthesize: vi.fn(async () => ({ wav: Buffer.alloc(8), latencyMs: 1 })) }));
const streamChatMock = vi.fn();
vi.mock('./llm.js', () => ({ streamChat: (...a) => streamChatMock(...a), resolveLlmEndpoint: vi.fn() }));
vi.mock('./echo.js', () => ({ isEchoOfRecentTts: () => false, rememberTtsSentence: () => {} }));
vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: vi.fn(async () => '2026-05-12') }));
vi.mock('../memoryRetriever.js', () => ({ getRelevantMemories: vi.fn(async () => []) }));
const describeMock = vi.fn();
vi.mock('../visionTest.js', () => ({ describeImageDataUrl: (...a) => describeMock(...a) }));
const listVisionModelsMock = vi.fn();
vi.mock('../localLlm.js', () => ({ listVisionModels: (...a) => listVisionModelsMock(...a) }));

const { runTurn, describeAttachedImage } = await import('./pipeline.js');
const { attachImage, setTabSharing } = await import('./imageAttachments.js');

const FRAME = 'data:image/jpeg;base64,AAAA';
const signature = (v) => Array(256).fill(v);

// A socket-like emitter: answers each screenshot request with `frame`, and
// records every voice:image chip update.
const harness = (frame) => {
  const state = { screenshotWaiters: new Map() };
  const chips = [];
  const emit = (event, data) => {
    if (event === 'voice:image') chips.push(data);
    if (event === 'voice:screenshot:request') {
      const resolve = state.screenshotWaiters.get(data.requestId);
      queueMicrotask(() => resolve?.(frame));
    }
  };
  return { state, chips, emit };
};

const turn = async (text, { state, emit }) => {
  streamChatMock.mockResolvedValueOnce({ text: 'I see it', toolCalls: [], model: 'voice-model', ttfbMs: 1, totalMs: 2 });
  const result = await runTurn({ text, history: [], emit, state });
  const [messages] = streamChatMock.mock.calls.at(-1);
  return { result, userMessage: messages.at(-1) };
};

beforeEach(() => {
  streamChatMock.mockReset();
  describeMock.mockReset();
  listVisionModelsMock.mockReset();
  listVisionModelsMock.mockResolvedValue([
    { providerId: 'ollama', backend: 'ollama', id: 'voice-model' },
    { providerId: 'ollama', backend: 'ollama', id: 'other-vision' },
  ]);
});

describe('runTurn — images shown to the voice agent', () => {
  it('describes the shared tab with the voice model when it can see, and adds the description to the message and history', async () => {
    describeMock.mockResolvedValue('A tasks page listing three overdue items.');
    const h = harness({ dataUrl: FRAME, signature: signature(10) });
    setTabSharing(h.state, true);

    const { result, userMessage } = await turn('what is on my screen?', h);

    expect(describeMock).toHaveBeenCalledWith(expect.objectContaining({ dataUrl: FRAME, providerId: 'ollama', model: 'voice-model' }));
    expect(userMessage.content.startsWith('what is on my screen?\n\n[Attached image: a frame of the browser tab the user is sharing')).toBe(true);
    expect(userMessage.content).toContain('A tasks page listing three overdue items.');
    expect(result).toMatchObject({ transcript: 'what is on my screen?', userContent: userMessage.content });
    const sent = h.chips.find((c) => c.status === 'sent');
    expect(sent).toMatchObject({ source: 'tab', model: 'voice-model' });
    expect(userMessage.content.endsWith(sent.text)).toBe(true);
  });

  it('skips an unchanged screen on the next turn and re-describes it once it changes', async () => {
    describeMock.mockResolvedValue('Same page.');
    const h = harness({ dataUrl: FRAME, signature: signature(10) });
    setTabSharing(h.state, true);
    await turn('look at this', h);
    h.state.screenshotWaiters = new Map();

    const again = await turn('and now?', h);
    expect(describeMock).toHaveBeenCalledTimes(1);
    expect(again.userMessage.content).toBe('and now?');
    expect(again.result.userContent).toBeUndefined();

    const changed = harness({ dataUrl: FRAME, signature: signature(200) });
    changed.state.images = h.state.images;
    await turn('what changed?', changed);
    expect(describeMock).toHaveBeenCalledTimes(2);
  });

  it('adds a queued upload to the next turn and falls back to another local vision model when the voice model is text-only', async () => {
    listVisionModelsMock.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'other-vision' }]);
    describeMock.mockResolvedValue('A photo of a red bicycle.');
    const h = harness(null);
    attachImage(h.state, { id: 'img_1', dataUrl: FRAME, source: 'upload', name: 'bike.jpg' }, {
      describe: (dataUrl) => describeAttachedImage(dataUrl),
      emit: h.emit,
    });

    const { userMessage } = await turn('what is this?', h);

    expect(describeMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'other-vision' }));
    expect(userMessage.content).toContain('an image the user attached ("bike.jpg")');
    expect(userMessage.content).toContain('A photo of a red bicycle.');
    expect(h.chips.map((c) => c.status)).toEqual(['analyzing', 'ready', 'sent']);
  });

  it('sends the turn without a failed image and leaves the error on its chip', async () => {
    describeMock.mockRejectedValue(new Error('model offline'));
    const h = harness(null);
    attachImage(h.state, { id: 'img_2', dataUrl: FRAME, source: 'upload', name: 'x.png' }, {
      describe: (dataUrl) => describeAttachedImage(dataUrl),
      emit: h.emit,
    });

    const { userMessage, result } = await turn('thoughts?', h);

    expect(userMessage.content).toBe('thoughts?');
    expect(result.userContent).toBeUndefined();
    expect(h.chips.find((c) => c.status === 'error')).toMatchObject({ id: 'img_2', error: 'model offline' });
    expect(h.chips.at(-1)).toEqual({ id: 'img_2', status: 'removed' });
  });

  it('re-sends an unchanged screen when its earlier frame was removed before a turn', async () => {
    describeMock.mockResolvedValue('A settings page.');
    const h = harness({ dataUrl: FRAME, signature: signature(50) });
    setTabSharing(h.state, true);
    const { attachTabFrame, removeImage } = await import('./imageAttachments.js');
    const first = await attachTabFrame(h.state, { capture: async () => ({ dataUrl: FRAME, signature: signature(50) }), describe: async () => ({ text: 'x', model: 'm' }), emit: h.emit, newId: () => 'tab_a' });
    await first.done;
    removeImage(h.state, 'tab_a', h.emit);

    const { userMessage } = await turn('what about now?', h);
    expect(userMessage.content).toContain('A settings page.');
  });
});
