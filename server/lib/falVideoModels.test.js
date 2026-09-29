import { describe, it, expect } from 'vitest';
import {
  FAL_LIPSYNC_VIDEO_MODEL,
  FAL_VIDEO_MODELS,
  buildFalVideoRequest,
  coerceFalVideoSeconds,
  estimateFalVideoCostUsd,
  getFalVideoModel,
} from './falVideoModels.js';

// The catalog is a serialization boundary with a real per-family matrix: each
// fal family spells duration, resolution, image and audio differently, and a
// wrong type is either a 422 or — worse — a silently ignored key on a billed
// render. These pin the wire bodies against fal's OpenAPI schemas and the
// estimates against fal's published prices (FAL_VIDEO_PRICING_VERIFIED_AT).

const build = (modelId, extra = {}) => buildFalVideoRequest({ modelId, prompt: 'a lighthouse at dusk', imageUrl: 'data:image/png;base64,AA==', ...extra });

describe('buildFalVideoRequest — per-family wire bodies', () => {
  it('Hailuo-02: string enum duration covering the request, resolution enum, no aspect_ratio or audio key', () => {
    const { body, seconds } = build('fal-ai/minimax/hailuo-02/standard/image-to-video', { seconds: 7.5, width: 1920, height: 1080, negativePrompt: 'blur' });
    expect(seconds).toBe(10);
    expect(body).toEqual({
      prompt: 'a lighthouse at dusk\nAvoid: blur', image_url: 'data:image/png;base64,AA==', duration: '10', resolution: '768P',
    });
  });

  it('MiniMax H3: integer duration clamped to 5–15, case-insensitive resolution, the required prompt_expansion_mode', () => {
    expect(build('minimax/h3-max/image-to-video', { seconds: 3, resolution: '1080p' }).body).toEqual({
      prompt: 'a lighthouse at dusk', image_url: 'data:image/png;base64,AA==', duration: 5, resolution: '1080P', prompt_expansion_mode: 'balanced',
    });
    expect(build('minimax/h3-max-turbo/image-to-video', { seconds: 40 }).body.duration).toBe(15);
  });

  it('Kling v3 Pro: start_image_url, string duration, native negative prompt, provider audio off unless asked', () => {
    expect(build('fal-ai/kling-video/v3/pro/image-to-video', { seconds: 4.2, negativePrompt: 'text overlay' }).body).toEqual({
      prompt: 'a lighthouse at dusk', negative_prompt: 'text overlay', start_image_url: 'data:image/png;base64,AA==',
      duration: '5', generate_audio: false,
    });
    expect(build('fal-ai/kling-video/v3/pro/image-to-video', { generateAudio: true }).body.generate_audio).toBe(true);
  });

  it('Veo 3.1 Fast: "Ns" duration enum and the nearest of its two aspect ratios', () => {
    expect(build('fal-ai/veo3.1/fast/image-to-video', { seconds: 5, width: 1080, height: 1920 }).body).toMatchObject({
      duration: '6s', aspect_ratio: '9:16', resolution: '720p', generate_audio: false,
    });
  });

  it('Seedance 2.5: always an explicit length (never "auto"), no aspect for image-to-video, 21:9 for text-to-video', () => {
    const i2v = build('bytedance/seedance-2.5/image-to-video');
    expect(i2v.body).toEqual({
      prompt: 'a lighthouse at dusk', image_url: 'data:image/png;base64,AA==', duration: '5', resolution: '720p', generate_audio: false,
    });
    const t2v = buildFalVideoRequest({ modelId: 'bytedance/seedance-2.5/text-to-video', prompt: 'x', seconds: 12, aspectRatio: '21:9' });
    expect(t2v.body).toMatchObject({ duration: '12', aspect_ratio: '21:9' });
  });

  it('reference-to-video: the start frame becomes the first reference, audio references ride their own list', () => {
    const { body } = build('bytedance/seedance-2.5/reference-to-video', {
      referenceImageUrls: ['https://example.com/b.png'], referenceAudioUrls: ['https://example.com/a.wav'],
    });
    expect(body.image_urls).toEqual(['data:image/png;base64,AA==', 'https://example.com/b.png']);
    expect(body.audio_urls).toEqual(['https://example.com/a.wav']);
    expect(body).not.toHaveProperty('image_url');
    expect(build('minimax/h3-max/reference-to-video', { width: 1080, height: 1350 }).body).toMatchObject({
      reference_image_urls: ['data:image/png;base64,AA=='], aspect_ratio: '3:4', duration: 5,
    });
  });

  it('lip-sync: frame + audio + resolution only — no prompt field even when one is supplied', () => {
    const req = buildFalVideoRequest({
      modelId: FAL_LIPSYNC_VIDEO_MODEL, prompt: 'singer', imageUrl: 'i', audioUrl: 'a', audioSec: 12, resolution: '2k', enableTranscription: true,
    });
    expect(req.body).toEqual({ image_url: 'i', audio_url: 'a', enable_transcription: true, resolution: '2K' });
    expect(req.seconds).toBeNull();
    expect(req.estimatedCostUsd).toBe(3.84);
  });

  it('refuses a request the model cannot honor before anything is paid for; an uncurated id is not built', () => {
    const refused = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };
    expect(refused(() => buildFalVideoRequest({ modelId: 'fal-ai/kling-video/v3/pro/image-to-video', prompt: 'x' }))).toBe('FAL_MODEL_INPUT');
    expect(refused(() => buildFalVideoRequest({ modelId: 'fal-ai/minimax/hailuo-02/standard/text-to-video', prompt: 'x', imageUrl: 'i' }))).toBe('FAL_MODEL_INPUT');
    expect(refused(() => buildFalVideoRequest({ modelId: FAL_LIPSYNC_VIDEO_MODEL, imageUrl: 'i' }))).toBe('FAL_MODEL_INPUT');
    expect(refused(() => build('fal-ai/veo3.1/fast/image-to-video', { prompt: '' }))).toBe('FAL_MODEL_INPUT');
    expect(buildFalVideoRequest({ modelId: 'example/uncurated-model', prompt: 'x' })).toBeNull();
  });
});

