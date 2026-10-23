import { describe, it, expect } from 'vitest';
import {
  RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL,
  RUNWAY_VIDEO_MODELS,
  buildRunwayVideoRequest,
  coerceRunwayVideoSeconds,
  describeRunwayVideoRate,
  getRunwayVideoModel,
  runwayVideoClipQuote,
} from './runwayVideoModels.js';

// The catalog is the wire boundary for a paid API that validates every field
// per model: a wrong key or type is a 400 after the user pressed Render, and a
// wrong price is a bill the board never showed. These pin the bodies against
// Runway's API reference and the quotes against its pricing guide
// (RUNWAY_VIDEO_PRICING_VERIFIED_AT).

const FRAME = 'data:image/png;base64,AA==';
const END = 'data:image/jpeg;base64,BB==';
const build = (modelId, extra = {}) => buildRunwayVideoRequest({ modelId, prompt: 'a lighthouse at dusk', imageUri: FRAME, ...extra });

describe('buildRunwayVideoRequest — per-family wire bodies', () => {
  it('Gen-4.5 (the default): required ratio matched to the target shape, covering duration, prompt Avoid fold', () => {
    const { body, seconds, estimatedCostUsd } = buildRunwayVideoRequest({
      prompt: 'a lighthouse at dusk', negativePrompt: 'text', imageUri: FRAME, seconds: 3.2, width: 1080, height: 1920, seed: 7,
    });
    expect(body).toEqual({
      model: RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, promptImage: FRAME, promptText: 'a lighthouse at dusk\nAvoid: text',
      duration: 4, ratio: '720:1280', seed: 7,
    });
    expect(seconds).toBe(4);
    expect(estimatedCostUsd).toBe(0.48);
  });

  it('Kling 3.0 Pro: first+last frames, audio off, no ratio on a keyframe render', () => {
    expect(build('kling3.0_pro', { seconds: 5, negativePrompt: 'blur', endImageUri: END, width: 1920, height: 1080 }).body).toEqual({
      model: 'kling3.0_pro',
      promptImage: [{ uri: FRAME, position: 'first' }, { uri: END, position: 'last' }],
      promptText: 'a lighthouse at dusk\nAvoid: blur', duration: 5, audio: false,
    });
  });

  it('Kling 3.0: optional ratio sent only for a start-frame render with a target shape', () => {
    expect(build('kling3.0_standard', { width: 1280, height: 720 }).body).toMatchObject({ ratio: '1280:720', audio: false, duration: 5 });
    expect(build('kling3.0_standard', {}).body).not.toHaveProperty('ratio');
    expect(build('kling3.0_standard', { width: 1280, height: 720, endImageUri: END }).body).not.toHaveProperty('ratio');
  });

  it('MiniMax H3 / WAN 3.0: size sent as a resolution or an auto ratio, priced per resolution', () => {
    const h3 = build('h3_max', { seconds: 2, resolution: '480P' });
    expect(h3.body).toEqual({ model: 'h3_max', promptImage: FRAME, promptText: 'a lighthouse at dusk', duration: 5, resolution: '480p' });
    expect(h3.estimatedCostUsd).toBe(0.25);
    expect(build('wan3', { seconds: 12, endImageUri: END }).body).toMatchObject({ ratio: 'auto_720p', duration: 12, audio: false });
    // Kling 2.5 has no size field and no audio field at all.
    expect(build('kling2.5_turbo_pro', { width: 1280, height: 720 }).body).toEqual({
      model: 'kling2.5_turbo_pro', promptImage: FRAME, promptText: 'a lighthouse at dusk', duration: 5,
    });
  });
});

describe('buildRunwayVideoRequest — text-to-video', () => {
  it('Gen-4.5 with no start frame: /v1/text_to_video body, ratio matched to the shape, priced, Avoid folded in', () => {
    const portrait = buildRunwayVideoRequest({
      prompt: 'a lighthouse at dusk', negativePrompt: 'text', seconds: 3.2, width: 1080, height: 1920, seed: 7,
    });
    expect(portrait.endpoint).toBe('text_to_video');
    expect(portrait.body).toEqual({
      model: 'gen4.5', promptText: 'a lighthouse at dusk\nAvoid: text', duration: 4, ratio: '720:1280', seed: 7,
    });
    expect(portrait.estimatedCostUsd).toBe(0.48);
    // No target shape: Runway's documented landscape canvas.
    expect(buildRunwayVideoRequest({ prompt: 'a fox' }).body.ratio).toBe('1280:720');
    expect(build('gen4.5').endpoint).toBe('image_to_video');
  });

  it('refuses an over-cap text prompt with its count and never shortens it', () => {
    expect(() => buildRunwayVideoRequest({ prompt: 'x'.repeat(1001) })).toThrow(/1,001 characters/);
  });
});

