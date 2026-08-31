import { describe, expect, it } from 'vitest';
import {
  buildVisualStyleClause,
  dropTokensPresentIn,
  mergeNegativePromptTokens,
  universeAestheticLine,
  universeVisualStyleTokens,
} from './universeVisualStyle.js';

const universe = {
  influences: { embrace: ['ligne claire', 'flat matte color fields'], avoid: ['photoreal', 'gore'] },
  // Writing-stage direction: names canon that is nowhere near a given shot.
  styleNotes: 'Stage Aruun as a massive but local physical presence. Keep the tone PG-13.',
};

describe('universeVisualStyle', () => {
  it('keeps the free-text styleNotes out of an image prompt', () => {
    const clause = buildVisualStyleClause(universe);
    expect(clause).toBe('ligne claire, flat matte color fields');
    expect(clause).not.toContain('Aruun');
    expect(universeAestheticLine(universe)).toBe('Universe aesthetic: ligne claire, flat matte color fields');
  });

  it('returns empty for a universe with no curated tokens so callers keep their fallback line', () => {
    expect(buildVisualStyleClause({ styleNotes: 'painted realism' })).toBe('');
    expect(universeAestheticLine(null)).toBe('');
    expect(universeVisualStyleTokens(null)).toEqual({ embrace: [], avoid: [] });
  });

  it('composes a series override by mode', () => {
    const override = { override: 'washed sepia' };
    expect(buildVisualStyleClause(universe, override))
      .toBe('washed sepia. ligne claire, flat matte color fields');
    expect(buildVisualStyleClause(universe, { ...override, mode: 'append' }))
      .toBe('ligne claire, flat matte color fields. washed sepia');
    expect(buildVisualStyleClause(universe, { ...override, mode: 'override' })).toBe('washed sepia');
  });

  it('drops style tokens the authored prompt already carries', () => {
    const authored = 'Ligne Claire, flat matte color fields. Tala kneels in silver grass.';
    expect(dropTokensPresentIn(universeVisualStyleTokens(universe).embrace, authored)).toEqual([]);
    expect(dropTokensPresentIn(['ligne claire', 'screenprint grain'], authored)).toEqual(['screenprint grain']);
    expect(dropTokensPresentIn(['ligne claire'], '')).toEqual(['ligne claire']);
  });

  it('unions negatives at token level so a joined authored negative does not repeat the list', () => {
    expect(mergeNegativePromptTokens([
      'photoreal, gore, blurry',
      ['photoreal', 'gore'],
      ['wrong face'],
    ])).toEqual(['photoreal', 'gore', 'blurry', 'wrong face']);
  });
});
