import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The cache resolves its file from PATHS.data at import time of each call, so
// point PATHS at a temp dir before importing the module under test.
let tempRoot;

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get PATHS() {
      return { ...actual.PATHS, data: tempRoot };
    }
  };
});

const cacheFile = () => join(tempRoot, 'cache', 'huggingface-repos.json');

let cache;

describe('huggingFaceRepoCache', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'portos-hf-cache-'));
    vi.resetModules();
    cache = await import('./huggingFaceRepoCache.js');
    cache.__resetRepoCache();
  });

  afterEach(async () => {
    cache.__resetRepoCache();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('reports a miss for an unknown repo', async () => {
    expect(await cache.readCachedRepoModel('nobody/Nothing')).toEqual({ hit: false, model: null });
  });

  it('round-trips a record through disk so a restart does not refetch', async () => {
    const model = { id: 'pub/Repo-GGUF', siblings: [{ rfilename: 'a-Q4_K_M.gguf', size: 42 }] };
    await cache.writeCachedRepoModel('pub/Repo-GGUF', model);
    await cache.__flushRepoCache();

    // Fresh module instance = a fresh process, reading only what is on disk.
    vi.resetModules();
    const reloaded = await import('./huggingFaceRepoCache.js');
    expect(await reloaded.readCachedRepoModel('pub/Repo-GGUF')).toEqual({ hit: true, model });
  });

  // The whole point of the `hit` flag: a gated/404 repo caches as `null`, and a
  // caller must not confuse that real answer with "never looked".
  it('distinguishes a cached null (gated/absent repo) from a miss', async () => {
    await cache.writeCachedRepoModel('gated/Repo', null);
    await cache.__flushRepoCache();
    expect(await cache.readCachedRepoModel('gated/Repo')).toEqual({ hit: true, model: null });
    expect(await cache.readCachedRepoModel('other/Repo')).toEqual({ hit: false, model: null });
  });

  it('treats an entry past the TTL as a miss and prunes it on the next save', async () => {
    const stale = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days — TTL is 7
    await mkdir(join(tempRoot, 'cache'), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify({
      schemaVersion: 1,
      entries: {
        'old/Repo': { fetchedAt: stale, model: { id: 'old/Repo' } },
        'new/Repo': { fetchedAt: Date.now(), model: { id: 'new/Repo' } }
      }
    }));

    expect((await cache.readCachedRepoModel('old/Repo')).hit).toBe(false);
    expect((await cache.readCachedRepoModel('new/Repo')).hit).toBe(true);

    await cache.writeCachedRepoModel('third/Repo', { id: 'third/Repo' });
    await cache.__flushRepoCache();
    const onDisk = JSON.parse(await readFile(cacheFile(), 'utf8'));
    expect(Object.keys(onDisk.entries).sort()).toEqual(['new/Repo', 'third/Repo']);
  });

  it('ignores a cache file written by a different schema version', async () => {
    await mkdir(join(tempRoot, 'cache'), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify({
      schemaVersion: 999,
      entries: { 'pub/Repo': { fetchedAt: Date.now(), model: { id: 'pub/Repo' } } }
    }));
    expect((await cache.readCachedRepoModel('pub/Repo')).hit).toBe(false);
  });

  // Regenerable data: a corrupt file must degrade to an empty cache and a
  // refetch, never throw and take the catalog endpoint down with it.
  it('treats a corrupt cache file as empty rather than throwing', async () => {
    await mkdir(join(tempRoot, 'cache'), { recursive: true });
    await writeFile(cacheFile(), '{ this is not json');
    expect((await cache.readCachedRepoModel('pub/Repo')).hit).toBe(false);
    await expect(cache.writeCachedRepoModel('pub/Repo', { id: 'pub/Repo' })).resolves.not.toThrow();
  });
});
