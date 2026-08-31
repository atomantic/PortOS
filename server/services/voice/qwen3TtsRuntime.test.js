import { describe, it, expect, vi } from 'vitest';
import {
  SUPPORTED_QWEN3_MODELS,
  downloadQwen3Model,
  getQwen3RuntimeStatus,
  resolveQwen3Python,
} from './qwen3TtsRuntime.js';

describe('qwen3TtsRuntime', () => {
  it('enumerates supported models with sizes and default roles', () => {
    expect(SUPPORTED_QWEN3_MODELS.length).toBeGreaterThanOrEqual(3);
    const designModel = SUPPORTED_QWEN3_MODELS.find((m) => m.defaultFor === 'voiceDesign');
    const cloneModel = SUPPORTED_QWEN3_MODELS.find((m) => m.defaultFor === 'instantClone');
    const interactiveModel = SUPPORTED_QWEN3_MODELS.find((m) => m.defaultFor === 'interactive');

    expect(designModel).toBeDefined();
    expect(cloneModel).toBeDefined();
    expect(interactiveModel).toBeDefined();
  });

  it('probes runtime health without throwing when python is available', async () => {
    const status = await getQwen3RuntimeStatus();
    expect(status).toHaveProperty('ok');
    expect(status).toHaveProperty('installed');
    expect(status).toHaveProperty('supportedModels');
  });

  it('downloads model explicitly on user request and rejects unknown models', async () => {
    await expect(downloadQwen3Model('unknown/invalid-model')).rejects.toThrow(/unsupported qwen3/i);

    const result = await downloadQwen3Model('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign');
    expect(result).toMatchObject({
      ok: true,
      modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    });
  });
});
