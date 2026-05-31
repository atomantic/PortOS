/**
 * Bidirectional catalog↔canon projection — the highest-risk file in this PR.
 *
 * Needs a live Postgres (the same one `npm start` uses) for the catalog rows +
 * refs; SKIPS cleanly when no DB is reachable. The universe side is INJECTED as
 * a spy (`updateUniverse` dep) so the suite asserts the projection's fan-out /
 * loop-break / LWW behavior without standing up a real universe store.
 *
 * The load-bearing assertion is "written EXACTLY ONCE": a single catalog edit
 * that round-trips catalog → canon → (echo) catalog must NOT write the catalog
 * row a second time. The injected updateUniverse calls the real
 * `projectToCatalog` (the A→B→A cycle) and we count `updateIngredient` hits.
 *
 * `instances.js` stays under the global vitest.setup mock (getPeers → []) so no
 * created row fans out to live peers; nothing here exercises the
 * createUniverse/createSeries peerSync import path, so mockNoPeers alone is
 * sufficient per the CLAUDE.md record-creating-tests rule.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { checkHealth, ensureSchema, close } from '../lib/db.js';
import * as catalogDB from './catalogDB.js';
import { projectToCanon, projectToCatalog, _inFlightSize } from './catalogCanonProjection.js';

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
if (!dbReady) console.log(`⏭️ catalogCanonProjection.test: skipping suite — ${skipReason || 'no database'}`);

const createdIngredientIds = new Set();
afterAll(async () => {
  if (!dbReady) return;
  for (const id of createdIngredientIds) {
    await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
  }
  await close();
});

// Mint a catalog character row + a universe ref link. Returns the row.
async function makeLinkedCharacter(universeId, { name = 'Proj Test', payload = {} } = {}) {
  const ing = await catalogDB.createIngredient({ type: 'character', name, payload });
  createdIngredientIds.add(ing.id);
  await catalogDB.linkIngredientToRef(ing.id, 'universe', universeId, 'canon-character');
  return ing;
}

describe.skipIf(!dbReady)('catalogCanonProjection', () => {
  it('projectToCanon fans a catalog edit into every linked universe canon entry', async () => {
    const uA = `u-proj-${Date.now()}-a`;
    const uB = `u-proj-${Date.now()}-b`;
    const ing = await makeLinkedCharacter(uA, { name: 'Multi' });
    await catalogDB.linkIngredientToRef(ing.id, 'universe', uB, 'canon-character');

    const seenUniverses = [];
    const updateUniverse = vi.fn(async (universeId, mutator) => {
      seenUniverses.push(universeId);
      // Simulate the embedded entry carrying this ingredientId so the mutator
      // produces a patch (returns null otherwise → counted as skipped).
      const patch = mutator({ characters: [{ id: 'e1', ingredientId: ing.id, name: 'old' }] });
      return patch; // truthy → counted as "written"
    });

    const stats = await projectToCanon(ing.id, { ...ing, name: 'Renamed', payload: { role: 'Hero' } }, { updateUniverse });
    expect(stats.universes).toBe(2);
    expect(stats.written).toBe(2);
    expect(seenUniverses.sort()).toEqual([uA, uB].sort());
    // Guard set drains — no leaked in-flight token.
    expect(_inFlightSize()).toBe(0);
  });

  it('projectToCanon is a silent no-op for an ingredient with no universe ref', async () => {
    const ing = await catalogDB.createIngredient({ type: 'object', name: 'Lonely Object' });
    createdIngredientIds.add(ing.id);
    const updateUniverse = vi.fn();
    const stats = await projectToCanon(ing.id, ing, { updateUniverse });
    expect(stats).toEqual({ universes: 0, written: 0, skipped: 0 });
    expect(updateUniverse).not.toHaveBeenCalled();
  });

  it('projectToCatalog writes a canon edit into the catalog row (LWW: newer canon wins)', async () => {
    const uId = `u-proj-${Date.now()}-c`;
    const ing = await makeLinkedCharacter(uId, { name: 'Canon Edit', payload: { role: 'old-role' } });
    // Embedded entry is NEWER than the row → it wins.
    const future = new Date(Date.now() + 60_000).toISOString();
    const canon = {
      characters: [{
        id: 'e1', ingredientId: ing.id, name: 'Canon Edit', role: 'new-role',
        updatedAt: future,
      }],
    };
    const stats = await projectToCatalog(uId, canon, {});
    expect(stats.written).toBe(1);
    const row = await catalogDB.getIngredient(ing.id);
    expect(row.payload.role).toBe('new-role');
  });

  it('projectToCatalog LWW skips an OLDER canon snapshot (catalog row newer)', async () => {
    const uId = `u-proj-${Date.now()}-d`;
    const ing = await makeLinkedCharacter(uId, { name: 'Fresh Row', payload: { role: 'keep-me' } });
    // Embedded entry is OLDER than the (just-created) row → it loses, no write.
    const past = new Date(Date.now() - 60_000).toISOString();
    const canon = {
      characters: [{ id: 'e1', ingredientId: ing.id, name: 'Fresh Row', role: 'stale', updatedAt: past }],
    };
    const stats = await projectToCatalog(uId, canon, {});
    expect(stats.written).toBe(0);
    expect(stats.skipped).toBe(1);
    const row = await catalogDB.getIngredient(ing.id);
    expect(row.payload.role).toBe('keep-me');
  });

  it('re-entrancy guard breaks the A→B→A loop — each side written EXACTLY ONCE', async () => {
    const uId = `u-proj-${Date.now()}-e`;
    const ing = await makeLinkedCharacter(uId, { name: 'Loop Guard', payload: { role: 'before' } });

    // Count catalog writes. The injected updateUniverse calls the REAL
    // projectToCatalog with the originating guard token — which must skip the
    // originating ingredient and therefore NOT write the catalog row again.
    const updSpy = vi.spyOn(catalogDB, 'updateIngredient');
    let catalogWritesInsideEcho = 0;

    const updateUniverse = vi.fn(async (universeId, mutator, opts) => {
      const before = updSpy.mock.calls.length;
      // The embedded entry now carries the fresh ingredientId; updateUniverse
      // would persist canon then synchronously project back to catalog.
      const canon = {
        characters: [{
          id: 'e1', ingredientId: ing.id, name: 'Loop Guard', role: 'after',
          updatedAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      };
      await projectToCatalog(universeId, canon, { guardToken: opts?.canonProjectionGuard });
      catalogWritesInsideEcho = updSpy.mock.calls.length - before;
      return mutator(canon); // truthy
    });

    const updated = await catalogDB.updateIngredient(ing.id, { payload: { role: 'after' } });
    const writesAfterPrimary = updSpy.mock.calls.length;

    await projectToCanon(ing.id, updated, { updateUniverse });

    // The echo (projectToCatalog inside updateUniverse) must NOT have written
    // the originating catalog row — the guard token skipped it.
    expect(catalogWritesInsideEcho).toBe(0);
    // Total catalog writes across the whole round-trip: only the primary edit.
    expect(updSpy.mock.calls.length).toBe(writesAfterPrimary);
    // Canon side written exactly once.
    expect(updateUniverse).toHaveBeenCalledTimes(1);
    expect(_inFlightSize()).toBe(0);
    updSpy.mockRestore();
  });
});
