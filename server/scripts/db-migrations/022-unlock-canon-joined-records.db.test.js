/**
 * Migration 022 against a real PostgreSQL (`portos_test` only): it unlocks only
 * the records whose lock came from joining a universe's canon, and leaves every
 * deliberate or unprovable lock in place.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const { checkHealth, close, ensureSchema, query, withTransaction } = await import('../../lib/db.js');
const { requireDbOrSkip } = await import('../../lib/dbTestGate.js');
const { toPgJson } = await import('../../lib/pgJson.js');
const { up } = await import('./022-unlock-canon-joined-records.js');

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/022-unlock-canon-joined-records.db.test', health.connected, 'disposable PostgreSQL unavailable');

const key = randomUUID().slice(0, 8);
const id = (name) => `cat-chr-${key}-${name}`;
const universeId = `${key}-universe`;
const ingredientIds = [];

afterAll(async () => {
  if (runDb) {
    await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [ingredientIds]);
    await query('DELETE FROM universes WHERE id = $1', [universeId]);
  }
  if (health.connected) await close();
});

const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

// `revisions`: [payload, source, actor] oldest first.
async function seed(name, revisions) {
  const ingredientId = id(name);
  ingredientIds.push(ingredientId);
  const current = revisions.at(-1)[0];
  await query(`INSERT INTO catalog_ingredients (id, type, name, payload) VALUES ($1, 'character', $2, $3::jsonb)`,
    [ingredientId, `Ada ${name}`, toPgJson(current)]);
  for (const [n, [payload, source, actor]] of revisions.entries()) {
    await query(`INSERT INTO catalog_ingredient_revisions (id, ingredient_id, name, payload, source, actor, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`, [`cat-rev-${randomUUID()}`, ingredientId, `Ada ${name}`, toPgJson(payload), source, actor, at(n)]);
  }
  return ingredientId;
}

const joinEntry = (ingredientId) => ({ id: `character-${randomUUID()}`, ingredientId, name: 'Ada', locked: true, updatedAt: at(1) });
const PROJECTED = [{ locked: true }, 'sync', 'canon-projection'];
const CREATED = [{}, 'user', null];
const lockOf = async (ingredientId) => (await query('SELECT payload FROM catalog_ingredients WHERE id = $1', [ingredientId])).rows[0].payload.locked;
const universe = async () => (await query('SELECT data, updated_at FROM universes WHERE id = $1', [universeId])).rows[0];

describe.skipIf(!runDb)('db-migration 022 — unlock records locked by joining canon', () => {
  it('unlocks only the canon-join signature and keeps both stores agreeing', async () => {
    const bug = await seed('bug', [CREATED, PROJECTED]);
    const userLocked = await seed('user', [CREATED, [{ locked: true }, 'user', null]]);
    const promoted = await seed('promoted', [[{ locked: true }, 'user', null]]);
    const relocked = await seed('relocked', [CREATED, PROJECTED, [{ locked: false }, 'user', null], [{ locked: true }, 'user', null]]);
    const authored = await seed('authored', [CREATED, PROJECTED]);
    const pruned = await seed('pruned', [PROJECTED]);
    const shared = await seed('shared', [CREATED, PROJECTED]);
    const characters = [joinEntry(bug), joinEntry(userLocked), joinEntry(promoted), joinEntry(relocked),
      { id: `chr-${randomUUID()}`, ingredientId: authored, name: 'Ada', locked: true }, joinEntry(pruned),
      joinEntry(shared), { id: 'chr-example', ingredientId: shared, name: 'Ada', locked: true }];
    const universeClock = '2099-01-01T00:00:00.000Z';
    await query('INSERT INTO universes (id, name, data, updated_at) VALUES ($1, $2, $3::jsonb, $4)',
      [universeId, 'Example Universe', toPgJson({ id: universeId, name: 'Example Universe', characters, updatedAt: universeClock }), universeClock]);

    await withTransaction((client) => up(client));

    expect(await lockOf(bug)).toBe(false);
    for (const kept of [userLocked, promoted, relocked, authored, pruned, shared]) expect(await lockOf(kept)).toBe(true);
    const { rows: [revision] } = await query(`SELECT source, actor, payload FROM catalog_ingredient_revisions
      WHERE ingredient_id = $1 ORDER BY created_at DESC LIMIT 1`, [bug]);
    expect(revision).toMatchObject({ source: 'sync', actor: 'migration:022-unlock-canon-joined-records', payload: { locked: false } });

    const after = await universe();
    const { rows: [{ updated_at: recordClock }] } = await query('SELECT updated_at FROM catalog_ingredients WHERE id = $1', [bug]);
    expect(after.data.characters.find((e) => e.ingredientId === bug)).toMatchObject({ locked: false, updatedAt: recordClock.toISOString() });
    expect(after.data.characters.filter((e) => e.ingredientId !== bug).every((e) => e.locked === true)).toBe(true);
    expect(after.updated_at.toISOString()).toBe(after.data.updatedAt);
    expect(after.data.updatedAt > universeClock).toBe(true);

    // A re-run finds nothing left to unlock and rewrites nothing.
    await withTransaction((client) => up(client));
    expect((await universe()).data.updatedAt).toBe(after.data.updatedAt);
  });
});
