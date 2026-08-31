import { describe, expect, it } from 'vitest';
import {
  buildVisualStyleClause,
  mergeNegativePromptTokens,
  stripStyleClause,
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

  it('strips the style clause the browser already prefixed, leaving the scene', () => {
    const authored = 'Ligne Claire, flat matte color fields. Tala kneels in silver grass.';
    expect(stripStyleClause(authored, 'ligne claire, flat matte color fields'))
      .toBe('Tala kneels in silver grass.');
  });

  it('leaves a prompt that never carried the clause untouched', () => {
    expect(stripStyleClause('A cautious arrival', 'ligne claire')).toBe('A cautious arrival');
    expect(stripStyleClause('A cautious arrival', '')).toBe('A cautious arrival');
    // Only a LEADING copy is the browser's duplicate; style words occurring in
    // the scene sentence itself are the author's and must survive.
    expect(stripStyleClause('Dusk in flat matte color fields', 'flat matte color fields'))
      .toBe('Dusk in flat matte color fields');
  });

  it('matches a token carrying its own punctuation instead of emitting it twice', () => {
    // A per-token split on '.' would never match `M.C. Escher`, so the compiler
    // would prepend the whole clause again on top of the browser's copy.
    const clause = 'ligne claire, M.C. Escher';
    expect(stripStyleClause(`${clause}. Stairs fold back on themselves.`, clause))
      .toBe('Stairs fold back on themselves.');
  });

  it('unions negatives at token level so a joined authored negative does not repeat the list', () => {
    expect(mergeNegativePromptTokens([
      'photoreal, gore, blurry',
      ['photoreal', 'gore'],
      ['wrong face'],
    ])).toEqual(['photoreal', 'gore', 'blurry', 'wrong face']);
  });
});
