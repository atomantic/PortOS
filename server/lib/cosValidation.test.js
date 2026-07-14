import { describe, it, expect } from 'vitest';
import { createCosTaskSchema, updateCosTaskSchema, createCosJobSchema, updateCosJobSchema } from './cosValidation.js';
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

describe('cosValidation autonomous-job effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosJobSchema.safeParse({ name: 'j', effort }).success).toBe(true);
    }
    expect(createCosJobSchema.safeParse({ name: 'j', effort: 'bogus' }).success).toBe(false);
  });

  it("mirrors providerId's clearable-null semantics: ''/null → null, absent → undefined", () => {
    // A job effort pin is clearable through a PUT the same way providerId is —
    // '' from the UI picker and an explicit null both persist as null so
    // updateJob (which skips only `undefined`) resets the pin to the provider
    // default; an omitted key stays undefined and preserves the existing value.
    expect(createCosJobSchema.parse({ name: 'j', effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: 'max' }).effort).toBe('max');
    expect(updateCosJobSchema.parse({}).effort).toBeUndefined();
    expect(updateCosJobSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});
