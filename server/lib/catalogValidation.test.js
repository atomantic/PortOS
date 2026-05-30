/**
 * Zod boundary tests for the Creative Ingredients Catalog validators.
 * Pure — no DB, no LLM.
 *
 * The catalog routes lean entirely on these schemas as the contract between
 * client/peer input and the DB layer. A regression that loosens (or breaks)
 * one of these gates would land an unbounded blob in Postgres. Boundary tests
 * are cheap and exercise the exact failure modes the schema was written for.
 */

import { describe, it, expect } from 'vitest';
import {
  INGREDIENT_TYPES,
  REF_KINDS,
  catalogScrapCreateSchema,
  catalogIngredientCreateSchema,
  catalogIngredientPatchSchema,
  catalogIngredientQuerySchema,
  catalogIngredientLinkSchema,
  catalogScrapCommitSchema,
  catalogSyncEnvelopeSchema,
} from './catalogValidation.js';

describe('catalogValidation — ingredient types & ref kinds', () => {
  it('exposes the six v1 ingredient types as a frozen list', () => {
    expect(INGREDIENT_TYPES).toEqual(['character', 'place', 'object', 'idea', 'scene', 'concept']);
    expect(Object.isFrozen(INGREDIENT_TYPES)).toBe(true);
  });

  it('exposes the documented ref kinds (universe/series/issue/work/creative-director)', () => {
    expect(REF_KINDS).toEqual(['universe', 'series', 'issue', 'work', 'creative-director']);
    expect(Object.isFrozen(REF_KINDS)).toBe(true);
  });
});

describe('catalogValidation — catalogScrapCreateSchema', () => {
  it('accepts a minimal paste body', () => {
    const out = catalogScrapCreateSchema.parse({ rawText: 'hello world' });
    expect(out.rawText).toBe('hello world');
  });

  it('rejects empty rawText', () => {
    expect(() => catalogScrapCreateSchema.parse({ rawText: '' })).toThrow();
  });

  it('rejects rawText over 2MB', () => {
    const huge = 'a'.repeat(2_000_001);
    expect(() => catalogScrapCreateSchema.parse({ rawText: huge })).toThrow();
  });

  it('accepts known sourceKinds', () => {
    for (const k of ['paste', 'brain-bridge', 'importer-handoff', 'manual']) {
      expect(() => catalogScrapCreateSchema.parse({ rawText: 'x', sourceKind: k })).not.toThrow();
    }
  });

  it('rejects unknown sourceKinds (strict enum)', () => {
    expect(() => catalogScrapCreateSchema.parse({ rawText: 'x', sourceKind: 'firehose' })).toThrow();
  });

  it('rejects extra keys (strict)', () => {
    expect(() => catalogScrapCreateSchema.parse({ rawText: 'x', sneaky: true })).toThrow();
  });
});

describe('catalogValidation — catalogIngredientCreateSchema', () => {
  it('accepts every v1 type', () => {
    for (const t of INGREDIENT_TYPES) {
      const out = catalogIngredientCreateSchema.parse({ type: t, name: 'X' });
      expect(out.type).toBe(t);
    }
  });

  it('rejects an unknown type (gates the 7th-type addition)', () => {
    expect(() => catalogIngredientCreateSchema.parse({ type: 'faction', name: 'X' })).toThrow();
  });

  it('trims + requires name', () => {
    expect(() => catalogIngredientCreateSchema.parse({ type: 'idea', name: '   ' })).toThrow();
    const out = catalogIngredientCreateSchema.parse({ type: 'idea', name: '  Hello  ' });
    expect(out.name).toBe('Hello');
  });

  it('caps payload at 200KB stringified', () => {
    const big = { blob: 'x'.repeat(210_000) };
    expect(() => catalogIngredientCreateSchema.parse({ type: 'idea', name: 'X', payload: big })).toThrow();
  });

  it('accepts a payload near the cap', () => {
    const ok = { blob: 'x'.repeat(190_000) };
    expect(() => catalogIngredientCreateSchema.parse({ type: 'idea', name: 'X', payload: ok })).not.toThrow();
  });
});

describe('catalogValidation — catalogIngredientPatchSchema', () => {
  it('accepts a tag-only patch', () => {
    const out = catalogIngredientPatchSchema.parse({ tags: ['noir'] });
    expect(out.tags).toEqual(['noir']);
  });

  it('rejects extra keys', () => {
    expect(() => catalogIngredientPatchSchema.parse({ name: 'X', extra: 1 })).toThrow();
  });
});

