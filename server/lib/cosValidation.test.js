import { describe, it, expect } from 'vitest';
import { createCosTaskSchema, updateCosTaskSchema } from './cosValidation.js';
import { EFFORT_LEVELS } from './providerModels.js';

describe('cosValidation effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosTaskSchema.safeParse({ description: 'x', effort }).success).toBe(true);
    }
    expect(createCosTaskSchema.safeParse({ description: 'x', effort: 'bogus' }).success).toBe(false);
  });

  it("create: '' (the form's Default option) parses to absent, not a stored empty pin", () => {
    const parsed = createCosTaskSchema.parse({ description: 'x', effort: '' });
    expect('effort' in parsed && parsed.effort !== undefined).toBe(false);
  });

  it("update: ''/null survive as null so the API can CLEAR a set effort pin", () => {
    // absent-vs-cleared (CLAUDE.md): the route gates on `!== undefined`, and the
    // store's legacy-field normalizer deletes a null pin — so the clear signal
    // must reach the route as null, not be preprocessed away to undefined.
    expect(updateCosTaskSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: 'high' }).effort).toBe('high');
    expect(updateCosTaskSchema.parse({}).effort).toBeUndefined();
    expect(updateCosTaskSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});
