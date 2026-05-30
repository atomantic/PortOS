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
import { checkHealth, ensureSchema, close } from '../lib/db.js';

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
