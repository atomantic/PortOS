import { describe, it, expect } from 'vitest';
import {
  FAL_IMAGE_FAMILIES, FAL_IMAGE_MODEL_IDS, buildFalImageRequest, falImageFamily,
} from './falImageModels.js';

// The provider suite (services/imageGen/fal.test.js) drives a nano-banana and a
// FLUX.2 render end to end; this pins the per-family mapping matrix the wire
// body and the recorded cost depend on, which one render per family can't.
describe('falImageModels — request mapping and cost', () => {
  const build = (modelId, extra = {}) => buildFalImageRequest({ modelId, prompt: 'p', ...extra });

  it('names every catalog family by either endpoint id and refuses anything else', () => {
    for (const family of FAL_IMAGE_FAMILIES) {
      expect(falImageFamily(family.textEndpoint)).toBe(family);
      expect(falImageFamily(family.editEndpoint)).toBe(family);
    }
    expect(FAL_IMAGE_MODEL_IDS).toHaveLength(FAL_IMAGE_FAMILIES.length * 2);
    expect(build('fal-ai/flux-pro')).toBeNull();
  });

  it.each([
    // [model, width, height, aspect_ratio, resolution, cost]
    ['fal-ai/nano-banana-pro', 1344, 768, '16:9', '1K', 0.15],
    ['fal-ai/nano-banana-pro', 2560, 1440, '16:9', '2K', 0.15],
    ['fal-ai/nano-banana-pro', 4096, 4096, '1:1', '4K', 0.3],
    ['fal-ai/nano-banana-2', 512, 512, '1:1', '0.5K', 0.06],
    ['fal-ai/nano-banana-2', 832, 1216, '2:3', '1K', 0.08],
    ['fal-ai/nano-banana-2', 3840, 1600, '21:9', '4K', 0.16],
  ])('%s at %ix%i → %s / %s ≈ $%s', (modelId, width, height, aspect, resolution, cost) => {
    const req = build(modelId, { width, height });
    expect(req.body).toMatchObject({ aspect_ratio: aspect, resolution });
    expect(req.estimatedCostUsd).toBe(cost);
  });

  it('omits geometry entirely when no size was asked for, so each endpoint applies its own default', () => {
    const req = build('fal-ai/nano-banana-pro');
    expect(req.body).not.toHaveProperty('aspect_ratio');
    expect(req.body).not.toHaveProperty('resolution');
    expect(build('fal-ai/flux-2-pro').body).not.toHaveProperty('image_size');
  });

  it('sends Seedream pixel geometry and no seed/output_format fields its schema lacks', () => {
    const req = build('fal-ai/bytedance/seedream/v5/lite/text-to-image', { width: 2560, height: 1440, seed: 7 });
    expect(req.endpointId).toBe('fal-ai/bytedance/seedream/v5/lite/text-to-image');
    expect(req.body).toEqual({ prompt: 'p', image_size: { width: 2560, height: 1440 } });
    expect(req.estimatedCostUsd).toBe(0.035);
  });

  it('bills FLUX.2 by output plus input megapixels, rounded up', () => {
    // 1 MP output, no inputs → the first-megapixel price.
    expect(build('fal-ai/flux-2-pro', { width: 1024, height: 1024 }).estimatedCostUsd).toBe(0.03);
    // 2 MP output (1920×1088 aligned) + 1.2 MP of references → 2 + 2 billed MP.
    const edit = build('fal-ai/flux-2-pro', { width: 1920, height: 1080, imageUrls: ['a', 'b'], inputMegapixels: 1.2 });
    expect(edit.endpointId).toBe('fal-ai/flux-2-pro/edit');
    expect(edit.estimatedCostUsd).toBe(0.075);
  });
});
