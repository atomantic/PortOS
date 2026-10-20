/**
 * DB-backed regressions for #12500: the catalog LWW clock (`updated_at`) a
 * local change stamps must be strictly newer than the row it overwrites at
 * wire (millisecond) precision. Peers apply only `EXCLUDED.updated_at >`
 * the stored clock, so a regressed or same-millisecond clock is a version the
 * peer drops permanently once its cursor moves past it.
 *
 * Needs a live Postgres: the clock is assigned by the catalog triggers and
 * judged by the peer-apply SQL guard, neither of which a mocked query() runs.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import {
  createIngredient, updateIngredient, getIngredient, deleteIngredient, reviveDeletedIngredient,
} from './catalogDB/ingredients.js';
import { linkIngredientToRef } from './catalogDB/refs.js';
import { upsertIngredientFromPeer } from './catalogDB/sync.js';

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
const runDb = requireDbOrSkip('services/catalogSync.changeClock.db.test', dbReady, skipReason);

const createdIds = new Set();

afterAll(async () => {
  if (!dbReady) return;
  for (const id of createdIds) {
    await deleteIngredient(id, { hard: true }).catch(() => {});
  }
  await close();
});

async function makeIngredient(name) {
  const ing = await createIngredient({ type: 'idea', name, payload: {}, tags: [] });
  createdIds.add(ing.id);
  return ing;
}

// The receiving install: a separate row fed only through the peer-apply path.
function replicaOf(wire) {
  const id = `${wire.id}-replica-${randomUUID()}`;
  createdIds.add(id);
  return { id, apply: (version) => upsertIngredientFromPeer({ ...version, id }) };
}

const wireMs = (iso) => Date.parse(iso);

describe.skipIf(!runDb)('catalog conflict clock is monotonic at wire precision (#12500)', () => {
  it('a transaction that began before a committed edit still ships a newer clock, so the peer keeps both edits', async () => {
    const ing = await makeIngredient('Clock Subject');

    let resumeA;
    const gate = new Promise((resolve) => { resumeA = resolve; });
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    // Transaction A opens first (fixing its NOW()), then waits while B commits.
    const transactionA = withTransaction(async (tx) => {
      await tx.query('SELECT 1');
      markStarted();
      await gate;
      return updateIngredient(ing.id, { payload: { summary: 'late disjoint payload' } }, { client: tx });
    });
    await started;

    const versionB = await updateIngredient(ing.id, { name: 'Renamed By B' });
    const replica = replicaOf(versionB);
    expect(await replica.apply(versionB)).toMatchObject({ applied: true });

    resumeA();
    const versionA = await transactionA;
    expect(versionA.name).toBe('Renamed By B');
    expect(versionA.payload.summary).toBe('late disjoint payload');
    expect(wireMs(versionA.updatedAt)).toBeGreaterThan(wireMs(versionB.updatedAt));

    expect(await replica.apply(versionA)).toMatchObject({ applied: true });
    const onPeer = await getIngredient(replica.id);
    expect(onPeer.name).toBe('Renamed By B');
    expect(onPeer.payload.summary).toBe('late disjoint payload');
  });

  it('local changes inside one transaction (one NOW()) get distinct, ordered wire clocks, including tombstone and revival', async () => {
    const ing = await makeIngredient('Same Instant Subject');
    await linkIngredientToRef(ing.id, 'universe', 'u-test-12500', 'canon-character');

    const { ingredientClocks, refClocks } = await withTransaction(async (tx) => {
      const ingredientClocks = [];
      for (const set of [`name = 'Second Name'`, `payload = '{"summary":"x"}'::jsonb`, 'deleted = true, deleted_at = NOW()', 'deleted = false, deleted_at = NULL']) {
        const { rows } = await tx.query(`UPDATE catalog_ingredients SET ${set} WHERE id = $1 RETURNING updated_at`, [ing.id]);
        ingredientClocks.push(rows[0].updated_at.toISOString());
      }
      const refClocks = [];
      for (const set of ['deleted = true, deleted_at = NOW()', 'deleted = false, deleted_at = NULL']) {
        const { rows } = await tx.query(
          `UPDATE catalog_ingredient_refs SET ${set}
            WHERE ingredient_id = $1 AND ref_kind = 'universe' AND ref_id = 'u-test-12500' RETURNING updated_at`,
          [ing.id],
        );
        refClocks.push(rows[0].updated_at.toISOString());
      }
      return { ingredientClocks, refClocks };
    });

    const strictlyIncreasing = (clocks) => clocks.every((c, i) => i === 0 || wireMs(c) > wireMs(clocks[i - 1]));
    expect(wireMs(ingredientClocks[0])).toBeGreaterThan(wireMs(ing.updatedAt));
    expect(strictlyIncreasing(ingredientClocks)).toBe(true);
    expect(strictlyIncreasing(refClocks)).toBe(true);
  });

  it('a local edit, soft-delete and revival never move a future peer clock backward', async () => {
    const ing = await makeIngredient('Future Clock Subject');
    const futureClock = new Date(Date.now() + 60_000).toISOString();
    expect(await upsertIngredientFromPeer({ ...ing, name: 'From Skewed Peer', updatedAt: futureClock })).toMatchObject({ applied: true });

    const edited = await updateIngredient(ing.id, { name: 'Local After Future' });
    expect(wireMs(edited.updatedAt)).toBeGreaterThan(wireMs(futureClock));

    await deleteIngredient(ing.id);
    const { rows: [tombstone] } = await query('SELECT updated_at FROM catalog_ingredients WHERE id = $1', [ing.id]);
    expect(tombstone.updated_at.getTime()).toBeGreaterThan(wireMs(edited.updatedAt));

    const revived = await reviveDeletedIngredient(ing.id, { type: 'idea', name: 'Revived' });
    expect(wireMs(revived.updatedAt)).toBeGreaterThan(tombstone.updated_at.getTime());
  });

  it('no-op updates and a repeated inbound envelope create no new feed work', async () => {
    const ing = await makeIngredient('No-op Subject');
    const seq = async () => (await query('SELECT sync_sequence, updated_at FROM catalog_ingredients WHERE id = $1', [ing.id])).rows[0];

    const before = await seq();
    await query(`UPDATE catalog_ingredients SET name = name WHERE id = $1`, [ing.id]);
    expect(await seq()).toEqual(before);

    const envelope = { ...ing, name: 'Inbound Once', updatedAt: new Date(Date.now() + 60_000).toISOString() };
    expect(await upsertIngredientFromPeer(envelope)).toMatchObject({ applied: true });
    const afterApply = await seq();
    expect(afterApply.updated_at.toISOString()).toBe(envelope.updatedAt);
    expect(await upsertIngredientFromPeer(envelope)).toMatchObject({ applied: false });
    expect(await seq()).toEqual(afterApply);
  });
});
