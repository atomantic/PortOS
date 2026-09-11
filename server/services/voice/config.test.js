import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
import { getSettings, updateSettings } from '../settings.js';
import { VOICE_DEFAULTS, getVoiceConfig, updateVoiceConfig, invalidateVoiceConfigCache } from './config.js';

beforeEach(() => { vi.clearAllMocks(); invalidateVoiceConfigCache(); });

it('upgrades restored legacy config on reads and old-client saves without losing settings', async () => {
  const legacy = { enabled: true, tts: { engine: 'kokoro', rate: 1.3, kokoro: { voice: 'af_heart' } } };
  getSettings.mockResolvedValue({ voice: legacy });
  const cfg = await getVoiceConfig();
  expect(cfg.tts).toMatchObject({ engine: 'piper', retiredEngine: 'kokoro', rate: 1.3, piper: VOICE_DEFAULTS.tts.piper });
  expect(cfg.enabled).toBe(true);
  expect(updateSettings).not.toHaveBeenCalled();
  const saved = await updateVoiceConfig({ tts: { engine: 'kokoro' } });
  expect(saved.tts.engine).toBe('piper');
  expect(updateSettings).toHaveBeenCalledWith({ voice: saved });
});


describe('voice configuration defaults', () => {
  it('provides a usable Qwen3-TTS voice and model when the engine is selected', () => {
    expect(VOICE_DEFAULTS.tts.qwen3).toEqual({
      modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
      voice: 'warm-narrator',
    });
  });
});
