import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(),
  piperVoiceTildePath: vi.fn((voice) => `~/.portos/voice/voices/${voice}.onnx`),
}));
vi.mock('./tts-kokoro.js', () => ({ synthesizeKokoro: vi.fn(), listKokoroVoices: vi.fn() }));
vi.mock('./tts-piper.js', () => ({ synthesizePiper: vi.fn(), listPiperVoices: vi.fn() }));
vi.mock('./tts-qwen3.js', () => ({ synthesizeQwen3: vi.fn(), listQwen3Voices: vi.fn() }));
vi.mock('./piper-voices.js', () => ({ findPiperVoice: vi.fn() }));
vi.mock('./kokoro-voices.js', () => ({ isKokoroVoice: vi.fn(() => true) }));
vi.mock('./profiles.js', () => ({ getProfileForSynthesis: vi.fn() }));
vi.mock('./bootstrap.js', () => ({ which: vi.fn() }));
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn().mockResolvedValue(null) }));

import { getVoiceConfig } from './config.js';
import { synthesizeKokoro } from './tts-kokoro.js';
import { synthesizeQwen3 } from './tts-qwen3.js';
import { getProfileForSynthesis } from './profiles.js';
import { listVoiceEngines, normalizeVoiceEngine, synthesize } from './tts.js';

const CONFIG = {
  tts: {
    engine: 'kokoro',
    rate: 1.7,
    kokoro: { modelId: 'configured-model', dtype: 'q8', voice: 'af_bella' },
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
      expect.objectContaining({ id: 'kokoro', configKey: 'kokoro', label: 'Kokoro' }),
      expect.objectContaining({ id: 'piper', configKey: 'piper', label: 'Piper' }),
      expect.objectContaining({ id: 'qwen3-tts', configKey: 'qwen3', label: 'Qwen3-TTS' }),
    ]));
  });
});

describe('profile-aware TTS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVoiceConfig.mockResolvedValue(CONFIG);
    synthesizeKokoro.mockResolvedValue({ wav: Buffer.from('wav'), latencyMs: 12 });
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

  it('uses the approved profile voice and promoted delivery rate instead of later project defaults', async () => {
    getProfileForSynthesis.mockResolvedValue({
      id: 'voice-profile-1', version: 3, engine: 'kokoro', voiceId: 'kokoro:af_heart',
      delivery: { rate: 0.85, pitchSemitones: null, formantSemitones: null },
      mastering: { chain: ['preset-output:unprocessed'] },
    });

    const result = await synthesize('A stable character line.', { profileId: 'voice-profile-1', route: 'studio' });

    expect(synthesizeKokoro).toHaveBeenCalledWith('A stable character line.', expect.objectContaining({
      rate: 0.85,
      kokoro: expect.objectContaining({ voice: 'af_heart' }),
    }), undefined);
    expect(result).toMatchObject({
      engine: 'kokoro', profileId: 'voice-profile-1', profileRevision: 3,
      provenance: {
        modelRevision: 'configured-model:q8',
        effectiveControls: { rate: 0.85 },
        mastering: { chain: ['preset-output:unprocessed'] },
      },
    });
  });
});
