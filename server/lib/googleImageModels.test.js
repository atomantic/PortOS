import { describe, expect, it } from 'vitest';
import { buildGoogleImageRequest, googleImagePriceLabel, googleImageFamily } from './googleImageModels.js';

const img = { mimeType: 'image/png', data: 'AAAA' };

describe('buildGoogleImageRequest', () => {
  it('sends a Gemini image request with references, ratio, size tier and seed', () => {
    const out = buildGoogleImageRequest({ modelId: 'gemini-3-pro-image', prompt: 'a lighthouse', width: 1920, height: 1080, images: [img, img], seed: 42 });
    expect(out.method).toBe('generateContent');
    expect(out.location).toBe('global');
    expect(out.body.contents[0].parts).toEqual([{ text: 'a lighthouse' }, { inlineData: img }, { inlineData: img }]);
    expect(out.body.generationConfig).toEqual({ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' }, seed: 42 });
    expect(out.estimatedCostUsd).toBe(0.134);
  });

  it('sends Imagen with enhancePrompt off and the negative prompt as a visible Avoid clause', () => {
    const out = buildGoogleImageRequest({ modelId: 'imagen-4.0-generate-001', prompt: 'a lighthouse', negativePrompt: 'text', width: 1024, height: 1024, seed: 7 });
    expect(out.method).toBe('predict');
    expect(out.body).toEqual({
      instances: [{ prompt: 'a lighthouse\nAvoid: text' }],
      parameters: { sampleCount: 1, enhancePrompt: false, aspectRatio: '1:1', sampleImageSize: '1K' },
    });
    expect(out.seed).toBeNull();
    expect(out.location).toBeNull();
  });

  it('refuses inputs a model cannot take instead of dropping them', () => {
    expect(() => buildGoogleImageRequest({ modelId: 'imagen-4.0-generate-001', prompt: 'p', images: [img] })).toThrow(/text-to-image only/);
    expect(() => buildGoogleImageRequest({ modelId: 'gemini-2.5-flash-image', prompt: 'p', images: [img, img, img, img] })).toThrow(/at most 3/);
    expect(() => buildGoogleImageRequest({ modelId: 'imagen-9', prompt: 'p' })).toThrow(/Unknown Google image model/);
    expect(() => buildGoogleImageRequest({ prompt: '  ' })).toThrow(/Prompt is required/);
    expect(() => buildGoogleImageRequest({ prompt: '  ', negativePrompt: 'text' })).toThrow(/Prompt is required/);
  });

  it('labels prices without inventing one', () => {
    expect(googleImagePriceLabel(googleImageFamily('gemini-3-pro-image'))).toBe('from ~$0.134/image');
    expect(googleImagePriceLabel(googleImageFamily('gemini-3.1-flash-image'))).toBe('');
  });
});
