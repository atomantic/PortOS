import { describe, it, expect, vi, beforeEach } from 'vitest';

// runTurn-level pin for per-channel agents: the on-air Voice Call channel's
// LLM, persona and voice replace the global ones, and a channel without
// overrides runs the global config exactly as before.

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: {
      provider: 'global-provider',
      model: 'global-model',
      usePersonality: true,
      personality: { name: 'Base', role: 'Helper', traits: ['warm'], speechStyle: 'brief', customPrompt: '' },
      tools: { enabled: false },
    },
  })),
}));
const settings = { voiceAvatarChannels: null };
vi.mock(import('../settings.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => settings),
}));
vi.mock('./stt.js', () => ({ transcribe: vi.fn() }));
const synthesize = vi.fn(async () => ({ wav: Buffer.alloc(8), latencyMs: 1 }));
vi.mock('./tts.js', () => ({ synthesize: (...args) => synthesize(...args) }));
const streamChat = vi.fn();
vi.mock('./llm.js', () => ({ streamChat: (...args) => streamChat(...args) }));
vi.mock('./echo.js', () => ({ isEchoOfRecentTts: () => false, rememberTtsSentence: () => {} }));
vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: vi.fn(async () => '2026-05-12') }));
vi.mock('../memoryRetriever.js', () => ({ getRelevantMemories: vi.fn(async () => []) }));

const { runTurn } = await import('./pipeline.js');

const turn = async () => {
  streamChat.mockImplementationOnce(async (_messages, opts) => {
    opts.onDelta?.('Hello there. ');
    return { text: 'Hello there. ', toolCalls: [], model: opts.model, ttfbMs: 1, totalMs: 2 };
  });
  await runTurn({ text: 'hi', history: [], emit: () => {}, state: {} });
  const [messages, opts] = streamChat.mock.calls.at(-1);
  return { system: messages[0].content, opts, speech: synthesize.mock.calls.at(-1)?.[1] };
};

const onAir = (agent) => {
  const channels = Array.from({ length: 6 }, () => ({ label: '', avatar: null }));
  channels[2] = { label: 'Scout', avatar: null, agent };
  settings.voiceAvatarChannels = { active: 2, channels };
};

describe('runTurn — on-air channel agent', () => {
  beforeEach(() => {
    streamChat.mockReset();
    synthesize.mockClear();
    settings.voiceAvatarChannels = null;
  });

  it('runs the global agent when the channel overrides nothing', async () => {
    onAir({});
    const { system, opts, speech } = await turn();
    expect(opts).toMatchObject({ provider: 'global-provider', model: 'global-model' });
    expect(system).toContain('You are Base, Helper for the user.');
    expect(speech).not.toHaveProperty('voice');
  });

  it('answers with the channel LLM, persona and voice', async () => {
    onAir({
      provider: 'channel-provider', model: 'channel-model', name: 'Scout', speechStyle: 'dry and formal',
      traits: ['curious'], voiceId: 'piper:channel-voice',
    });
    const { system, opts, speech } = await turn();
    expect(opts).toMatchObject({ provider: 'channel-provider', model: 'channel-model' });
    expect(system).toContain('You are Scout, Helper for the user.');
    expect(system).toContain('Speech style: dry and formal.');
    expect(system).toContain('Personality: curious.');
    expect(speech).toMatchObject({ engine: 'piper', voice: 'channel-voice' });
  });
});
