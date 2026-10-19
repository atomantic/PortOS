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

  it('Veo 3.1: enum duration, native negative prompt, audio off, ratio from the picked resolution, first+last frames', () => {
    expect(build('veo3.1_fast', { seconds: 5, resolution: '1080P', negativePrompt: 'blur', endImageUri: END, width: 1920, height: 1080 }).body).toEqual({
      model: 'veo3.1_fast',
      promptImage: [{ uri: FRAME, position: 'first' }, { uri: END, position: 'last' }],
      promptText: 'a lighthouse at dusk', negativePrompt: 'blur', duration: 6, ratio: '1920:1080', audio: false,
    });
  });

  it('Kling 3.0: optional ratio sent only for a start-frame render with a target shape', () => {
    expect(build('kling3.0_standard', { width: 1280, height: 720 }).body).toMatchObject({ ratio: '1280:720', audio: false, duration: 5 });
    expect(build('kling3.0_standard', {}).body).not.toHaveProperty('ratio');
    expect(build('kling3.0_standard', { width: 1280, height: 720, endImageUri: END }).body).not.toHaveProperty('ratio');
  });

  it('MiniMax H3 / WAN 3.0: size sent as a resolution or an auto ratio, priced per resolution', () => {
    const h3 = build('h3_max', { seconds: 2, resolution: '480p' });
    expect(h3.body).toEqual({ model: 'h3_max', promptImage: FRAME, promptText: 'a lighthouse at dusk', duration: 5, resolution: '480p' });
    expect(h3.estimatedCostUsd).toBe(0.25);
    expect(build('wan3', { seconds: 12, endImageUri: END }).body).toMatchObject({ ratio: 'auto_720p', duration: 12, audio: false });
    // Kling 2.5 has no size field and no audio field at all.
    expect(build('kling2.5_turbo_pro', { width: 1280, height: 720 }).body).toEqual({
      model: 'kling2.5_turbo_pro', promptImage: FRAME, promptText: 'a lighthouse at dusk', duration: 5,
    });
  });
});

describe('buildRunwayVideoRequest — refusals before anything is paid for', () => {
  it.each([
    ['an uncurated model', { modelId: 'gen9' }, /not a Runway model/],
    ['a missing start frame', { imageUri: null }, /start frame/],
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
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('veo3.1'), 6.01)).toBe(8);
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('veo3.1'), 20)).toBe(8);
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('gen4_turbo'), 1)).toBe(2);
    expect(coerceRunwayVideoSeconds(getRunwayVideoModel('gen4_turbo'), null)).toBe(5);
  });

  it('quotes every curated model and describes its rate', () => {
    for (const model of RUNWAY_VIDEO_MODELS) {
      expect(runwayVideoClipQuote({ modelId: model.id, seconds: 4 })?.costUsd).toBeGreaterThan(0);
      expect(describeRunwayVideoRate(model.id)).toMatch(/^\$[\d.]+\/s/);
    }
    expect(runwayVideoClipQuote({ modelId: 'wan3', seconds: 4, resolution: '1080p' })).toMatchObject({ billedSec: 4, perSec: 0.2, costUsd: 0.8 });
    expect(runwayVideoClipQuote({ modelId: 'unknown' })).toBeNull();
  });
});
