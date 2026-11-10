import { describe, expect, it } from 'vitest';
import { buildHiggsfieldImageRequest } from './higgsfieldImageModels.js';

describe('buildHiggsfieldImageRequest', () => {
  it('sends rewrite knobs off and maps size to the nearest ratio and tier', () => {
    const out = buildHiggsfieldImageRequest({ prompt: 'a', negativePrompt: 'b', width: 1024, height: 1536, seed: 7 });
    expect(out.endpointId).toBe('higgsfield-ai/soul/v2/standard');
    expect(out.body).toEqual({ prompt: 'a\nAvoid: b', enhance_prompt: false, seed: 7, aspect_ratio: '2:3', resolution: '720p' });
  });

  it('routes references to the edit endpoint and keeps a native negative prompt separate', () => {
    const out = buildHiggsfieldImageRequest({ modelId: 'alibaba/qwen-image-3/text-to-image', prompt: 'a', negativePrompt: 'b', imageUrls: ['u1', 'u2'] });
    expect(out.endpointId).toBe('alibaba/qwen-image-3/edit');
    expect(out.body).toEqual({ prompt: 'a', prompt_extend: false, enable_thinking: false, image_urls: ['u1', 'u2'], negative_prompt: 'b' });
    expect(buildHiggsfieldImageRequest({ modelId: 'ideogram/v4.0', prompt: 'ab', imageUrls: ['u1'] }).body.image_url).toBe('u1');
  });

  it('refuses too many references and out-of-range prompts', () => {
    expect(() => buildHiggsfieldImageRequest({ prompt: 'a', imageUrls: ['u'] })).toThrow(/text-to-image only/);
    expect(() => buildHiggsfieldImageRequest({ modelId: 'alibaba/qwen-image-3/edit', prompt: 'a', imageUrls: ['1', '2', '3', '4'] })).toThrow(/at most 3/);
    expect(() => buildHiggsfieldImageRequest({ modelId: 'z-image/turbo', prompt: 'x'.repeat(801) })).toThrow(/Nothing was submitted or truncated/);
    expect(() => buildHiggsfieldImageRequest({ modelId: 'unknown', prompt: 'a' })).toThrow(/Unknown Higgsfield image model/);
  });
});
