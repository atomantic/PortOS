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
  catalogBulkImportSchema,
  catalogExportQuerySchema,
  catalogRelationLinkSchema,
  RELATION_KINDS,
  catalogMediaAttachSchema,
  catalogMediaDetachSchema,
  catalogPortraitSetSchema,
  MEDIA_KINDS,
  catalogUrlIngestSchema,
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

describe('catalogValidation — catalogBulkImportSchema', () => {
  it('accepts a minimal markdown payload', () => {
    const out = catalogBulkImportSchema.parse({ format: 'markdown', payload: '## Idea: X\nbody' });
    expect(out.format).toBe('markdown');
  });

  it('accepts json/csv/markdown as formats', () => {
    for (const f of ['json', 'csv', 'markdown']) {
      expect(() => catalogBulkImportSchema.parse({ format: f, payload: 'x' })).not.toThrow();
    }
  });

  it('rejects unknown formats', () => {
    expect(() => catalogBulkImportSchema.parse({ format: 'toml', payload: 'x' })).toThrow();
  });

  it('rejects empty payload', () => {
    expect(() => catalogBulkImportSchema.parse({ format: 'json', payload: '' })).toThrow();
  });

  it('caps payload at 2MB', () => {
    const huge = 'a'.repeat(2_000_001);
    expect(() => catalogBulkImportSchema.parse({ format: 'json', payload: huge })).toThrow();
  });

  it('accepts defaults block with universe/series/work refs and tags', () => {
    const out = catalogBulkImportSchema.parse({
      format: 'json',
      payload: '[]',
      defaults: { universeRef: 'u1', seriesRef: 's1', tags: ['noir'] },
    });
    expect(out.defaults.universeRef).toBe('u1');
    expect(out.defaults.tags).toEqual(['noir']);
  });

  it('rejects unknown keys in defaults (strict)', () => {
    expect(() => catalogBulkImportSchema.parse({
      format: 'json', payload: '[]', defaults: { universeRef: 'u1', mystery: true },
    })).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => catalogBulkImportSchema.parse({ format: 'json', payload: '[]', sneaky: true })).toThrow();
  });
});

describe('catalogValidation — catalogExportQuerySchema', () => {
  it('accepts every ref kind', () => {
    for (const k of REF_KINDS) {
      expect(() => catalogExportQuerySchema.parse({ refKind: k, refId: 'r1' })).not.toThrow();
    }
  });

  it('rejects unknown ref kind', () => {
    expect(() => catalogExportQuerySchema.parse({ refKind: 'galaxy', refId: 'r1' })).toThrow();
  });

  it('defaults to no format (route resolves to json)', () => {
    const out = catalogExportQuerySchema.parse({ refKind: 'universe', refId: 'u1' });
    expect(out.format).toBeUndefined();
  });

  it('accepts json/markdown/yaml format', () => {
    for (const f of ['json', 'markdown', 'yaml']) {
      expect(() => catalogExportQuerySchema.parse({ refKind: 'universe', refId: 'u1', format: f })).not.toThrow();
    }
  });

  it('rejects unknown format', () => {
    expect(() => catalogExportQuerySchema.parse({ refKind: 'universe', refId: 'u1', format: 'xml' })).toThrow();
  });

  it('caps refId at 120 chars', () => {
    expect(() => catalogExportQuerySchema.parse({ refKind: 'universe', refId: 'a'.repeat(200) })).toThrow();
  });
});

