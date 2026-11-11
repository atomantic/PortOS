import { describe, expect, it } from 'vitest';
import { buildHiggsfieldVideoRequest, higgsfieldVideoLengths, getHiggsfieldVideoModel, higgsfieldShotRequestFields } from './higgsfieldVideoModels.js';

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
