import { setImmediate } from 'node:timers/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Count disk reads + control file content so the TTL cache + in-flight
// coalescing can be asserted precisely. existsSync is forced true so
// loadProviders always takes the read path (never the sample-bootstrap
// branch). The atomicWrite mock commits to an in-memory file.
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
  atomicWrite.mockReset().mockImplementation(async (_path, data) => { diskContent = JSON.stringify(data); });
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

  it('shares an in-flight reload after the cache expires', async () => {
    const { readFile } = await import('fs/promises');
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json', providersCacheTtlMs: 0 });
    await svc.getAllProviders();
    diskContent = seed({ a: cli('a'), b: cli('b') }, 'a');
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    readFile.mockImplementationOnce(async () => {
      readCount += 1;
      entered.resolve();
      await release.promise;
      return diskContent;
    });

    const first = svc.getAllProviders();
    await entered.promise;
    const second = svc.getAllProviders();
    release.resolve();

    for (const result of await Promise.all([first, second])) {
      expect(result.providers.map(provider => provider.id)).toEqual(['a', 'b']);
    }
    expect(readCount).toBe(2);
  });

  it('refreshes the cache on write so a save is reflected without a re-read', async () => {
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json' });

    await svc.getAllProviders(); // read 1, cache warm
    expect(readCount).toBe(1);

    const created = await svc.createProvider({ id: 'b', name: 'B', type: 'cli', command: 'y' });
    expect(created.id).toBe('b');

    const all = await svc.getAllProviders();
    expect(readCount).toBe(1);
    expect(all.providers.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('does not leave an unsaved mutation in the cache when the write fails', async () => {
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json' });
    await svc.getAllProviders(); // warm cache with just 'a', read 1
    expect(readCount).toBe(1);

    atomicWrite.mockRejectedValueOnce(new Error('disk full'));
    const failed = svc.createProvider({ id: 'b', name: 'B', type: 'cli', command: 'y' });
    const recovered = svc.createProvider({ id: 'c', name: 'C', type: 'cli', command: 'z' });

    await expect(failed).rejects.toThrow('disk full');
    await expect(recovered).resolves.toMatchObject({ id: 'c' });
    const all = await svc.getAllProviders();
    expect(all.providers.map((p) => p.id)).toEqual(['a', 'c']);
    expect(readCount).toBe(1);
    expect(Object.keys(JSON.parse(diskContent).providers)).toEqual(['a', 'c']);
  });

  it('serves the last committed snapshot while saving a draft', async () => {
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json' });
    await svc.getAllProviders();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    atomicWrite.mockImplementationOnce(async (_path, data) => {
      entered.resolve();
      await release.promise;
      diskContent = JSON.stringify(data);
    });

    const saving = svc.updateProvider('a', { name: 'Edited' });
    await entered.promise;
    let during;
    try {
      during = await svc.getProviderById('a');
    } finally {
      release.resolve();
      await saving;
    }

    expect(during.name).toBe('a');
    expect((await svc.getProviderById('a')).name).toBe('Edited');
    expect(readCount).toBe(1);
  });

  it('allows external reads and serializes nested edits while an awaited save hook runs', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const onProvidersSaved = vi.fn().mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      await Promise.all([
        svc.updateProvider('a', { name: 'Hook edit' }),
        svc.createProvider({ id: 'b', name: 'B' }),
      ]);
    });
    const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json', providersCacheTtlMs: 0, onProvidersSaved });
    const saving = svc.updateProvider('a', { command: 'edited' });
    await entered.promise;
    const reading = svc.getProviderById('a');
    let during;
    try {
      await setImmediate();
      during = await Promise.race([reading, Promise.resolve(null)]);
    } finally {
      release.resolve();
      await Promise.all([saving, reading]);
    }

    expect(during).toMatchObject({ name: 'a', command: 'edited' });
    expect(JSON.parse(diskContent).providers).toMatchObject({
      a: { name: 'Hook edit', command: 'edited' },
      b: { name: 'B' },
    });
  });

  it.each(['refreshProviderModels', 'refreshProviderModelsBatch'])(
    'isolates cold readers and queues edits during the file write from %s',
    async (method) => {
      const provider = { id: 'a', name: 'Example', type: 'api', models: ['old'] };
      diskContent = seed({ a: provider }, 'a');
      const svc = createProviderService({ dataDir: '/x', providersFile: 'p.json', providersCacheTtlMs: 0 });
      vi.spyOn(svc, 'fetchProviderModelCatalog').mockResolvedValue({ models: ['new'] });
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      atomicWrite.mockImplementationOnce(async (_path, data) => {
        entered.resolve();
        await release.promise;
        diskContent = JSON.stringify(data);
      });

      const refreshing = svc[method](method === 'refreshProviderModels' ? 'a' : ['a']);
      await entered.promise;
      const readsBeforeWrite = readCount;
      const coldRead = svc.getAllProviders();
      const editing = svc.updateProvider('a', { name: 'Edited', apiKey: 'example-secret' });
      let during;
      let readsDuringWrite;
      let writesDuringRefresh;
      try {
        await setImmediate();
        during = await Promise.race([coldRead, Promise.resolve(null)]);
        readsDuringWrite = readCount;
        writesDuringRefresh = atomicWrite.mock.calls.length;
      } finally {
        release.resolve();
        await Promise.all([refreshing, coldRead, editing]);
      }

      expect(during.providers).toEqual([provider]);
      expect(readsDuringWrite).toBe(readsBeforeWrite);
      expect(writesDuringRefresh).toBe(1);
      expect(JSON.parse(diskContent).providers.a).toMatchObject({
        name: 'Edited', apiKey: 'example-secret', models: ['new'],
      });
    }
  );
});
