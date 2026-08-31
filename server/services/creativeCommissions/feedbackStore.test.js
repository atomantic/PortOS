import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'commission-feedback-test-'));
const writeCounter = vi.hoisted(() => ({ baseHash: 0 }));

// In-memory collectionStore (same posture as store.test.js) so CRUD + merge are
// exercised without the filesystem or Postgres.
const feedbackRecords = new Map();
const journalRecords = new Map();
const makeMemStore = (records) => ({
  loadAll: async () => [...records.values()],
  loadOne: async (id) => records.get(id) || null,
  saveOne: async (id, rec) => { records.set(id, rec); },
  saveOneNow: async (id, rec) => { records.set(id, rec); },
  deleteOne: async (id) => { records.delete(id); },
  deleteOneNow: async (id) => { records.delete(id); },
  saveTypeIndex: async () => {},
  verifySchemaVersion: async () => ({ ok: true }),
});
vi.mock('../../lib/collectionStore.js', () => ({
  createCollectionStore: ({ type }) => makeMemStore(type === 'conflictJournal' ? journalRecords : feedbackRecords),
}));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
    atomicWrite: async (path, data) => {
      if (typeof path === 'string' && path.endsWith('sync_base_hashes.json')) writeCounter.baseHash += 1;
      return actual.atomicWrite(path, data);
    },
  };
});
// Keep federation side-effects inert in this store-level unit test.
const emitRecordUpdated = vi.fn();
const emitRecordDeleted = vi.fn();
const autoSubscribeRecordToAllPeers = vi.fn(() => Promise.resolve());
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers }));
const {
  recordFeedback,
  listFeedbackForCommission,
  listFeedbackByCommissionIds,
  getCommissionFeedbackForSync,
  listCommissionFeedbackForSync,
  listCommissionFeedbackIdsForSync,
  mergeCommissionFeedbackFromSync,
  pruneTombstonedCommissionFeedback,
  restoreCommissionFeedback,
  deleteCommissionFeedback,
  backfillInlineFeedback,
} = await import('./feedbackStore.js');
const cj = await import('../../lib/conflictJournal.js');

beforeEach(() => {
  feedbackRecords.clear();
  journalRecords.clear();
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
  cj.__resetBaseHashCacheForTests();
  writeCounter.baseHash = 0;
  vi.clearAllMocks();
});
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('recordFeedback + hydration', () => {
  it('writes one federated record per reaction (deterministic id per run) and subscribes peers', async () => {
    const rec = await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 'up', note: 'more Magritte' });
    expect(rec.id).toBe('cfeedback-run-A');
    expect(rec).toMatchObject({ commissionId: 'c1', runId: 'run-A', rating: 'up', note: 'more Magritte' });
    expect(autoSubscribeRecordToAllPeers).toHaveBeenCalledWith('commissionFeedback', 'cfeedback-run-A');
    const inline = await listFeedbackForCommission('c1');
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ runId: 'run-A', rating: 'up', note: 'more Magritte' });
  });

  it('re-rating the same run LWW-updates in place (one reaction per run)', async () => {
    await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 'up', note: 'first' });
    const createdAt = feedbackRecords.get('cfeedback-run-A').createdAt;
    await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 'down', note: 'changed my mind' });
    const all = [...feedbackRecords.values()].filter((r) => r.runId === 'run-A');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ rating: 'down', note: 'changed my mind', createdAt });
  });

  it('returns null for an unusable rating', async () => {
    expect(await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 0 })).toBeNull();
  });

  it('caps live reactions per commission by tombstoning the oldest excess (sync-safe bound)', async () => {
    const { MAX_LIVE_FEEDBACK_PER_COMMISSION } = await import('./feedbackStore.js');
    const N = MAX_LIVE_FEEDBACK_PER_COMMISSION + 3;
    for (let i = 0; i < N; i++) {
      await recordFeedback({ commissionId: 'c1', runId: `run-${String(i).padStart(4, '0')}`, rating: 'up', at: new Date(2026, 0, 1, 0, i).toISOString() });
    }
    const live = await listFeedbackForCommission('c1');
    expect(live).toHaveLength(MAX_LIVE_FEEDBACK_PER_COMMISSION);
    // The 3 oldest runs were tombstoned (not array-dropped) — their rows survive with deleted:true.
    expect(live.some((f) => f.runId === 'run-0000')).toBe(false);
    expect(feedbackRecords.get('cfeedback-run-0000')).toMatchObject({ deleted: true });
    // The newest survives.
    expect(live.some((f) => f.runId === `run-${String(N - 1).padStart(4, '0')}`)).toBe(true);
  });

  it('hydrates only the requested commission and orders oldest-first', async () => {
    await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 'up', note: 'a' });
    await recordFeedback({ commissionId: 'c2', runId: 'run-B', rating: 'down', note: 'b' });
    const c1 = await listFeedbackForCommission('c1');
    expect(c1.map((f) => f.runId)).toEqual(['run-A']);
    const map = await listFeedbackByCommissionIds(['c1', 'c2']);
    expect(map.get('c1')).toHaveLength(1);
    expect(map.get('c2')).toHaveLength(1);
  });
});

