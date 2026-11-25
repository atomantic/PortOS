import { describe, expect, it } from 'vitest';
import {
  CLOUD_IMAGE_GEN_MODES,
  CLOUD_VIDEO_GEN_MODES,
  GENERATION_MODE_LABELS,
  HOSTED_MEDIA_BACKENDS,
  IMAGE_GEN_MODE,
  IMAGE_GEN_MODES,
  METERED_IMAGE_GEN_MODES,
  QUEUEABLE_IMAGE_MODES,
  VIDEO_GEN_MODE,
  VIDEO_GEN_MODES,
} from './generationModes.js';

describe('generation mode alphabets', () => {
  it('derives immutable image mode lists from the shared discriminator', () => {
    expect(IMAGE_GEN_MODES).toEqual(['external', 'local', 'codex', 'grok', 'agy', 'fal', 'runway', 'higgsfield', 'google']);
    expect(CLOUD_IMAGE_GEN_MODES).toEqual(['codex', 'grok', 'agy', 'fal', 'runway', 'higgsfield', 'google']);
    expect(QUEUEABLE_IMAGE_MODES).toEqual(['local', 'codex', 'grok', 'agy', 'fal', 'runway', 'higgsfield', 'google']);
    expect([
      IMAGE_GEN_MODE,
      IMAGE_GEN_MODES,
      CLOUD_IMAGE_GEN_MODES,
      QUEUEABLE_IMAGE_MODES,
    ].every(Object.isFrozen)).toBe(true);
  });

  it('preserves the shared labels and metered image modes', () => {
    expect(Object.entries(GENERATION_MODE_LABELS)).toEqual([
      ['local', 'Local'], ['codex', 'Codex'], ['grok', 'Grok'], ['agy', 'Agy'],
      ['external', 'External'], ['fal', 'fal.ai'], ['reactor', 'Reactor.inc'],
      ['runway', 'Runway'], ['gemini', 'Gemini'], ['higgsfield', 'Higgsfield'], ['google', 'Google'],
    ]);
    expect(METERED_IMAGE_GEN_MODES).toEqual(['fal', 'runway', 'higgsfield', 'google']);
    expect([GENERATION_MODE_LABELS, HOSTED_MEDIA_BACKENDS, ...HOSTED_MEDIA_BACKENDS].every(Object.isFrozen)).toBe(true);
  });

  it('keeps the video backend alphabet in the image discriminator namespace, plus reactor as a video-only extra', () => {
    expect(VIDEO_GEN_MODE).toEqual({
      LOCAL: IMAGE_GEN_MODE.LOCAL, GROK: IMAGE_GEN_MODE.GROK, FAL: IMAGE_GEN_MODE.FAL, REACTOR: 'reactor', RUNWAY: 'runway',
      GEMINI: 'gemini', HIGGSFIELD: IMAGE_GEN_MODE.HIGGSFIELD, GOOGLE: IMAGE_GEN_MODE.GOOGLE,
    });
    expect(VIDEO_GEN_MODES).toEqual(['local', 'grok', 'fal', 'reactor', 'runway', 'gemini', 'higgsfield', 'google']);
    expect(CLOUD_VIDEO_GEN_MODES).toEqual(['grok', 'fal', 'reactor', 'runway', 'gemini', 'higgsfield', 'google']);
    expect([VIDEO_GEN_MODE, VIDEO_GEN_MODES, CLOUD_VIDEO_GEN_MODES].every(Object.isFrozen)).toBe(true);
  });
});
