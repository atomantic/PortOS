import { describe, it, expect, vi, beforeEach } from 'vitest';

// Count disk reads + control file content so the TTL cache + in-flight
// coalescing can be asserted precisely. existsSync is forced true so
// loadProviders always takes the read path (never the sample-bootstrap
// branch); atomicWrite is a no-op so saveProviders doesn't touch disk.
let readCount = 0;
let diskContent = '';

vi.mock('fs', () => ({ existsSync: () => true }));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { readCount += 1; return diskContent; }),
  rename: vi.fn(async () => {}),
}));
vi.mock('./internal/atomicWrite.js', () => ({
  atomicWrite: vi.fn(async () => {}),
}));

const { createProviderService } = await import('./providers.js');
const { atomicWrite } = await import('./internal/atomicWrite.js');

const seed = (providers, active) => JSON.stringify({ activeProvider: active, providers });
const cli = (id) => ({ id, name: id, type: 'cli', command: 'x' });

beforeEach(() => {
  readCount = 0;
  diskContent = seed({ a: cli('a') }, 'a');
});

describe('loadProviders — TTL cache + in-flight coalescing', () => {
  it('collapses a concurrent read storm into a single disk read', async () => {
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json' });

    // 10 simultaneous readers (the N-way failure-storm shape) must share
    // one disk read, not race 10 independent reads.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => svc.getAllProviders())
    );

    expect(readCount).toBe(1);
    for (const r of results) expect(r.providers).toHaveLength(1);
  });

  it('serves reads from cache within the TTL window, re-reads after it expires', async () => {
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json', providersCacheTtlMs: 50 });

    await svc.getAllProviders();
    await svc.getAllProviders();
    expect(readCount).toBe(1); // second served from cache

    // Mutate disk directly (bypassing saveProviders) — cache still serves
    // the old snapshot until the TTL elapses.
    diskContent = seed({ a: cli('a'), b: cli('b') }, 'a');
    await svc.getAllProviders();
    expect(readCount).toBe(1);

    await new Promise((r) => setTimeout(r, 120)); // exceed the 50ms TTL
    const after = await svc.getAllProviders();
    expect(readCount).toBe(2);
    expect(after.providers).toHaveLength(2);
  });

  it('refreshes the cache on write so a save is reflected without a re-read', async () => {
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json' });

    await svc.getAllProviders(); // read 1, cache warm
    expect(readCount).toBe(1);

    const created = await svc.createProvider({ id: 'b', name: 'B', type: 'cli', command: 'y' });
    expect(created.id).toBe('b');

    const all = await svc.getAllProviders();
    // createProvider mutated the cached snapshot and saveProviders refreshed
    // the cache, so the new provider is visible with no extra disk read.
    expect(readCount).toBe(1);
    expect(all.providers.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('does not leave an unsaved mutation in the cache when the write fails', async () => {
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json' });
    await svc.getAllProviders(); // warm cache with just 'a', read 1
    expect(readCount).toBe(1);

    // The mutator mutates the warm cache object in place, then the write
    // throws. Because saveProviders invalidates the cache before writing,
    // the un-persisted 'b' must not survive — the next read re-reads disk
    // (still only 'a') rather than serving the poisoned cache.
    atomicWrite.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      svc.createProvider({ id: 'b', name: 'B', type: 'cli', command: 'y' })
    ).rejects.toThrow('disk full');

    const all = await svc.getAllProviders();
    expect(all.providers.map((p) => p.id)).toEqual(['a']);
    expect(readCount).toBe(2); // cache was invalidated → fresh disk read
  });

  it('a stale in-flight read does not clobber a fresher snapshot written mid-read', async () => {
    const fsp = await import('fs/promises');
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json' });

    await svc.getAllProviders(); // warm cache with {a}

    // Gate the write so the cache stays invalidated while a cold read runs.
    let releaseWrite;
    atomicWrite.mockImplementationOnce(async () => {
      await new Promise((res) => { releaseWrite = res; });
    });
    const createP = svc.createProvider({ id: 'b', name: 'B', type: 'cli', command: 'y' });
    await new Promise((r) => setTimeout(r, 0)); // let it invalidate + park at the gated write

    // Cache is now invalidated; start a cold read and gate it mid-flight.
    let releaseRead;
    fsp.readFile.mockImplementationOnce(async () => {
      readCount += 1;
      await new Promise((res) => { releaseRead = res; });
      return diskContent; // stale snapshot — disk still only has {a}
    });
    const staleRead = svc.getAllProviders();
    await new Promise((r) => setTimeout(r, 0)); // let the read start

    // The write lands and refreshes the cache to {a, b} FIRST...
    releaseWrite();
    await createP;

    // ...then the stale read resolves. Its older snapshot must NOT overwrite
    // the fresher cache (the generation guard skips the adoption).
    releaseRead();
    const staleResult = await staleRead;
    expect(staleResult.providers.map((p) => p.id).sort()).toEqual(['a', 'b']);

    const all = await svc.getAllProviders();
    expect(all.providers.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });
});