describe('catalogValidation — relation kinds & catalogRelationLinkSchema', () => {
  it('exposes the relation kinds as a frozen list including the documented set', () => {
    expect(Object.isFrozen(RELATION_KINDS)).toBe(true);
    for (const k of ['appears-in', 'lives-in', 'created-by', 'parent-of', 'variant-of', 'references']) {
      expect(RELATION_KINDS).toContain(k);
    }
  });

  it('accepts a valid relation link body', () => {
    const out = catalogRelationLinkSchema.parse({ toId: 'cat-chr-abc', kind: 'lives-in' });
    expect(out).toEqual({ toId: 'cat-chr-abc', kind: 'lives-in' });
  });

  it('accepts every registered relation kind', () => {
    for (const k of RELATION_KINDS) {
      expect(() => catalogRelationLinkSchema.parse({ toId: 'x', kind: k })).not.toThrow();
    }
  });

  it('rejects an unknown relation kind', () => {
    expect(() => catalogRelationLinkSchema.parse({ toId: 'x', kind: 'nemesis-of' })).toThrow();
  });

  it('rejects a missing or empty toId', () => {
    expect(() => catalogRelationLinkSchema.parse({ kind: 'lives-in' })).toThrow();
    expect(() => catalogRelationLinkSchema.parse({ toId: '', kind: 'lives-in' })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => catalogRelationLinkSchema.parse({ toId: 'x', kind: 'lives-in', fromId: 'y' })).toThrow();
  });

  it('caps toId at 80 chars', () => {
    expect(() => catalogRelationLinkSchema.parse({ toId: 'a'.repeat(81), kind: 'lives-in' })).toThrow();
  });
});

describe('catalogValidation — catalogSyncEnvelopeSchema relations block', () => {
  it('accepts an envelope carrying a relations array with tombstone fields', () => {
    const out = catalogSyncEnvelopeSchema.parse({
      relations: [
        { fromId: 'a', toId: 'b', kind: 'lives-in', createdAt: '2026-01-01T00:00:00Z' },
        { fromId: 'a', toId: 'c', kind: 'references', createdAt: '2026-01-01T00:00:00Z', deleted: true, deletedAt: '2026-01-02T00:00:00Z' },
      ],
    });
    expect(out.relations).toHaveLength(2);
  });

  it('tolerates a forward (unknown) relation kind on the wire', () => {
    // The sync schema intentionally accepts freeform `kind` (not the enum) so a
    // newer peer's extra relation kind doesn't get the whole envelope rejected.
    expect(() => catalogSyncEnvelopeSchema.parse({
      relations: [{ fromId: 'a', toId: 'b', kind: 'future-kind', createdAt: '2026-01-01T00:00:00Z' }],
    })).not.toThrow();
  });

  it('requires createdAt on a relation row', () => {
    expect(() => catalogSyncEnvelopeSchema.parse({
      relations: [{ fromId: 'a', toId: 'b', kind: 'lives-in' }],
    })).toThrow();
  });
});

describe('catalogValidation — media kinds & catalogMediaAttachSchema', () => {
  it('exposes the media kinds as a frozen list including the documented set', () => {
    expect(Object.isFrozen(MEDIA_KINDS)).toBe(true);
    for (const k of ['portrait', 'reference', 'audio', 'video', 'document']) {
      expect(MEDIA_KINDS).toContain(k);
    }
  });

  it('accepts a valid media attach body with optional role/caption', () => {
    const out = catalogMediaAttachSchema.parse({ mediaKey: 'hero.png', kind: 'portrait', role: 'hero-shot', caption: 'angry' });
    expect(out).toEqual({ mediaKey: 'hero.png', kind: 'portrait', role: 'hero-shot', caption: 'angry' });
  });

  it('accepts an attach body without role/caption', () => {
    expect(() => catalogMediaAttachSchema.parse({ mediaKey: 'a.png', kind: 'reference' })).not.toThrow();
  });

  it('accepts every registered media kind', () => {
    for (const k of MEDIA_KINDS) {
      expect(() => catalogMediaAttachSchema.parse({ mediaKey: 'x.png', kind: k })).not.toThrow();
    }
  });

  it('rejects an unknown media kind', () => {
    expect(() => catalogMediaAttachSchema.parse({ mediaKey: 'x.png', kind: 'hologram' })).toThrow();
  });

  it('rejects a missing or empty mediaKey', () => {
    expect(() => catalogMediaAttachSchema.parse({ kind: 'portrait' })).toThrow();
    expect(() => catalogMediaAttachSchema.parse({ mediaKey: '', kind: 'portrait' })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => catalogMediaAttachSchema.parse({ mediaKey: 'x.png', kind: 'portrait', bytes: 'nope' })).toThrow();
  });

  it('portrait-set body omits kind; detach body requires kind', () => {
    expect(() => catalogPortraitSetSchema.parse({ mediaKey: 'x.png' })).not.toThrow();
    expect(() => catalogPortraitSetSchema.parse({ mediaKey: 'x.png', kind: 'portrait' })).toThrow(); // strict: no kind
    expect(() => catalogMediaDetachSchema.parse({ mediaKey: 'x.png', kind: 'portrait' })).not.toThrow();
    expect(() => catalogMediaDetachSchema.parse({ mediaKey: 'x.png' })).toThrow();
  });
});

