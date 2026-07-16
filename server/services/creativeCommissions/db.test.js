/**
 * Postgres-backed round-trip for the Creative Commission DB adapter (#2657).
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never
 * the real `portos` DB (the db.js runner guard + the health-gate skip below
 * enforce this). If no test DB is reachable it SKIPS cleanly rather than failing
 * red. Every row uses a per-run nonce id prefix and is torn down in afterAll, so
 * the suite never touches unrelated rows and is safe on a shared test DB.
 *
 * Exercises the pure leaf I/O: verbatim record readback, list order, upsert
 * (created_at preserved on conflict), and hard delete (no tombstone — commissions
 * are machine-local). The scheduler-vs-request read-modify-write serialization
 * lives in the store facade's shared per-id write queue, not here, so it's
 * covered by the store tests + the shared fileWriteQueue suite.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { readRaw, listRaw, writeRaw, deleteRaw } from './db.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'creative_commissions') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'creative_commissions table not present';
  }
}

if (!dbReady) console.log(`⏭️  creativeCommissions/db.test.js skipped: ${skipReason}`);

const nonce = `cc${Date.now()}`;
const cid = (n) => `${nonce}-${n}`;

const rec = (id, over = {}) => ({
  id,
  name: `Commission ${id}`,
  enabled: true,
  targetAbility: 'video',
  brief: { intent: 'surreal', constraints: {} },
  schedule: { kind: 'DAILY', atLocalTime: '02:00' },
  generation: { quality: 'standard' },
  feedback: [],
  runs: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

afterAll(async () => {
  if (dbReady) {
    await query(`DELETE FROM creative_commissions WHERE id LIKE $1`, [`${nonce}-%`]).catch(() => {});
    await close();
  }
});

describe.skipIf(!dbReady)('creativeCommissions DB adapter round-trip', () => {
  it('writes and reads a record back verbatim', async () => {
    const r = rec(cid('rw'), { brief: { intent: 'noir', constraints: { universeId: 'u-1' } } });
    await writeRaw(r.id, r);
    expect(await readRaw(r.id)).toEqual(r);
  });

  it('returns null for a missing id', async () => {
    expect(await readRaw(cid('nope'))).toBeNull();
  });

  it('upserts on conflict — preserves created_at, updates data + mirror columns', async () => {
    const id = cid('upsert');
    await writeRaw(id, rec(id, { name: 'first' }));
    await writeRaw(id, rec(id, { name: 'second', enabled: false, createdAt: '2099-01-01T00:00:00.000Z' }));
    const back = await readRaw(id);
    expect(back.name).toBe('second');
    // created_at column is preserved on conflict (only the first INSERT sets it);
    // name/enabled mirror the new data.
    const col = await query(`SELECT created_at, name, enabled FROM creative_commissions WHERE id = $1`, [id]);
    expect(col.rows[0].created_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(col.rows[0].name).toBe('second');
    expect(col.rows[0].enabled).toBe(false);
  });

  it('lists commissions oldest-first (created_at ASC)', async () => {
    await writeRaw(cid('old'), rec(cid('old'), { createdAt: '2026-01-01T00:00:00.000Z' }));
    await writeRaw(cid('new'), rec(cid('new'), { createdAt: '2026-06-01T00:00:00.000Z' }));
    const ids = (await listRaw()).map((r) => r.id).filter((x) => x.startsWith(nonce));
    expect(ids.indexOf(cid('old'))).toBeLessThan(ids.indexOf(cid('new')));
  });

  it('hard-deletes a record (idempotent — no tombstone)', async () => {
    const id = cid('del');
    await writeRaw(id, rec(id));
    await deleteRaw(id);
    expect(await readRaw(id)).toBeNull();
    await expect(deleteRaw(id)).resolves.not.toThrow(); // idempotent
  });
});
