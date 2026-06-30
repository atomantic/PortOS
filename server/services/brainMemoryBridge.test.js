import { describe, it, expect, vi, beforeEach } from 'vitest';

// The bridge memoizes its parsed bridge-map in a module-level variable
// (loadBridgeMap caches), so each test resets the module registry and
// re-imports a fresh copy to stay isolated. Mocks are declared with
// vi.mock (hoisted) so they apply to every fresh import; shared mock fns
// live in module scope so assertions can reach them after re-import.

let bridgeFileContents = null; // null = file absent

const createMemory = vi.fn(async (data) => ({ id: `mem-${data.content?.slice(0, 6) || 'x'}` }));
const updateMemory = vi.fn(async () => ({ id: 'updated' }));
const updateMemoryEmbedding = vi.fn(async () => {});
const deleteMemory = vi.fn(async () => ({ success: true }));
const generateMemoryEmbedding = vi.fn(async () => [0.1, 0.2, 0.3]);
const getById = vi.fn();
const getAll = vi.fn(async () => []);
const getDigests = vi.fn(async () => []);
const getReviews = vi.fn(async () => []);
const listJournals = vi.fn(async () => ({ records: [] }));
const getJournal = vi.fn();

vi.mock('fs', () => ({ existsSync: vi.fn(() => bridgeFileContents !== null) }));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => bridgeFileContents ?? '{}'),
  writeFile: vi.fn(async (_path, data) => { bridgeFileContents = data; }),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { brain: '/tmp/test-brain' },
  ensureDir: vi.fn(async () => {}),
  // atomicWrite replaced the raw writeFile(JSON.stringify) bridge-map site (#1837);
  // route it through the mocked fs/promises.writeFile so it updates
  // bridgeFileContents and a reloaded bridge sees the persisted map.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
}));
vi.mock('./memoryBackend.js', () => ({ createMemory, updateMemory, updateMemoryEmbedding, deleteMemory }));
vi.mock('./memoryEmbeddings.js', () => ({ generateMemoryEmbedding }));
vi.mock('./brainStorage.js', () => {
  const { EventEmitter } = require('events');
  return { brainEvents: new EventEmitter(), getById, getAll, getDigests, getReviews };
});
vi.mock('./brainJournal.js', () => ({ listJournals, getJournal }));

// Re-import a fresh bridge module (clears the cached bridge map).
async function loadBridge() {
  vi.resetModules();
  return import('./brainMemoryBridge.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeFileContents = null;
});

