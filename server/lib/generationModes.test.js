import { describe, expect, it } from 'vitest';
import {
  CLOUD_IMAGE_GEN_MODES,
  CLOUD_VIDEO_GEN_MODES,
  IMAGE_GEN_MODE,
  IMAGE_GEN_MODES,
  QUEUEABLE_IMAGE_MODES,
  VIDEO_GEN_MODE,
  VIDEO_GEN_MODES,
} from './generationModes.js';

describe('generation mode alphabets', () => {
  it('derives immutable image mode lists from the shared discriminator', () => {
    expect(IMAGE_GEN_MODES).toEqual(['external', 'local', 'codex', 'grok', 'agy']);
    expect(CLOUD_IMAGE_GEN_MODES).toEqual(['codex', 'grok', 'agy']);
    expect(QUEUEABLE_IMAGE_MODES).toEqual(['local', 'codex', 'grok', 'agy']);
    expect([
      IMAGE_GEN_MODE,
      IMAGE_GEN_MODES,
      CLOUD_IMAGE_GEN_MODES,
      QUEUEABLE_IMAGE_MODES,
    ].every(Object.isFrozen)).toBe(true);
  });

  it('keeps the video backend alphabet in the image discriminator namespace', () => {
    expect(VIDEO_GEN_MODE).toEqual({ LOCAL: IMAGE_GEN_MODE.LOCAL, GROK: IMAGE_GEN_MODE.GROK });
    expect(VIDEO_GEN_MODES).toEqual(['local', 'grok']);
    expect(CLOUD_VIDEO_GEN_MODES).toEqual(['grok']);
    expect([VIDEO_GEN_MODE, VIDEO_GEN_MODES, CLOUD_VIDEO_GEN_MODES].every(Object.isFrozen)).toBe(true);
  });
});
