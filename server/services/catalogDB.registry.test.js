/**
 * Unit tests for the catalog DB layer's registry-driven behavior:
 *   - `createIngredient` stamps `payload.schemaVersion` from the registry;
 *   - it overwrites an incoming (stale/peer) schemaVersion with the LOCAL one;
 *   - the minted id uses the registry's per-type prefix;
 *   - an unknown type throws before touching the DB.
 *
 * Postgres is mocked — we capture the INSERT params and assert on them, so the
 * suite runs without a live database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = { sql: null, params: null };

vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    // createIngredient/reviveDeletedIngredient now also write + prune a
    // revision row, so the fake must dispatch on the statement: only capture
    // the catalog_ingredients write the assertions read, and no-op the
    // revision INSERT / prune DELETE.
    const s = sql.trim();
    if (/^INSERT INTO catalog_ingredient_revisions/i.test(s)) {
      const [id, ingredient_id, name] = params;
      return {
        rows: [{
          id, ingredient_id, name, payload: JSON.parse(params[3]),
          tags: params[4] || [], source: params[5], actor: params[6] ?? null,
          created_at: new Date(),
        }],
      };
    }
    if (/^DELETE FROM catalog_ingredient_revisions/i.test(s)) {
      return { rows: [] };
    }
    captured.sql = sql;
    captured.params = params;
    // Echo a row shaped like catalog_ingredients so rowToIngredient works.
    const [id, type, name] = params;
    const payload = JSON.parse(params[3]);
    return {
      rows: [{
        id, type, name, payload, tags: params[4] || [],
        embedding: null, embedding_model: null, origin_instance_id: params[7],
        created_at: new Date(), updated_at: new Date(),
        deleted: false, deleted_at: null, sync_sequence: 1,
      }],
    };
  }),
  withTransaction: vi.fn(),
  pgvectorToArray: vi.fn(() => null),
  arrayToPgvector: vi.fn((a) => a),
}));

vi.mock('./instances.js', () => ({
  getInstanceId: vi.fn(async () => 'inst-test'),
}));

import { createIngredient, reviveDeletedIngredient } from './catalogDB.js';
import { currentPayloadSchemaVersion } from '../lib/catalogTypes.js';

beforeEach(() => {
  captured.sql = null;
  captured.params = null;
});

describe('createIngredient — payload schemaVersion stamping', () => {
  it('stamps the registry-current payload schemaVersion', async () => {
    const ing = await createIngredient({ type: 'character', name: 'Echo', payload: { physicalDescription: 'tall' } });
    const stored = JSON.parse(captured.params[3]);
    expect(stored.schemaVersion).toBe(currentPayloadSchemaVersion('character'));
    expect(stored.physicalDescription).toBe('tall');
    // The returned record carries the stamped payload too.
    expect(ing.payload.schemaVersion).toBe(currentPayloadSchemaVersion('character'));
  });

  it('overwrites an incoming (stale) schemaVersion with the local one', async () => {
    await createIngredient({ type: 'idea', name: 'Spark', payload: { summary: 'x', schemaVersion: 99 } });
    const stored = JSON.parse(captured.params[3]);
    expect(stored.schemaVersion).toBe(currentPayloadSchemaVersion('idea'));
    expect(stored.schemaVersion).not.toBe(99);
  });

  it('stamps even when no payload is supplied', async () => {
    await createIngredient({ type: 'scene', name: 'Open' });
    const stored = JSON.parse(captured.params[3]);
    expect(stored.schemaVersion).toBe(currentPayloadSchemaVersion('scene'));
  });
});

describe('createIngredient — registry-derived id prefix + type guard', () => {
  it('mints an id with the registry per-type prefix', async () => {
    const ing = await createIngredient({ type: 'place', name: 'Dock' });
    expect(ing.id).toMatch(/^cat-plc-/);
  });

  it('preserves an explicit id (peer backfill) without minting', async () => {
    const ing = await createIngredient({ id: 'cat-chr-bible-abc', type: 'character', name: 'Echo' });
    expect(ing.id).toBe('cat-chr-bible-abc');
  });

  it('throws on an unknown type before touching the DB', async () => {
    await expect(createIngredient({ type: 'wardrobe', name: 'Cape' })).rejects.toThrow(/Invalid ingredient type/);
    expect(captured.params).toBeNull();
  });
});

describe('reviveDeletedIngredient — registry guard + payload stamping', () => {
  it('validates the type against the registry (not a stale prefix map)', async () => {
    await expect(reviveDeletedIngredient('cat-x-1', { type: 'wardrobe', name: 'Cape' }))
      .rejects.toThrow(/invalid type/);
    expect(captured.params).toBeNull();
  });

  it('re-stamps the payload schemaVersion on revive', async () => {
    await reviveDeletedIngredient('cat-chr-1', { type: 'character', name: 'Echo', payload: { role: 'lead' } });
    const stored = JSON.parse(captured.params[3]);
    expect(stored.schemaVersion).toBe(currentPayloadSchemaVersion('character'));
    expect(stored.role).toBe('lead');
  });
});