describe('buildRunwayVideoRequest — refusals before anything is paid for', () => {
  it.each([
    ['an uncurated model', { modelId: 'gen9' }, /not a Runway model/],
    ['a missing start frame on an image-only model', { modelId: 'gen4_turbo', imageUri: null }, /start frame/],
    ['an end frame without a start frame', { imageUri: null, endImageUri: END }, /end frame needs a start frame/],
    ['an end frame on a start-frame-only model', { modelId: 'gen4.5', endImageUri: END }, /takes no end frame/],
    ['a missing required prompt', { modelId: 'gen4.5', prompt: '  ' }, /needs a prompt/],
  ])('refuses %s', (_label, extra, message) => {
    expect(() => build(extra.modelId || 'gen4.5', extra)).toThrow(message);
  });

  it('refuses an over-cap prompt with its count, counting the Avoid fold, and never shortens it', () => {
    const prompt = 'x'.repeat(995);
    expect(() => build('gen4.5', { prompt })).not.toThrow();
    let err;
    try { build('gen4.5', { prompt, negativePrompt: 'blurry' }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'RUNWAY_MODEL_INPUT', message: expect.stringMatching(/1,009 characters with its "Avoid:" clause; Runway Gen-4.5 takes 1,000/) });
  });
});

describe('Runway pricing and lengths', () => {
  it('rounds a shot up to the shortest length that covers it, capped at the longest', () => {
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('kling2.5_turbo_pro'), 5.01)).toBe(10);
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('kling2.5_turbo_pro'), 20)).toBe(10);
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('veo3.1'), 5)).toBe(6);
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('gen4_turbo'), 1)).toBe(2);
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('gen4_turbo'), null)).toBe(5);
  });

  it('keeps unknown prices explicit and preserves verified model quotes', () => {
    for (const model of RUNWAY_VIDEO_MODELS) {
      if (model.pricing.perSecond == null) {
        expect(runwayVideoClipQuote({ modelId: model.id, seconds: 4 })).toBeNull();
        expect(describeRunwayVideoRate(model.id)).toBeNull();
        continue;
      }
      expect(runwayVideoClipQuote({ modelId: model.id, seconds: 4 })?.costUsd).toBeGreaterThan(0);
      expect(describeRunwayVideoRate(model.id)).toMatch(/^\$[\d.]+\/s/);
    }
    expect(runwayVideoClipQuote({ modelId: 'wan3', seconds: 4, resolution: '1080p' })).toMatchObject({ billedSec: 4, perSec: 0.2, costUsd: 0.8 });
    expect(runwayVideoClipQuote({ modelId: 'unknown' })).toBeNull();
  });
});

describe('Additional Runway families', () => {
  it('uses native Veo exclusions, endpoint-specific WAN sizes and resolution plus ratio for Hailuo', () => {
    expect(buildRunwayVideoRequest({ modelId: 'veo3.1', prompt: 'A coast', negativePrompt: 'text', seconds: 5, resolution: '1080p' }).body).toEqual({ model: 'veo3.1', promptText: 'A coast', negativePrompt: 'text', duration: 6, ratio: '1920:1080', audio: false });
    expect(build('wan3_prime', { resolution: '1080p' }).body).toMatchObject({ ratio: 'auto_1080p', audio: false });
    expect(buildRunwayVideoRequest({ modelId: 'wan3_prime', prompt: 'A coast', resolution: '1080p' }).body).toMatchObject({ ratio: '1920:1080' });
    expect(buildRunwayVideoRequest({ modelId: 'hailuo3', prompt: 'A coast', resolution: '2k', aspectRatio: '9:16' }).body).toEqual({ model: 'hailuo3', promptText: 'A coast', duration: 5, resolution: '2k', ratio: '9:16' });
    expect(buildRunwayVideoRequest({ modelId: 'h3_max', prompt: 'A coast' }).body).not.toHaveProperty('ratio');
    expect(() => build('kling3.0_pro', { prompt: 'x' })).toThrow('at least 2');
  });
});