describe('federation facades', () => {
  it('merges an incoming remote reaction (LWW) and exposes it for sync', async () => {
    const remote = { id: 'cfeedback-run-Z', commissionId: 'c9', runId: 'run-Z', rating: 'up', note: 'peer', at: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z' };
    const res = await mergeCommissionFeedbackFromSync([remote], { source: { via: 'sync', peerId: 'peer-a' } });
    expect(res).toEqual({ applied: true, count: 1 });
    const forSync = await getCommissionFeedbackForSync('cfeedback-run-Z');
    expect(forSync).toMatchObject({ id: 'cfeedback-run-Z', rating: 'up' });
    const live = await listCommissionFeedbackForSync();
    expect(live).toEqual([{ id: 'cfeedback-run-Z', updatedAt: '2026-05-05T00:00:00.000Z' }]);
  });

  it('re-applies the per-commission cap AFTER a sync merge (two peers reconciling cannot exceed the bound)', async () => {
    const { MAX_LIVE_FEEDBACK_PER_COMMISSION } = await import('./feedbackStore.js');
    // Simulate a reconnection delivering a batch that pushes past the cap.
    const batch = Array.from({ length: MAX_LIVE_FEEDBACK_PER_COMMISSION + 5 }, (_, i) => ({
      id: `cfeedback-run-${String(i).padStart(4, '0')}`, commissionId: 'c9', runId: `run-${i}`,
      rating: 'up', at: new Date(2026, 0, 1, 0, i).toISOString(), updatedAt: new Date(2026, 0, 1, 0, i).toISOString(),
    }));
    await mergeCommissionFeedbackFromSync(batch, { source: { via: 'sync', peerId: 'peer-a' } });
    const live = await listFeedbackForCommission('c9');
    expect(live).toHaveLength(MAX_LIVE_FEEDBACK_PER_COMMISSION);
  });

  it('a stale remote does not clobber a newer local reaction', async () => {
    await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 'down', note: 'newer' });
    feedbackRecords.get('cfeedback-run-A').updatedAt = '2026-09-09T00:00:00.000Z';
    const stale = { id: 'cfeedback-run-A', commissionId: 'c1', runId: 'run-A', rating: 'up', note: 'older', at: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' };
    const res = await mergeCommissionFeedbackFromSync([stale], { source: { via: 'sync', peerId: 'peer-a' } });
    expect(res.count).toBe(0);
    expect(feedbackRecords.get('cfeedback-run-A').note).toBe('newer');
  });

  it('soft-deletes (tombstones) and prunes past a cutoff, then lists ids incl. deleted', async () => {
    await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 'up' });
    const del = await deleteCommissionFeedback('cfeedback-run-A');
    expect(del).toEqual({ id: 'cfeedback-run-A', deleted: true });
    expect(emitRecordDeleted).toHaveBeenCalledWith('commissionFeedback', 'cfeedback-run-A');
    // tombstone excluded from the live view but present in the includeDeleted id list
    expect(await listFeedbackForCommission('c1')).toEqual([]);
    expect(await listCommissionFeedbackIdsForSync({ includeDeleted: true })).toContain('cfeedback-run-A');
    // Backdate the tombstone so it's older than the cutoff, then prune.
    feedbackRecords.get('cfeedback-run-A').deletedAt = '2020-01-01T00:00:00.000Z';
    const pruned = await pruneTombstonedCommissionFeedback(Date.parse('2021-01-01T00:00:00.000Z'));
    expect(pruned.pruned).toBe(1);
    expect(feedbackRecords.has('cfeedback-run-A')).toBe(false);
  });

  it('prunes multiple tombstoned reactions with one base-hash write', async () => {
    const oldOne = {
      id: 'cfeedback-run-old-1', commissionId: 'c1', runId: 'run-old-1', rating: 'up',
      note: '', tags: [], at: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
      deleted: true, deletedAt: '2020-01-01T00:00:00.000Z',
    };
    const oldTwo = {
      ...oldOne, id: 'cfeedback-run-old-2', runId: 'run-old-2',
      at: '2020-01-02T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
      deletedAt: '2020-01-02T00:00:00.000Z',
    };
    const newer = {
      ...oldOne, id: 'cfeedback-run-new', runId: 'run-new',
      at: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z',
      deletedAt: '2099-01-01T00:00:00.000Z',
    };
    await mergeCommissionFeedbackFromSync([oldOne, oldTwo, newer]);
    expect(await cj.getSyncBaseHash('commissionFeedback', oldOne.id)).not.toBeNull();
    expect(await cj.getSyncBaseHash('commissionFeedback', oldTwo.id)).not.toBeNull();

    writeCounter.baseHash = 0;
    const result = await pruneTombstonedCommissionFeedback(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(result).toEqual({ pruned: 2, ids: [oldOne.id, oldTwo.id] });
    expect(writeCounter.baseHash).toBe(1);
    expect(await cj.getSyncBaseHash('commissionFeedback', oldOne.id)).toBeNull();
    expect(await cj.getSyncBaseHash('commissionFeedback', oldTwo.id)).toBeNull();
    expect(feedbackRecords.has(newer.id)).toBe(true);
  });

  it('restores a tombstoned reaction from a snapshot, un-deleting it', async () => {
    await recordFeedback({ commissionId: 'c1', runId: 'run-A', rating: 'up', note: 'x' });
    await deleteCommissionFeedback('cfeedback-run-A');
    const restored = await restoreCommissionFeedback('cfeedback-run-A', { rating: 'down', note: 'restored' });
    expect(restored).toMatchObject({ deleted: false, rating: 'down', note: 'restored' });
    expect(emitRecordUpdated).toHaveBeenCalledWith('commissionFeedback', 'cfeedback-run-A');
    expect(await restoreCommissionFeedback('cfeedback-missing', {})).toBeNull();
  });
});

