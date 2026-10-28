/**
 * Migration 023 against a real PostgreSQL (`portos_test` only): records created
 * inside a universe join its canon once, and records whose missing membership
 * is deliberate (owner set later, membership removed, forks) stay as they are.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const { checkHealth, close, ensureSchema, query, withTransaction } = await import('../../lib/db.js');
const { requireDbOrSkip } = await import('../../lib/dbTestGate.js');
const { toPgJson } = await import('../../lib/pgJson.js');
const { up, canonEntryId } = await import('./023-owned-records-join-universe-canon.js');

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/023-owned-records-join-universe-canon.db.test', health.connected, 'disposable PostgreSQL unavailable');

const key = randomUUID().slice(0, 8);
const universeId = `${key}-universe`;
const ingredientIds = [];
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const UNIVERSE_CLOCK = '2099-02-01T00:00:00.000Z';

afterAll(async () => {
  if (runDb) {
    await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [ingredientIds]);
    await query('DELETE FROM universes WHERE id = $1', [universeId]);
  }
  if (health.connected) await close();
});

async function seed(name, { type = 'character', payload = {}, ownerAt = CREATED_AT } = {}) {
  const ingredientId = `cat-${key}-${name}`;
  ingredientIds.push(ingredientId);
  await query(`INSERT INTO catalog_ingredients (id, type, name, payload, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [ingredientId, type, `Ada ${name}`, toPgJson(payload), CREATED_AT]);
  await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role, created_at) VALUES ($1, 'universe', $2, 'owner', $3)`,
    [ingredientId, universeId, ownerAt]);
  return ingredientId;
}

const canonRoles = async (ingredientId) => (await query(`SELECT role, deleted FROM catalog_ingredient_refs
  WHERE ingredient_id = $1 AND role LIKE 'canon-%'`, [ingredientId])).rows;
const universe = async () => (await query('SELECT data, updated_at FROM universes WHERE id = $1', [universeId])).rows[0];

describe.skipIf(!runDb)('db-migration 023 — owned records join their universe canon', () => {
  it('backfills canon membership only for records created inside the universe', async () => {
    const character = await seed('character', { payload: { physicalDescription: 'Brass goggles.' } });
    const place = await seed('place', { type: 'place', payload: { description: 'Fog over piers.' } });
    const locked = await seed('locked', { type: 'object', payload: { locked: true } });
    const ownedLater = await seed('owned-later', { ownerAt: '2026-01-05T00:00:00.000Z' });
    const removed = await seed('removed');
    await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role, deleted, deleted_at)
      VALUES ($1, 'universe', $2, 'canon-character', true, NOW())`, [removed, universeId]);
    const fork = await seed('fork');
    await query(`INSERT INTO catalog_ingredient_relations (from_id, to_id, kind) VALUES ($1, $2, 'forked-from')`, [fork, character]);
    const present = await seed('present');
    const existing = { id: 'chr-example', ingredientId: present, name: 'Ada present', locked: true };
    await query('INSERT INTO universes (id, name, data, updated_at) VALUES ($1, $2, $3::jsonb, $4)', [universeId, 'Example Universe',
      toPgJson({ id: universeId, name: 'Example Universe', characters: [existing], updatedAt: UNIVERSE_CLOCK }), UNIVERSE_CLOCK]);

    await withTransaction((client) => up(client));

    const after = await universe();
    const { rows: clocks } = await query('SELECT id, updated_at FROM catalog_ingredients WHERE id = ANY($1)', [[character, place, locked]]);
    const clockOf = (ingredientId) => clocks.find((row) => row.id === ingredientId).updated_at.toISOString();
    expect(after.data.characters).toEqual([existing, {
      physicalDescription: 'Brass goggles.', locked: false, id: canonEntryId('character', character, universeId),
      ingredientId: character, name: 'Ada character', updatedAt: clockOf(character),
    }]);
    expect(after.data.places).toMatchObject([{ ingredientId: place, description: 'Fog over piers.', locked: false }]);
    expect(after.data.objects).toMatchObject([{ ingredientId: locked, locked: true }]);
    expect(await canonRoles(character)).toEqual([{ role: 'canon-character', deleted: false }]);
    expect(await canonRoles(place)).toEqual([{ role: 'canon-place', deleted: false }]);
    for (const untouched of [ownedLater, fork, present]) expect(await canonRoles(untouched)).toEqual([]);
    expect(await canonRoles(removed)).toEqual([{ role: 'canon-character', deleted: true }]);
    // An unmodified peer rejects equal timestamps, so the backfill must
    // advance even a universe clock that is ahead of the local wall clock.
    expect(after.updated_at.toISOString() > UNIVERSE_CLOCK).toBe(true);
    expect(after.data.updatedAt).toBe(after.updated_at.toISOString());

    await withTransaction((client) => up(client));
    const again = await universe();
    expect(again.data.characters).toHaveLength(2);
    expect(again.data.places).toHaveLength(1);
    expect(again.data.updatedAt).toBe(after.data.updatedAt);
  });
});
