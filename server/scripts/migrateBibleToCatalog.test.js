/**
 * Idempotency tests for the bible→catalog backfill.
 *
 * The migration is wired into boot and MUST be safe to run repeatedly: a
 * second run (with `force: true`, since the marker would otherwise short-
 * circuit it) must promote zero new ingredients because every embedded entry
 * already carries the deterministic `ingredientId` stamped by the first run.
 *
 * The migration's two DB dependencies (`universeBuilder`, `catalogDB`) are
 * replaced with in-memory fakes so the test needs no Postgres. The marker
 * file I/O (`fs/promises`) is mocked to an in-memory blob so we can assert
 * the short-circuit-on-marker behavior without touching disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- In-memory universe store --------------------------------------------
// Mutable so the migration's Phase-2 `updateUniverse` mutator can stamp
// ingredientId back onto entries and a second run sees the stamped shape.
let universes = [];

vi.mock('../services/universeBuilder.js', () => ({
  // Honor `includeDeleted` like the real service (the migration calls it with
  // `{ includeDeleted: false }`), so the in-source `if (universe.deleted)`
  // guard can be exercised independently by overriding this mock per-test.
  listUniverses: vi.fn(async ({ includeDeleted = true } = {}) =>
    (includeDeleted ? universes : universes.filter((u) => !u.deleted))),
  updateUniverse: vi.fn(async (id, patchOrMutator) => {
    const u = universes.find((x) => x.id === id);
    if (!u) return null;
    const patch = typeof patchOrMutator === 'function' ? patchOrMutator(u) : patchOrMutator;
    if (!patch) return u;
    Object.assign(u, patch);
    return u;
  }),
}));

// --- In-memory catalog store ---------------------------------------------
// Keyed by id. `createIngredient` mirrors the real one's PK-conflict throw so
// a non-idempotent migration (re-INSERT at a deterministic id) would surface
// as a thrown error / errors counter bump.
let ingredients = new Map();
let refLinks = []; // { ingredientId, refKind, refId, role }

const createIngredient = vi.fn(async ({ id, type, name, payload = {}, tags = [] }) => {
  if (ingredients.has(id)) {
    throw new Error(`duplicate key value violates unique constraint (id=${id})`);
  }
  const row = { id, type, name, payload, tags, deleted: false };
  ingredients.set(id, row);
  return row;
});

const getIngredient = vi.fn(async (id) => {
  const row = ingredients.get(id);
  return row && !row.deleted ? row : null;
});

const reviveDeletedIngredient = vi.fn(async (id, { type, name, payload, tags }) => {
  const row = ingredients.get(id);
  if (!row || !row.deleted) return null;
  Object.assign(row, { deleted: false, type, name, payload, tags });
  return row;
});

const linkIngredientToRef = vi.fn(async (ingredientId, refKind, refId, role) => {
  const exists = refLinks.some(
    (r) => r.ingredientId === ingredientId && r.refKind === refKind && r.refId === refId && r.role === role,
  );
  if (!exists) refLinks.push({ ingredientId, refKind, refId, role });
});

vi.mock('../services/catalogDB.js', () => ({
  createIngredient: (...args) => createIngredient(...args),
  getIngredient: (...args) => getIngredient(...args),
  reviveDeletedIngredient: (...args) => reviveDeletedIngredient(...args),
  linkIngredientToRef: (...args) => linkIngredientToRef(...args),
}));

// --- In-memory marker file -----------------------------------------------
// Marker I/O is delegated to migrationMarker.js; mock it against `markerBlob`
// (the marker helper has its own unit test in server/lib/migrationMarker.test.js).
let markerBlob = null; // string | null
vi.mock('../lib/migrationMarker.js', () => ({
  readMarker: vi.fn(async () => (markerBlob === null ? null : JSON.parse(markerBlob))),
  writeMarker: vi.fn(async (_name, payload) => { markerBlob = JSON.stringify(payload); }),
}));

import { migrateBibleToCatalog } from './migrateBibleToCatalog.js';
import { listUniverses } from '../services/universeBuilder.js';

function makeUniverse(overrides = {}) {
  return {
    id: 'u-1',
    deleted: false,
    characters: [
      { id: 'c-1', name: 'Echo Saint', physicalDescription: 'A wiry figure.' },
      { id: 'c-2', name: 'Mirror Doe', personality: 'Wry' },
    ],
    places: [{ id: 'p-1', name: 'Old Harbor', description: 'Brine.' }],
    objects: [{ id: 'o-1', name: 'Brass Key' }],
    ...overrides,
  };
}

beforeEach(() => {
  universes = [makeUniverse()];
  ingredients = new Map();
  refLinks = [];
  markerBlob = null;
  vi.clearAllMocks();
});

describe('migrateBibleToCatalog', () => {
  it('promotes every embedded canon entry on the first run', async () => {
    const result = await migrateBibleToCatalog();
    expect(result.skipped).toBe(false);
    expect(result.stats.universesScanned).toBe(1);
    // 2 characters + 1 place + 1 object = 4 promotions.
    expect(result.stats.promoted).toBe(4);
    expect(result.stats.errors).toBe(0);
    expect(ingredients.size).toBe(4);
    // Each entry got its ingredientId stamped back onto the universe.
    const u = universes[0];
    expect(u.characters.every((c) => typeof c.ingredientId === 'string')).toBe(true);
    expect(u.places[0].ingredientId).toMatch(/^cat-plc-bible-/);
    expect(u.objects[0].ingredientId).toMatch(/^cat-obj-bible-/);
    // One ref link per promoted entry.
    expect(refLinks).toHaveLength(4);
  });

  it('is idempotent: a second run promotes nothing new and inserts no duplicate rows', async () => {
    await migrateBibleToCatalog();
    const firstSize = ingredients.size;
    const createCallsAfterFirst = createIngredient.mock.calls.length;

    // Force a second run (the marker would otherwise short-circuit it).
    const second = await migrateBibleToCatalog({ force: true });

    expect(second.skipped).toBe(false);
    expect(second.stats.promoted).toBe(0);
    expect(second.stats.errors).toBe(0);
    // No new ingredient rows, no duplicate-key throws.
    expect(ingredients.size).toBe(firstSize);
    expect(createIngredient.mock.calls.length).toBe(createCallsAfterFirst);
    // The skipped counter accounts for every already-promoted entry.
    expect(second.stats.skipped).toBe(4);
  });

  it('short-circuits when the marker is already at the current version', async () => {
    await migrateBibleToCatalog();
    // Marker is now written; a plain (non-forced) re-run must no-op.
    const rerun = await migrateBibleToCatalog();
    expect(rerun.skipped).toBe(true);
    expect(rerun.marker.version).toBe(1);
  });

  it('re-links an already-promoted entry that lost its ref (idempotent linking)', async () => {
    await migrateBibleToCatalog();
    // Drop the ref links but keep the stamped ingredientId + catalog rows.
    refLinks = [];

    const second = await migrateBibleToCatalog({ force: true });
    expect(second.stats.promoted).toBe(0);
    // linkIngredientToRef is re-asserted for each already-promoted entry,
    // re-creating the 4 missing links without minting new ingredients.
    expect(refLinks).toHaveLength(4);
    expect(ingredients.size).toBe(4);
  });

  it('skips a soft-deleted universe via the in-source guard even if listUniverses leaks it', async () => {
    universes = [makeUniverse({ deleted: true })];
    // Force listUniverses to RETURN the deleted universe (simulating a stale
    // service that ignores includeDeleted, or a peer-synced delete flag) so the
    // migration's own `if (universe.deleted) continue` is the thing under test —
    // not the listUniverses filter. Without this override the mock would honor
    // includeDeleted:false and the guard would never be reached.
    listUniverses.mockResolvedValueOnce(universes);
    const result = await migrateBibleToCatalog();
    expect(result.stats.universesScanned).toBe(0);
    expect(result.stats.promoted).toBe(0);
    expect(ingredients.size).toBe(0);
  });

  it('preserves a foreign ingredientId stamped by a peer instead of minting a new one', async () => {
    // Simulate a peer that already promoted this character under a random id.
    universes[0].characters[0].ingredientId = 'cat-chr-peer-abc123';
    const result = await migrateBibleToCatalog();
    expect(ingredients.has('cat-chr-peer-abc123')).toBe(true);
    // The other three entries still promote under deterministic ids.
    expect(result.stats.promoted).toBe(4);
  });
});
