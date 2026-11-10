import { describe, expect, it } from 'vitest';
import { buildVertexVideoRequest } from './vertexVideoModels.js';

const img = { mimeType: 'image/png', data: 'AAAA' };

describe('buildVertexVideoRequest', () => {
  it('builds an image-to-video request with an end frame, native negative prompt and snapped length', () => {
    const out = buildVertexVideoRequest({
      modelId: 'veo-3.1-generate-001', prompt: 'the door opens', negativePrompt: 'blur', seconds: 5, width: 1080, height: 1920,
      image: img, lastImage: img, generateAudio: true, seed: '12',
    });
    expect(out.route).toBe('image');
    expect(out.body.instances[0]).toEqual({
      prompt: 'the door opens', image: { bytesBase64Encoded: 'AAAA', mimeType: 'image/png' }, lastFrame: { bytesBase64Encoded: 'AAAA', mimeType: 'image/png' },
    });
    expect(out.body.parameters).toEqual({
      sampleCount: 1, durationSeconds: 4, resolution: '720p', generateAudio: true, aspectRatio: '9:16', negativePrompt: 'blur', seed: 12,
    });
    expect(out.estimatedCostUsd).toBeNull();
  });

  it('sends reference images as assets at the one length Veo accepts', () => {
    const out = buildVertexVideoRequest({ modelId: 'veo-3.1-generate-001', prompt: 'p', referenceImages: [img, img] });
    expect(out.route).toBe('reference');
    expect(out.seconds).toBe(8);
    expect(out.body.instances[0].referenceImages).toHaveLength(2);
    expect(out.body.instances[0].referenceImages[0].referenceType).toBe('asset');
    expect(() => buildVertexVideoRequest({ modelId: 'veo-3.1-generate-001', prompt: 'p', referenceImages: [img], seconds: 4 })).toThrow(/only as 8-second/);
  });

  it('refuses inputs a model cannot take', () => {
    expect(() => buildVertexVideoRequest({ modelId: 'veo-3.0-generate-001', prompt: 'p', image: img, lastImage: img })).toThrow(/no end frame/);
    expect(() => buildVertexVideoRequest({ modelId: 'veo-3.1-fast-generate-001', prompt: 'p', referenceImages: [img] })).toThrow(/no reference images/);
    expect(() => buildVertexVideoRequest({ prompt: 'p', image: img, referenceImages: [img] })).toThrow(/not both/);
    expect(() => buildVertexVideoRequest({ prompt: '', lastImage: img })).toThrow(/end frame needs a start frame/);
    expect(() => buildVertexVideoRequest({ prompt: '' })).toThrow(/Prompt is required/);
    expect(buildVertexVideoRequest({ prompt: '', image: img }).route).toBe('image');
  });
});
