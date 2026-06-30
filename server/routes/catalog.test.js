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
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';

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
if (!dbReady) console.log(`⏭️ routes/catalog.test: skipping suite — ${skipReason || 'no database'}`);

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

afterAll(async () => {
  if (!dbReady) return;
  for (const id of createdIngredientIds) {
    await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
  }
  for (const id of createdScrapIds) {
    await catalogDB.deleteScrap(id, { hard: true }).catch(() => {});
  }
  await close();
});

describe.skipIf(!dbReady)('POST /api/catalog/bulk-import — scrap persistence', () => {
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

describe.skipIf(!dbReady)('POST /api/catalog/scraps — chunking', () => {
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

describe.skipIf(!dbReady)('POST /api/catalog/bulk-import — export-bundle ref recreation', () => {
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

describe.skipIf(!dbReady)('POST /api/catalog/ingredients/:id/revisions/:revisionId/restore', () => {
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
      .send({});

    expect(r.status).toBe(200);
    expect(r.body.payload.description).toBe('old-shape');
    expect(r.body.payload.schemaVersion).toBe(0); // preserved verbatim, NOT re-stamped

    // The restore is itself recorded as a new revision (auditable/reversible).
    const { items: after } = await catalogDB.listIngredientRevisions(ing.id);
    expect(after.length).toBe(revisions.length + 1);
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

describe.skipIf(!dbReady)('GET /api/catalog/ingredients/:id/details — batched hydration', () => {
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

describe.skipIf(!dbReady)('GET /api/catalog/facets + ingredient filters (#1762)', () => {
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
