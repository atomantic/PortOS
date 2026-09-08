import { describe, expect, it } from 'vitest';
import {
  LOCAL_PERSISTENT_MIND_MODEL,
  LOCAL_PERSISTENT_MIND_PROVIDER_ID,
  hasUsableNvidiaGpu,
  hostFitsLocalPersistentMindDefault,
  isCpuOnlyHost,
  isCuratedGpuCodingHost,
  isLowRamHost,
  localPersistentMindRecommendation,
  matchesLocalPersistentMindModel,
  shouldSuppressHeavyLocalPresets,
} from './localPersistentMindRecommendation.js';

const grokBox = Object.freeze({
  platform: 'linux',
  arch: 'x64',
  appleSilicon: false,
  totalMemoryGb: 15.6,
  cpuCount: 4,
  cuda: { status: 'absent', gpus: [], maxVramGb: null },
});

const apple64 = Object.freeze({
  platform: 'darwin',
  arch: 'arm64',
  appleSilicon: true,
  totalMemoryGb: 64,
  cuda: { status: 'absent', gpus: [], maxVramGb: null },
});

const rtx3090 = Object.freeze({
  platform: 'win32',
  appleSilicon: false,
  totalMemoryGb: 64,
  cuda: {
    status: 'available',
    maxVramGb: 24,
    gpus: [{ name: 'NVIDIA GeForce RTX 3090', vramGb: 24 }],
  },
});

describe('localPersistentMindRecommendation helpers', () => {
  it('recognizes the recommended model and common Ollama aliases', () => {
    expect(matchesLocalPersistentMindModel(LOCAL_PERSISTENT_MIND_MODEL)).toBe(true);
    expect(matchesLocalPersistentMindModel('qwen2.5:7b')).toBe(true);
    expect(matchesLocalPersistentMindModel('qwen2.5:7b-instruct:latest')).toBe(true);
    expect(matchesLocalPersistentMindModel('qwen3.8:27b')).toBe(false);
    expect(matchesLocalPersistentMindModel('')).toBe(false);
  });

  it('classifies a Grok Bot box as CPU-only, low-RAM, and default-fit', () => {
    expect(isCpuOnlyHost(grokBox)).toBe(true);
    expect(isLowRamHost(grokBox)).toBe(true);
    expect(hasUsableNvidiaGpu(grokBox)).toBe(false);
    expect(isCuratedGpuCodingHost(grokBox)).toBe(false);
    expect(hostFitsLocalPersistentMindDefault(grokBox)).toBe(true);
    expect(shouldSuppressHeavyLocalPresets(grokBox)).toBe(true);
  });

  it('leaves curated GPU coding hosts to HardwareLlmRecommendation', () => {
    expect(isCuratedGpuCodingHost(apple64)).toBe(true);
    expect(hostFitsLocalPersistentMindDefault(apple64)).toBe(false);
    expect(localPersistentMindRecommendation(apple64)).toBeNull();
    expect(isCuratedGpuCodingHost(rtx3090)).toBe(true);
    expect(localPersistentMindRecommendation(rtx3090)).toBeNull();
    expect(shouldSuppressHeavyLocalPresets(rtx3090)).toBe(false);
  });

  it('recommends Ollama + Qwen2.5 7B Instruct for a Grok Bot box', () => {
    const profile = localPersistentMindRecommendation(grokBox);
    expect(profile).toMatchObject({
      id: 'grok-box-ollama-mind',
      audience: 'grok-box',
      providerId: LOCAL_PERSISTENT_MIND_PROVIDER_ID,
      model: LOCAL_PERSISTENT_MIND_MODEL,
      runtime: 'Ollama',
      cpuOnly: true,
      lowRam: true,
      suppressHeavyLocalPresets: true,
    });
    expect(profile.codingHarnesses).toMatch(/Cursor/i);
    expect(profile.codingHarnesses).toMatch(/OpenCode/i);
    expect(profile.warnings.some((w) => /no usable NVIDIA GPU/i.test(w))).toBe(true);
    expect(profile.warnings.some((w) => /7B|27B|vLLM/i.test(w))).toBe(true);
    expect(profile.alternatives).toMatch(/vLLM|27B/i);
  });

  it('treats a failed CUDA probe as not having a GPU', () => {
    const unknownCuda = {
      ...grokBox,
      cuda: { status: 'unknown', gpus: [], maxVramGb: null },
    };
    expect(hasUsableNvidiaGpu(unknownCuda)).toBe(false);
    expect(localPersistentMindRecommendation(unknownCuda)?.providerId).toBe('ollama');
  });

  it('offers the free mind path on modest Apple Silicon without a 27B coding preset', () => {
    const apple16 = {
      platform: 'darwin',
      appleSilicon: true,
      totalMemoryGb: 16,
      cuda: { status: 'absent', gpus: [], maxVramGb: null },
    };
    expect(isCpuOnlyHost(apple16)).toBe(false);
    expect(hostFitsLocalPersistentMindDefault(apple16)).toBe(true);
    expect(shouldSuppressHeavyLocalPresets(apple16)).toBe(true);
    expect(localPersistentMindRecommendation(apple16)?.model).toBe(LOCAL_PERSISTENT_MIND_MODEL);
  });
});
