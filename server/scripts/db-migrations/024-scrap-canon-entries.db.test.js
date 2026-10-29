import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { up, canonEntryId } from './024-scrap-canon-entries.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/024-scrap-canon-entries.db.test', health.connected, 'disposable PostgreSQL unavailable');
const universeId = `migration-${randomUUID()}`;
const ids = ['character', 'place', 'object', 'removed'].map(() => `cat-${randomUUID()}`);
afterAll(async () => {
  if (runDb) {
    await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [ids]);
    await query('DELETE FROM universes WHERE id = $1', [universeId]);
    await close();
  }
});

describe.skipIf(!runDb)('migration 024 scrap canon projection', () => {
  it('joins live canon refs once with deterministic unlocked entries and leaves removed refs alone', async () => {
    await query("INSERT INTO universes (id, name, data) VALUES ($1, 'Example', '{}'::jsonb)", [universeId]);
    for (const [index, type] of ['character', 'place', 'object', 'character'].entries()) {
      await query("INSERT INTO catalog_ingredients (id, type, name, payload) VALUES ($1, $2, 'Example', '{}'::jsonb)", [ids[index], type]);
      await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role, deleted)
        VALUES ($1, 'universe', $2, $3, $4)`, [ids[index], universeId, `canon-${type}`, index === 3]);
    }
    await withTransaction(up);
    const read = async () => (await query('SELECT data FROM universes WHERE id = $1', [universeId])).rows[0].data;
    const first = await read();
    for (const [index, field] of ['characters', 'places', 'objects'].entries()) {
      const type = ['character', 'place', 'object'][index];
      expect(first[field]).toEqual([expect.objectContaining({ ingredientId: ids[index], locked: false,
        id: canonEntryId(type, ids[index], universeId) })]);
    }
    await withTransaction(up);
    expect(await read()).toEqual(first);
    // No qualifying input changes no universe clocks or data.
    await query('DELETE FROM catalog_ingredient_refs WHERE ingredient_id = ANY($1)', [ids]);
    await withTransaction(up);
    expect(await read()).toEqual(first);
  });
  it('holds universe locks and rechecks memberships removed after candidate discovery', async () => {
    await query("UPDATE universes SET data = '{}'::jsonb WHERE id = $1", [universeId]);
    await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
      VALUES ($1, 'universe', $2, 'canon-character')`, [ids[0], universeId]);
    await withTransaction(async (client) => up({ query: async (sql, params) => {
      const lockingUniverseRead = sql.startsWith('SELECT id, data, updated_at FROM universes');
      if (lockingUniverseRead) {
        // A removal wins the race between candidate discovery and row locking.
        await query("UPDATE catalog_ingredient_refs SET deleted = true WHERE ingredient_id = $1", [ids[0]]);
      }
      const result = await client.query(sql, params);
      if (lockingUniverseRead) {
        await expect(withTransaction(async (other) => {
          await other.query("SET LOCAL lock_timeout = '100ms'");
          await other.query("UPDATE universes SET name = 'Concurrent edit' WHERE id = $1", [universeId]);
        })).rejects.toMatchObject({ code: '55P03' });
      }
      return result;
    } }));
    const { rows: [saved] } = await query('SELECT data FROM universes WHERE id = $1', [universeId]);
    expect(saved.data.characters || []).toEqual([]);
  });

});
