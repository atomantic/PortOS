/**
 * Route-level Postgres integration tests for the catalog HTTP contract.
 *
 * Covers the producer↔consumer seams that the parser/DB unit tests don't reach:
 *   - POST /bulk-import persists round-tripped `### Scraps` into catalog_scraps
 *     + catalog_ingredient_sources rows in the same transaction.
 *   - POST /bulk-import recreates an export bundle's ref link from `bundleRef`
 *     when no `defaults.*Ref` overrides it, honoring per-row `roleForExportedRef`.
 *   - POST /ingredients/:id/revisions/:revisionId/restore restores the revision's
 *     payload VERBATIM, preserving its captured `payload.schemaVersion`, and
 *     records the restore as a new (auditable) revision.
 *
 * Needs a live Postgres with the catalog schema (same probe as
 * services/catalogDB.test.js); SKIPS cleanly when unreachable. Embeddings are
 * mocked so the route never reaches an AI provider.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import express from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

// Mock embeddings — the bulk-import + restore routes call these; we don't want a
// network round-trip and the assertions never inspect the vector.
vi.mock('../services/embeddings.js', () => ({
  embedBatch: vi.fn(async (seeds) => (seeds || []).map(() => ({ embedding: null, model: null }))),
  ingredientEmbedSeed: vi.fn((e) => e),
  embedIngredient: vi.fn(async () => ({})),
}));

const catalogDB = await import('../services/catalogDB.js');
const router = (await import('./catalog.js')).default;

// Probe the DB ONCE at module load (top-level await) so describe.skipIf reports
// SKIPPED rather than zero-assertion green when Postgres is unreachable.
let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const recheck = await checkHealth().catch(() => ({ hasCatalogSchema: false }));
    if (recheck.hasCatalogSchema) dbReady = true;
    else skipReason = 'catalog schema not present';
  }
}
const runDb = requireDbOrSkip('routes/catalog.test', dbReady, skipReason);

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/catalog', router);
  app.use(errorMiddleware);
  return app;
}

// Per-run nonce so seeded names/refs can't collide with residue left by a
// prior aborted run (cleanup hard-deletes by id, but a unique nonce keeps the
// assertions and any leftover rows unambiguous).
const NONCE = Date.now();

const createdIngredientIds = new Set();
const createdScrapIds = new Set();
const receiptKeys = new Set();

afterAll(async () => {
  if (!dbReady) return;
  await query('DELETE FROM catalog_commit_receipts WHERE operation_key = ANY($1::uuid[])', [[...receiptKeys]]);
  for (const id of createdIngredientIds) {
    await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
  }
  for (const id of createdScrapIds) {
    await catalogDB.deleteScrap(id, { hard: true }).catch(() => {});
  }
  await close();
});

describe.skipIf(!runDb)('POST /api/catalog/bulk-import — scrap persistence', () => {
  it('persists a round-tripped `### Scraps` bullet as a catalog_scraps row + source link', async () => {
    const markdown = [
      `## Character: Scrap Persist Hero ${NONCE}`,
      '',
      'A protagonist used to verify scrap persistence.',
      '',
      'tags: test-bulk-scrap',
      '',
      '### Scraps',
      '- (paste) Original notes captured for this hero.',
    ].join('\n');

    const r = await request(makeApp())
      .post('/api/catalog/bulk-import')
      .send({ format: 'markdown', payload: markdown });

    expect(r.status).toBe(201);
    expect(r.body.count).toBe(1);
    expect(r.body.scrapsCreated).toBe(1);
    const ing = r.body.created[0];
    createdIngredientIds.add(ing.id);

    const sources = await catalogDB.listSourcesForIngredient(ing.id);
    expect(sources).toHaveLength(1);
    const scrapId = sources[0].scrapId;
    createdScrapIds.add(scrapId);
    const scrap = await catalogDB.getScrap(scrapId);
    expect(scrap.rawText).toBe('Original notes captured for this hero.');
    expect(scrap.sourceKind).toBe('paste');
  });

  it('creates no scrap rows for a JSON import (no scraps carried)', async () => {
    const r = await request(makeApp())
      .post('/api/catalog/bulk-import')
      .send({ format: 'json', payload: JSON.stringify([{ type: 'idea', name: `Scrapless Idea ${NONCE}`, payload: { description: 'x' } }]) });

    expect(r.status).toBe(201);
    expect(r.body.scrapsCreated).toBe(0);
    createdIngredientIds.add(r.body.created[0].id);
    const sources = await catalogDB.listSourcesForIngredient(r.body.created[0].id);
    expect(sources).toHaveLength(0);
  });
});

describe.skipIf(!runDb)('POST /api/catalog/scraps — chunking', () => {
  it('chunks a long paste into a parent + children but returns the parent scrap', async () => {
    // Over the 12k cap so createChunkedScrap splits it.
    const para = `Para body ${NONCE} `.repeat(300); // ~5400 chars
    const rawText = Array.from({ length: 4 }, (_, i) => `Section ${i}\n\n${para}`).join('\n\n');
    expect(rawText.length).toBeGreaterThan(12_000);

    const r = await request(makeApp())
      .post('/api/catalog/scraps')
      .send({ title: `Long ${NONCE}`, rawText, sourceKind: 'paste' });

    expect(r.status).toBe(201);
    const parent = r.body.scrap;
    createdScrapIds.add(parent.id); // CASCADE drops children
    // Response is the PARENT: chunk_index 0, no parent, FULL text.
    expect(parent.chunkIndex).toBe(0);
    expect(parent.parentScrapId).toBeNull();
    expect(parent.rawText).toBe(rawText);

    const children = await catalogDB.listChildScraps(parent.id);
    expect(children.length).toBeGreaterThan(1);
    expect(children.map((c) => c.rawText).join('')).toBe(rawText);
  });

  it('rejects an extract request against a child chunk with 400', async () => {
    const para = `Child reject ${NONCE} `.repeat(300);
    const rawText = Array.from({ length: 4 }, () => para).join('\n\n');
    const create = await request(makeApp())
      .post('/api/catalog/scraps')
      .send({ rawText });
    const parentId = create.body.scrap.id;
    createdScrapIds.add(parentId);
    const children = await catalogDB.listChildScraps(parentId);
    expect(children.length).toBeGreaterThan(0);

    const r = await request(makeApp())
      .post(`/api/catalog/scraps/${children[0].id}/extract`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error || r.body.message).toMatch(/parent scrap/i);
  });

  it('keeps a short paste as a single non-chunked scrap', async () => {
    const r = await request(makeApp())
      .post('/api/catalog/scraps')
      .send({ rawText: `A brief note ${NONCE}.` });
    expect(r.status).toBe(201);
    const scrap = r.body.scrap;
    createdScrapIds.add(scrap.id);
    expect(scrap.parentScrapId).toBeNull();
    const children = await catalogDB.listChildScraps(scrap.id);
    expect(children).toHaveLength(0);
  });
});

describe.skipIf(!runDb)('POST /api/catalog/bulk-import — export-bundle ref recreation', () => {
  it('recreates the bundle ref link from `bundleRef` and honors per-row role', async () => {
    const seriesId = `test-series-${NONCE}`;
    const bundle = {
      version: 1,
      ref: { kind: 'series', id: seriesId },
      ingredients: [
        { type: 'character', name: `Bundle Cast A ${NONCE}`, payload: { physicalDescription: 'a' }, roleForExportedRef: 'lead' },
        { type: 'character', name: `Bundle Cast B ${NONCE}`, payload: { physicalDescription: 'b' } },
      ],
    };

    const r = await request(makeApp())
      .post('/api/catalog/bulk-import')
      .send({ format: 'json', payload: JSON.stringify(bundle) });

    expect(r.status).toBe(201);
    expect(r.body.count).toBe(2);
    for (const c of r.body.created) createdIngredientIds.add(c.id);

    const linked = await catalogDB.listIngredientsForRef('series', seriesId);
    expect(linked.map((x) => x.ingredient.name).sort()).toEqual([`Bundle Cast A ${NONCE}`, `Bundle Cast B ${NONCE}`]);
    // Per-row role precedence: row A carried `roleForExportedRef: 'lead'`, row B
    // fell back to the `bulk-<kind>` default.
    const roleByName = Object.fromEntries(linked.map((x) => [x.ingredient.name, x.role]));
    expect(roleByName[`Bundle Cast A ${NONCE}`]).toBe('lead');
    expect(roleByName[`Bundle Cast B ${NONCE}`]).toBe('bulk-series');
  });
});

// Inject a real SQL error at the pg transport, retaining its promise/callback
// interface. All other statements (including rollback) still reach portos_test.
async function withRevisionFailure(statement, operation, matchesParams = () => true) {
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (sql, ...args) {
    if (typeof sql === 'string' && statement.test(sql.trim()) && matchesParams(args[0])) {
      const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
      return original.call(this, 'SELECT 1 / 0', [], callback);
    }
    return original.call(this, sql, ...args);
  });
  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}

describe.skipIf(!runDb)('ingredient content and history commit together', () => {
  it('rolls back standalone creation and new tags when the seed revision fails', async () => {
    const id = `cat-idea-rollback-${NONCE}`;
    const tag = `rollback-create-${NONCE}`;
    createdIngredientIds.add(id);
    await expect(withRevisionFailure(/^INSERT INTO catalog_ingredient_revisions/i, () =>
      catalogDB.createIngredient({ id, type: 'idea', name: 'Example rollback', tags: [tag] }),
    )).rejects.toThrow('division by zero');
    expect(await catalogDB.getIngredient(id)).toBeNull();
    expect((await catalogDB.listIngredientRevisions(id)).items).toEqual([]);
    expect((await query('SELECT id FROM catalog_tags WHERE label = $1', [tag])).rows).toEqual([]);
  });

  it.each(['insert', 'prune'])('rolls back public PATCH when revision %s fails', async (stage) => {
    const ing = await catalogDB.createIngredient({ type: 'idea', name: `Before ${NONCE}` });
    createdIngredientIds.add(ing.id);
    const revisions = (await catalogDB.listIngredientRevisions(ing.id)).items;
    const tag = `rollback-patch-${stage}-${NONCE}`;
    const statement = stage === 'insert'
      ? /^INSERT INTO catalog_ingredient_revisions/i
      : /^DELETE FROM catalog_ingredient_revisions/i;
    const response = await withRevisionFailure(statement, () =>
      request(makeApp()).patch(`/api/catalog/ingredients/${ing.id}`)
        .send({ name: 'After', payload: { summary: 'changed' }, tags: [tag] }),
    );
    expect(response.status).toBe(500);
    expect(await catalogDB.getIngredient(ing.id)).toEqual(ing);
    expect((await catalogDB.listIngredientRevisions(ing.id)).items).toEqual(revisions);
    expect((await query('SELECT id FROM catalog_tags WHERE label = $1', [tag])).rows).toEqual([]);
  });

  it('rolls back a public restore when its new revision fails', async () => {
    const ing = await catalogDB.createIngredient({ type: 'concept', name: `Restore rollback ${NONCE}` });
    createdIngredientIds.add(ing.id);
    const original = (await catalogDB.listIngredientRevisions(ing.id)).items[0];
    const edited = await catalogDB.updateIngredient(ing.id, { payload: { schemaVersion: 99, summary: 'keep' } });
    const revisions = (await catalogDB.listIngredientRevisions(ing.id)).items;
    const response = await withRevisionFailure(/^INSERT INTO catalog_ingredient_revisions/i, () =>
      request(makeApp()).post(`/api/catalog/ingredients/${ing.id}/revisions/${original.id}/restore`).send({}),
    );
    expect(response.status).toBe(500);
    expect(await catalogDB.getIngredient(ing.id)).toEqual(edited);
    expect((await catalogDB.listIngredientRevisions(ing.id)).items).toEqual(revisions);
  });

  it('commits public create and PATCH snapshots with their content and attribution', async () => {
    const created = await request(makeApp()).post('/api/catalog/ingredients')
      .send({ type: 'idea', name: `Atomic create ${NONCE}`, payload: { summary: 'initial' } });
    expect(created.status).toBe(201);
    createdIngredientIds.add(created.body.id);
    const seed = (await catalogDB.listIngredientRevisions(created.body.id)).items[0];
    expect(seed).toMatchObject({
      name: created.body.name, payload: created.body.payload, tags: created.body.tags, source: 'user', actor: null,
    });
    const edited = await request(makeApp()).patch(`/api/catalog/ingredients/${created.body.id}`)
      .send({ payload: { schemaVersion: 7, summary: 'edited' }, source: 'refine', actor: 'example-agent' });
    expect(edited.status).toBe(200);
    const revisions = (await catalogDB.listIngredientRevisions(created.body.id)).items;
    expect(revisions).toHaveLength(2);
    expect(revisions.find((rev) => rev.id !== seed.id)).toMatchObject({
      name: edited.body.name, payload: edited.body.payload, tags: edited.body.tags,
      source: 'refine', actor: 'example-agent',
    });
  });

  it('keeps create and update inside a supplied transaction, including reads of uncommitted rows', async () => {
    const id = `cat-chr-owned-${NONCE}`;
    createdIngredientIds.add(id);
    await expect(withTransaction(async (client) => {
      await catalogDB.createIngredient({ id, type: 'character', name: 'Example character' }, { client });
      const edited = await catalogDB.updateIngredient(id, {
        payload: { aliases: [' Example alias ', ''] }, tags: ['example-owned'],
      }, { client });
      expect(edited.payload.aliases).toEqual(['Example alias']);
      expect((await client.query('SELECT id FROM catalog_ingredient_revisions WHERE ingredient_id = $1', [id])).rows).toHaveLength(2);
      throw new Error('cancel outer transaction');
    })).rejects.toThrow('cancel outer transaction');
    expect(await catalogDB.getIngredient(id)).toBeNull();
    expect((await catalogDB.listIngredientRevisions(id)).items).toEqual([]);
  });

  it('rolls back the scrap graph when a later ingredient revision fails', async () => {
    const scrap = await catalogDB.createScrap({ rawText: 'Example source' });
    createdScrapIds.add(scrap.id);
    const firstName = `Example first ${NONCE}`;
    const secondName = `Example second ${NONCE}`;
    const refId = `example-universe-${NONCE}`;
    await expect(withRevisionFailure(/^INSERT INTO catalog_ingredient_revisions/i, () =>
      catalogDB.commitScrap({
        scrapId: scrap.id, universeRef: refId,
        accepted: [{ type: 'idea', name: firstName }, { type: 'idea', name: secondName }],
      }), (params) => params?.[2] === secondName,
    )).rejects.toThrow('division by zero');
    expect((await query('SELECT ingredient_id FROM catalog_ingredient_refs WHERE ref_id = $1', [refId])).rows).toEqual([]);
    expect((await query('SELECT id FROM catalog_ingredients WHERE name = ANY($1)', [[firstName, secondName]])).rows).toEqual([]);
    expect((await query('SELECT ingredient_id FROM catalog_ingredient_sources WHERE scrap_id = $1', [scrap.id])).rows).toEqual([]);
    expect((await query('SELECT id FROM catalog_ingredient_revisions WHERE name = ANY($1)', [[firstName, secondName]])).rows).toEqual([]);
  });
});

describe.skipIf(!runDb)('POST /api/catalog/ingredients/:id/revisions/:revisionId/restore', () => {
  it('restores the revision payload verbatim, preserving its schemaVersion, and records a new revision', async () => {
    // Seed an ingredient, then write an "old shape" payload (schemaVersion 0) so
    // a later restore can prove the marker is preserved, not re-stamped.
    const ing = await catalogDB.createIngredient({ type: 'concept', name: `Restore Probe ${NONCE}`, payload: { description: 'v-current' } });
    createdIngredientIds.add(ing.id);

    await catalogDB.updateIngredient(ing.id, { payload: { schemaVersion: 0, description: 'old-shape' } });
    await catalogDB.updateIngredient(ing.id, { payload: { schemaVersion: 99, description: 'new-shape' } });

    const { items: revisions } = await catalogDB.listIngredientRevisions(ing.id);
    const oldRev = revisions.find((rev) => rev.payload?.description === 'old-shape');
    expect(oldRev).toBeTruthy();
    expect(oldRev.payload.schemaVersion).toBe(0);

    const r = await request(makeApp())
      .post(`/api/catalog/ingredients/${ing.id}/revisions/${oldRev.id}/restore`)
      .send({ source: 'user', actor: 'example-restore' });

    expect(r.status).toBe(200);
    expect(r.body.payload.description).toBe('old-shape');
    expect(r.body.payload.schemaVersion).toBe(0); // preserved verbatim, NOT re-stamped

    // The restore is itself recorded as a new revision (auditable/reversible).
    const { items: after } = await catalogDB.listIngredientRevisions(ing.id);
    expect(after.length).toBe(revisions.length + 1);
    expect(after.find((rev) => !revisions.some((before) => before.id === rev.id))).toMatchObject({
      name: r.body.name, payload: r.body.payload, tags: r.body.tags, source: 'user', actor: 'example-restore',
    });
  });

  it('404s when the revision belongs to a different ingredient', async () => {
    const a = await catalogDB.createIngredient({ type: 'concept', name: `Restore Owner A ${NONCE}`, payload: { description: 'a' } });
    const b = await catalogDB.createIngredient({ type: 'concept', name: `Restore Owner B ${NONCE}`, payload: { description: 'b' } });
    createdIngredientIds.add(a.id);
    createdIngredientIds.add(b.id);
    await catalogDB.updateIngredient(a.id, { payload: { description: 'a2' } });
    const aRev = (await catalogDB.listIngredientRevisions(a.id)).items[0];

    const r = await request(makeApp())
      .post(`/api/catalog/ingredients/${b.id}/revisions/${aRev.id}/restore`)
      .send({});
    expect(r.status).toBe(404);
  });
});

describe.skipIf(!runDb)('GET /api/catalog/ingredients/:id/details — batched hydration', () => {
  it('returns ingredient + refs + sources + relations + revisions + media + missingMedia in one response', async () => {
    const a = await catalogDB.createIngredient({ type: 'character', name: `Details A ${NONCE}`, payload: { physicalDescription: 'lead' } });
    const b = await catalogDB.createIngredient({ type: 'place', name: `Details B ${NONCE}`, payload: { description: 'a place' } });
    createdIngredientIds.add(a.id);
    createdIngredientIds.add(b.id);
    await catalogDB.linkIngredientRelation(a.id, b.id, 'lives-in');
    await catalogDB.updateIngredient(a.id, { payload: { physicalDescription: 'lead, edited' } }); // → a revision

    const r = await request(makeApp()).get(`/api/catalog/ingredients/${a.id}/details`);
    expect(r.status).toBe(200);
    expect(r.body.ingredient.id).toBe(a.id);
    expect(r.body.ingredient).not.toHaveProperty('embedding'); // stripped by default
    expect(Array.isArray(r.body.refs)).toBe(true);
    expect(Array.isArray(r.body.sources)).toBe(true);
    expect(Array.isArray(r.body.media)).toBe(true);
    expect(Array.isArray(r.body.missingMedia)).toBe(true);
    expect(Array.isArray(r.body.revisions)).toBe(true);
    expect(r.body.revisions.length).toBeGreaterThan(0);          // the edit above
    // The relation A→B shows up as an outbound edge to B.
    expect(r.body.relations.outbound.some((e) => e.toId === b.id && e.kind === 'lives-in')).toBe(true);
  });

  it('404s for an unknown ingredient id', async () => {
    const r = await request(makeApp()).get(`/api/catalog/ingredients/cat-chr-does-not-exist-${NONCE}/details`);
    expect(r.status).toBe(404);
  });

  it('joins the source scrap title and lists sibling extractions, without a stub for a solo extraction (#7617)', async () => {
    const scrap = await catalogDB.createScrap({ title: `Route Scrap ${NONCE}`, rawText: 'Two characters, one page.', sourceKind: 'paste' });
    createdScrapIds.add(scrap.id);
    const a = await catalogDB.createIngredient({ type: 'character', name: `Details Sibling A ${NONCE}` });
    const b = await catalogDB.createIngredient({ type: 'character', name: `Details Sibling B ${NONCE}` });
    const solo = await catalogDB.createIngredient({ type: 'idea', name: `Details Solo ${NONCE}` });
    [a, b, solo].forEach((i) => createdIngredientIds.add(i.id));
    await catalogDB.linkIngredientToSource(a.id, scrap.id);
    await catalogDB.linkIngredientToSource(b.id, scrap.id);

    const rA = await request(makeApp()).get(`/api/catalog/ingredients/${a.id}/details`);
    expect(rA.status).toBe(200);
    expect(rA.body.sources).toHaveLength(1);
    expect(rA.body.sources[0].scrapTitle).toBe(`Route Scrap ${NONCE}`);
    expect(rA.body.sources[0].siblings).toEqual([{ id: b.id, name: `Details Sibling B ${NONCE}`, type: 'character' }]);

    // An ingredient with no other extraction from its scrap gets an EMPTY
    // siblings array, not an absent field — the client renders no stub for it.
    const soloScrap = await catalogDB.createScrap({ title: `Route Solo Scrap ${NONCE}`, rawText: 'Just one.', sourceKind: 'paste' });
    createdScrapIds.add(soloScrap.id);
    await catalogDB.linkIngredientToSource(solo.id, soloScrap.id);
    const rSolo = await request(makeApp()).get(`/api/catalog/ingredients/${solo.id}/details`);
    expect(rSolo.body.sources[0].siblings).toEqual([]);
  });

  it('omits dangling "Appears in" refs whose target was soft-deleted (#1812)', async () => {
    const liveUni = `details-live-uni-${NONCE}`;
    const deadUni = `details-dead-uni-${NONCE}`;
    await query('INSERT INTO universes (id, name) VALUES ($1, $2)', [liveUni, `Live Uni ${NONCE}`]);
    // Soft-delete this one so its ref becomes dangling.
    await query('INSERT INTO universes (id, name, deleted, deleted_at) VALUES ($1, $2, TRUE, NOW())', [deadUni, `Dead Uni ${NONCE}`]);
    const ing = await catalogDB.createIngredient({ type: 'character', name: `Dangling Probe ${NONCE}` });
    createdIngredientIds.add(ing.id);
    await catalogDB.linkIngredientToRef(ing.id, 'universe', liveUni, 'cast-character');
    await catalogDB.linkIngredientToRef(ing.id, 'universe', deadUni, 'reference');

    const r = await request(makeApp()).get(`/api/catalog/ingredients/${ing.id}/details`);
    expect(r.status).toBe(200);
    const refIds = r.body.refs.map((ref) => ref.refId);
    expect(refIds).toContain(liveUni);        // live target → chip stays
    expect(refIds).not.toContain(deadUni);    // dangling target → chip dropped

    await query('DELETE FROM catalog_ingredient_refs WHERE ref_id = ANY($1)', [[liveUni, deadUni]]).catch(() => {});
    await query('DELETE FROM universes WHERE id = ANY($1)', [[liveUni, deadUni]]).catch(() => {});
  });
});

describe.skipIf(!runDb)('POST /api/catalog/scraps/:id/commit — universe binding + relations (#7615)', () => {
  const UNI = `commit-uni-${NONCE}`;
  afterAll(async () => {
    await query('DELETE FROM catalog_ingredient_refs WHERE ref_id = $1', [UNI]).catch(() => {});
    await query('DELETE FROM universes WHERE id = $1', [UNI]).catch(() => {});
  });

  it('replays a lost response and concurrent commits without duplicating the batch, and rejects changed input', async () => {
    const scrap = await catalogDB.createScrap({ rawText: 'Example receipt source' });
    createdScrapIds.add(scrap.id);
    await query('INSERT INTO universes (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [UNI, 'Example Universe']);
    const operationKey = randomUUID();
    receiptKeys.add(operationKey);
    const body = {
      operationKey, universeRef: UNI,
      accepted: [
        { type: 'idea', name: 'Example receipt A', payload: { a: 1, b: 2 } },
        { type: 'idea', name: 'Example receipt B' },
      ],
    };
    const post = (input) => request(makeApp()).post(`/api/catalog/scraps/${scrap.id}/commit`).send(input);
    const [first, concurrent] = await Promise.all([post(body), post(body)]);
    expect(first.status).toBe(201);
    expect(concurrent.status).toBe(201);
    expect(concurrent.body.ingredients).toEqual(first.body.ingredients);
    const ids = first.body.ingredients.map(row => row.id);
    ids.forEach(id => createdIngredientIds.add(id));
    const counts = async () => {
      const { rows: [row] } = await query(`SELECT
        (SELECT count(*) FROM catalog_ingredient_sources WHERE scrap_id = $1) AS sources,
        (SELECT count(*) FROM catalog_ingredients WHERE id = ANY($2::text[])) AS ingredients,
        (SELECT count(*) FROM catalog_ingredient_revisions WHERE ingredient_id = ANY($2::text[])) AS revisions,
        (SELECT count(*) FROM catalog_ingredient_refs WHERE ingredient_id = ANY($2::text[])) AS refs,
        (SELECT count(*) FROM catalog_ingredient_relations WHERE from_id = ANY($2::text[])) AS edges`, [scrap.id, ids]);
      return row;
    };
    const originalCounts = await counts();
    expect(originalCounts).toEqual({ sources: '2', ingredients: '2', revisions: '2', refs: '2', edges: '1' });
    // A fresh process has no request cache: it must replay the durable receipt.
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { commitScrap } from './services/catalogDB/commit.js';
      import { catalogScrapCommitSchema } from './lib/catalogValidation.js';
      import { close } from './lib/db.js';
      const input = JSON.parse(process.argv[1]);
      const result = await commitScrap({ scrapId: input.scrapId, ...catalogScrapCommitSchema.parse(input.body) });
      await close();
      console.log('RECEIPT:' + JSON.stringify(result));
    `, JSON.stringify({ scrapId: scrap.id, body })], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, NODE_ENV: 'test', PGDATABASE: 'portos_test' },
    });
    const restartedResult = JSON.parse(stdout.split('\n').find(line => line.startsWith('RECEIPT:')).slice(8));
    expect(restartedResult).toEqual(first.body.ingredients);
    const replay = await post({ ...body, accepted: [
      { ...body.accepted[0], payload: { b: 2, a: 1 } }, body.accepted[1],
    ] });
    expect(replay.status).toBe(201);
    expect(replay.body.ingredients).toEqual(first.body.ingredients);
    expect(await counts()).toEqual(originalCounts);
    expect((await post({ ...body, accepted: [{ type: 'idea', name: 'Changed' }] })).status).toBe(409);
    expect(await counts()).toEqual(originalCounts);
    const nextKey = randomUUID();
    receiptKeys.add(nextKey);
    const intentional = await post({ ...body, operationKey: nextKey });
    expect(intentional.status).toBe(201);
    intentional.body.ingredients.forEach(row => {
      createdIngredientIds.add(row.id);
      expect(ids).not.toContain(row.id);
    });
  });

  it('links every committed ingredient to the universe with the type-derived role, and clusters the batch with related-to edges', async () => {
    await query('INSERT INTO universes (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [UNI, `Commit Universe ${NONCE}`]);
    const scrap = await catalogDB.createScrap({ rawText: `Commit binding source ${NONCE}` });
    createdScrapIds.add(scrap.id);

    const r = await request(makeApp())
      .post(`/api/catalog/scraps/${scrap.id}/commit`)
      .send({
        accepted: [
          { type: 'character', name: `Commit Hero ${NONCE}` },
          { type: 'idea', name: `Commit Idea ${NONCE}` },
        ],
        universeRef: UNI,
      });

    expect(r.status).toBe(201);
    expect(r.body.ingredients).toHaveLength(2);
    const [hero, idea] = r.body.ingredients;
    createdIngredientIds.add(hero.id);
    createdIngredientIds.add(idea.id);

    const heroRefs = await catalogDB.listRefsForIngredient(hero.id);
    expect(heroRefs).toEqual([expect.objectContaining({ refKind: 'universe', refId: UNI, role: 'canon-character' })]);
    const ideaRefs = await catalogDB.listRefsForIngredient(idea.id);
    expect(ideaRefs).toEqual([expect.objectContaining({ refKind: 'universe', refId: UNI, role: 'reference' })]);

    // HAS_ANY_HOMING_REF is true for both — neither buckets as unlinked (#7615 core symptom).
    const facets = await request(makeApp()).get('/api/catalog/facets');
    const uniBucket = facets.body.universes.find((u) => u.refId === UNI);
    expect(uniBucket?.count).toBeGreaterThanOrEqual(2);

    // A single scrap's extractions form a connected cluster: one related-to
    // edge for the pair, direction = lexicographically smaller id first.
    const heroRelations = await catalogDB.listRelationsForIngredient(hero.id);
    const [smallerId, largerId] = [hero.id, idea.id].sort();
    const edge = [...heroRelations.outbound, ...heroRelations.inbound].find((e) => e.kind === 'related-to');
    expect(edge).toBeTruthy();
    expect(edge.fromId).toBe(smallerId);
    expect(edge.toId).toBe(largerId);
  });

  it('omitting universeRef reproduces prior behavior exactly — source link only, no homing ref', async () => {
    const scrap = await catalogDB.createScrap({ rawText: `Commit no-universe source ${NONCE}` });
    createdScrapIds.add(scrap.id);

    const r = await request(makeApp())
      .post(`/api/catalog/scraps/${scrap.id}/commit`)
      .send({ accepted: [{ type: 'idea', name: `Commit Unbound Idea ${NONCE}` }] });

    expect(r.status).toBe(201);
    const ing = r.body.ingredients[0];
    createdIngredientIds.add(ing.id);

    const refs = await catalogDB.listRefsForIngredient(ing.id);
    expect(refs).toHaveLength(0);
    const sources = await catalogDB.listSourcesForIngredient(ing.id);
    expect(sources).toHaveLength(1);
  });

  it('mints no relation edges for a single-item batch or a batch over the 25-row bound', async () => {
    const scrap = await catalogDB.createScrap({ rawText: `Commit bound source ${NONCE}` });
    createdScrapIds.add(scrap.id);
    const accepted = Array.from({ length: 26 }, (_, i) => ({ type: 'idea', name: `Commit Bound Idea ${i} ${NONCE}` }));

    const r = await request(makeApp())
      .post(`/api/catalog/scraps/${scrap.id}/commit`)
      .send({ accepted });

    expect(r.status).toBe(201);
    expect(r.body.ingredients).toHaveLength(26);
    for (const ing of r.body.ingredients) createdIngredientIds.add(ing.id);

    for (const ing of r.body.ingredients) {
      const rel = await catalogDB.listRelationsForIngredient(ing.id);
      expect(rel.outbound).toHaveLength(0);
      expect(rel.inbound).toHaveLength(0);
    }
  });

  it('persists reviewed ownership/use edges and evidence through reload without draft metadata', async () => {
    const scrap = await catalogDB.createScrap({ rawText: 'Example Owner lends an inherited pistol to Example Companion.' });
    createdScrapIds.add(scrap.id);
    const response = await request(makeApp()).post(`/api/catalog/scraps/${scrap.id}/commit`).send({
      accepted: [
        { draftId: 'pistol', type: 'object', name: 'Example Inherited Pistol' },
        { draftId: 'owner', type: 'character', name: 'Example Owner' },
        { draftId: 'user', type: 'character', name: 'Example Companion' },
      ],
      relationships: [
        { fromDraftId: 'pistol', toDraftId: 'owner', kind: 'owned-by', evidence: 'The owner inherited the pistol.' },
        { fromDraftId: 'pistol', toDraftId: 'user', kind: 'used-by', evidence: 'The companion borrowed the pistol.' },
      ],
      universeRef: UNI,
    });
    expect(response.status).toBe(201);
    for (const row of response.body.ingredients) createdIngredientIds.add(row.id);
    const [pistol, owner, user] = response.body.ingredients;
    const reloaded = await catalogDB.getIngredient(pistol.id);
    expect(reloaded.payload.evidence).toEqual([
      'owned-by → Example Owner: The owner inherited the pistol.',
      'used-by → Example Companion: The companion borrowed the pistol.',
    ]);
    expect(reloaded.payload).not.toHaveProperty('draftId');
    const relations = await catalogDB.listRelationsForIngredient(pistol.id);
    expect(relations.outbound).toEqual(expect.arrayContaining([
      expect.objectContaining({ toId: owner.id, kind: 'owned-by' }),
      expect.objectContaining({ toId: user.id, kind: 'used-by' }),
    ]));
    expect(relations.outbound).toHaveLength(2);
    expect((await catalogDB.listRelationsForIngredient(owner.id)).inbound)
      .toEqual([expect.objectContaining({ fromId: pistol.id, kind: 'owned-by' })]);
  });

  it('rolls back source links, universe refs, ingredients and earlier edges on a relation failure', async () => {
    const scrap = await catalogDB.createScrap({ rawText: 'Example relation rollback source' });
    createdScrapIds.add(scrap.id);
    const operationKey = randomUUID();
    receiptKeys.add(operationKey);
    const refs = await import('../services/catalogDB/refs.js');
    const realLink = refs.linkIngredientRelation;
    const linkedIds = new Set();
    let calls = 0;
    const spy = vi.spyOn(refs, 'linkIngredientRelation').mockImplementation(async (from, to, kind, options) => {
      linkedIds.add(from);
      linkedIds.add(to);
      if (++calls === 2) throw new Error('Injected second relation failure');
      return realLink(from, to, kind, options);
    });
    try {
      await expect(catalogDB.commitScrap({
        scrapId: scrap.id, universeRef: UNI, operationKey,
        accepted: ['a', 'b', 'c'].map(draftId => ({ draftId, type: 'idea', name: 'Example ' + draftId })),
        relationships: [
          { fromDraftId: 'a', toDraftId: 'b', kind: 'references', evidence: 'A references B.' },
          { fromDraftId: 'a', toDraftId: 'c', kind: 'references', evidence: 'A references C.' },
        ],
      })).rejects.toThrow('Injected second relation failure');
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect((await query('SELECT * FROM catalog_commit_receipts WHERE operation_key = $1', [operationKey])).rows).toEqual([]);
    const retry = await catalogDB.commitScrap({
      scrapId: scrap.id, operationKey,
      accepted: [{ type: 'idea', name: 'Example successful retry after rollback' }],
    });
    retry.forEach(row => createdIngredientIds.add(row.id));
    expect(retry).toHaveLength(1);
    for (const id of linkedIds) {
      expect(await catalogDB.getIngredient(id)).toBeNull();
      expect(await catalogDB.listSourcesForIngredient(id)).toEqual([]);
      expect(await catalogDB.listRefsForIngredient(id)).toEqual([]);
    }
    const edges = await query('SELECT * FROM catalog_ingredient_relations WHERE from_id = ANY($1::text[])', [[...linkedIds]]);
    expect(edges.rows).toEqual([]);
  });

  it('rolls back every ingredient, ref, and relation edge on a mid-batch failure', async () => {
    const scrap = await catalogDB.createScrap({ rawText: `Commit rollback source ${NONCE}` });
    createdScrapIds.add(scrap.id);
    // A null `name` clears the route/Zod boundary (commitScrap itself does no
    // input validation — that's the route layer's job) but violates the
    // `catalog_ingredients.name TEXT NOT NULL` DB constraint on the second
    // insert, forcing a real mid-transaction failure.
    await expect(catalogDB.commitScrap({
      scrapId: scrap.id,
      accepted: [
        { type: 'idea', name: `Commit Rollback First ${NONCE}` },
        { type: 'idea', name: null },
      ],
      universeRef: UNI,
    })).rejects.toThrow();

    const { items } = await catalogDB.listIngredients({ query: `Commit Rollback First ${NONCE}` });
    expect(items).toHaveLength(0); // the first insert did not survive the rollback
  });
});

describe.skipIf(!runDb)('GET /api/catalog/facets + ingredient filters (#1762)', () => {
  const UNI = `route-uni-${NONCE}`;
  afterAll(async () => {
    await query('DELETE FROM catalog_ingredient_refs WHERE ref_id = $1', [UNI]).catch(() => {});
    await query('DELETE FROM universes WHERE id = $1', [UNI]).catch(() => {});
  });

  it('returns the facets envelope with universe membership + bucket counts', async () => {
    await query('INSERT INTO universes (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [UNI, `Route Universe ${NONCE}`]);
    const linked = await catalogDB.createIngredient({ type: 'character', name: `Route Linked ${NONCE}`, tags: [`rt-${NONCE}`] });
    const raw = await catalogDB.createIngredient({ type: 'idea', name: `Route Raw ${NONCE}` });
    createdIngredientIds.add(linked.id);
    createdIngredientIds.add(raw.id);
    await catalogDB.linkIngredientToRef(linked.id, 'universe', UNI, 'cast-character');

    const r = await request(makeApp()).get('/api/catalog/facets');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.types)).toBe(true);
    expect(Array.isArray(r.body.universes)).toBe(true);
    expect(Array.isArray(r.body.tags)).toBe(true);
    expect(typeof r.body.total).toBe('number');
    expect(typeof r.body.unlinkedCount).toBe('number');
    expect(typeof r.body.orphanedCount).toBe('number');
    const uni = r.body.universes.find((u) => u.refId === UNI);
    expect(uni?.name).toBe(`Route Universe ${NONCE}`);
    expect(uni?.count).toBeGreaterThanOrEqual(1);

    // The ref filter lists only the linked ingredient.
    const filtered = await request(makeApp()).get(`/api/catalog/ingredients?refKind=universe&refId=${UNI}`);
    expect(filtered.status).toBe(200);
    const ids = filtered.body.items.map((i) => i.id);
    expect(ids).toContain(linked.id);
    expect(ids).not.toContain(raw.id);
  });

  it('400s on an unpaired refKind and on combined album filters', async () => {
    const noRefId = await request(makeApp()).get('/api/catalog/ingredients?refKind=universe');
    expect(noRefId.status).toBe(400);
    const combined = await request(makeApp()).get('/api/catalog/ingredients?unlinked=true&orphaned=true');
    expect(combined.status).toBe(400);
  });
});

describe.skipIf(!runDb)('GET /api/catalog/ingredients?scrapId= (#7617)', () => {
  it('filters to ingredients extracted from the given source scrap', async () => {
    const scrap = await catalogDB.createScrap({ title: `Filter Scrap ${NONCE}`, rawText: 'Filter probe text.', sourceKind: 'paste' });
    createdScrapIds.add(scrap.id);
    const inScrap = await catalogDB.createIngredient({ type: 'character', name: `Scrap Filter In ${NONCE}` });
    const outOfScrap = await catalogDB.createIngredient({ type: 'character', name: `Scrap Filter Out ${NONCE}` });
    createdIngredientIds.add(inScrap.id);
    createdIngredientIds.add(outOfScrap.id);
    await catalogDB.linkIngredientToSource(inScrap.id, scrap.id);

    const r = await request(makeApp()).get(`/api/catalog/ingredients?scrapId=${scrap.id}`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i) => i.id);
    expect(ids).toContain(inScrap.id);
    expect(ids).not.toContain(outOfScrap.id);
  });
});