describe('estimateFalVideoCostUsd — list prices per family', () => {
  it('prices each family from its published rate, billing the coerced length', () => {
    // Hailuo-02: $0.045/s at 768P — a 7s request renders (and bills) 10s.
    expect(estimateFalVideoCostUsd({ modelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video', seconds: 7 })).toBe(0.45);
    expect(estimateFalVideoCostUsd({ modelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video', seconds: 6, resolution: '512P' })).toBe(0.102);
    // H3 Max at list price (not the launch promo), H3 Turbo half that.
    expect(estimateFalVideoCostUsd({ modelId: 'minimax/h3-max/image-to-video', seconds: 6, resolution: '1080P' })).toBe(0.96);
    expect(estimateFalVideoCostUsd({ modelId: 'minimax/h3-max-turbo/image-to-video', seconds: 5, resolution: '480P' })).toBe(0.125);
    // Kling / Veo: audio-off vs audio-on rates.
    expect(estimateFalVideoCostUsd({ modelId: 'fal-ai/kling-video/v3/pro/image-to-video', seconds: 5 })).toBe(0.56);
    expect(estimateFalVideoCostUsd({ modelId: 'fal-ai/kling-video/v3/pro/image-to-video', seconds: 5, generateAudio: true })).toBe(0.84);
    expect(estimateFalVideoCostUsd({ modelId: 'fal-ai/veo3.1/fast/image-to-video', seconds: 8, resolution: '4k', generateAudio: true })).toBe(2.8);
  });

  it('Seedance bills video tokens: the 16:9 per-second figure, scaled up (never down) for a wider canvas', () => {
    expect(estimateFalVideoCostUsd({ modelId: 'bytedance/seedance-2.5/image-to-video', seconds: 5, resolution: '720p' })).toBe(2.365);
    expect(estimateFalVideoCostUsd({ modelId: 'bytedance/seedance-2.5/text-to-video', seconds: 4, resolution: '480p', width: 1080, height: 1080 })).toBe(0.882);
    expect(estimateFalVideoCostUsd({ modelId: 'bytedance/seedance-2.5/text-to-video', seconds: 4, resolution: '1080p', width: 2520, height: 1080 })).toBeCloseTo(4 * 1.164 * (21 / 9) / (16 / 9), 3);
  });

  it('lip-sync bills its audio length (at least the 5s minimum), ×1.2 past 15s', () => {
    expect(estimateFalVideoCostUsd({ modelId: FAL_LIPSYNC_VIDEO_MODEL, seconds: 5.05, resolution: '1080P' })).toBe(0.808);
    expect(estimateFalVideoCostUsd({ modelId: FAL_LIPSYNC_VIDEO_MODEL, seconds: 3, resolution: '768P' })).toBe(0.4);
    expect(estimateFalVideoCostUsd({ modelId: FAL_LIPSYNC_VIDEO_MODEL, seconds: 20, resolution: '768P' })).toBe(1.92);
  });

  it('reports unknown (null) rather than guessing: uncurated model, lip-sync with no audio length', () => {
    expect(estimateFalVideoCostUsd({ modelId: 'example/uncurated-model', seconds: 6 })).toBeNull();
    expect(estimateFalVideoCostUsd({ modelId: FAL_LIPSYNC_VIDEO_MODEL })).toBeNull();
  });

  it('every curated model prices its default request', () => {
    for (const model of FAL_VIDEO_MODELS) {
      const seconds = model.duration.kind === 'audio' ? 10 : coerceFalVideoSeconds(model, null);
      expect(estimateFalVideoCostUsd({ modelId: model.id, seconds }), model.id).toBeGreaterThan(0);
      expect(getFalVideoModel(model.id)).toBe(model);
    }
  });
});
