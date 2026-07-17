/**
 * buildAvatarPrompt — human-centered Character avatar fallback (#2752).
 *
 * The Character surface (#2677) reframed name/class around the real human user,
 * so a fresh install has a blank identity. Clicking "Generate avatar" before
 * filling in a name must NOT fall back to the old D&D adventurer/warrior prompt.
 * These assert the neutral human-portrait default and the photographic (not
 * fantasy) framing when identity fields are present.
 */

import { describe, it, expect } from 'vitest';
import { buildAvatarPrompt } from './index.js';

describe('buildAvatarPrompt', () => {
  it('uses a neutral human portrait for a fully blank identity', () => {
    const prompt = buildAvatarPrompt({ name: '', characterClass: '' });
    expect(prompt).toBe('portrait of a person, photographic, natural lighting, detailed, high quality');
  });

  it('never emits the old D&D adventurer/warrior fallback for a blank identity', () => {
    for (const args of [{}, { name: '', characterClass: '' }, { name: '   ', characterClass: '   ' }, { name: undefined, characterClass: undefined }]) {
      const prompt = buildAvatarPrompt(args).toLowerCase();
      expect(prompt).not.toContain('adventurer');
      expect(prompt).not.toContain('warrior');
      expect(prompt).not.toContain('d&d');
      expect(prompt).not.toContain('fantasy');
      expect(prompt).toContain('portrait of a person');
    }
  });

  it('shapes a photographic portrait from provided identity fields', () => {
    const prompt = buildAvatarPrompt({ name: 'Alice Example', characterClass: 'Engineer' });
    expect(prompt).toBe('portrait of Alice Example, Engineer, photographic, natural lighting, detailed, high quality');
    expect(prompt).not.toContain('fantasy');
    expect(prompt).not.toContain('D&D');
  });

  it('trims and omits blank identity fields individually', () => {
    expect(buildAvatarPrompt({ name: '  Bob  ', characterClass: '' }))
      .toBe('portrait of Bob, photographic, natural lighting, detailed, high quality');
    expect(buildAvatarPrompt({ name: '', characterClass: 'Teacher' }))
      .toBe('portrait of Teacher, photographic, natural lighting, detailed, high quality');
  });
});
