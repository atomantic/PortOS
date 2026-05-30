/**
 * Postgres-backed CRUD round-trip for the catalog data layer.
 *
 * This suite needs a live PostgreSQL instance with the catalog schema applied
 * (the same one `npm start` connects to). If no DB is reachable — the common
 * case in CI and on fresh checkouts — it SKIPS cleanly with a clear message
 * rather than failing red. When a DB IS reachable it exercises the full
 * scrap → ingredient → ref → source lifecycle and tears its rows back out so
 * the suite is repeatable.
 *
 * `instances.js` is left under the global vitest.setup.js mock (getPeers → [])
 * so no row created here fans out to live sync peers; nothing here exercises
 * the createUniverse/createSeries peerSync import path, so mockNoPeers alone
 * is sufficient per the CLAUDE.md record-creating-tests rule.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close } from '../lib/db.js';
import * as catalogDB from './catalogDB.js';

// Probe the DB once before the suite. `dbReady` gates every test: when false
// we register the suite with `describe.skip` so the runner reports them as
// skipped (with the reason logged) instead of erroring on a missing socket.
let dbReady = false;
let skipReason = '';

beforeAll(async () => {
  const health = await checkHealth();
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
    return;
  }
  // Always run the idempotent ensureSchema upgrades before the suite: a DB
  // provisioned by an older PortOS may have the catalog tables but be missing
  // newer columns (e.g. the ref tombstone `deleted`/`deleted_at`). ensureSchema
  // creates the tables when absent and ALTERs them up to current when present.
  await ensureSchema().catch(() => {});
  const recheck = await checkHealth();
  if (!recheck.hasCatalogSchema) {
    skipReason = 'catalog schema not present (ensureSchema did not create catalog tables)';
    return;
  }
  dbReady = true;
});

// Vitest evaluates describe bodies eagerly, before beforeAll runs, so we can't
// branch on `dbReady` at registration time. Instead each test no-ops with a
// console note when the DB is unavailable — keeping the suite green and loud.
function requireDb(t) {
  if (!dbReady) {
    console.log(`⏭️ catalogDB.test: skipping "${t}" — ${skipReason || 'no database'}`);
    return false;
  }
  return true;
}

// Track ids created across tests so end-of-suite cleanup hard-deletes them
// even when an assertion throws mid-test. Cleanup runs BEFORE the pool is
// closed (single afterAll, in order) so the deletes have a live connection.
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

describe('catalogDB (Postgres CRUD round-trip)', () => {
  it('creates and reads back an ingredient with payload + tags', async () => {
    if (!requireDb('create/get ingredient')) return;
    const created = await catalogDB.createIngredient({
      type: 'character',
      name: '  Echo Saint  ',
      payload: { physicalDescription: 'A wiry figure in a long coat.', personality: 'Wry' },
      tags: ['noir', 'protagonist'],
    });
    createdIngredientIds.add(created.id);

    expect(created.id).toMatch(/^cat-chr-/);
    expect(created.name).toBe('Echo Saint'); // trimmed
    expect(created.type).toBe('character');
    expect(created.payload.physicalDescription).toContain('wiry figure');
    expect(created.tags).toEqual(['noir', 'protagonist']);
    expect(created.deleted).toBe(false);

    const fetched = await catalogDB.getIngredient(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe('Echo Saint');
    expect(fetched.payload.personality).toBe('Wry');
  });

  it('rejects an invalid type and a blank name', async () => {
    if (!requireDb('create validation')) return;
    await expect(catalogDB.createIngredient({ type: 'spaceship', name: 'X' }))
      .rejects.toThrow(/Invalid ingredient type/);
    await expect(catalogDB.createIngredient({ type: 'idea', name: '   ' }))
      .rejects.toThrow(/name is required/);
  });

  it('updates name/payload/tags in place and preserves untouched fields', async () => {
    if (!requireDb('update ingredient')) return;
    const created = await catalogDB.createIngredient({
      type: 'place',
      name: 'Old Harbor',
      payload: { description: 'Brine and rust.' },
      tags: ['coastal'],
    });
    createdIngredientIds.add(created.id);

    const updated = await catalogDB.updateIngredient(created.id, {
      name: 'New Harbor',
      tags: ['coastal', 'rebuilt'],
    });
    expect(updated.name).toBe('New Harbor');
    expect(updated.tags).toEqual(['coastal', 'rebuilt']);
    // payload untouched — only patched fields change
    expect(updated.payload.description).toBe('Brine and rust.');
  });

  it('soft-deletes so GET returns null but the row survives for sync', async () => {
    if (!requireDb('soft-delete ingredient')) return;
    const created = await catalogDB.createIngredient({ type: 'object', name: 'Brass Key' });
    createdIngredientIds.add(created.id);

    await catalogDB.deleteIngredient(created.id);
    const afterDelete = await catalogDB.getIngredient(created.id);
    expect(afterDelete).toBeNull();

    // The tombstone is still visible to the sync change-feed.
    const { items } = await catalogDB.getIngredientChangesSince('0', 1000);
    const tombstone = items.find((i) => i.id === created.id);
    expect(tombstone).toBeTruthy();
    expect(tombstone.deleted).toBe(true);
  });

  it('reviveDeletedIngredient un-deletes a soft-deleted row at the same id', async () => {
    if (!requireDb('revive ingredient')) return;
    const created = await catalogDB.createIngredient({
      type: 'concept', name: 'Entropy', payload: { summary: 'old' },
    });
    createdIngredientIds.add(created.id);
    await catalogDB.deleteIngredient(created.id);

    const revived = await catalogDB.reviveDeletedIngredient(created.id, {
      type: 'concept', name: 'Entropy', payload: { summary: 'new' }, tags: ['physics'],
    });
    expect(revived).not.toBeNull();
    expect(revived.deleted).toBe(false);
    expect(revived.payload.summary).toBe('new');

    // A fresh GET now succeeds (the row is active again).
    const fetched = await catalogDB.getIngredient(created.id);
    expect(fetched.tags).toEqual(['physics']);

    // Reviving a row that is NOT deleted returns null (no-op).
    const noop = await catalogDB.reviveDeletedIngredient(created.id, {
      type: 'concept', name: 'Entropy',
    });
    expect(noop).toBeNull();
  });

  it('lists ingredients filtered by type', async () => {
    if (!requireDb('list by type')) return;
    const scene = await catalogDB.createIngredient({ type: 'scene', name: 'Rooftop Standoff' });
    createdIngredientIds.add(scene.id);

    const { items } = await catalogDB.listIngredients({ type: 'scene', limit: 200 });
    expect(items.every((i) => i.type === 'scene')).toBe(true);
    expect(items.some((i) => i.id === scene.id)).toBe(true);
    // The light list path strips the embedding column.
    expect(items[0].embedding).toBeNull();
  });

  it('links an ingredient to a ref, lists both directions, then soft-unlinks', async () => {
    if (!requireDb('ref link/unlink')) return;
    const ing = await catalogDB.createIngredient({ type: 'character', name: 'Linker McRef' });
    createdIngredientIds.add(ing.id);
    const refId = `series-${ing.id}`; // unique synthetic ref id

    await catalogDB.linkIngredientToRef(ing.id, 'series', refId, 'cast-character');

    const refs = await catalogDB.listRefsForIngredient(ing.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ refKind: 'series', refId, role: 'cast-character', deleted: false });

    const forRef = await catalogDB.listIngredientsForRef('series', refId);
    expect(forRef).toHaveLength(1);
    expect(forRef[0].ingredient.id).toBe(ing.id);
    expect(forRef[0].role).toBe('cast-character');

    await catalogDB.unlinkIngredientFromRef(ing.id, 'series', refId, 'cast-character');
    // Live list paths hide tombstoned links.
    expect(await catalogDB.listRefsForIngredient(ing.id)).toHaveLength(0);
    expect(await catalogDB.listIngredientsForRef('series', refId)).toHaveLength(0);
  });

  it('creates a scrap, links it as an ingredient source, and hydrates it back', async () => {
    if (!requireDb('scrap source link')) return;
    const scrap = await catalogDB.createScrap({
      title: 'Notebook page',
      rawText: 'A long coat, a longer memory.',
      sourceKind: 'paste',
    });
    createdScrapIds.add(scrap.id);
    expect(scrap.id).toMatch(/^cat-scrap-/);

    const ing = await catalogDB.createIngredient({ type: 'character', name: 'Sourced One' });
    createdIngredientIds.add(ing.id);

    await catalogDB.linkIngredientToSource(ing.id, scrap.id, { start: 0, end: 10 });

    const sources = await catalogDB.listSourcesForIngredient(ing.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ scrapId: scrap.id, ingredientId: ing.id });
    expect(sources[0].span).toEqual({ start: 0, end: 10 });

    const forScrap = await catalogDB.listSourcesForScrap(scrap.id);
    expect(forScrap.some((s) => s.ingredientId === ing.id)).toBe(true);

    const hydrated = await catalogDB.listScrapsForIngredient(ing.id);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].rawText).toContain('long coat');
  });

  it('exportSliceForRef bundles ingredients + scraps + refs for a ref', async () => {
    if (!requireDb('export slice')) return;
    const ing = await catalogDB.createIngredient({
      type: 'character', name: 'Bundled Hero', payload: { role: 'lead' },
    });
    createdIngredientIds.add(ing.id);
    const refId = `work-${ing.id}`;
    await catalogDB.linkIngredientToRef(ing.id, 'work', refId, 'cast-character');
    const scrap = await catalogDB.createScrap({ rawText: 'Origin notes.' });
    createdScrapIds.add(scrap.id);
    await catalogDB.linkIngredientToSource(ing.id, scrap.id);

    const bundle = await catalogDB.exportSliceForRef('work', refId);
    expect(bundle.version).toBe(1);
    expect(bundle.ref).toEqual({ kind: 'work', id: refId });
    expect(bundle.ingredients).toHaveLength(1);
    const exported = bundle.ingredients[0];
    expect(exported.id).toBe(ing.id);
    expect(exported.roleForExportedRef).toBe('cast-character');
    expect(exported.scraps).toHaveLength(1);
    // Embedding is stripped from the export.
    expect(exported.embedding).toBeUndefined();
  });

  it('getCatalogStats reflects created rows', async () => {
    if (!requireDb('catalog stats')) return;
    const ing = await catalogDB.createIngredient({ type: 'idea', name: 'Stat Idea' });
    createdIngredientIds.add(ing.id);
    const stats = await catalogDB.getCatalogStats();
    expect(typeof stats.total).toBe('number');
    expect(stats.byType.idea).toBeGreaterThanOrEqual(1);
  });

  it('getMaxSequences returns numeric-string cursors for every table', async () => {
    if (!requireDb('max sequences')) return;
    const seqs = await catalogDB.getMaxSequences();
    for (const key of ['ingredients', 'scraps', 'sources', 'refs']) {
      expect(seqs[key]).toMatch(/^\d+$/);
    }
  });
});
