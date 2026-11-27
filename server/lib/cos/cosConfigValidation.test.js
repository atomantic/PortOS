import { describe, it, expect } from 'vitest';
import { cosConfigSchema } from './cosConfigValidation.js';
import { AVATAR_STYLE_IDS } from '../avatarStyles.js';

describe('cosConfigSchema avatarStyle', () => {
  it('accepts every style in the shared registry, so a style added there is never a settings 400', () => {
    for (const id of AVATAR_STYLE_IDS) {
      expect(cosConfigSchema.safeParse({ avatarStyle: id }).success, `avatarStyle "${id}"`).toBe(true);
    }
  });

  it('accepts rigged record spellings', () => {
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-image3d-abc-123' }).success).toBe(true);
  });

  it('rejects unknown and traversal-shaped styles', () => {
    expect(cosConfigSchema.safeParse({ avatarStyle: 'not-a-style' }).success).toBe(false);
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-../secret' }).success).toBe(false);
    expect(cosConfigSchema.safeParse({ avatarStyle: 'rigged-' }).success).toBe(false);
  });
});
