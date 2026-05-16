import { describe, it, expect } from 'vitest';
import { composeCleanPlatePrompt, CLEAN_PLATE_PREFIX, CLEAN_PLATE_NEGATIVE } from './cleanPlatePrompt.js';

describe('composeCleanPlatePrompt', () => {
  it('returns the prefix + negative even for an empty setting', () => {
    const out = composeCleanPlatePrompt({});
    expect(out.prompt).toContain(CLEAN_PLATE_PREFIX);
    expect(out.negativePrompt).toContain('people');
  });

  it('handles a fully-populated setting', () => {
    const out = composeCleanPlatePrompt({
      name: 'The Foundry',
      slugline: 'INT. BAR — NIGHT',
      description: 'cramped chrome bar with broken neon',
      palette: 'amber, sodium yellow',
      recurringDetails: 'broken jukebox in the corner',
      intExt: 'INT',
      timeOfDay: 'night',
    });
    expect(out.prompt).toContain(CLEAN_PLATE_PREFIX);
    expect(out.prompt).toContain('interior, night');
    expect(out.prompt).toContain('cramped chrome bar');
    expect(out.prompt).toContain('Palette: amber, sodium yellow');
    expect(out.prompt).toContain('broken jukebox');
  });

  it('omits the metadata parenthetical when both intExt + timeOfDay are null', () => {
    const out = composeCleanPlatePrompt({
      description: 'a generic place',
      intExt: null,
      timeOfDay: null,
    });
    expect(out.prompt).not.toContain('(');
    expect(out.prompt).toContain('a generic place');
  });

  it('emits only the present half when one of intExt / timeOfDay is set', () => {
    const intOnly = composeCleanPlatePrompt({ description: 'x', intExt: 'EXT' });
    expect(intOnly.prompt).toContain('(exterior)');
    expect(intOnly.prompt).not.toContain('(exterior,');
    const todOnly = composeCleanPlatePrompt({ description: 'x', timeOfDay: 'dawn' });
    expect(todOnly.prompt).toContain('(dawn)');
    expect(todOnly.prompt).not.toContain('interior');
    expect(todOnly.prompt).not.toContain('exterior');
  });

  it('appends the clean-plate negatives after the user negatives', () => {
    const out = composeCleanPlatePrompt({ description: 'x' }, 'blurry, low quality');
    expect(out.negativePrompt).toBe(`blurry, low quality, ${CLEAN_PLATE_NEGATIVE}`);
  });

  it('handles malformed input without throwing', () => {
    expect(composeCleanPlatePrompt(null).prompt).toBe(CLEAN_PLATE_PREFIX);
    expect(composeCleanPlatePrompt('not an object').prompt).toBe(CLEAN_PLATE_PREFIX);
  });
});
