/**
 * Postgres-backed round-trip for the mood board store (issue #911).
 *
 * Like projectsDB.test.js / mediaAssetIndex/db.test.js, this needs a live
 * PostgreSQL with the schema applied. If no DB is reachable (CI, fresh
 * checkout), it SKIPS cleanly rather than failing red. When a DB IS reachable it
 * exercises create/list/get/update + the item add/update/remove ops, cleaning up
 * its own rows after (only rows it created — no global table mutation).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';

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
    await close();
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

  it('deletes a board', async () => {
    const board = await db.createBoard({ name: 'Delete me' });
    const result = await db.deleteBoard(board.id);
    expect(result.ok).toBe(true);
    expect(await db.getBoard(board.id)).toBeNull();
  });
});
