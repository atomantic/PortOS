import { beforeEach, describe, expect, it, vi } from 'vitest';

// The migration writes a PostgreSQL row through the universe store, so the
// store is the boundary to double. What these tests pin is the decision the
// migration makes ABOUT that boundary — specifically that a tombstone is
// treated as "the user deleted this", which `insertUniverseWithId` itself
// would happily overwrite.
const loadOneRaw = vi.fn();
const insertUniverseWithId = vi.fn();
vi.mock('../../server/services/universeBuilder.js', () => ({
  store: () => ({ loadOneRaw }),
  insertUniverseWithId: (...args) => insertUniverseWithId(...args),
}));

const { default: migration, REALITY_UNIVERSE_ID } = await import('./395-reality-universe-seed.js');

describe('migration 395 — Reality universe seed', () => {
  beforeEach(() => {
    loadOneRaw.mockReset();
    insertUniverseWithId.mockReset();
  });

  it('seeds one live factual Reality with the deterministic id and no invented copy', async () => {
    loadOneRaw.mockResolvedValue(null);

    await expect(migration.up({})).resolves.toEqual({ updated: 1 });

    expect(insertUniverseWithId).toHaveBeenCalledTimes(1);
    const seeded = insertUniverseWithId.mock.calls[0][0];
    expect(seeded).toMatchObject({
      id: REALITY_UNIVERSE_ID,
      name: 'Reality',
      factual: true,
      logline: '',
      premise: '',
      styleNotes: '',
    });
    // Reality must federate like any other universe — an ephemeral seed would
    // give each of the user's machines its own private copy.
    expect(seeded.ephemeral).toBeUndefined();
  });

  it('does NOT resurrect a Reality the user deleted', async () => {
    loadOneRaw.mockResolvedValue({ id: REALITY_UNIVERSE_ID, name: 'Reality', deleted: true });

    await expect(migration.up({})).resolves.toEqual({ updated: 0, reason: 'tombstoned' });
    expect(insertUniverseWithId).not.toHaveBeenCalled();
  });

  it('no-ops when the row is already present (re-run, or synced in from a peer)', async () => {
    loadOneRaw.mockResolvedValue({ id: REALITY_UNIVERSE_ID, name: 'Reality', deleted: false });

    await expect(migration.up({})).resolves.toEqual({ updated: 0, reason: 'already-seeded' });
    expect(insertUniverseWithId).not.toHaveBeenCalled();
  });
});
