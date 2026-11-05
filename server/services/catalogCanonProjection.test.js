/**
 * Bidirectional catalog↔canon projection — the highest-risk file in this PR.
 *
 * Uses the isolated portos_test database for catalog rows and refs; skips
 * when the test DB is unavailable. The universe side is INJECTED as
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
 * sufficient per the AGENTS.md record-creating-tests rule.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';

const reconcileUniverses = vi.hoisted(() => ({ list: [] }));
vi.mock('./universeBuilder.js', () => ({
  listUniverses: vi.fn(async () => reconcileUniverses.list),
  updateUniverse: vi.fn(async () => null),
}));
vi.mock('../lib/migrationMarker.js', () => ({ readMarker: vi.fn(async () => null), writeMarker: vi.fn(async () => {}) }));
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as catalogDB from './catalogDB.js';
import { projectToCanon, projectToCatalog } from './catalogCanonProjection.js';
import { sanitizePlace } from '../lib/storyBible.js';
import { reconcileCanonCatalog } from '../scripts/reconcileCanonCatalog.js';

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
const runDb = requireDbOrSkip('services/catalogCanonProjection.test', dbReady, skipReason);

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

// Pin a row's change clock so entry clocks can sit deterministically between
// it and the NOW() a later write stamps (the trigger keeps an explicit clock).
const PINNED_AT = '2020-01-01T00:00:00.000Z';
const AFTER_PIN = '2020-01-01T00:00:01.000Z';
const LATER_AFTER_PIN = '2020-01-01T00:00:02.000Z';
async function pinClock(id, at = PINNED_AT) {
  await query('UPDATE catalog_ingredients SET updated_at = $2 WHERE id = $1', [id, at]);
}
const canonEntry = (ingredientId, name, updatedAt) => ({ id: `e-${ingredientId}`, ingredientId, name, updatedAt });

describe.skipIf(!runDb)('a place Photoreal look across canon sync (#14946)', () => {
  const look = {
    version: 1,
    materials: [],
    lights: [{ id: 'key', type: 'point', position: [0, 3, 0], color: '#ffffff', watts: 100, size: 0.25, spotDegrees: 45 }],
    atmosphere: { haze: 0.2, worldColor: '#0d0d10', worldStrength: 0.3, exposure: 0, sun: false },
  };

  async function makeLinkedPlace(universeId) {
    const place = await catalogDB.createIngredient({ type: 'place', name: 'Example Rink', payload: { description: 'old' } });
    createdIngredientIds.add(place.id);
    await catalogDB.linkIngredientToRef(place.id, 'universe', universeId, 'canon-place');
    return catalogDB.setIngredientPayloadKey(place.id, 'photoreal', look);
  }
  const future = () => new Date(Date.now() + 60_000).toISOString();

  it('survives catalog→canon→catalog unchanged, through the canon sanitizer', async () => {
    const uId = `u-look-${Date.now()}-a`;
    const place = await makeLinkedPlace(uId);
    const canon = { places: [{ id: 'e1', ingredientId: place.id, name: place.name, updatedAt: '2020-01-01T00:00:00.000Z' }] };
    await projectToCanon(place.id, place, { updateUniverse: async (_id, mutator) => {
      const patch = await mutator(canon);
      canon.places = patch.places.map((entry) => ({ ...sanitizePlace(entry), ingredientId: entry.ingredientId }));
      return canon;
    } });
    expect(canon.places[0].photoreal).toEqual(look);

    canon.places[0] = { ...canon.places[0], description: 'edited in canon', updatedAt: future() };
    expect((await projectToCatalog(uId, canon)).written).toBe(1);
    const row = await catalogDB.getIngredient(place.id);
    expect(row.payload.description).toBe('edited in canon');
    expect(row.payload.photoreal).toEqual(look);
  });

  it('survives a sync from a canon entry saved before the sanitizer kept it', async () => {
    const uId = `u-look-${Date.now()}-b`;
    const place = await makeLinkedPlace(uId);
    const stale = { id: 'e1', ingredientId: place.id, name: place.name, description: 'stale mirror', updatedAt: future() };
    expect((await projectToCatalog(uId, { places: [stale] })).written).toBe(1);
    expect((await catalogDB.getIngredient(place.id)).payload.photoreal).toEqual(look);
  });

  it('a removed look is not brought back by a canon entry still holding it', async () => {
    const uId = `u-look-${Date.now()}-c`;
    const place = await makeLinkedPlace(uId);
    await catalogDB.setIngredientPayloadKey(place.id, 'photoreal', null);
    const mirror = { id: 'e1', ingredientId: place.id, name: place.name, photoreal: look, updatedAt: future() };
    expect((await projectToCatalog(uId, { places: [mirror] })).written).toBe(1);
    expect((await catalogDB.getIngredient(place.id)).payload).not.toHaveProperty('photoreal');
  });

  it('survives a boot reconcile where an older-shape canon entry wins', async () => {
    const uId = `u-look-${Date.now()}-d`;
    const place = await makeLinkedPlace(uId);
    reconcileUniverses.list = [{ id: uId, places: [
      { id: 'e1', ingredientId: place.id, name: place.name, description: 'canon won', updatedAt: future() },
    ] }];
    const result = await reconcileCanonCatalog({ force: true });
    reconcileUniverses.list = [];
    expect(result.stats.canonWon).toBe(1);
    const row = await catalogDB.getIngredient(place.id);
    expect(row.payload.description).toBe('canon won');
    expect(row.payload.photoreal).toEqual(look);
  });
});

describe.skipIf(!runDb)('catalogCanonProjection', () => {
  it('projectToCanon fans a catalog edit into every linked universe canon entry', async () => {
    const uA = `u-proj-${Date.now()}-a`;
    const uB = `u-proj-${Date.now()}-b`;
    const ing = await makeLinkedCharacter(uA, { name: 'Multi' });
    await catalogDB.linkIngredientToRef(ing.id, 'universe', uB, 'canon-character');

    const seenUniverses = [];
    const projected = [];
    const updateUniverse = vi.fn(async (universeId, mutator) => {
      seenUniverses.push(universeId);
      // Simulate the embedded entry carrying this ingredientId so the mutator
      // produces a patch (returns null otherwise → counted as skipped).
      const patch = await mutator({
        characters: [{
          id: 'e1', ingredientId: ing.id, name: 'old',
          createdAt: '2026-01-01T00:00:00.000Z', staleField: 'remove me',
        }],
      });
      projected.push(patch.characters[0]);
      return patch; // truthy → counted as "written"
    });

    const updated = await catalogDB.updateIngredient(ing.id, { name: 'Renamed', payload: { role: 'Hero' } });
    const stats = await projectToCanon(ing.id, updated, { updateUniverse });
    expect(stats.universes).toBe(2);
    expect(stats.written).toBe(2);
    expect(seenUniverses.sort()).toEqual([uA, uB].sort());
    expect(projected[0]).toMatchObject({
      id: 'e1', ingredientId: ing.id, name: 'Renamed', role: 'Hero',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(projected[0]).not.toHaveProperty('staleField');
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
    const condSpy = vi.spyOn(catalogDB, 'updateIngredientIfFresh');
    let catalogWritesInsideEcho = 0;

    const updateUniverse = vi.fn(async (universeId, mutator, opts) => {
      const before = updSpy.mock.calls.length;
      // The embedded entry now carries the fresh ingredientId; updateUniverse
      // would persist canon then synchronously project back to catalog.
      const canon = {
        characters: [{
          id: 'e1', ingredientId: ing.id, name: 'Loop Guard', role: 'before',
          updatedAt: ing.updatedAt,
        }],
      };
      const patch = await mutator(canon);
      expect(patch).not.toBeNull();
      const persisted = { ...canon, ...patch };
      await projectToCatalog(universeId, persisted, { guardToken: opts?.canonProjectionGuard });
      catalogWritesInsideEcho = updSpy.mock.calls.length - before;
      return persisted;
    });

    const updated = await catalogDB.updateIngredient(ing.id, { payload: { role: 'after' } });
    const writesAfterPrimary = updSpy.mock.calls.length;

    await projectToCanon(ing.id, updated, { updateUniverse });

    // The echo (projectToCatalog inside updateUniverse) must NOT have written
    // the originating catalog row — the guard token skipped it.
    expect(catalogWritesInsideEcho).toBe(0);
    expect(condSpy).not.toHaveBeenCalled();
    // Total catalog writes across the whole round-trip: only the primary edit.
    expect(updSpy.mock.calls.length).toBe(writesAfterPrimary);
    // Canon side written exactly once.
    expect(updateUniverse).toHaveBeenCalledTimes(1);
    updSpy.mockRestore();
    condSpy.mockRestore();
  });

  it('a catalog edit committed after the batched lookup survives a pending projection (#12503)', async () => {
    const uId = `u-proj-${Date.now()}-f`;
    const a = await makeLinkedCharacter(uId, { name: 'Race A' });
    const b = await makeLinkedCharacter(uId, { name: 'Race B' });
    await pinClock(a.id);
    await pinClock(b.id);
    const realWrite = catalogDB.updateIngredientIfFresh;
    // While A's write is pending, an explicit catalog PATCH commits B.
    const spy = vi.spyOn(catalogDB, 'updateIngredientIfFresh').mockImplementation(async (id, ...rest) => {
      if (id === a.id) await catalogDB.updateIngredient(b.id, { name: 'New catalog edit' });
      return realWrite(id, ...rest);
    });
    try {
      const stats = await projectToCatalog(uId, {
        characters: [canonEntry(a.id, 'Canon edit A', AFTER_PIN), canonEntry(b.id, 'Older canon edit', AFTER_PIN)],
      });
      expect(stats).toEqual({ written: 1, skipped: 1 });
    } finally {
      spy.mockRestore();
    }
    expect((await catalogDB.getIngredient(a.id)).name).toBe('Canon edit A');
    expect((await catalogDB.getIngredient(b.id)).name).toBe('New catalog edit');
    const { items } = await catalogDB.listIngredientRevisions(b.id);
    expect(items.filter((r) => r.actor === 'canon-projection')).toEqual([]);
  });

  it('two universe saves of one identity honor the same locked check', async () => {
    const ing = await makeLinkedCharacter(`u-proj-${Date.now()}-g`, { name: 'Shared' });
    await pinClock(ing.id);
    const realLookup = catalogDB.getIngredientTimestamps;
    let newerStats;
    // The older save takes its snapshot, then the newer save commits first.
    const spy = vi.spyOn(catalogDB, 'getIngredientTimestamps').mockImplementationOnce(async (...args) => {
      const snapshot = await realLookup(...args);
      newerStats = await projectToCatalog('u-newer', { characters: [canonEntry(ing.id, 'Newer universe save', LATER_AFTER_PIN)] });
      return snapshot;
    });
    try {
      const olderStats = await projectToCatalog('u-older', { characters: [canonEntry(ing.id, 'Older universe save', AFTER_PIN)] });
      expect(olderStats).toEqual({ written: 0, skipped: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(newerStats).toEqual({ written: 1, skipped: 0 });
    expect((await catalogDB.getIngredient(ing.id)).name).toBe('Newer universe save');
  });

  it('a newer duplicate in the same save supersedes the write made earlier in that save (#4006)', async () => {
    const uId = `u-proj-${Date.now()}-i`;
    const ing = await makeLinkedCharacter(uId, { name: 'Duplicate' });
    await pinClock(ing.id);
    const stats = await projectToCatalog(uId, {
      characters: [canonEntry(ing.id, 'First copy', AFTER_PIN)],
      places: [canonEntry(ing.id, 'Newer copy', LATER_AFTER_PIN)],
    });
    expect(stats).toEqual({ written: 2, skipped: 0 });
    expect((await catalogDB.getIngredient(ing.id)).name).toBe('Newer copy');
  });

  it('an equal-clock entry still writes; a row deleted after the lookup is skipped', async () => {
    const uId = `u-proj-${Date.now()}-h`;
    const equal = await makeLinkedCharacter(uId, { name: 'Equal' });
    const gone = await makeLinkedCharacter(uId, { name: 'Gone' });
    await pinClock(equal.id);
    await pinClock(gone.id);
    const realLookup = catalogDB.getIngredientTimestamps;
    const spy = vi.spyOn(catalogDB, 'getIngredientTimestamps').mockImplementationOnce(async (...args) => {
      const snapshot = await realLookup(...args);
      await catalogDB.deleteIngredient(gone.id);
      return snapshot;
    });
    try {
      const stats = await projectToCatalog(uId, {
        characters: [canonEntry(equal.id, 'Equal clock edit', PINNED_AT), canonEntry(gone.id, 'Revived?', AFTER_PIN)],
      });
      expect(stats).toEqual({ written: 1, skipped: 1 });
    } finally {
      spy.mockRestore();
    }
    expect((await catalogDB.getIngredient(equal.id)).name).toBe('Equal clock edit');
    expect(await catalogDB.getIngredient(gone.id)).toBeNull();
  });
});
