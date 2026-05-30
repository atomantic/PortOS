/**
 * Route tests for the user-defined catalog TYPE CRUD endpoints
 * (GET/POST/PATCH/DELETE /api/catalog/types).
 *
 * Pure — settings + catalogDB are mocked so no Postgres or real settings.json
 * is touched. The settings mock keeps an in-memory `catalogUserTypes` slice so
 * create → list → delete round-trips through the same code path the live
 * routes use, without writing to disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// In-memory settings store the route's getSettings/updateSettings read/write.
let store = {};
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ ...store })),
  updateSettings: vi.fn(async (patch) => { store = { ...store, ...patch }; return { ...store }; }),
}));

// listIngredients drives the delete-in-use guard. Default: no ingredients.
let ingredientsForType = [];
vi.mock('../services/catalogDB.js', () => ({
  listIngredients: vi.fn(async () => ({ items: ingredientsForType, nextOffset: 0 })),
}));
// catalogSync is imported by the route module's `import * as catalogSync`.
vi.mock('../services/catalogSync.js', () => ({}));

const router = (await import('./catalog.js')).default;
// Reset the in-process registry between tests via the real module.
const { setUserCatalogTypes, getActiveCatalogType } = await import('../lib/catalogTypes.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/catalog', router);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  store = {};
  ingredientsForType = [];
  setUserCatalogTypes([]);
});

describe('GET /api/catalog/types', () => {
  it('returns the active registry (system first) including a synced user type', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }] };
    setUserCatalogTypes(store.catalogUserTypes);
    const res = await request(makeApp()).get('/api/catalog/types');
    expect(res.status).toBe(200);
    const ids = res.body.types.map((t) => t.id);
    expect(ids.slice(0, 6)).toEqual(['character', 'place', 'object', 'idea', 'scene', 'concept']);
    expect(ids).toContain('faction');
    expect(res.body.types.find((t) => t.id === 'faction').system).toBe(false);
    expect(res.body.types.find((t) => t.id === 'character').system).toBe(true);
  });
});

describe('POST /api/catalog/types', () => {
  it('creates a user type, persists it, and refreshes the registry', async () => {
    const body = { id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [{ key: 'creed', label: 'Creed', kind: 'longtext' }] };
    const res = await request(makeApp()).post('/api/catalog/types').send(body);
    expect(res.status).toBe(201);
    expect(res.body.types.some((t) => t.id === 'faction')).toBe(true);
    expect(store.catalogUserTypes).toHaveLength(1);
    // Registry refreshed in-process.
    expect(getActiveCatalogType('faction')?.label).toBe('Faction');
  });

  it('rejects a duplicate id with 409', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }] };
    const res = await request(makeApp())
      .post('/api/catalog/types')
      .send({ id: 'faction', label: 'Again', primaryContentKey: 'x', fields: [] });
    expect(res.status).toBe(409);
  });

  it('rejects an id colliding with a built-in system type (400 via slice refinement)', async () => {
    const res = await request(makeApp())
      .post('/api/catalog/types')
      .send({ id: 'character', label: 'Hijack', primaryContentKey: 'x', fields: [] });
    expect(res.status).toBe(400);
  });

  it('400s a malformed body (non-slug id)', async () => {
    const res = await request(makeApp())
      .post('/api/catalog/types')
      .send({ id: 'Faction!', label: 'X', primaryContentKey: 'x', fields: [] });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/catalog/types/:id', () => {
  it('updates an existing user type', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }] };
    const res = await request(makeApp())
      .patch('/api/catalog/types/faction')
      .send({ label: 'Guild', primaryContentKey: 'creed', fields: [] });
    expect(res.status).toBe(200);
    expect(res.body.types.find((t) => t.id === 'faction').label).toBe('Guild');
    expect(store.catalogUserTypes[0].label).toBe('Guild');
  });

  it('404s an unknown id', async () => {
    const res = await request(makeApp())
      .patch('/api/catalog/types/ghost')
      .send({ label: 'X', primaryContentKey: 'x', fields: [] });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/catalog/types/:id', () => {
  it('soft-deletes an unused type (tombstone kept so the delete federates, gone from the registry)', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }] };
    const res = await request(makeApp()).delete('/api/catalog/types/faction');
    expect(res.status).toBe(200);
    // The entry is RETAINED with a deletedAt tombstone (so the deletion syncs
    // to peers) but no longer appears in the active registry response.
    expect(store.catalogUserTypes).toHaveLength(1);
    expect(store.catalogUserTypes[0].deletedAt).toBeTruthy();
    expect(res.body.types.some((t) => t.id === 'faction')).toBe(false);
    expect(getActiveCatalogType('faction')).toBeUndefined();
  });

  it('refuses to delete a type with ingredients (409) unless ?force=true', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }] };
    ingredientsForType = [{ id: 'cat-fac-1' }];
    const refused = await request(makeApp()).delete('/api/catalog/types/faction');
    expect(refused.status).toBe(409);
    // Slice untouched on the refused delete (still live, no tombstone).
    expect(store.catalogUserTypes).toHaveLength(1);
    expect(store.catalogUserTypes[0].deletedAt).toBeFalsy();
    // Forced delete tombstones the definition anyway.
    const forced = await request(makeApp()).delete('/api/catalog/types/faction?force=true');
    expect(forced.status).toBe(200);
    expect(store.catalogUserTypes[0].deletedAt).toBeTruthy();
    expect(forced.body.types.some((t) => t.id === 'faction')).toBe(false);
  });

  it('404s a DELETE on an already-tombstoned type', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [], deletedAt: '2026-01-01T00:00:00.000Z' }] };
    const res = await request(makeApp()).delete('/api/catalog/types/faction');
    expect(res.status).toBe(404);
  });

  it('POST revives a tombstoned id (replaces the slot, clears the tombstone)', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Old', primaryContentKey: 'creed', fields: [], deletedAt: '2026-01-01T00:00:00.000Z' }] };
    const res = await request(makeApp())
      .post('/api/catalog/types')
      .send({ id: 'faction', label: 'Reborn', primaryContentKey: 'creed', fields: [] });
    expect(res.status).toBe(201);
    expect(store.catalogUserTypes).toHaveLength(1);
    expect(store.catalogUserTypes[0].deletedAt).toBeNull();
    expect(getActiveCatalogType('faction')?.label).toBe('Reborn');
  });

  it('404s an unknown id', async () => {
    const res = await request(makeApp()).delete('/api/catalog/types/ghost');
    expect(res.status).toBe(404);
  });
});
