/**
 * DB-backed regression coverage for #8347: the ref/relation/media
 * tuple-unique upserts must not let a peer's stale live copy revive a
 * NEWER local tombstone.
 *
 * `upsertRefFromPeer`, `upsertRelationFromPeer`, and `upsertMediaFromPeer`
 * apply `deleted`/`deleted_at` unconditionally by ON CONFLICT DO UPDATE.
 * Scenario: machine A soft-deletes ref R at t2. Before B pulls that
 * tombstone, A pulls B's still-live copy of R (a role/data resend, a reset
 * rewind, or the #8315 upgrade replay that resends every catalog row once).
 * Applying it unconditionally sets `deleted = false` and revives the row —
 * the unlink is lost. The fix adds an `updated_at` change-clock (bumped by
 * the sync-seq triggers on every soft-delete/revival) and gates the apply
 * on `EXCLUDED.updated_at > <table>.updated_at`.
 *
 * This needs a live Postgres — the trigger-maintained `updated_at` stamp and
 * the `WHERE EXCLUDED.updated_at > …` guard are SQL-level behavior a mocked
 * `query()` can't exercise faithfully.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as catalogDB from './catalogDB.js';

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
    else skipReason = 'catalog schema not present (ensureSchema did not create catalog tables)';
  }
}
const runDb = requireDbOrSkip('services/catalogSync.tombstoneRevival.db.test', dbReady, skipReason);
function requireDb() { return dbReady; }

const createdIngredientIds = new Set();

afterAll(async () => {
  if (!dbReady) return;
  for (const id of createdIngredientIds) {
    await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
  }
  await close();
});

async function makeIngredient(name) {
  const ing = await catalogDB.createIngredient({ type: 'character', name, payload: {}, tags: [] });
  createdIngredientIds.add(ing.id);
  return ing;
}

const STALE_CLOCK = '2000-01-01T00:00:00.000Z'; // always older than any row created by this suite
const FUTURE_CLOCK = new Date(Date.now() + 60_000).toISOString(); // always newer

describe.skipIf(!runDb)('catalog tombstone/revival guard (#8347)', () => {
  it('keeps a ref tombstone when the peer applies a stale live copy, but accepts a genuinely newer revival', async () => {
    if (!requireDb('ref revival guard')) return;
    const ing = await makeIngredient('Ref Revival Subject');
    const refKind = 'universe';
    const refId = 'u-test-8347';
    const role = 'canon-character';

    await catalogDB.linkIngredientToRef(ing.id, refKind, refId, role);
    await catalogDB.unlinkIngredientFromRef(ing.id, refKind, refId, role); // local tombstone

    const before = await query(
      `SELECT deleted, deleted_at, updated_at, created_at FROM catalog_ingredient_refs
        WHERE ingredient_id = $1 AND ref_kind = $2 AND ref_id = $3 AND role = $4`,
      [ing.id, refKind, refId, role],
    );
    expect(before.rows[0].deleted).toBe(true);
    expect(before.rows[0].updated_at).not.toBeNull();

    // A stale peer re-sends its still-live copy of the same ref, carrying an
    // OLDER change-clock than the local tombstone.
    await catalogDB.upsertRefFromPeer({
      ingredientId: ing.id, refKind, refId, role,
      createdAt: before.rows[0].created_at.toISOString(),
      deleted: false, deletedAt: null, updatedAt: STALE_CLOCK,
    });
    const afterStale = await query(
      `SELECT deleted FROM catalog_ingredient_refs
        WHERE ingredient_id = $1 AND ref_kind = $2 AND ref_id = $3 AND role = $4`,
      [ing.id, refKind, refId, role],
    );
    expect(afterStale.rows[0].deleted).toBe(true); // tombstone survives

    // A genuinely newer revival (a real re-link on the peer, later in time)
    // still un-deletes the row.
    await catalogDB.upsertRefFromPeer({
      ingredientId: ing.id, refKind, refId, role,
      createdAt: before.rows[0].created_at.toISOString(),
      deleted: false, deletedAt: null, updatedAt: FUTURE_CLOCK,
    });
    const afterRevival = await query(
      `SELECT deleted FROM catalog_ingredient_refs
        WHERE ingredient_id = $1 AND ref_kind = $2 AND ref_id = $3 AND role = $4`,
      [ing.id, refKind, refId, role],
    );
    expect(afterRevival.rows[0].deleted).toBe(false);
  });

  it('keeps a relation tombstone when the peer applies a stale live copy, but accepts a genuinely newer revival', async () => {
    if (!requireDb('relation revival guard')) return;
    const from = await makeIngredient('Relation Revival From');
    const to = await makeIngredient('Relation Revival To');
    const kind = 'related-to';

    await catalogDB.linkIngredientRelation(from.id, to.id, kind);
    await catalogDB.unlinkIngredientRelation(from.id, to.id, kind);

    const before = await query(
      `SELECT deleted, created_at FROM catalog_ingredient_relations
        WHERE from_id = $1 AND to_id = $2 AND kind = $3`,
      [from.id, to.id, kind],
    );
    expect(before.rows[0].deleted).toBe(true);

    await catalogDB.upsertRelationFromPeer({
      fromId: from.id, toId: to.id, kind,
      createdAt: before.rows[0].created_at.toISOString(),
      deleted: false, deletedAt: null, updatedAt: STALE_CLOCK,
    });
    const afterStale = await query(
      `SELECT deleted FROM catalog_ingredient_relations WHERE from_id = $1 AND to_id = $2 AND kind = $3`,
      [from.id, to.id, kind],
    );
    expect(afterStale.rows[0].deleted).toBe(true);

    await catalogDB.upsertRelationFromPeer({
      fromId: from.id, toId: to.id, kind,
      createdAt: before.rows[0].created_at.toISOString(),
      deleted: false, deletedAt: null, updatedAt: FUTURE_CLOCK,
    });
    const afterRevival = await query(
      `SELECT deleted FROM catalog_ingredient_relations WHERE from_id = $1 AND to_id = $2 AND kind = $3`,
      [from.id, to.id, kind],
    );
    expect(afterRevival.rows[0].deleted).toBe(false);
  });

  it('keeps a media tombstone when the peer applies a stale live copy, but accepts a genuinely newer revival', async () => {
    if (!requireDb('media revival guard')) return;
    const ing = await makeIngredient('Media Revival Subject');
    const mediaKey = 'media-revival-8347.png';
    const kind = 'reference';

    await catalogDB.attachMedia(ing.id, mediaKey, kind);
    await catalogDB.detachMedia(ing.id, mediaKey, kind);

    const before = await query(
      `SELECT deleted, created_at FROM catalog_ingredient_media
        WHERE ingredient_id = $1 AND media_key = $2 AND kind = $3`,
      [ing.id, mediaKey, kind],
    );
    expect(before.rows[0].deleted).toBe(true);

    await catalogDB.upsertMediaFromPeer({
      ingredientId: ing.id, mediaKey, kind,
      createdAt: before.rows[0].created_at.toISOString(),
      deleted: false, deletedAt: null, updatedAt: STALE_CLOCK,
    });
    const afterStale = await query(
      `SELECT deleted FROM catalog_ingredient_media WHERE ingredient_id = $1 AND media_key = $2 AND kind = $3`,
      [ing.id, mediaKey, kind],
    );
    expect(afterStale.rows[0].deleted).toBe(true);

    await catalogDB.upsertMediaFromPeer({
      ingredientId: ing.id, mediaKey, kind,
      createdAt: before.rows[0].created_at.toISOString(),
      deleted: false, deletedAt: null, updatedAt: FUTURE_CLOCK,
    });
    const afterRevival = await query(
      `SELECT deleted FROM catalog_ingredient_media WHERE ingredient_id = $1 AND media_key = $2 AND kind = $3`,
      [ing.id, mediaKey, kind],
    );
    expect(afterRevival.rows[0].deleted).toBe(false);
  });

  it('treats a tombstone-less (mixed-version) peer payload as no opinion, preserving a local tombstone', async () => {
    if (!requireDb('mixed-version compatibility')) return;
    const ing = await makeIngredient('Mixed Version Subject');
    const refKind = 'series';
    const refId = 's-test-8347';
    const role = 'cast';

    await catalogDB.linkIngredientToRef(ing.id, refKind, refId, role);
    await catalogDB.unlinkIngredientFromRef(ing.id, refKind, refId, role);

    // A pre-tombstone (v1-shape) peer payload carries no deleted/deletedAt keys.
    await catalogDB.upsertRefFromPeer({
      ingredientId: ing.id, refKind, refId, role, createdAt: new Date().toISOString(),
    });
    const after = await query(
      `SELECT deleted FROM catalog_ingredient_refs
        WHERE ingredient_id = $1 AND ref_kind = $2 AND ref_id = $3 AND role = $4`,
      [ing.id, refKind, refId, role],
    );
    expect(after.rows[0].deleted).toBe(true); // untouched, "no opinion"
  });
});