describe('catalogValidation — catalogIngredientQuerySchema', () => {
  it('coerces numeric limit/offset', () => {
    const out = catalogIngredientQuerySchema.parse({ limit: '50', offset: '0' });
    expect(out.limit).toBe(50);
    expect(out.offset).toBe(0);
  });

  it('caps limit at 200', () => {
    expect(() => catalogIngredientQuerySchema.parse({ limit: '500' })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => catalogIngredientQuerySchema.parse({ offset: '-1' })).toThrow();
  });
});

describe('catalogValidation — catalogIngredientLinkSchema', () => {
  it('accepts every ref kind', () => {
    for (const k of REF_KINDS) {
      expect(() =>
        catalogIngredientLinkSchema.parse({ refKind: k, refId: 'r1', role: 'canon-character' }),
      ).not.toThrow();
    }
  });

  it('rejects unknown ref kind', () => {
    expect(() =>
      catalogIngredientLinkSchema.parse({ refKind: 'galaxy', refId: 'r1', role: 'canon' }),
    ).toThrow();
  });

  it('caps refId at 120 chars', () => {
    expect(() =>
      catalogIngredientLinkSchema.parse({ refKind: 'universe', refId: 'a'.repeat(200), role: 'canon-character' }),
    ).toThrow();
  });
});

describe('catalogValidation — catalogScrapCommitSchema', () => {
  it('accepts an empty accepted list (user rejected every draft)', () => {
    const out = catalogScrapCommitSchema.parse({ accepted: [] });
    expect(out.accepted).toEqual([]);
  });

  it('rejects more than 200 accepted drafts', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ type: 'idea', name: `n${i}` }));
    expect(() => catalogScrapCommitSchema.parse({ accepted: many })).toThrow();
  });
});

describe('catalogValidation — catalogSyncEnvelopeSchema', () => {
  const isoNow = '2026-05-29T00:00:00.000Z';

  it('accepts a minimal scraps-only envelope', () => {
    const env = {
      scraps: [{ id: 'cat-scrap-1', rawText: 'hi', createdAt: isoNow, updatedAt: isoNow }],
    };
    expect(() => catalogSyncEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('accepts an ingredients envelope with v2 tombstone fields', () => {
    const env = {
      ingredients: [
        {
          id: 'cat-chr-1',
          type: 'character',
          name: 'X',
          createdAt: isoNow,
          updatedAt: isoNow,
          deleted: true,
          deletedAt: isoNow,
        },
      ],
    };
    expect(() => catalogSyncEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('accepts a v1 ref envelope without tombstone fields (mixed-version peer)', () => {
    const env = {
      refs: [
        {
          ingredientId: 'cat-chr-1',
          refKind: 'universe',
          refId: 'u1',
          role: 'canon-character',
          createdAt: isoNow,
        },
      ],
    };
    expect(() => catalogSyncEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('rejects an envelope whose ingredient payload exceeds 200KB', () => {
    const env = {
      ingredients: [
        {
          id: 'cat-chr-1',
          type: 'character',
          name: 'X',
          payload: { blob: 'x'.repeat(210_000) },
          createdAt: isoNow,
          updatedAt: isoNow,
        },
      ],
    };
    expect(() => catalogSyncEnvelopeSchema.parse(env)).toThrow();
  });

  it('caps each kind array length so a malicious peer can\'t push millions of rows', () => {
    const env = {
      ingredients: Array.from({ length: 5_001 }, (_, i) => ({
        id: `cat-chr-${i}`,
        type: 'character',
        name: 'X',
        createdAt: isoNow,
        updatedAt: isoNow,
      })),
    };
    expect(() => catalogSyncEnvelopeSchema.parse(env)).toThrow();
  });

  it('accepts portosMeta.schemaVersions.catalog for the version gate', () => {
    const env = {
      portosMeta: { portosVersion: '2.10.0', schemaVersions: { catalog: 3 } },
    };
    const out = catalogSyncEnvelopeSchema.parse(env);
    expect(out.portosMeta.schemaVersions.catalog).toBe(3);
  });

  it('caps portosMeta at 4KB so the escape hatch can\'t carry junk', () => {
    const env = {
      portosMeta: { junk: 'x'.repeat(5000) },
    };
    expect(() => catalogSyncEnvelopeSchema.parse(env)).toThrow();
  });
});
