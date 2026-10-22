import { describe, it, expect } from 'vitest';
import { RUNWAY_IMAGE_MODELS, buildRunwayImageRequest, runwayReferenceTags } from './runwayImageModels.js';

const ref = { uri: 'https://example.com/anchor.png', tag: 'char1' };
describe('Runway image wire contracts', () => {
  // Catches unsupported model fields and resolution/price drift without paid requests.
  it.each(RUNWAY_IMAGE_MODELS)('$id emits only the image API fields and prices each canvas', (model) => {
    const references = model.id === 'bria_fibo_edit_1_5' ? [ref, { uri: 'https://example.com/second.png', tag: 'ref2' }] : [ref];
    for (const [resolution, ratios] of Object.entries(model.ratios)) {
      for (const ratio of ratios) {
        const request = buildRunwayImageRequest({ modelId: model.id, prompt: '  @char1 in a garden  ', resolution, ratio, seed: 42, referenceImages: references });
        expect(request.body).toEqual({ model: model.id, promptText: '  @char1 in a garden  ', ratio, ...(model.seed ? { seed: 42 } : {}), referenceImages: references.map((r) => model.referenceTags ? r : { uri: r.uri }) });
        expect(request.estimatedCredits).toBe(model.credits[resolution] ?? null);
      }
    }
  });
  it('permits text-only Gen-4, refuses Turbo without a reference and refuses excess inputs', () => {
    expect(buildRunwayImageRequest({ prompt: 'garden' }).body).toEqual({ model: 'gen4_image', promptText: 'garden', ratio: '720:720' });
    expect(() => buildRunwayImageRequest({ modelId: 'gen4_image_turbo', prompt: 'garden' })).toThrow('1–3 reference');
    expect(() => buildRunwayImageRequest({ prompt: 'garden', referenceImages: [ref, ref, ref, ref] })).toThrow('0–3 reference');
    expect(() => buildRunwayImageRequest({ prompt: 'x'.repeat(1001) })).toThrow('1001');
    expect(() => buildRunwayImageRequest({ prompt: 'garden', ratio: '1:1' })).toThrow('ratio');
    expect(() => buildRunwayImageRequest({ prompt: 'garden', seed: 4294967296 })).toThrow('32-bit');
  });
  it('keeps binding tags stable across ordering, distinguishes supplemental anchors and obeys the tag grammar', () => {
    const a = { bindingId: 'character-example-a', role: 'character-neutral' };
    const b = { bindingId: 'character-example-b', role: 'character-neutral' };
    const tags = runwayReferenceTags([a, b, a]);
    expect(tags[0].tag).toBe(runwayReferenceTags([b, a])[1].tag);
    expect(new Set(tags.map((r) => r.tag)).size).toBe(3);
    for (const { tag } of tags) expect(tag).toMatch(/^[a-z][a-z0-9_]{2,15}$/i);
  });
});

it('enforces Bria seed bounds and keeps third-party canvas and prompt limits model-specific', () => {
  expect(() => buildRunwayImageRequest({ modelId: 'bria_fibo_1_5', prompt: 'A garden', seed: 2147483648 })).toThrow('2147483647');
  expect(buildRunwayImageRequest({ modelId: 'gpt_image_2', prompt: 'x'.repeat(20000), seed: 42, resolution: '3840:2160' }).body).toEqual({ model: 'gpt_image_2', promptText: 'x'.repeat(20000), ratio: '3840:2160' });
  expect(() => buildRunwayImageRequest({ modelId: 'gemini_image3_pro', prompt: 'x' })).toThrow('prompt');
  expect(() => buildRunwayImageRequest({ modelId: 'bria_fibo_edit_1_5', prompt: 'A garden' })).toThrow('1–4');
});

it('preserves requested portrait and landscape framing when the model uses automatic canvas selection', () => {
  expect(buildRunwayImageRequest({ modelId: 'gpt_image_2', prompt: 'A coast', width: 1920, height: 1080 }).body.ratio).toBe('2560:1440');
  expect(buildRunwayImageRequest({ modelId: 'muse_image', prompt: 'A coast', width: 720, height: 1280 }).body.ratio).toBe('1152:2016');
});

it('preserves FIBO Edit source framing with one reference and permits a canvas with two', () => {
  expect(buildRunwayImageRequest({ modelId: 'bria_fibo_edit_1_5', prompt: 'Make it blue', referenceImages: [ref] }).body).not.toHaveProperty('ratio');
  expect(() => buildRunwayImageRequest({ modelId: 'bria_fibo_edit_1_5', prompt: 'Make it blue', referenceImages: [ref], resolution: '1024:1024' })).toThrow('at least two references');
});
