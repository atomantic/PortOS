/**
 * Zod boundary tests for the Story Builder validators.
 *
 * Focused on the #1761 additive `catalogIngredientIds` field on
 * storySessionCreateSchema — the schema is `.strict()`, so the field MUST be
 * declared for the create route to accept it. These also pin the
 * back-compat guarantee: a create body that omits it still parses.
 */

import { describe, it, expect } from 'vitest';
import { storySessionCreateSchema } from './storyBuilderValidation.js';

describe('storyBuilderValidation — storySessionCreateSchema.catalogIngredientIds', () => {
  it('accepts a create body carrying catalogIngredientIds', () => {
    const out = storySessionCreateSchema.parse({
      title: 'Salt Run',
      catalogIngredientIds: ['cat-character-1', 'cat-place-2'],
    });
    expect(out.catalogIngredientIds).toEqual(['cat-character-1', 'cat-place-2']);
  });

  it('omits the field cleanly when absent (back-compat)', () => {
    const out = storySessionCreateSchema.parse({ title: 'No Ingredients' });
    expect(out.catalogIngredientIds).toBeUndefined();
  });

  it('accepts an empty array', () => {
    const out = storySessionCreateSchema.parse({ title: 'X', catalogIngredientIds: [] });
    expect(out.catalogIngredientIds).toEqual([]);
  });

  it('trims each id', () => {
    const out = storySessionCreateSchema.parse({
      title: 'X',
      catalogIngredientIds: ['  cat-1  '],
    });
    expect(out.catalogIngredientIds).toEqual(['cat-1']);
  });

  it('rejects an oversized array (>50)', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `cat-${i}`);
    expect(() => storySessionCreateSchema.parse({ title: 'X', catalogIngredientIds: ids })).toThrow();
  });

  it('rejects an id longer than 64 chars', () => {
    expect(() => storySessionCreateSchema.parse({
      title: 'X',
      catalogIngredientIds: ['x'.repeat(65)],
    })).toThrow();
  });

  it('rejects a non-array catalogIngredientIds', () => {
    expect(() => storySessionCreateSchema.parse({
      title: 'X',
      catalogIngredientIds: 'cat-1',
    })).toThrow();
  });
});