describe('catalogValidation — catalogSyncEnvelopeSchema media block', () => {
  it('accepts an envelope carrying a media array with tombstone + metadata fields', () => {
    const out = catalogSyncEnvelopeSchema.parse({
      media: [
        { ingredientId: 'i1', mediaKey: 'a.png', kind: 'portrait', createdAt: '2026-01-01T00:00:00Z' },
        { ingredientId: 'i1', mediaKey: 'b.png', kind: 'reference', role: 'mood', caption: 'rainy', createdAt: '2026-01-01T00:00:00Z', deleted: true, deletedAt: '2026-01-02T00:00:00Z' },
      ],
    });
    expect(out.media).toHaveLength(2);
  });

  it('tolerates a forward (unknown) media kind on the wire', () => {
    expect(() => catalogSyncEnvelopeSchema.parse({
      media: [{ ingredientId: 'i1', mediaKey: 'a.png', kind: 'future-kind', createdAt: '2026-01-01T00:00:00Z' }],
    })).not.toThrow();
  });

  it('requires ingredientId + mediaKey + createdAt on a media row', () => {
    expect(() => catalogSyncEnvelopeSchema.parse({
      media: [{ kind: 'portrait', createdAt: '2026-01-01T00:00:00Z' }],
    })).toThrow();
  });
});

describe('catalogUrlIngestSchema — SSRF guard', () => {
  it('accepts a normal http(s) URL (incl. a LAN/Tailscale host — intentional)', () => {
    expect(catalogUrlIngestSchema.parse({ url: 'https://example.com/post' }).url).toBe('https://example.com/post');
    // Private/LAN hosts are allowed by design (ingest from a home wiki / peer).
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://192.168.1.50/wiki' })).not.toThrow();
  });

  it('rejects file:// and other non-http(s) schemes (local-file exfiltration)', () => {
    expect(() => catalogUrlIngestSchema.parse({ url: 'file:///etc/passwd' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'ftp://host/x' })).toThrow();
  });

  it('rejects loopback and link-local / cloud-metadata hosts (SSRF)', () => {
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://169.254.169.254/latest/meta-data/' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://localhost:5555/api/secrets' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://127.0.0.1/x' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://metadata.google.internal/x' })).toThrow();
  });

  it('rejects IPv4-mapped IPv6 loopback/link-local + unspecified literals (no bypass)', () => {
    // WHATWG normalizes [::ffff:127.0.0.1] → [::ffff:7f00:1]; both must reject.
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://[::ffff:127.0.0.1]/x' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://[::ffff:169.254.169.254]/x' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://[::]/x' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://0.0.0.0/x' })).toThrow();
  });

  it('rejects native IPv6 link-local (fe80::/10) literals', () => {
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://[fe80::1]/x' })).toThrow();
    expect(() => catalogUrlIngestSchema.parse({ url: 'http://[febf::dead]/x' })).toThrow();
  });
});
