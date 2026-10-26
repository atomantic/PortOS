import { describe, expect, it } from 'vitest';
import { naturalUniverseVisualProfile, visualProfileLook } from '../../lib/universeVisualProfile.js';
import { universeVisualProfileSchema } from '../../lib/universeVisualProfileValidation.js';
import { applyImageVisualProfile } from './visualProfile.js';

describe('universe photography submission', () => {
  it('records exact additions and a stable recipe revision without altering authored text or repeating composition', () => {
    const profile = naturalUniverseVisualProfile();
    const authored = 'A portrait.\nKeep my exact words.';
    const result = applyImageVisualProfile({ prompt: authored }, profile);
    expect(result.prompt.startsWith(authored + '\n\n')).toBe(true);
    expect(result.promptAdditions.map(a => a.id)).toContain('universe-photography-lighting');
    expect(result.negativePrompt).toBe(profile.generation.avoid);
    expect(result.visualProfileRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(applyImageVisualProfile(result, profile)).toEqual(result);
    const next = structuredClone(profile);
    next.finishing.textureAmount = 0;
    expect(applyImageVisualProfile({ prompt: authored }, next).visualProfileRevision).not.toBe(result.visualProfileRevision);
    expect(visualProfileLook(next)).toMatchObject({ grain: 0, halation: 0, shoulder: 0.5 });
    expect(applyImageVisualProfile({ prompt: authored }, null)).toEqual({ prompt: authored });
    expect(universeVisualProfileSchema.safeParse(profile).success).toBe(true);
    expect(universeVisualProfileSchema.safeParse({ ...profile, generation: { enabled: true, lighting: 'bad\0text' } }).success).toBe(false);
  });
});
