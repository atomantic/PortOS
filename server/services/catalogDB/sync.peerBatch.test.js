/**
 * Peer-apply batching: a multi-row envelope kind costs one transaction, one
 * set_config and one fence query (plus per-row SAVEPOINT + write), not 5 SQL
 * round-trips and a commit per row. Failure isolation and the standalone path
 * are pinned too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const log = [];
let failOn = null;
let fenceRows = [];
const client = {
  query: vi.fn(async (sql, params) => {
    const text = String(sql).trim();
    log.push(text.split(/\s+/).slice(0, 2).join(' '));
    if (text.startsWith('SELECT source_id')) return { rows: fenceRows };
    if (failOn && text.startsWith('INSERT') && params?.[1] === failOn) throw new Error('fk violation');
    return { rows: [{ ingredient_id: 'x' }], rowCount: 1 };
  }),
};
vi.mock('../../lib/db.js', async () => {
  const actual = await vi.importActual('../../lib/db.js');
  return {
    ...actual,
    query: vi.fn(),
    withTransaction: vi.fn(async (fn) => { log.push('BEGIN'); const r = await fn(client); log.push('COMMIT'); return r; }),
  };
});

const { upsertSourceFromPeer, withPeerIdentityBatch } = await import('./sync.js');

const src = (i, scrap = `s${i}`) => ({ ingredientId: `ing${i}`, scrapId: scrap, span: null, extractedAt: '2026-01-01' });

beforeEach(() => { log.length = 0; failOn = null; fenceRows = []; client.query.mockClear(); });

describe('withPeerIdentityBatch', () => {
  it('uses one transaction and one fence query for N rows', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => src(i));
    await withPeerIdentityBatch(rows.map((r) => r.ingredientId), async (batch) => {
      for (const r of rows) await batch.isolate(() => upsertSourceFromPeer(r, batch));
    });
    expect(log.filter((l) => l === 'BEGIN')).toHaveLength(1);
    expect(log.filter((l) => l.startsWith('SELECT set_config'))).toHaveLength(1);
    expect(log.filter((l) => l === 'SELECT source_id,')).toHaveLength(1);
    // set_config + fence + 20 × (SAVEPOINT + INSERT + RELEASE)
    expect(client.query.mock.calls.length).toBe(2 + 20 * 3);
  });

  it('isolates a failing row with a savepoint rollback', async () => {
    failOn = 'bad';
    const results = [];
    await withPeerIdentityBatch(['a', 'b'], async (batch) => {
      for (const r of [src(1), src(2, 'bad'), src(3)]) {
        results.push(await batch.isolate(() => upsertSourceFromPeer(r, batch)).catch((e) => e.message));
      }
    });
    expect(results[1]).toBe('fk violation');
    expect(results[0]).toBeUndefined();
    expect(results[2]).toBeUndefined();
    expect(log).toContain('ROLLBACK TO');
  });

  it('skips only rows whose identity is fenced', async () => {
    fenceRows = [{ source_id: 'ing1', survivor_id: 'zzz', state: 'prepared' }];
    const out = [];
    await withPeerIdentityBatch(['ing1', 'ing2'], async (batch) => {
      for (const r of [src(1), src(2)]) out.push(await upsertSourceFromPeer(r, batch));
    });
    expect(out[0]).toMatchObject({ protectedIdentity: true, identityPending: true, applied: false });
    expect(out[1]).toBeUndefined();
  });
});

describe('standalone upsert', () => {
  it('keeps its own transaction and fence check', async () => {
    await upsertSourceFromPeer(src(1));
    expect(log.filter((l) => l === 'BEGIN')).toHaveLength(1);
    expect(log.filter((l) => l === 'SELECT source_id,')).toHaveLength(1);
    fenceRows = [{ source_id: 'ing1', survivor_id: 'z', state: 'committed' }];
    expect(await upsertSourceFromPeer(src(1))).toMatchObject({ protectedIdentity: true, identityPending: false });
  });
});
