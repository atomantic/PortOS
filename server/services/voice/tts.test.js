import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(),
  piperVoiceTildePath: vi.fn((voice) => `~/.portos/voice/voices/${voice}.onnx`),
}));
vi.mock('./tts-piper.js', () => ({ synthesizePiper: vi.fn(), listPiperVoices: vi.fn() }));
vi.mock('./tts-qwen3.js', () => ({ synthesizeQwen3: vi.fn(), listQwen3Voices: vi.fn() }));
vi.mock('./piper-voices.js', () => ({ findPiperVoice: vi.fn() }));
vi.mock('./profiles.js', () => ({ getProfileForSynthesis: vi.fn() }));
vi.mock('./bootstrap.js', () => ({ which: vi.fn() }));
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn().mockResolvedValue(null) }));

const { getVoiceConfig } = await import('./config.js');
const { synthesizePiper } = await import('./tts-piper.js');
const { findPiperVoice } = await import('./piper-voices.js');
const { synthesizeQwen3 } = await import('./tts-qwen3.js');
const { getProfileForSynthesis } = await import('./profiles.js');
const { listVoiceEngines, normalizeVoiceEngine, synthesize } = await import('./tts.js');

const CONFIG = {
  tts: {
    engine: 'piper',
    rate: 1.7,
    piper: { voice: 'en_US-lessac-medium', voicePath: '~/.portos/voice/voices/en_US-lessac-medium.onnx' },
  },
};

describe('voice engine normalization', () => {
  it('keeps canonical engines and upgrades the legacy Qwen3 alias', () => {
    expect(normalizeVoiceEngine('kokoro')).toBe('kokoro');
    expect(normalizeVoiceEngine('piper')).toBe('piper');
    expect(normalizeVoiceEngine('qwen3-tts')).toBe('qwen3-tts');
    expect(normalizeVoiceEngine('qwen3')).toBe('qwen3-tts');
  });

  it('publishes registry display and configuration metadata for every engine', async () => {
    const engines = await listVoiceEngines();

    expect(engines).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'piper', configKey: 'piper', label: 'Piper' }),
      expect.objectContaining({ id: 'qwen3-tts', configKey: 'qwen3', label: 'Qwen3-TTS' }),
    ]));
  });
});

describe('profile-aware TTS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findPiperVoice.mockReturnValue({});
    getVoiceConfig.mockResolvedValue(CONFIG);
    synthesizePiper.mockResolvedValue({ wav: Buffer.from('wav'), latencyMs: 12 });
  });

  it('dispatches the legacy Qwen3 engine alias and preset key to the Qwen3 adapter', async () => {
    getProfileForSynthesis.mockResolvedValue(null);
    synthesizeQwen3.mockResolvedValue({
      wav: Buffer.from('qwen3-wav'), latencyMs: 8, modelRevision: 'qwen3-model',
    });

    const result = await synthesize('A stable character line.', {
      engine: 'qwen3', voice: 'warm-narrator',
    });

    expect(synthesizeQwen3).toHaveBeenCalledWith(
      'A stable character line.',
      expect.objectContaining({ voice: 'warm-narrator', rate: 1.7 }),
      undefined,
    );
    expect(result.engine).toBe('qwen3-tts');
  });

  it('refuses retired presets and profiles without silently replacing their voice', async () => {
    await expect(synthesize('hello', { engine: 'kokoro', voice: 'af_heart' }))
      .rejects.toMatchObject({ code: 'VOICE_ENGINE_RETIRED' });
    getProfileForSynthesis.mockResolvedValue({ engine: 'kokoro', voiceId: 'kokoro:af_heart' });
    await expect(synthesize('hello', { profileId: 'old-profile' }))
      .rejects.toMatchObject({ code: 'VOICE_ENGINE_RETIRED' });
    expect(synthesizePiper).not.toHaveBeenCalled();
  });

  it('uses Piper for the default engine', async () => {
    getVoiceConfig.mockResolvedValue({ tts: { ...CONFIG.tts, engine: 'piper' } });
    const result = await synthesize('hello');
    expect(result.engine).toBe('piper');
    expect(synthesizePiper).toHaveBeenCalled();
  });

  it('uses the approved profile voice and promoted delivery rate instead of later project defaults', async () => {
    getProfileForSynthesis.mockResolvedValue({
      id: 'voice-profile-1', version: 3, engine: 'piper', voiceId: 'piper:en_US-lessac-medium',
      delivery: { rate: 0.85, pitchSemitones: null, formantSemitones: null },
      mastering: { chain: ['preset-output:unprocessed'] },
    });

    const result = await synthesize('A stable character line.', { profileId: 'voice-profile-1', route: 'studio' });

    expect(synthesizePiper).toHaveBeenCalledWith('A stable character line.', expect.objectContaining({
      rate: 0.85,
      piper: expect.objectContaining({ voice: 'en_US-lessac-medium' }),
    }), undefined);
    expect(result).toMatchObject({
      engine: 'piper', profileId: 'voice-profile-1', profileRevision: 3,
      provenance: {
        modelRevision: 'piper:en_US-lessac-medium',
        effectiveControls: { rate: 0.85 },
        mastering: { chain: ['preset-output:unprocessed'] },
      },
    });
  });
});
