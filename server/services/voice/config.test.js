import { describe, expect, it } from 'vitest';
import { VOICE_DEFAULTS } from './config.js';

describe('voice configuration defaults', () => {
  it('provides a usable Qwen3-TTS voice and model when the engine is selected', () => {
    expect(VOICE_DEFAULTS.tts.qwen3).toEqual({
      modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
      voice: 'warm-narrator',
    });
  });
});
