import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
const { getSettings, updateSettings } = await import('../settings.js');
const { VOICE_DEFAULTS, getVoiceConfig, updateVoiceConfig, invalidateVoiceConfigCache } = await import('./config.js');

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

  it('keeps every shipped voice setting aligned with its code default', async () => {
    const seed = JSON.parse(await readFile(new URL('../../../data.reference/settings.json', import.meta.url), 'utf8'));

    const assertSeedLeavesMatchDefaults = (defaults, values, path = 'voice') => {
      for (const [key, value] of Object.entries(values)) {
        const currentPath = `${path}.${key}`;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          assertSeedLeavesMatchDefaults(defaults?.[key] || {}, value, currentPath);
          continue;
        }
        expect(defaults?.[key], `seed ${currentPath} must match VOICE_DEFAULTS`).toEqual(value);
      }
    };

    assertSeedLeavesMatchDefaults(VOICE_DEFAULTS, seed.voice);
  });
});

it('persists retirement acknowledgement without removing customized TTS settings', async () => {
  const tts = { engine: 'piper', retiredEngine: 'kokoro', rate: 1.3, piper: { voice: 'custom', voicePath: '~/custom.onnx' } };
  getSettings.mockResolvedValue({ voice: { enabled: true, tts } });
  const saved = await updateVoiceConfig({ tts: { retiredEngine: null } });
  expect(saved.tts).not.toHaveProperty('retiredEngine');
  expect(saved.tts).toMatchObject({ engine: 'piper', rate: 1.3, piper: tts.piper });
  expect(updateSettings).toHaveBeenCalledWith({ voice: saved });
  expect(await getVoiceConfig()).toBe(saved);
});