describe('brainMemoryBridge — resyncBrainRecord (issue #1080)', () => {
  it('re-embeds a present, non-archived synced-in record', async () => {
    const bridge = await loadBridge();
    getById.mockResolvedValue({ id: 'p1', name: 'Alice', context: 'met at conf' });

    await bridge.resyncBrainRecord('people', 'p1');

    expect(getById).toHaveBeenCalledWith('people', 'p1');
    expect(createMemory).toHaveBeenCalledTimes(1); // no prior map → new vector
  });

  it('archives the mapped memory when the record is gone (tombstoned)', async () => {
    const bridge = await loadBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p2')]: 'mem-existing' });
    getById.mockResolvedValue(null); // getById returns null for tombstones

    await bridge.resyncBrainRecord('people', 'p2');

    expect(updateMemory).toHaveBeenCalledWith('mem-existing', { status: 'archived' });
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('archives the mapped memory when the record is archived', async () => {
    const bridge = await loadBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('projects', 'pr1')]: 'mem-proj' });
    getById.mockResolvedValue({ id: 'pr1', name: 'X', status: 'done', archived: true });

    await bridge.resyncBrainRecord('projects', 'pr1');

    expect(updateMemory).toHaveBeenCalledWith('mem-proj', { status: 'archived' });
  });

  it('reads journals via getJournal, not getById', async () => {
    const bridge = await loadBridge();
    getJournal.mockResolvedValue({ id: '2026-06-09', date: '2026-06-09', content: 'a good day' });

    await bridge.resyncBrainRecord('journals', '2026-06-09');

    expect(getJournal).toHaveBeenCalledWith('2026-06-09');
    expect(getById).not.toHaveBeenCalled();
    expect(createMemory).toHaveBeenCalledTimes(1);
  });

  it('no-ops for a type the bridge does not mirror (links/buckets/inbox)', async () => {
    const bridge = await loadBridge();

    await bridge.resyncBrainRecord('links', 'l1');
    await bridge.resyncBrainRecord('inbox', 'i1');

    expect(getById).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('no archive call when a deleted record was never mapped', async () => {
    const bridge = await loadBridge();
    getById.mockResolvedValue(null);

    await bridge.resyncBrainRecord('people', 'never-seen');

    expect(updateMemory).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('hard-deletes the mapped memory for a tombstoned record when hardDelete:true (local delete, #1318)', async () => {
    const bridge = await loadBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p2')]: 'mem-existing' });
    getById.mockResolvedValue(null); // tombstoned

    await bridge.resyncBrainRecord('people', 'p2', { hardDelete: true });

    expect(deleteMemory).toHaveBeenCalledWith('mem-existing', true);
    expect(updateMemory).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('soft-archives (never hard-deletes) a tombstoned record when hardDelete is absent (synced delete stays recoverable)', async () => {
    const bridge = await loadBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p2')]: 'mem-existing' });
    getById.mockResolvedValue(null);

    await bridge.resyncBrainRecord('people', 'p2'); // sync:applied path — no hardDelete

    expect(updateMemory).toHaveBeenCalledWith('mem-existing', { status: 'archived' });
    expect(deleteMemory).not.toHaveBeenCalled();
  });

  it('soft-archives (never hard-deletes) a present-but-archived record even when hardDelete:true', async () => {
    const bridge = await loadBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('projects', 'pr1')]: 'mem-proj' });
    getById.mockResolvedValue({ id: 'pr1', name: 'X', status: 'done', archived: true });

    await bridge.resyncBrainRecord('projects', 'pr1', { hardDelete: true });

    // Archived ≠ deleted — keep it recoverable, do not drop the row.
    expect(updateMemory).toHaveBeenCalledWith('mem-proj', { status: 'archived' });
    expect(deleteMemory).not.toHaveBeenCalled();
  });

  it('no hard-delete call when a deleted record was never mapped', async () => {
    const bridge = await loadBridge();
    getById.mockResolvedValue(null);

    await bridge.resyncBrainRecord('people', 'never-seen', { hardDelete: true });

    expect(deleteMemory).not.toHaveBeenCalled();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('reactivates an archived memory when its record comes back live (status:active)', async () => {
    const bridge = await loadBridge();
    // p1 is already mapped (memory was archived for a prior synced-in delete);
    // now the record resolves live again. The re-embed must reset status:active
    // or memory search (which filters status='active') keeps hiding it.
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p1')]: 'mem-resurrect' });
    getById.mockResolvedValue({ id: 'p1', name: 'Alice', context: 'back again' });

    await bridge.resyncBrainRecord('people', 'p1');

    expect(updateMemory).toHaveBeenCalledWith('mem-resurrect', expect.objectContaining({ status: 'active' }));
    expect(createMemory).not.toHaveBeenCalled();
  });
});

describe('brainMemoryBridge — queueResync debounce + dedup', () => {
  it('dedups repeated touches of the same record and drops unmirrored types', async () => {
    const bridge = await loadBridge();
    getById.mockResolvedValue({ id: 'p1', name: 'Alice' });

    bridge.queueResync([
      { type: 'people', id: 'p1' },
      { type: 'people', id: 'p1' }, // duplicate — collapses
      { type: 'links', id: 'l1' },  // unmirrored — dropped
    ]);
    await bridge.flushPendingResync(); // flush deterministically

    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith('people', 'p1');
  });

  it('keeps a hard-delete sticky when a later soft touch coalesces onto the same key (#1318)', async () => {
    const bridge = await loadBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p1')]: 'mem-del' });
    getById.mockResolvedValue(null); // still tombstoned at flush time

    // Local delete marks p1 for a hard prune; a concurrent sync:applied (no flag)
    // coalesces onto the same key before the flush. The hard intent must survive.
    bridge.queueResync([{ type: 'people', id: 'p1', hardDelete: true }]);
    bridge.queueResync([{ type: 'people', id: 'p1' }]);
    await bridge.flushPendingResync();

    expect(deleteMemory).toHaveBeenCalledWith('mem-del', true);
    expect(updateMemory).not.toHaveBeenCalledWith('mem-del', { status: 'archived' });
  });

  it('processes the queue sequentially across multiple records', async () => {
    const bridge = await loadBridge();
    getById.mockImplementation(async (_type, id) => ({ id, name: id }));

    bridge.queueResync([
      { type: 'people', id: 'a' },
      { type: 'projects', id: 'b' },
      { type: 'ideas', id: 'c' },
    ]);
    await bridge.flushPendingResync();

    expect(getById).toHaveBeenCalledTimes(3);
  });

  it('ignores a non-array payload without throwing', async () => {
    const bridge = await loadBridge();

    expect(() => bridge.queueResync(undefined)).not.toThrow();
    expect(() => bridge.queueResync(null)).not.toThrow();
    await bridge.flushPendingResync();

    expect(getById).not.toHaveBeenCalled();
  });

  it('single-flights overlapping flushes so a record is never embedded twice', async () => {
    const bridge = await loadBridge();
    // Slow embed for p1 — while the first flush is awaiting it, a second
    // sync:applied for the SAME not-yet-mapped record arrives. Without the
    // single-flight guard, a second flush would start and createMemory twice.
    let resolveFirst;
    const gate = new Promise((r) => { resolveFirst = r; });
    let calls = 0;
    getById.mockImplementation(async (_type, id) => {
      calls += 1;
      if (id === 'p1' && calls === 1) await gate; // hold the first resync open
      return { id, name: id };
    });

    bridge.queueResync([{ type: 'people', id: 'p1' }]);
    const inFlight = bridge.flushPendingResync(); // begins, awaits the gate on p1
    // Same record re-queued mid-flush + a direct flush attempt (the re-arm path).
    bridge.queueResync([{ type: 'people', id: 'p1' }]);
    const second = bridge.flushPendingResync(); // must early-return (guard), not run concurrently
    resolveFirst();
    await Promise.all([inFlight, second]);

    // p1 was mapped by the first create; the re-drain sees it mapped → update,
    // not a second create. Exactly one memory created for p1.
    expect(createMemory).toHaveBeenCalledTimes(1);
  });

  it('re-vectorizes when brainEvents emits sync:applied (end-to-end wiring)', async () => {
    const bridge = await loadBridge();
    const { brainEvents } = await import('./brainStorage.js');
    bridge.initBridge();
    getById.mockResolvedValue({ id: 'p1', name: 'Alice' });

    brainEvents.emit('sync:applied', { records: [{ type: 'people', id: 'p1' }] });
    await bridge.flushPendingResync();

    expect(getById).toHaveBeenCalledWith('people', 'p1');
    expect(createMemory).toHaveBeenCalledTimes(1);
  });
});

describe('brainMemoryBridge — entity :upserted/:deleted route through queueResync (bulk-create throttle)', () => {
  it('does NOT embed synchronously on a single :upserted — it enqueues for the debounced flush', async () => {
    const bridge = await loadBridge();
    const { brainEvents } = await import('./brainStorage.js');
    bridge.initBridge();
    getById.mockResolvedValue({ id: 'm1', title: 'note', content: 'hi' });

    brainEvents.emit('memories:upserted', { id: 'm1', record: { id: 'm1', title: 'note' } });
    // Before the flush nothing has been embedded — the burst is only queued.
    expect(getById).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();

    await bridge.flushPendingResync();
    // After the flush it re-reads canonical state and embeds exactly once.
    expect(getById).toHaveBeenCalledWith('memories', 'm1');
    expect(createMemory).toHaveBeenCalledTimes(1);
  });

  it('coalesces a tight burst of N :upserted events into N sequential resyncs (one per distinct id)', async () => {
    const bridge = await loadBridge();
    const { brainEvents } = await import('./brainStorage.js');
    bridge.initBridge();
    getById.mockImplementation(async (_type, id) => ({ id, title: id, content: id }));

    // Simulate the ChatGPT import creating many conversations back-to-back.
    for (let i = 0; i < 50; i++) {
      brainEvents.emit('memories:upserted', { id: `c${i}`, record: { id: `c${i}` } });
    }
    // A repeat touch of an already-queued id collapses (dedup).
    brainEvents.emit('memories:upserted', { id: 'c0', record: { id: 'c0' } });

    await bridge.flushPendingResync();

    // 50 distinct ids → 50 reads, NOT 51 — and they ran through the sequential
    // queue, not 51 concurrent fire-and-forget embeds.
    expect(getById).toHaveBeenCalledTimes(50);
    expect(createMemory).toHaveBeenCalledTimes(50);
  });

  it('routes a local :deleted through the resync path, HARD-deleting the mapped memory (issue #1318)', async () => {
    const bridge = await loadBridge();
    const { brainEvents } = await import('./brainStorage.js');
    bridge.initBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p9')]: 'mem-del' });
    getById.mockResolvedValue(null); // deleted/tombstoned → getById returns null

    brainEvents.emit('people:deleted', { id: 'p9' });
    await bridge.flushPendingResync();

    // Real local delete → hard prune (drop row + embedding), NOT soft archive.
    expect(deleteMemory).toHaveBeenCalledWith('mem-del', true);
    expect(updateMemory).not.toHaveBeenCalledWith('mem-del', { status: 'archived' });
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('drops the bridge-map entry after a local hard-delete so a re-create starts fresh', async () => {
    const bridge = await loadBridge();
    const { brainEvents } = await import('./brainStorage.js');
    bridge.initBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p9')]: 'mem-del' });
    getById.mockResolvedValue(null);

    brainEvents.emit('people:deleted', { id: 'p9' });
    await bridge.flushPendingResync();

    const map = await bridge.loadBridgeMap();
    expect(map[bridge.bridgeKey('people', 'p9')]).toBeUndefined();
  });

  it('hard-deletes the mapped memory on a local journals:deleted (issue #1318)', async () => {
    const bridge = await loadBridge();
    const { brainEvents } = await import('./brainStorage.js');
    bridge.initBridge();
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('journals', '2026-06-09')]: 'mem-day' });

    brainEvents.emit('journals:deleted', { date: '2026-06-09', entry: { id: '2026-06-09' } });
    // handleJournalDeleted is async; flush the microtask queue.
    await new Promise((r) => setImmediate(r));

    expect(deleteMemory).toHaveBeenCalledWith('mem-day', true);
    expect(updateMemory).not.toHaveBeenCalled();
  });
});

describe('brainMemoryBridge — syncAllBrainData refresh mode (issue #1080 recovery)', () => {
  it('skips already-mapped records by default but re-embeds them with refresh:true', async () => {
    const bridge = await loadBridge();
    getAll.mockImplementation(async (type) => (type === 'people' ? [{ id: 'p1', name: 'Alice' }] : []));
    // p1 already mapped — the pre-#1080 staleness scenario.
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p1')]: 'mem-old' });

    const normal = await bridge.syncAllBrainData();
    expect(normal.skipped).toBeGreaterThanOrEqual(1);
    expect(updateMemory).not.toHaveBeenCalled();

    const refreshed = await bridge.syncAllBrainData({ refresh: true });
    expect(refreshed.synced).toBeGreaterThanOrEqual(1);
    expect(updateMemory).toHaveBeenCalledWith('mem-old', expect.any(Object));
  });

  it('refresh reconcile archives a mapped entry whose record was deleted on a peer pre-fix', async () => {
    const bridge = await loadBridge();
    // p-gone is mapped but its canonical record no longer resolves (deleted/
    // tombstoned on a peer before the fix) — getAll won't surface it, so only
    // the reconcile pass can retire its stale, still-searchable memory entry.
    getAll.mockResolvedValue([]);
    getById.mockResolvedValue(null);
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p-gone')]: 'mem-orphan' });

    // Default mode does NOT reconcile (no archival).
    await bridge.syncAllBrainData();
    expect(updateMemory).not.toHaveBeenCalled();

    const refreshed = await bridge.syncAllBrainData({ refresh: true });
    expect(updateMemory).toHaveBeenCalledWith('mem-orphan', { status: 'archived' });
    expect(refreshed.archived).toBe(1);
  });

  it('refresh reconcile leaves live mapped records alone (no spurious archive)', async () => {
    const bridge = await loadBridge();
    getAll.mockImplementation(async (type) => (type === 'people' ? [{ id: 'p1', name: 'Alice' }] : []));
    getById.mockResolvedValue({ id: 'p1', name: 'Alice' }); // still live
    bridgeFileContents = JSON.stringify({ [bridge.bridgeKey('people', 'p1')]: 'mem-live' });

    const refreshed = await bridge.syncAllBrainData({ refresh: true });

    // Re-embedded (update via syncBrainRecord), never archived.
    expect(refreshed.archived).toBe(0);
    expect(updateMemory).not.toHaveBeenCalledWith('mem-live', { status: 'archived' });
  });
});
