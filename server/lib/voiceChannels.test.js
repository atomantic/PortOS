import { describe, expect, it } from 'vitest';
import {
  applyChannelAgent,
  channelAgentSpeechOpts,
  normalizeChannelAgent,
  normalizeChannels,
} from './voiceChannels.js';

const globalCfg = {
  tts: { engine: 'piper', piper: { voice: 'base-voice' } },
  llm: {
    provider: 'ollama',
    model: 'base-model',
    visionModel: 'base-vision',
    usePersonality: false,
    systemPrompt: 'raw prompt',
    personality: { name: 'Base', role: 'Helper', traits: ['warm'], speechStyle: 'brief', customPrompt: '' },
  },
};

describe('channel agent overrides', () => {
  it('a channel with no overrides runs the global config unchanged', () => {
    expect(applyChannelAgent(globalCfg, {})).toBe(globalCfg);
    expect(channelAgentSpeechOpts({})).toEqual({});
  });

  it('keeps only valid overrides and inherits the rest', () => {
    expect(normalizeChannelAgent({
      voiceId: 'unknown-engine:voice', provider: '  ', model: 'orphan-model', name: '', role: ' Scout ', traits: ['a', ' a ', 'b'],
    })).toEqual({ role: 'Scout', traits: ['a', 'b'] });
    expect(normalizeChannelAgent({ voiceId: 'qwen3:narrator', provider: 'lmstudio' }))
      .toEqual({ voiceId: 'qwen3-tts:narrator', provider: 'lmstudio', model: 'auto' });
    expect(normalizeChannelAgent(null)).toEqual({});
  });

  it('applies the LLM, persona and voice of the on-air channel', () => {
    const agent = normalizeChannelAgent({
      voiceId: 'piper:channel-voice', provider: 'lmstudio', model: 'channel-model', name: 'Scout', traits: [],
    });
    const cfg = applyChannelAgent(globalCfg, agent);
    expect(cfg.llm).toMatchObject({
      provider: 'lmstudio',
      model: 'channel-model',
      // The global vision model belongs to the global provider.
      visionModel: 'auto',
      // A persona override turns the personality prompt on for this channel.
      usePersonality: true,
      personality: { name: 'Scout', role: 'Helper', traits: [], speechStyle: 'brief' },
    });
    expect(globalCfg.llm.personality.name).toBe('Base');
    expect(channelAgentSpeechOpts(agent)).toEqual({ engine: 'piper', voice: 'channel-voice' });
  });

  it('keeps the global vision model when the channel keeps the global provider', () => {
    const cfg = applyChannelAgent(globalCfg, { provider: 'ollama', model: 'other' });
    expect(cfg.llm.visionModel).toBe('base-vision');
    expect(cfg.llm.usePersonality).toBe(false);
  });

  it('normalizes every channel record, including stored agents', () => {
    const { channels } = normalizeChannels({ channels: [{ label: 'A', avatar: 'a.png', agent: { name: 'Scout', bogus: 1 } }] });
    expect(channels).toHaveLength(6);
    expect(channels[0]).toEqual({ label: 'A', avatar: 'a.png', agent: { name: 'Scout' } });
    expect(channels[1]).toEqual({ label: '', avatar: null, agent: {} });
  });
});
