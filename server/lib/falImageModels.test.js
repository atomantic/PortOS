import { describe, it, expect } from 'vitest';
import {
  FAL_FEATURED_EDIT_MODEL_IDS, FAL_FEATURED_IMAGE_MODEL_IDS, FAL_IMAGE_DEFAULT_MODEL, FAL_IMAGE_FAMILIES, FAL_IMAGE_MODEL_IDS,
  FAL_IMAGE_MODEL_OPTIONS, buildFalImageRequest, buildListedFalImageRequest, falImageFamily,
  falImageModelChoices, falImageModelGroups, falInputSchemaFromOpenApi, isPlausibleFalEndpointId,
} from './falImageModels.js';
import { imageGenFalSettingsSchema } from './settingsValidation.js';

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

  it('prices Seedream 4.5 exactly and routes references to its edit endpoint', () => {
    const text = build('fal-ai/bytedance/seedream/v4.5/text-to-image', { width: 2560, height: 1440, seed: 7 });
    expect(text.endpointId).toBe('fal-ai/bytedance/seedream/v4.5/text-to-image');
    expect(text.body).toEqual({ prompt: 'p', image_size: { width: 2560, height: 1440 }, seed: 7 });
    expect(text.estimatedCostUsd).toBe(0.04);
    const edit = build('fal-ai/bytedance/seedream/v4.5/edit', { imageUrls: ['a'], width: 1920, height: 1920 });
    expect(edit.endpointId).toBe('fal-ai/bytedance/seedream/v4.5/edit');
    expect(edit.body.image_urls).toEqual(['a']);
    expect(edit.body).not.toHaveProperty('output_format');
    expect(FAL_IMAGE_DEFAULT_MODEL).toBe('fal-ai/nano-banana-pro');
  });

  it('leads the picker with the featured endpoints and keeps a listed model behind the priced rows', () => {
    expect(FAL_FEATURED_IMAGE_MODEL_IDS.every((id) => FAL_IMAGE_MODEL_IDS.includes(id))).toBe(true);
    expect(FAL_IMAGE_MODEL_OPTIONS.slice(0, 4).map((row) => row.id)).toEqual([...FAL_FEATURED_IMAGE_MODEL_IDS]);
    expect(FAL_IMAGE_MODEL_OPTIONS.find((row) => row.id === 'fal-ai/nano-banana-pro/edit').label).toContain('up to 14 refs');
    const choices = falImageModelChoices([
      { id: 'fal-ai/nano-banana-pro', label: 'LIVE NAME', category: 'text-to-image' },
      { id: 'fal-ai/flux/schnell', label: 'FLUX Schnell', category: 'text-to-image' },
      { id: 'gpt-5.6-luna', label: 'nope' },
    ]);
    expect(choices.find((row) => row.id === 'fal-ai/nano-banana-pro').label).toContain('$0.15/image');
    expect(choices.at(-1)).toMatchObject({ id: 'fal-ai/flux/schnell', known: false, featured: false });
    expect(choices.some((row) => row.id === 'gpt-5.6-luna')).toBe(false);
    expect(FAL_FEATURED_EDIT_MODEL_IDS.every((id) => FAL_FEATURED_IMAGE_MODEL_IDS.includes(id))).toBe(true);
    const editing = falImageModelGroups(choices, { editing: true });
    expect(editing.map((group) => group.label)).toEqual(['Edit / refine', 'Featured', 'All image models']);
    expect(editing[0].models.map((row) => row.id)).toEqual([...FAL_FEATURED_EDIT_MODEL_IDS]);
    expect(editing[1].models.slice(0, 2).map((row) => row.id)).toEqual([
      'fal-ai/bytedance/seedream/v4.5/text-to-image',
      'fal-ai/nano-banana-pro',
    ]);
    expect(editing[1].models.some((row) => FAL_FEATURED_EDIT_MODEL_IDS.includes(row.id))).toBe(false);
    expect(editing.flatMap((group) => group.models).filter((row) => row.id === 'fal-ai/nano-banana-pro/edit')).toHaveLength(1);
    expect(falImageModelGroups(choices).map((group) => group.label)).toEqual(['Featured', 'All image models']);
  });

  it('accepts a plausible fal endpoint id and refuses one that is not', () => {
    expect(isPlausibleFalEndpointId('fal-ai/flux/schnell')).toBe(true);
    expect(isPlausibleFalEndpointId(' fal-ai/flux/schnell ')).toBe(true);
    expect(isPlausibleFalEndpointId('gpt-5.6-luna')).toBe(false);
    expect(isPlausibleFalEndpointId('../etc')).toBe(false);
    expect(isPlausibleFalEndpointId('')).toBe(false);
    expect(imageGenFalSettingsSchema.parse({ model: 'fal-ai/bytedance/seedream/v4.5/text-to-image' }).model)
      .toBe('fal-ai/bytedance/seedream/v4.5/text-to-image');
    expect(imageGenFalSettingsSchema.parse({ model: 'fal-ai/flux/schnell' }).model).toBe('fal-ai/flux/schnell');
    expect(imageGenFalSettingsSchema.parse({ model: '' }).model).toBeUndefined();
    expect(() => imageGenFalSettingsSchema.parse({ model: 'gpt-5.6-luna' })).toThrow();
  });

  it('builds a listed request from resolved schema fields and does not guess a named size or a price', () => {
    const spec = {
      paths: { '/queue': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } } } } },
      components: { schemas: {
        Input: {
          required: ['prompt', 'image_urls'],
          properties: {
            prompt: { type: 'string' },
            image_urls: { type: 'array', items: { type: 'string' }, maxItems: 3 },
            image_size: { anyOf: [{ $ref: '#/components/schemas/ImageSize' }, { type: 'string', enum: ['square_hd', 'auto_2K'] }] },
            seed: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            output_format: { type: 'string', enum: ['jpeg', 'png'] },
            num_images: { type: 'integer' },
          },
        },
        ImageSize: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } },
        EnumOnly: { properties: { prompt: { type: 'string' }, image_size: { type: 'string', enum: ['square_hd'] } }, required: ['prompt'] },
      } },
    };
    const schema = falInputSchemaFromOpenApi(spec);
    const req = buildListedFalImageRequest({
      modelId: 'fal-ai/flux/schnell', schema, prompt: 'harbour', negativePrompt: 'blur',
      width: 800, height: 600, imageUrls: ['a', 'b', 'c', 'd'], seed: 4,
    });
    expect(req.estimatedCostUsd).toBeNull();
    expect(req.requiresImages).toBe(true);
    expect(req.body).toEqual({
      prompt: 'harbour\nAvoid: blur',
      image_urls: ['a', 'b', 'c'],
      image_size: { width: 800, height: 600 },
      seed: 4,
      output_format: 'png',
    });
    expect(req.body).not.toHaveProperty('num_images');
    const enumOnly = falInputSchemaFromOpenApi({
      paths: { '/': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/EnumOnly' } } } } } } },
      components: spec.components,
    });
    expect(enumOnly.imageSize).toBeNull();
    expect(buildListedFalImageRequest({
      modelId: 'fal-ai/flux/schnell', schema: enumOnly, prompt: 'p', width: 512, height: 512,
    }).body).toEqual({ prompt: 'p' });
    expect(buildListedFalImageRequest({ modelId: 'gpt-5.6-luna', schema, prompt: 'p' })).toBeNull();
    expect(falInputSchemaFromOpenApi({ paths: {} })).toBeNull();
  });
});
