/**
 * Postgres-backed round-trip for the mood board store (issue #911).
 *
 * Like projectsDB.test.js / mediaAssetIndex/db.test.js, this needs a live
 * PostgreSQL with the schema applied. If no DB is reachable (CI, fresh
 * checkout), it SKIPS cleanly rather than failing red. When a DB IS reachable it
 * exercises create/list/get/update + the item add/update/remove ops + the #1564
 * federation paths (soft-delete tombstone, LWW merge, prune, restore), cleaning
 * up its own rows after (only rows it created — no global table mutation).
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';

// Stub the conflict-journal so mergeBoardsFromSync exercises its DB persist + LWW
// decision WITHOUT writing real base-hash / journal files under data/ during the
// test:db run (the pure LWW decision itself is pinned in logic.test.js).
vi.mock('../../lib/conflictJournal.js', () => ({
  maybeJournalBeforeOverwrite: vi.fn().mockResolvedValue(undefined),
  setSyncBaseHash: vi.fn().mockResolvedValue(undefined),
  contentHashForRecord: vi.fn(() => 'test-hash'),
  flushBaseHashes: vi.fn().mockResolvedValue(undefined),
  deleteSyncBaseHash: vi.fn().mockResolvedValue(undefined),
}));

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'mood_boards') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'mood_boards table not present';
  }
}

if (!dbReady) console.log(`⏭️  moodBoard/db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('mood board DB round-trip', () => {
  let db;
  const created = [];
  beforeAll(async () => {
    db = await import('./db.js');
  });
  afterAll(async () => {
    for (const id of created) {
      await query(`DELETE FROM mood_boards WHERE id = $1`, [id]).catch(() => {});
    }
    // The pool is closed once, by the federation describe's afterAll (runs last).
  });

  it('creates, lists, and gets a board (lossless data)', async () => {
    const board = await db.createBoard({ name: 'Test board', description: 'd' });
    created.push(board.id);
    expect(board.id).toMatch(/^mb-/);
    expect(board.items).toEqual([]);

    const fetched = await db.getBoard(board.id);
    expect(fetched.name).toBe('Test board');
    expect(fetched.description).toBe('d');

    const list = await db.listBoards();
    expect(list.some((b) => b.id === board.id)).toBe(true);
  });

  it('updates board metadata', async () => {
    const board = await db.createBoard({ name: 'Rename me' });
    created.push(board.id);
    const updated = await db.updateBoard(board.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect((await db.getBoard(board.id)).name).toBe('Renamed');
  });

  it('adds, updates, and removes items', async () => {
    const board = await db.createBoard({ name: 'Items' });
    created.push(board.id);

    const item = await db.addBoardItem(board.id, { type: 'image', imageUrl: 'https://x/y.png' });
    expect(item.id).toMatch(/^mbi-/);
    expect((await db.getBoard(board.id)).items).toHaveLength(1);

    const patched = await db.updateBoardItem(board.id, item.id, { caption: 'cap' });
    expect(patched.caption).toBe('cap');

    const afterRemove = await db.removeBoardItem(board.id, item.id);
    expect(afterRemove.items).toHaveLength(0);
  });

  it('removeBoardItem is a no-op for an unknown item id', async () => {
    const board = await db.createBoard({ name: 'Noop' });
    created.push(board.id);
    const result = await db.removeBoardItem(board.id, 'mbi-nope');
    expect(result.items).toEqual([]);
  });

  it('throws NOT_FOUND for a missing board on get/update/delete', async () => {
    expect(await db.getBoard('mb-missing')).toBeNull();
    await expect(db.updateBoard('mb-missing', { name: 'x' })).rejects.toThrow(/not found/i);
    await expect(db.deleteBoard('mb-missing')).rejects.toThrow(/not found/i);
  });

  it('soft-deletes a board (tombstone), hiding it from live reads but not includeDeleted', async () => {
    const board = await db.createBoard({ name: 'Delete me' });
    created.push(board.id); // soft-delete leaves the row — afterAll hard-deletes it
    const result = await db.deleteBoard(board.id);
    expect(result.ok).toBe(true);
    // Live reads hide the tombstone…
    expect(await db.getBoard(board.id)).toBeNull();
    expect((await db.listBoards()).some((b) => b.id === board.id)).toBe(false);
    expect(await db.listBoardIds()).not.toContain(board.id);
    // …but includeDeleted surfaces it with the tombstone trio set.
    const tomb = await db.getBoard(board.id, { includeDeleted: true });
    expect(tomb).toMatchObject({ deleted: true });
    expect(typeof tomb.deletedAt).toBe('string');
    expect(await db.listBoardIds({ includeDeleted: true })).toContain(board.id);
    // Deleting again 404s (idempotent tombstone), and user mutators refuse it.
    await expect(db.deleteBoard(board.id)).rejects.toThrow(/not found/i);
    await expect(db.updateBoard(board.id, { name: 'zombie' })).rejects.toThrow(/not found/i);
    await expect(db.addBoardItem(board.id, { type: 'text', text: 'z' })).rejects.toThrow(/not found/i);
  });
});

describe.skipIf(!dbReady)('mood board federation (#1564)', () => {
  let db;
  const created = [];
  const remote = (id, over = {}) => ({
    id, name: `R-${id}`, description: '', items: [],
    createdAt: '2026-06-23T00:00:00.000Z', updatedAt: '2026-06-23T00:00:00.000Z',
    deleted: false, deletedAt: null, ...over,
  });
  beforeAll(async () => { db = await import('./db.js'); });
  afterAll(async () => {
    for (const id of created) await query(`DELETE FROM mood_boards WHERE id = $1`, [id]).catch(() => {});
    await close();
  });

  it('inserts a remote board on first merge', async () => {
    const id = `mb-fed-insert-${Date.now()}`;
    created.push(id);
    const res = await db.mergeBoardsFromSync([remote(id, { name: 'Inserted' })]);
    expect(res).toEqual({ applied: true, count: 1 });
    expect((await db.getBoard(id)).name).toBe('Inserted');
  });

  it('newer remote updatedAt wins; older loses', async () => {
    const id = `mb-fed-lww-${Date.now()}`;
    created.push(id);
    await db.mergeBoardsFromSync([remote(id, { name: 'v1', updatedAt: '2026-06-23T00:00:00.000Z' })]);
    // Older remote → no change.
    const older = await db.mergeBoardsFromSync([remote(id, { name: 'stale', updatedAt: '2026-06-22T00:00:00.000Z' })]);
    expect(older.applied).toBe(false);
    expect((await db.getBoard(id)).name).toBe('v1');
    // Newer remote → wins.
    await db.mergeBoardsFromSync([remote(id, { name: 'v2', updatedAt: '2026-06-24T00:00:00.000Z' })]);
    expect((await db.getBoard(id)).name).toBe('v2');
  });

  it('applies a remote tombstone (delete federates)', async () => {
    const id = `mb-fed-tomb-${Date.now()}`;
    created.push(id);
    await db.mergeBoardsFromSync([remote(id, { updatedAt: '2026-06-23T00:00:00.000Z' })]);
    await db.mergeBoardsFromSync([remote(id, { updatedAt: '2026-06-24T00:00:00.000Z', deleted: true, deletedAt: '2026-06-24T00:00:00.000Z' })]);
    expect(await db.getBoard(id)).toBeNull();
    expect(await db.getBoard(id, { includeDeleted: true })).toMatchObject({ deleted: true });
  });

  it('restoreBoard brings back name/description/items wholesale', async () => {
    const board = await db.createBoard({ name: 'Orig' });
    created.push(board.id);
    const items = [{ id: 'mbi-r1', type: 'text', text: 'restored', mediaKey: null, imageUrl: null, caption: null, source: null, createdAt: 't0' }];
    const restored = await db.restoreBoard(board.id, { name: 'Restored', description: 'd', items });
    expect(restored.name).toBe('Restored');
    expect(restored.items).toEqual(items);
    expect((await db.getBoard(board.id)).description).toBe('d');
  });

  it('pruneTombstonedBoards hard-removes tombstones older than the cutoff', async () => {
    const id = `mb-fed-prune-${Date.now()}`;
    created.push(id);
    await db.mergeBoardsFromSync([remote(id, { updatedAt: '2026-06-23T00:00:00.000Z', deleted: true, deletedAt: '2026-06-23T00:00:00.000Z' })]);
    const res = await db.pruneTombstonedBoards(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(res.pruned).toBeGreaterThanOrEqual(1);
    expect(await db.getBoard(id, { includeDeleted: true })).toBeNull();
  });
});
