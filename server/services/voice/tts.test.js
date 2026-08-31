import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(),
  piperVoiceTildePath: vi.fn((voice) => `~/.portos/voice/voices/${voice}.onnx`),
}));
vi.mock('./tts-kokoro.js', () => ({ synthesizeKokoro: vi.fn(), listKokoroVoices: vi.fn() }));
vi.mock('./tts-piper.js', () => ({ synthesizePiper: vi.fn(), listPiperVoices: vi.fn() }));
vi.mock('./piper-voices.js', () => ({ findPiperVoice: vi.fn() }));
vi.mock('./kokoro-voices.js', () => ({ isKokoroVoice: vi.fn(() => true) }));
vi.mock('./profiles.js', () => ({ getProfileForSynthesis: vi.fn() }));
vi.mock('./bootstrap.js', () => ({ which: vi.fn() }));

import { getVoiceConfig } from './config.js';
import { synthesizeKokoro } from './tts-kokoro.js';
import { getProfileForSynthesis } from './profiles.js';
import { synthesize } from './tts.js';

const CONFIG = {
  tts: {
    engine: 'kokoro',
    rate: 1.7,
    kokoro: { modelId: 'configured-model', dtype: 'q8', voice: 'af_bella' },
    piper: { voice: 'en_US-lessac-medium', voicePath: '~/.portos/voice/voices/en_US-lessac-medium.onnx' },
  },
};

describe('profile-aware TTS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVoiceConfig.mockResolvedValue(CONFIG);
    synthesizeKokoro.mockResolvedValue({ wav: Buffer.from('wav'), latencyMs: 12 });
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