describe('backfillInlineFeedback', () => {
  it('migrates legacy inline reactions once, never clobbering a newer federated one', async () => {
    const wrote = await backfillInlineFeedback('c1', [
      { id: 'feedback-legacy', runId: 'run-A', rating: 'up', note: 'legacy', at: '2026-01-01T00:00:00.000Z' },
      { runId: 'run-B', rating: 'down', note: 'legacy2', at: '2026-01-02T00:00:00.000Z' },
    ]);
    expect(wrote).toBe(true);
    // run-A got a deterministic id; run-B too.
    expect(feedbackRecords.has('cfeedback-run-A')).toBe(true);
    expect(feedbackRecords.has('cfeedback-run-B')).toBe(true);
    // Re-running is a no-op (records already present → never clobber).
    feedbackRecords.get('cfeedback-run-A').note = 'peer-updated';
    const again = await backfillInlineFeedback('c1', [{ runId: 'run-A', rating: 'up', note: 'legacy', at: '2026-01-01T00:00:00.000Z' }]);
    expect(again).toBe(false);
    expect(feedbackRecords.get('cfeedback-run-A').note).toBe('peer-updated');
  });

  it('is a no-op for empty/absent inline feedback', async () => {
    expect(await backfillInlineFeedback('c1', [])).toBe(false);
    expect(await backfillInlineFeedback('c1', null)).toBe(false);
  });

  it('is idempotent for a run-LESS legacy reaction (stable id from the legacy id, no duplicate on retry)', async () => {
    const legacy = [{ id: 'feedback-old-uuid', rating: 'up', note: 'legacy', at: '2026-01-01T00:00:00.000Z' }];
    expect(await backfillInlineFeedback('c1', legacy)).toBe(true);
    const idsAfterFirst = [...feedbackRecords.keys()];
    expect(idsAfterFirst).toHaveLength(1);
    // A retry (e.g. clearInlineFeedback failed the first time) must not duplicate it.
    expect(await backfillInlineFeedback('c1', legacy)).toBe(false);
    expect([...feedbackRecords.keys()]).toEqual(idsAfterFirst);
  });
});
