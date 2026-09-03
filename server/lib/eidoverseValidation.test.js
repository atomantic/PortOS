import { describe, it, expect } from 'vitest';
import {
  EIDOVERSE_AUGMENT_VERBS,
  EIDOVERSE_PROJECTION_SOURCE_KEYS,
  eidoverseProjectionRecipeSchema,
  eidoverseWorldAugmentSchema,
  eidoverseWorldConfigPatchSchema,
  eidoverseWorldSaySchema,
} from './eidoverseValidation.js';
import { EIDOVERSE_WORLD_DESIGN_V2 } from './eidoverseWorldDesign.js';

describe('eidoverseProjectionRecipeSchema', () => {
  it('accepts the shipped V2 world design unchanged', () => {
    expect(eidoverseProjectionRecipeSchema.parse(EIDOVERSE_WORLD_DESIGN_V2))
      .toEqual(EIDOVERSE_WORLD_DESIGN_V2);
  });

  it('rejects a district source key outside the projection allowlist', () => {
    const recipe = structuredClone(EIDOVERSE_WORLD_DESIGN_V2);
    recipe.districts[0].sources = ['definitely-not-a-source'];

    expect(EIDOVERSE_PROJECTION_SOURCE_KEYS).not.toContain('definitely-not-a-source');
    expect(eidoverseProjectionRecipeSchema.safeParse(recipe).success).toBe(false);
  });

  it('rejects a resolved asset path that escapes the library root', () => {
    const recipe = structuredClone(EIDOVERSE_WORLD_DESIGN_V2);
    recipe.assets = { ...recipe.assets, nexus: 'eidoverse/assets/../../etc/passwd' };

    expect(eidoverseProjectionRecipeSchema.safeParse(recipe).success).toBe(false);
  });
});

describe('eidoverseWorldAugmentSchema', () => {
  it('accepts a bounded operation bag', () => {
    const parsed = eidoverseWorldAugmentSchema.parse({
      operations: [{ verb: 'spawn', args: { id: 'example-entity' } }],
    });

    expect(parsed.operations).toHaveLength(1);
    expect(EIDOVERSE_AUGMENT_VERBS).toContain('spawn');
  });

  it('rejects an argument bag over the 8KB cap', () => {
    const result = eidoverseWorldAugmentSchema.safeParse({
      operations: [{ verb: 'spawn', args: { blob: 'x'.repeat(8193) } }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a verb outside the augment vocabulary', () => {
    expect(eidoverseWorldAugmentSchema.safeParse({
      operations: [{ verb: 'detonate', args: {} }],
    }).success).toBe(false);
  });
});

describe('eidoverseWorldConfigPatchSchema', () => {
  it('accepts a partial patch and rejects an unknown key', () => {
    expect(eidoverseWorldConfigPatchSchema.parse({ cosEnabled: false }))
      .toEqual({ cosEnabled: false });
    expect(eidoverseWorldConfigPatchSchema.safeParse({ notAField: 1 }).success).toBe(false);
  });

  it('rejects an avatar path that escapes the asset root', () => {
    expect(eidoverseWorldConfigPatchSchema.safeParse({
      cosAvatar: 'eidoverse/../../secrets/avatar.glb',
    }).success).toBe(false);
  });
});

describe('eidoverseWorldSaySchema', () => {
  it('trims text and rejects an empty or over-long line', () => {
    expect(eidoverseWorldSaySchema.parse({ text: '  hello  ' })).toEqual({ text: 'hello' });
    expect(eidoverseWorldSaySchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(eidoverseWorldSaySchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false);
  });
});
