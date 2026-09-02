/**
 * Postgres-backed tests for the operator-action ledger (#5594):
 *   - insertUserActionEvent()  — idempotent insert via ON CONFLICT (type, dedupe_key)
 *   - listUserActionEvents()   — type / actor / success / time-window filters + paging
 *   - pruneUserActionEvents()  — the row cap AND the age cap
 *
 * These drive `userActionsDb.js` directly rather than `userActions.js`: the store
 * facade selects the FILE backend under NODE_ENV=test (which this config sets),
 * so the SQL is only reachable through the leaf module. Same split as
 * `postRunDb.db.test.js`.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never
 * the real `portos` DB (the db.js runner guard + the suite skip below enforce
 * this). The DB is shared across worktrees, so every row created here uses a
 * per-run nonce and is torn down in afterAll.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as db from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import {
  insertUserActionEvent,
  listUserActionEvents,
  pruneUserActionEvents,
} from './userActionsDb.js';
import { normalizeListOptions, normalizeUserAction } from './userActions.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/userActions.db.test', dbReady, skipReason);

const nonce = `ua${Date.now()}`;
const key = (suffix) => `${nonce}:${suffix}`;

// Start from an empty table: the row-cap assertion below is arithmetic over the
// GLOBAL row count, so a row stranded by a crashed earlier run would silently
// become the one the cap evicts. Safe here and nowhere else — this suite only
// ever runs against `portos_test`.
beforeAll(async () => {
  if (dbReady) await query('DELETE FROM user_action_events');
});

afterAll(async () => {
  if (dbReady) {
    await query('DELETE FROM user_action_events WHERE dedupe_key LIKE $1', [`${nonce}:%`]).catch(() => {});
    await close();
  }
});

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const event = (over = {}) => normalizeUserAction({
  type: 'cos.task.create',
  summary: 'Queued CoS task: example',
  dedupeKey: key(Math.random().toString(36).slice(2)),
  ...over,
});

// Scope every read to this run's rows — the table is shared with whatever the
// developer's own install wrote.
const listMine = async (options = {}) => {
  const rows = await listUserActionEvents(db, normalizeListOptions({ limit: 500, ...options }));
  return rows.filter((row) => row.dedupeKey.startsWith(`${nonce}:`));
};

describe.skipIf(!runDb)('user_action_events store (#5594)', () => {
  it('inserts and round-trips the full row shape', async () => {
    const row = event({
      dedupeKey: key('shape'),
      target: 'task-1',
      targetName: 'render the shot',
      payload: { taskId: 'task-1', provider: 'claude', apiKey: 'sk-EXAMPLE-not-real' },
      source: { route: '/api/cos/tasks', method: 'POST' },
      happenedAt: daysAgo(1),
    });
    expect(await insertUserActionEvent(db, row)).toBe(true);

    const [stored] = await listMine({ target: 'task-1' });
    expect(stored).toMatchObject({
      type: 'cos.task.create',
      actor: 'user',
      target: 'task-1',
      targetName: 'render the shot',
      success: true,
      dedupeKey: key('shape'),
      source: { route: '/api/cos/tasks', method: 'POST' },
    });
    // JSONB survives the round trip, and the recorder's redaction rode into it.
    expect(stored.payload).toMatchObject({ taskId: 'task-1', provider: 'claude' });
    expect(stored.payload.redactedKeys).toEqual(['apiKey']);
    expect(stored.payload).not.toHaveProperty('apiKey');
  });

  it('is idempotent on (type, dedupe_key) and scopes the key to the type', async () => {
    expect(await insertUserActionEvent(db, event({ dedupeKey: key('dup') }))).toBe(true);
    expect(await insertUserActionEvent(db, event({ dedupeKey: key('dup') }))).toBe(false);
    expect(await insertUserActionEvent(db, event({ type: 'cos.task.delete', dedupeKey: key('dup') }))).toBe(true);
  });

  it('filters by type, actor, success, and time window', async () => {
    await insertUserActionEvent(db, event({
      type: 'cos.schedule.trigger', dedupeKey: key('f1'), actor: 'user', happenedAt: daysAgo(9),
    }));
    await insertUserActionEvent(db, event({
      type: 'settings.update', dedupeKey: key('f2'), actor: 'system', success: false, happenedAt: daysAgo(5),
    }));

    expect((await listMine({ type: 'settings.update' })).map((r) => r.dedupeKey)).toEqual([key('f2')]);
    expect((await listMine({ actor: 'system' })).map((r) => r.dedupeKey)).toEqual([key('f2')]);
    expect((await listMine({ success: false })).map((r) => r.dedupeKey)).toEqual([key('f2')]);
    expect((await listMine({ types: ['cos.schedule.trigger', 'settings.update'] })).map((r) => r.dedupeKey))
      .toEqual([key('f2'), key('f1')]);
    expect((await listMine({ from: daysAgo(7), to: daysAgo(3) })).map((r) => r.dedupeKey)).toEqual([key('f2')]);
  });

  it('prunes past the age cap without touching fresher rows', async () => {
    await insertUserActionEvent(db, event({ dedupeKey: key('stale'), happenedAt: daysAgo(120) }));
    await insertUserActionEvent(db, event({ dedupeKey: key('recent'), happenedAt: daysAgo(1) }));

    await pruneUserActionEvents(db, {
      maxRows: 1_000_000,
      cutoffIso: daysAgo(90),
    });

    const keys = (await listMine()).map((r) => r.dedupeKey);
    expect(keys).not.toContain(key('stale'));
    expect(keys).toContain(key('recent'));
  });

  it('prunes past the row cap, keeping the newest', async () => {
    // The cap is global, so measure it against the live table: keep every row
    // that exists plus two of this run's three, and assert the OLDEST of the
    // three is the one that goes.
    for (const index of [0, 1, 2]) {
      await insertUserActionEvent(db, event({ dedupeKey: key(`cap${index}`), happenedAt: daysAgo(30 - index) }));
    }
    const total = Number((await query('SELECT COUNT(*)::int AS n FROM user_action_events')).rows[0].n);

    // Keep everything but one row; `cap0` is the oldest thing in the table.
    await pruneUserActionEvents(db, { maxRows: total - 1, cutoffIso: daysAgo(365) });

    const keys = (await listMine()).map((r) => r.dedupeKey);
    expect(keys).toContain(key('cap2'));
    expect(keys).toContain(key('cap1'));
    expect(keys).not.toContain(key('cap0'));
  });
});
