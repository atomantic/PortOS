import { describe, expect, it } from 'vitest';
import { buildHiggsfieldVideoRequest, higgsfieldVideoLengths, getHiggsfieldVideoModel, higgsfieldCapabilityHint, higgsfieldShotRequestFields } from './higgsfieldVideoModels.js';

describe('buildHiggsfieldVideoRequest', () => {
  it('routes by the inputs present: text, start frame, or references', () => {
    const text = buildHiggsfieldVideoRequest({ modelId: 'bytedance/seedance-2.5', prompt: 'a', width: 1920, height: 1080 });
    expect(text.endpointId).toBe('bytedance/seedance-2.5/text-to-video');
    expect(text.body).toEqual({ duration: 5, prompt: 'a', resolution: '720p', aspect_ratio: '16:9', generate_audio: false });

    const image = buildHiggsfieldVideoRequest({ modelId: 'kling-video/v3.0/pro', prompt: 'a', imageUrl: 'u1', endImageUrl: 'u2', generateAudio: true, seconds: 40 });
    expect(image.endpointId).toBe('kling-video/v3.0/pro/image-to-video');
    expect(image.body).toEqual({ duration: 15, prompt: 'a', image_url: 'u1', last_image_url: 'u2', sound: 'on' });

    const refs = buildHiggsfieldVideoRequest({ modelId: 'alibaba/wan-3.0', prompt: 'a', referenceImageUrls: ['r1', 'r2'], aspectRatio: '9:16', seed: '42' });
    expect(refs.endpointId).toBe('alibaba/wan-3.0/reference-to-video');
    expect(refs.body).toMatchObject({ enable_thinking: false, image_urls: ['r1', 'r2'], aspect_ratio: '9:16', seed: 42, resolution: '1080p' });
  });

  it('folds a negative prompt in as a visible Avoid clause', () => {
    expect(buildHiggsfieldVideoRequest({ prompt: 'walk', negativePrompt: 'blur' }).body.prompt).toBe('walk\nAvoid: blur');
  });

  it('refuses input combinations and over-limit prompts instead of dropping or truncating', () => {
    expect(() => buildHiggsfieldVideoRequest({ modelId: 'nope', prompt: 'a' })).toThrow(/not a Higgsfield video model/);
    expect(() => buildHiggsfieldVideoRequest({ prompt: 'a', imageUrl: 'u', referenceImageUrls: ['r'] })).toThrow(/not both/);
    expect(() => buildHiggsfieldVideoRequest({ prompt: 'a', imageUrl: 'u', audioUrls: ['song.wav'] })).toThrow(/cannot combine anchored/);
    expect(() => buildHiggsfieldVideoRequest({ prompt: 'a', imageUrl: 'u', endImageUrl: 'end', audioUrls: ['song.wav'] })).toThrow(/cannot combine anchored/);
    expect(() => buildHiggsfieldVideoRequest({ modelId: 'kling-video/v3.0/std', prompt: 'a', referenceImageUrls: ['r'] })).toThrow(/no reference images/);
    expect(() => buildHiggsfieldVideoRequest({ prompt: 'a', endImageUrl: 'u' })).toThrow(/needs a start frame/);
    expect(() => buildHiggsfieldVideoRequest({ prompt: '' })).toThrow(/Prompt is required/);
    expect(() => buildHiggsfieldVideoRequest({ modelId: 'kling-video/v3.0/pro', prompt: 'x'.repeat(2501) })).toThrow(/2501\/2500/);
    expect(buildHiggsfieldVideoRequest({ prompt: '', imageUrl: 'u' }).route).toBe('image');
  });

  it('sends Seedance reference audio and user words unchanged, and refuses other families', () => {
    const prompt = '  dance\nwith the beat  ';
    const request = buildHiggsfieldVideoRequest({ prompt, audioUrls: ['song.wav'], referenceImageUrls: ['cast.png'] });
    expect(request.endpointId).toBe('bytedance/seedance-2.5/reference-to-video');
    expect(request.body).toMatchObject({ prompt, audio_urls: ['song.wav'], image_urls: ['cast.png'] });
    expect(() => buildHiggsfieldVideoRequest({ modelId: 'alibaba/wan-3.0', prompt, audioUrls: ['song.wav'] })).toThrow(/at most 0 audio references/);
  });

  it('lists every whole-second length a family accepts', () => {
    expect(higgsfieldVideoLengths(getHiggsfieldVideoModel('kling-video/v3.0/pro'))).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

it('covers short shots with the family minimum duration', () => {
  expect(higgsfieldShotRequestFields({}, 2).higgsfieldDuration).toBe(4);
  expect(higgsfieldShotRequestFields({}, 9.2).higgsfieldDuration).toBe(10);
  expect(() => higgsfieldShotRequestFields({}, 31)).toThrow(/at most 30 seconds/);
  expect(() => buildHiggsfieldVideoRequest({ prompt: '  \n ' })).toThrow(/Prompt is required/);
  expect(() => buildHiggsfieldVideoRequest({ prompt: '', negativePrompt: '   ' })).toThrow(/Prompt is required/);
});

describe('higgsfieldCapabilityHint', () => {
  it('tells the picker which families take references, end frames and audio', () => {
    expect(higgsfieldCapabilityHint(getHiggsfieldVideoModel('bytedance/seedance-2.5'))).toBe('refs ≤30 · end frame · audio refs');
    expect(higgsfieldCapabilityHint(getHiggsfieldVideoModel('kling-video/v3.0/pro'))).toBe('no refs · end frame');
    expect(higgsfieldCapabilityHint(getHiggsfieldVideoModel('alibaba/wan-3.0'))).toBe('refs ≤10 · end frame');
  });
});

describe('Kling 4 wire bodies', () => {
  const build = (modelId, extra) => buildHiggsfieldVideoRequest({ modelId, prompt: 'a', ...extra });

  it('matches the published Kling 4.0 schemas on every route', () => {
    expect(build('kling-video/v4.0', { width: 1920, height: 1080 }).body).toEqual({ duration: 5, prompt: 'a', resolution: '1080p', aspect_ratio: '16:9' });
    const image = build('kling-video/v4.0', { imageUrl: 'u1', endImageUrl: 'u2', seconds: 99 });
    expect(image.endpointId).toBe('kling-video/v4.0/image-to-video');
    expect(image.body).toEqual({ duration: 30, prompt: 'a', resolution: '1080p', image_url: 'u1', end_image_url: 'u2' });
    const refs = build('kling-video/v4.0', { referenceImageUrls: ['r1'], aspectRatio: 'adaptive' });
    expect(refs.endpointId).toBe('kling-video/v4.0/reference-to-video');
    expect(refs.body).toEqual({ duration: 5, prompt: 'a', resolution: '1080p', aspect_ratio: 'adaptive', image_urls: ['r1'] });
  });

  it('sends Flash only the fields its strict schema allows, and never picks adaptive by shape', () => {
    const image = build('kling-video/v4.0-flash', { imageUrl: 'u1', seconds: 99, generateAudio: true });
    expect(image.body).toEqual({ duration: 20, prompt: 'a', resolution: '720p', image_url: 'u1' });
    expect(() => build('kling-video/v4.0-flash', { imageUrl: 'u1', endImageUrl: 'u2' })).toThrow(/no end frame/);
    expect(build('kling-video/v4.0-flash', { referenceImageUrls: ['r1'], width: 1000, height: 1000 }).body.aspect_ratio).toBe('1:1');
  });
});
