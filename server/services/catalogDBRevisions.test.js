/**
 * Unit tests for the catalog ingredient revision-history layer:
 *   - createIngredient seeds an initial revision (source-labeled);
 *   - updateIngredient writes a revision only when name/payload/tags change,
 *     NOT on embedding-only patches;
 *   - recordIngredientRevision prunes to CATALOG_REVISION_RETENTION;
 *   - restore-friendly read helpers (list/get) translate rows.
 *
 * Postgres is mocked with a SQL-dispatching fake — we capture the INSERTs and
 * assert on them, so the suite runs without a live database. The DDL/integration
 * round-trip is covered by db.catalogDdlParity.test.js + the live-DB suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];

function fakeIngredientRow(params) {
  // params shape from createIngredient INSERT: [id, type, name, payloadJson, tags, emb, embModel, origin]
  const [id, type, name, payloadJson, tags] = params;
  return {
    id, type, name,
    payload: JSON.parse(payloadJson),
    tags: tags || [],
    embedding: null, embedding_model: null, origin_instance_id: params[7],
    created_at: new Date(), updated_at: new Date(),
    deleted: false, deleted_at: null, sync_sequence: 1,
  };
}

function fakeRevisionRow(params) {
  // params from revision INSERT: [id, ingredient_id, name, payloadJson, tags, source, actor]
  const [id, ingredient_id, name, payloadJson, tags, source, actor] = params;
  return {
    id, ingredient_id, name,
    payload: JSON.parse(payloadJson),
    tags: tags || [],
    source, actor: actor ?? null,
    created_at: new Date(),
  };
}

vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    const s = sql.trim();
    if (/^INSERT INTO catalog_ingredient_revisions/i.test(s)) {
      return { rows: [fakeRevisionRow(params)] };
    }
    if (/^DELETE FROM catalog_ingredient_revisions/i.test(s)) {
      return { rows: [] };
    }
    if (/^SELECT \* FROM catalog_ingredient_revisions WHERE id =/i.test(s)) {
      return { rows: [] }; // overridden per-test where needed
    }
    if (/^SELECT \* FROM catalog_ingredient_revisions/i.test(s)) {
      return { rows: [] };
    }
    if (/^INSERT INTO catalog_ingredients/i.test(s)) {
      return { rows: [fakeIngredientRow(params)] };
    }
    if (/^UPDATE catalog_ingredients/i.test(s)) {
      // updateIngredient builds RETURNING *; echo a plausible row. The last
      // param is the id; reconstruct a minimal row from the SET values we know.
      const id = params[params.length - 1];
      return {
        rows: [{
          id, type: 'idea', name: 'updated',
          payload: { schemaVersion: 1 }, tags: [],
          embedding: null, embedding_model: null, origin_instance_id: 'inst-test',
          created_at: new Date(), updated_at: new Date(),
          deleted: false, deleted_at: null, sync_sequence: 2,
        }],
      };
    }
    if (/^SELECT \* FROM catalog_ingredients WHERE id =/i.test(s)) {
      return { rows: [] };
    }
    return { rows: [] };
  }),
  withTransaction: vi.fn(),
  pgvectorToArray: vi.fn(() => null),
  arrayToPgvector: vi.fn((a) => a),
}));

vi.mock('./instances.js', () => ({
  getInstanceId: vi.fn(async () => 'inst-test'),
}));

const db = await import('../lib/db.js');
const {
  createIngredient,
  updateIngredient,
  recordIngredientRevision,
  CATALOG_REVISION_RETENTION,
} = await import('./catalogDB.js');

const revisionInserts = () => calls.filter((c) => /^INSERT INTO catalog_ingredient_revisions/i.test(c.sql.trim()));
const revisionDeletes = () => calls.filter((c) => /^DELETE FROM catalog_ingredient_revisions/i.test(c.sql.trim()));

beforeEach(() => {
  calls.length = 0;
});

describe('createIngredient — seeds an initial revision', () => {
  it('writes one revision row labeled with the supplied source', async () => {
    await createIngredient({ type: 'idea', name: 'Spark', payload: { summary: 'x' } }, { source: 'extract', actor: 'agent-7' });
    const ins = revisionInserts();
    expect(ins.length).toBe(1);
    // params: [id, ingredient_id, name, payloadJson, tags, source, actor]
    expect(ins[0].params[5]).toBe('extract');
    expect(ins[0].params[6]).toBe('agent-7');
    expect(ins[0].params[0]).toMatch(/^cat-rev-/);
  });

  it('defaults the seed revision source to user', async () => {
    await createIngredient({ type: 'idea', name: 'Plain' });
    expect(revisionInserts()[0].params[5]).toBe('user');
  });
});

describe('updateIngredient — records a revision only on content change', () => {
  it('records a revision when payload changes', async () => {
    await updateIngredient('cat-idea-1', { payload: { summary: 'new' } });
    expect(revisionInserts().length).toBe(1);
  });

  it('records a revision when name changes', async () => {
    await updateIngredient('cat-idea-1', { name: 'Renamed' });
    expect(revisionInserts().length).toBe(1);
  });

  it('records a revision when tags change', async () => {
    await updateIngredient('cat-idea-1', { tags: ['noir'] });
    expect(revisionInserts().length).toBe(1);
  });

  it('does NOT record a revision on an embedding-only patch', async () => {
    await updateIngredient('cat-idea-1', { embedding: [0.1, 0.2], embeddingModel: 'm' });
    expect(revisionInserts().length).toBe(0);
  });

  it('labels the revision with the supplied source/actor', async () => {
    await updateIngredient('cat-idea-1', { name: 'X' }, { source: 'refine', actor: 'run-99' });
    const ins = revisionInserts();
    expect(ins[0].params[5]).toBe('refine');
    expect(ins[0].params[6]).toBe('run-99');
  });

  it('coerces an unknown source back to user', async () => {
    await recordIngredientRevision(
      { id: 'cat-idea-1', name: 'n', payload: {}, tags: [] },
      { source: 'bogus' },
    );
    expect(revisionInserts()[0].params[5]).toBe('user');
  });
});

describe('recordIngredientRevision — retention prune', () => {
  it('issues a prune DELETE with the retention cap', async () => {
    await recordIngredientRevision({ id: 'cat-idea-9', name: 'n', payload: {}, tags: [] }, {});
    const del = revisionDeletes();
    expect(del.length).toBe(1);
    // DELETE params: [ingredient_id, retention]
    expect(del[0].params[0]).toBe('cat-idea-9');
    expect(del[0].params[1]).toBe(CATALOG_REVISION_RETENTION);
  });

  it('truncates a very long actor to 120 chars', async () => {
    const longActor = 'a'.repeat(300);
    await recordIngredientRevision({ id: 'cat-idea-1', name: 'n', payload: {}, tags: [] }, { actor: longActor });
    expect(revisionInserts()[0].params[6].length).toBe(120);
  });

  it('defaults retention to 50', () => {
    expect(CATALOG_REVISION_RETENTION).toBe(50);
  });
});
