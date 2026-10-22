import { describe, it, expect } from 'vitest';
import { RUNWAY_IMAGE_MODELS, buildRunwayImageRequest, runwayReferenceTags } from './runwayImageModels.js';

const ref = { uri: 'https://example.com/anchor.png', tag: 'char1' };
describe('Runway image wire contracts', () => {
  // Catches unsupported model fields and resolution/price drift without paid requests.
  it.each(RUNWAY_IMAGE_MODELS)('$id emits only the image API fields and prices each canvas', (model) => {
    for (const [resolution, ratios] of Object.entries(model.ratios)) {
      for (const ratio of ratios) {
        const request = buildRunwayImageRequest({ modelId: model.id, prompt: '  @char1 in a garden  ', resolution, ratio, seed: 42, referenceImages: [ref] });
        expect(request.body).toEqual({ model: model.id, promptText: '  @char1 in a garden  ', ratio, seed: 42, referenceImages: [ref] });
        expect(request.estimatedCredits).toBe(model.credits[resolution]);
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
