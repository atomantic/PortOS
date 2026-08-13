/**
 * Unit tests for the BATCHED export-slice hydration (#3940).
 *
 * `exportSliceForRef` used to issue three queries per ingredient (scraps, refs,
 * media) — 3N round-trips for an N-ingredient universe. It now issues four
 * queries total, regardless of N. Postgres is mocked: the fake `query` routes on
 * the SQL text, so the suite asserts BOTH the query count and that the payload
 * shape / ordering is byte-identical to the per-ingredient version.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
// Flipped by the empty-slice test so the mocked ref lookup returns no rows
// while still recording its call (mockResolvedValueOnce would bypass the
// recorder and make the "how many queries ran" assertion meaningless).
const sliceIsEmpty = { value: false };

const ingredientRow = (id, name, role) => ({
  id,
  type: 'character',
  name,
  payload: {},
  tags: [],
  embedding: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  role,
  ref_created_at: new Date('2026-01-01T00:00:00Z'),
});

const scrapRow = (ingredientId, id, createdAt) => ({
  ingredient_id: ingredientId,
  id,
  title: `Scrap ${id}`,
  raw_text: `raw ${id}`,
  source_kind: 'paste',
  metadata: null,
  created_at: new Date(createdAt),
  updated_at: new Date(createdAt),
});

const refRow = (ingredientId, refId) => ({
  ingredient_id: ingredientId,
  ref_kind: 'universe',
  ref_id: refId,
  role: 'cast',
  created_at: new Date('2026-01-01T00:00:00Z'),
  deleted: false,
  deleted_at: null,
  sync_sequence: 1,
});

const mediaRow = (ingredientId, mediaKey, kind) => ({
  ingredient_id: ingredientId,
  media_key: mediaKey,
  kind,
  role: null,
  caption: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  deleted: false,
  deleted_at: null,
  sync_sequence: 1,
});

// Two ingredients: i1 has 2 scraps / 1 ref / 2 media, i2 has none of any.
const INGREDIENT_ROWS = [ingredientRow('i1', 'Alpha', 'cast'), ingredientRow('i2', 'Beta', 'mentioned')];
const SCRAP_ROWS = [
  scrapRow('i1', 's-old', '2026-01-01T00:00:00Z'),
  scrapRow('i1', 's-new', '2026-02-01T00:00:00Z'),
];
const REF_ROWS = [refRow('i1', 'uni-1')];
const MEDIA_ROWS = [mediaRow('i1', 'portrait.png', 'portrait'), mediaRow('i1', 'ref.png', 'reference')];

vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    if (flat.includes('FROM catalog_ingredients i')) return { rows: sliceIsEmpty.value ? [] : INGREDIENT_ROWS };
    if (flat.includes('FROM catalog_scraps s')) return { rows: SCRAP_ROWS };
    if (flat.includes('FROM catalog_ingredient_refs')) return { rows: REF_ROWS };
    if (flat.includes('FROM catalog_ingredient_media')) return { rows: MEDIA_ROWS };
    return { rows: [] };
  }),
  withTransaction: vi.fn(),
  pgvectorToArray: vi.fn(() => null),
  arrayToPgvector: vi.fn(),
}));

// instances.getInstanceId is pulled in transitively by catalogDB — stub it.
vi.mock('./instances.js', () => ({ getInstanceId: vi.fn(async () => 'inst-1') }));

const catalogDB = await import('./catalogDB.js');

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('exportSliceForRef batching (#3940)', () => {
  it('issues exactly four queries regardless of ingredient count', async () => {
    await catalogDB.exportSliceForRef('universe', 'uni-1');
    expect(calls).toHaveLength(4);
    // Three of them are the batched ANY($1) hydration queries.
    const batched = calls.filter((c) => c.sql.includes('= ANY($1)'));
    expect(batched).toHaveLength(3);
    for (const c of batched) expect(c.params[0]).toEqual(['i1', 'i2']);
  });

  it('groups the batched rows back onto their ingredients', async () => {
    const bundle = await catalogDB.exportSliceForRef('universe', 'uni-1');
    expect(bundle.ref).toEqual({ kind: 'universe', id: 'uni-1' });
    const [alpha, beta] = bundle.ingredients;
    expect(alpha.id).toBe('i1');
    expect(alpha.roleForExportedRef).toBe('cast');
    expect(alpha.scraps.map((s) => s.id)).toEqual(['s-old', 's-new']); // per-ingredient order kept
    expect(alpha.refs).toEqual([expect.objectContaining({ refId: 'uni-1', role: 'cast' })]);
    expect(alpha.media.map((m) => m.mediaKey)).toEqual(['portrait.png', 'ref.png']);
    // An ingredient with no rows in any batch gets empty arrays, not undefined.
    expect(beta.id).toBe('i2');
    expect(beta.roleForExportedRef).toBe('mentioned');
    expect(beta.scraps).toEqual([]);
    expect(beta.refs).toEqual([]);
    expect(beta.media).toEqual([]);
  });

  it('strips embeddings from the exported ingredients', async () => {
    const bundle = await catalogDB.exportSliceForRef('universe', 'uni-1');
    for (const ing of bundle.ingredients) expect(ing).not.toHaveProperty('embedding');
  });

  it('skips the hydration queries entirely for an empty slice', async () => {
    sliceIsEmpty.value = true;
    const bundle = await catalogDB.exportSliceForRef('universe', 'empty');
    sliceIsEmpty.value = false;
    expect(bundle.ingredients).toEqual([]);
    expect(calls).toHaveLength(1); // just listIngredientsForRef
  });
});

describe('batched list helpers', () => {
  it('listScrapsForIngredients keys every requested id, empty when it has none', async () => {
    const byId = await catalogDB.listScrapsForIngredients(['i1', 'i2']);
    expect([...byId.keys()]).toEqual(['i1', 'i2']);
    expect(byId.get('i1').map((s) => s.rawText)).toEqual(['raw s-old', 'raw s-new']);
    expect(byId.get('i2')).toEqual([]);
  });

  it('de-dupes repeated ids and issues no query for an empty id list', async () => {
    const byId = await catalogDB.listMediaForIngredients(['i1', 'i1']);
    expect(calls[0].params[0]).toEqual(['i1']);
    expect(byId.get('i1')).toHaveLength(2);
    calls.length = 0;
    expect(await catalogDB.listRefsForIngredients([])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });

  it('the singular helpers still return a plain array', async () => {
    expect(await catalogDB.listRefsForIngredient('i1')).toEqual([
      expect.objectContaining({ ingredientId: 'i1', refId: 'uni-1' }),
    ]);
    expect(await catalogDB.listScrapsForIngredient('i2')).toEqual([]);
  });
});
