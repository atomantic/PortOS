/**
 * Tests for the boot-time canon↔catalog reconciliation.
 *
 * fs/promises (marker), fileUtils (PATHS), universeBuilder (listUniverses /
 * updateUniverse) and catalogDB (getIngredient / updateIngredient) are mocked,
 * so this exercises the walk + LWW-merge + dual-write orchestration:
 *   - newer catalog row wins → stamped back onto the embedded canon entry;
 *   - newer embedded entry wins → written into the catalog row;
 *   - entries without an ingredientId are untouched;
 *   - a clean pass writes the marker; a second run is a marker-gated no-op.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = { marker: null, written: null };
const dbState = { rows: {}, updates: [] };
const uniState = { universes: [], canonStamps: [] };

// Marker I/O is delegated to migrationMarker.js; mock it against `fsState`
// (the marker helper has its own unit test in server/lib/migrationMarker.test.js).
vi.mock('../lib/migrationMarker.js', () => ({
  readMarker: vi.fn(async () => fsState.marker),
  writeMarker: vi.fn(async (_name, payload) => { fsState.written = payload; }),
}));

vi.mock('../services/universeBuilder.js', () => ({
  listUniverses: vi.fn(async () => uniState.universes),
  updateUniverse: vi.fn(async (id, mutator) => {
    const cur = uniState.universes.find((u) => u.id === id);
    const patch = mutator(cur || {});
    uniState.canonStamps.push({ id, patch });
    return patch;
  }),
}));

vi.mock('../services/catalogDB.js', () => ({
  getIngredient: vi.fn(async (id) => dbState.rows[id] || null),
  updateIngredient: vi.fn(async (id, patch, ctx) => {
    dbState.updates.push({ id, patch, ctx });
    // Simulate the real DB trigger: a write bumps updated_at to "now" (a clock
    // strictly later than any fixture timestamp). This is what makes the
    // mid-pass clock-mutation bug observable — a later universe comparing
    // against the LIVE row would see this fresh clock.
    if (dbState.rows[id]) {
      dbState.rows[id] = { ...dbState.rows[id], ...patch, updatedAt: '2099-01-01T00:00:00.000Z' };
    }
    return dbState.rows[id];
  }),
}));

const { reconcileCanonCatalog } = await import('./reconcileCanonCatalog.js');

beforeEach(() => {
  fsState.marker = null;
  fsState.written = null;
  dbState.rows = {};
  dbState.updates = [];
  uniState.universes = [];
  uniState.canonStamps = [];
});

describe('reconcileCanonCatalog', () => {
  it('catalog row newer → stamps catalog payload back onto the embedded canon entry', async () => {
    const past = '2026-01-01T00:00:00.000Z';
    const future = '2026-02-01T00:00:00.000Z';
    dbState.rows['cat-chr-1'] = { id: 'cat-chr-1', name: 'Ada', payload: { role: 'catalog-role' }, updatedAt: future };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-1', name: 'Ada', role: 'canon-role', updatedAt: past }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.skipped).toBe(false);
    expect(result.stats.catalogWon).toBe(1);
    expect(result.stats.canonWon).toBe(0);
    // No catalog write (catalog already authoritative); one canon stamp.
    expect(dbState.updates).toHaveLength(0);
    expect(uniState.canonStamps).toHaveLength(1);
    const stamped = uniState.canonStamps[0].patch.characters[0];
    expect(stamped.role).toBe('catalog-role');
  });

  it('embedded canon entry newer → writes it into the catalog row', async () => {
    const past = '2026-01-01T00:00:00.000Z';
    const future = '2026-02-01T00:00:00.000Z';
    dbState.rows['cat-chr-2'] = { id: 'cat-chr-2', name: 'Bee', payload: { role: 'old' }, updatedAt: past };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-2', name: 'Bee', role: 'fresh', updatedAt: future }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.stats.canonWon).toBe(1);
    expect(result.stats.catalogWon).toBe(0);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].patch.payload.role).toBe('fresh');
    expect(dbState.updates[0].ctx.source).toBe('sync');
    // No canon stamp needed (canon already authoritative).
    expect(uniState.canonStamps).toHaveLength(0);
  });

  it('multi-universe: the NEWEST embedded copy wins; a mid-pass row bump cannot clobber it', async () => {
    // Same ingredient embedded in three universes. Original catalog row is the
    // oldest. Two embedded copies beat it (u-mid @ Feb, u-new @ Mar); the third
    // (u-old @ 2025) loses to the original. The newest (u-new, Mar) must end up
    // in the catalog row — NOT u-mid just because it was iterated, and NOT lost
    // to the artificially-fresh clock the first write stamps on the row.
    dbState.rows['cat-chr-m'] = { id: 'cat-chr-m', name: 'Multi', payload: { v: 'orig' }, updatedAt: '2026-01-01T00:00:00.000Z' };
    uniState.universes = [
      { id: 'u-old', characters: [{ id: 'e', ingredientId: 'cat-chr-m', name: 'Multi', v: 'old', updatedAt: '2025-01-01T00:00:00.000Z' }] },
      { id: 'u-mid', characters: [{ id: 'e', ingredientId: 'cat-chr-m', name: 'Multi', v: 'mid', updatedAt: '2026-02-01T00:00:00.000Z' }] },
      { id: 'u-new', characters: [{ id: 'e', ingredientId: 'cat-chr-m', name: 'Multi', v: 'new', updatedAt: '2026-03-01T00:00:00.000Z' }] },
    ];

    const result = await reconcileCanonCatalog();

    // u-old loses to the original row (catalog stamped back onto it); u-mid and
    // u-new each beat the ORIGINAL row, but only the strictly-newer copy writes.
    const payloadsWritten = dbState.updates.map((u) => u.patch.payload.v);
    // The FINAL catalog content must be the newest embedded copy ('new'),
    // regardless of write order, and 'mid' must never be the last write.
    expect(dbState.rows['cat-chr-m'].payload.v).toBe('new');
    expect(payloadsWritten).toContain('new');
    expect(payloadsWritten[payloadsWritten.length - 1]).toBe('new');
    // u-old never wins.
    expect(payloadsWritten).not.toContain('old');
  });

  it('leaves entries without an ingredientId untouched', async () => {
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', name: 'Unpromoted', role: 'x', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.stats.scanned).toBe(0);
    expect(dbState.updates).toHaveLength(0);
    expect(uniState.canonStamps).toHaveLength(0);
  });

  it('writes the completion marker on a clean pass', async () => {
    dbState.rows['cat-chr-3'] = { id: 'cat-chr-3', name: 'C', payload: {}, updatedAt: '2026-01-01T00:00:00.000Z' };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-3', name: 'C', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }];

    const result = await reconcileCanonCatalog();
    expect(result.markerWritten).toBe(true);
    expect(fsState.written.version).toBe(1);
  });

  it('second run is a marker-gated no-op', async () => {
    fsState.marker = { version: 1, completedAt: '2026-01-01T00:00:00.000Z' };
    dbState.rows['cat-chr-4'] = { id: 'cat-chr-4', name: 'D', payload: { role: 'x' }, updatedAt: '2026-02-01T00:00:00.000Z' };
    uniState.universes = [{
      id: 'u-1',
      characters: [{ id: 'e1', ingredientId: 'cat-chr-4', name: 'D', role: 'y', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }];

    const result = await reconcileCanonCatalog();

    expect(result.skipped).toBe(true);
    expect(dbState.updates).toHaveLength(0);
    expect(uniState.canonStamps).toHaveLength(0);
  });
});
