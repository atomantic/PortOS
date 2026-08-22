import { describe, it, expect } from 'vitest';
import { buildFederatedMediaRequest } from './federatedMediaRequest.js';

describe('buildFederatedMediaRequest', () => {
  it('projects local image params onto the wire body', () => {
    expect(buildFederatedMediaRequest({
      kind: 'image',
      params: { modelId: 'sdxl-base', prompt: 'a lighthouse', width: 512, height: 768, steps: 20, guidance: 7, seed: 3 },
    })).toEqual({
      kind: 'image', engine: 'local', modelId: 'sdxl-base', prompt: 'a lighthouse',
      width: 512, height: 768, steps: 20, guidance: 7, seed: 3,
    });
  });

  // The strength scales the init image it travels with (#4348). Dropping it
  // renders at FULL denoise — the opposite of what a low strength asked for,
  // and indistinguishable from a working render until the result comes back.
  // It is projected without its `initImage`, because the image itself reaches
  // the body as an asset id resolved immediately before submission; the builder
  // therefore validates against the un-refined base schema.
  it('projects an init-image strength even though the image itself is added later', () => {
    expect(buildFederatedMediaRequest({
      kind: 'image',
      params: {
        modelId: 'sdxl-base', prompt: 'a lighthouse', width: 512, height: 512,
        initImagePath: 'source.png', initImageStrength: 0.35,
      },
    })).toMatchObject({ initImageStrength: 0.35 });
  });

  it('maps the video route dialect guidanceScale onto the wire guidance field', () => {
    const request = buildFederatedMediaRequest({
      kind: 'video',
      params: { modelId: 'wan-2.2', prompt: 'a drifting balloon', guidanceScale: 5.5, numFrames: 33, fps: 16 },
    });
    expect(request.guidance).toBe(5.5);
    expect(request).not.toHaveProperty('guidanceScale');
    expect(request.numFrames).toBe(33);
  });

  it('omits absent optionals rather than sending explicit undefined into a strict schema', () => {
    const request = buildFederatedMediaRequest({ kind: 'image', params: { modelId: 'm', prompt: 'p' } });
    expect(Object.keys(request).sort()).toEqual(['engine', 'kind', 'modelId', 'prompt']);
  });

  it('treats a blank negative prompt as absent', () => {
    const request = buildFederatedMediaRequest({
      kind: 'image',
      params: { modelId: 'm', prompt: 'p', negativePrompt: '   ' },
    });
    expect(request).not.toHaveProperty('negativePrompt');
  });

  it('prefers an explicit engine over the local mediaProviderEngine param', () => {
    expect(buildFederatedMediaRequest({
      kind: 'image', engine: 'comfy', params: { mediaProviderEngine: 'local', modelId: 'm', prompt: 'p' },
    }).engine).toBe('comfy');
    expect(buildFederatedMediaRequest({
      kind: 'image', params: { mediaProviderEngine: 'comfy', modelId: 'm', prompt: 'p' },
    }).engine).toBe('comfy');
  });

  it('rejects a body the provider would refuse instead of persisting it into a marker', () => {
    expect(() => buildFederatedMediaRequest({ kind: 'image', params: { modelId: 'm' } })).toThrow();
    expect(() => buildFederatedMediaRequest({ kind: 'image', params: { prompt: 'p' } })).toThrow();
  });

  it('refuses a kind with no wire projection', () => {
    expect(() => buildFederatedMediaRequest({ kind: 'audio', params: { modelId: 'm', prompt: 'p' } }))
      .toThrow(/unsupported kind audio/);
  });
});
